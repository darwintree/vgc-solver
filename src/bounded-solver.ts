import type {Action, MatrixSolution, Snapshot, SolverOptions, StateKey, StrategyEntry, Transition} from './types';
import {solveZeroSumMatrix} from './matrix-game';
import {
  enumerateTurn,
  legalActions,
  restoreBattle,
  snapshotBattle,
  stateKey,
  terminalUtility,
} from './showdown-adapter';
import {createMemoStateKey, privateSnapshotKey} from './native-memo-key';
import {createPPTransitionCache, auditPPBattle} from './pp-transition-cache';
import {createTurnCursor, type TransitionCursor} from './progressive-transition';
import {createEventPlan} from './event-plan';
import {auditNativeRules} from './native-rules';

export interface BoundedAdapter {
  // Custom adapters may use primitive state IDs and action IDs.
  snapshotBattle?: (battle: any) => any;
  restoreBattle?: (snapshot: any) => any;
  stateKey?: (snapshot: any) => string;
  terminalUtility?: (battle: any) => number | null;
  legalActions?: (battle: any, side: number) => (Action | string | number)[];
  createTurnCursor?: (snapshot: any, p1: any, p2: any, options?: any) => TransitionCursor;
  enumerateTurn: (snapshot: any, p1: any, p2: any, options?: any) => {
    outcomes: Transition['outcomes']; simulatorRuns?: number; cacheHits?: number; complete?: boolean;
  };
}
export interface BoundedOptions extends SolverOptions {
  tolerance?: number;
  maxSearchMs?: number;
  maxNodes?: number;
  warmStartRoot?: boolean;
  lazyCells?: boolean;
  selectionPolicy?: 'auto' | 'security' | 'joint';
  adapter?: BoundedAdapter;
}
export interface BoundedResult {
  value: number;
  lowerBound: number;
  upperBound: number;
  valueErrorBound: number;
  converged: boolean;
  approximate: boolean;
  isApproximate: boolean;
  exact: boolean;
  stopReason: string | null;
  p1Strategy: StrategyEntry[];
  p2Strategy: StrategyEntry[];
  payoffMatrix: number[][];
  payoffMatrixLower: number[][];
  payoffMatrixUpper: number[][];
  payoffMatrixIntervals: {lowerBound: number; upperBound: number}[][];
  stats: ReturnType<typeof createStats> & {nodes: number};
  backend?: 'sync' | 'fallback' | 'worker';
}
interface BoundedOutcome {
  probability: number;
  utility: number | null;
  child: SearchNode | null;
}
interface BoundedCell {
  cursor?: TransitionCursor | null;
  remainingProbability?: number;
  outcomes: BoundedOutcome[] | null;
  lower: number;
  upper: number;
}
export interface SearchNode {
  key: string;
  snapshot: Snapshot;
  terminal: number | null;
  initialized: boolean;
  actions1: (Action | string | number)[] | null;
  actions2: (Action | string | number)[] | null;
  cells: BoundedCell[][] | null;
  lower: number;
  upper: number;
  lowerMatrix: number[][] | null;
  upperMatrix: number[][] | null;
  lowerSolution: MatrixSolution | null;
  upperSolution: MatrixSolution | null;
  parents: Set<SearchNode>;
  exactCertified: boolean;
}

const DEFAULT_LOWER = -1;
const DEFAULT_UPPER = 1;
const EPSILON = 1e-12;
const FRONTIER_TIE_EPSILON = 1e-9;

const nativeAdapter = Object.freeze({
  createTurnCursor,
  enumerateTurn,
  legalActions,
  restoreBattle,
  snapshotBattle,
  stateKey,
  terminalUtility,
});

function actionName(action) {
  if (typeof action === 'string') return action;
  return action?.name ?? action?.id ?? action?.command ?? String(action);
}

function finiteUtility(value) {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value < DEFAULT_LOWER || value > DEFAULT_UPPER) {
    throw new Error(`Invalid terminal utility: ${value}`);
  }
  return value;
}

function createStats() {
  return {
    expandedStates: 0,
    solvedStates: 0,
    discoveredStates: 0,
    transitionCalls: 0,
    simulatorRuns: 0,
    memoHits: 0,
    ppCacheHits: 0,
    backupUpdates: 0,
    expandedCells: 0,
    matrixSolves: 0,
    searchMs: 0,
    prepareMs: 0,
  };
}

/**
 * Anytime interval solver for finite or stochastic zero-sum games.
 *
 * A node is initialized once, then its action-pair cells are generated on
 * demand. Every generated cell interns only its immediate outcomes;
 * continuing outcomes are never recursively expanded as part of that
 * operation. Continuing cycles simply retain their current interval until
 * another path can improve it.
 */
class BoundedSearch {
  declare options: Required<Omit<BoundedOptions, 'adapter' | 'maxStates'>>;
  declare adapter: BoundedAdapter;
  declare nodes: Map<string, SearchNode>;
  declare snapshotKeyCache: WeakMap<object, string>;
  declare stats: ReturnType<typeof createStats>;
  declare limitReached: boolean;
  declare stopReason: string | null;
  declare deadline: number;
  declare _prepareStart: number;
  declare memoStateKey: StateKey;
  declare ppCache: ReturnType<typeof createPPTransitionCache> | null;
  declare ppAudit: symbol | null;
  declare eventPlan: ReturnType<typeof createEventPlan>;
  declare proofTurn: number;
  declare autoJoint: boolean;
  declare rootNode: SearchNode | null;

  constructor(options: BoundedOptions = {}) {
    this.options = {
      tolerance: options.tolerance ?? 0.02,
      maxSearchMs: options.maxSearchMs ?? Infinity,
      maxNodes: options.maxNodes ?? options.maxStates ?? 100000,
      maxSimulatorRunsPerTransition: options.maxSimulatorRunsPerTransition ?? 100000,
      warmStartRoot: options.warmStartRoot ?? true,
      lazyCells: options.lazyCells ?? true,
      selectionPolicy: options.selectionPolicy ?? 'auto',
    };
    if (!['auto', 'security', 'joint'].includes(this.options.selectionPolicy)) {
      throw new RangeError('selectionPolicy must be auto, security, or joint');
    }
    if (!(this.options.tolerance >= 0) || !Number.isFinite(this.options.tolerance)) {
      throw new RangeError('tolerance must be a finite non-negative number');
    }
    if (!(this.options.maxSearchMs >= 0) || Number.isNaN(this.options.maxSearchMs)) {
      throw new RangeError('maxSearchMs must be non-negative or Infinity');
    }
    if (!Number.isInteger(this.options.maxNodes) || this.options.maxNodes < 1) {
      throw new RangeError('maxNodes must be a positive integer');
    }
    this.adapter = options.adapter || nativeAdapter;
    this._reset();
  }

  _reset() {
    this.nodes = new Map();
    this.snapshotKeyCache = new WeakMap();
    this.stats = createStats();
    this.limitReached = false;
    this.stopReason = null;
    this.deadline = Infinity;
    this._prepareStart = 0;
    this.memoStateKey = this.adapter.stateKey || stateKey;
    this.ppCache = null;
    this.ppAudit = null;
    this.eventPlan = null;
    this.proofTurn = 0;
    this.autoJoint = false;
    this.rootNode = null;
  }

  /** Solve a battle, returning a certified interval around the value. */
  protected solveSync(battle): BoundedResult {
    this._reset();
    this._prepareStart = performance.now();
    const isNative = this.adapter === nativeAdapter;

    // Auditing and the initial snapshot are fixed preparation. The search
    // clock starts after them so maxSearchMs measures only anytime search.
    let nativeAudit;
    if (isNative) {
      nativeAudit = auditNativeRules(battle);
      this.memoStateKey = createMemoStateKey(battle, stateKey, nativeAudit);
      this.ppCache = createPPTransitionCache({admitOnSecondUse: true});
      this.ppAudit = auditPPBattle(battle, nativeAudit);
      this.eventPlan = createEventPlan(battle, nativeAudit);
    } else {
      this.memoStateKey = this.adapter.stateKey || stateKey;
    }
    const rootSnapshot = this._snapshot(battle);
    const root = this._intern(rootSnapshot);
    this.rootNode = root;
    const searchStart = performance.now();
    this.stats.prepareMs = searchStart - (this._prepareStart || searchStart);
    this.deadline = Number.isFinite(this.options.maxSearchMs)
      ? searchStart + this.options.maxSearchMs
      : Infinity;
    // Warm start initializes the root action dimensions. Cell generation is
    // still owned by the proof frontier, so the default API does not spend
    // its entire budget on an unrelated root row before descending.
    if (this.options.warmStartRoot && root.terminal === null) this._expand(root);
    this._backupFrom([root]);

    let converged = false;
    while (true) {
      this._backupFrom([root]);
      const width = root.upper - root.lower;
      if (width <= this.options.tolerance + EPSILON) {
        converged = true;
        break;
      }
      if (root.terminal !== null) {
        converged = true;
        break;
      }
      if (this._timedOut()) {
        this.stopReason = 'time';
        break;
      }
      if (this.stopReason) break;
      const selectionPolicy = this._selectionPolicyForRoot(root);
      if (selectionPolicy === 'security') this.proofTurn++;
      let frontier = this._selectFrontier(root, selectionPolicy);
      if (!frontier && selectionPolicy === 'security') {
        // A pure-policy proof path can terminate at a nearly exact child
        // while another mixed-equilibrium cell still carries useful width.
        // Retry the mandated joint frontier before reporting a stall.
        frontier = this._selectFrontier(root, 'joint');
      }
      if (!frontier) frontier = this._findAnyFrontier();
      if (!frontier) {
        if (!this.stopReason) this.stopReason = this.limitReached ? 'node-limit' : 'stalled';
        break;
      }
      if (frontier.initialize) this._expand(frontier.node);
      else this._expandCell(frontier.node, frontier.i, frontier.j);
      this._backupFrom([frontier.node]);
    }
    this._backupFrom([root]);
    const result = this._result(root, converged);
    this.stats.searchMs = performance.now() - searchStart;
    result.stats = {...this.stats, nodes: this.nodes.size};
    return result;
  }

  _snapshot(battle) {
    return this.adapter.snapshotBattle ? this.adapter.snapshotBattle(battle) : battle;
  }

  _restore(snapshot) {
    return this.adapter.restoreBattle ? this.adapter.restoreBattle(snapshot) : snapshot;
  }

  _key(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return String(snapshot);
    let key = this.snapshotKeyCache.get(snapshot);
    if (key === undefined) {
      key = this.memoStateKey(snapshot);
      this.snapshotKeyCache.set(snapshot, key);
    }
    return key;
  }

  _terminal(snapshot) {
    if (!this.adapter.terminalUtility) return null;
    const restored = this._restore(snapshot);
    return finiteUtility(this.adapter.terminalUtility(restored));
  }

  _intern(snapshot: Snapshot, skipTerminal = false): SearchNode | null {
    const key = this._key(snapshot);
    const existing = this.nodes.get(key);
    if (existing) {
      this.stats.memoHits++;
      return existing;
    }
    if (this.nodes.size >= this.options.maxNodes) {
      this.limitReached = true;
      return null;
    }
    const terminal = skipTerminal ? null : this._terminal(snapshot);
    const node: SearchNode = {
      key,
      snapshot,
      terminal,
      initialized: terminal !== null,
      actions1: null,
      actions2: null,
      cells: null,
      lower: terminal === null ? DEFAULT_LOWER : terminal,
      upper: terminal === null ? DEFAULT_UPPER : terminal,
      lowerMatrix: null,
      upperMatrix: null,
      lowerSolution: null,
      upperSolution: null,
      parents: new Set(),
      exactCertified: terminal !== null,
    };
    this.nodes.set(key, node);
    this.stats.discoveredStates++;
    this.stats.solvedStates = this.stats.discoveredStates;
    return node;
  }

  _transitionOptions() {
    if (this.adapter !== nativeAdapter) return {};
    return {
      maxSimulatorRunsPerTransition: this.options.maxSimulatorRunsPerTransition,
      deadline: this.deadline,
      eventPlan: this.eventPlan,
      ppCache: this.ppCache,
      ppAudit: this.ppAudit,
      outcomeKey: this.memoStateKey.private ? privateSnapshotKey : undefined,
    };
  }

  _selectionPolicyForRoot(root: SearchNode) {
    if (this.options.selectionPolicy !== 'auto' || this.autoJoint) {
      return this.autoJoint ? 'joint' : this.options.selectionPolicy;
    }
    if (!root.initialized || !root.lowerSolution || !root.upperSolution) return 'security';
    const bestPureRowFloor = Math.max(...root.cells.map(row =>
      Math.min(...row.map(cell => cell.lower))));
    const bestPureColumnCeiling = Math.min(...root.cells[0].map((_, j) =>
      Math.max(...root.cells.map(row => row[j].upper))));
    if (root.lowerSolution.value > bestPureRowFloor + 1e-9 ||
        root.upperSolution.value < bestPureColumnCeiling - 1e-9) {
      this.autoJoint = true;
      return 'joint';
    }
    return 'security';
  }

  _initializeNode(node: SearchNode) {
    const battle = this._restore(node.snapshot);
    const getActions = this.adapter.legalActions || legalActions;
    node.actions1 = getActions(battle, 0) || [];
    node.actions2 = getActions(battle, 1) || [];
    if (!node.actions1.length || !node.actions2.length) {
      throw new Error('BoundedSolver requires at least one legal action per player');
    }
    node.cells = Array.from({length: node.actions1.length}, () =>
      Array.from({length: node.actions2.length}, () => ({
        outcomes: null,
        lower: DEFAULT_LOWER,
        upper: DEFAULT_UPPER,
      })));
    node.initialized = true;
    this.stats.expandedStates++;
  }

  _acceptTransition(node: SearchNode, i, j, transition) {
    this.stats.transitionCalls++;
    this.stats.simulatorRuns += transition.simulatorRuns || 0;
    this.stats.ppCacheHits += transition.cacheHits || 0;
    const progressive = transition.remainingProbability !== undefined;
    const remaining = progressive ? Number(transition.remainingProbability) : 0;
    if (!Number.isFinite(remaining) || remaining < 0 || remaining > 1 ||
        (progressive && transition.complete && remaining !== 0)) {
      throw new Error(`Invalid remaining transition probability: ${remaining}`);
    }
    if (transition.complete === false && !progressive) {
      this.stopReason = this._timedOut() ? 'time' : 'transition-incomplete';
      return;
    }
    if (!Array.isArray(transition.outcomes) || !transition.outcomes.length && remaining === 0) {
      throw new Error('A transition must have at least one outcome');
    }
    const outcomes = [];
    for (const outcome of transition.outcomes) {
      const probability = Number(outcome.probability);
      if (!(probability >= 0) || !Number.isFinite(probability)) {
        throw new Error(`Invalid transition probability: ${outcome.probability}`);
      }
      if (outcome.snapshot === undefined) {
        const utility = finiteUtility(outcome.utility);
        if (utility === null) throw new Error('Terminal outcome lacks utility');
        outcomes.push({probability, utility, child: null});
        continue;
      }
      const child = this._intern(outcome.snapshot, this.adapter === nativeAdapter);
      if (child) child.parents.add(node);
      outcomes.push({probability, child, utility: null});
    }
    const total = remaining + outcomes.reduce((sum, outcome) => sum + outcome.probability, 0);
    if (!(total > 0) || Math.abs(total - 1) > 1e-9) {
      throw new Error(`Transition probabilities sum to ${total}, not 1`);
    }
    if (!progressive || transition.complete) {
      for (const outcome of outcomes) outcome.probability /= total;
    }
    const cell = node.cells[i][j];
    if (!cell.outcomes) this.stats.expandedCells++;
    cell.outcomes = outcomes;
    cell.remainingProbability = remaining;
    if (transition.complete) cell.cursor = null;
  }

  _expand(node: SearchNode) {
    if (node.terminal !== null || node.initialized) return;
    if (this._timedOut()) {
      this.stopReason = 'time';
      return;
    }
    this._initializeNode(node);
    // Cell generation is scheduled by `_selectFrontier`, which lets the
    // search descend through a promising generated outcome before paying for
    // unrelated action pairs. Unknown cells remain [-1, 1], so delaying them
    // cannot strengthen a bounded certificate. The interval contract and
    // complete action dimensions remain unchanged.
  }

  _expandCell(node: SearchNode, i, j) {
    if (node.terminal !== null || !node.initialized) return;
    const cell = node.cells[i][j];
    if (cell.outcomes && !cell.cursor) return;
    if (this._timedOut()) {
      this.stopReason = 'time';
      return;
    }
    if (this.adapter.createTurnCursor) {
      cell.cursor ||= this.adapter.createTurnCursor(node.snapshot, node.actions1[i], node.actions2[j], this._transitionOptions());
      const progress = cell.cursor.advance({maxRuns: 32, deadline: Math.min(this.deadline, performance.now() + 25)});
      this._acceptTransition(node, i, j, progress);
      return;
    }
    const runTransition = this.adapter.enumerateTurn || enumerateTurn;
    const transition = runTransition(
      node.snapshot,
      node.actions1[i],
      node.actions2[j],
      this._transitionOptions()
    );
    this._acceptTransition(node, i, j, transition);
  }

  _cellBounds(cell: BoundedCell) {
    if (!cell.outcomes) return;
    const oldLower = cell.lower;
    const oldUpper = cell.upper;
    let lower = -(cell.remainingProbability || 0);
    let upper = cell.remainingProbability || 0;
    for (const outcome of cell.outcomes) {
      let childLower = outcome.utility;
      let childUpper = outcome.utility;
      if (outcome.utility === null) {
        childLower = outcome.child ? outcome.child.lower : DEFAULT_LOWER;
        childUpper = outcome.child ? outcome.child.upper : DEFAULT_UPPER;
      }
      lower += outcome.probability * childLower;
      upper += outcome.probability * childUpper;
    }
    const nextLower = Math.max(DEFAULT_LOWER, Math.min(DEFAULT_UPPER, lower));
    const nextUpper = Math.max(DEFAULT_LOWER, Math.min(DEFAULT_UPPER, upper));
    // Bellman interval updates are monotone. Retaining the previous endpoint
    // also protects a certificate from a tiny floating-point reversal.
    cell.lower = Math.min(cell.upper, Math.max(cell.lower, nextLower));
    cell.upper = Math.max(cell.lower, Math.min(cell.upper, nextUpper));
    return cell.lower !== oldLower || cell.upper !== oldUpper;
  }

  _refresh(node: SearchNode) {
    if (node.terminal !== null) return false;
    if (!node.initialized) return false;
    let matrixChanged = node.lowerSolution === null;
    for (const row of node.cells) {
      for (const cell of row) matrixChanged = this._cellBounds(cell) || matrixChanged;
    }
    const previousExact = node.exactCertified;
    const exactCertified = node.cells.every(row => row.every(cell => cell.outcomes && !cell.cursor && !cell.remainingProbability &&
      cell.outcomes.every(outcome => outcome.utility !== null ||
        (outcome.child && outcome.child.exactCertified))));
    if (!matrixChanged) {
      node.exactCertified = exactCertified;
      return previousExact !== exactCertified;
    }
    const lowerMatrix = node.cells.map(row => row.map(cell => cell.lower));
    const upperMatrix = node.cells.map(row => row.map(cell => cell.upper));
    const lowerSolution = solveZeroSumMatrix(lowerMatrix);
    const upperSolution = solveZeroSumMatrix(upperMatrix);
    this.stats.matrixSolves++;
    const oldLower = node.lower;
    const oldUpper = node.upper;
    // Re-evaluate the two security certificates from the strategies returned
    // by the matrix solver. This makes floating-point roundoff widen an
    // interval conservatively instead of turning a numerical equality into a
    // false certificate.
    const lowerSecurity = Math.min(...lowerMatrix[0].map((_, j) =>
      lowerMatrix.reduce((sum, row, i) => sum + lowerSolution.p1[i] * row[j], 0)));
    const upperSecurity = Math.max(...upperMatrix.map((row, i) =>
      row.reduce((sum, entry, j) => sum + entry * upperSolution.p2[j], 0)));
    const lowerValue = lowerSecurity - 1e-10;
    const upperValue = upperSecurity + 1e-10;
    const boundedLower = Math.max(DEFAULT_LOWER, Math.min(DEFAULT_UPPER, lowerValue));
    const boundedUpper = Math.max(DEFAULT_LOWER, Math.min(DEFAULT_UPPER, upperValue));
    node.lower = Math.min(node.upper, Math.max(node.lower, boundedLower));
    node.upper = Math.max(node.lower, Math.min(node.upper, boundedUpper));
    node.exactCertified = exactCertified;
    node.lowerMatrix = lowerMatrix;
    node.upperMatrix = upperMatrix;
    node.lowerSolution = lowerSolution;
    node.upperSolution = upperSolution;
    // Parents only consume this node's interval endpoints and exactness. A
    // changed internal matrix with identical exported bounds cannot affect a
    // parent, so do not enqueue needless ancestor refreshes for it.
    return previousExact !== exactCertified ||
      Math.abs(oldLower - node.lower) > EPSILON || Math.abs(oldUpper - node.upper) > EPSILON;
  }

  _backupFrom(startNodes: SearchNode[]) {
    const queue = [...startNodes];
    const queued = new Set(queue);
    let updates = 0;
    while (queue.length) {
      if (updates > 0 && (updates & 63) === 0 && this._timedOut()) {
        this.stopReason = 'time';
        break;
      }
      const node = queue.shift();
      queued.delete(node);
      if (this._refresh(node)) {
        updates++;
        for (const parent of node.parents) {
          if (!queued.has(parent)) {
            queued.add(parent);
            queue.push(parent);
          }
        }
      }
      // A monotone interval backup on a cycle can only have useful changes
      // while an endpoint moves. This guard prevents pathological adapters
      // from monopolizing the synchronous lane.
      if (++this.stats.backupUpdates > this.options.maxNodes * 1000) {
        this.stopReason = this.stopReason || 'stalled';
        break;
      }
    }
    return updates;
  }

  _selectFrontier(root: SearchNode, selectionPolicy = this.options.selectionPolicy) {
    const path = new Set();
    let node = root;
    // A root security proof propagates through positive-probability child
    // outcomes: refining a lower root certificate requires lower certificates
    // from every unresolved descendant on that path. Keep this scheduling
    // direction for the whole traversal; mixed local matrices still use joint
    // selection.
    let lowerProof = false;
    let directionChosen = selectionPolicy !== 'security';
    while (node && node.terminal === null) {
      if (!node.initialized) return {node, initialize: true};
      if (path.has(node)) return null;
      path.add(node);
      this._refresh(node);
      if (!directionChosen) {
        if (root.upper >= DEFAULT_UPPER - EPSILON) {
          // At the global upper ceiling, keep lower proof only when the
          // pessimistic incumbent row could still reach that ceiling. If its
          // optimistic floor is already below the root ceiling, prefer upper
          // proof to test the opponent column that may invalidate it.
          let incumbent: {i: number; floor: number; mean: number} | null = null;
          for (let i = 0; i < root.cells.length; i++) {
            const row = root.cells[i];
            const floor = Math.min(...row.map(cell => cell.lower));
            const mean = row.reduce((sum, cell) => sum + cell.lower, 0) / row.length;
            if (!incumbent || floor > incumbent.floor + FRONTIER_TIE_EPSILON ||
                (Math.abs(floor - incumbent.floor) <= FRONTIER_TIE_EPSILON &&
                 mean > incumbent.mean + FRONTIER_TIE_EPSILON)) {
              incumbent = {i, floor, mean};
            }
          }
          const optimisticFloor = Math.min(...root.cells[incumbent.i].map(cell => cell.upper));
          lowerProof = optimisticFloor >= root.upper - EPSILON;
        } else {
          lowerProof = (this.proofTurn & 1) === 1;
        }
        directionChosen = true;
      }
      const rowStrategy = node.upperSolution?.p1 || [];
      const colStrategy = node.lowerSolution?.p2 || [];
      const canExpandCell = cell => {
        if (cell.upper - cell.lower <= 1e-9) return false;
        if (!cell.outcomes || cell.cursor) return true;
        return cell.outcomes.some(outcome => outcome.utility === null && outcome.child &&
          outcome.child.upper - outcome.child.lower > 1e-9);
      };
      const chooseJoint = () => {
        let selected = null;
        for (let i = 0; i < node.cells.length; i++) {
          for (let j = 0; j < node.cells[i].length; j++) {
            const cell = node.cells[i][j];
            if (!canExpandCell(cell)) continue;
            const gap = cell.upper - cell.lower;
            const score = (rowStrategy[i] || 0) * (colStrategy[j] || 0) * gap;
            if (!selected || score > selected.score + EPSILON ||
                (Math.abs(score - selected.score) <= EPSILON && gap > selected.gap)) {
              selected = {i, j, cell, score, gap};
            }
          }
        }
        return selected;
      };
      const chooseJointUnexpanded = () => {
        let selected = null;
        for (let i = 0; i < node.cells.length; i++) {
          for (let j = 0; j < node.cells[i].length; j++) {
            const cell = node.cells[i][j];
            if (cell.outcomes || cell.upper - cell.lower <= 1e-9) continue;
            const gap = cell.upper - cell.lower;
            const score = (rowStrategy[i] || 0) * (colStrategy[j] || 0) * gap;
            if (!selected || score > selected.score + EPSILON ||
                (Math.abs(score - selected.score) <= EPSILON && gap > selected.gap)) {
              selected = {i, j, cell, score, gap};
            }
          }
        }
        if (!selected || selected.score > EPSILON) return selected;
        for (let i = 0; i < node.cells.length; i++) {
          for (let j = 0; j < node.cells[i].length; j++) {
            const cell = node.cells[i][j];
            if (!cell.outcomes && cell.upper - cell.lower > selected.gap + EPSILON) {
              selected = {i, j, cell, score: 0, gap: cell.upper - cell.lower};
            }
          }
        }
        return selected;
      };
      const chooseSecurityCell = (cells, lowerProof) => {
        let selected = null;
        for (let j = 0; j < cells.length; j++) {
          const cell = cells[j];
          if (!canExpandCell(cell)) continue;
          const gap = cell.upper - cell.lower;
          const bound = lowerProof ? cell.lower : cell.upper;
          if (!selected) {
            selected = {j, cell, gap, bound, score: gap};
            continue;
          }
          const improvesBound = lowerProof
            ? bound < selected.bound - EPSILON
            : bound > selected.bound + EPSILON;
          const tiesBound = Math.abs(bound - selected.bound) <= EPSILON;
          if (improvesBound || (tiesBound && gap > selected.gap + EPSILON)) {
            selected = {j, cell, gap, bound, score: gap};
          }
        }
        return selected;
      };
      const lowerPotential = cells =>
        Math.min(...cells.map(cell => cell.upper)) - Math.min(...cells.map(cell => cell.lower));
      const upperPotential = cells =>
        Math.max(...cells.map(cell => cell.upper)) - Math.max(...cells.map(cell => cell.lower));
      let chosen = null;
      let preferUnexpanded = false;
      if (selectionPolicy === 'security') {
        const bestPureRowFloor = Math.max(...node.cells.map(row =>
          Math.min(...row.map(cell => cell.lower))));
        const bestPureColumnCeiling = Math.min(...node.cells[0].map((_, j) =>
          Math.max(...node.cells.map(row => row[j].upper))));
        const lowerMatrixIsMixed = node.lowerSolution.value > bestPureRowFloor + 1e-9;
        const upperMatrixIsMixed = node.upperSolution.value < bestPureColumnCeiling - 1e-9;
        const mixedImprovement = (lowerProof && lowerMatrixIsMixed) ||
          (!lowerProof && upperMatrixIsMixed);
        preferUnexpanded = mixedImprovement;
        if (!mixedImprovement && lowerProof) {
          const rowStats = node.cells.map(row => ({
            floor: Math.min(...row.map(cell => cell.lower)),
            mean: row.reduce((sum, cell) => sum + cell.lower, 0) / row.length,
          }));
          let row = 0;
          for (let i = 1; i < rowStats.length; i++) {
            if (rowStats[i].floor > rowStats[row].floor + FRONTIER_TIE_EPSILON ||
                (Math.abs(rowStats[i].floor - rowStats[row].floor) <= FRONTIER_TIE_EPSILON &&
                 rowStats[i].mean > rowStats[row].mean + FRONTIER_TIE_EPSILON)) row = i;
          }
          if (Math.min(...node.cells[row].map(cell => cell.upper)) < DEFAULT_UPPER - EPSILON) {
            preferUnexpanded = true;
          }
          if (lowerPotential(node.cells[row]) > FRONTIER_TIE_EPSILON) {
            const selected = chooseSecurityCell(node.cells[row], true);
            if (selected) chosen = {...selected, i: row};
          }
        } else if (!mixedImprovement) {
          const columnStats = node.cells[0].map((_, j) => {
            const values = node.cells.map(row => row[j].upper);
            return {
              ceiling: Math.max(...values),
              mean: values.reduce((sum, value) => sum + value, 0) / values.length,
            };
          });
          let column = 0;
          for (let j = 1; j < columnStats.length; j++) {
            if (columnStats[j].ceiling < columnStats[column].ceiling - FRONTIER_TIE_EPSILON ||
                (Math.abs(columnStats[j].ceiling - columnStats[column].ceiling) <= FRONTIER_TIE_EPSILON &&
                 columnStats[j].mean < columnStats[column].mean - FRONTIER_TIE_EPSILON)) column = j;
          }
          const selectedColumn = node.cells.map(row => row[column]);
          if (Math.max(...selectedColumn.map(cell => cell.lower)) > DEFAULT_LOWER + EPSILON) {
            preferUnexpanded = true;
          }
          if (upperPotential(selectedColumn) > FRONTIER_TIE_EPSILON) {
            const selected = chooseSecurityCell(selectedColumn, false);
            if (selected) chosen = {...selected, i: selected.j, j: column};
          }
        }
        // If the selected security row/column is already resolved, retain
        // the joint optimistic/pessimistic frontier as a progress fallback.
        if (preferUnexpanded && (!chosen || chosen.cell.outcomes)) {
          const unexpanded = chooseJointUnexpanded();
          if (unexpanded) chosen = unexpanded;
        }
        if (!chosen || chosen.gap <= 1e-9) chosen = chooseJoint();
      } else {
        chosen = chooseJointUnexpanded() || chooseJoint();
      }
      if (!chosen || chosen.gap <= 1e-9) return null;
      // If equilibrium support gives a zero score, the largest gap remains a
      // valid best-first fallback and preserves progress for degenerate games.
      if (chosen.score <= EPSILON) {
        for (let i = 0; i < node.cells.length; i++) {
          for (let j = 0; j < node.cells[i].length; j++) {
            const cell = node.cells[i][j];
            if (cell.upper - cell.lower > chosen.gap) chosen = {i, j, cell, gap: cell.upper - cell.lower, score: 0};
          }
        }
      }
      // Keep this guard after the zero-support fallback: a defensive
      // synthetic or future selector may replace a generated choice with an
      // ungenerated cell while preserving conservative bounds.
      if (!chosen.cell.outcomes) return {node, i: chosen.i, j: chosen.j};
      // An outcome that still leaves the complete [-1, 1] interval carries
      // no directional information. Before descending into that opaque child,
      // spend one transition on another cell at this node so a useful row or
      // column certificate can emerge. The preference follows the active
      // proof direction; joint selection uses the existing support score.
      const fullyUnknown = chosen.cell.outcomes &&
        chosen.cell.lower <= DEFAULT_LOWER + EPSILON &&
        chosen.cell.upper >= DEFAULT_UPPER - EPSILON;
      if (fullyUnknown) {
        let sibling = null;
        const considerCandidate = (i, j) => {
          const cell = node.cells[i][j];
          if (cell.outcomes || cell.upper - cell.lower <= 1e-9) return;
          const preferredAxis = selectionPolicy === 'security' && lowerProof ? 'row' : 'column';
          const priority = preferredAxis === 'row'
            ? (i === chosen.i ? 0 : j === chosen.j ? 1 : 2)
            : (j === chosen.j ? 0 : i === chosen.i ? 1 : 2);
          const score = (rowStrategy[i] || 0) * (colStrategy[j] || 0);
          const gap = cell.upper - cell.lower;
          if (!sibling || priority < sibling.priority ||
              (priority === sibling.priority &&
               (score > sibling.score + EPSILON ||
                (Math.abs(score - sibling.score) <= EPSILON && gap > sibling.gap + EPSILON)))) {
            sibling = {i, j, priority, score, gap};
          }
        };
        for (let i = 0; i < node.cells.length; i++) {
          for (let j = 0; j < node.cells[i].length; j++) considerCandidate(i, j);
        }
        if (sibling) return {node, i: sibling.i, j: sibling.j};
      }
      let next = null;
      let nextScore = -1;
      for (const outcome of chosen.cell.outcomes) {
        if (!outcome.child || outcome.utility !== null) continue;
        const gap = outcome.child.upper - outcome.child.lower;
        if (gap <= 1e-9) continue;
        const score = outcome.probability * gap;
        if (score > nextScore) {
          next = outcome.child;
          nextScore = score;
        }
      }
      if (chosen.cell.cursor && 2 * chosen.cell.remainingProbability >= nextScore) {
        return {node, i: chosen.i, j: chosen.j};
      }
      if (!next) return null;
      node = next;
    }
    return null;
  }

  /**
   * Recover liveness when a strategy path closes on a cycle or has no
   * expandable support cell. Every interned node is reachable from the root
   * through a generated outcome, so a conservative graph scan can select any
   * remaining uninitialized node or ungenerated cell. This path is only used
   * after both security and joint selectors fail.
   */
  _findAnyFrontier() {
    for (const node of this.nodes.values()) {
      if (this._timedOut()) {
        this.stopReason = 'time';
        return null;
      }
      if (node.terminal !== null) continue;
      if (node.upper - node.lower <= 1e-9) continue;
      if (!node.initialized) {
        return {node, initialize: true};
      }
      for (let i = 0; i < node.cells.length; i++) {
        for (let j = 0; j < node.cells[i].length; j++) {
          const cell = node.cells[i][j];
          if ((!cell.outcomes || cell.cursor) && cell.upper - cell.lower > 1e-9) return {node, i, j};
        }
      }
    }
    return null;
  }

  _timedOut() {
    return performance.now() >= this.deadline;
  }

  _strategy(actions: (Action | string | number)[], strategy: number[]): StrategyEntry[] {
    if (!actions || !strategy) return [];
    return actions.map((action, index) => ({
      action: actionName(action),
      probability: strategy[index] || 0,
    }));
  }

  _result(root: SearchNode, converged: boolean): BoundedResult {
    const lower = root.lower;
    const upper = root.upper;
    const width = Math.max(0, upper - lower);
    const midpoint = (lower + upper) / 2;
    const lowerMatrix = root.lowerMatrix || [];
    const upperMatrix = root.upperMatrix || [];
    const midpointMatrix = lowerMatrix.map((row, i) => row.map((value, j) =>
      (value + upperMatrix[i][j]) / 2));
    const intervalMatrix = lowerMatrix.map((row, i) => row.map((value, j) => ({
      lowerBound: value,
      upperBound: upperMatrix[i][j],
    })));
    return {
      value: midpoint,
      lowerBound: lower,
      upperBound: upper,
      valueErrorBound: width / 2,
      converged: !!converged,
      approximate: !root.exactCertified,
      isApproximate: !root.exactCertified,
      exact: !!root.exactCertified,
      stopReason: converged ? null : this.stopReason,
      p1Strategy: this._strategy(root.actions1, root.lowerSolution?.p1),
      p2Strategy: this._strategy(root.actions2, root.upperSolution?.p2),
      // Keep the established numeric payoffMatrix shape for callers that
      // display it, while making approximation explicit and exposing the
      // certified interval under stable, unambiguous names.
      payoffMatrix: midpointMatrix,
      payoffMatrixLower: lowerMatrix,
      payoffMatrixUpper: upperMatrix,
      payoffMatrixIntervals: intervalMatrix,
      stats: {...this.stats, nodes: this.nodes.size},
    };
  }
}

class BoundedSolver extends BoundedSearch {
  solve(battle): BoundedResult {
    return this.solveSync(battle);
  }
}

export {BoundedSearch, BoundedSolver};
