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
  /** Signed HP vector (+hp for P1, -hp for P2) for multi-Pokemon N-D monotone dominance. */
  vec?: number[];
}
export interface MonotoneBoxOutcome {
  probability: number;
  lowerSnapshot: Snapshot | null;
  upperSnapshot: Snapshot | null;
  split: (violatedSide?: 'lower' | 'upper' | 'both') => (import('./types').Outcome | MonotoneBoxOutcome)[];
  /** Bitmask of Pokemon (bits 0..5 P1, 6..11 P2) that fainted during this turn transition. */
  faintMask?: number;
  /** Lower corner is sound only when its witness never faints any Pokemon in this bitmask. */
  lowerReqNoFaintMask?: number;
  /** Lower corner is sound only when its witness never executes a P1 draining move. */
  lowerReqNoDrain?: boolean;
  /** Upper corner is sound only when its witness never faints any Pokemon in this bitmask. */
  upperReqNoFaintMask?: number;
  /** Upper corner is sound only when its witness never executes a P2 draining move. */
  upperReqNoDrain?: boolean;
}
export interface BoundedTransitionCursor {
  advance: (options?: {maxRuns?: number; deadline?: number}) => {
    outcomes: (import('./types').Outcome | MonotoneBoxOutcome)[];
    remainingProbability: number;
    simulatorRuns: number;
    cacheHits?: number;
    complete: boolean;
    equivalentRows?: number[];
    equivalentCols?: number[];
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

export interface JointMonoPpSignature {
  /** Base state key with BOTH PP masked and eligible monotone/conditional HP axes masked, plus mode tag. */
  groupKey: string;
  /** Signed HP vector (+hp for P1 mons, -hp for P2 mons). */
  vec: number[];
  /** Per-axis side (0 = P1, 1 = P2). */
  sides: number[];
  /** Per-axis Pokemon bitmask: 1 << (side * 6 + pokeIdx). */
  bits: number[];
  /** Per-axis mode: 0 = unconditional, 1 = no-drain-opp, 2 = survive-self. */
  modes: number[];
  /** Flat move PP vector for all non-fainted Pokemon in deterministic order. */
  pp: number[];
  /** Maximum PP a single move can lose per turn (1 normally, 2+ with Pressure). */
  maxPpLossPerTurn: number;
}

export interface ProtectContractionInfo {
  /** Which side (0 or 1) has stalling active Pokemon (protectStreak >= 1). */
  stallingSide: 0 | 1;
  /** Number of stalling active Pokemon with protectStreak >= 1 (1 or 2). */
  stallSlotsCount: 1 | 2;
  /** Minimum protectStreak (1 <= streak <= 5) across stalling Pokemon(s); equals slot 0 streak when stallSlotsCount === 1. */
  streak: number;
  /** Exact per-stalling-slot streaks [s0] or [s0, s1] (1 <= s0, s1 <= 6, min < 6). */
  streaks?: [number] | [number, number];
  /** Base state key masking PP and stalling Pokemon protectStreak(s), for exact self-shift detection. */
  baseKey: string;
  /** True when contracting across equal positive Tailwind turns on both sides (requires opp witness not to use Tailwind). */
  equalTailwind?: boolean;
  /** Number of stalling slots (0, 1, or 2) using Protect/Endure in this action on `stallingSide`. */
  stallActionCount: (action: any) => 0 | 1 | 2;
  /** Bitmask (0..3) of stalling slots using Protect/Endure in this action on `stallingSide`. */
  stallActionMask?: (action: any) => 0 | 1 | 2 | 3;
  /** True if the action on the opposing (proving) side is eligible for contraction. */
  isOpponentActionEligible: (action: any) => boolean;
  /**
   * Maximum safe target streak K (<= 6) relative to `streak = min(streaks)` given
   * the proving action, all pure self-shift stall actions, and max proof horizon of
   * all non-stall and stall-fail branches. Returns <= streak when PP is insufficient.
   */
  maxSafeStreak: (opponentAction: any, selfShiftActions: any[], maxProofDepth: number) => number;
  /**
   * Inspect a concrete outcome snapshot: returns validity, count (and optional bitmask)
   * of stalling Pokemon that incremented streak, and baseKey when all succeeded.
   */
  inspectOutcome: (snapshot: any) => {valid: boolean; succCount: 0 | 1 | 2; succMask?: 0 | 1 | 2 | 3; baseKey: string} | null;
}

export interface BoundedAdapter {
  // Custom adapters may use primitive state IDs and action IDs.
  snapshotBattle?: (battle: any) => any;
  restoreBattle?: (snapshot: any) => any;
  stateKey?: (snapshot: any) => string;
  monotoneSignature?: (snapshot: any) => MonotoneSignature | null;
  ppSignature?: (snapshot: any) => PpSignature | null;
  jointMonoPpSignature?: (snapshot: any) => JointMonoPpSignature | null;
  protectContractionInfo?: (snapshot: any) => ProtectContractionInfo | null;
  terminalUtility?: (battle: any) => number | null;
  legalActions?: (battle: any, side: number) => (Action | string | number)[];
  createTurnCursor?: (snapshot: any, p1: any, p2: any, options?: any) => BoundedTransitionCursor;
  enumerateTurn: (snapshot: any, p1: any, p2: any, options?: any) => {
    outcomes: (import('./types').Outcome | MonotoneBoxOutcome)[];
    simulatorRuns?: number;
    cacheHits?: number;
    complete?: boolean;
    equivalentRows?: number[];
    equivalentCols?: number[];
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
  split?: ((violatedSide?: 'lower' | 'upper' | 'both') => (import('./types').Outcome | MonotoneBoxOutcome)[]) | null;
  faintMask?: number;
  lowerReqNoFaintMask?: number;
  lowerReqNoDrain?: boolean;
  upperReqNoFaintMask?: number;
  upperReqNoDrain?: boolean;
  /** Uninterned snapshot for large-matrix lazy leaf interning (concrete outcomes). */
  lazySnapshot?: Snapshot | null;
  /** Uninterned lower/upper corner snapshots for large-matrix lazy box corners. */
  lazyLowerSnapshot?: Snapshot | null;
  lazyUpperSnapshot?: Snapshot | null;
  /** Read-only monotone/PP cached bounds for lazy outcomes/corners (zero SearchNode allocation). */
  lazyLower?: number;
  lazyUpper?: number;
  lazyLowerDepth?: number;
  lazyUpperDepth?: number;
  lazyLowerFaintMask?: number;
  lazyLowerUsedDrain?: boolean;
  lazyUpperFaintMask?: number;
  lazyUpperUsedDrain?: boolean;
  /** Monotone cache of best valid (non-violated) box corner bounds so later dirty corner refinements never regress box bounds. */
  validBoxLower?: number;
  validBoxLowerDepth?: number;
  validBoxLowerFaintMask?: number;
  validBoxLowerUsedDrain?: boolean;
  validBoxUpper?: number;
  validBoxUpperDepth?: number;
  validBoxUpperFaintMask?: number;
  validBoxUpperUsedDrain?: boolean;
}
interface CellCoord {
  i: number;
  j: number;
  probes: number;
}
interface BoundedCell {
  cursor?: BoundedTransitionCursor | null;
  remainingProbability?: number;
  outcomes: BoundedOutcome[] | null;
  lower: number;
  upper: number;
  lowerDepth?: number;
  upperDepth?: number;
  lowerFaintMask?: number;
  lowerUsedDrain?: boolean;
  upperFaintMask?: number;
  upperUsedDrain?: boolean;
  probes?: number;
  /** Shared matrix positions referencing this exact BoundedCell equivalence class. */
  coords?: CellCoord[];
  /** True when newly attached sibling coordinates need matrix/sum synchronization in _refresh. */
  needsSync?: boolean;
}
interface MonotoneFrontier2D {
  h1: number;
  h2: number;
  val: number;
  depth: number;
  faintMask: number;
  usedDrain: boolean;
}
interface MonotoneFrontierND {
  vec: number[];
  val: number;
  depth: number;
  faintMask: number;
  usedDrain: boolean;
}
interface MonotoneGroup {
  kind: 'h1' | 'h2' | '2d' | 'nd';
  nodes: SearchNode[];
  lowerFrontier: MonotoneFrontier2D[];
  upperFrontier: MonotoneFrontier2D[];
  lowerFrontierNd?: MonotoneFrontierND[];
  upperFrontierNd?: MonotoneFrontierND[];
}
interface PpGroup {
  nodes: SearchNode[];
}
interface JointWitness {
  vec: number[];
  pp: number[];
  val: number;
  depth: number;
  faintMask: number;
  usedDrain: boolean;
}
interface JointLazyWatcher {
  parent: SearchNode;
  outcome: BoundedOutcome;
  /** 0 = concrete lazySnapshot, 1 = lazyLowerSnapshot, 2 = lazyUpperSnapshot */
  kind: 0 | 1 | 2;
  vec: number[];
  pp: number[];
}
interface JointMonoPpGroup {
  sides: number[];
  bits: number[];
  modes: number[];
  maxPpLossPerTurn: number;
  lowerWitnesses: JointWitness[];
  upperWitnesses: JointWitness[];
  activeNodes: SearchNode[];
  lazyWatchers: JointLazyWatcher[];
}
interface ExactLazyWatcher {
  parent: SearchNode;
  outcome: BoundedOutcome;
  /** 0 = concrete lazySnapshot, 1 = lazyLowerSnapshot, 2 = lazyUpperSnapshot */
  kind: 0 | 1 | 2;
}
export interface SearchNode {
  key: string;
  snapshot: Snapshot;
  terminal: number | null;
  initialized: boolean;
  actions1: (Action | string | number)[] | null;
  actions2: (Action | string | number)[] | null;
  cells: BoundedCell[][] | null;
  populatedCells?: {i: number; j: number; cell: BoundedCell}[];
  populatedCellCount?: number;
  rowFloor?: Float64Array;
  rowOptFloor?: Float64Array;
  rowLowerSum?: Float64Array;
  colCeil?: Float64Array;
  colOptCeil?: Float64Array;
  colUpperSum?: Float64Array;
  rowOpaqueProbes?: Int32Array;
  colOpaqueProbes?: Int32Array;
  rowStallProbes?: Int32Array;
  colStallProbes?: Int32Array;
  localVisitTurn?: number;
  bestPureRowFloor?: number;
  bestPureColCeil?: number;
  lower: number;
  upper: number;
  lowerDepth: number;
  upperDepth: number;
  lowerFaintMask: number;
  lowerUsedDrain: boolean;
  upperFaintMask: number;
  upperUsedDrain: boolean;
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
  monoVec?: number[] | null;
  ppGroup?: PpGroup | null;
  ppVec?: number[] | null;
  ppLossPerTurn?: number;
  jointGroup?: JointMonoPpGroup | null;
  jointVec?: number[] | null;
  jointPp?: number[] | null;
  protectInfo?: ProtectContractionInfo | null;
}

const DEFAULT_LOWER = -1;
const DEFAULT_UPPER = 1;
const EPSILON = 1e-12;
const FRONTIER_TIE_EPSILON = 1e-9;
const MAX_PP_PROP_DEPTH = 32;
const MAX_PP_GROUP_NODES = 128;
const MAX_ND_GROUP_NODES = 256;
const MAX_ND_FRONTIER = 64;
const MAX_JOINT_WITNESSES = 256;
const MAX_JOINT_ACTIVE_NODES = 4096;
const MAX_JOINT_LAZY_WATCHERS = 16384;
const MAX_EXACT_LAZY_WATCHERS_TOTAL = 262144;
const TW_P1_BIT = 1 << 12;
const TW_P2_BIT = 1 << 13;

function vecDominates(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let k = 0; k < a.length; k++) {
    if (a[k] < b[k]) return false;
  }
  return true;
}

function ppVectorsCompatible(a: number[], b: number[], threshold: number): boolean {
  if (a.length !== b.length) return false;
  for (let k = 0; k < a.length; k++) {
    if (a[k] !== b[k] && (a[k] <= threshold || b[k] <= threshold)) return false;
  }
  return true;
}

/**
 * Check if a joint witness `w` soundly certifies `target.lower >= w.val`
 * across both conditional/unconditional HP dominance and finite-horizon PP compatibility.
 * Returns the conservatively updated `faintMask` (>= 0) on success, or -1 if inapplicable.
 */
function jointTransferLowerMask(
  w: JointWitness,
  tVec: number[],
  tPp: number[],
  group: JointMonoPpGroup
): number {
  const thr = group.maxPpLossPerTurn * w.depth;
  if (!ppVectorsCompatible(tPp, w.pp, thr)) return -1;
  const sides = group.sides;
  const bits = group.bits;
  const modes = group.modes;
  const wVec = w.vec;
  let outFaint = w.faintMask;
  for (let c = 0; c < wVec.length; c++) {
    const tv = tVec[c];
    const wv = wVec[c];
    if (tv < wv) return -1;
    if (tv > wv) {
      const mode = modes[c];
      if (sides[c] === 0) {
        // P1 HP increased: unconditional (0) always ok; no-drain-opp (1) and survive-self (2) require P1 mon never fainted.
        if (mode !== 0 && (w.faintMask & bits[c]) !== 0) return -1;
      } else {
        // P2 HP decreased: survive-self (2) forbids decreasing opp HP; no-drain-opp (1) requires !usedDrain.
        if (mode === 2) return -1;
        if (mode === 1 && w.usedDrain) return -1;
        // Conservative transitive safety: at strictly lower P2 HP, that P2 mon might now faint.
        outFaint |= bits[c];
      }
    }
  }
  return outFaint;
}

/**
 * Dual of jointTransferLowerMask: check if joint witness `w` soundly certifies
 * `target.upper <= w.val`. Returns updated `faintMask` (>= 0) or -1.
 */
function jointTransferUpperMask(
  w: JointWitness,
  tVec: number[],
  tPp: number[],
  group: JointMonoPpGroup
): number {
  const thr = group.maxPpLossPerTurn * w.depth;
  if (!ppVectorsCompatible(tPp, w.pp, thr)) return -1;
  const sides = group.sides;
  const bits = group.bits;
  const modes = group.modes;
  const wVec = w.vec;
  let outFaint = w.faintMask;
  for (let c = 0; c < wVec.length; c++) {
    const tv = tVec[c];
    const wv = wVec[c];
    if (tv > wv) return -1;
    if (tv < wv) {
      const mode = modes[c];
      if (sides[c] === 1) {
        // P2 HP increased (-hp decreased): unconditional (0) always ok; (1)/(2) require P2 mon never fainted.
        if (mode !== 0 && (w.faintMask & bits[c]) !== 0) return -1;
      } else {
        // P1 HP decreased: survive-self (2) forbids decreasing P1 HP; no-drain-opp (1) requires !usedDrain.
        if (mode === 2) return -1;
        if (mode === 1 && w.usedDrain) return -1;
        outFaint |= bits[c];
      }
    }
  }
  return outFaint;
}

/** True if lower witness `e` covers every target that `c` covers with at least as strong bound & clean witness. */
function jointLowerWitnessDominates(e: JointWitness, c: JointWitness, group: JointMonoPpGroup): boolean {
  if (e.val < c.val - EPSILON || e.depth > c.depth) return false;
  if ((e.faintMask & ~c.faintMask) !== 0) return false;
  if (e.usedDrain && !c.usedDrain) return false;
  const marginE = Math.max(3, group.maxPpLossPerTurn * e.depth + 1);
  if (!ppVectorsCompatible(e.pp, c.pp, marginE - 1)) return false;
  const sides = group.sides;
  const bits = group.bits;
  const modes = group.modes;
  for (let k = 0; k < e.vec.length; k++) {
    const ev = e.vec[k];
    const cv = c.vec[k];
    if (ev > cv) return false;
    if (ev < cv) {
      const mode = modes[k];
      if (sides[k] === 0) {
        if (mode !== 0 && (e.faintMask & bits[k]) !== 0) return false;
      } else {
        if (mode === 2) return false;
        if (mode === 1 && e.usedDrain) return false;
      }
    }
  }
  return true;
}

/** True if upper witness `e` covers every target that `c` covers with at least as strong bound & clean witness. */
function jointUpperWitnessDominates(e: JointWitness, c: JointWitness, group: JointMonoPpGroup): boolean {
  if (e.val > c.val + EPSILON || e.depth > c.depth) return false;
  if ((e.faintMask & ~c.faintMask) !== 0) return false;
  if (e.usedDrain && !c.usedDrain) return false;
  const marginE = Math.max(3, group.maxPpLossPerTurn * e.depth + 1);
  if (!ppVectorsCompatible(e.pp, c.pp, marginE - 1)) return false;
  const sides = group.sides;
  const bits = group.bits;
  const modes = group.modes;
  for (let k = 0; k < e.vec.length; k++) {
    const ev = e.vec[k];
    const cv = c.vec[k];
    if (ev < cv) return false;
    if (ev > cv) {
      const mode = modes[k];
      if (sides[k] === 1) {
        if (mode !== 0 && (e.faintMask & bits[k]) !== 0) return false;
      } else {
        if (mode === 2) return false;
        if (mode === 1 && e.usedDrain) return false;
      }
    }
  }
  return true;
}

/**
 * Exact zero-sum matrix solver with:
 * 1) O(M*N) pure saddle-point fast path, and
 * 2) Exact Double-Oracle (active-submatrix best-response LP) for large matrices
 *    (M > 12 or N > 12), solving only tiny active submatrices while returning a
 *    globally verified exact minimax equilibrium of the full M x N game.
 */
function solveMatrixFast(
  matrix: number[][],
  prevSolution?: MatrixSolution | null,
  rowMins?: Float64Array,
  colMaxs?: Float64Array
): MatrixSolution {
  const m = matrix.length;
  const n = matrix[0].length;
  let bestRow = 0;
  let bestRowMin = -Infinity;
  if (rowMins) {
    for (let i = 0; i < m; i++) {
      const rowMin = rowMins[i];
      if (rowMin > bestRowMin) {
        bestRowMin = rowMin;
        bestRow = i;
      }
    }
  } else {
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
  }
  let bestCol = 0;
  let bestColMax = Infinity;
  if (colMaxs) {
    for (let j = 0; j < n; j++) {
      const colMax = colMaxs[j];
      if (colMax < bestColMax) {
        bestColMax = colMax;
        bestCol = j;
      }
    }
  } else {
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
  }
  if (bestRowMin >= bestColMax - 1e-12) {
    const p1 = new Array<number>(m).fill(0);
    const p2 = new Array<number>(n).fill(0);
    p1[bestRow] = 1;
    p2[bestCol] = 1;
    return {value: bestRowMin, p1, p2};
  }
  if (m <= 12 && n <= 12) {
    return solveZeroSumMatrix(matrix);
  }

  // Exact Double-Oracle on large matrices
  const activeRows: number[] = [bestRow];
  const activeCols: number[] = [bestCol];
  const inRows = new Uint8Array(m);
  const inCols = new Uint8Array(n);
  inRows[bestRow] = 1;
  inCols[bestCol] = 1;

  if (prevSolution && prevSolution.p1.length === m && prevSolution.p2.length === n) {
    let rAdded = 0;
    for (let i = 0; i < m && rAdded < 8; i++) {
      if (prevSolution.p1[i] > 1e-12 && !inRows[i]) {
        inRows[i] = 1;
        activeRows.push(i);
        rAdded++;
      }
    }
    let cAdded = 0;
    for (let j = 0; j < n && cAdded < 8; j++) {
      if (prevSolution.p2[j] > 1e-12 && !inCols[j]) {
        inCols[j] = 1;
        activeCols.push(j);
        cAdded++;
      }
    }
  }

  const maxIter = Math.min(m + n, 64);
  for (let iter = 0; iter < maxIter; iter++) {
    const rm = activeRows.length;
    const cn = activeCols.length;
    const sub: number[][] = new Array(rm);
    for (let r = 0; r < rm; r++) {
      const srcRow = matrix[activeRows[r]];
      const dstRow = new Array<number>(cn);
      for (let c = 0; c < cn; c++) dstRow[c] = srcRow[activeCols[c]];
      sub[r] = dstRow;
    }
    const sol = solveZeroSumMatrix(sub);

    // Collect non-zero support indices for fast O(|supp| * M) best-response checks
    const supR: number[] = [];
    const supRw: number[] = [];
    for (let r = 0; r < rm; r++) {
      if (sol.p1[r] > 1e-15) {
        supR.push(activeRows[r]);
        supRw.push(sol.p1[r]);
      }
    }
    const supC: number[] = [];
    const supCw: number[] = [];
    for (let c = 0; c < cn; c++) {
      if (sol.p2[c] > 1e-15) {
        supC.push(activeCols[c]);
        supCw.push(sol.p2[c]);
      }
    }

    // P1 best response over all m rows against sol.p2
    let brRow = -1;
    let brRowVal = -Infinity;
    for (let i = 0; i < m; i++) {
      const row = matrix[i];
      let ev = 0;
      for (let k = 0; k < supC.length; k++) ev += row[supC[k]] * supCw[k];
      if (ev > brRowVal) {
        brRowVal = ev;
        brRow = i;
      }
    }

    // P2 best response over all n columns against sol.p1
    let brCol = -1;
    let brColVal = Infinity;
    for (let j = 0; j < n; j++) {
      let ev = 0;
      for (let k = 0; k < supR.length; k++) ev += supRw[k] * matrix[supR[k]][j];
      if (ev < brColVal) {
        brColVal = ev;
        brCol = j;
      }
    }

    if (brRowVal <= sol.value + 1e-11 && brColVal >= sol.value - 1e-11) {
      const p1 = new Array<number>(m).fill(0);
      const p2 = new Array<number>(n).fill(0);
      for (let r = 0; r < rm; r++) p1[activeRows[r]] = sol.p1[r];
      for (let c = 0; c < cn; c++) p2[activeCols[c]] = sol.p2[c];
      return {value: sol.value, p1, p2};
    }

    let added = false;
    if (brRow >= 0 && !inRows[brRow]) {
      inRows[brRow] = 1;
      activeRows.push(brRow);
      added = true;
    }
    if (brCol >= 0 && !inCols[brCol]) {
      inCols[brCol] = 1;
      activeCols.push(brCol);
      added = true;
    }
    if (!added) break;
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
    equivCellsFilled: 0,
    protectContractions: 0,
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
  declare jointMonoPpGroups: Map<string, JointMonoPpGroup>;
  declare lazyExactWatchers: Map<string, ExactLazyWatcher[]>;
  declare lazyExactWatcherCount: number;
  declare deferredDirty: SearchNode[];
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
  declare rootIsLargeMatrix: boolean;
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
    this.jointMonoPpGroups = new Map();
    this.lazyExactWatchers = new Map();
    this.lazyExactWatcherCount = 0;
    this.deferredDirty = [];
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
    this.rootIsLargeMatrix = false;
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
      if (frontier.refreshOnly) {
        frontier.node.dirty = true;
      } else if (frontier.initialize) {
        this._expand(frontier.node);
      } else if (frontier.splitOutcomeIndex !== undefined) {
        this._splitOutcome(frontier.node, frontier.i, frontier.j, frontier.splitOutcomeIndex);
      } else {
        this._expandCell(frontier.node, frontier.i, frontier.j);
      }
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
      lowerFaintMask: 0,
      lowerUsedDrain: false,
      upperFaintMask: 0,
      upperUsedDrain: false,
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
      if (this.adapter.jointMonoPpSignature) this._registerJointMonoPp(node);
    }
    const exactWatchers = this.lazyExactWatchers.get(key);
    if (exactWatchers) {
      this.lazyExactWatchers.delete(key);
      this.lazyExactWatcherCount -= exactWatchers.length;
      const hasBound = node.lower > DEFAULT_LOWER + EPSILON || node.upper < DEFAULT_UPPER - EPSILON;
      for (let w = 0; w < exactWatchers.length; w++) {
        const ew = exactWatchers[w];
        const o = ew.outcome;
        let attached = false;
        if (ew.kind === 0) {
          if (!o.child && o.lazySnapshot) {
            o.child = node;
            o.lazySnapshot = null;
            node.parents.add(ew.parent);
            ew.parent.dirty = true;
            attached = true;
          }
        } else if (ew.kind === 1) {
          if (!o.child && o.lazyLowerSnapshot) {
            o.child = node;
            o.lazyLowerSnapshot = null;
            node.parents.add(ew.parent);
            ew.parent.dirty = true;
            attached = true;
          }
        } else if (!o.upperChild && o.lazyUpperSnapshot) {
          o.upperChild = node;
          o.lazyUpperSnapshot = null;
          node.parents.add(ew.parent);
          ew.parent.dirty = true;
          attached = true;
        }
        if (attached && hasBound) {
          this.deferredDirty.push(ew.parent);
        }
      }
    }
    return node;
  }

  _registerMonotone(node: SearchNode) {
    const sig = this.adapter.monotoneSignature!(node.snapshot);
    const hasNd = !!(sig && sig.vec && sig.vec.length > 0);
    if (!sig || (!hasNd && sig.h1 === null && sig.h2 === null)) return;
    const kind: 'h1' | 'h2' | '2d' | 'nd' = hasNd
      ? 'nd'
      : sig.h1 !== null && sig.h2 !== null
        ? '2d'
        : sig.h1 !== null ? 'h1' : 'h2';
    let group = this.monotoneGroups.get(sig.groupKey);
    if (!group) {
      group = kind === 'nd'
        ? {kind, nodes: [], lowerFrontier: [], upperFrontier: [], lowerFrontierNd: [], upperFrontierNd: []}
        : {kind, nodes: [], lowerFrontier: [], upperFrontier: []};
      this.monotoneGroups.set(sig.groupKey, group);
    }
    if (group.kind !== kind) return;
    node.monoGroup = group;
    node.monoH1 = sig.h1;
    node.monoH2 = sig.h2;
    node.monoVec = hasNd ? sig.vec! : null;

    if (kind === 'nd') {
      const vec = sig.vec!;
      let bestL = node.lower;
      let bestLDepth = node.lowerDepth;
      let bestLFaint = node.lowerFaintMask;
      let bestLDrain = node.lowerUsedDrain;
      const lf = group.lowerFrontierNd!;
      for (let i = 0; i < lf.length; i++) {
        const f = lf[i];
        if (f.val > bestL && vecDominates(vec, f.vec)) {
          bestL = f.val;
          bestLDepth = f.depth;
          bestLFaint = f.faintMask;
          bestLDrain = f.usedDrain;
        }
      }
      let bestU = node.upper;
      let bestUDepth = node.upperDepth;
      let bestUFaint = node.upperFaintMask;
      let bestUDrain = node.upperUsedDrain;
      const uf = group.upperFrontierNd!;
      for (let i = 0; i < uf.length; i++) {
        const f = uf[i];
        if (f.val < bestU && vecDominates(f.vec, vec)) {
          bestU = f.val;
          bestUDepth = f.depth;
          bestUFaint = f.faintMask;
          bestUDrain = f.usedDrain;
        }
      }
      node.lower = bestL;
      node.lowerDepth = bestLDepth;
      node.lowerFaintMask = bestLFaint;
      node.lowerUsedDrain = bestLDrain;
      if (bestU < bestL) {
        node.upper = bestL;
        node.upperDepth = Math.max(bestLDepth, bestUDepth);
        node.upperFaintMask = bestUFaint;
        node.upperUsedDrain = bestUDrain;
      } else {
        node.upper = bestU;
        node.upperDepth = bestUDepth;
        node.upperFaintMask = bestUFaint;
        node.upperUsedDrain = bestUDrain;
      }
      if (group.nodes.length < MAX_ND_GROUP_NODES) {
        group.nodes.push(node);
      }
      if (bestL > DEFAULT_LOWER + EPSILON || bestU < DEFAULT_UPPER - EPSILON) {
        this.stats.monotoneUpdates++;
      }
      return;
    }

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
        node.lowerFaintMask = list[lo - 1].lowerFaintMask;
        node.lowerUsedDrain = list[lo - 1].lowerUsedDrain;
      }
      if (lo < list.length && list[lo].upper < node.upper) {
        node.upper = list[lo].upper;
        node.upperDepth = list[lo].upperDepth;
        node.upperFaintMask = list[lo].upperFaintMask;
        node.upperUsedDrain = list[lo].upperUsedDrain;
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
    let bestLFaint = node.lowerFaintMask;
    let bestLDrain = node.lowerUsedDrain;
    for (const f of group.lowerFrontier) {
      if (f.h1 <= h1 && f.h2 >= h2 && f.val > bestL) {
        bestL = f.val;
        bestLDepth = f.depth;
        bestLFaint = f.faintMask;
        bestLDrain = f.usedDrain;
      }
    }
    let bestU = node.upper;
    let bestUDepth = node.upperDepth;
    let bestUFaint = node.upperFaintMask;
    let bestUDrain = node.upperUsedDrain;
    for (const f of group.upperFrontier) {
      if (f.h1 >= h1 && f.h2 <= h2 && f.val < bestU) {
        bestU = f.val;
        bestUDepth = f.depth;
        bestUFaint = f.faintMask;
        bestUDrain = f.usedDrain;
      }
    }
    node.lower = bestL;
    node.lowerDepth = bestLDepth;
    node.lowerFaintMask = bestLFaint;
    node.lowerUsedDrain = bestLDrain;
    if (bestU < bestL) {
      node.upper = bestL;
      node.upperDepth = Math.max(bestLDepth, bestUDepth);
      node.upperFaintMask = bestUFaint;
      node.upperUsedDrain = bestUDrain;
    } else {
      node.upper = bestU;
      node.upperDepth = bestUDepth;
      node.upperFaintMask = bestUFaint;
      node.upperUsedDrain = bestUDrain;
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
          node.lowerFaintMask = peer.lowerFaintMask;
          node.lowerUsedDrain = peer.lowerUsedDrain;
        }
      }
      if (peer.upper < node.upper - EPSILON && peer.upperDepth > 0 && peer.upperDepth <= MAX_PP_PROP_DEPTH) {
        if (ppVectorsCompatible(sig.pp, peer.ppVec!, sig.maxPpLossPerTurn * peer.upperDepth)) {
          node.upper = Math.max(node.lower, peer.upper);
          node.upperDepth = peer.upperDepth;
          node.upperFaintMask = peer.upperFaintMask;
          node.upperUsedDrain = peer.upperUsedDrain;
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

  _registerJointMonoPp(node: SearchNode) {
    const sig = this.adapter.jointMonoPpSignature!(node.snapshot);
    if (!sig || sig.vec.length === 0 || sig.pp.length === 0) return;
    let group = this.jointMonoPpGroups.get(sig.groupKey);
    if (!group) {
      group = {
        sides: sig.sides,
        bits: sig.bits,
        modes: sig.modes,
        maxPpLossPerTurn: sig.maxPpLossPerTurn,
        lowerWitnesses: [],
        upperWitnesses: [],
        activeNodes: [],
        lazyWatchers: [],
      };
      this.jointMonoPpGroups.set(sig.groupKey, group);
    }
    if (group.sides.length !== sig.vec.length) return;
    node.jointGroup = group;
    node.jointVec = sig.vec;
    node.jointPp = sig.pp;

    const oldLower = node.lower;
    const oldUpper = node.upper;
    const lw = group.lowerWitnesses;
    for (let i = 0; i < lw.length; i++) {
      const w = lw[i];
      if (w.val <= node.lower + EPSILON) continue;
      const outFaint = jointTransferLowerMask(w, sig.vec, sig.pp, group);
      if (outFaint >= 0) {
        if (w.val > node.upper) {
          node.lower = node.upper;
          node.lowerDepth = Math.max(w.depth, node.upperDepth);
        } else {
          node.lower = w.val;
          node.lowerDepth = w.depth;
        }
        node.lowerFaintMask = outFaint;
        node.lowerUsedDrain = w.usedDrain;
      }
    }
    const uw = group.upperWitnesses;
    for (let i = 0; i < uw.length; i++) {
      const w = uw[i];
      if (w.val >= node.upper - EPSILON) continue;
      const outFaint = jointTransferUpperMask(w, sig.vec, sig.pp, group);
      if (outFaint >= 0) {
        if (w.val < node.lower) {
          node.upper = node.lower;
          node.upperDepth = Math.max(w.depth, node.lowerDepth);
        } else {
          node.upper = w.val;
          node.upperDepth = w.depth;
        }
        node.upperFaintMask = outFaint;
        node.upperUsedDrain = w.usedDrain;
      }
    }
    if (node.upper - node.lower > 1e-9) {
      if (group.activeNodes.length >= MAX_JOINT_ACTIVE_NODES) {
        // Evict already-resolved activeNodes before capping so fresh nodes always fit.
        let write = 0;
        for (let i = 0; i < group.activeNodes.length; i++) {
          const an = group.activeNodes[i];
          if (an.upper - an.lower > 1e-9) group.activeNodes[write++] = an;
        }
        group.activeNodes.length = write;
      }
      if (group.activeNodes.length < MAX_JOINT_ACTIVE_NODES) {
        group.activeNodes.push(node);
      }
    }
    if (node.lower > oldLower + EPSILON || node.upper < oldUpper - EPSILON) {
      this.stats.ppBoundUpdates++;
    }
  }

  _registerLazyWatchers(
    parent: SearchNode,
    outcome: BoundedOutcome,
    kind: 0 | 1 | 2,
    key: string,
    jointSig: JointMonoPpSignature | null
  ) {
    if (this.lazyExactWatcherCount < MAX_EXACT_LAZY_WATCHERS_TOTAL) {
      let list = this.lazyExactWatchers.get(key);
      if (!list) {
        list = [];
        this.lazyExactWatchers.set(key, list);
      }
      if (list.length < 128) {
        list.push({parent, outcome, kind});
        this.lazyExactWatcherCount++;
      }
    }
    if (!jointSig || jointSig.vec.length === 0 || jointSig.pp.length === 0) return;
    let group = this.jointMonoPpGroups.get(jointSig.groupKey);
    if (!group) {
      group = {
        sides: jointSig.sides,
        bits: jointSig.bits,
        modes: jointSig.modes,
        maxPpLossPerTurn: jointSig.maxPpLossPerTurn,
        lowerWitnesses: [],
        upperWitnesses: [],
        activeNodes: [],
        lazyWatchers: [],
      };
      this.jointMonoPpGroups.set(jointSig.groupKey, group);
    }
    if (group.sides.length !== jointSig.vec.length) return;
    if (group.lazyWatchers.length >= MAX_JOINT_LAZY_WATCHERS) {
      // Compact materialized or resolved lazy watchers so new rows stay subscribed.
      let write = 0;
      for (let i = 0; i < group.lazyWatchers.length; i++) {
        const w = group.lazyWatchers[i];
        const o = w.outcome;
        const alive = w.kind === 0
          ? (!o.child && !!o.lazySnapshot && (o.lazyUpper ?? DEFAULT_UPPER) - (o.lazyLower ?? DEFAULT_LOWER) > 1e-9)
          : w.kind === 1
            ? (!o.child && !!o.lazyLowerSnapshot && (o.lazyLower ?? DEFAULT_LOWER) < DEFAULT_UPPER - 1e-9)
            : (!o.upperChild && !!o.lazyUpperSnapshot && (o.lazyUpper ?? DEFAULT_UPPER) > DEFAULT_LOWER + 1e-9);
        if (alive) group.lazyWatchers[write++] = w;
      }
      group.lazyWatchers.length = write;
    }
    if (group.lazyWatchers.length < MAX_JOINT_LAZY_WATCHERS) {
      group.lazyWatchers.push({parent, outcome, kind, vec: jointSig.vec, pp: jointSig.pp});
    }
  }

  _transitionOptions(node?: SearchNode) {
    if (this.adapter !== nativeAdapter) {
      return {
        deadline: this.deadline,
        tolerance: this.options.tolerance,
        actions1: node?.actions1 ?? undefined,
        actions2: node?.actions2 ?? undefined,
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

  _ensureAxisStats(node: SearchNode) {
    if (node.rowFloor) return;
    const cells = node.cells!;
    const m = cells.length;
    const n = cells[0].length;
    const rowFloor = new Float64Array(m);
    const rowOptFloor = new Float64Array(m);
    const rowLowerSum = new Float64Array(m);
    const colCeil = new Float64Array(n);
    const colOptCeil = new Float64Array(n);
    const colUpperSum = new Float64Array(n);
    for (let j = 0; j < n; j++) {
      colCeil[j] = -Infinity;
      colOptCeil[j] = -Infinity;
    }
    let bestPureRowFloor = -Infinity;
    for (let i = 0; i < m; i++) {
      const row = cells[i];
      let rf = Infinity;
      let rof = Infinity;
      let rls = 0;
      for (let j = 0; j < n; j++) {
        const lo = row[j].lower;
        const hi = row[j].upper;
        if (lo < rf) rf = lo;
        if (hi < rof) rof = hi;
        rls += lo;
        if (hi > colCeil[j]) colCeil[j] = hi;
        if (lo > colOptCeil[j]) colOptCeil[j] = lo;
        colUpperSum[j] += hi;
      }
      rowFloor[i] = rf;
      rowOptFloor[i] = rof;
      rowLowerSum[i] = rls;
      if (rf > bestPureRowFloor) bestPureRowFloor = rf;
    }
    let bestPureColCeil = Infinity;
    for (let j = 0; j < n; j++) {
      if (colCeil[j] < bestPureColCeil) bestPureColCeil = colCeil[j];
    }
    node.rowFloor = rowFloor;
    node.rowOptFloor = rowOptFloor;
    node.rowLowerSum = rowLowerSum;
    node.colCeil = colCeil;
    node.colOptCeil = colOptCeil;
    node.colUpperSum = colUpperSum;
    node.rowOpaqueProbes = new Int32Array(m);
    node.colOpaqueProbes = new Int32Array(n);
    node.rowStallProbes = new Int32Array(m);
    node.colStallProbes = new Int32Array(n);
    node.bestPureRowFloor = bestPureRowFloor;
    node.bestPureColCeil = bestPureColCeil;
  }

  _selectionPolicyForRoot(root: SearchNode) {
    if (this.options.selectionPolicy !== 'auto') {
      return this.options.selectionPolicy;
    }
    if (!root.initialized || !root.lowerSolution || !root.upperSolution) {
      this.autoJoint = false;
      return 'security';
    }
    if (!root.rowFloor) this._ensureAxisStats(root);
    const bestPureRowFloor = root.bestPureRowFloor ?? DEFAULT_LOWER;
    const bestPureColumnCeiling = root.bestPureColCeil ?? DEFAULT_UPPER;
    const isLarge = (root.actions1?.length ?? 0) * (root.actions2?.length ?? 0) > 25;
    const flatUpper = root.upperSolution.value >= DEFAULT_UPPER - EPSILON;
    const flatLower = root.lowerSolution.value <= DEFAULT_LOWER + EPSILON;
    const lowerMixedEps = isLarge ? (flatUpper ? Math.max(1e-3, this.options.tolerance * 0.5) : 1e-3) : 1e-9;
    const upperMixedEps = isLarge ? (flatLower ? Math.max(1e-3, this.options.tolerance * 0.5) : 1e-3) : 1e-9;
    const isMixed =
      root.lowerSolution.value > bestPureRowFloor + lowerMixedEps ||
      root.upperSolution.value < bestPureColumnCeiling - upperMixedEps;
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
    const m = node.actions1.length;
    const n = node.actions2.length;
    const cells: BoundedCell[][] = new Array(m);
    const lowerMatrix: number[][] = new Array(m);
    const upperMatrix: number[][] = new Array(m);
    const rowFloor = new Float64Array(m);
    const rowOptFloor = new Float64Array(m);
    const rowLowerSum = new Float64Array(m);
    const colCeil = new Float64Array(n);
    const colOptCeil = new Float64Array(n);
    const colUpperSum = new Float64Array(n);
    for (let j = 0; j < n; j++) {
      colCeil[j] = -Infinity;
      colOptCeil[j] = -Infinity;
    }
    let bestPureRowFloor = -Infinity;
    for (let i = 0; i < m; i++) {
      const row = new Array<BoundedCell>(n);
      const lRow = new Array<number>(n);
      const uRow = new Array<number>(n);
      let rf = Infinity;
      let rof = Infinity;
      let rls = 0;
      for (let j = 0; j < n; j++) {
        const envelope = terminalEnvelope?.(node.actions1[i] as Action, node.actions2[j] as Action);
        if (envelope) this.stats.terminalEnvelopes++;
        const lo = envelope?.lower ?? DEFAULT_LOWER;
        const hi = envelope?.upper ?? DEFAULT_UPPER;
        row[j] = {outcomes: null, lower: lo, upper: hi};
        lRow[j] = lo;
        uRow[j] = hi;
        if (lo < rf) rf = lo;
        if (hi < rof) rof = hi;
        rls += lo;
        if (hi > colCeil[j]) colCeil[j] = hi;
        if (lo > colOptCeil[j]) colOptCeil[j] = lo;
        colUpperSum[j] += hi;
      }
      cells[i] = row;
      lowerMatrix[i] = lRow;
      upperMatrix[i] = uRow;
      rowFloor[i] = rf;
      rowOptFloor[i] = rof;
      rowLowerSum[i] = rls;
      if (rf > bestPureRowFloor) bestPureRowFloor = rf;
    }
    let bestPureColCeil = Infinity;
    for (let j = 0; j < n; j++) {
      if (colCeil[j] < bestPureColCeil) bestPureColCeil = colCeil[j];
    }
    node.cells = cells;
    node.populatedCells = [];
    node.populatedCellCount = 0;
    node.rowFloor = rowFloor;
    node.rowOptFloor = rowOptFloor;
    node.rowLowerSum = rowLowerSum;
    node.colCeil = colCeil;
    node.colOptCeil = colOptCeil;
    node.colUpperSum = colUpperSum;
    node.rowOpaqueProbes = new Int32Array(m);
    node.colOpaqueProbes = new Int32Array(n);
    node.rowStallProbes = new Int32Array(m);
    node.colStallProbes = new Int32Array(n);
    node.bestPureRowFloor = bestPureRowFloor;
    node.bestPureColCeil = bestPureColCeil;
    node.lowerMatrix = lowerMatrix;
    node.upperMatrix = upperMatrix;
    node.initialized = true;
    if (node === this.rootNode) {
      this.rootIsLargeMatrix = m * n > 25;
    }
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
    if (!cell.outcomes) {
      this.stats.expandedCells++;
      node.populatedCells?.push({i, j, cell});
      node.populatedCellCount = (node.populatedCellCount || 0) + 1;
    }
    cell.outcomes = outcomes;
    cell.remainingProbability = incomplete ? Math.max(0, 1 - completed / denominator) : remaining / total;
    if (transition.complete) cell.cursor = null;

    if (!incomplete && (transition.equivalentRows || transition.equivalentCols)) {
      const eqRows: number[] = transition.equivalentRows ?? [i];
      const eqCols: number[] = transition.equivalentCols ?? [j];
      if (eqRows.length > 1 || eqCols.length > 1) {
        const cells = node.cells;
        for (let r = 0; r < eqRows.length; r++) {
          const ri = eqRows[r];
          const row = cells[ri];
          if (!row) continue;
          for (let c = 0; c < eqCols.length; c++) {
            const cj = eqCols[c];
            if (ri === i && cj === j) continue;
            const sib = row[cj];
            if (!sib || sib === cell || sib.outcomes) continue;
            if (sib.lower > cell.lower) cell.lower = Math.min(cell.upper, sib.lower);
            if (sib.upper < cell.upper) cell.upper = Math.max(cell.lower, sib.upper);
            row[cj] = cell;
            if (!cell.coords) {
              cell.coords = [{i, j, probes: cell.probes || 0}];
            }
            cell.coords.push({i: ri, j: cj, probes: 0});
            cell.needsSync = true;
            this.stats.equivCellsFilled++;
            node.populatedCellCount = (node.populatedCellCount || 0) + 1;
          }
        }
      }
    }
    node.dirty = true;
  }

  /**
   * Read-only lookup of existing SearchNode / monotone frontier / PP peer
   * bounds for an unmaterialized snapshot without allocating a SearchNode or
   * polluting monotoneGroups/ppGroups caps.
   */
  _queryLazySnapshot(
    snapshot: Snapshot,
    loReqNoFaint = 0,
    loReqNoDrain = false,
    hiReqNoFaint = 0,
    hiReqNoDrain = false
  ): {
    node: SearchNode | null;
    key: string;
    jointSig: JointMonoPpSignature | null;
    lower: number;
    upper: number;
    lowerDepth: number;
    upperDepth: number;
    lowerFaintMask: number;
    lowerUsedDrain: boolean;
    upperFaintMask: number;
    upperUsedDrain: boolean;
  } {
    const key = this._key(snapshot);
    const existing = this.nodes.get(key);
    if (existing) {
      return {
        node: existing,
        key,
        jointSig: null,
        lower: existing.lower,
        upper: existing.upper,
        lowerDepth: existing.lowerDepth,
        upperDepth: existing.upperDepth,
        lowerFaintMask: existing.lowerFaintMask,
        lowerUsedDrain: existing.lowerUsedDrain,
        upperFaintMask: existing.upperFaintMask,
        upperUsedDrain: existing.upperUsedDrain,
      };
    }
    let lower = DEFAULT_LOWER;
    let upper = DEFAULT_UPPER;
    let lowerDepth = 0;
    let upperDepth = 0;
    let lowerFaintMask = 0;
    let lowerUsedDrain = false;
    let upperFaintMask = 0;
    let upperUsedDrain = false;
    let jointSig: JointMonoPpSignature | null = null;
    const loClean = (faint: number, drain: boolean) =>
      (loReqNoFaint === 0 || (faint & loReqNoFaint) === 0) && (!loReqNoDrain || !drain);
    const hiClean = (faint: number, drain: boolean) =>
      (hiReqNoFaint === 0 || (faint & hiReqNoFaint) === 0) && (!hiReqNoDrain || !drain);

    if (this.adapter.jointMonoPpSignature) {
      jointSig = this.adapter.jointMonoPpSignature(snapshot);
      if (jointSig && jointSig.vec.length > 0 && jointSig.pp.length > 0) {
        const group = this.jointMonoPpGroups.get(jointSig.groupKey);
        if (group && group.sides.length === jointSig.vec.length) {
          const lw = group.lowerWitnesses;
          for (let i = 0; i < lw.length; i++) {
            const w = lw[i];
            if (w.val <= lower + EPSILON) continue;
            const outFaint = jointTransferLowerMask(w, jointSig.vec, jointSig.pp, group);
            if (outFaint >= 0 && loClean(outFaint, w.usedDrain)) {
              lower = Math.min(upper, w.val);
              lowerDepth = w.depth;
              lowerFaintMask = outFaint;
              lowerUsedDrain = w.usedDrain;
            }
          }
          const uw = group.upperWitnesses;
          for (let i = 0; i < uw.length; i++) {
            const w = uw[i];
            if (w.val >= upper - EPSILON) continue;
            const outFaint = jointTransferUpperMask(w, jointSig.vec, jointSig.pp, group);
            if (outFaint >= 0 && hiClean(outFaint, w.usedDrain)) {
              upper = Math.max(lower, w.val);
              upperDepth = w.depth;
              upperFaintMask = outFaint;
              upperUsedDrain = w.usedDrain;
            }
          }
          if (upper < lower) {
            upper = lower;
            upperDepth = Math.max(lowerDepth, upperDepth);
          }
        }
      }
    }

    if (this.adapter.monotoneSignature && upper - lower > 1e-9) {
      const sig = this.adapter.monotoneSignature(snapshot);
      const hasNd = !!(sig && sig.vec && sig.vec.length > 0);
      if (sig && (hasNd || sig.h1 !== null || sig.h2 !== null)) {
        const group = this.monotoneGroups.get(sig.groupKey);
        if (group) {
          if (group.kind === 'nd' && hasNd) {
            const vec = sig.vec!;
            const lf = group.lowerFrontierNd!;
            for (let i = 0; i < lf.length; i++) {
              const f = lf[i];
              if (f.val > lower && vecDominates(vec, f.vec) && loClean(f.faintMask, f.usedDrain)) {
                lower = f.val;
                lowerDepth = f.depth;
                lowerFaintMask = f.faintMask;
                lowerUsedDrain = f.usedDrain;
              }
            }
            const uf = group.upperFrontierNd!;
            for (let i = 0; i < uf.length; i++) {
              const f = uf[i];
              if (f.val < upper && vecDominates(f.vec, vec) && hiClean(f.faintMask, f.usedDrain)) {
                upper = f.val;
                upperDepth = f.depth;
                upperFaintMask = f.faintMask;
                upperUsedDrain = f.usedDrain;
              }
            }
          } else if (group.kind === '2d' && sig.h1 !== null && sig.h2 !== null) {
            const h1 = sig.h1;
            const h2 = sig.h2;
            for (const f of group.lowerFrontier) {
              if (f.h1 <= h1 && f.h2 >= h2 && f.val > lower && loClean(f.faintMask, f.usedDrain)) {
                lower = f.val;
                lowerDepth = f.depth;
                lowerFaintMask = f.faintMask;
                lowerUsedDrain = f.usedDrain;
              }
            }
            for (const f of group.upperFrontier) {
              if (f.h1 >= h1 && f.h2 <= h2 && f.val < upper && hiClean(f.faintMask, f.usedDrain)) {
                upper = f.val;
                upperDepth = f.depth;
                upperFaintMask = f.faintMask;
                upperUsedDrain = f.usedDrain;
              }
            }
          } else if ((group.kind === 'h1' && sig.h1 !== null) || (group.kind === 'h2' && sig.h2 !== null)) {
            const coord = group.kind === 'h1' ? sig.h1! : -sig.h2!;
            const list = group.nodes;
            let lo = 0;
            let hi = list.length;
            while (lo < hi) {
              const mid = (lo + hi) >>> 1;
              const mc = group.kind === 'h1' ? list[mid].monoH1! : -list[mid].monoH2!;
              if (mc < coord) lo = mid + 1;
              else hi = mid;
            }
            if (lo > 0 && list[lo - 1].lower > lower && loClean(list[lo - 1].lowerFaintMask, list[lo - 1].lowerUsedDrain)) {
              lower = list[lo - 1].lower;
              lowerDepth = list[lo - 1].lowerDepth;
              lowerFaintMask = list[lo - 1].lowerFaintMask;
              lowerUsedDrain = list[lo - 1].lowerUsedDrain;
            }
            if (lo < list.length) {
              const mc = group.kind === 'h1' ? list[lo].monoH1! : -list[lo].monoH2!;
              if (mc === coord && list[lo].lower > lower && loClean(list[lo].lowerFaintMask, list[lo].lowerUsedDrain)) {
                lower = list[lo].lower;
                lowerDepth = list[lo].lowerDepth;
                lowerFaintMask = list[lo].lowerFaintMask;
                lowerUsedDrain = list[lo].lowerUsedDrain;
              }
              if (list[lo].upper < upper && hiClean(list[lo].upperFaintMask, list[lo].upperUsedDrain)) {
                upper = list[lo].upper;
                upperDepth = list[lo].upperDepth;
                upperFaintMask = list[lo].upperFaintMask;
                upperUsedDrain = list[lo].upperUsedDrain;
              }
            }
          }
          if (upper < lower) {
            upper = lower;
            upperDepth = Math.max(lowerDepth, upperDepth);
          }
        }
      }
    }

    if (this.adapter.ppSignature && upper - lower > 1e-9) {
      const sig = this.adapter.ppSignature(snapshot);
      if (sig) {
        const group = this.ppGroups.get(sig.groupKey);
        if (group) {
          const list = group.nodes;
          for (let i = 0; i < list.length; i++) {
            const peer = list[i];
            if (peer.lower > lower + EPSILON && peer.lowerDepth > 0 && peer.lowerDepth <= MAX_PP_PROP_DEPTH &&
                loClean(peer.lowerFaintMask, peer.lowerUsedDrain)) {
              if (ppVectorsCompatible(sig.pp, peer.ppVec!, sig.maxPpLossPerTurn * peer.lowerDepth)) {
                lower = Math.min(upper, peer.lower);
                lowerDepth = peer.lowerDepth;
                lowerFaintMask = peer.lowerFaintMask;
                lowerUsedDrain = peer.lowerUsedDrain;
              }
            }
            if (peer.upper < upper - EPSILON && peer.upperDepth > 0 && peer.upperDepth <= MAX_PP_PROP_DEPTH &&
                hiClean(peer.upperFaintMask, peer.upperUsedDrain)) {
              if (ppVectorsCompatible(sig.pp, peer.ppVec!, sig.maxPpLossPerTurn * peer.upperDepth)) {
                upper = Math.max(lower, peer.upper);
                upperDepth = peer.upperDepth;
                upperFaintMask = peer.upperFaintMask;
                upperUsedDrain = peer.upperUsedDrain;
              }
            }
          }
        }
      }
    }

    return {
      node: null,
      key,
      jointSig,
      lower,
      upper,
      lowerDepth,
      upperDepth,
      lowerFaintMask,
      lowerUsedDrain,
      upperFaintMask,
      upperUsedDrain,
    };
  }

  _internOutcome(node: SearchNode, outcome: any, skipTerminal: boolean): BoundedOutcome {
    const probability = Number(outcome.probability);
    if (!(probability >= 0) || !Number.isFinite(probability)) {
      throw new Error(`Invalid transition probability: ${outcome.probability}`);
    }
    const faintMask = outcome.faintMask ? (outcome.faintMask | 0) : 0;
    const useLazy = this.rootIsLargeMatrix;
    if (outcome.lowerSnapshot !== undefined && outcome.upperSnapshot !== undefined && typeof outcome.split === 'function') {
      const lowerReqNoFaintMask = outcome.lowerReqNoFaintMask ? (outcome.lowerReqNoFaintMask | 0) : 0;
      const lowerReqNoDrain = Boolean(outcome.lowerReqNoDrain);
      const upperReqNoFaintMask = outcome.upperReqNoFaintMask ? (outcome.upperReqNoFaintMask | 0) : 0;
      const upperReqNoDrain = Boolean(outcome.upperReqNoDrain);
      const hasCond = lowerReqNoFaintMask !== 0 || lowerReqNoDrain || upperReqNoFaintMask !== 0 || upperReqNoDrain;
      if (useLazy) {
        let lowerChild: SearchNode | null = null;
        let lazyLowerSnapshot: Snapshot | null = null;
        let lazyLower = DEFAULT_LOWER;
        let lazyLowerDepth = 0;
        let lazyLowerFaintMask = 0;
        let lazyLowerUsedDrain = false;
        let loKey = '';
        let loJointSig: JointMonoPpSignature | null = null;
        if (outcome.lowerSnapshot !== null) {
          const q = this._queryLazySnapshot(outcome.lowerSnapshot, lowerReqNoFaintMask, lowerReqNoDrain, 0, false);
          if (q.node) {
            this.stats.memoHits++;
            lowerChild = q.node;
            lowerChild.parents.add(node);
          } else {
            const t = skipTerminal ? null : this._terminal(outcome.lowerSnapshot);
            if (t !== null) {
              lowerChild = this._intern(outcome.lowerSnapshot, false);
              if (lowerChild) lowerChild.parents.add(node);
            } else {
              lazyLowerSnapshot = outcome.lowerSnapshot;
              lazyLower = q.lower;
              lazyLowerDepth = q.lowerDepth;
              lazyLowerFaintMask = q.lowerFaintMask;
              lazyLowerUsedDrain = q.lowerUsedDrain;
              loKey = q.key;
              loJointSig = q.jointSig;
            }
          }
        }
        let upperChild: SearchNode | null = null;
        let lazyUpperSnapshot: Snapshot | null = null;
        let lazyUpper = DEFAULT_UPPER;
        let lazyUpperDepth = 0;
        let lazyUpperFaintMask = 0;
        let lazyUpperUsedDrain = false;
        let hiKey = '';
        let hiJointSig: JointMonoPpSignature | null = null;
        if (outcome.upperSnapshot !== null) {
          const q = this._queryLazySnapshot(outcome.upperSnapshot, 0, false, upperReqNoFaintMask, upperReqNoDrain);
          if (q.node) {
            this.stats.memoHits++;
            upperChild = q.node;
            upperChild.parents.add(node);
          } else {
            const t = skipTerminal ? null : this._terminal(outcome.upperSnapshot);
            if (t !== null) {
              upperChild = this._intern(outcome.upperSnapshot, false);
              if (upperChild) upperChild.parents.add(node);
            } else {
              lazyUpperSnapshot = outcome.upperSnapshot;
              lazyUpper = q.upper;
              lazyUpperDepth = q.upperDepth;
              lazyUpperFaintMask = q.upperFaintMask;
              lazyUpperUsedDrain = q.upperUsedDrain;
              hiKey = q.key;
              hiJointSig = q.jointSig;
            }
          }
        }
        if (lowerChild && upperChild && lowerChild === upperChild && !hasCond) {
          return {probability, utility: null, child: lowerChild, upperChild: null, split: null, faintMask};
        }
        const bo: BoundedOutcome = {
          probability,
          utility: null,
          child: lowerChild,
          upperChild,
          split: outcome.split,
          faintMask,
          lowerReqNoFaintMask,
          lowerReqNoDrain,
          upperReqNoFaintMask,
          upperReqNoDrain,
          lazyLowerSnapshot,
          lazyUpperSnapshot,
          lazyLower,
          lazyUpper,
          lazyLowerDepth,
          lazyUpperDepth,
          lazyLowerFaintMask,
          lazyLowerUsedDrain,
          lazyUpperFaintMask,
          lazyUpperUsedDrain,
        };
        if (lazyLowerSnapshot && lazyLower < DEFAULT_UPPER - 1e-9) {
          this._registerLazyWatchers(node, bo, 1, loKey, loJointSig);
        }
        if (lazyUpperSnapshot && lazyUpper > DEFAULT_LOWER + 1e-9) {
          this._registerLazyWatchers(node, bo, 2, hiKey, hiJointSig);
        }
        return bo;
      }
      const lowerChild = outcome.lowerSnapshot !== null ? this._intern(outcome.lowerSnapshot, skipTerminal) : null;
      const upperChild = outcome.upperSnapshot !== null ? this._intern(outcome.upperSnapshot, skipTerminal) : null;
      if (lowerChild) lowerChild.parents.add(node);
      if (upperChild) upperChild.parents.add(node);
      if (lowerChild && upperChild && lowerChild === upperChild && !hasCond) {
        return {probability, utility: null, child: lowerChild, upperChild: null, split: null, faintMask};
      }
      return {
        probability,
        utility: null,
        child: lowerChild,
        upperChild,
        split: outcome.split,
        faintMask,
        lowerReqNoFaintMask,
        lowerReqNoDrain,
        upperReqNoFaintMask,
        upperReqNoDrain,
      };
    }
    if (outcome.snapshot === undefined) {
      const utility = finiteUtility(outcome.utility);
      if (utility === null) throw new Error('Terminal outcome lacks utility');
      return {probability, utility, child: null, upperChild: null, split: null, faintMask};
    }
    if (useLazy) {
      const key = this._key(outcome.snapshot);
      const existing = this.nodes.get(key);
      if (existing) {
        this.stats.memoHits++;
        existing.parents.add(node);
        return {probability, child: existing, utility: null, upperChild: null, split: null, faintMask};
      }
      const terminal = skipTerminal ? null : this._terminal(outcome.snapshot);
      if (terminal !== null) {
        return {probability, utility: terminal, child: null, upperChild: null, split: null, faintMask};
      }
      const q = this._queryLazySnapshot(outcome.snapshot);
      const bo: BoundedOutcome = {
        probability,
        child: null,
        utility: null,
        upperChild: null,
        split: null,
        faintMask,
        lazySnapshot: outcome.snapshot,
        lazyLower: q.lower,
        lazyUpper: q.upper,
        lazyLowerDepth: q.lowerDepth,
        lazyUpperDepth: q.upperDepth,
        lazyLowerFaintMask: q.lowerFaintMask,
        lazyLowerUsedDrain: q.lowerUsedDrain,
        lazyUpperFaintMask: q.upperFaintMask,
        lazyUpperUsedDrain: q.upperUsedDrain,
      };
      if (q.upper - q.lower > 1e-9) {
        this._registerLazyWatchers(node, bo, 0, q.key, q.jointSig);
      }
      return bo;
    }
    const child = this._intern(outcome.snapshot, skipTerminal);
    if (child) child.parents.add(node);
    return {probability, child, utility: null, upperChild: null, split: null, faintMask};
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
    const loNode = outcome.child;
    const loVal = loNode ? loNode.lower : (outcome.lazyLowerSnapshot ? (outcome.lazyLower ?? DEFAULT_LOWER) : DEFAULT_LOWER);
    const loFaint = loNode ? loNode.lowerFaintMask : (outcome.lazyLowerFaintMask || 0);
    const loDrain = loNode ? loNode.lowerUsedDrain : Boolean(outcome.lazyLowerUsedDrain);
    const loReqFaint = outcome.lowerReqNoFaintMask || 0;
    const loViolated = !!(
      (loNode || outcome.lazyLowerSnapshot) &&
      loVal > DEFAULT_LOWER + EPSILON &&
      ((loReqFaint !== 0 && (loFaint & loReqFaint) !== 0) ||
       (outcome.lowerReqNoDrain && loDrain))
    );
    const hiNode = outcome.upperChild;
    const hiVal = hiNode ? hiNode.upper : (outcome.lazyUpperSnapshot ? (outcome.lazyUpper ?? DEFAULT_UPPER) : DEFAULT_UPPER);
    const hiFaint = hiNode ? hiNode.upperFaintMask : (outcome.lazyUpperFaintMask || 0);
    const hiDrain = hiNode ? hiNode.upperUsedDrain : Boolean(outcome.lazyUpperUsedDrain);
    const hiReqFaint = outcome.upperReqNoFaintMask || 0;
    const hiViolated = !!(
      (hiNode || outcome.lazyUpperSnapshot) &&
      hiVal < DEFAULT_UPPER - EPSILON &&
      ((hiReqFaint !== 0 && (hiFaint & hiReqFaint) !== 0) ||
       (outcome.upperReqNoDrain && hiDrain))
    );
    const violatedSide: 'lower' | 'upper' | 'both' | undefined =
      loViolated && hiViolated ? 'both' : loViolated ? 'lower' : hiViolated ? 'upper' : undefined;
    const rawSubs = outcome.split(violatedSide);
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
      cell.cursor ||= this.adapter.createTurnCursor(node.snapshot, node.actions1[i], node.actions2[j], this._transitionOptions(node));
      const progress = cell.cursor.advance({maxRuns: 32, deadline: this.deadline});
      this._acceptTransition(node, i, j, progress);
      return;
    }
    const runTransition: BoundedAdapter['enumerateTurn'] = this.adapter.enumerateTurn || (enumerateTurn as any);
    const transition = runTransition(
      node.snapshot,
      node.actions1[i],
      node.actions2[j],
      this._transitionOptions(node)
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
    let cLowerFaint = 0;
    let cLowerDrain = false;
    let cUpperFaint = 0;
    let cUpperDrain = false;
    const outcomes = cell.outcomes;
    for (let k = 0; k < outcomes.length; k++) {
      const outcome = outcomes[k];
      const oFaint = outcome.faintMask || 0;
      let childLower = outcome.utility;
      let childUpper = outcome.utility;
      if (childLower === null) {
        if (outcome.split) {
          const loNode = outcome.child;
          const hasLo = !!(loNode || outcome.lazyLowerSnapshot);
          const rawLo = loNode ? loNode.lower : (outcome.lazyLowerSnapshot ? (outcome.lazyLower ?? DEFAULT_LOWER) : DEFAULT_LOWER);
          const rawLoDepth = loNode ? loNode.lowerDepth : (outcome.lazyLowerDepth || 0);
          const rawLoFaint = loNode ? loNode.lowerFaintMask : (outcome.lazyLowerFaintMask || 0);
          const rawLoDrain = loNode ? loNode.lowerUsedDrain : Boolean(outcome.lazyLowerUsedDrain);
          const loReqFaint = outcome.lowerReqNoFaintMask || 0;
          const loValid = hasLo &&
            rawLo > DEFAULT_LOWER + EPSILON &&
            (loReqFaint === 0 || (rawLoFaint & loReqFaint) === 0) &&
            (!outcome.lowerReqNoDrain || !rawLoDrain);
          if (loValid && rawLo > (outcome.validBoxLower ?? DEFAULT_LOWER) + EPSILON) {
            outcome.validBoxLower = rawLo;
            outcome.validBoxLowerDepth = rawLoDepth;
            outcome.validBoxLowerFaintMask = rawLoFaint;
            outcome.validBoxLowerUsedDrain = rawLoDrain;
          }
          if (outcome.validBoxLower !== undefined && outcome.validBoxLower > DEFAULT_LOWER + EPSILON) {
            childLower = outcome.validBoxLower;
            const d = (outcome.validBoxLowerDepth || 0) + 1;
            if (d > cLowerDepth) cLowerDepth = d;
            cLowerFaint |= oFaint | (outcome.validBoxLowerFaintMask || 0);
            if (outcome.validBoxLowerUsedDrain) cLowerDrain = true;
          } else {
            childLower = DEFAULT_LOWER;
          }

          const hiNode = outcome.upperChild;
          const hasHi = !!(hiNode || outcome.lazyUpperSnapshot);
          const rawHi = hiNode ? hiNode.upper : (outcome.lazyUpperSnapshot ? (outcome.lazyUpper ?? DEFAULT_UPPER) : DEFAULT_UPPER);
          const rawHiDepth = hiNode ? hiNode.upperDepth : (outcome.lazyUpperDepth || 0);
          const rawHiFaint = hiNode ? hiNode.upperFaintMask : (outcome.lazyUpperFaintMask || 0);
          const rawHiDrain = hiNode ? hiNode.upperUsedDrain : Boolean(outcome.lazyUpperUsedDrain);
          const hiReqFaint = outcome.upperReqNoFaintMask || 0;
          const hiValid = hasHi &&
            rawHi < DEFAULT_UPPER - EPSILON &&
            (hiReqFaint === 0 || (rawHiFaint & hiReqFaint) === 0) &&
            (!outcome.upperReqNoDrain || !rawHiDrain);
          if (hiValid && rawHi < (outcome.validBoxUpper ?? DEFAULT_UPPER) - EPSILON) {
            outcome.validBoxUpper = rawHi;
            outcome.validBoxUpperDepth = rawHiDepth;
            outcome.validBoxUpperFaintMask = rawHiFaint;
            outcome.validBoxUpperUsedDrain = rawHiDrain;
          }
          if (outcome.validBoxUpper !== undefined && outcome.validBoxUpper < DEFAULT_UPPER - EPSILON) {
            childUpper = outcome.validBoxUpper;
            const d = (outcome.validBoxUpperDepth || 0) + 1;
            if (d > cUpperDepth) cUpperDepth = d;
            cUpperFaint |= oFaint | (outcome.validBoxUpperFaintMask || 0);
            if (outcome.validBoxUpperUsedDrain) cUpperDrain = true;
          } else {
            childUpper = DEFAULT_UPPER;
          }
        } else {
          const ch = outcome.child;
          if (ch) {
            childLower = ch.lower;
            childUpper = ch.upper;
            if (childLower > DEFAULT_LOWER + EPSILON) {
              const d = ch.lowerDepth + 1;
              if (d > cLowerDepth) cLowerDepth = d;
              cLowerFaint |= oFaint | ch.lowerFaintMask;
              if (ch.lowerUsedDrain) cLowerDrain = true;
            }
            if (childUpper < DEFAULT_UPPER - EPSILON) {
              const d = ch.upperDepth + 1;
              if (d > cUpperDepth) cUpperDepth = d;
              cUpperFaint |= oFaint | ch.upperFaintMask;
              if (ch.upperUsedDrain) cUpperDrain = true;
            }
          } else if (outcome.lazySnapshot) {
            childLower = outcome.lazyLower ?? DEFAULT_LOWER;
            childUpper = outcome.lazyUpper ?? DEFAULT_UPPER;
            if (childLower > DEFAULT_LOWER + EPSILON) {
              const d = (outcome.lazyLowerDepth || 0) + 1;
              if (d > cLowerDepth) cLowerDepth = d;
              cLowerFaint |= oFaint | (outcome.lazyLowerFaintMask || 0);
              if (outcome.lazyLowerUsedDrain) cLowerDrain = true;
            }
            if (childUpper < DEFAULT_UPPER - EPSILON) {
              const d = (outcome.lazyUpperDepth || 0) + 1;
              if (d > cUpperDepth) cUpperDepth = d;
              cUpperFaint |= oFaint | (outcome.lazyUpperFaintMask || 0);
              if (outcome.lazyUpperUsedDrain) cUpperDrain = true;
            }
          } else {
            childLower = DEFAULT_LOWER;
            childUpper = DEFAULT_UPPER;
          }
        }
      } else {
        if (childLower > DEFAULT_LOWER + EPSILON) {
          if (cLowerDepth < 1) cLowerDepth = 1;
          cLowerFaint |= oFaint;
        }
        if (childUpper < DEFAULT_UPPER - EPSILON) {
          if (cUpperDepth < 1) cUpperDepth = 1;
          cUpperFaint |= oFaint;
        }
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
      cell.lowerFaintMask = cLowerFaint;
      cell.lowerUsedDrain = cLowerDrain;
    } else if (nextLower > cell.lower) {
      cell.lower = Math.min(cell.upper, nextLower);
    }
    if (nextUpper < cell.upper - EPSILON) {
      cell.upper = Math.max(cell.lower, nextUpper);
      cell.upperDepth = nextUpper < cell.lower ? Math.max(cUpperDepth, cell.lowerDepth || 0) : cUpperDepth;
      cell.upperFaintMask = cUpperFaint;
      cell.upperUsedDrain = cUpperDrain;
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
    const m = cells.length;
    const n = cells[0].length;
    const lowerMatrix = node.lowerMatrix!;
    const upperMatrix = node.upperMatrix!;
    const populated = node.populatedCells;
    const rowFloor = node.rowFloor!;
    const rowOptFloor = node.rowOptFloor!;
    const rowLowerSum = node.rowLowerSum!;
    const colCeil = node.colCeil!;
    const colOptCeil = node.colOptCeil!;
    const colUpperSum = node.colUpperSum!;
    const rowOpaqueProbes = node.rowOpaqueProbes!;
    const colOpaqueProbes = node.colOpaqueProbes!;
    const rowStallProbes = node.rowStallProbes;
    const colStallProbes = node.colStallProbes;
    const prevLoP2 = node.lowerSolution?.p2 || null;
    const prevHiP1 = node.upperSolution?.p1 || null;
    let needLowerSolve = prevLoP2 === null;
    let needUpperSolve = prevHiP1 === null;
    let dirtyRows: Set<number> | null = null;
    let dirtyCols: Set<number> | null = null;

    const recordChanged = (
      i: number,
      j: number,
      cell: BoundedCell,
      oldLo: number,
      oldHi: number,
      mask: number,
      coordProbes?: number
    ) => {
      changeMask |= mask;
      if ((mask & 1) !== 0) {
        lowerMatrix[i][j] = cell.lower;
        const dLo = cell.lower - oldLo;
        rowLowerSum[i] += dLo;
        if (rowStallProbes && dLo > 1e-4) rowStallProbes[i] = 0;
        if (!needLowerSolve && (dLo < 0 || prevLoP2![j] > 0)) needLowerSolve = true;
      }
      if ((mask & 2) !== 0) {
        upperMatrix[i][j] = cell.upper;
        const dHi = cell.upper - oldHi;
        colUpperSum[j] += dHi;
        if (colStallProbes && dHi < -1e-4) colStallProbes[j] = 0;
        if (!needUpperSolve && (dHi > 0 || prevHiP1![i] > 0)) needUpperSolve = true;
      }
      const pCount = coordProbes !== undefined ? coordProbes : (cell.probes || 0);
      if (pCount > 0 && oldLo <= DEFAULT_LOWER + EPSILON && oldHi >= DEFAULT_UPPER - EPSILON &&
          (cell.lower > DEFAULT_LOWER + EPSILON || cell.upper < DEFAULT_UPPER - EPSILON)) {
        rowOpaqueProbes[i] -= pCount;
        colOpaqueProbes[j] -= pCount;
      }
      if (!dirtyRows) dirtyRows = new Set();
      if (!dirtyCols) dirtyCols = new Set();
      dirtyRows.add(i);
      dirtyCols.add(j);
    };

    if (populated) {
      for (let p = 0; p < populated.length; p++) {
        const entry = populated[p];
        const cell = entry.cell;
        const oldLo = cell.lower;
        const oldHi = cell.upper;
        const mask = this._cellBounds(cell);
        if (mask !== 0 || cell.needsSync) {
          cell.needsSync = false;
          const coords = cell.coords;
          if (coords) {
            for (let c = 0; c < coords.length; c++) {
              const cr = coords[c];
              const prevL = lowerMatrix[cr.i][cr.j];
              const prevU = upperMatrix[cr.i][cr.j];
              let cMask = 0;
              if (cell.lower !== prevL) cMask |= 1;
              if (cell.upper !== prevU) cMask |= 2;
              if (cMask !== 0) {
                recordChanged(cr.i, cr.j, cell, prevL, prevU, cMask, cr.probes);
                if (cr.probes > 0 && prevL <= DEFAULT_LOWER + EPSILON && prevU >= DEFAULT_UPPER - EPSILON &&
                    (cell.lower > DEFAULT_LOWER + EPSILON || cell.upper < DEFAULT_UPPER - EPSILON)) {
                  cr.probes = 0;
                }
              }
            }
          } else if (mask !== 0) {
            recordChanged(entry.i, entry.j, cell, oldLo, oldHi, mask);
          }
        }
      }
    } else {
      for (let i = 0; i < m; i++) {
        const row = cells[i];
        const lRow = lowerMatrix[i];
        const uRow = upperMatrix[i];
        for (let j = 0; j < n; j++) {
          const cell = row[j];
          this._cellBounds(cell);
          if (cell.needsSync) cell.needsSync = false;
          const prevL = lRow[j];
          const prevU = uRow[j];
          let cMask = 0;
          if (cell.lower !== prevL) cMask |= 1;
          if (cell.upper !== prevU) cMask |= 2;
          if (cMask !== 0) recordChanged(i, j, cell, prevL, prevU, cMask);
        }
      }
    }

    if (dirtyRows) {
      const rowStallProbes = node.rowStallProbes;
      for (const i of dirtyRows) {
        const row = cells[i];
        let rf = row[0].lower;
        let rof = row[0].upper;
        for (let j = 1; j < n; j++) {
          const lo = row[j].lower;
          const hi = row[j].upper;
          if (lo < rf) rf = lo;
          if (hi < rof) rof = hi;
        }
        if (rowStallProbes && rf > rowFloor[i] + EPSILON) rowStallProbes[i] = 0;
        rowFloor[i] = rf;
        rowOptFloor[i] = rof;
      }
      let bestRf = rowFloor[0];
      for (let i = 1; i < m; i++) {
        if (rowFloor[i] > bestRf) bestRf = rowFloor[i];
      }
      node.bestPureRowFloor = bestRf;
    }
    if (dirtyCols) {
      const colStallProbes = node.colStallProbes;
      for (const j of dirtyCols) {
        let cc = cells[0][j].upper;
        let coc = cells[0][j].lower;
        for (let i = 1; i < m; i++) {
          const c = cells[i][j];
          if (c.upper > cc) cc = c.upper;
          if (c.lower > coc) coc = c.lower;
        }
        if (colStallProbes && cc < colCeil[j] - EPSILON) colStallProbes[j] = 0;
        colCeil[j] = cc;
        colOptCeil[j] = coc;
      }
      let bestCc = colCeil[0];
      for (let j = 1; j < n; j++) {
        if (colCeil[j] < bestCc) bestCc = colCeil[j];
      }
      node.bestPureColCeil = bestCc;
    }

    const computeExactCertified = (): boolean => {
      if (node.upper - node.lower > 1e-8) return false;
      if (populated) {
        if ((node.populatedCellCount ?? populated.length) < m * n) return false;
        for (let p = 0; p < populated.length; p++) {
          const cell = populated[p].cell;
          if (!cell.outcomes || cell.cursor || cell.remainingProbability) return false;
          for (let k = 0; k < cell.outcomes.length; k++) {
            const outcome = cell.outcomes[k];
            if (outcome.utility === null && (outcome.split || !outcome.child || !outcome.child.exactCertified)) {
              return false;
            }
          }
        }
        return true;
      }
      for (let i = 0; i < m; i++) {
        const row = cells[i];
        for (let j = 0; j < n; j++) {
          const cell = row[j];
          if (!cell.outcomes || cell.cursor || cell.remainingProbability) return false;
          for (let k = 0; k < cell.outcomes.length; k++) {
            const outcome = cell.outcomes[k];
            if (outcome.utility === null && (outcome.split || !outcome.child || !outcome.child.exactCertified)) {
              return false;
            }
          }
        }
      }
      return true;
    };

    const previousExact = node.exactCertified;
    if (changeMask === 0 || (!needLowerSolve && !needUpperSolve)) {
      const oldL0 = node.lower;
      const oldU0 = node.upper;
      this._tryProtectContraction(node);
      const exactCertified = computeExactCertified();
      node.exactCertified = exactCertified;
      node.dirty = false;
      return previousExact !== exactCertified ||
        Math.abs(oldL0 - node.lower) > EPSILON || Math.abs(oldU0 - node.upper) > EPSILON;
    }
    const oldLower = node.lower;
    const oldUpper = node.upper;
    this.stats.matrixSolves++;
    if (needLowerSolve || !node.lowerSolution) {
      const lowerSolution = solveMatrixFast(lowerMatrix, node.lowerSolution, rowFloor, colOptCeil);
      const sup1: number[] = [];
      const sup1W: number[] = [];
      for (let i = 0; i < m; i++) {
        const w = lowerSolution.p1[i];
        if (w > 1e-15) {
          sup1.push(i);
          sup1W.push(w);
        }
      }
      let lowerSecurity = Infinity;
      for (let j = 0; j < n; j++) {
        let sum = 0;
        for (let k = 0; k < sup1.length; k++) {
          sum += sup1W[k] * lowerMatrix[sup1[k]][j];
        }
        if (sum < lowerSecurity) lowerSecurity = sum;
      }
      const lowerValue = lowerSecurity - 1e-10;
      const boundedLower = Math.max(DEFAULT_LOWER, Math.min(DEFAULT_UPPER, lowerValue));
      if (boundedLower > node.lower + EPSILON) {
        let nextLowerDepth = 0;
        let nextLowerFaint = 0;
        let nextLowerDrain = false;
        const acts1 = node.actions1!;
        for (let k = 0; k < sup1.length; k++) {
          const rIdx = sup1[k];
          if ((acts1[rIdx] as any)?.hasDrain) nextLowerDrain = true;
          if ((acts1[rIdx] as any)?.hasTailwind) nextLowerFaint |= TW_P1_BIT;
          const row = cells[rIdx];
          for (let j = 0; j < n; j++) {
            const c = row[j];
            if (c.lower > DEFAULT_LOWER + EPSILON) {
              const d = c.lowerDepth || 1;
              if (d > nextLowerDepth) nextLowerDepth = d;
              nextLowerFaint |= (c.lowerFaintMask || 0);
              if (c.lowerUsedDrain) nextLowerDrain = true;
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
        node.lowerFaintMask = nextLowerFaint;
        node.lowerUsedDrain = nextLowerDrain;
      } else if (boundedLower > node.lower) {
        node.lower = Math.min(node.upper, boundedLower);
      }
      node.lowerSolution = lowerSolution;
    }
    if (needUpperSolve || !node.upperSolution) {
      const upperSolution = solveMatrixFast(upperMatrix, node.upperSolution, rowOptFloor, colCeil);
      const sup2: number[] = [];
      const sup2W: number[] = [];
      for (let j = 0; j < n; j++) {
        const w = upperSolution.p2[j];
        if (w > 1e-15) {
          sup2.push(j);
          sup2W.push(w);
        }
      }
      let upperSecurity = -Infinity;
      for (let i = 0; i < m; i++) {
        const row = upperMatrix[i];
        let sum = 0;
        for (let k = 0; k < sup2.length; k++) {
          sum += row[sup2[k]] * sup2W[k];
        }
        if (sum > upperSecurity) upperSecurity = sum;
      }
      const upperValue = upperSecurity + 1e-10;
      const boundedUpper = Math.max(DEFAULT_LOWER, Math.min(DEFAULT_UPPER, upperValue));
      if (boundedUpper < node.upper - EPSILON) {
        let nextUpperDepth = 0;
        let nextUpperFaint = 0;
        let nextUpperDrain = false;
        const acts2 = node.actions2!;
        for (let k = 0; k < sup2.length; k++) {
          const j = sup2[k];
          if ((acts2[j] as any)?.hasDrain) nextUpperDrain = true;
          if ((acts2[j] as any)?.hasTailwind) nextUpperFaint |= TW_P2_BIT;
          for (let i = 0; i < m; i++) {
            const c = cells[i][j];
            if (c.upper < DEFAULT_UPPER - EPSILON) {
              const d = c.upperDepth || 1;
              if (d > nextUpperDepth) nextUpperDepth = d;
              nextUpperFaint |= (c.upperFaintMask || 0);
              if (c.upperUsedDrain) nextUpperDrain = true;
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
        node.upperFaintMask = nextUpperFaint;
        node.upperUsedDrain = nextUpperDrain;
      } else if (boundedUpper < node.upper) {
        node.upper = Math.max(node.lower, boundedUpper);
      }
      node.upperSolution = upperSolution;
    }
    this._tryProtectContraction(node);
    const exactCertified = computeExactCertified();
    node.exactCertified = exactCertified;
    node.dirty = false;
    // Parents only consume this node's interval endpoints and exactness. A
    // changed internal matrix with identical exported bounds cannot affect a
    // parent, so do not enqueue needless ancestor refreshes for it.
    return previousExact !== exactCertified ||
      Math.abs(oldLower - node.lower) > EPSILON || Math.abs(oldUpper - node.upper) > EPSILON;
  }

  /**
   * Exact finite-horizon Protect/Endure chain contraction for non-root nodes
   * where 1 or 2 active Pokemon on the same side have positive protectStreak(s)
   * (1 <= s0, s1 <= 6, min < 6) and an opposing action proves strictly tighter
   * bounds on all non-stall and stall-fail outcomes while pure self-shift stall
   * rows map s_k -> s_{k+1} (or s_{s0,s1} -> s_{min(6,s0+1),min(6,s1+1)}).
   */
  _tryProtectContraction(node: SearchNode): void {
    if (node === this.rootNode || !node.initialized || !this.adapter.protectContractionInfo) return;
    if (node.protectInfo === undefined) {
      node.protectInfo = this.adapter.protectContractionInfo(node.snapshot);
    }
    const info = node.protectInfo;
    if (!info) return;
    const stallSlots = info.stallSlotsCount;
    const s0 = info.streaks ? info.streaks[0] : info.streak;
    const s1 = stallSlots === 2 ? (info.streaks ? info.streaks[1]! : info.streak) : s0;
    const k = Math.min(s0, s1);
    if (k < 1 || k >= 6 || s0 > 6 || s1 > 6) return;
    const p0 = 1 / Math.min(729, 3 ** s0);
    const q0 = 1 - p0;
    const p1 = 1 / Math.min(729, 3 ** s1);
    const q1 = 1 - p1;
    const pBoth0 = p0 * p1;
    const pOne0 = p0 * q1 + q0 * p1;
    const pNone0 = q0 * q1;
    const getStallMask = (act: any): 0 | 1 | 2 | 3 => {
      if (info.stallActionMask) return info.stallActionMask(act);
      const cnt = info.stallActionCount(act);
      return cnt === 2 ? 3 : cnt === 1 ? 1 : 0;
    };
    const fullMask = stallSlots === 2 ? 3 : 1;
    const cells = node.cells!;
    const actions1 = node.actions1!;
    const actions2 = node.actions2!;
    const m = actions1.length;
    const n = actions2.length;

    const getUpperSnap = (o: BoundedOutcome): Snapshot | null =>
      o.split
        ? (o.upperChild ? o.upperChild.snapshot : (o.lazyUpperSnapshot ?? null))
        : (o.child ? o.child.snapshot : (o.lazySnapshot ?? null));

    const getUpperStats = (o: BoundedOutcome): {u: number; depth: number; faint: number; drain: boolean} => {
      const ref = o.split ? o.upperChild : o.child;
      const rawU = ref ? ref.upper : (o.lazyUpper ?? DEFAULT_UPPER);
      const depth = ref ? ref.upperDepth : (o.lazyUpperDepth || 0);
      const faint = ref ? ref.upperFaintMask : (o.lazyUpperFaintMask || 0);
      const drain = ref ? ref.upperUsedDrain : Boolean(o.lazyUpperUsedDrain);
      if (o.split) {
        const hiReqFaint = o.upperReqNoFaintMask || 0;
        const hiValid = rawU < DEFAULT_UPPER - EPSILON &&
          (hiReqFaint === 0 || (faint & hiReqFaint) === 0) &&
          (!o.upperReqNoDrain || !drain);
        if (hiValid && rawU < (o.validBoxUpper ?? DEFAULT_UPPER) - EPSILON) {
          o.validBoxUpper = rawU;
          o.validBoxUpperDepth = depth;
          o.validBoxUpperFaintMask = faint;
          o.validBoxUpperUsedDrain = drain;
        }
        if (o.validBoxUpper !== undefined && o.validBoxUpper < DEFAULT_UPPER - EPSILON) {
          return {
            u: o.validBoxUpper,
            depth: o.validBoxUpperDepth || 0,
            faint: o.validBoxUpperFaintMask || 0,
            drain: Boolean(o.validBoxUpperUsedDrain),
          };
        }
        return {u: DEFAULT_UPPER, depth: 0, faint: 0, drain: false};
      }
      return {u: rawU, depth, faint, drain};
    };

    const getLowerSnap = (o: BoundedOutcome): Snapshot | null =>
      o.split
        ? (o.child ? o.child.snapshot : (o.lazyLowerSnapshot ?? null))
        : (o.child ? o.child.snapshot : (o.lazySnapshot ?? null));

    const getLowerStats = (o: BoundedOutcome): {l: number; depth: number; faint: number; drain: boolean} => {
      const ref = o.child;
      const rawL = ref ? ref.lower : (o.lazyLower ?? DEFAULT_LOWER);
      const depth = ref ? ref.lowerDepth : (o.lazyLowerDepth || 0);
      const faint = ref ? ref.lowerFaintMask : (o.lazyLowerFaintMask || 0);
      const drain = ref ? ref.lowerUsedDrain : Boolean(o.lazyLowerUsedDrain);
      if (o.split) {
        const loReqFaint = o.lowerReqNoFaintMask || 0;
        const loValid = rawL > DEFAULT_LOWER + EPSILON &&
          (loReqFaint === 0 || (faint & loReqFaint) === 0) &&
          (!o.lowerReqNoDrain || !drain);
        if (loValid && rawL > (o.validBoxLower ?? DEFAULT_LOWER) + EPSILON) {
          o.validBoxLower = rawL;
          o.validBoxLowerDepth = depth;
          o.validBoxLowerFaintMask = faint;
          o.validBoxLowerUsedDrain = drain;
        }
        if (o.validBoxLower !== undefined && o.validBoxLower > DEFAULT_LOWER + EPSILON) {
          return {
            l: o.validBoxLower,
            depth: o.validBoxLowerDepth || 0,
            faint: o.validBoxLowerFaintMask || 0,
            drain: Boolean(o.validBoxLowerUsedDrain),
          };
        }
        return {l: DEFAULT_LOWER, depth: 0, faint: 0, drain: false};
      }
      return {l: rawL, depth, faint, drain};
    };

    if (info.stallingSide === 0) {
      const rowStallMask = new Uint8Array(m);
      let anyFullStall = false;
      for (let i = 0; i < m; i++) {
        const sm = getStallMask(actions1[i]);
        rowStallMask[i] = sm;
        if (sm === fullMask) anyFullStall = true;
      }
      if (!anyFullStall) return;

      let bestUpper = node.upper;
      let bestDepth = node.upperDepth;
      let bestFaint = node.upperFaintMask;
      let bestDrain = node.upperUsedDrain;

      for (let j = 0; j < n; j++) {
        if (!info.isOpponentActionEligible(actions2[j])) continue;
        let nonStallMax = DEFAULT_LOWER;
        let maxProofDepth = 1;
        let colFaint = (actions2[j] as any)?.hasTailwind ? TW_P2_BIT : 0;
        let colDrain = Boolean((actions2[j] as any)?.hasDrain);
        let feasible = true;
        for (let i = 0; i < m; i++) {
          if (rowStallMask[i] > 0) continue;
          const c = cells[i][j];
          if (c.upper >= bestUpper - EPSILON) {
            feasible = false;
            break;
          }
          if (c.upper > nonStallMax) nonStallMax = c.upper;
          if (c.upper < DEFAULT_UPPER - EPSILON) {
            const d = c.upperDepth || 1;
            if (d > maxProofDepth) maxProofDepth = d;
            colFaint |= (c.upperFaintMask || 0);
            if (c.upperUsedDrain) colDrain = true;
          }
        }
        if (!feasible) continue;

        let hasSelfStall = false;
        let selfFailMax = DEFAULT_LOWER;
        let selfAtKBaseMax = DEFAULT_LOWER;
        const selfShiftActions: any[] = [];
        let hasSingle0 = false;
        let single0FailMax = DEFAULT_LOWER;
        let single0AtKMax = DEFAULT_LOWER;
        let hasSingle1 = false;
        let single1FailMax = DEFAULT_LOWER;
        let single1AtKMax = DEFAULT_LOWER;
        let hasMixStall = false;
        let mixFailMax = DEFAULT_LOWER;
        let mixAtKMax = DEFAULT_LOWER;

        for (let i = 0; i < m; i++) {
          const sm = rowStallMask[i];
          if (sm === 0) continue;
          const c = cells[i][j];
          if (!c.outcomes || c.cursor || (c.remainingProbability && c.remainingProbability > EPSILON)) {
            feasible = false;
            break;
          }
          if (sm === 1 || sm === 2) {
            const pSlot = sm === 1 ? p0 : p1;
            const qSlot = sm === 1 ? q0 : q1;
            let succProb = 0;
            let succCount = 0;
            let succIsExactSelf = false;
            let failUpperSum = 0;
            let failProb = 0;
            let tailProb = 0;
            let rowFailDepth = 1;
            for (let oi = 0; oi < c.outcomes.length; oi++) {
              const o = c.outcomes[oi];
              const oFaint = o.faintMask || 0;
              if (o.utility !== null) {
                failProb += o.probability;
                failUpperSum += o.probability * o.utility;
                if (o.utility < DEFAULT_UPPER - EPSILON) colFaint |= oFaint;
                continue;
              }
              const refSnap = getUpperSnap(o);
              if (!refSnap) {
                if (o.split) {
                  tailProb += o.probability;
                  continue;
                }
                feasible = false;
                break;
              }
              const insp = info.inspectOutcome(refSnap);
              if (!insp || !insp.valid) {
                feasible = false;
                break;
              }
              if (insp.succCount === 1 && (insp.succMask === undefined || insp.succMask === sm)) {
                succProb += o.probability;
                succCount++;
                if (stallSlots === 1 && !o.split && succCount === 1 && insp.baseKey === info.baseKey) {
                  succIsExactSelf = true;
                } else {
                  succIsExactSelf = false;
                }
              } else if (insp.succCount === 0) {
                failProb += o.probability;
                const st = getUpperStats(o);
                failUpperSum += o.probability * st.u;
                if (st.u < DEFAULT_UPPER - EPSILON) {
                  const d = st.depth + 1;
                  if (d > rowFailDepth) rowFailDepth = d;
                  colFaint |= oFaint | st.faint;
                  if (st.drain) colDrain = true;
                }
              } else {
                feasible = false;
                break;
              }
            }
            if (!feasible ||
                succProb > pSlot + 1e-7 ||
                failProb > qSlot + 1e-7 ||
                Math.abs(succProb + failProb + tailProb - 1) > 1e-6 ||
                failProb <= 1e-9) {
              feasible = false;
              break;
            }
            const missingFail = Math.max(0, qSlot - failProb);
            const uFail = Math.max(DEFAULT_LOWER, Math.min(DEFAULT_UPPER, (failUpperSum + missingFail * DEFAULT_UPPER) / qSlot));
            if (rowFailDepth > maxProofDepth) maxProofDepth = rowFailDepth;
            if (stallSlots === 1 && Math.abs(succProb - pSlot) <= 1e-7 && succCount === 1 && succIsExactSelf) {
              hasSelfStall = true;
              if (uFail > selfFailMax) selfFailMax = uFail;
              selfShiftActions.push(actions1[i]);
            } else if (stallSlots === 2) {
              if (sm === 1) {
                hasSingle0 = true;
                if (uFail > single0FailMax) single0FailMax = uFail;
                if (c.upper > single0AtKMax) single0AtKMax = c.upper;
              } else {
                hasSingle1 = true;
                if (uFail > single1FailMax) single1FailMax = uFail;
                if (c.upper > single1AtKMax) single1AtKMax = c.upper;
              }
              if (c.upper < DEFAULT_UPPER - EPSILON) {
                const cd = c.upperDepth || 1;
                if (cd > maxProofDepth) maxProofDepth = cd;
                colFaint |= (c.upperFaintMask || 0);
                if (c.upperUsedDrain) colDrain = true;
              }
            } else {
              hasMixStall = true;
              if (uFail > mixFailMax) mixFailMax = uFail;
              if (c.upper > mixAtKMax) mixAtKMax = c.upper;
              if (c.upper < DEFAULT_UPPER - EPSILON) {
                const cd = c.upperDepth || 1;
                if (cd > maxProofDepth) maxProofDepth = cd;
                colFaint |= (c.upperFaintMask || 0);
                if (c.upperUsedDrain) colDrain = true;
              }
            }
          } else {
            // sm === 3 (double-Protect on stallSlots === 2)
            let bothSuccProb = 0;
            let bothSuccCount = 0;
            let bothSuccExactSelf = false;
            let oneSuccProb = 0;
            let oneSuccUpperSum = 0;
            let bothFailProb = 0;
            let bothFailUpperSum = 0;
            let tailProb = 0;
            let rowDepth = 1;
            for (let oi = 0; oi < c.outcomes.length; oi++) {
              const o = c.outcomes[oi];
              const oFaint = o.faintMask || 0;
              if (o.utility !== null) {
                bothFailProb += o.probability;
                bothFailUpperSum += o.probability * o.utility;
                if (o.utility < DEFAULT_UPPER - EPSILON) colFaint |= oFaint;
                continue;
              }
              const refSnap = getUpperSnap(o);
              if (!refSnap) {
                if (o.split) {
                  tailProb += o.probability;
                  continue;
                }
                feasible = false;
                break;
              }
              const insp = info.inspectOutcome(refSnap);
              if (!insp || !insp.valid) {
                feasible = false;
                break;
              }
              if (insp.succCount === 2) {
                bothSuccProb += o.probability;
                bothSuccCount++;
                if (!o.split && bothSuccCount === 1 && insp.baseKey === info.baseKey) {
                  bothSuccExactSelf = true;
                } else {
                  bothSuccExactSelf = false;
                }
              } else if (insp.succCount === 1) {
                oneSuccProb += o.probability;
                const st = getUpperStats(o);
                oneSuccUpperSum += o.probability * st.u;
                if (st.u < DEFAULT_UPPER - EPSILON) {
                  const d = st.depth + 1;
                  if (d > rowDepth) rowDepth = d;
                  colFaint |= oFaint | st.faint;
                  if (st.drain) colDrain = true;
                }
              } else {
                bothFailProb += o.probability;
                const st = getUpperStats(o);
                bothFailUpperSum += o.probability * st.u;
                if (st.u < DEFAULT_UPPER - EPSILON) {
                  const d = st.depth + 1;
                  if (d > rowDepth) rowDepth = d;
                  colFaint |= oFaint | st.faint;
                  if (st.drain) colDrain = true;
                }
              }
            }
            if (!feasible ||
                bothSuccProb > pBoth0 + 1e-7 ||
                oneSuccProb > pOne0 + 1e-7 ||
                bothFailProb > pNone0 + 1e-7 ||
                Math.abs(bothSuccProb + oneSuccProb + bothFailProb + tailProb - 1) > 1e-6 ||
                bothFailProb <= 1e-9) {
              feasible = false;
              break;
            }
            const missingBothFail = Math.max(0, pNone0 - bothFailProb);
            const uBothFail = Math.max(DEFAULT_LOWER, Math.min(DEFAULT_UPPER, (bothFailUpperSum + missingBothFail * DEFAULT_UPPER) / pNone0));
            if (rowDepth > maxProofDepth) maxProofDepth = rowDepth;
            if (Math.abs(bothSuccProb - pBoth0) <= 1e-7 && bothSuccCount === 1 && bothSuccExactSelf) {
              hasSelfStall = true;
              if (uBothFail > selfFailMax) selfFailMax = uBothFail;
              const atKBase = bothFailUpperSum + oneSuccUpperSum + tailProb * DEFAULT_UPPER;
              if (atKBase > selfAtKBaseMax) selfAtKBaseMax = atKBase;
              selfShiftActions.push(actions1[i]);
            } else {
              hasMixStall = true;
              if (uBothFail > mixFailMax) mixFailMax = uBothFail;
              if (c.upper > mixAtKMax) mixAtKMax = c.upper;
              if (c.upper < DEFAULT_UPPER - EPSILON) {
                const cd = c.upperDepth || 1;
                if (cd > maxProofDepth) maxProofDepth = cd;
                colFaint |= (c.upperFaintMask || 0);
                if (c.upperUsedDrain) colDrain = true;
              }
            }
          }
        }
        if (!feasible || !hasSelfStall) continue;
        if (info.equalTailwind && (colFaint & TW_P2_BIT) !== 0) continue;
        if (hasSingle0 && single0AtKMax >= bestUpper - EPSILON) continue;
        if (hasSingle1 && single1AtKMax >= bestUpper - EPSILON) continue;
        if (hasMixStall && mixAtKMax >= bestUpper - EPSILON) continue;

        const targetK = info.maxSafeStreak(actions2[j], selfShiftActions, maxProofDepth);
        const steps = targetK - k;
        if (steps <= 0) continue;

        let uNext = DEFAULT_UPPER;
        for (let step = steps - 1; step >= 0; step--) {
          const pk0 = 1 / Math.min(729, 3 ** Math.min(6, s0 + step));
          const qk0 = 1 - pk0;
          let vSelf: number;
          let vSingle0 = DEFAULT_LOWER;
          let vSingle1 = DEFAULT_LOWER;
          let vMix = DEFAULT_LOWER;
          if (stallSlots === 1) {
            vSelf = qk0 * selfFailMax + pk0 * uNext;
            if (hasMixStall) {
              const vMixCons = qk0 * mixFailMax + pk0 * DEFAULT_UPPER;
              vMix = step === 0 ? Math.min(mixAtKMax, vMixCons) : vMixCons;
            }
          } else {
            const pk1 = 1 / Math.min(729, 3 ** Math.min(6, s1 + step));
            const qk1 = 1 - pk1;
            const vSelfCons = (qk0 * qk1) * selfFailMax + (pk0 * qk1 + qk0 * pk1) * DEFAULT_UPPER + (pk0 * pk1) * uNext;
            vSelf = step === 0 ? Math.min(selfAtKBaseMax + (pk0 * pk1) * uNext, vSelfCons) : vSelfCons;
            if (hasSingle0) {
              const vS0Cons = qk0 * single0FailMax + pk0 * DEFAULT_UPPER;
              vSingle0 = step === 0 ? Math.min(single0AtKMax, vS0Cons) : vS0Cons;
            }
            if (hasSingle1) {
              const vS1Cons = qk1 * single1FailMax + pk1 * DEFAULT_UPPER;
              vSingle1 = step === 0 ? Math.min(single1AtKMax, vS1Cons) : vS1Cons;
            }
            if (hasMixStall) {
              const vMixCons = (qk0 * qk1) * mixFailMax + (1 - qk0 * qk1) * DEFAULT_UPPER;
              vMix = step === 0 ? Math.min(mixAtKMax, vMixCons) : vMixCons;
            }
          }
          uNext = Math.max(nonStallMax, vSelf, vSingle0, vSingle1, vMix);
        }
        const candUpper = Math.min(DEFAULT_UPPER, Math.max(node.lower, uNext + 1e-10));
        if (candUpper < bestUpper - EPSILON) {
          bestUpper = candUpper;
          bestDepth = steps + maxProofDepth;
          bestFaint = colFaint;
          bestDrain = colDrain;
        }
      }

      if (bestUpper < node.upper - EPSILON) {
        if (bestUpper <= node.lower) {
          node.upper = node.lower;
          node.upperDepth = Math.max(bestDepth, node.lowerDepth);
        } else {
          node.upper = bestUpper;
          node.upperDepth = bestDepth;
        }
        node.upperFaintMask = bestFaint;
        node.upperUsedDrain = bestDrain;
        this.stats.protectContractions++;
      }
      return;
    }

    // Symmetric case: stallingSide === 1 (P2 stalling; try eligible P1 row i to tighten node.lower).
    const colStallMask = new Uint8Array(n);
    let anyFullStall = false;
    for (let j = 0; j < n; j++) {
      const sm = getStallMask(actions2[j]);
      colStallMask[j] = sm;
      if (sm === fullMask) anyFullStall = true;
    }
    if (!anyFullStall) return;

    let bestLower = node.lower;
    let bestDepth = node.lowerDepth;
    let bestFaint = node.lowerFaintMask;
    let bestDrain = node.lowerUsedDrain;

    for (let i = 0; i < m; i++) {
      if (!info.isOpponentActionEligible(actions1[i])) continue;
      const row = cells[i];
      let nonStallMin = DEFAULT_UPPER;
      let maxProofDepth = 1;
      let rowFaint = (actions1[i] as any)?.hasTailwind ? TW_P1_BIT : 0;
      let rowDrain = Boolean((actions1[i] as any)?.hasDrain);
      let feasible = true;
      for (let j = 0; j < n; j++) {
        if (colStallMask[j] > 0) continue;
        const c = row[j];
        if (c.lower <= bestLower + EPSILON) {
          feasible = false;
          break;
        }
        if (c.lower < nonStallMin) nonStallMin = c.lower;
        if (c.lower > DEFAULT_LOWER + EPSILON) {
          const d = c.lowerDepth || 1;
          if (d > maxProofDepth) maxProofDepth = d;
          rowFaint |= (c.lowerFaintMask || 0);
          if (c.lowerUsedDrain) rowDrain = true;
        }
      }
      if (!feasible) continue;

      let hasSelfStall = false;
      let selfFailMin = DEFAULT_UPPER;
      let selfAtKBaseMin = DEFAULT_UPPER;
      const selfShiftActions: any[] = [];
      let hasSingle0 = false;
      let single0FailMin = DEFAULT_UPPER;
      let single0AtKMin = DEFAULT_UPPER;
      let hasSingle1 = false;
      let single1FailMin = DEFAULT_UPPER;
      let single1AtKMin = DEFAULT_UPPER;
      let hasMixStall = false;
      let mixFailMin = DEFAULT_UPPER;
      let mixAtKMin = DEFAULT_UPPER;

      for (let j = 0; j < n; j++) {
        const sm = colStallMask[j];
        if (sm === 0) continue;
        const c = row[j];
        if (!c.outcomes || c.cursor || (c.remainingProbability && c.remainingProbability > EPSILON)) {
          feasible = false;
          break;
        }
        if (sm === 1 || sm === 2) {
          const pSlot = sm === 1 ? p0 : p1;
          const qSlot = sm === 1 ? q0 : q1;
          let succProb = 0;
          let succCount = 0;
          let succIsExactSelf = false;
          let failLowerSum = 0;
          let failProb = 0;
          let tailProb = 0;
          let colFailDepth = 1;
          for (let oi = 0; oi < c.outcomes.length; oi++) {
            const o = c.outcomes[oi];
            const oFaint = o.faintMask || 0;
            if (o.utility !== null) {
              failProb += o.probability;
              failLowerSum += o.probability * o.utility;
              if (o.utility > DEFAULT_LOWER + EPSILON) rowFaint |= oFaint;
              continue;
            }
            const refSnap = getLowerSnap(o);
            if (!refSnap) {
              if (o.split) {
                tailProb += o.probability;
                continue;
              }
              feasible = false;
              break;
            }
            const insp = info.inspectOutcome(refSnap);
            if (!insp || !insp.valid) {
              feasible = false;
              break;
            }
            if (insp.succCount === 1 && (insp.succMask === undefined || insp.succMask === sm)) {
              succProb += o.probability;
              succCount++;
              if (stallSlots === 1 && !o.split && succCount === 1 && insp.baseKey === info.baseKey) {
                succIsExactSelf = true;
              } else {
                succIsExactSelf = false;
              }
            } else if (insp.succCount === 0) {
              failProb += o.probability;
              const st = getLowerStats(o);
              failLowerSum += o.probability * st.l;
              if (st.l > DEFAULT_LOWER + EPSILON) {
                const d = st.depth + 1;
                if (d > colFailDepth) colFailDepth = d;
                rowFaint |= oFaint | st.faint;
                if (st.drain) rowDrain = true;
              }
            } else {
              feasible = false;
              break;
            }
          }
          if (!feasible ||
              succProb > pSlot + 1e-7 ||
              failProb > qSlot + 1e-7 ||
              Math.abs(succProb + failProb + tailProb - 1) > 1e-6 ||
              failProb <= 1e-9) {
            feasible = false;
            break;
          }
          const missingFail = Math.max(0, qSlot - failProb);
          const lFail = Math.max(DEFAULT_LOWER, Math.min(DEFAULT_UPPER, (failLowerSum + missingFail * DEFAULT_LOWER) / qSlot));
          if (colFailDepth > maxProofDepth) maxProofDepth = colFailDepth;
          if (stallSlots === 1 && Math.abs(succProb - pSlot) <= 1e-7 && succCount === 1 && succIsExactSelf) {
            hasSelfStall = true;
            if (lFail < selfFailMin) selfFailMin = lFail;
            selfShiftActions.push(actions2[j]);
          } else if (stallSlots === 2) {
            if (sm === 1) {
              hasSingle0 = true;
              if (lFail < single0FailMin) single0FailMin = lFail;
              if (c.lower < single0AtKMin) single0AtKMin = c.lower;
            } else {
              hasSingle1 = true;
              if (lFail < single1FailMin) single1FailMin = lFail;
              if (c.lower < single1AtKMin) single1AtKMin = c.lower;
            }
            if (c.lower > DEFAULT_LOWER + EPSILON) {
              const cd = c.lowerDepth || 1;
              if (cd > maxProofDepth) maxProofDepth = cd;
              rowFaint |= (c.lowerFaintMask || 0);
              if (c.lowerUsedDrain) rowDrain = true;
            }
          } else {
            hasMixStall = true;
            if (lFail < mixFailMin) mixFailMin = lFail;
            if (c.lower < mixAtKMin) mixAtKMin = c.lower;
            if (c.lower > DEFAULT_LOWER + EPSILON) {
              const cd = c.lowerDepth || 1;
              if (cd > maxProofDepth) maxProofDepth = cd;
              rowFaint |= (c.lowerFaintMask || 0);
              if (c.lowerUsedDrain) rowDrain = true;
            }
          }
        } else {
          // sm === 3 (double-Protect on stallSlots === 2)
          let bothSuccProb = 0;
          let bothSuccCount = 0;
          let bothSuccExactSelf = false;
          let oneSuccProb = 0;
          let oneSuccLowerSum = 0;
          let bothFailProb = 0;
          let bothFailLowerSum = 0;
          let tailProb = 0;
          let colDepth = 1;
          for (let oi = 0; oi < c.outcomes.length; oi++) {
            const o = c.outcomes[oi];
            const oFaint = o.faintMask || 0;
            if (o.utility !== null) {
              bothFailProb += o.probability;
              bothFailLowerSum += o.probability * o.utility;
              if (o.utility > DEFAULT_LOWER + EPSILON) rowFaint |= oFaint;
              continue;
            }
            const refSnap = getLowerSnap(o);
            if (!refSnap) {
              if (o.split) {
                tailProb += o.probability;
                continue;
              }
              feasible = false;
              break;
            }
            const insp = info.inspectOutcome(refSnap);
            if (!insp || !insp.valid) {
              feasible = false;
              break;
            }
            if (insp.succCount === 2) {
              bothSuccProb += o.probability;
              bothSuccCount++;
              if (!o.split && bothSuccCount === 1 && insp.baseKey === info.baseKey) {
                bothSuccExactSelf = true;
              } else {
                bothSuccExactSelf = false;
              }
            } else if (insp.succCount === 1) {
              oneSuccProb += o.probability;
              const st = getLowerStats(o);
              oneSuccLowerSum += o.probability * st.l;
              if (st.l > DEFAULT_LOWER + EPSILON) {
                const d = st.depth + 1;
                if (d > colDepth) colDepth = d;
                rowFaint |= oFaint | st.faint;
                if (st.drain) rowDrain = true;
              }
            } else {
              bothFailProb += o.probability;
              const st = getLowerStats(o);
              bothFailLowerSum += o.probability * st.l;
              if (st.l > DEFAULT_LOWER + EPSILON) {
                const d = st.depth + 1;
                if (d > colDepth) colDepth = d;
                rowFaint |= oFaint | st.faint;
                if (st.drain) rowDrain = true;
              }
            }
          }
          if (!feasible ||
              bothSuccProb > pBoth0 + 1e-7 ||
              oneSuccProb > pOne0 + 1e-7 ||
              bothFailProb > pNone0 + 1e-7 ||
              Math.abs(bothSuccProb + oneSuccProb + bothFailProb + tailProb - 1) > 1e-6 ||
              bothFailProb <= 1e-9) {
            feasible = false;
            break;
          }
          const missingBothFail = Math.max(0, pNone0 - bothFailProb);
          const lBothFail = Math.max(DEFAULT_LOWER, Math.min(DEFAULT_UPPER, (bothFailLowerSum + missingBothFail * DEFAULT_LOWER) / pNone0));
          if (colDepth > maxProofDepth) maxProofDepth = colDepth;
          if (Math.abs(bothSuccProb - pBoth0) <= 1e-7 && bothSuccCount === 1 && bothSuccExactSelf) {
            hasSelfStall = true;
            if (lBothFail < selfFailMin) selfFailMin = lBothFail;
            const atKBase = bothFailLowerSum + oneSuccLowerSum + tailProb * DEFAULT_LOWER;
            if (atKBase < selfAtKBaseMin) selfAtKBaseMin = atKBase;
            selfShiftActions.push(actions2[j]);
          } else {
            hasMixStall = true;
            if (lBothFail < mixFailMin) mixFailMin = lBothFail;
            if (c.lower < mixAtKMin) mixAtKMin = c.lower;
            if (c.lower > DEFAULT_LOWER + EPSILON) {
              const cd = c.lowerDepth || 1;
              if (cd > maxProofDepth) maxProofDepth = cd;
              rowFaint |= (c.lowerFaintMask || 0);
              if (c.lowerUsedDrain) rowDrain = true;
            }
          }
        }
      }
      if (!feasible || !hasSelfStall) continue;
      if (info.equalTailwind && (rowFaint & TW_P1_BIT) !== 0) continue;
      if (hasSingle0 && single0AtKMin <= bestLower + EPSILON) continue;
      if (hasSingle1 && single1AtKMin <= bestLower + EPSILON) continue;
      if (hasMixStall && mixAtKMin <= bestLower + EPSILON) continue;

      const targetK = info.maxSafeStreak(actions1[i], selfShiftActions, maxProofDepth);
      const steps = targetK - k;
      if (steps <= 0) continue;

      let lNext = DEFAULT_LOWER;
      for (let step = steps - 1; step >= 0; step--) {
        const pk0 = 1 / Math.min(729, 3 ** Math.min(6, s0 + step));
        const qk0 = 1 - pk0;
        let vSelf: number;
        let vSingle0 = DEFAULT_UPPER;
        let vSingle1 = DEFAULT_UPPER;
        let vMix = DEFAULT_UPPER;
        if (stallSlots === 1) {
          vSelf = qk0 * selfFailMin + pk0 * lNext;
          if (hasMixStall) {
            const vMixCons = qk0 * mixFailMin + pk0 * DEFAULT_LOWER;
            vMix = step === 0 ? Math.max(mixAtKMin, vMixCons) : vMixCons;
          }
        } else {
          const pk1 = 1 / Math.min(729, 3 ** Math.min(6, s1 + step));
          const qk1 = 1 - pk1;
          const vSelfCons = (qk0 * qk1) * selfFailMin + (pk0 * qk1 + qk0 * pk1) * DEFAULT_LOWER + (pk0 * pk1) * lNext;
          vSelf = step === 0 ? Math.max(selfAtKBaseMin + (pk0 * pk1) * lNext, vSelfCons) : vSelfCons;
          if (hasSingle0) {
            const vS0Cons = qk0 * single0FailMin + pk0 * DEFAULT_LOWER;
            vSingle0 = step === 0 ? Math.max(single0AtKMin, vS0Cons) : vS0Cons;
          }
          if (hasSingle1) {
            const vS1Cons = qk1 * single1FailMin + pk1 * DEFAULT_LOWER;
            vSingle1 = step === 0 ? Math.max(single1AtKMin, vS1Cons) : vS1Cons;
          }
          if (hasMixStall) {
            const vMixCons = (qk0 * qk1) * mixFailMin + (1 - qk0 * qk1) * DEFAULT_LOWER;
            vMix = step === 0 ? Math.max(mixAtKMin, vMixCons) : vMixCons;
          }
        }
        lNext = Math.min(nonStallMin, vSelf, vSingle0, vSingle1, vMix);
      }
      const candLower = Math.max(DEFAULT_LOWER, Math.min(node.upper, lNext - 1e-10));
      if (candLower > bestLower + EPSILON) {
        bestLower = candLower;
        bestDepth = steps + maxProofDepth;
        bestFaint = rowFaint;
        bestDrain = rowDrain;
      }
    }

    if (bestLower > node.lower + EPSILON) {
      if (bestLower >= node.upper) {
        node.lower = node.upper;
        node.lowerDepth = Math.max(bestDepth, node.upperDepth);
      } else {
        node.lower = bestLower;
        node.lowerDepth = bestDepth;
      }
      node.lowerFaintMask = bestFaint;
      node.lowerUsedDrain = bestDrain;
      this.stats.protectContractions++;
    }
  }

  _backupFrom(startNodes: SearchNode[]) {
    const queue = [...startNodes];
    const queued = new Set(queue);
    if (this.deferredDirty.length > 0) {
      for (let i = 0; i < this.deferredDirty.length; i++) {
        const dn = this.deferredDirty[i];
        if (!queued.has(dn)) {
          queued.add(dn);
          queue.push(dn);
        }
      }
      this.deferredDirty.length = 0;
    }
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
        if (node.jointGroup && (lowerImproved || upperImproved)) {
          this._propagateJointMonoPp(node, lowerImproved, upperImproved, queue, queued);
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
        peer.lowerFaintMask = source.lowerFaintMask;
        peer.lowerUsedDrain = source.lowerUsedDrain;
        this.stats.ppBoundUpdates++;
        pLower = true;
      }
      if (canUpper && peer.upper > source.upper + EPSILON && ppVectorsCompatible(srcPp, peer.ppVec!, uThr)) {
        peer.upper = Math.max(peer.lower, source.upper);
        peer.upperDepth = source.upperDepth;
        peer.upperFaintMask = source.upperFaintMask;
        peer.upperUsedDrain = source.upperUsedDrain;
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

  _propagateJointMonoPp(
    source: SearchNode,
    lowerImproved: boolean,
    upperImproved: boolean,
    queue: SearchNode[],
    queued: Set<SearchNode>
  ) {
    const group = source.jointGroup;
    if (!group || !source.jointVec || !source.jointPp) return;
    const canLower = lowerImproved && source.lower > DEFAULT_LOWER + EPSILON &&
      source.lowerDepth > 0 && source.lowerDepth <= MAX_PP_PROP_DEPTH;
    const canUpper = upperImproved && source.upper < DEFAULT_UPPER - EPSILON &&
      source.upperDepth > 0 && source.upperDepth <= MAX_PP_PROP_DEPTH;
    if (!canLower && !canUpper) return;

    const enqueueNode = (target: SearchNode) => {
      target.dirty = true;
      if (!queued.has(target)) {
        queued.add(target);
        queue.push(target);
      }
    };
    const enqueueParents = (target: SearchNode) => {
      for (const parent of target.parents) {
        enqueueNode(parent);
      }
    };

    if (canLower) {
      const cand: JointWitness = {
        vec: source.jointVec,
        pp: source.jointPp,
        val: source.lower,
        depth: source.lowerDepth,
        faintMask: source.lowerFaintMask,
        usedDrain: source.lowerUsedDrain,
      };
      const lw = group.lowerWitnesses;
      let dominated = false;
      for (let i = 0; i < lw.length; i++) {
        if (jointLowerWitnessDominates(lw[i], cand, group)) {
          dominated = true;
          break;
        }
      }
      if (!dominated) {
        let write = 0;
        for (let i = 0; i < lw.length; i++) {
          if (!jointLowerWitnessDominates(cand, lw[i], group)) {
            lw[write++] = lw[i];
          }
        }
        lw.length = write;
        if (lw.length < MAX_JOINT_WITNESSES) {
          lw.push(cand);
        } else {
          let weakIdx = 0;
          for (let i = 1; i < lw.length; i++) {
            if (lw[i].val < lw[weakIdx].val - EPSILON ||
                (Math.abs(lw[i].val - lw[weakIdx].val) <= EPSILON && lw[i].depth > lw[weakIdx].depth)) {
              weakIdx = i;
            }
          }
          if (cand.val > lw[weakIdx].val + EPSILON ||
              (Math.abs(cand.val - lw[weakIdx].val) <= EPSILON && cand.depth < lw[weakIdx].depth)) {
            lw[weakIdx] = cand;
          }
        }

        const active = group.activeNodes;
        let aWrite = 0;
        for (let i = 0; i < active.length; i++) {
          const peer = active[i];
          if (peer !== source && peer !== this.rootNode && peer.lower < cand.val - EPSILON) {
            const outFaint = jointTransferLowerMask(cand, peer.jointVec!, peer.jointPp!, group);
            if (outFaint >= 0) {
              if (cand.val > peer.upper) {
                peer.lower = peer.upper;
                peer.lowerDepth = Math.max(cand.depth, peer.upperDepth);
              } else {
                peer.lower = cand.val;
                peer.lowerDepth = cand.depth;
              }
              peer.lowerFaintMask = outFaint;
              peer.lowerUsedDrain = cand.usedDrain;
              this.stats.ppBoundUpdates++;
              enqueueParents(peer);
            }
          }
          if (peer.upper - peer.lower > 1e-9) {
            active[aWrite++] = peer;
          }
        }
        active.length = aWrite;

        const watchers = group.lazyWatchers;
        let wWrite = 0;
        for (let i = 0; i < watchers.length; i++) {
          const w = watchers[i];
          const o = w.outcome;
          if (w.kind === 0) {
            if (o.child || !o.lazySnapshot) continue;
            if ((o.lazyLower ?? DEFAULT_LOWER) < cand.val - EPSILON) {
              const outFaint = jointTransferLowerMask(cand, w.vec, w.pp, group);
              if (outFaint >= 0) {
                const curU = o.lazyUpper ?? DEFAULT_UPPER;
                if (cand.val > curU) {
                  o.lazyLower = curU;
                  o.lazyLowerDepth = Math.max(cand.depth, o.lazyUpperDepth || 0);
                } else {
                  o.lazyLower = cand.val;
                  o.lazyLowerDepth = cand.depth;
                }
                o.lazyLowerFaintMask = outFaint;
                o.lazyLowerUsedDrain = cand.usedDrain;
                this.stats.ppBoundUpdates++;
                enqueueNode(w.parent);
              }
            }
            if ((o.lazyUpper ?? DEFAULT_UPPER) - (o.lazyLower ?? DEFAULT_LOWER) > 1e-9) {
              watchers[wWrite++] = w;
            }
          } else if (w.kind === 1) {
            if (o.child || !o.lazyLowerSnapshot) continue;
            const reqFaint = o.lowerReqNoFaintMask || 0;
            const curValid = (o.lazyLower ?? DEFAULT_LOWER) > DEFAULT_LOWER + EPSILON &&
              (reqFaint === 0 || ((o.lazyLowerFaintMask || 0) & reqFaint) === 0) &&
              (!o.lowerReqNoDrain || !o.lazyLowerUsedDrain);
            let effCurL = curValid ? (o.lazyLower ?? DEFAULT_LOWER) : DEFAULT_LOWER;
            if (effCurL < cand.val - EPSILON) {
              const outFaint = jointTransferLowerMask(cand, w.vec, w.pp, group);
              if (outFaint >= 0 &&
                  (reqFaint === 0 || (outFaint & reqFaint) === 0) &&
                  (!o.lowerReqNoDrain || !cand.usedDrain)) {
                o.lazyLower = cand.val;
                o.lazyLowerDepth = cand.depth;
                o.lazyLowerFaintMask = outFaint;
                o.lazyLowerUsedDrain = cand.usedDrain;
                effCurL = cand.val;
                this.stats.ppBoundUpdates++;
                enqueueNode(w.parent);
              }
            }
            if (effCurL < DEFAULT_UPPER - 1e-9) {
              watchers[wWrite++] = w;
            }
          } else {
            if (!o.upperChild && o.lazyUpperSnapshot) {
              const reqFaint = o.upperReqNoFaintMask || 0;
              const curValid = (o.lazyUpper ?? DEFAULT_UPPER) < DEFAULT_UPPER - EPSILON &&
                (reqFaint === 0 || ((o.lazyUpperFaintMask || 0) & reqFaint) === 0) &&
                (!o.upperReqNoDrain || !o.lazyUpperUsedDrain);
              const effCurU = curValid ? (o.lazyUpper ?? DEFAULT_UPPER) : DEFAULT_UPPER;
              if (effCurU > DEFAULT_LOWER + 1e-9) watchers[wWrite++] = w;
            }
          }
        }
        watchers.length = wWrite;
      }
    }

    if (canUpper) {
      const cand: JointWitness = {
        vec: source.jointVec,
        pp: source.jointPp,
        val: source.upper,
        depth: source.upperDepth,
        faintMask: source.upperFaintMask,
        usedDrain: source.upperUsedDrain,
      };
      const uw = group.upperWitnesses;
      let dominated = false;
      for (let i = 0; i < uw.length; i++) {
        if (jointUpperWitnessDominates(uw[i], cand, group)) {
          dominated = true;
          break;
        }
      }
      if (!dominated) {
        let write = 0;
        for (let i = 0; i < uw.length; i++) {
          if (!jointUpperWitnessDominates(cand, uw[i], group)) {
            uw[write++] = uw[i];
          }
        }
        uw.length = write;
        if (uw.length < MAX_JOINT_WITNESSES) {
          uw.push(cand);
        } else {
          let weakIdx = 0;
          for (let i = 1; i < uw.length; i++) {
            if (uw[i].val > uw[weakIdx].val + EPSILON ||
                (Math.abs(uw[i].val - uw[weakIdx].val) <= EPSILON && uw[i].depth > uw[weakIdx].depth)) {
              weakIdx = i;
            }
          }
          if (cand.val < uw[weakIdx].val - EPSILON ||
              (Math.abs(cand.val - uw[weakIdx].val) <= EPSILON && cand.depth < uw[weakIdx].depth)) {
            uw[weakIdx] = cand;
          }
        }

        const active = group.activeNodes;
        let aWrite = 0;
        for (let i = 0; i < active.length; i++) {
          const peer = active[i];
          if (peer !== source && peer !== this.rootNode && peer.upper > cand.val + EPSILON) {
            const outFaint = jointTransferUpperMask(cand, peer.jointVec!, peer.jointPp!, group);
            if (outFaint >= 0) {
              if (cand.val < peer.lower) {
                peer.upper = peer.lower;
                peer.upperDepth = Math.max(cand.depth, peer.lowerDepth);
              } else {
                peer.upper = cand.val;
                peer.upperDepth = cand.depth;
              }
              peer.upperFaintMask = outFaint;
              peer.upperUsedDrain = cand.usedDrain;
              this.stats.ppBoundUpdates++;
              enqueueParents(peer);
            }
          }
          if (peer.upper - peer.lower > 1e-9) {
            active[aWrite++] = peer;
          }
        }
        active.length = aWrite;

        const watchers = group.lazyWatchers;
        let wWrite = 0;
        for (let i = 0; i < watchers.length; i++) {
          const w = watchers[i];
          const o = w.outcome;
          if (w.kind === 0) {
            if (o.child || !o.lazySnapshot) continue;
            if ((o.lazyUpper ?? DEFAULT_UPPER) > cand.val + EPSILON) {
              const outFaint = jointTransferUpperMask(cand, w.vec, w.pp, group);
              if (outFaint >= 0) {
                const curL = o.lazyLower ?? DEFAULT_LOWER;
                if (cand.val < curL) {
                  o.lazyUpper = curL;
                  o.lazyUpperDepth = Math.max(cand.depth, o.lazyLowerDepth || 0);
                } else {
                  o.lazyUpper = cand.val;
                  o.lazyUpperDepth = cand.depth;
                }
                o.lazyUpperFaintMask = outFaint;
                o.lazyUpperUsedDrain = cand.usedDrain;
                this.stats.ppBoundUpdates++;
                enqueueNode(w.parent);
              }
            }
            if ((o.lazyUpper ?? DEFAULT_UPPER) - (o.lazyLower ?? DEFAULT_LOWER) > 1e-9) {
              watchers[wWrite++] = w;
            }
          } else if (w.kind === 2) {
            if (o.upperChild || !o.lazyUpperSnapshot) continue;
            const reqFaint = o.upperReqNoFaintMask || 0;
            const curValid = (o.lazyUpper ?? DEFAULT_UPPER) < DEFAULT_UPPER - EPSILON &&
              (reqFaint === 0 || ((o.lazyUpperFaintMask || 0) & reqFaint) === 0) &&
              (!o.upperReqNoDrain || !o.lazyUpperUsedDrain);
            let effCurU = curValid ? (o.lazyUpper ?? DEFAULT_UPPER) : DEFAULT_UPPER;
            if (effCurU > cand.val + EPSILON) {
              const outFaint = jointTransferUpperMask(cand, w.vec, w.pp, group);
              if (outFaint >= 0 &&
                  (reqFaint === 0 || (outFaint & reqFaint) === 0) &&
                  (!o.upperReqNoDrain || !cand.usedDrain)) {
                o.lazyUpper = cand.val;
                o.lazyUpperDepth = cand.depth;
                o.lazyUpperFaintMask = outFaint;
                o.lazyUpperUsedDrain = cand.usedDrain;
                effCurU = cand.val;
                this.stats.ppBoundUpdates++;
                enqueueNode(w.parent);
              }
            }
            if (effCurU > DEFAULT_LOWER + 1e-9) {
              watchers[wWrite++] = w;
            }
          } else {
            if (!o.child && o.lazyLowerSnapshot) {
              const reqFaint = o.lowerReqNoFaintMask || 0;
              const curValid = (o.lazyLower ?? DEFAULT_LOWER) > DEFAULT_LOWER + EPSILON &&
                (reqFaint === 0 || ((o.lazyLowerFaintMask || 0) & reqFaint) === 0) &&
                (!o.lowerReqNoDrain || !o.lazyLowerUsedDrain);
              const effCurL = curValid ? (o.lazyLower ?? DEFAULT_LOWER) : DEFAULT_LOWER;
              if (effCurL < DEFAULT_UPPER - 1e-9) watchers[wWrite++] = w;
            }
          }
        }
        watchers.length = wWrite;
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

    if (group.kind === 'nd') {
      const vec = source.monoVec!;
      if (lowerImproved) {
        const lf = group.lowerFrontierNd!;
        let dominated = false;
        for (let i = 0; i < lf.length; i++) {
          const f = lf[i];
          if (f.val >= source.lower - EPSILON && f.depth <= source.lowerDepth &&
              (f.faintMask & ~source.lowerFaintMask) === 0 && (!f.usedDrain || source.lowerUsedDrain) &&
              vecDominates(vec, f.vec)) {
            dominated = true;
            break;
          }
        }
        if (!dominated) {
          let write = 0;
          for (let i = 0; i < lf.length; i++) {
            const f = lf[i];
            if (!(f.val <= source.lower + EPSILON && f.depth >= source.lowerDepth &&
                  (source.lowerFaintMask & ~f.faintMask) === 0 && (!source.lowerUsedDrain || f.usedDrain) &&
                  vecDominates(f.vec, vec))) {
              lf[write++] = f;
            }
          }
          lf.length = write;
          if (lf.length < MAX_ND_FRONTIER) {
            lf.push({
              vec,
              val: source.lower,
              depth: source.lowerDepth,
              faintMask: source.lowerFaintMask,
              usedDrain: source.lowerUsedDrain,
            });
          }
          const list = group.nodes;
          for (let i = 0; i < list.length; i++) {
            const peer = list[i];
            if (peer === source || peer === this.rootNode) continue;
            if (peer.lower < source.lower - EPSILON && vecDominates(peer.monoVec!, vec)) {
              peer.lower = Math.min(peer.upper, source.lower);
              peer.lowerDepth = source.lowerDepth;
              peer.lowerFaintMask = source.lowerFaintMask;
              peer.lowerUsedDrain = source.lowerUsedDrain;
              this.stats.monotoneUpdates++;
              enqueueParents(peer, true, false);
            }
          }
        }
      }
      if (upperImproved) {
        const uf = group.upperFrontierNd!;
        let dominated = false;
        for (let i = 0; i < uf.length; i++) {
          const f = uf[i];
          if (f.val <= source.upper + EPSILON && f.depth <= source.upperDepth &&
              (f.faintMask & ~source.upperFaintMask) === 0 && (!f.usedDrain || source.upperUsedDrain) &&
              vecDominates(f.vec, vec)) {
            dominated = true;
            break;
          }
        }
        if (!dominated) {
          let write = 0;
          for (let i = 0; i < uf.length; i++) {
            const f = uf[i];
            if (!(f.val >= source.upper - EPSILON && f.depth >= source.upperDepth &&
                  (source.upperFaintMask & ~f.faintMask) === 0 && (!source.upperUsedDrain || f.usedDrain) &&
                  vecDominates(vec, f.vec))) {
              uf[write++] = f;
            }
          }
          uf.length = write;
          if (uf.length < MAX_ND_FRONTIER) {
            uf.push({
              vec,
              val: source.upper,
              depth: source.upperDepth,
              faintMask: source.upperFaintMask,
              usedDrain: source.upperUsedDrain,
            });
          }
          const list = group.nodes;
          for (let i = 0; i < list.length; i++) {
            const peer = list[i];
            if (peer === source || peer === this.rootNode) continue;
            if (peer.upper > source.upper + EPSILON && vecDominates(vec, peer.monoVec!)) {
              peer.upper = Math.max(peer.lower, source.upper);
              peer.upperDepth = source.upperDepth;
              peer.upperFaintMask = source.upperFaintMask;
              peer.upperUsedDrain = source.upperUsedDrain;
              this.stats.monotoneUpdates++;
              enqueueParents(peer, false, true);
            }
          }
        }
      }
      return;
    }

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
          peer.lowerFaintMask = source.lowerFaintMask;
          peer.lowerUsedDrain = source.lowerUsedDrain;
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
          peer.upperFaintMask = source.upperFaintMask;
          peer.upperUsedDrain = source.upperUsedDrain;
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
        if (f.h1 <= h1 && f.h2 >= h2 && f.val >= source.lower - EPSILON && f.depth <= source.lowerDepth &&
            (f.faintMask & ~source.lowerFaintMask) === 0 && (!f.usedDrain || source.lowerUsedDrain)) {
          dominated = true;
          break;
        }
      }
      if (!dominated) {
        group.lowerFrontier = group.lowerFrontier.filter(
          f => !(f.h1 >= h1 && f.h2 <= h2 && f.val <= source.lower + EPSILON && f.depth >= source.lowerDepth &&
                 (source.lowerFaintMask & ~f.faintMask) === 0 && (!source.lowerUsedDrain || f.usedDrain))
        );
        group.lowerFrontier.push({
          h1,
          h2,
          val: source.lower,
          depth: source.lowerDepth,
          faintMask: source.lowerFaintMask,
          usedDrain: source.lowerUsedDrain,
        });
        for (const peer of group.nodes) {
          if (peer === source || peer === this.rootNode) continue;
          if (peer.monoH1! >= h1 && peer.monoH2! <= h2 && peer.lower < source.lower - EPSILON) {
            peer.lower = Math.min(peer.upper, source.lower);
            peer.lowerDepth = source.lowerDepth;
            peer.lowerFaintMask = source.lowerFaintMask;
            peer.lowerUsedDrain = source.lowerUsedDrain;
            this.stats.monotoneUpdates++;
            enqueueParents(peer, true, false);
          }
        }
      }
    }
    if (upperImproved) {
      let dominated = false;
      for (const f of group.upperFrontier) {
        if (f.h1 >= h1 && f.h2 <= h2 && f.val <= source.upper + EPSILON && f.depth <= source.upperDepth &&
            (f.faintMask & ~source.upperFaintMask) === 0 && (!f.usedDrain || source.upperUsedDrain)) {
          dominated = true;
          break;
        }
      }
      if (!dominated) {
        group.upperFrontier = group.upperFrontier.filter(
          f => !(f.h1 <= h1 && f.h2 >= h2 && f.val >= source.upper - EPSILON && f.depth >= source.upperDepth &&
                 (source.upperFaintMask & ~f.faintMask) === 0 && (!source.upperUsedDrain || f.usedDrain))
        );
        group.upperFrontier.push({
          h1,
          h2,
          val: source.upper,
          depth: source.upperDepth,
          faintMask: source.upperFaintMask,
          usedDrain: source.upperUsedDrain,
        });
        for (const peer of group.nodes) {
          if (peer === source || peer === this.rootNode) continue;
          if (peer.monoH1! <= h1 && peer.monoH2! >= h2 && peer.upper > source.upper + EPSILON) {
            peer.upper = Math.max(peer.lower, source.upper);
            peer.upperDepth = source.upperDepth;
            peer.upperFaintMask = source.upperFaintMask;
            peer.upperUsedDrain = source.upperUsedDrain;
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
      if (!node.rowFloor) this._ensureAxisStats(node);
      const cells = node.cells;
      const m = cells.length;
      const n = cells[0].length;
      const isLargeMatrix = m * n > 25;

      if (!directionChosen) {
        const atUpperCeiling = root.upper >= DEFAULT_UPPER - EPSILON;
        const atLowerFloor = root.lower <= DEFAULT_LOWER + EPSILON;
        const rFloor = node.rowFloor!;
        const rOptFloor = node.rowOptFloor!;
        const rLowerSum = node.rowLowerSum!;
        const cCeil = node.colCeil!;
        const cOptCeil = node.colOptCeil!;
        const cUpperSum = node.colUpperSum!;
        if (atUpperCeiling && !atLowerFloor) {
          let incI = 0;
          for (let i = 1; i < m; i++) {
            if (rFloor[i] > rFloor[incI] + FRONTIER_TIE_EPSILON ||
                (Math.abs(rFloor[i] - rFloor[incI]) <= FRONTIER_TIE_EPSILON &&
                 rLowerSum[i] > rLowerSum[incI] + n * FRONTIER_TIE_EPSILON)) {
              incI = i;
            }
          }
          const optimisticFloor = rOptFloor[incI];
          if (optimisticFloor < root.upper - EPSILON) {
            if (isLargeMatrix && optimisticFloor - root.lower > Math.max(this.options.tolerance * 0.5, FRONTIER_TIE_EPSILON)) {
              lowerProof = true;
            } else if (isLargeMatrix) {
              let anotherCanClose = false;
              const target = root.upper - Math.max(this.options.tolerance, FRONTIER_TIE_EPSILON);
              for (let i = 0; i < m; i++) {
                if (i !== incI && rOptFloor[i] >= target) {
                  anotherCanClose = true;
                  break;
                }
              }
              lowerProof = anotherCanClose ? (this.proofTurn & 1) === 1 : false;
            } else {
              lowerProof = false;
            }
          } else if (this.proofTurn > 16) {
            let allExpanded = isLargeMatrix;
            if (!allExpanded) {
              allExpanded = true;
              const incRow = cells[incI];
              for (let j = 0; j < n; j++) {
                if (!incRow[j].outcomes) { allExpanded = false; break; }
              }
            }
            lowerProof = allExpanded ? (this.proofTurn & 3) !== 0 : true;
          } else {
            lowerProof = true;
          }
        } else if (atLowerFloor && !atUpperCeiling) {
          let incJ = 0;
          for (let j = 1; j < n; j++) {
            if (cCeil[j] < cCeil[incJ] - FRONTIER_TIE_EPSILON ||
                (Math.abs(cCeil[j] - cCeil[incJ]) <= FRONTIER_TIE_EPSILON &&
                 cUpperSum[j] < cUpperSum[incJ] - m * FRONTIER_TIE_EPSILON)) {
              incJ = j;
            }
          }
          const optimisticCeiling = cOptCeil[incJ];
          if (optimisticCeiling > root.lower + EPSILON) {
            if (isLargeMatrix && root.upper - optimisticCeiling > Math.max(this.options.tolerance * 0.5, FRONTIER_TIE_EPSILON)) {
              lowerProof = false;
            } else if (isLargeMatrix) {
              let anotherCanClose = false;
              const target = root.lower + Math.max(this.options.tolerance, FRONTIER_TIE_EPSILON);
              for (let j = 0; j < n; j++) {
                if (j !== incJ && cOptCeil[j] <= target) {
                  anotherCanClose = true;
                  break;
                }
              }
              lowerProof = anotherCanClose ? (this.proofTurn & 1) === 1 : true;
            } else {
              lowerProof = true;
            }
          } else if (this.proofTurn > 16) {
            let allExpanded = isLargeMatrix;
            if (!allExpanded) {
              allExpanded = true;
              for (let i = 0; i < m; i++) {
                if (!cells[i][incJ].outcomes) { allExpanded = false; break; }
              }
            }
            lowerProof = allExpanded ? (this.proofTurn & 3) === 0 : false;
          } else {
            lowerProof = false;
          }
        } else if (atUpperCeiling && atLowerFloor) {
          if (isLargeMatrix) {
            if (m >= 2 * n) lowerProof = (this.proofTurn & 3) !== 0;
            else if (n >= 2 * m) lowerProof = (this.proofTurn & 3) === 0;
            else lowerProof = m >= n ? (this.proofTurn & 1) === 0 : (this.proofTurn & 1) === 1;
          } else {
            let incI = 0;
            for (let i = 1; i < m; i++) {
              if (rFloor[i] > rFloor[incI] + FRONTIER_TIE_EPSILON ||
                  (Math.abs(rFloor[i] - rFloor[incI]) <= FRONTIER_TIE_EPSILON &&
                   rLowerSum[i] > rLowerSum[incI] + n * FRONTIER_TIE_EPSILON)) {
                incI = i;
              }
            }
            const optimisticFloor = rOptFloor[incI];
            if (optimisticFloor < root.upper - EPSILON) {
              lowerProof = false;
            } else if (this.proofTurn > 16) {
              let allExpanded = true;
              const incRow = cells[incI];
              for (let j = 0; j < n; j++) {
                if (!incRow[j].outcomes) { allExpanded = false; break; }
              }
              lowerProof = allExpanded ? (this.proofTurn & 1) === 1 : true;
            } else {
              lowerProof = true;
            }
          }
        } else {
          lowerProof = (this.proofTurn & 1) === 1;
        }
        directionChosen = true;
      }

      // Exact/tolerance-aware dual-optimality witness check for flat bounds
      const flatUpper = (node.upperSolution?.value ?? DEFAULT_UPPER) >= DEFAULT_UPPER - EPSILON;
      const flatLower = (node.lowerSolution?.value ?? DEFAULT_LOWER) <= DEFAULT_LOWER + EPSILON;
      let useLowerP1 = false;
      if (flatUpper && !flatLower && node.lowerSolution?.p1) {
        const lp1 = node.lowerSolution.p1;
        const supI: number[] = [];
        const supW: number[] = [];
        for (let i = 0; i < m; i++) {
          if (lp1[i] > 1e-15) {
            supI.push(i);
            supW.push(lp1[i]);
          }
        }
        let minOptEv = Infinity;
        for (let j = 0; j < n; j++) {
          let ev = 0;
          for (let k = 0; k < supI.length; k++) ev += supW[k] * cells[supI[k]][j].upper;
          if (ev < minOptEv) minOptEv = ev;
        }
        const upperVal = node.upperSolution?.value ?? DEFAULT_UPPER;
        const lowerVal = node.lowerSolution.value;
        const closeTarget = upperVal - Math.max(this.options.tolerance, EPSILON);
        const tightenFloor = lowerVal + Math.max(this.options.tolerance * 0.5, FRONTIER_TIE_EPSILON);
        useLowerP1 = minOptEv >= upperVal - EPSILON ||
          (isLargeMatrix && (minOptEv >= closeTarget || minOptEv > tightenFloor));
      }
      let useUpperP2 = false;
      if (flatLower && !flatUpper && node.upperSolution?.p2) {
        const up2 = node.upperSolution.p2;
        const supJ: number[] = [];
        const supW: number[] = [];
        for (let j = 0; j < n; j++) {
          if (up2[j] > 1e-15) {
            supJ.push(j);
            supW.push(up2[j]);
          }
        }
        let maxOptEv = -Infinity;
        for (let i = 0; i < m; i++) {
          const row = cells[i];
          let ev = 0;
          for (let k = 0; k < supJ.length; k++) ev += row[supJ[k]].lower * supW[k];
          if (ev > maxOptEv) maxOptEv = ev;
        }
        const lowerVal = node.lowerSolution?.value ?? DEFAULT_LOWER;
        const upperVal = node.upperSolution.value;
        const closeTarget = lowerVal + Math.max(this.options.tolerance, EPSILON);
        const tightenCeil = upperVal - Math.max(this.options.tolerance * 0.5, FRONTIER_TIE_EPSILON);
        useUpperP2 = maxOptEv <= lowerVal + EPSILON ||
          (isLargeMatrix && (maxOptEv <= closeTarget || maxOptEv < tightenCeil));
      }
      const rowStrategy = (useLowerP1 ? node.lowerSolution?.p1 : node.upperSolution?.p1) || [];
      const colStrategy = (useUpperP2 ? node.upperSolution?.p2 : node.lowerSolution?.p2) || [];

      const canExpandCell = (cell: BoundedCell) => {
        if (cell.upper - cell.lower <= 1e-9) return false;
        if (!cell.outcomes || cell.cursor) return true;
        const outs = cell.outcomes;
        for (let k = 0; k < outs.length; k++) {
          const outcome = outs[k];
          if (outcome.utility !== null) continue;
          if (outcome.split) {
            const loN = outcome.child;
            const hasLo = !!(loN || outcome.lazyLowerSnapshot);
            const loVal = loN ? loN.lower : (outcome.lazyLowerSnapshot ? (outcome.lazyLower ?? DEFAULT_LOWER) : DEFAULT_LOWER);
            const loFaint = loN ? loN.lowerFaintMask : (outcome.lazyLowerFaintMask || 0);
            const loDrain = loN ? loN.lowerUsedDrain : Boolean(outcome.lazyLowerUsedDrain);
            const loRF = outcome.lowerReqNoFaintMask || 0;
            const loV = !!(hasLo && loVal > DEFAULT_LOWER + EPSILON &&
              ((loRF !== 0 && (loFaint & loRF) !== 0) || (outcome.lowerReqNoDrain && loDrain)));

            const hiN = outcome.upperChild;
            const hasHi = !!(hiN || outcome.lazyUpperSnapshot);
            const hiVal = hiN ? hiN.upper : (outcome.lazyUpperSnapshot ? (outcome.lazyUpper ?? DEFAULT_UPPER) : DEFAULT_UPPER);
            const hiFaint = hiN ? hiN.upperFaintMask : (outcome.lazyUpperFaintMask || 0);
            const hiDrain = hiN ? hiN.upperUsedDrain : Boolean(outcome.lazyUpperUsedDrain);
            const hiRF = outcome.upperReqNoFaintMask || 0;
            const hiV = !!(hasHi && hiVal < DEFAULT_UPPER - EPSILON &&
              ((hiRF !== 0 && (hiFaint & hiRF) !== 0) || (outcome.upperReqNoDrain && hiDrain)));

            const lo = Math.max(hasLo && !loV ? loVal : DEFAULT_LOWER, outcome.validBoxLower ?? DEFAULT_LOWER);
            const hi = Math.min(hasHi && !hiV ? hiVal : DEFAULT_UPPER, outcome.validBoxUpper ?? DEFAULT_UPPER);
            if (hi - lo <= 1e-9) continue;
            if (!this.limitReached) return true;
            if (loN && !loV && loN.upper - loN.lower > 1e-9) return true;
            if (hiN && !hiV && hiN.upper - hiN.lower > 1e-9) return true;
            if (!loN && outcome.lazyLowerSnapshot && this.nodes.has(this._key(outcome.lazyLowerSnapshot))) return true;
            if (!hiN && outcome.lazyUpperSnapshot && this.nodes.has(this._key(outcome.lazyUpperSnapshot))) return true;
          } else if (outcome.child) {
            if (outcome.child.upper - outcome.child.lower > 1e-9) return true;
          } else if (outcome.lazySnapshot) {
            const gap = (outcome.lazyUpper ?? DEFAULT_UPPER) - (outcome.lazyLower ?? DEFAULT_LOWER);
            if (gap <= 1e-9) continue;
            if (!this.limitReached || this.nodes.has(this._key(outcome.lazySnapshot))) return true;
          }
        }
        return false;
      };

      const chooseJoint = () => {
        let selected: {i: number; j: number; cell: BoundedCell; score: number; gap: number} | null = null;
        // Fast path: scan only positive-support pairs O(|supp1| * |supp2|)
        const supR: number[] = [];
        const supC: number[] = [];
        for (let i = 0; i < m; i++) if ((rowStrategy[i] || 0) > 1e-15) supR.push(i);
        for (let j = 0; j < n; j++) if ((colStrategy[j] || 0) > 1e-15) supC.push(j);
        for (let ri = 0; ri < supR.length; ri++) {
          const i = supR[ri];
          const row = cells[i];
          const rw = rowStrategy[i];
          for (let cj = 0; cj < supC.length; cj++) {
            const j = supC[cj];
            const cell = row[j];
            if (!canExpandCell(cell)) continue;
            const gap = cell.upper - cell.lower;
            const score = rw * colStrategy[j] * gap;
            if (!selected || score > selected.score + EPSILON ||
                (Math.abs(score - selected.score) <= EPSILON && gap > selected.gap)) {
              selected = {i, j, cell, score, gap};
            }
          }
        }
        if (selected && selected.score > EPSILON) return selected;
        for (let i = 0; i < m; i++) {
          const row = cells[i];
          for (let j = 0; j < n; j++) {
            const cell = row[j];
            if (!canExpandCell(cell)) continue;
            const gap = cell.upper - cell.lower;
            if (!selected || gap > selected.gap) {
              selected = {i, j, cell, score: 0, gap};
            }
          }
        }
        return selected;
      };

      const chooseJointUnexpanded = (requirePositiveSupport = false) => {
        let selected: {i: number; j: number; cell: BoundedCell; score: number; gap: number} | null = null;
        const supR: number[] = [];
        const supC: number[] = [];
        for (let i = 0; i < m; i++) if ((rowStrategy[i] || 0) > 1e-15) supR.push(i);
        for (let j = 0; j < n; j++) if ((colStrategy[j] || 0) > 1e-15) supC.push(j);
        for (let ri = 0; ri < supR.length; ri++) {
          const i = supR[ri];
          const row = cells[i];
          const rw = rowStrategy[i];
          for (let cj = 0; cj < supC.length; cj++) {
            const j = supC[cj];
            const cell = row[j];
            if (cell.outcomes || cell.upper - cell.lower <= 1e-9) continue;
            const gap = cell.upper - cell.lower;
            const score = rw * colStrategy[j] * gap;
            if (!selected || score > selected.score + EPSILON ||
                (Math.abs(score - selected.score) <= EPSILON && gap > selected.gap)) {
              selected = {i, j, cell, score, gap};
            }
          }
        }
        if (requirePositiveSupport || (selected && selected.score > EPSILON)) return selected;
        for (let i = 0; i < m; i++) {
          const row = cells[i];
          for (let j = 0; j < n; j++) {
            const cell = row[j];
            if (!cell.outcomes && cell.upper - cell.lower > 1e-9) {
              const gap = cell.upper - cell.lower;
              if (!selected || gap > selected.gap + EPSILON) {
                selected = {i, j, cell, score: 0, gap};
              }
            }
          }
        }
        return selected;
      };

      let chosen: {i: number; j: number; cell: BoundedCell; score: number; gap: number} | null = null;
      let preferUnexpanded = false;
      let stepLowerProof = lowerProof;
      const mixedEps = isLargeMatrix ? 1e-3 : 1e-9;
      let nodePolicy = selectionPolicy;
      if (node !== root && isLargeMatrix && this.options.selectionPolicy === 'auto') {
        const bestPureR = node.bestPureRowFloor ?? DEFAULT_LOWER;
        const bestPureC = node.bestPureColCeil ?? DEFAULT_UPPER;
        const nodeMixed =
          node.lowerSolution.value > bestPureR + mixedEps ||
          node.upperSolution.value < bestPureC - mixedEps;
        nodePolicy = nodeMixed ? 'joint' : 'security';
      }
      if (nodePolicy === 'security') {
        const rowFloor = node.rowFloor!;
        const rowOptFloor = node.rowOptFloor!;
        const rowLowerSum = node.rowLowerSum!;
        const rowOpaqueProbes = node.rowOpaqueProbes!;
        const rowStallProbes = node.rowStallProbes;
        const colCeil = node.colCeil!;
        const colOptCeil = node.colOptCeil!;
        const colUpperSum = node.colUpperSum!;
        const colOpaqueProbes = node.colOpaqueProbes!;
        const colStallProbes = node.colStallProbes;
        // On large-matrix child nodes, adapt proof direction locally so the solver
        // can refute lost/won subgames instead of wasting budget proving an
        // impossible direction inherited from the root.
        if (node !== root && isLargeMatrix) {
          const vt = (node.localVisitTurn = (node.localVisitTurn || 0) + 1);
          const childFlatL = node.lower <= DEFAULT_LOWER + EPSILON;
          const childFlatU = node.upper >= DEFAULT_UPPER - EPSILON;
          if (childFlatL && childFlatU) {
            if (m >= 2 * n) stepLowerProof = (vt & 3) !== 0;
            else if (n >= 2 * m) stepLowerProof = (vt & 3) === 0;
            else stepLowerProof = (vt & 1) === 0 ? lowerProof : !lowerProof;
          } else if (childFlatL && !childFlatU) {
            stepLowerProof = (vt & 3) !== 0 ? false : lowerProof;
          } else if (!childFlatL && childFlatU) {
            stepLowerProof = (vt & 3) !== 0 ? true : lowerProof;
          }
        }
        const bestPureRowFloor = node.bestPureRowFloor ?? DEFAULT_LOWER;
        const bestPureColumnCeiling = node.bestPureColCeil ?? DEFAULT_UPPER;
        const localLowerMixedEps = isLargeMatrix && flatUpper ? Math.max(1e-3, this.options.tolerance * 0.5) : mixedEps;
        const localUpperMixedEps = isLargeMatrix && flatLower ? Math.max(1e-3, this.options.tolerance * 0.5) : mixedEps;
        const lowerMatrixIsMixed = node.lowerSolution.value > bestPureRowFloor + localLowerMixedEps;
        const upperMatrixIsMixed = node.upperSolution.value < bestPureColumnCeiling - localUpperMixedEps;
        const mixedImprovement = (stepLowerProof && lowerMatrixIsMixed) ||
          (!stepLowerProof && upperMatrixIsMixed);
        preferUnexpanded = mixedImprovement;

        if (!mixedImprovement && stepLowerProof) {
          let row = -1;
          let bestCanClose = -1;
          let bestRound = Infinity;
          const closeTarget = node.upper - Math.max(this.options.tolerance, FRONTIER_TIE_EPSILON);
          const tightenFloor = node.lower + Math.max(this.options.tolerance * 0.5, FRONTIER_TIE_EPSILON);
          const baseRowStallStep = Math.max(64, 2 * n);
          const provenRowStallStep = Math.max(64, 8 * n);
          for (let i = 0; i < m; i++) {
            if (rowOptFloor[i] <= node.lower + FRONTIER_TIE_EPSILON) continue;
            const canClose = isLargeMatrix
              ? (rowOptFloor[i] >= closeTarget || (rowFloor[i] > DEFAULT_LOWER + EPSILON && rowOptFloor[i] > tightenFloor) ? 1 : 0)
              : 0;
            const opaqueRound = isLargeMatrix && rowFloor[i] <= DEFAULT_LOWER + EPSILON && rowLowerSum[i] <= -n + EPSILON
              ? (rowOpaqueProbes![i] >>> 5)
              : 0;
            const rowStallStep = rowFloor[i] > DEFAULT_LOWER + EPSILON ? provenRowStallStep : baseRowStallStep;
            const stallRound = isLargeMatrix && rowStallProbes ? Math.floor(rowStallProbes[i] / rowStallStep) : 0;
            const round = opaqueRound + stallRound;
            if (row < 0 ||
                canClose > bestCanClose ||
                (canClose === bestCanClose && round < bestRound) ||
                (canClose === bestCanClose && round === bestRound &&
                 (rowFloor[i] > rowFloor[row] + FRONTIER_TIE_EPSILON ||
                  (Math.abs(rowFloor[i] - rowFloor[row]) <= FRONTIER_TIE_EPSILON &&
                   (rowLowerSum[i] > rowLowerSum[row] + n * FRONTIER_TIE_EPSILON ||
                    (isLargeMatrix &&
                     Math.abs(rowLowerSum[i] - rowLowerSum[row]) <= n * FRONTIER_TIE_EPSILON &&
                     rowOptFloor[i] > rowOptFloor[row] + FRONTIER_TIE_EPSILON)))))) {
              row = i;
              bestCanClose = canClose;
              bestRound = round;
            }
          }
          if (row < 0) {
            row = 0;
            for (let i = 1; i < m; i++) {
              if (rowFloor[i] > rowFloor[row] + FRONTIER_TIE_EPSILON ||
                  (Math.abs(rowFloor[i] - rowFloor[row]) <= FRONTIER_TIE_EPSILON &&
                   rowLowerSum[i] > rowLowerSum[row] + n * FRONTIER_TIE_EPSILON)) {
                row = i;
              }
            }
          }
          if (node === root && this.proofTurn > 16 && (this.proofTurn & 3) === 3) {
            const minBeating = Math.ceil(n / 2);
            let alt = -1;
            for (let i = 0; i < m; i++) {
              if (i === row) continue;
              if (rowOptFloor[i] <= node.lower + this.options.tolerance) continue;
              if (rowOptFloor[i] < rowOptFloor[row] - EPSILON) continue;
              if (rowOptFloor[i] - rowFloor[i] <= FRONTIER_TIE_EPSILON) continue;
              let beating = 0;
              const rCells = cells[i];
              for (let j = 0; j < n; j++) {
                if (rCells[j].lower > node.lower + FRONTIER_TIE_EPSILON) beating++;
              }
              if (beating < minBeating) continue;
              if (alt < 0 || rowLowerSum[i] > rowLowerSum[alt] + n * FRONTIER_TIE_EPSILON) alt = i;
            }
            if (alt >= 0) row = alt;
          }
          if (!isLargeMatrix && rowOptFloor[row] < DEFAULT_UPPER - EPSILON) {
            preferUnexpanded = true;
          }
          if (rowOptFloor[row] - rowFloor[row] > FRONTIER_TIE_EPSILON) {
            const rCells = cells[row];
            const boundTieEps = isLargeMatrix ? 1e-7 : FRONTIER_TIE_EPSILON;
            let bestJ = -1;
            let bestBound = Infinity;
            let bestCellRound = Infinity;
            let bestGap = -1;
            let bestDanger = -Infinity;
            for (let j = 0; j < n; j++) {
              const cell = rCells[j];
              if (!canExpandCell(cell)) continue;
              const gap = cell.upper - cell.lower;
              const bound = cell.lower;
              const cellRound = isLargeMatrix && cell.outcomes &&
                bound <= DEFAULT_LOWER + EPSILON && cell.upper >= DEFAULT_UPPER - EPSILON
                ? ((cell.probes || 0) >>> 4)
                : 0;
              const danger = -colUpperSum[j] / m;
              // On large matrices, when cell.lower ties, prefer smaller gap
              // (smaller upper bound) first to refute bad rows in 1-2 probes
              // instead of scanning all unrelated [-1, 1] columns first.
              const betterGap = isLargeMatrix ? (gap < bestGap - EPSILON) : (gap > bestGap + EPSILON);
              if (bestJ < 0 ||
                  bound < bestBound - boundTieEps ||
                  (Math.abs(bound - bestBound) <= boundTieEps &&
                   (cellRound < bestCellRound ||
                    (cellRound === bestCellRound &&
                     (betterGap ||
                      (Math.abs(gap - bestGap) <= EPSILON && danger > bestDanger + FRONTIER_TIE_EPSILON)))))) {
                bestJ = j;
                bestBound = bound;
                bestCellRound = cellRound;
                bestGap = gap;
                bestDanger = danger;
              }
            }
            if (bestJ >= 0) {
              chosen = {i: row, j: bestJ, cell: rCells[bestJ], gap: bestGap, score: bestGap};
            }
          }
        } else if (!mixedImprovement) {
          let column = -1;
          let bestCanClose = -1;
          let bestRound = Infinity;
          const closeTarget = node.lower + Math.max(this.options.tolerance, FRONTIER_TIE_EPSILON);
          const tightenCeil = node.upper - Math.max(this.options.tolerance * 0.5, FRONTIER_TIE_EPSILON);
          const baseColStallStep = Math.max(64, 2 * m);
          const provenColStallStep = Math.max(64, 8 * m);
          for (let j = 0; j < n; j++) {
            if (colOptCeil[j] >= node.upper - FRONTIER_TIE_EPSILON) continue;
            const canClose = isLargeMatrix
              ? (colOptCeil[j] <= closeTarget || (colCeil[j] < DEFAULT_UPPER - EPSILON && colOptCeil[j] < tightenCeil) ? 1 : 0)
              : 0;
            const opaqueRound = isLargeMatrix && colCeil[j] >= DEFAULT_UPPER - EPSILON && colUpperSum[j] >= m - EPSILON
              ? (colOpaqueProbes![j] >>> 5)
              : 0;
            const colStallStep = colCeil[j] < DEFAULT_UPPER - EPSILON ? provenColStallStep : baseColStallStep;
            const stallRound = isLargeMatrix && colStallProbes ? Math.floor(colStallProbes[j] / colStallStep) : 0;
            const round = opaqueRound + stallRound;
            if (column < 0 ||
                canClose > bestCanClose ||
                (canClose === bestCanClose && round < bestRound) ||
                (canClose === bestCanClose && round === bestRound &&
                 (colCeil[j] < colCeil[column] - FRONTIER_TIE_EPSILON ||
                  (Math.abs(colCeil[j] - colCeil[column]) <= FRONTIER_TIE_EPSILON &&
                   (colUpperSum[j] < colUpperSum[column] - m * FRONTIER_TIE_EPSILON ||
                    (isLargeMatrix &&
                     Math.abs(colUpperSum[j] - colUpperSum[column]) <= m * FRONTIER_TIE_EPSILON &&
                     colOptCeil[j] < colOptCeil[column] - FRONTIER_TIE_EPSILON)))))) {
              column = j;
              bestCanClose = canClose;
              bestRound = round;
            }
          }
          if (column < 0) {
            column = 0;
            for (let j = 1; j < n; j++) {
              if (colCeil[j] < colCeil[column] - FRONTIER_TIE_EPSILON ||
                  (Math.abs(colCeil[j] - colCeil[column]) <= FRONTIER_TIE_EPSILON &&
                   colUpperSum[j] < colUpperSum[column] - m * FRONTIER_TIE_EPSILON)) {
                column = j;
              }
            }
          }
          if (node === root && this.proofTurn > 16 && (this.proofTurn & 3) === 2) {
            const minBeating = Math.ceil(m / 2);
            let alt = -1;
            for (let j = 0; j < n; j++) {
              if (j === column) continue;
              if (colOptCeil[j] >= node.upper - this.options.tolerance) continue;
              if (colOptCeil[j] > colOptCeil[column] + EPSILON) continue;
              if (colCeil[j] - colOptCeil[j] <= FRONTIER_TIE_EPSILON) continue;
              let beating = 0;
              for (let i = 0; i < m; i++) {
                if (cells[i][j].upper < node.upper - FRONTIER_TIE_EPSILON) beating++;
              }
              if (beating < minBeating) continue;
              if (alt < 0 || colUpperSum[j] < colUpperSum[alt] - m * FRONTIER_TIE_EPSILON) alt = j;
            }
            if (alt >= 0) column = alt;
          }
          if (!isLargeMatrix && colOptCeil[column] > DEFAULT_LOWER + EPSILON) {
            preferUnexpanded = true;
          }
          if (colCeil[column] - colOptCeil[column] > FRONTIER_TIE_EPSILON) {
            const boundTieEps = isLargeMatrix ? 1e-7 : FRONTIER_TIE_EPSILON;
            let bestI = -1;
            let bestBound = -Infinity;
            let bestCellRound = Infinity;
            let bestGap = -1;
            let bestDanger = -Infinity;
            for (let i = 0; i < m; i++) {
              const cell = cells[i][column];
              if (!canExpandCell(cell)) continue;
              const gap = cell.upper - cell.lower;
              const bound = cell.upper;
              const cellRound = isLargeMatrix && cell.outcomes &&
                cell.lower <= DEFAULT_LOWER + EPSILON && bound >= DEFAULT_UPPER - EPSILON
                ? ((cell.probes || 0) >>> 4)
                : 0;
              const danger = rowLowerSum[i] / n;
              const betterGap = isLargeMatrix ? (gap < bestGap - EPSILON) : (gap > bestGap + EPSILON);
              if (bestI < 0 ||
                  bound > bestBound + boundTieEps ||
                  (Math.abs(bound - bestBound) <= boundTieEps &&
                   (cellRound < bestCellRound ||
                    (cellRound === bestCellRound &&
                     (betterGap ||
                      (Math.abs(gap - bestGap) <= EPSILON && danger > bestDanger + FRONTIER_TIE_EPSILON)))))) {
                bestI = i;
                bestBound = bound;
                bestCellRound = cellRound;
                bestGap = gap;
                bestDanger = danger;
              }
            }
            if (bestI >= 0) {
              chosen = {i: bestI, j: column, cell: cells[bestI][column], gap: bestGap, score: bestGap};
            }
          }
        }
        // If the selected security row/column is already resolved (or on small
        // matrices, when preferUnexpanded requests filling the matrix), fall
        // back to joint unexpanded/expanded frontier. On large matrices, only
        // override an expanded security choice with an unexpanded cell that has
        // strictly positive equilibrium support, avoiding full-matrix depth-1 scans.
        if (preferUnexpanded && (!chosen || chosen.cell.outcomes)) {
          const unexpanded = chooseJointUnexpanded(isLargeMatrix && !!chosen);
          if (unexpanded) chosen = unexpanded;
        }
        if (!chosen || chosen.gap <= 1e-9) chosen = chooseJoint();
      } else {
        chosen = chooseJointUnexpanded(isLargeMatrix) || chooseJoint();
        if (!chosen) chosen = chooseJointUnexpanded(false);
      }
      if (!chosen || chosen.gap <= 1e-9) return null;
      // If equilibrium support gives a zero score, the largest gap remains a
      // valid best-first fallback and preserves progress for degenerate games.
      if (chosen.score <= EPSILON) {
        for (let i = 0; i < m; i++) {
          const row = cells[i];
          for (let j = 0; j < n; j++) {
            const cell = row[j];
            if (canExpandCell(cell) && cell.upper - cell.lower > chosen.gap) {
              chosen = {i, j, cell, gap: cell.upper - cell.lower, score: 0};
            }
          }
        }
      }
      if (!chosen.cell.outcomes) return {node, i: chosen.i, j: chosen.j};
      if (isLargeMatrix && nodePolicy === 'security') {
        if (stepLowerProof && node.rowStallProbes) node.rowStallProbes[chosen.i]++;
        else if (!stepLowerProof && node.colStallProbes) node.colStallProbes[chosen.j]++;
      }
      // An outcome that still leaves the complete [-1, 1] interval carries
      // no directional information. On small matrices (<= 25 cells), spend one
      // transition on a sibling before descending; on large matrices (> 25 cells),
      // descend immediately so multi-turn KOs back up and refute bad rows/cols
      // without expanding thousands of Turn-1 siblings, tracking opaque probes
      // so progressive widening rotates away from stalled deep subtrees.
      const fullyUnknown = chosen.cell.outcomes &&
        chosen.cell.lower <= DEFAULT_LOWER + EPSILON &&
        chosen.cell.upper >= DEFAULT_UPPER - EPSILON;
      if (fullyUnknown) {
        if (!isLargeMatrix) {
          let sibling: {i: number; j: number; priority: number; score: number; gap: number} | null = null;
          const preferredAxis = nodePolicy === 'security' && stepLowerProof ? 'row' : 'column';
          for (let i = 0; i < m; i++) {
            const row = cells[i];
            const rw = rowStrategy[i] || 0;
            for (let j = 0; j < n; j++) {
              const cell = row[j];
              if (cell.outcomes || cell.upper - cell.lower <= 1e-9) continue;
              const priority = preferredAxis === 'row'
                ? (i === chosen.i ? 0 : j === chosen.j ? 1 : 2)
                : (j === chosen.j ? 0 : i === chosen.i ? 1 : 2);
              const score = rw * (colStrategy[j] || 0);
              const gap = cell.upper - cell.lower;
              if (!sibling || priority < sibling.priority ||
                  (priority === sibling.priority &&
                   (score > sibling.score + EPSILON ||
                    (Math.abs(score - sibling.score) <= EPSILON && gap > sibling.gap + EPSILON)))) {
                sibling = {i, j, priority, score, gap};
              }
            }
          }
          if (sibling) return {node, i: sibling.i, j: sibling.j};
        } else {
          chosen.cell.probes = (chosen.cell.probes || 0) + 1;
          if (chosen.cell.coords) {
            const coords = chosen.cell.coords;
            for (let c = 0; c < coords.length; c++) {
              if (coords[c].i === chosen.i && coords[c].j === chosen.j) {
                coords[c].probes++;
                break;
              }
            }
          }
          node.rowOpaqueProbes![chosen.i]++;
          node.colOpaqueProbes![chosen.j]++;
          if (path.size >= 6) {
            if (nodePolicy === 'security' && stepLowerProof) {
              const row = cells[chosen.i];
              for (let j = 0; j < n; j++) {
                if (!row[j].outcomes && row[j].upper - row[j].lower > 1e-9) {
                  return {node, i: chosen.i, j};
                }
              }
            } else {
              for (let i = 0; i < m; i++) {
                const c = cells[i][chosen.j];
                if (!c.outcomes && c.upper - c.lower > 1e-9) {
                  return {node, i, j: chosen.j};
                }
              }
            }
          }
        }
      }
      const preferLowerCorner = nodePolicy === 'security'
        ? stepLowerProof
        : ((this.monoCornerTurn++ & 1) === 0);
      const {child: next, splitOutcomeIndex, refreshOnly, maxSingleScore} = this._selectCellChild(
        node,
        chosen.cell.outcomes,
        path,
        preferLowerCorner,
        isLargeMatrix
      );
      if (refreshOnly) {
        return {node, refreshOnly: true};
      }
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
    parentNode: SearchNode,
    outcomes: BoundedOutcome[],
    path: Set<unknown>,
    preferLowerCorner: boolean,
    isLargeMatrix = false
  ): {child: SearchNode | null; splitOutcomeIndex?: number; refreshOnly?: boolean; maxSingleScore: number} {
    const skipTerminal = this.adapter === nativeAdapter;

    const refreshSiblingLazyOutcomes = () => {
      for (let k = 0; k < outcomes.length; k++) {
        const o = outcomes[k];
        if (o.utility !== null) continue;
        if (o.split) {
          if (!o.child && o.lazyLowerSnapshot) {
            const q = this._queryLazySnapshot(
              o.lazyLowerSnapshot,
              o.lowerReqNoFaintMask || 0,
              Boolean(o.lowerReqNoDrain),
              0,
              false
            );
            if (q.node) {
              this.stats.memoHits++;
              o.child = q.node;
              o.lazyLowerSnapshot = null;
              q.node.parents.add(parentNode);
            } else if (q.lower > (o.lazyLower ?? DEFAULT_LOWER) + EPSILON) {
              o.lazyLower = q.lower;
              o.lazyLowerDepth = q.lowerDepth;
              o.lazyLowerFaintMask = q.lowerFaintMask;
              o.lazyLowerUsedDrain = q.lowerUsedDrain;
            }
          }
          if (!o.upperChild && o.lazyUpperSnapshot) {
            const q = this._queryLazySnapshot(
              o.lazyUpperSnapshot,
              0,
              false,
              o.upperReqNoFaintMask || 0,
              Boolean(o.upperReqNoDrain)
            );
            if (q.node) {
              this.stats.memoHits++;
              o.upperChild = q.node;
              o.lazyUpperSnapshot = null;
              q.node.parents.add(parentNode);
            } else if (q.upper < (o.lazyUpper ?? DEFAULT_UPPER) - EPSILON) {
              o.lazyUpper = q.upper;
              o.lazyUpperDepth = q.upperDepth;
              o.lazyUpperFaintMask = q.upperFaintMask;
              o.lazyUpperUsedDrain = q.upperUsedDrain;
            }
          }
        } else if (!o.child && o.lazySnapshot) {
          const q = this._queryLazySnapshot(o.lazySnapshot);
          if (q.node) {
            this.stats.memoHits++;
            o.child = q.node;
            o.lazySnapshot = null;
            q.node.parents.add(parentNode);
          } else {
            if (q.lower > (o.lazyLower ?? DEFAULT_LOWER) + EPSILON) {
              o.lazyLower = Math.min(o.lazyUpper ?? DEFAULT_UPPER, q.lower);
              o.lazyLowerDepth = q.lowerDepth;
              o.lazyLowerFaintMask = q.lowerFaintMask;
              o.lazyLowerUsedDrain = q.lowerUsedDrain;
            }
            if (q.upper < (o.lazyUpper ?? DEFAULT_UPPER) - EPSILON) {
              o.lazyUpper = Math.max(o.lazyLower ?? DEFAULT_LOWER, q.upper);
              o.lazyUpperDepth = q.upperDepth;
              o.lazyUpperFaintMask = q.upperFaintMask;
              o.lazyUpperUsedDrain = q.upperUsedDrain;
            }
          }
        }
      }
    };

    const resolveLazyLeaf = (
      o: BoundedOutcome,
      maxScore: number,
      fallbackChild: SearchNode | null
    ): {child: SearchNode | null; refreshOnly?: boolean; maxSingleScore: number} => {
      const snap = o.lazySnapshot!;
      const q = this._queryLazySnapshot(snap);
      if (q.node) {
        this.stats.memoHits++;
        o.child = q.node;
        o.lazySnapshot = null;
        q.node.parents.add(parentNode);
        return {child: null, refreshOnly: true, maxSingleScore: maxScore};
      }
      if (q.lower > (o.lazyLower ?? DEFAULT_LOWER) + EPSILON ||
          q.upper < (o.lazyUpper ?? DEFAULT_UPPER) - EPSILON) {
        if (q.lower > (o.lazyLower ?? DEFAULT_LOWER) + EPSILON) {
          o.lazyLower = Math.min(o.lazyUpper ?? DEFAULT_UPPER, q.lower);
          o.lazyLowerDepth = q.lowerDepth;
          o.lazyLowerFaintMask = q.lowerFaintMask;
          o.lazyLowerUsedDrain = q.lowerUsedDrain;
        }
        if (q.upper < (o.lazyUpper ?? DEFAULT_UPPER) - EPSILON) {
          o.lazyUpper = Math.max(o.lazyLower ?? DEFAULT_LOWER, q.upper);
          o.lazyUpperDepth = q.upperDepth;
          o.lazyUpperFaintMask = q.upperFaintMask;
          o.lazyUpperUsedDrain = q.upperUsedDrain;
        }
        refreshSiblingLazyOutcomes();
        return {child: null, refreshOnly: true, maxSingleScore: maxScore};
      }
      const ch = this._intern(snap, skipTerminal);
      if (!ch) return {child: fallbackChild, maxSingleScore: maxScore};
      o.child = ch;
      o.lazySnapshot = null;
      ch.parents.add(parentNode);
      if (ch.upper - ch.lower <= 1e-9) {
        return {child: null, refreshOnly: true, maxSingleScore: maxScore};
      }
      return {child: ch, maxSingleScore: maxScore};
    };

    const preserveValidLazyBox = (box: BoundedOutcome, side: 'lower' | 'upper') => {
      if (side === 'lower') {
        const val = box.lazyLower ?? DEFAULT_LOWER;
        if (val > (box.validBoxLower ?? DEFAULT_LOWER) + EPSILON) {
          const rf = box.lowerReqNoFaintMask || 0;
          const f = box.lazyLowerFaintMask || 0;
          const d = Boolean(box.lazyLowerUsedDrain);
          if ((rf === 0 || (f & rf) === 0) && (!box.lowerReqNoDrain || !d)) {
            box.validBoxLower = val;
            box.validBoxLowerDepth = box.lazyLowerDepth || 0;
            box.validBoxLowerFaintMask = f;
            box.validBoxLowerUsedDrain = d;
          }
        }
      } else {
        const val = box.lazyUpper ?? DEFAULT_UPPER;
        if (val < (box.validBoxUpper ?? DEFAULT_UPPER) - EPSILON) {
          const rf = box.upperReqNoFaintMask || 0;
          const f = box.lazyUpperFaintMask || 0;
          const d = Boolean(box.lazyUpperUsedDrain);
          if ((rf === 0 || (f & rf) === 0) && (!box.upperReqNoDrain || !d)) {
            box.validBoxUpper = val;
            box.validBoxUpperDepth = box.lazyUpperDepth || 0;
            box.validBoxUpperFaintMask = f;
            box.validBoxUpperUsedDrain = d;
          }
        }
      }
    };

    const resolveBoxCorner = (
      box: BoundedOutcome,
      side: 'lower' | 'upper',
      maxScore: number
    ): {child: SearchNode | null; refreshOnly?: boolean; maxSingleScore: number} => {
      if (side === 'lower') {
        if (box.child) return {child: box.child, maxSingleScore: maxScore};
        const snap = box.lazyLowerSnapshot!;
        const q = this._queryLazySnapshot(
          snap,
          box.lowerReqNoFaintMask || 0,
          Boolean(box.lowerReqNoDrain),
          0,
          false
        );
        if (q.node) {
          preserveValidLazyBox(box, 'lower');
          this.stats.memoHits++;
          box.child = q.node;
          box.lazyLowerSnapshot = null;
          q.node.parents.add(parentNode);
          return {child: null, refreshOnly: true, maxSingleScore: maxScore};
        }
        if (q.lower > (box.lazyLower ?? DEFAULT_LOWER) + EPSILON) {
          box.lazyLower = q.lower;
          box.lazyLowerDepth = q.lowerDepth;
          box.lazyLowerFaintMask = q.lowerFaintMask;
          box.lazyLowerUsedDrain = q.lowerUsedDrain;
          refreshSiblingLazyOutcomes();
          return {child: null, refreshOnly: true, maxSingleScore: maxScore};
        }
        preserveValidLazyBox(box, 'lower');
        const ch = this._intern(snap, skipTerminal);
        if (!ch) return {child: null, maxSingleScore: maxScore};
        box.child = ch;
        box.lazyLowerSnapshot = null;
        ch.parents.add(parentNode);
        if (ch.upper - ch.lower <= 1e-9) {
          return {child: null, refreshOnly: true, maxSingleScore: maxScore};
        }
        return {child: ch, maxSingleScore: maxScore};
      }
      if (box.upperChild) return {child: box.upperChild, maxSingleScore: maxScore};
      const snap = box.lazyUpperSnapshot!;
      const q = this._queryLazySnapshot(
        snap,
        0,
        false,
        box.upperReqNoFaintMask || 0,
        Boolean(box.upperReqNoDrain)
      );
      if (q.node) {
        preserveValidLazyBox(box, 'upper');
        this.stats.memoHits++;
        box.upperChild = q.node;
        box.lazyUpperSnapshot = null;
        q.node.parents.add(parentNode);
        return {child: null, refreshOnly: true, maxSingleScore: maxScore};
      }
      if (q.upper < (box.lazyUpper ?? DEFAULT_UPPER) - EPSILON) {
        box.lazyUpper = q.upper;
        box.lazyUpperDepth = q.upperDepth;
        box.lazyUpperFaintMask = q.upperFaintMask;
        box.lazyUpperUsedDrain = q.upperUsedDrain;
        refreshSiblingLazyOutcomes();
        return {child: null, refreshOnly: true, maxSingleScore: maxScore};
      }
      preserveValidLazyBox(box, 'upper');
      const ch = this._intern(snap, skipTerminal);
      if (!ch) return {child: null, maxSingleScore: maxScore};
      box.upperChild = ch;
      box.lazyUpperSnapshot = null;
      ch.parents.add(parentNode);
      if (ch.upper - ch.lower <= 1e-9) {
        return {child: null, refreshOnly: true, maxSingleScore: maxScore};
      }
      return {child: ch, maxSingleScore: maxScore};
    };

    if (!this.adapter.monotoneSignature && !outcomes.some(o => !!o.split)) {
      let next: SearchNode | null = null;
      let nextScore = -1;
      let bestLazyIdx = -1;
      let bestLazyScore = -1;
      let anyTightened = false;
      for (let idx = 0; idx < outcomes.length; idx++) {
        const outcome = outcomes[idx];
        if (outcome.utility !== null) continue;
        if (!outcome.child && outcome.lazySnapshot) {
          const existing = this.nodes.get(this._key(outcome.lazySnapshot));
          if (existing) {
            this.stats.memoHits++;
            outcome.child = existing;
            outcome.lazySnapshot = null;
            existing.parents.add(parentNode);
            if (existing.lower > (outcome.lazyLower ?? DEFAULT_LOWER) + EPSILON ||
                existing.upper < (outcome.lazyUpper ?? DEFAULT_UPPER) - EPSILON) {
              anyTightened = true;
            }
          } else {
            const gap = (outcome.lazyUpper ?? DEFAULT_UPPER) - (outcome.lazyLower ?? DEFAULT_LOWER);
            if (gap <= 1e-9 || this.limitReached) continue;
            const score = outcome.probability * gap;
            if (score > bestLazyScore) {
              bestLazyIdx = idx;
              bestLazyScore = score;
            }
            continue;
          }
        }
        if (!outcome.child) continue;
        const gap = outcome.child.upper - outcome.child.lower;
        if (gap <= 1e-9 || path.has(outcome.child)) continue;
        const score = outcome.probability * gap;
        if (score > nextScore) {
          next = outcome.child;
          nextScore = score;
        }
      }
      const maxScore = Math.max(nextScore, bestLazyScore);
      if (anyTightened) return {child: null, refreshOnly: true, maxSingleScore: maxScore};
      if (bestLazyIdx >= 0 && bestLazyScore > nextScore + EPSILON) {
        return resolveLazyLeaf(outcomes[bestLazyIdx], maxScore, next);
      }
      return {child: next, maxSingleScore: maxScore};
    }

    let maxSingleScore = -1;
    let bestSingle: SearchNode | null = null;
    let bestSingleScore = -1;
    let bestLazyIdx = -1;
    let bestLazyScore = -1;
    let bestCornerBoxIdx = -1;
    let bestCornerBoxScore = -1;
    let bestOpaqueBoxIdx = -1;
    let bestOpaqueBoxScore = -1;
    let bestOpaqueProb = 0;
    let bestOpaqueIsViolated = false;
    let bestUntouchedConcreteProb = 0;
    let anyTightened = false;
    let groups: Map<MonotoneGroup, {score: number; members: {child: SearchNode; prob: number}[]}> | null = null;
    const parentB = isLargeMatrix
      ? (preferLowerCorner ? (parentNode.actions2?.length || 1) : (parentNode.actions1?.length || 1))
      : 1;
    const targetFaintBits = preferLowerCorner ? 0xfc0 : 0x3f;
    const effScore = (rawScore: number, ch: SearchNode | null | undefined, faintMask: number): number => {
      if (!isLargeMatrix) return rawScore;
      let estB = parentB;
      if (ch && ch.initialized) {
        estB = preferLowerCorner ? (ch.actions2?.length || 1) : (ch.actions1?.length || 1);
      } else if ((faintMask & targetFaintBits) !== 0) {
        estB = Math.max(4, Math.ceil(parentB / 8));
      }
      return rawScore / Math.sqrt(Math.max(1, estB));
    };

    for (let idx = 0; idx < outcomes.length; idx++) {
      const outcome = outcomes[idx];
      if (outcome.utility !== null) continue;
      if (outcome.split) {
        if (!outcome.child && outcome.lazyLowerSnapshot) {
          const existing = this.nodes.get(this._key(outcome.lazyLowerSnapshot));
          if (existing) {
            preserveValidLazyBox(outcome, 'lower');
            this.stats.memoHits++;
            outcome.child = existing;
            outcome.lazyLowerSnapshot = null;
            existing.parents.add(parentNode);
            const loRF0 = outcome.lowerReqNoFaintMask || 0;
            const exViolated = existing.lower > DEFAULT_LOWER + EPSILON &&
              ((loRF0 !== 0 && (existing.lowerFaintMask & loRF0) !== 0) ||
               (outcome.lowerReqNoDrain && existing.lowerUsedDrain));
            if (!exViolated && existing.lower > Math.max(outcome.lazyLower ?? DEFAULT_LOWER, outcome.validBoxLower ?? DEFAULT_LOWER) + EPSILON) {
              anyTightened = true;
            }
          }
        }
        if (!outcome.upperChild && outcome.lazyUpperSnapshot) {
          const existing = this.nodes.get(this._key(outcome.lazyUpperSnapshot));
          if (existing) {
            preserveValidLazyBox(outcome, 'upper');
            this.stats.memoHits++;
            outcome.upperChild = existing;
            outcome.lazyUpperSnapshot = null;
            existing.parents.add(parentNode);
            const hiRF0 = outcome.upperReqNoFaintMask || 0;
            const exViolated = existing.upper < DEFAULT_UPPER - EPSILON &&
              ((hiRF0 !== 0 && (existing.upperFaintMask & hiRF0) !== 0) ||
               (outcome.upperReqNoDrain && existing.upperUsedDrain));
            if (!exViolated && existing.upper < Math.min(outcome.lazyUpper ?? DEFAULT_UPPER, outcome.validBoxUpper ?? DEFAULT_UPPER) - EPSILON) {
              anyTightened = true;
            }
          }
        }
        const loNode = outcome.child;
        const hiNode = outcome.upperChild;
        const hasLo = !!(loNode || outcome.lazyLowerSnapshot);
        const hasHi = !!(hiNode || outcome.lazyUpperSnapshot);
        const loVal = loNode ? loNode.lower : (outcome.lazyLowerSnapshot ? (outcome.lazyLower ?? DEFAULT_LOWER) : DEFAULT_LOWER);
        const loFaint = loNode ? loNode.lowerFaintMask : (outcome.lazyLowerFaintMask || 0);
        const loDrain = loNode ? loNode.lowerUsedDrain : Boolean(outcome.lazyLowerUsedDrain);
        const loReqFaint = outcome.lowerReqNoFaintMask || 0;
        const loViolated = !!(
          hasLo &&
          loVal > DEFAULT_LOWER + EPSILON &&
          ((loReqFaint !== 0 && (loFaint & loReqFaint) !== 0) ||
           (outcome.lowerReqNoDrain && loDrain))
        );
        const hiVal = hiNode ? hiNode.upper : (outcome.lazyUpperSnapshot ? (outcome.lazyUpper ?? DEFAULT_UPPER) : DEFAULT_UPPER);
        const hiFaint = hiNode ? hiNode.upperFaintMask : (outcome.lazyUpperFaintMask || 0);
        const hiDrain = hiNode ? hiNode.upperUsedDrain : Boolean(outcome.lazyUpperUsedDrain);
        const hiReqFaint = outcome.upperReqNoFaintMask || 0;
        const hiViolated = !!(
          hasHi &&
          hiVal < DEFAULT_UPPER - EPSILON &&
          ((hiReqFaint !== 0 && (hiFaint & hiReqFaint) !== 0) ||
           (outcome.upperReqNoDrain && hiDrain))
        );
        const lo = Math.max(hasLo && !loViolated ? loVal : DEFAULT_LOWER, outcome.validBoxLower ?? DEFAULT_LOWER);
        const hi = Math.min(hasHi && !hiViolated ? hiVal : DEFAULT_UPPER, outcome.validBoxUpper ?? DEFAULT_UPPER);
        const boxGap = hi - lo;
        if (boxGap <= 1e-9) continue;
        const rawScore = outcome.probability * boxGap;
        if (rawScore > maxSingleScore) maxSingleScore = rawScore;
        const refCh = preferLowerCorner ? (loNode || hiNode) : (hiNode || loNode);
        const score = effScore(rawScore, refCh, outcome.faintMask || 0);
        const loCanDescend = !loViolated && (
          loNode
            ? (!path.has(loNode) && loNode.upper - loNode.lower > 1e-9)
            : (!!outcome.lazyLowerSnapshot && !this.limitReached)
        );
        const hiCanDescend = !hiViolated && (
          hiNode
            ? (!path.has(hiNode) && hiNode.upper - hiNode.lower > 1e-9)
            : (!!outcome.lazyUpperSnapshot && !this.limitReached)
        );
        if (!loCanDescend && !hiCanDescend && this.limitReached) continue;
        if ((hasLo && !loViolated) || (hasHi && !hiViolated)) {
          if (score > bestCornerBoxScore + EPSILON) {
            bestCornerBoxScore = score;
            bestCornerBoxIdx = idx;
          }
          if ((loCanDescend || hiCanDescend) && boxGap >= 1.99 - EPSILON && outcome.probability > bestUntouchedConcreteProb) {
            bestUntouchedConcreteProb = outcome.probability;
          }
        } else {
          if (score > bestOpaqueBoxScore + EPSILON) {
            bestOpaqueBoxScore = score;
            bestOpaqueBoxIdx = idx;
            bestOpaqueProb = outcome.probability;
            bestOpaqueIsViolated = loViolated || hiViolated;
          }
        }
        continue;
      }
      if (!outcome.child && outcome.lazySnapshot) {
        const existing = this.nodes.get(this._key(outcome.lazySnapshot));
        if (existing) {
          this.stats.memoHits++;
          outcome.child = existing;
          outcome.lazySnapshot = null;
          existing.parents.add(parentNode);
          if (existing.lower > (outcome.lazyLower ?? DEFAULT_LOWER) + EPSILON ||
              existing.upper < (outcome.lazyUpper ?? DEFAULT_UPPER) - EPSILON) {
            anyTightened = true;
          }
        } else {
          const gap = (outcome.lazyUpper ?? DEFAULT_UPPER) - (outcome.lazyLower ?? DEFAULT_LOWER);
          if (gap <= 1e-9) continue;
          const rawScore = outcome.probability * gap;
          if (rawScore > maxSingleScore) maxSingleScore = rawScore;
          if (this.limitReached) continue;
          if (gap >= 1.99 - EPSILON && outcome.probability > bestUntouchedConcreteProb) {
            bestUntouchedConcreteProb = outcome.probability;
          }
          const score = effScore(rawScore, null, outcome.faintMask || 0);
          if (score > bestLazyScore + EPSILON) {
            bestLazyIdx = idx;
            bestLazyScore = score;
          }
          continue;
        }
      }
      const child = outcome.child;
      if (!child) continue;
      const gap = child.upper - child.lower;
      if (gap <= 1e-9) continue;
      const rawScore = outcome.probability * gap;
      if (rawScore > maxSingleScore) maxSingleScore = rawScore;
      if (path.has(child)) continue;
      if (gap >= 1.99 - EPSILON && outcome.probability > bestUntouchedConcreteProb) {
        bestUntouchedConcreteProb = outcome.probability;
      }
      const score = effScore(rawScore, child, outcome.faintMask || 0);

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

    if (anyTightened) {
      return {child: null, refreshOnly: true, maxSingleScore};
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
    const bestConcreteScore = Math.max(bestCornerBoxScore, bestGroupScore, bestSingleScore, bestLazyScore);
    // On large matrices, avoid breadth-first shattering of null-corner non-monotone
    // boxes: if freshly peeled concrete/cornered outcomes are still untouched ([-1, 1])
    // and carry non-negligible mass relative to the remainder box, descend first.
    // Never defer splitting a witness-violated box whose corner cannot tighten further.
    const deferOpaqueSplit = isLargeMatrix && !bestOpaqueIsViolated && bestConcreteScore > 0 &&
      bestUntouchedConcreteProb >= bestOpaqueProb * 0.002;
    if (bestOpaqueBoxIdx >= 0 && !deferOpaqueSplit &&
        bestOpaqueBoxScore >= bestConcreteScore - EPSILON && !this.limitReached) {
      return {child: null, splitOutcomeIndex: bestOpaqueBoxIdx, maxSingleScore};
    }

    if (bestCornerBoxIdx >= 0 &&
        bestCornerBoxScore >= bestGroupScore - EPSILON &&
        bestCornerBoxScore >= bestSingleScore - EPSILON &&
        bestCornerBoxScore >= bestLazyScore - EPSILON) {
      const box = outcomes[bestCornerBoxIdx];
      const loNode = box.child;
      const hiNode = box.upperChild;
      const hasLo = !!(loNode || box.lazyLowerSnapshot);
      const hasHi = !!(hiNode || box.lazyUpperSnapshot);
      const loVal = loNode ? loNode.lower : (box.lazyLowerSnapshot ? (box.lazyLower ?? DEFAULT_LOWER) : DEFAULT_LOWER);
      const loFaint = loNode ? loNode.lowerFaintMask : (box.lazyLowerFaintMask || 0);
      const loDrain = loNode ? loNode.lowerUsedDrain : Boolean(box.lazyLowerUsedDrain);
      const loReqFaint = box.lowerReqNoFaintMask || 0;
      const loViolated = !!(
        hasLo &&
        loVal > DEFAULT_LOWER + EPSILON &&
        ((loReqFaint !== 0 && (loFaint & loReqFaint) !== 0) ||
         (box.lowerReqNoDrain && loDrain))
      );
      const hiVal = hiNode ? hiNode.upper : (box.lazyUpperSnapshot ? (box.lazyUpper ?? DEFAULT_UPPER) : DEFAULT_UPPER);
      const hiFaint = hiNode ? hiNode.upperFaintMask : (box.lazyUpperFaintMask || 0);
      const hiDrain = hiNode ? hiNode.upperUsedDrain : Boolean(box.lazyUpperUsedDrain);
      const hiReqFaint = box.upperReqNoFaintMask || 0;
      const hiViolated = !!(
        hasHi &&
        hiVal < DEFAULT_UPPER - EPSILON &&
        ((hiReqFaint !== 0 && (hiFaint & hiReqFaint) !== 0) ||
         (box.upperReqNoDrain && hiDrain))
      );
      if (!this.limitReached && ((preferLowerCorner && loViolated) || (!preferLowerCorner && hiViolated))) {
        return {child: null, splitOutcomeIndex: bestCornerBoxIdx, maxSingleScore};
      }
      const loGap = !loViolated
        ? (loNode
          ? (!path.has(loNode) ? loNode.upper - loNode.lower : 0)
          : (box.lazyLowerSnapshot && !this.limitReached ? Math.max(0, DEFAULT_UPPER - loVal) : 0))
        : 0;
      const hiGap = !hiViolated
        ? (hiNode
          ? (!path.has(hiNode) ? hiNode.upper - hiNode.lower : 0)
          : (box.lazyUpperSnapshot && !this.limitReached ? Math.max(0, hiVal - DEFAULT_LOWER) : 0))
        : 0;
      const spreadGap = loNode && !loViolated && hiNode && !hiViolated
        ? Math.max(0, hiNode.lower - loNode.upper)
        : 0;
      if (preferLowerCorner && loGap > 1e-9 && loGap >= spreadGap) {
        return resolveBoxCorner(box, 'lower', maxSingleScore);
      }
      if (!preferLowerCorner && hiGap > 1e-9 && hiGap >= spreadGap) {
        return resolveBoxCorner(box, 'upper', maxSingleScore);
      }
      if (loGap > 1e-9 && loGap >= spreadGap) {
        return resolveBoxCorner(box, 'lower', maxSingleScore);
      }
      if (hiGap > 1e-9 && hiGap >= spreadGap) {
        return resolveBoxCorner(box, 'upper', maxSingleScore);
      }
      if (!this.limitReached) {
        return {child: null, splitOutcomeIndex: bestCornerBoxIdx, maxSingleScore};
      }
      if (loGap > 1e-9) return resolveBoxCorner(box, 'lower', maxSingleScore);
      if (hiGap > 1e-9) return resolveBoxCorner(box, 'upper', maxSingleScore);
      return {child: null, maxSingleScore};
    }

    if (bestLazyIdx >= 0 &&
        bestLazyScore >= bestGroupScore - EPSILON &&
        bestLazyScore >= bestSingleScore - EPSILON) {
      return resolveLazyLeaf(outcomes[bestLazyIdx], maxSingleScore, bestSingle);
    }

    if (!bestGroupEntry || bestSingleScore > bestGroupEntry.score + EPSILON) {
      if (bestSingle) return {child: bestSingle, maxSingleScore};
      if (bestLazyIdx >= 0) return resolveLazyLeaf(outcomes[bestLazyIdx], maxSingleScore, null);
      if (bestOpaqueBoxIdx >= 0 && !this.limitReached) {
        return {child: null, splitOutcomeIndex: bestOpaqueBoxIdx, maxSingleScore};
      }
      return {child: null, maxSingleScore};
    }

    const members = bestGroupEntry.members;
    if (members.length === 1) {
      return {child: members[0].child, maxSingleScore};
    }

    if (bestGroup!.kind === 'nd') {
      const candidates: SearchNode[] = [];
      for (let i = 0; i < members.length; i++) {
        const c = members[i].child;
        const cv = c.monoVec!;
        let dominated = false;
        if (preferLowerCorner) {
          const cu = c.upper;
          for (let j = 0; j < candidates.length; j++) {
            const cand = candidates[j];
            if (cand.upper >= cu - EPSILON && vecDominates(cv, cand.monoVec!)) {
              dominated = true;
              break;
            }
          }
        } else {
          const cl = c.lower;
          for (let j = 0; j < candidates.length; j++) {
            const cand = candidates[j];
            if (cand.lower <= cl + EPSILON && vecDominates(cand.monoVec!, cv)) {
              dominated = true;
              break;
            }
          }
        }
        if (!dominated) candidates.push(c);
      }
      if (candidates.length === 1) {
        return {child: candidates[0], maxSingleScore};
      }
      let bestChild = candidates[0];
      let bestGain = -1;
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        const cv = c.monoVec!;
        let gain = 0;
        if (preferLowerCorner) {
          const cu = c.upper;
          for (let j = 0; j < members.length; j++) {
            const p = members[j].child;
            if (vecDominates(p.monoVec!, cv)) {
              const d = cu - p.lower;
              if (d > 0) gain += members[j].prob * d;
            }
          }
        } else {
          const cl = c.lower;
          for (let j = 0; j < members.length; j++) {
            const p = members[j].child;
            if (vecDominates(cv, p.monoVec!)) {
              const d = p.upper - cl;
              if (d > 0) gain += members[j].prob * d;
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
    const skipTerminal = this.adapter === nativeAdapter;
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
          if (cell.outcomes && cell.upper - cell.lower > 1e-9) {
            for (let k = 0; k < cell.outcomes.length; k++) {
              const o = cell.outcomes[k];
              if (o.utility !== null) continue;
              if (o.split) {
                const loN = o.child;
                const hasLo = !!(loN || o.lazyLowerSnapshot);
                const loVal = loN ? loN.lower : (o.lazyLowerSnapshot ? (o.lazyLower ?? DEFAULT_LOWER) : DEFAULT_LOWER);
                const loFaint = loN ? loN.lowerFaintMask : (o.lazyLowerFaintMask || 0);
                const loDrain = loN ? loN.lowerUsedDrain : Boolean(o.lazyLowerUsedDrain);
                const loRF = o.lowerReqNoFaintMask || 0;
                const loV = !!(hasLo && loVal > DEFAULT_LOWER + EPSILON &&
                  ((loRF !== 0 && (loFaint & loRF) !== 0) || (o.lowerReqNoDrain && loDrain)));
                const hiN = o.upperChild;
                const hasHi = !!(hiN || o.lazyUpperSnapshot);
                const hiVal = hiN ? hiN.upper : (o.lazyUpperSnapshot ? (o.lazyUpper ?? DEFAULT_UPPER) : DEFAULT_UPPER);
                const hiFaint = hiN ? hiN.upperFaintMask : (o.lazyUpperFaintMask || 0);
                const hiDrain = hiN ? hiN.upperUsedDrain : Boolean(o.lazyUpperUsedDrain);
                const hiRF = o.upperReqNoFaintMask || 0;
                const hiV = !!(hasHi && hiVal < DEFAULT_UPPER - EPSILON &&
                  ((hiRF !== 0 && (hiFaint & hiRF) !== 0) || (o.upperReqNoDrain && hiDrain)));
                const lo = hasLo && !loV ? loVal : DEFAULT_LOWER;
                const hi = hasHi && !hiV ? hiVal : DEFAULT_UPPER;
                if (hi - lo <= 1e-9) continue;
                if (!loN && o.lazyLowerSnapshot && !loV) {
                  const existing = this.nodes.get(this._key(o.lazyLowerSnapshot));
                  if (existing) {
                    this.stats.memoHits++;
                    o.child = existing;
                    o.lazyLowerSnapshot = null;
                    existing.parents.add(node);
                    return {node, refreshOnly: true};
                  }
                  if (!this.limitReached) {
                    const ch = this._intern(o.lazyLowerSnapshot, skipTerminal);
                    if (ch) {
                      o.child = ch;
                      o.lazyLowerSnapshot = null;
                      ch.parents.add(node);
                      return ch.initialized ? {node, refreshOnly: true} : {node: ch, initialize: true};
                    }
                  }
                }
                if (!hiN && o.lazyUpperSnapshot && !hiV) {
                  const existing = this.nodes.get(this._key(o.lazyUpperSnapshot));
                  if (existing) {
                    this.stats.memoHits++;
                    o.upperChild = existing;
                    o.lazyUpperSnapshot = null;
                    existing.parents.add(node);
                    return {node, refreshOnly: true};
                  }
                  if (!this.limitReached) {
                    const ch = this._intern(o.lazyUpperSnapshot, skipTerminal);
                    if (ch) {
                      o.upperChild = ch;
                      o.lazyUpperSnapshot = null;
                      ch.parents.add(node);
                      return ch.initialized ? {node, refreshOnly: true} : {node: ch, initialize: true};
                    }
                  }
                }
                if (!this.limitReached) return {node, i, j, splitOutcomeIndex: k};
              } else if (!o.child && o.lazySnapshot) {
                const gap = (o.lazyUpper ?? DEFAULT_UPPER) - (o.lazyLower ?? DEFAULT_LOWER);
                if (gap <= 1e-9) continue;
                const existing = this.nodes.get(this._key(o.lazySnapshot));
                if (existing) {
                  this.stats.memoHits++;
                  o.child = existing;
                  o.lazySnapshot = null;
                  existing.parents.add(node);
                  return {node, refreshOnly: true};
                }
                if (!this.limitReached) {
                  const ch = this._intern(o.lazySnapshot, skipTerminal);
                  if (ch) {
                    o.child = ch;
                    o.lazySnapshot = null;
                    ch.parents.add(node);
                    return ch.initialized ? {node, refreshOnly: true} : {node: ch, initialize: true};
                  }
                }
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
