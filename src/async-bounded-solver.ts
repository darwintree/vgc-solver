import type {BoundedOptions, BoundedResult, SearchNode} from './bounded-solver';
import type {Transition, WorkerOptions} from './types';
import {BoundedSearch} from './bounded-solver';
import {snapshotBattle, stateKey} from './showdown-adapter';
import {createMemoStateKey} from './native-memo-key';
import {auditPPBattle} from './pp-transition-cache';
import {auditNativeRules} from './native-rules';
import {compareStockProfile} from './stock-rule-profile';
import {TransitionPool} from './transition-pool';

/**
 * Worker-backed one-ply expansion for BoundedSolver. Only the immediate
 * transition generation is parallel; interval backup and frontier selection
 * remain on the main thread, so the bounded solver's ownership rules stay
 * unchanged.
 */
class AsyncBoundedSolver extends BoundedSearch {
  declare workerCount: number;
  declare batchSize: number;
  declare pool: TransitionPool;
  declare ownsPool: boolean;
  declare activeSolve: boolean;
  declare usesNativeAdapter: boolean;

  constructor(options: BoundedOptions & WorkerOptions = {}) {
    const poolSize = options.pool?.size;
    const workerCount = options.workerCount ?? poolSize ?? 1;
    if (!Number.isInteger(workerCount) || workerCount < 1) {
      throw new RangeError('Async bounded solver workerCount must be positive');
    }
    if (poolSize !== undefined && workerCount !== poolSize) {
      throw new RangeError(`Async bounded solver workerCount ${workerCount} does not match pool size ${poolSize}`);
    }
    super(options);
    this.workerCount = workerCount;
    this.batchSize = options.batchSize ?? options.pool?.batchSize ?? 4;
    if (!Number.isInteger(this.batchSize) || this.batchSize < 1) {
      throw new RangeError('Async bounded solver batchSize must be positive');
    }
    this.pool = options.pool || new TransitionPool(workerCount, {batchSize: this.batchSize});
    this.ownsPool = !options.pool;
    this.activeSolve = false;
    this.usesNativeAdapter = !options.adapter;
  }

  async solve(battle): Promise<BoundedResult> {
    if (this.activeSolve) throw new Error('Async bounded solver already has an active solve');
    this.activeSolve = true;
    this._reset();
    let lease = false;
    try {
      const prepareStart = performance.now();
      if (!this.usesNativeAdapter) {
        const result = this.solveSync(battle);
        result.backend = 'fallback';
        return result;
      }
      const nativeAudit = auditNativeRules(battle);
      if (!nativeAudit) {
        const result = this.solveSync(battle);
        result.backend = 'fallback';
        return result;
      }
      this.memoStateKey = createMemoStateKey(battle, stateKey, nativeAudit);
      this.ppAudit = auditPPBattle(battle, nativeAudit);
      const rootSnapshot = snapshotBattle(battle);
      const initialized = await this.pool.initSolve(rootSnapshot, {enabled: !!this.ppAudit});
      lease = true;
      const workerProfile = initialized.find(status => status.stockProfile)?.stockProfile;
      if (!compareStockProfile(battle.dex, workerProfile, {battle}).ok ||
          initialized.some(status => !status.compatible)) {
        this.pool.releaseSolve();
        lease = false;
        const result = this.solveSync(battle);
        result.backend = 'fallback';
        return result;
      }
      this.stats.prepareMs = performance.now() - prepareStart;
      const searchStart = performance.now();
      this.deadline = Number.isFinite(this.options.maxSearchMs)
        ? searchStart + this.options.maxSearchMs : Infinity;
      let result;
      let converged = false;
      const root = this._intern(rootSnapshot);
      if (this.options.warmStartRoot && this.options.lazyCells && root.terminal === null) {
        this._expandAsync(root);
        if (!root.initialized) {
          this._backupFrom([root]);
        }
        if (root.initialized) {
          const rootCells = this._allCells(root);
          for (let index = 0; index < rootCells.length && !this._timedOut(); index += this.batchSize) {
            await this._expandCellsAsync(root, rootCells.slice(index, index + this.batchSize));
          }
        }
      }
      if (!this.options.lazyCells && root.terminal === null) {
        this._expandAsync(root);
        if (!root.initialized) {
          this._backupFrom([root]);
        }
        if (root.initialized) {
          const rootCells = this._allCells(root);
          await this._expandCellsAsync(root, rootCells);
        }
      }
      this._backupFrom([root]);
      while (true) {
        this._backupFrom([root]);
        if (root.upper - root.lower <= this.options.tolerance + 1e-12 || root.terminal !== null) {
          converged = true;
          break;
        }
        if (this._timedOut()) {
          this.stopReason = 'time';
          break;
        }
        const selectionPolicy = this._selectionPolicyForRoot(root);
        if (selectionPolicy === 'security') this.proofTurn++;
        let frontier = this._selectFrontier(root, selectionPolicy);
        if (!frontier && selectionPolicy === 'security') {
          frontier = this._selectFrontier(root, 'joint');
        }
        if (!frontier) {
          if (!this.stopReason) this.stopReason = this.limitReached ? 'node-limit' : 'stalled';
          break;
        }
        if (frontier.initialize) {
          this._expandAsync(frontier.node);
          if (!frontier.node.initialized) {
            this.stopReason = this.stopReason || 'time';
            break;
          }
          if (!this.options.lazyCells) {
            await this._expandCellsAsync(frontier.node, this._allCells(frontier.node));
          }
        } else {
          await this._expandCellsAsync(frontier.node, this._cellBatch(frontier));
        }
        this._backupFrom([frontier.node]);
      }
      this._backupFrom([root]);
      result = this._result(root, converged);
      this.stats.searchMs = performance.now() - searchStart;
      result.stats = {...this.stats, nodes: this.nodes.size};
      result.backend = 'worker';
      return result;
    } finally {
      if (lease) {
        await this.pool.waitForIdle();
        this.pool.releaseSolve();
      }
      this.activeSolve = false;
    }
  }

  _expandAsync(node) {
    if (node.initialized || node.terminal !== null || this._timedOut()) return;
    this._initializeNode(node);
  }

  _cellBatch(frontier) {
    const node = frontier.node;
    const rowStrategy = node.upperSolution?.p1 || [];
    const colStrategy = node.lowerSolution?.p2 || [];
    const candidates = [];
    for (let i = 0; i < node.cells.length; i++) {
      for (let j = 0; j < node.cells[i].length; j++) {
        const cell = node.cells[i][j];
        if (cell.outcomes) continue;
        candidates.push({i, j,
          score: (rowStrategy[i] || 0) * (colStrategy[j] || 0),
          gap: cell.upper - cell.lower});
      }
    }
    candidates.sort((a, b) => b.score - a.score || b.gap - a.gap);
    const selected = candidates.findIndex(candidate =>
      candidate.i === frontier.i && candidate.j === frontier.j);
    if (selected > 0) {
      const [choice] = candidates.splice(selected, 1);
      candidates.unshift(choice);
    }
    const width = Math.max(1, Math.min(this.workerCount, this.batchSize, candidates.length));
    return candidates.slice(0, width);
  }

  _allCells(node) {
    const cells = [];
    for (let i = 0; i < node.actions1.length; i++) {
      for (let j = 0; j < node.actions2.length; j++) cells.push({i, j});
    }
    return cells;
  }

  async _expandCellsAsync(node: SearchNode, cells: {i: number; j: number}[]) {
    if (node.terminal !== null || !node.initialized || this._timedOut()) return;
    const jobs: {i: number; j: number; promise: Promise<Transition>; transition?: Transition}[] = [];
    for (const {i, j} of cells) {
      jobs.push({i, j, promise: this.pool.run(
        node.snapshot, node.actions1[i] as import('./types').Action, node.actions2[j] as import('./types').Action, {
          maxSimulatorRunsPerTransition: this.options.maxSimulatorRunsPerTransition,
          outcomeKeyMode: this.memoStateKey.private ? 'private' : undefined,
          // Route each action pair by its transient row-major rank. This is
          // only a worker-affinity hint; state identity and semantics remain
          // independent of the selected worker.
          workerRoute: (i * node.actions2.length + j) % this.workerCount,
        })});
    }
    const pendingJobs = jobs.filter(job => job.promise);
    let transitions;
    try {
      const pendingTransitions = await Promise.all(pendingJobs.map(job => job.promise));
      for (let index = 0; index < pendingJobs.length; index++) {
        pendingJobs[index].transition = pendingTransitions[index];
      }
      transitions = jobs.map(job => job.transition);
    } catch (error) {
      await Promise.allSettled(pendingJobs.map(job => job.promise));
      throw error;
    }
    for (let index = 0; index < jobs.length; index++) {
      const {i, j} = jobs[index];
      const transition = transitions[index];
      this._acceptTransition(node, i, j, transition);
    }
  }

  async close() {
    if (this.ownsPool) await this.pool.close();
  }
}

export {AsyncBoundedSolver};
