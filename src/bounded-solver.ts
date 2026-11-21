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
import {createTerminalEnvelope} from './terminal-envelope';
import {canRunInEngine, createEngineBoundedAdapter} from './engine';

const PROBABILITY_SUM_TOLERANCE = 1e-9;

export interface MonotoneSignature {
  groupKey: string;
  h1: number | null;
  h2: number | null;
}
export interface MonotoneBoxOutcome {
  probability: number;
  lowerSnapshot: Snapshot | null;
  upperSnapshot: Snapshot | null;
  split: () => (import('./types').Outcome | MonotoneBoxOutcome)[];
}
export interface BoundedTransitionCursor {
  advance: (options?: {maxRuns?: number; deadline?: number}) => {
    outcomes: (import('./types').Outcome | MonotoneBoxOutcome)[];
    remainingProbability: number;
    simulatorRuns: number;
    cacheHits?: number;
    complete: boolean;
  };
}

export interface PpSignature {
  /** Key identifying identical non-PP state (with low PP <= 2 kept exact). */
  groupKey: string;
  /** Flat move PP vector for all non-fainted Pokemon in deterministic order. */
  pp: number[];
  /** Maximum PP a single move can lose per turn (1 normally, 2+ with Pressure). */
  maxPpLossPerTurn: number;
}

export interface BoundedAdapter {
  // Custom adapters may use primitive state IDs and action IDs.
  snapshotBattle?: (battle: any) => any;
  restoreBattle?: (snapshot: any) => any;
  stateKey?: (snapshot: any) => string;
  monotoneSignature?: (snapshot: any) => MonotoneSignature | null;
  ppSignature?: (snapshot: any) => PpSignature | null;
  terminalUtility?: (battle: any) => number | null;
  legalActions?: (battle: any, side: number) => (Action | string | number)[];
  createTurnCursor?: (snapshot: any, p1: any, p2: any, options?: any) => BoundedTransitionCursor;
  enumerateTurn: (snapshot: any, p1: any, p2: any, options?: any) => {
    outcomes: (import('./types').Outcome | MonotoneBoxOutcome)[];
    simulatorRuns?: number;
    cacheHits?: number;
    complete?: boolean;
  };
}
export interface BoundedOptions extends SolverOptions {
  tolerance?: number;
  maxSearchMs?: number;
  maxNodes?: number;
  warmStartRoot?: boolean;
  lazyCells?: boolean;
  selectionPolicy?: 'auto' | 'security' | 'joint';
  engine?: 'auto' | 'compact' | 'showdown';
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
  engine?: 'compact' | 'showdown' | 'custom';
}
interface BoundedOutcome {
  probability: number;
  utility: number | null;
  child: SearchNode | null;
  upperChild?: SearchNode | null;
  split?: (() => (import('./types').Outcome | MonotoneBoxOutcome)[]) | null;
}
interface BoundedCell {
  cursor?: BoundedTransitionCursor | null;
  remainingProbability?: number;
  outcomes: BoundedOutcome[] | null;
  lower: number;
  upper: number;
  lowerDepth?: number;
  upperDepth?: number;
}
interface MonotoneFrontier2D {
  h1: number;
  h2: number;
  val: number;
  depth: number;
}
interface MonotoneGroup {
  kind: 'h1' | 'h2' | '2d';
  nodes: SearchNode[];
  lowerFrontier: MonotoneFrontier2D[];
  upperFrontier: MonotoneFrontier2D[];
}
interface PpGroup {
  nodes: SearchNode[];
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
  lowerDepth: number;
  upperDepth: number;
  lowerMatrix: number[][] | null;
  upperMatrix: number[][] | null;
  lowerSolution: MatrixSolution | null;
  upperSolution: MatrixSolution | null;
  parents: Set<SearchNode>;
  exactCertified: boolean;
  dirty?: boolean;
  monoGroup?: MonotoneGroup | null;
  monoH1?: number | null;
  monoH2?: number | null;
  ppGroup?: PpGroup | null;
  ppVec?: number[] | null;
  ppLossPerTurn?: number;
}

const DEFAULT_LOWER = -1;
const DEFAULT_UPPER = 1;
const EPSILON = 1e-12;
const FRONTIER_TIE_EPSILON = 1e-9;
const MAX_PP_PROP_DEPTH = 32;
const MAX_PP_GROUP_NODES = 128;

function ppVectorsCompatible(a: number[], b: number[], threshold: number): boolean {
  if (a.length !== b.length) return false;
  for (let k = 0; k < a.length; k++) {
    if (a[k] !== b[k] && (a[k] <= threshold || b[k] <= threshold)) return false;
  }
  return true;
}

/**
 * Exact O(M*N) pure saddle-point check before invoking general LP/matrix reduction.
 * Returns identical value and pure strategies whenever max_i min_j M[i][j] === min_j max_i M[i][j].
 */
function solveMatrixFast(matrix: number[][]): MatrixSolution {
  const m = matrix.length;
  const n = matrix[0].length;
  let bestRow = 0;
  let bestRowMin = -Infinity;
  for (let i = 0; i < m; i++) {
    const row = matrix[i];
    let rowMin = row[0];
    for (let j = 1; j < n; j++) {
      if (row[j] < rowMin) rowMin = row[j];
    }
    if (rowMin > bestRowMin) {
      bestRowMin = rowMin;
      bestRow = i;
    }
  }
  let bestCol = 0;
  let bestColMax = Infinity;
  for (let j = 0; j < n; j++) {
    let colMax = matrix[0][j];
    for (let i = 1; i < m; i++) {
      if (matrix[i][j] > colMax) colMax = matrix[i][j];
    }
    if (colMax < bestColMax) {
      bestColMax = colMax;
      bestCol = j;
    }
  }
  if (bestRowMin >= bestColMax - 1e-12) {
    const p1 = new Array<number>(m).fill(0);
    const p2 = new Array<number>(n).fill(0);
    p1[bestRow] = 1;
    p2[bestCol] = 1;
    return {value: bestRowMin, p1, p2};
  }
  return solveZeroSumMatrix(matrix);
}

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
    terminalEnvelopes: 0,
    monotoneUpdates: 0,
    ppBoundUpdates: 0,
    boxSplits: 0,
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
  declare explicitAdapter: BoundedAdapter | null;
  declare adapter: BoundedAdapter;
  declare nodes: Map<string, SearchNode>;
  declare snapshotKeyCache: WeakMap<object, string>;
  declare monotoneGroups: Map<string, MonotoneGroup>;
  declare ppGroups: Map<string, PpGroup>;
  declare monoCornerTurn: number;
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
  declare terminalEnvelope: ReturnType<typeof createTerminalEnvelope>;

  constructor(options: BoundedOptions = {}) {
    this.options = {
      tolerance: options.tolerance ?? 0.02,
      maxSearchMs: options.maxSearchMs ?? Infinity,
      maxNodes: options.maxNodes ?? options.maxStates ?? 100000,
      maxSimulatorRunsPerTransition: options.maxSimulatorRunsPerTransition ?? 100000,
      warmStartRoot: options.warmStartRoot ?? true,
      lazyCells: options.lazyCells ?? true,
      selectionPolicy: options.selectionPolicy ?? 'auto',
      engine: options.engine ?? 'auto',
    };
    if (!['auto', 'security', 'joint'].includes(this.options.selectionPolicy)) {
      throw new RangeError('selectionPolicy must be auto, security, or joint');
    }
    if (!['auto', 'compact', 'showdown'].includes(this.options.engine)) {
      throw new RangeError('engine must be auto, compact, or showdown');
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
    this.explicitAdapter = options.adapter || null;
    this.adapter = this.explicitAdapter || nativeAdapter;
    this._reset();
  }

  _reset() {
    this.nodes = new Map();
    this.snapshotKeyCache = new WeakMap();
    this.monotoneGroups = new Map();
    this.ppGroups = new Map();
    this.monoCornerTurn = 0;
    this.stats = createStats();
    this.limitReached = false;
    this.stopReason = null;
    this.deadline = Infinity;
    this._prepareStart = 0;
    this.adapter = this.explicitAdapter || nativeAdapter;
    this.memoStateKey = this.adapter.stateKey || stateKey;
    this.ppCache = null;
    this.ppAudit = null;
    this.eventPlan = null;
    this.proofTurn = 0;
    this.autoJoint = false;
    this.rootNode = null;
    this.terminalEnvelope = null;
  }

  /** Solve a battle, returning a certified interval around the value. */
  protected solveSync(battle): BoundedResult {
    this._reset();
    this._prepareStart = performance.now();

    let engineLabel: 'compact' | 'showdown' | 'custom' = 'custom';
    let nativeAudit: boolean | undefined;

    if (this.explicitAdapter) {
      this.adapter = this.explicitAdapter;
      engineLabel = 'custom';
    } else if (this.options.engine === 'showdown') {
      this.adapter = nativeAdapter;
      engineLabel = 'showdown';
    } else {
      const isChampionsMod = battle?.dex?.currentMod === 'champions' || battle?.dex?.currentMod === 'championsregmb';
      const support = canRunInEngine(battle);
      let compactAdmitted = false;
      if (support.supported) {
        if (isChampionsMod) {
          compactAdmitted = true;
        } else {
          nativeAudit = auditNativeRules(battle);
          compactAdmitted = nativeAudit;
        }
      }
      if (compactAdmitted) {
        const compactAdapter = createEngineBoundedAdapter(battle);
        if (compactAdapter) {
          this.adapter = compactAdapter;
          engineLabel = 'compact';
        }
      }
      if (engineLabel !== 'compact') {
        if (this.options.engine === 'compact') {
          const reason = support.supported ? 'Battle failed native stock rules audit' : support.reasons.join('; ');
          throw new Error(`Compact engine cannot run this battle: ${reason}`);
        }
        this.adapter = nativeAdapter;
        engineLabel = 'showdown';
      }
    }

    const isNative = this.adapter === nativeAdapter;

    // Auditing and the initial snapshot are fixed preparation. The search
    // clock starts after them so maxSearchMs measures only anytime search.
    if (isNative) {
      if (nativeAudit === undefined) nativeAudit = auditNativeRules(battle);
      this.terminalEnvelope = createTerminalEnvelope(battle, nativeAudit);
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
      if (root.dirty !== false) this._backupFrom([root]);
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
      else if (frontier.splitOutcomeIndex !== undefined) {
        this._splitOutcome(frontier.node, frontier.i, frontier.j, frontier.splitOutcomeIndex);
      } else this._expandCell(frontier.node, frontier.i, frontier.j);
      this._backupFrom([frontier.node]);
    }
    this._backupFrom([root]);
    const result = this._result(root, converged);
    this.stats.searchMs = performance.now() - searchStart;
    result.stats = {...this.stats, nodes: this.nodes.size};
    result.engine = engineLabel;
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
      lowerDepth: 0,
      upperDepth: 0,
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
    if (terminal === null && this.rootNode !== null) {
      if (this.adapter.monotoneSignature) this._registerMonotone(node);
      if (this.adapter.ppSignature) this._registerPp(node);
    }
    return node;
  }

  _registerMonotone(node: SearchNode) {
    const sig = this.adapter.monotoneSignature!(node.snapshot);
    if (!sig || (sig.h1 === null && sig.h2 === null)) return;
    const kind: 'h1' | 'h2' | '2d' = sig.h1 !== null && sig.h2 !== null
      ? '2d'
      : sig.h1 !== null ? 'h1' : 'h2';
    let group = this.monotoneGroups.get(sig.groupKey);
    if (!group) {
      group = {kind, nodes: [], lowerFrontier: [], upperFrontier: []};
      this.monotoneGroups.set(sig.groupKey, group);
    }
    node.monoGroup = group;
    node.monoH1 = sig.h1;
    node.monoH2 = sig.h2;

    if (kind !== '2d') {
      const coord = kind === 'h1' ? sig.h1! : -sig.h2!;
      const list = group.nodes;
      let lo = 0;
      let hi = list.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        const mc = kind === 'h1' ? list[mid].monoH1! : -list[mid].monoH2!;
        if (mc < coord) lo = mid + 1;
        else hi = mid;
      }
      if (lo > 0 && list[lo - 1].lower > node.lower) {
        node.lower = list[lo - 1].lower;
        node.lowerDepth = list[lo - 1].lowerDepth;
      }
      if (lo < list.length && list[lo].upper < node.upper) {
        node.upper = list[lo].upper;
        node.upperDepth = list[lo].upperDepth;
      }
      if (node.lower > node.upper) {
        node.upper = node.lower;
        node.upperDepth = Math.max(node.lowerDepth, node.upperDepth);
      }
      list.splice(lo, 0, node);
      if (node.lower > DEFAULT_LOWER + EPSILON || node.upper < DEFAULT_UPPER - EPSILON) {
        this.stats.monotoneUpdates++;
      }
      return;
    }

    const h1 = sig.h1!;
    const h2 = sig.h2!;
    let bestL = node.lower;
    let bestLDepth = node.lowerDepth;
    for (const f of group.lowerFrontier) {
      if (f.h1 <= h1 && f.h2 >= h2 && f.val > bestL) {
        bestL = f.val;
        bestLDepth = f.depth;
      }
    }
    let bestU = node.upper;
    let bestUDepth = node.upperDepth;
    for (const f of group.upperFrontier) {
      if (f.h1 >= h1 && f.h2 <= h2 && f.val < bestU) {
        bestU = f.val;
        bestUDepth = f.depth;
      }
    }
    node.lower = bestL;
    node.lowerDepth = bestLDepth;
    if (bestU < bestL) {
      node.upper = bestL;
      node.upperDepth = Math.max(bestLDepth, bestUDepth);
    } else {
      node.upper = bestU;
      node.upperDepth = bestUDepth;
    }
    group.nodes.push(node);
    if (bestL > DEFAULT_LOWER + EPSILON || bestU < DEFAULT_UPPER - EPSILON) {
      this.stats.monotoneUpdates++;
    }
  }

  _registerPp(node: SearchNode) {
    const sig = this.adapter.ppSignature!(node.snapshot);
    if (!sig) return;
    let group = this.ppGroups.get(sig.groupKey);
    if (!group) {
      group = {nodes: []};
      this.ppGroups.set(sig.groupKey, group);
    }
    node.ppGroup = group;
    node.ppVec = sig.pp;
    node.ppLossPerTurn = sig.maxPpLossPerTurn;

    const oldLower = node.lower;
    const oldUpper = node.upper;
    for (let i = 0; i < group.nodes.length; i++) {
      const peer = group.nodes[i];
      if (peer.lower > node.lower + EPSILON && peer.lowerDepth > 0 && peer.lowerDepth <= MAX_PP_PROP_DEPTH) {
        if (ppVectorsCompatible(sig.pp, peer.ppVec!, sig.maxPpLossPerTurn * peer.lowerDepth)) {
          node.lower = Math.min(node.upper, peer.lower);
          node.lowerDepth = peer.lowerDepth;
        }
      }
      if (peer.upper < node.upper - EPSILON && peer.upperDepth > 0 && peer.upperDepth <= MAX_PP_PROP_DEPTH) {
        if (ppVectorsCompatible(sig.pp, peer.ppVec!, sig.maxPpLossPerTurn * peer.upperDepth)) {
          node.upper = Math.max(node.lower, peer.upper);
          node.upperDepth = peer.upperDepth;
        }
      }
    }
    if (group.nodes.length < MAX_PP_GROUP_NODES) {
      group.nodes.push(node);
    }
    if (node.lower > oldLower + EPSILON || node.upper < oldUpper - EPSILON) {
      this.stats.ppBoundUpdates++;
    }
  }

  _transitionOptions() {
    if (this.adapter !== nativeAdapter) {
      return {
        deadline: this.deadline,
        tolerance: this.options.tolerance,
      };
    }
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
    if (this.options.selectionPolicy !== 'auto') {
      return this.options.selectionPolicy;
    }
    if (!root.initialized || !root.lowerSolution || !root.upperSolution) {
      this.autoJoint = false;
      return 'security';
    }
    const bestPureRowFloor = Math.max(...root.cells.map(row =>
      Math.min(...row.map(cell => cell.lower))));
    const bestPureColumnCeiling = Math.min(...root.cells[0].map((_, j) =>
      Math.max(...root.cells.map(row => row[j].upper))));
    const isMixed =
      root.lowerSolution.value > bestPureRowFloor + 1e-9 ||
      root.upperSolution.value < bestPureColumnCeiling - 1e-9;
    this.autoJoint = isMixed;
    return isMixed ? 'joint' : 'security';
  }

  _initializeNode(node: SearchNode) {
    const battle = this._restore(node.snapshot);
    const getActions = this.adapter.legalActions || legalActions;
    node.actions1 = getActions(battle, 0) || [];
    node.actions2 = getActions(battle, 1) || [];
    if (!node.actions1.length || !node.actions2.length) {
      throw new Error('BoundedSolver requires at least one legal action per player');
    }
    const terminalEnvelope = this.terminalEnvelope?.(node.snapshot, this.deadline);
    node.cells = Array.from({length: node.actions1.length}, (_, i) =>
      Array.from({length: node.actions2.length}, (_, j) => {
        const envelope = terminalEnvelope?.(node.actions1[i] as Action, node.actions2[j] as Action);
        if (envelope) this.stats.terminalEnvelopes++;
        return {
          outcomes: null,
          lower: envelope?.lower ?? DEFAULT_LOWER,
          upper: envelope?.upper ?? DEFAULT_UPPER,
        };
      }));
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
    const skipTerminal = this.adapter === nativeAdapter;
    const outcomes: BoundedOutcome[] = [];
    for (const outcome of transition.outcomes) {
      outcomes.push(this._internOutcome(node, outcome, skipTerminal));
    }
    const completed = outcomes.reduce((sum, outcome) => sum + outcome.probability, 0);
    const total = remaining + completed;
    if (!(total > 0) || Math.abs(total - 1) > PROBABILITY_SUM_TOLERANCE) {
      throw new Error(`Transition probabilities sum to ${total}, not 1`);
    }
    // A later cumulative batch may have a different admitted total. For an
    // incomplete batch use the largest possible final total and leave the
    // residual unknown, so monotone bounds contain every final normalization.
    // Complete transitions retain normalization by their actual total.
    const incomplete = progressive && !transition.complete;
    const denominator = incomplete ? 1 + PROBABILITY_SUM_TOLERANCE : total;
    for (const outcome of outcomes) outcome.probability /= denominator;
    const cell = node.cells[i][j];
    if (!cell.outcomes) this.stats.expandedCells++;
    cell.outcomes = outcomes;
    cell.remainingProbability = incomplete ? Math.max(0, 1 - completed / denominator) : remaining / total;
    if (transition.complete) cell.cursor = null;
    node.dirty = true;
  }

  _internOutcome(node: SearchNode, outcome: any, skipTerminal: boolean): BoundedOutcome {
    const probability = Number(outcome.probability);
    if (!(probability >= 0) || !Number.isFinite(probability)) {
      throw new Error(`Invalid transition probability: ${outcome.probability}`);
    }
    if (outcome.lowerSnapshot !== undefined && outcome.upperSnapshot !== undefined && typeof outcome.split === 'function') {
      const lowerChild = outcome.lowerSnapshot !== null ? this._intern(outcome.lowerSnapshot, skipTerminal) : null;
      const upperChild = outcome.upperSnapshot !== null ? this._intern(outcome.upperSnapshot, skipTerminal) : null;
      if (lowerChild) lowerChild.parents.add(node);
      if (upperChild) upperChild.parents.add(node);
      if (lowerChild && upperChild && lowerChild === upperChild) {
        return {probability, utility: null, child: lowerChild, upperChild: null, split: null};
      }
      return {probability, utility: null, child: lowerChild, upperChild, split: outcome.split};
    }
    if (outcome.snapshot === undefined) {
      const utility = finiteUtility(outcome.utility);
      if (utility === null) throw new Error('Terminal outcome lacks utility');
      return {probability, utility, child: null, upperChild: null, split: null};
    }
    const child = this._intern(outcome.snapshot, skipTerminal);
    if (child) child.parents.add(node);
    return {probability, child, utility: null, upperChild: null, split: null};
  }

  _splitOutcome(node: SearchNode, i: number, j: number, outcomeIndex: number) {
    if (node.terminal !== null || !node.initialized) return;
    const cell = node.cells[i][j];
    if (!cell.outcomes || outcomeIndex < 0 || outcomeIndex >= cell.outcomes.length) return;
    const outcome = cell.outcomes[outcomeIndex];
    if (!outcome.split) return;
    if (this._timedOut()) {
      this.stopReason = 'time';
      return;
    }
    const rawSubs = outcome.split();
    if (!Array.isArray(rawSubs) || rawSubs.length === 0) {
      throw new Error('MonotoneBoxOutcome.split() must return at least one sub-outcome');
    }
    const skipTerminal = this.adapter === nativeAdapter;
    const subs = rawSubs.map(sub => this._internOutcome(node, sub, skipTerminal));
    const sum = subs.reduce((acc, s) => acc + s.probability, 0);
    if (!(sum > 0) || Math.abs(sum - outcome.probability) > 2 * PROBABILITY_SUM_TOLERANCE) {
      throw new Error(`Split sub-outcome probabilities sum to ${sum}, expected ${outcome.probability}`);
    }
    if (sum !== outcome.probability) {
      const scale = outcome.probability / sum;
      for (const s of subs) s.probability *= scale;
    }
    cell.outcomes.splice(outcomeIndex, 1, ...subs);
    node.dirty = true;
    this.stats.boxSplits++;
  }

  _expand(node: SearchNode) {
    if (node.terminal !== null || node.initialized) return;
    if (this._timedOut()) {
      this.stopReason = 'time';
      return;
    }
    this._initializeNode(node);
    node.dirty = true;
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
      const progress = cell.cursor.advance({maxRuns: 32, deadline: this.deadline});
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

  _cellBounds(cell: BoundedCell): number {
    if (!cell.outcomes) return 0;
    const oldLower = cell.lower;
    const oldUpper = cell.upper;
    let lower = -(cell.remainingProbability || 0);
    let upper = cell.remainingProbability || 0;
    let cLowerDepth = 0;
    let cUpperDepth = 0;
    const outcomes = cell.outcomes;
    for (let k = 0; k < outcomes.length; k++) {
      const outcome = outcomes[k];
      let childLower = outcome.utility;
      let childUpper = outcome.utility;
      if (childLower === null) {
        if (outcome.split) {
          childLower = outcome.child ? outcome.child.lower : DEFAULT_LOWER;
          childUpper = outcome.upperChild ? outcome.upperChild.upper : DEFAULT_UPPER;
          if (childLower > DEFAULT_LOWER + EPSILON && outcome.child) {
            const d = outcome.child.lowerDepth + 1;
            if (d > cLowerDepth) cLowerDepth = d;
          }
          if (childUpper < DEFAULT_UPPER - EPSILON && outcome.upperChild) {
            const d = outcome.upperChild.upperDepth + 1;
            if (d > cUpperDepth) cUpperDepth = d;
          }
        } else {
          childLower = outcome.child ? outcome.child.lower : DEFAULT_LOWER;
          childUpper = outcome.child ? outcome.child.upper : DEFAULT_UPPER;
          if (childLower > DEFAULT_LOWER + EPSILON && outcome.child) {
            const d = outcome.child.lowerDepth + 1;
            if (d > cLowerDepth) cLowerDepth = d;
          }
          if (childUpper < DEFAULT_UPPER - EPSILON && outcome.child) {
            const d = outcome.child.upperDepth + 1;
            if (d > cUpperDepth) cUpperDepth = d;
          }
        }
      } else {
        if (childLower > DEFAULT_LOWER + EPSILON && cLowerDepth < 1) cLowerDepth = 1;
        if (childUpper < DEFAULT_UPPER - EPSILON && cUpperDepth < 1) cUpperDepth = 1;
      }
      const p = outcome.probability;
      lower += p * childLower;
      upper += p * childUpper;
    }
    const nextLower = lower < DEFAULT_LOWER ? DEFAULT_LOWER : (lower > DEFAULT_UPPER ? DEFAULT_UPPER : lower);
    const nextUpper = upper < DEFAULT_LOWER ? DEFAULT_LOWER : (upper > DEFAULT_UPPER ? DEFAULT_UPPER : upper);
    // Bellman interval updates are monotone. Retaining the previous endpoint
    // also protects a certificate from a tiny floating-point reversal.
    if (nextLower > cell.lower + EPSILON) {
      cell.lower = Math.min(cell.upper, nextLower);
      cell.lowerDepth = nextLower > cell.upper ? Math.max(cLowerDepth, cell.upperDepth || 0) : cLowerDepth;
    } else if (nextLower > cell.lower) {
      cell.lower = Math.min(cell.upper, nextLower);
    }
    if (nextUpper < cell.upper - EPSILON) {
      cell.upper = Math.max(cell.lower, nextUpper);
      cell.upperDepth = nextUpper < cell.lower ? Math.max(cUpperDepth, cell.lowerDepth || 0) : cUpperDepth;
    } else if (nextUpper < cell.upper) {
      cell.upper = Math.max(cell.lower, nextUpper);
    }
    let mask = 0;
    if (cell.lower !== oldLower) mask |= 1;
    if (cell.upper !== oldUpper) mask |= 2;
    return mask;
  }

  _refresh(node: SearchNode) {
    if (node.terminal !== null) {
      node.dirty = false;
      return false;
    }
    if (!node.initialized) return false;
    let changeMask = node.lowerSolution === null ? 3 : 0;
    const cells = node.cells;
    for (let i = 0; i < cells.length; i++) {
      const row = cells[i];
      for (let j = 0; j < row.length; j++) {
        changeMask |= this._cellBounds(row[j]);
      }
    }
    const previousExact = node.exactCertified;
    if (changeMask === 0) {
      const exactCertified = node.upper - node.lower <= 1e-8 &&
        cells.every(row => row.every(cell => cell.outcomes && !cell.cursor && !cell.remainingProbability &&
          cell.outcomes.every(outcome => outcome.utility !== null ||
            (!outcome.split && outcome.child && outcome.child.exactCertified))));
      node.exactCertified = exactCertified;
      node.dirty = false;
      return previousExact !== exactCertified;
    }
    const oldLower = node.lower;
    const oldUpper = node.upper;
    this.stats.matrixSolves++;
    if ((changeMask & 1) !== 0 || !node.lowerMatrix || !node.lowerSolution) {
      const lowerMatrix = cells.map(row => row.map(cell => cell.lower));
      const lowerSolution = solveMatrixFast(lowerMatrix);
      let lowerSecurity = Infinity;
      const nCols = lowerMatrix[0].length;
      for (let j = 0; j < nCols; j++) {
        let sum = 0;
        for (let i = 0; i < lowerMatrix.length; i++) {
          sum += lowerSolution.p1[i] * lowerMatrix[i][j];
        }
        if (sum < lowerSecurity) lowerSecurity = sum;
      }
      const lowerValue = lowerSecurity - 1e-10;
      const boundedLower = Math.max(DEFAULT_LOWER, Math.min(DEFAULT_UPPER, lowerValue));
      if (boundedLower > node.lower + EPSILON) {
        let nextLowerDepth = 0;
        for (let i = 0; i < cells.length; i++) {
          if ((lowerSolution.p1[i] || 0) <= 1e-12) continue;
          const row = cells[i];
          for (let j = 0; j < row.length; j++) {
            if (row[j].lower > DEFAULT_LOWER + EPSILON) {
              const d = row[j].lowerDepth || (row[j].outcomes ? 1 : 1);
              if (d > nextLowerDepth) nextLowerDepth = d;
            }
          }
        }
        if (boundedLower > node.upper) {
          node.lower = node.upper;
          node.lowerDepth = Math.max(nextLowerDepth, node.upperDepth);
        } else {
          node.lower = boundedLower;
          node.lowerDepth = nextLowerDepth;
        }
      } else if (boundedLower > node.lower) {
        node.lower = Math.min(node.upper, boundedLower);
      }
      node.lowerMatrix = lowerMatrix;
      node.lowerSolution = lowerSolution;
    }
    if ((changeMask & 2) !== 0 || !node.upperMatrix || !node.upperSolution) {
      const upperMatrix = cells.map(row => row.map(cell => cell.upper));
      const upperSolution = solveMatrixFast(upperMatrix);
      let upperSecurity = -Infinity;
      for (let i = 0; i < upperMatrix.length; i++) {
        const row = upperMatrix[i];
        let sum = 0;
        for (let j = 0; j < row.length; j++) {
          sum += row[j] * upperSolution.p2[j];
        }
        if (sum > upperSecurity) upperSecurity = sum;
      }
      const upperValue = upperSecurity + 1e-10;
      const boundedUpper = Math.max(DEFAULT_LOWER, Math.min(DEFAULT_UPPER, upperValue));
      if (boundedUpper < node.upper - EPSILON) {
        let nextUpperDepth = 0;
        for (let j = 0; j < cells[0].length; j++) {
          if ((upperSolution.p2[j] || 0) <= 1e-12) continue;
          for (let i = 0; i < cells.length; i++) {
            const c = cells[i][j];
            if (c.upper < DEFAULT_UPPER - EPSILON) {
              const d = c.upperDepth || (c.outcomes ? 1 : 1);
              if (d > nextUpperDepth) nextUpperDepth = d;
            }
          }
        }
        if (boundedUpper < node.lower) {
          node.upper = node.lower;
          node.upperDepth = Math.max(nextUpperDepth, node.lowerDepth);
        } else {
          node.upper = boundedUpper;
          node.upperDepth = nextUpperDepth;
        }
      } else if (boundedUpper < node.upper) {
        node.upper = Math.max(node.lower, boundedUpper);
      }
      node.upperMatrix = upperMatrix;
      node.upperSolution = upperSolution;
    }
    const exactCertified = node.upper - node.lower <= 1e-8 &&
      cells.every(row => row.every(cell => cell.outcomes && !cell.cursor && !cell.remainingProbability &&
        cell.outcomes.every(outcome => outcome.utility !== null ||
          (!outcome.split && outcome.child && outcome.child.exactCertified))));
    node.exactCertified = exactCertified;
    node.dirty = false;
    // Parents only consume this node's interval endpoints and exactness. A
    // changed internal matrix with identical exported bounds cannot affect a
    // parent, so do not enqueue needless ancestor refreshes for it.
    return previousExact !== exactCertified ||
      Math.abs(oldLower - node.lower) > EPSILON || Math.abs(oldUpper - node.upper) > EPSILON;
  }

  _backupFrom(startNodes: SearchNode[]) {
    const queue = [...startNodes];
    const queued = new Set(queue);
    let head = 0;
    let updates = 0;
    while (head < queue.length) {
      if (updates > 0 && (updates & 63) === 0 && this._timedOut()) {
        this.stopReason = 'time';
        break;
      }
      const node = queue[head++];
      queued.delete(node);
      const prevLower = node.lower;
      const prevUpper = node.upper;
      if (this._refresh(node)) {
        updates++;
        for (const parent of node.parents) {
          parent.dirty = true;
          if (!queued.has(parent)) {
            queued.add(parent);
            queue.push(parent);
          }
        }
        const lowerImproved = node.lower > prevLower + EPSILON;
        const upperImproved = node.upper < prevUpper - EPSILON;
        if (node.monoGroup && (lowerImproved || upperImproved)) {
          this._propagateMonotone(node, lowerImproved, upperImproved, queue, queued);
        }
        if (node.ppGroup && (lowerImproved || upperImproved)) {
          this._propagatePp(node, lowerImproved, upperImproved, queue, queued);
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

  _propagatePp(
    source: SearchNode,
    lowerImproved: boolean,
    upperImproved: boolean,
    queue: SearchNode[],
    queued: Set<SearchNode>,
    allowMonoHop = true
  ) {
    const group = source.ppGroup;
    if (!group || !source.ppVec || !source.ppLossPerTurn) return;
    const canLower = lowerImproved && source.lower > DEFAULT_LOWER + EPSILON &&
      source.lowerDepth > 0 && source.lowerDepth <= MAX_PP_PROP_DEPTH;
    const canUpper = upperImproved && source.upper < DEFAULT_UPPER - EPSILON &&
      source.upperDepth > 0 && source.upperDepth <= MAX_PP_PROP_DEPTH;
    if (!canLower && !canUpper) return;

    const lThr = canLower ? source.ppLossPerTurn * source.lowerDepth : 0;
    const uThr = canUpper ? source.ppLossPerTurn * source.upperDepth : 0;
    const srcPp = source.ppVec;
    const list = group.nodes;

    for (let i = 0; i < list.length; i++) {
      const peer = list[i];
      if (peer === source || peer === this.rootNode) continue;
      let pLower = false;
      let pUpper = false;
      if (canLower && peer.lower < source.lower - EPSILON && ppVectorsCompatible(srcPp, peer.ppVec!, lThr)) {
        peer.lower = Math.min(peer.upper, source.lower);
        peer.lowerDepth = source.lowerDepth;
        this.stats.ppBoundUpdates++;
        pLower = true;
      }
      if (canUpper && peer.upper > source.upper + EPSILON && ppVectorsCompatible(srcPp, peer.ppVec!, uThr)) {
        peer.upper = Math.max(peer.lower, source.upper);
        peer.upperDepth = source.upperDepth;
        this.stats.ppBoundUpdates++;
        pUpper = true;
      }
      if (pLower || pUpper) {
        for (const parent of peer.parents) {
          parent.dirty = true;
          if (!queued.has(parent)) {
            queued.add(parent);
            queue.push(parent);
          }
        }
        if (allowMonoHop && peer.monoGroup) {
          this._propagateMonotone(peer, pLower, pUpper, queue, queued, false);
        }
      }
    }
  }

  _propagateMonotone(
    source: SearchNode,
    lowerImproved: boolean,
    upperImproved: boolean,
    queue: SearchNode[],
    queued: Set<SearchNode>,
    allowPpHop = true
  ) {
    const group = source.monoGroup;
    if (!group) return;
    const enqueueParents = (peer: SearchNode, pLower: boolean, pUpper: boolean) => {
      for (const parent of peer.parents) {
        parent.dirty = true;
        if (!queued.has(parent)) {
          queued.add(parent);
          queue.push(parent);
        }
      }
      if (allowPpHop && peer.ppGroup) {
        this._propagatePp(peer, pLower, pUpper, queue, queued, false);
      }
    };

    if (group.kind !== '2d') {
      const list = group.nodes;
      const coord = group.kind === 'h1' ? source.monoH1! : -source.monoH2!;
      let lo = 0;
      let hi = list.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        const mc = group.kind === 'h1' ? list[mid].monoH1! : -list[mid].monoH2!;
        if (mc < coord) lo = mid + 1;
        else hi = mid;
      }
      if (lowerImproved) {
        for (let k = lo + 1; k < list.length; k++) {
          const peer = list[k];
          if (peer.lower >= source.lower - EPSILON) break;
          if (peer === this.rootNode) continue;
          peer.lower = Math.min(peer.upper, source.lower);
          peer.lowerDepth = source.lowerDepth;
          this.stats.monotoneUpdates++;
          enqueueParents(peer, true, false);
        }
      }
      if (upperImproved) {
        for (let k = lo - 1; k >= 0; k--) {
          const peer = list[k];
          if (peer.upper <= source.upper + EPSILON) break;
          if (peer === this.rootNode) continue;
          peer.upper = Math.max(peer.lower, source.upper);
          peer.upperDepth = source.upperDepth;
          this.stats.monotoneUpdates++;
          enqueueParents(peer, false, true);
        }
      }
      return;
    }

    const h1 = source.monoH1!;
    const h2 = source.monoH2!;
    if (lowerImproved) {
      let dominated = false;
      for (const f of group.lowerFrontier) {
        if (f.h1 <= h1 && f.h2 >= h2 && f.val >= source.lower - EPSILON && f.depth <= source.lowerDepth) {
          dominated = true;
          break;
        }
      }
      if (!dominated) {
        group.lowerFrontier = group.lowerFrontier.filter(
          f => !(f.h1 >= h1 && f.h2 <= h2 && f.val <= source.lower + EPSILON && f.depth >= source.lowerDepth)
        );
        group.lowerFrontier.push({h1, h2, val: source.lower, depth: source.lowerDepth});
        for (const peer of group.nodes) {
          if (peer === source || peer === this.rootNode) continue;
          if (peer.monoH1! >= h1 && peer.monoH2! <= h2 && peer.lower < source.lower - EPSILON) {
            peer.lower = Math.min(peer.upper, source.lower);
            peer.lowerDepth = source.lowerDepth;
            this.stats.monotoneUpdates++;
            enqueueParents(peer, true, false);
          }
        }
      }
    }
    if (upperImproved) {
      let dominated = false;
      for (const f of group.upperFrontier) {
        if (f.h1 >= h1 && f.h2 <= h2 && f.val <= source.upper + EPSILON && f.depth <= source.upperDepth) {
          dominated = true;
          break;
        }
      }
      if (!dominated) {
        group.upperFrontier = group.upperFrontier.filter(
          f => !(f.h1 <= h1 && f.h2 >= h2 && f.val >= source.upper - EPSILON && f.depth >= source.upperDepth)
        );
        group.upperFrontier.push({h1, h2, val: source.upper, depth: source.upperDepth});
        for (const peer of group.nodes) {
          if (peer === source || peer === this.rootNode) continue;
          if (peer.monoH1! <= h1 && peer.monoH2! >= h2 && peer.upper > source.upper + EPSILON) {
            peer.upper = Math.max(peer.lower, source.upper);
            peer.upperDepth = source.upperDepth;
            this.stats.monotoneUpdates++;
            enqueueParents(peer, false, true);
          }
        }
      }
    }
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
      if (node.dirty !== false) this._refresh(node);
      if (!directionChosen) {
        const atUpperCeiling = root.upper >= DEFAULT_UPPER - EPSILON;
        const atLowerFloor = root.lower <= DEFAULT_LOWER + EPSILON;
        if (atUpperCeiling && !atLowerFloor) {
          // P1 has raised the lower bound while the upper bound is still at +1.
          // Focus on lower proof while the incumbent row can still reach +1;
          // probe upper proof periodically (1 in 4 after initial expansion) so
          // a 90%-accuracy incumbent whose true value is < 1 still gets refuted.
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
          if (optimisticFloor < root.upper - EPSILON) {
            lowerProof = false;
          } else if (this.proofTurn > 16 && root.cells[incumbent.i].every(cell => !!cell.outcomes)) {
            lowerProof = (this.proofTurn & 3) !== 0;
          } else {
            lowerProof = true;
          }
        } else if (atLowerFloor && !atUpperCeiling) {
          // Symmetric case: P2 has lowered the upper bound while the lower bound
          // is still at -1. Focus on upper proof while the incumbent column can
          // still reach -1; probe lower proof periodically (1 in 4) if stalled.
          let incumbent: {j: number; ceiling: number; mean: number} | null = null;
          for (let j = 0; j < root.cells[0].length; j++) {
            const ceiling = Math.max(...root.cells.map(row => row[j].upper));
            const mean = root.cells.reduce((sum, row) => sum + row[j].upper, 0) / root.cells.length;
            if (!incumbent || ceiling < incumbent.ceiling - FRONTIER_TIE_EPSILON ||
                (Math.abs(ceiling - incumbent.ceiling) <= FRONTIER_TIE_EPSILON &&
                 mean < incumbent.mean - FRONTIER_TIE_EPSILON)) {
              incumbent = {j, ceiling, mean};
            }
          }
          const optimisticCeiling = Math.max(...root.cells.map(row => row[incumbent.j].lower));
          if (optimisticCeiling > root.lower + EPSILON) {
            lowerProof = true;
          } else if (this.proofTurn > 16 && root.cells.every(row => !!row[incumbent.j].outcomes)) {
            lowerProof = (this.proofTurn & 3) === 0;
          } else {
            lowerProof = false;
          }
        } else if (atUpperCeiling && atLowerFloor) {
          // Both bounds are still at [-1, +1]: start with lower proof for the
          // incumbent row, then alternate evenly once its row is expanded.
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
          if (optimisticFloor < root.upper - EPSILON) {
            lowerProof = false;
          } else if (this.proofTurn > 16 && root.cells[incumbent.i].every(cell => !!cell.outcomes)) {
            lowerProof = (this.proofTurn & 1) === 1;
          } else {
            lowerProof = true;
          }
        } else {
          lowerProof = (this.proofTurn & 1) === 1;
        }
        directionChosen = true;
      }
      // When upperSolution.value is flat at +1 (or lowerSolution.value at -1),
      // only substitute the opposite matrix's optimal strategy if it ALREADY
      // achieves that optimal value in the flat matrix. This preserves exact
      // witnesses (e.g. a single row holding upper=+1) while resolving
      // degeneracy when multiple actions tie at the global bound.
      const flatUpper = (node.upperSolution?.value ?? DEFAULT_UPPER) >= DEFAULT_UPPER - EPSILON;
      const flatLower = (node.lowerSolution?.value ?? DEFAULT_LOWER) <= DEFAULT_LOWER + EPSILON;
      let useLowerP1 = false;
      if (flatUpper && !flatLower && node.lowerSolution?.p1) {
        const lp1 = node.lowerSolution.p1;
        useLowerP1 = true;
        for (let j = 0; j < node.cells[0].length; j++) {
          let ev = 0;
          for (let i = 0; i < node.cells.length; i++) ev += (lp1[i] || 0) * node.cells[i][j].upper;
          if (ev < (node.upperSolution?.value ?? DEFAULT_UPPER) - EPSILON) {
            useLowerP1 = false;
            break;
          }
        }
      }
      let useUpperP2 = false;
      if (flatLower && !flatUpper && node.upperSolution?.p2) {
        const up2 = node.upperSolution.p2;
        useUpperP2 = true;
        for (let i = 0; i < node.cells.length; i++) {
          let ev = 0;
          for (let j = 0; j < node.cells[i].length; j++) ev += node.cells[i][j].lower * (up2[j] || 0);
          if (ev > (node.lowerSolution?.value ?? DEFAULT_LOWER) + EPSILON) {
            useUpperP2 = false;
            break;
          }
        }
      }
      const rowStrategy = (useLowerP1 ? node.lowerSolution?.p1 : node.upperSolution?.p1) || [];
      const colStrategy = (useUpperP2 ? node.upperSolution?.p2 : node.lowerSolution?.p2) || [];
      const canExpandCell = cell => {
        if (cell.upper - cell.lower <= 1e-9) return false;
        if (!cell.outcomes || cell.cursor) return true;
        return cell.outcomes.some(outcome => {
          if (outcome.utility !== null) return false;
          if (outcome.split) {
            const lo = outcome.child ? outcome.child.lower : DEFAULT_LOWER;
            const hi = outcome.upperChild ? outcome.upperChild.upper : DEFAULT_UPPER;
            return hi - lo > 1e-9;
          }
          return !!(outcome.child && outcome.child.upper - outcome.child.lower > 1e-9);
        });
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
      const chooseSecurityCell = (cells, lowerProof, danger?: number[]) => {
        let selected = null;
        for (let j = 0; j < cells.length; j++) {
          const cell = cells[j];
          if (!canExpandCell(cell)) continue;
          const gap = cell.upper - cell.lower;
          const bound = lowerProof ? cell.lower : cell.upper;
          const d = danger ? danger[j] : 0;
          if (!selected) {
            selected = {j, cell, gap, bound, danger: d, score: gap};
            continue;
          }
          const improvesBound = lowerProof
            ? bound < selected.bound - EPSILON
            : bound > selected.bound + EPSILON;
          const tiesBound = Math.abs(bound - selected.bound) <= EPSILON;
          const tiesGap = Math.abs(gap - selected.gap) <= EPSILON;
          if (improvesBound ||
              (tiesBound && gap > selected.gap + EPSILON) ||
              (tiesBound && tiesGap && d > selected.danger + FRONTIER_TIE_EPSILON)) {
            selected = {j, cell, gap, bound, danger: d, score: gap};
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
            optFloor: Math.min(...row.map(cell => cell.upper)),
            mean: row.reduce((sum, cell) => sum + cell.lower, 0) / row.length,
          }));
          let row = -1;
          for (let i = 0; i < rowStats.length; i++) {
            const s = rowStats[i];
            if (s.optFloor <= node.lower + FRONTIER_TIE_EPSILON) continue;
            if (row < 0 || s.floor > rowStats[row].floor + FRONTIER_TIE_EPSILON ||
                (Math.abs(s.floor - rowStats[row].floor) <= FRONTIER_TIE_EPSILON &&
                 s.mean > rowStats[row].mean + FRONTIER_TIE_EPSILON)) row = i;
          }
          if (row < 0) {
            row = 0;
            for (let i = 1; i < rowStats.length; i++) {
              if (rowStats[i].floor > rowStats[row].floor + FRONTIER_TIE_EPSILON ||
                  (Math.abs(rowStats[i].floor - rowStats[row].floor) <= FRONTIER_TIE_EPSILON &&
                   rowStats[i].mean > rowStats[row].mean + FRONTIER_TIE_EPSILON)) row = i;
            }
          }
          // Periodically probe the strongest non-incumbent contender row at root
          // that already beats node.lower on at least half the opponent responses
          // and still has optFloor >= incumbent.optFloor. This breaks lock-in on
          // a suboptimal high-floor move (e.g. a 90%-acc move) without diverting
          // budget into unpromising junk rows.
          if (node === root && this.proofTurn > 16 && (this.proofTurn & 3) === 3) {
            const minBeating = Math.ceil(node.cells[0].length / 2);
            let alt = -1;
            for (let i = 0; i < rowStats.length; i++) {
              if (i === row) continue;
              const s = rowStats[i];
              if (s.optFloor <= node.lower + this.options.tolerance) continue;
              if (s.optFloor < rowStats[row].optFloor - EPSILON) continue;
              if (lowerPotential(node.cells[i]) <= FRONTIER_TIE_EPSILON) continue;
              let beating = 0;
              for (const cell of node.cells[i]) {
                if (cell.lower > node.lower + FRONTIER_TIE_EPSILON) beating++;
              }
              if (beating < minBeating) continue;
              if (alt < 0 || s.mean > rowStats[alt].mean + FRONTIER_TIE_EPSILON) alt = i;
            }
            if (alt >= 0) row = alt;
          }
          if (rowStats[row].optFloor < DEFAULT_UPPER - EPSILON) {
            preferUnexpanded = true;
          }
          if (lowerPotential(node.cells[row]) > FRONTIER_TIE_EPSILON) {
            const colDanger = node.cells[0].map((_, j) =>
              -node.cells.reduce((sum, r) => sum + r[j].upper, 0) / node.cells.length);
            const selected = chooseSecurityCell(node.cells[row], true, colDanger);
            if (selected) chosen = {...selected, i: row};
          }
        } else if (!mixedImprovement) {
          const columnStats = node.cells[0].map((_, j) => {
            const uppers = node.cells.map(row => row[j].upper);
            const lowers = node.cells.map(row => row[j].lower);
            return {
              ceiling: Math.max(...uppers),
              optCeiling: Math.max(...lowers),
              mean: uppers.reduce((sum, value) => sum + value, 0) / uppers.length,
            };
          });
          let column = -1;
          for (let j = 0; j < columnStats.length; j++) {
            const s = columnStats[j];
            if (s.optCeiling >= node.upper - FRONTIER_TIE_EPSILON) continue;
            if (column < 0 || s.ceiling < columnStats[column].ceiling - FRONTIER_TIE_EPSILON ||
                (Math.abs(s.ceiling - columnStats[column].ceiling) <= FRONTIER_TIE_EPSILON &&
                 s.mean < columnStats[column].mean - FRONTIER_TIE_EPSILON)) column = j;
          }
          if (column < 0) {
            column = 0;
            for (let j = 1; j < columnStats.length; j++) {
              if (columnStats[j].ceiling < columnStats[column].ceiling - FRONTIER_TIE_EPSILON ||
                  (Math.abs(columnStats[j].ceiling - columnStats[column].ceiling) <= FRONTIER_TIE_EPSILON &&
                   columnStats[j].mean < columnStats[column].mean - FRONTIER_TIE_EPSILON)) column = j;
            }
          }
          if (node === root && this.proofTurn > 16 && (this.proofTurn & 3) === 2) {
            const minBeating = Math.ceil(node.cells.length / 2);
            let alt = -1;
            for (let j = 0; j < columnStats.length; j++) {
              if (j === column) continue;
              const s = columnStats[j];
              if (s.optCeiling >= node.upper - this.options.tolerance) continue;
              if (s.optCeiling > columnStats[column].optCeiling + EPSILON) continue;
              if (upperPotential(node.cells.map(r => r[j])) <= FRONTIER_TIE_EPSILON) continue;
              let beating = 0;
              for (const r of node.cells) {
                if (r[j].upper < node.upper - FRONTIER_TIE_EPSILON) beating++;
              }
              if (beating < minBeating) continue;
              if (alt < 0 || s.mean < columnStats[alt].mean - FRONTIER_TIE_EPSILON) alt = j;
            }
            if (alt >= 0) column = alt;
          }
          const selectedColumn = node.cells.map(row => row[column]);
          if (columnStats[column].optCeiling > DEFAULT_LOWER + EPSILON) {
            preferUnexpanded = true;
          }
          if (upperPotential(selectedColumn) > FRONTIER_TIE_EPSILON) {
            const rowDanger = node.cells.map(r =>
              r.reduce((sum, cell) => sum + cell.lower, 0) / r.length);
            const selected = chooseSecurityCell(selectedColumn, false, rowDanger);
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
      const preferLowerCorner = selectionPolicy === 'security'
        ? lowerProof
        : ((this.monoCornerTurn++ & 1) === 0);
      const {child: next, splitOutcomeIndex, maxSingleScore} = this._selectCellChild(
        chosen.cell.outcomes,
        path,
        preferLowerCorner
      );
      if (chosen.cell.cursor && 2 * chosen.cell.remainingProbability >= maxSingleScore) {
        return {node, i: chosen.i, j: chosen.j};
      }
      if (splitOutcomeIndex !== undefined) {
        return {node, i: chosen.i, j: chosen.j, splitOutcomeIndex};
      }
      if (!next) return null;
      node = next;
    }
    return null;
  }

  _selectCellChild(
    outcomes: BoundedOutcome[],
    path: Set<unknown>,
    preferLowerCorner: boolean
  ): {child: SearchNode | null; splitOutcomeIndex?: number; maxSingleScore: number} {
    if (!this.adapter.monotoneSignature && !outcomes.some(o => !!o.split)) {
      let next: SearchNode | null = null;
      let nextScore = -1;
      for (const outcome of outcomes) {
        if (!outcome.child || outcome.utility !== null) continue;
        const gap = outcome.child.upper - outcome.child.lower;
        if (gap <= 1e-9) continue;
        const score = outcome.probability * gap;
        if (score > nextScore) {
          next = outcome.child;
          nextScore = score;
        }
      }
      return {child: next, maxSingleScore: nextScore};
    }

    let maxSingleScore = -1;
    let bestSingle: SearchNode | null = null;
    let bestSingleScore = -1;
    let bestBoxIdx = -1;
    let bestBoxScore = -1;
    let groups: Map<MonotoneGroup, {score: number; members: {child: SearchNode; prob: number}[]}> | null = null;

    for (let idx = 0; idx < outcomes.length; idx++) {
      const outcome = outcomes[idx];
      if (outcome.utility !== null) continue;
      if (outcome.split) {
        const loNode = outcome.child;
        const hiNode = outcome.upperChild;
        const lo = loNode ? loNode.lower : DEFAULT_LOWER;
        const hi = hiNode ? hiNode.upper : DEFAULT_UPPER;
        const boxGap = hi - lo;
        if (boxGap <= 1e-9) continue;
        const score = outcome.probability * boxGap;
        if (score > maxSingleScore) maxSingleScore = score;
        const loCanDescend = !!(loNode && !path.has(loNode) && loNode.upper - loNode.lower > 1e-9);
        const hiCanDescend = !!(hiNode && !path.has(hiNode) && hiNode.upper - hiNode.lower > 1e-9);
        if (!loCanDescend && !hiCanDescend && this.limitReached) continue;
        if (score > bestBoxScore + EPSILON) {
          bestBoxScore = score;
          bestBoxIdx = idx;
        }
        continue;
      }
      const child = outcome.child;
      if (!child) continue;
      const gap = child.upper - child.lower;
      if (gap <= 1e-9) continue;
      const score = outcome.probability * gap;
      if (score > maxSingleScore) maxSingleScore = score;
      if (path.has(child)) continue;

      const mg = child.monoGroup;
      if (!mg) {
        if (score > bestSingleScore) {
          bestSingle = child;
          bestSingleScore = score;
        }
        continue;
      }
      if (!groups) groups = new Map();
      let entry = groups.get(mg);
      if (!entry) {
        entry = {score: 0, members: []};
        groups.set(mg, entry);
      }
      entry.score += score;
      entry.members.push({child, prob: outcome.probability});
    }

    let bestGroup: MonotoneGroup | null = null;
    let bestGroupEntry: {score: number; members: {child: SearchNode; prob: number}[]} | null = null;
    if (groups) {
      for (const [mg, entry] of groups) {
        if (!bestGroupEntry || entry.score > bestGroupEntry.score + EPSILON) {
          bestGroup = mg;
          bestGroupEntry = entry;
        }
      }
    }

    const bestGroupScore = bestGroupEntry ? bestGroupEntry.score : -1;
    if (bestBoxIdx >= 0 && bestBoxScore >= bestGroupScore - EPSILON && bestBoxScore >= bestSingleScore - EPSILON) {
      const box = outcomes[bestBoxIdx];
      const loNode = box.child;
      const hiNode = box.upperChild;
      const loGap = loNode && !path.has(loNode) ? loNode.upper - loNode.lower : 0;
      const hiGap = hiNode && !path.has(hiNode) ? hiNode.upper - hiNode.lower : 0;
      const spreadGap = loNode && hiNode ? Math.max(0, hiNode.lower - loNode.upper) : 0;
      if (preferLowerCorner && loGap > 1e-9 && loGap >= spreadGap) {
        return {child: loNode, maxSingleScore};
      }
      if (!preferLowerCorner && hiGap > 1e-9 && hiGap >= spreadGap) {
        return {child: hiNode, maxSingleScore};
      }
      if (loGap > 1e-9 && loGap >= spreadGap) {
        return {child: loNode, maxSingleScore};
      }
      if (hiGap > 1e-9 && hiGap >= spreadGap) {
        return {child: hiNode, maxSingleScore};
      }
      if (!this.limitReached) {
        return {child: null, splitOutcomeIndex: bestBoxIdx, maxSingleScore};
      }
      if (loGap > 1e-9) return {child: loNode, maxSingleScore};
      if (hiGap > 1e-9) return {child: hiNode, maxSingleScore};
      return {child: null, maxSingleScore};
    }

    if (!bestGroupEntry || bestSingleScore > bestGroupEntry.score + EPSILON) {
      return {child: bestSingle, maxSingleScore};
    }

    const members = bestGroupEntry.members;
    if (members.length === 1) {
      return {child: members[0].child, maxSingleScore};
    }

    if (bestGroup!.kind !== '2d') {
      const isH1 = bestGroup!.kind === 'h1';
      members.sort((a, b) => {
        const ca = isH1 ? a.child.monoH1! : -a.child.monoH2!;
        const cb = isH1 ? b.child.monoH1! : -b.child.monoH2!;
        return ca - cb;
      });
      let bestChild = members[0].child;
      let bestGain = -1;
      for (let i = 0; i < members.length; i++) {
        const c = members[i].child;
        let gain = 0;
        if (preferLowerCorner) {
          const cu = c.upper;
          for (let j = i; j < members.length; j++) {
            const d = cu - members[j].child.lower;
            if (d > 0) gain += members[j].prob * d;
          }
        } else {
          const cl = c.lower;
          for (let j = 0; j <= i; j++) {
            const d = members[j].child.upper - cl;
            if (d > 0) gain += members[j].prob * d;
          }
        }
        if (gain > bestGain + EPSILON) {
          bestGain = gain;
          bestChild = c;
        }
      }
      return {child: bestChild, maxSingleScore};
    }

    // 2D monotone group: prune to Pareto-undominated corner candidates first so
    // an unexpanded 16x16 grid collapses to a single corner candidate in O(k).
    const candidates: SearchNode[] = [];
    if (preferLowerCorner) {
      // Lower proof: small h1, large h2, high upper dominates (h1 >=, h2 <=, upper <=).
      members.sort((a, b) =>
        (a.child.monoH1! - b.child.monoH1!) || (b.child.monoH2! - a.child.monoH2!)
      );
      for (const m of members) {
        const c = m.child;
        const h1 = c.monoH1!;
        const h2 = c.monoH2!;
        const u = c.upper;
        let dominated = false;
        for (const cand of candidates) {
          if (cand.monoH1! <= h1 && cand.monoH2! >= h2 && cand.upper >= u - EPSILON) {
            dominated = true;
            break;
          }
        }
        if (!dominated) candidates.push(c);
      }
    } else {
      // Upper proof: large h1, small h2, low lower dominates (h1 <=, h2 >=, lower >=).
      members.sort((a, b) =>
        (b.child.monoH1! - a.child.monoH1!) || (a.child.monoH2! - b.child.monoH2!)
      );
      for (const m of members) {
        const c = m.child;
        const h1 = c.monoH1!;
        const h2 = c.monoH2!;
        const l = c.lower;
        let dominated = false;
        for (const cand of candidates) {
          if (cand.monoH1! >= h1 && cand.monoH2! <= h2 && cand.lower <= l + EPSILON) {
            dominated = true;
            break;
          }
        }
        if (!dominated) candidates.push(c);
      }
    }

    if (candidates.length === 1) {
      return {child: candidates[0], maxSingleScore};
    }

    let bestChild = candidates[0];
    let bestGain = -1;
    for (const c of candidates) {
      const ch1 = c.monoH1!;
      const ch2 = c.monoH2!;
      let gain = 0;
      if (preferLowerCorner) {
        const cu = c.upper;
        for (const m of members) {
          const p = m.child;
          if (p.monoH1! >= ch1 && p.monoH2! <= ch2) {
            const d = cu - p.lower;
            if (d > 0) gain += m.prob * d;
          }
        }
      } else {
        const cl = c.lower;
        for (const m of members) {
          const p = m.child;
          if (p.monoH1! <= ch1 && p.monoH2! >= ch2) {
            const d = p.upper - cl;
            if (d > 0) gain += m.prob * d;
          }
        }
      }
      if (gain > bestGain + EPSILON) {
        bestGain = gain;
        bestChild = c;
      }
    }
    return {child: bestChild, maxSingleScore};
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
          if (cell.outcomes && !this.limitReached && cell.upper - cell.lower > 1e-9) {
            for (let k = 0; k < cell.outcomes.length; k++) {
              const o = cell.outcomes[k];
              if (o.split) {
                const lo = o.child ? o.child.lower : DEFAULT_LOWER;
                const hi = o.upperChild ? o.upperChild.upper : DEFAULT_UPPER;
                if (hi - lo > 1e-9) return {node, i, j, splitOutcomeIndex: k};
              }
            }
          }
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
