import type {Battle} from '@pkmn/sim';
import type {ExactCell, ExactSolution, Snapshot, SolverOptions, StateKey, WorkerOptions} from './types';
import {solveZeroSumMatrix} from './matrix-game';
import {
  legalActions,
  restoreBattle,
  snapshotBattle,
  stateKey,
  terminalUtility,
} from './showdown-adapter';
import {createMemoStateKey} from './native-memo-key';
import {auditPPBattle} from './pp-transition-cache';
import {auditNativeRules} from './native-rules';
import {compareStockProfile} from './stock-rule-profile';
import {OneVsOneSolver} from './solver';
import {TransitionPool} from './transition-pool';

export interface AsyncSolverOptions extends SolverOptions, WorkerOptions {
  eager?: boolean;
  routing?: 'stable' | 'queue';
}

function createStats() {
  return {
    solvedStates: 0,
    simulatorRuns: 0,
    transitionCalls: 0,
    memoHits: 0,
    ppCacheHits: 0,
    prepareMs: 0,
    searchMs: 0,
  };
}

function actionCommand(action) {
  return typeof action === 'string' ? action : action?.command;
}

// Routing is only a cache locality hint. It never participates in state
// identity or correctness. Omitting PP is intentional: every PP variant of
// the same non-PP position and action pair is sent to the same worker.
function routeHint(snapshot, p1Action, p2Action, workerCount) {
  const pokemon = [];
  for (const side of snapshot.sides || []) {
    for (const entry of side.pokemon || []) {
      pokemon.push([entry.species, entry.hp, entry.status, !!entry.fainted, !!entry.active]);
    }
  }
  const input = JSON.stringify([
    snapshot.turn,
    snapshot.requestState,
    pokemon,
    actionCommand(p1Action),
    actionCommand(p2Action),
  ]);
  let hash = 2166136261;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % workerCount;
}

/**
 * Experimental solver: only transition generation is parallel. Memoization,
 * outcome resolution, pruning certificates, and matrix solving remain on the
 * main thread so the result has the same ownership and exactness rules as the
 * synchronous solver.
 */
class AsyncTransitionSolver {
  declare options: Required<SolverOptions> & {workerCount: number; batchSize: number; eager: boolean; routing: string};
  declare pool: TransitionPool;
  declare ownsPool: boolean;
  declare memo: Map<string, ExactSolution>;
  declare pendingStates: Map<string, Promise<ExactSolution>>;
  declare waitEdges: Map<string, Set<string>>;
  declare discoveredStates: Set<string>;
  declare snapshotKeyCache: WeakMap<object, string>;
  declare activeSolve: boolean;
  declare abortError: unknown;
  declare memoStateKey: StateKey;
  declare stats: ReturnType<typeof createStats>;

  constructor(options: AsyncSolverOptions = {}) {
    const poolSize = options.pool?.size;
    const workerCount = options.workerCount ?? poolSize ?? 1;
    if (!Number.isInteger(workerCount) || workerCount < 1) {
      throw new RangeError('Async solver workerCount must be a positive integer');
    }
    if (poolSize !== undefined && workerCount !== poolSize) {
      throw new RangeError(`Async solver workerCount ${workerCount} does not match pool size ${poolSize}`);
    }
    const batchSize = options.batchSize ?? options.pool?.batchSize ?? 4;
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new RangeError('Async solver batchSize must be a positive integer');
    }
    this.options = {
      maxStates: options.maxStates ?? 100000,
      maxSimulatorRunsPerTransition: options.maxSimulatorRunsPerTransition ?? 100000,
      workerCount,
      eager: options.eager ?? false,
      routing: options.routing ?? 'stable',
      batchSize,
    };
    this.pool = options.pool || new TransitionPool(this.options.workerCount, {
      batchSize: this.options.batchSize,
    });
    this.ownsPool = !options.pool;
    this.memo = new Map();
    this.pendingStates = new Map();
    this.waitEdges = new Map();
    this.discoveredStates = new Set();
    this.snapshotKeyCache = new WeakMap();
    this.activeSolve = false;
    this.abortError = null;
    this.memoStateKey = stateKey;
    this.stats = createStats();
  }

  async solve(battle: Battle) {
    if (this.activeSolve) throw new Error('Async solver already has an active solve');
    this.activeSolve = true;
    this.memo.clear();
    this.pendingStates.clear();
    this.waitEdges.clear();
    this.discoveredStates.clear();
    this.snapshotKeyCache = new WeakMap();
    this.abortError = null;
    this.stats = createStats();
    try {
      const prepareStart = performance.now();
      const nativeAudit = auditNativeRules(battle);
      if (!nativeAudit) {
        // A worker has an independent Dex and cannot reproduce custom runtime
        // rules from a JSON snapshot. Use the synchronous backend for the full
        // solve whenever the root is outside the audited native context.
        return new OneVsOneSolver(this.options).solve(battle);
      }
      this.memoStateKey = createMemoStateKey(battle, stateKey, nativeAudit);
      const root = snapshotBattle(battle);
      const ppAudit = auditPPBattle(battle, nativeAudit);
      const initialized = await this.pool.initSolve(root, {
        enabled: !!ppAudit,
      });
      const workerProfile = initialized.find(status => status.stockProfile)?.stockProfile;
      const stockAudit = compareStockProfile(battle.dex, workerProfile, {battle}).ok;
      if (!stockAudit || initialized.some(status => !status.compatible)) {
        this.pool.releaseSolve();
        return new OneVsOneSolver(this.options).solve(battle);
      }
      this.stats.prepareMs = performance.now() - prepareStart;
      const searchStart = performance.now();
      let searchSucceeded = false;
      try {
        const result = await this._solve(root, true, new Set());
        this.stats.searchMs = performance.now() - searchStart;
        searchSucceeded = true;
        return {...result, stats: {...this.stats}};
      } catch (error) {
        this.abortError = error;
        throw error;
      } finally {
        // Promise.all may leave sibling transition jobs running after the
        // first rejection. Drain them before resetting worker solve context or
        // releasing the lease so a following solve cannot race old jobs.
        if (!searchSucceeded) await this.drainPending();
        this.pool.releaseSolve();
      }
    } finally {
      this.activeSolve = false;
    }
  }

  snapshotKey(snapshot: Snapshot): string {
    if (!snapshot || typeof snapshot !== 'object') return this.memoStateKey(snapshot);
    let key = this.snapshotKeyCache.get(snapshot);
    if (key === undefined) {
      key = this.memoStateKey(snapshot);
      this.snapshotKeyCache.set(snapshot, key);
    }
    return key;
  }

  checkAbort() {
    if (this.abortError) throw this.abortError;
  }

  async drainPending() {
    // A settled parent can have sibling promises that are still between a
    // transition result and their next _solve call. Repeatedly observe the
    // complete pending set so those microtasks cannot repopulate the pool
    // after the lease is released.
    while (this.pendingStates.size) {
      await Promise.allSettled([...this.pendingStates.values()]);
    }
    if (this.pool.waitForIdle) await this.pool.waitForIdle();
  }

  async _solve(snapshot: Snapshot, wantStrategy = false, ancestors = new Set<string>()): Promise<ExactSolution> {
    this.checkAbort();
    const key = this.snapshotKey(snapshot);
    if (ancestors.has(key)) {
      throw new Error('A true state cycle was found on one ancestor path');
    }
    const cached = this.memo.get(key);
    if (cached && (cached.terminal || !wantStrategy || cached.p1Strategy)) {
      this.stats.memoHits++;
      return cached;
    }
    const pending = this.pendingStates.get(key);
    if (pending) return pending;
    if (!this.discoveredStates.has(key)) {
      if (this.discoveredStates.size >= this.options.maxStates) {
        throw new Error(`State limit (${this.options.maxStates}) exceeded`);
      }
      this.discoveredStates.add(key);
    }

    const nextAncestors = new Set(ancestors);
    nextAncestors.add(key);
    const promise = this._solveBody(snapshot, wantStrategy, key, nextAncestors);
    this.pendingStates.set(key, promise);
    try {
      return await promise;
    } finally {
      if (this.pendingStates.get(key) === promise) this.pendingStates.delete(key);
    }
  }

  addWaitEdge(parentKey, childKey) {
    let children = this.waitEdges.get(parentKey);
    if (!children) {
      children = new Set();
      this.waitEdges.set(parentKey, children);
    }
    children.add(childKey);
    const stack = [childKey];
    const seen = new Set();
    let reachesParent = false;
    while (stack.length) {
      const key = stack.pop();
      if (key === parentKey) {
        reachesParent = true;
        break;
      }
      if (seen.has(key)) continue;
      seen.add(key);
      for (const next of this.waitEdges.get(key) || []) stack.push(next);
    }
    if (reachesParent) {
      children.delete(childKey);
      if (!children.size) this.waitEdges.delete(parentKey);
      throw new Error(`Concurrent state dependency cycle: ${parentKey} -> ${childKey}`);
    }
  }

  removeWaitEdge(parentKey, childKey) {
    const children = this.waitEdges.get(parentKey);
    if (!children) return;
    children.delete(childKey);
    if (!children.size) this.waitEdges.delete(parentKey);
  }

  async awaitChild(parentKey, childKey, snapshot, ancestors) {
    this.checkAbort();
    if (ancestors.has(childKey)) {
      throw new Error(`A true state cycle was found on one ancestor path: ${parentKey} -> ${childKey}`);
    }
    this.addWaitEdge(parentKey, childKey);
    try {
      return await this._solve(snapshot, false, ancestors);
    } finally {
      this.removeWaitEdge(parentKey, childKey);
    }
  }

  async _solveBody(snapshot: Snapshot, wantStrategy: boolean, key: string, ancestors: Set<string>): Promise<ExactSolution> {
    this.checkAbort();
    const battle = restoreBattle(snapshot);
    const utility = terminalUtility(battle);
    if (utility !== null) {
      const terminal = {value: utility, terminal: true};
      this.memo.set(key, terminal);
      return terminal;
    }
    if (this.stats.solvedStates >= this.options.maxStates && !this.memo.has(key)) {
      throw new Error(`State limit (${this.options.maxStates}) exceeded`);
    }

    const p1Actions = legalActions(battle, 0);
    const p2Actions = legalActions(battle, 1);
    const payoff = Array.from({length: p1Actions.length}, () => Array(p2Actions.length).fill(null));
    const cells = Array.from({length: p1Actions.length}, () => Array(p2Actions.length).fill(null));

    const refreshCell = (cell: ExactCell) => {
      let known = 0;
      let unresolved = 0;
      for (let i = 0; i < cell.outcomes.length; i++) {
        const value = cell.values[i];
        if (value === undefined) unresolved++;
        else known += cell.outcomes[i].probability * value;
      }
      cell.unresolvedCount = unresolved;
      if (!unresolved) {
        cell.exact = true;
        cell.value = known;
      }
    };

    const ensureCell = (i, j) => {
      this.checkAbort();
      if (cells[i][j]) return cells[i][j];
      const pendingCell = this.pool.run(snapshot, p1Actions[i], p2Actions[j], {
        maxSimulatorRunsPerTransition: this.options.maxSimulatorRunsPerTransition,
        outcomeKeyMode: this.memoStateKey.private ? 'private' : undefined,
        workerRoute: this.options.routing === 'stable'
          ? routeHint(snapshot, p1Actions[i], p2Actions[j], this.options.workerCount)
          : undefined,
      }).then(transition => {
        this.checkAbort();
        this.stats.transitionCalls++;
        this.stats.simulatorRuns += transition.simulatorRuns;
        this.stats.ppCacheHits += transition.cacheHits || 0;
        const childKeys = transition.outcomes.map(outcome =>
          outcome.snapshot === undefined ? undefined : this.snapshotKey(outcome.snapshot));
        const values = transition.outcomes.map((outcome, index) => {
          if (outcome.snapshot === undefined) return outcome.utility;
          const cachedChild = this.memo.get(childKeys[index]);
          if (cachedChild && typeof cachedChild.value === 'number') {
            this.stats.memoHits++;
            return cachedChild.value;
          }
          return undefined;
        });
        const cell = {outcomes: transition.outcomes, values, childKeys,
          exact: false, value: null, unresolvedCount: 0};
        refreshCell(cell);
        cells[i][j] = cell;
        if (cell.exact) payoff[i][j] = cell.value;
        return cell;
      });
      cells[i][j] = pendingCell;
      return pendingCell;
    };

    const getCell = async (i, j) => {
      this.checkAbort();
      return await ensureCell(i, j);
    };

    const resolveCell = async (i, j) => {
      this.checkAbort();
      const cell = await getCell(i, j);
      if (cell.exact) return cell.value;
      const childPromises = new Map<string, Promise<number>>();
      for (let index = 0; index < cell.outcomes.length; index++) {
        if (cell.values[index] !== undefined) continue;
        const childKey = cell.childKeys[index];
        if (!childPromises.has(childKey)) {
          childPromises.set(childKey, this.awaitChild(
            key, childKey, cell.outcomes[index].snapshot, ancestors
          ).then(result => result.value));
        }
      }
      const childValues = new Map(await Promise.all([...childPromises.entries()]
        .map(async ([childKey, promise]) => [childKey, await promise] as const)));
      this.checkAbort();
      for (let index = 0; index < cell.outcomes.length; index++) {
        if (cell.values[index] === undefined) cell.values[index] = childValues.get(cell.childKeys[index]);
      }
      refreshCell(cell);
      payoff[i][j] = cell.value;
      return cell.value;
    };

    const rowIsForcedWin = i => cells[i].every(cell => cell && cell.exact &&
      cell.values.every(value => value === 1));
    const columnIsForcedLoss = j => cells.every(row => row[j] && row[j].exact &&
      row[j].values.every(value => value === -1));

    const allCellsHaveForcedValue = value => cells.every(row =>
      row.every(cell => cell && cell.exact && cell.values.every(outcome => outcome === value)));

    if (this.options.eager) {
      // Eager mode is an experiment: generate all transitions at this state,
      // but retain the strict terminal/cached certificates before descending.
      await Promise.all(p1Actions.flatMap((_, i) =>
        p2Actions.map((_, j) => getCell(i, j))));
      if (!wantStrategy && (p1Actions.some((_, i) => rowIsForcedWin(i)) || allCellsHaveForcedValue(1))) {
        return this.storeValue(key, 1);
      }
      if (!wantStrategy && (p2Actions.some((_, j) => columnIsForcedLoss(j)) || allCellsHaveForcedValue(-1))) {
        return this.storeValue(key, -1);
      }
      await Promise.all(p1Actions.flatMap((_, i) =>
        p2Actions.map((_, j) => resolveCell(i, j))));
    }

    if (!wantStrategy && !this.options.eager) {
      for (let i = 0; i < p1Actions.length; i++) {
        // Parallelize only transition generation for this row. Child states
        // are still resolved depth-first, preserving path cycle semantics.
        await Promise.all(p2Actions.map((_, j) => getCell(i, j)));
        if (rowIsForcedWin(i)) return this.storeValue(key, 1);
        const order = p2Actions.map((_, j) => j).sort((a, b) =>
          cells[i][a].unresolvedCount - cells[i][b].unresolvedCount);
        for (const j of order) {
          await resolveCell(i, j);
          if (rowIsForcedWin(i)) return this.storeValue(key, 1);
          if (cells[i][j].exact && cells[i][j].values.every(value => value === -1)) {
            await Promise.all(p1Actions.map((_, k) => getCell(k, j)));
            if (columnIsForcedLoss(j)) return this.storeValue(key, -1);
          }
        }
      }
    }

    // Root strategy and all non-certified states require the complete matrix.
    if (!this.options.eager) {
      for (let i = 0; i < p1Actions.length; i++) {
        await Promise.all(p2Actions.map((_, j) => getCell(i, j)));
        for (let j = 0; j < p2Actions.length; j++) await resolveCell(i, j);
      }
    }
    const solution = solveZeroSumMatrix(payoff);
    const result = {
      value: solution.value,
      terminal: false,
      p1Strategy: p1Actions.map((action, i) => ({action: action.name, probability: solution.p1[i]})),
      p2Strategy: p2Actions.map((action, j) => ({action: action.name, probability: solution.p2[j]})),
      payoffMatrix: payoff,
    };
    if (!this.memo.has(key)) this.stats.solvedStates++;
    this.memo.set(key, result);
    return result;
  }

  storeValue(key, value) {
    const result = {value, terminal: false};
    if (!this.memo.has(key)) this.stats.solvedStates++;
    this.memo.set(key, result);
    return result;
  }

  async close() {
    if (this.ownsPool) await this.pool.close();
  }
}

export {AsyncTransitionSolver};
