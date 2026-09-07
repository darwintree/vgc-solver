import type {Battle} from '@pkmn/sim';
import type {createEventPlan} from './event-plan';
import type {PPTransitionCache} from './pp-transition-cache';
import type {TransitionPool} from './transition-pool';

// The pinned simulator exposes serialized state as an open object graph.
export type Snapshot = ReturnType<Battle['toJSON']>;
export type StateKey = ((snapshot: Snapshot) => string) & {private?: boolean};
export interface Action {
  name: string;
  id: string;
  command: string;
}
export interface StrategyEntry {
  action: string;
  probability: number;
}
export interface MatrixSolution {
  value: number;
  p1: number[];
  p2: number[];
}
export interface ExactSolution {
  value: number;
  terminal: boolean;
  p1Strategy?: StrategyEntry[];
  p2Strategy?: StrategyEntry[];
  payoffMatrix?: number[][];
}
export interface SolverOptions {
  maxStates?: number;
  maxSimulatorRunsPerTransition?: number;
}
export interface WorkerOptions {
  pool?: TransitionPool;
  workerCount?: number;
  batchSize?: number;
}
export interface TransitionOptions {
  maxSimulatorRunsPerTransition?: number;
  /** Absolute performance.now() deadline for cooperative bounded cancellation. */
  deadline?: number;
  outcomeKey?: StateKey;
  ppCache?: PPTransitionCache;
  ppAudit?: symbol;
  eventPlan?: ReturnType<typeof createEventPlan>;
}
export interface WorkerTransitionOptions extends TransitionOptions {
  outcomeKeyMode?: 'private';
  workerRoute?: number;
}
export type Outcome = {probability: number} & (
  {snapshot: Snapshot; utility?: never} | {utility: number; snapshot?: never}
);
export interface Transition {
  outcomes: Outcome[];
  simulatorRuns: number;
  cacheHits?: number;
  /** False means the transition was abandoned before a complete distribution existed. */
  complete?: boolean;
}
export interface ExactCell {
  outcomes: Outcome[];
  values: (number | undefined)[];
  childKeys: (string | undefined)[];
  exact: boolean;
  value: number | null;
  unresolvedCount: number;
}
