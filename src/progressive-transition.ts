import type {Action, Outcome, Snapshot, TransitionOptions} from './types';
import {BranchingPRNG} from './branching-prng';
import {installSimulatorOptimizations} from './simulator-optimizations';
import {restoreBattle, snapshotBattle, stateKey, terminalUtility} from './showdown-adapter';

export interface TransitionProgress {
  /** Cumulative completed probability, never normalized independently. */
  outcomes: Outcome[];
  remainingProbability: number;
  complete: boolean;
  simulatorRuns: number;
}
export interface TransitionCursor {
  advance(options: {maxRuns: number; deadline: number}): TransitionProgress;
}

interface Branch {
  decisions: ConstructorParameters<typeof BranchingPRNG>[0];
  probability: number;
}

/** Max heap over disjoint random prefixes; no probability threshold is used. */
class PendingBranches {
  branches: Branch[] = [];

  push(branch: Branch) {
    const heap = this.branches;
    let index = heap.length;
    heap.push(branch);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (heap[parent].probability >= branch.probability) break;
      heap[index] = heap[parent];
      index = parent;
    }
    heap[index] = branch;
  }

  pop(): Branch {
    const heap = this.branches;
    const first = heap[0];
    const last = heap.pop();
    if (heap.length) {
      let index = 0;
      while (2 * index + 1 < heap.length) {
        let child = 2 * index + 1;
        if (child + 1 < heap.length && heap[child + 1].probability > heap[child].probability) child++;
        if (heap[child].probability <= last.probability) break;
        heap[index] = heap[child];
        index = child;
      }
      heap[index] = last;
    }
    return first;
  }
}

class SliceExpired extends Error {}

/**
 * Replay whole turns from probability-prioritized prefixes. This does not
 * serialize or merge mid-turn simulator execution. Exact enumerateTurn and
 * its PP templates remain independent of this bounded-only cursor.
 */
export function createTurnCursor(
  snapshot: Snapshot,
  p1: Pick<Action, 'command'>,
  p2: Pick<Action, 'command'>,
  options: TransitionOptions = {}
): TransitionCursor {
  const pending = new PendingBranches();
  pending.push({decisions: [], probability: 1});
  const outcomes = new Map<string, Outcome>();
  const keyOf = options.outcomeKey ?? stateKey;
  let completedProbability = 0;
  let totalRuns = 0;
  return {
    advance({maxRuns, deadline}) {
      if (!Number.isInteger(maxRuns) || maxRuns < 1) throw new RangeError('maxRuns must be positive');
      let runs = 0;
      while (pending.branches.length && runs < maxRuns && performance.now() < deadline) {
        if (totalRuns >= (options.maxSimulatorRunsPerTransition ?? 100000)) {
          throw new Error(`Random branch limit (${options.maxSimulatorRunsPerTransition ?? 100000}) exceeded`);
        }
        const branch = pending.pop();
        const battle = restoreBattle(snapshot);
        installSimulatorOptimizations(battle, {eventPlan: options.eventPlan || null});
        const prng = new BranchingPRNG(branch.decisions, 0, (alternatives, source) => {
          if (performance.now() >= deadline) throw new SliceExpired();
          let selected = alternatives[0];
          for (const alternative of alternatives) {
            if (alternative.probability > selected.probability) selected = alternative;
          }
          for (const alternative of alternatives) {
            if (alternative === selected || alternative.probability === 0) continue;
            pending.push({
              decisions: [...source.decisions, alternative.decision],
              probability: branch.probability * alternative.probability,
            });
          }
          branch.probability *= selected.probability;
          return selected;
        });
        battle.prng = prng as any;
        runs++;
        totalRuns++;
        try {
          battle.makeChoices(p1.command, p2.command);
        } catch (error) {
          if (!(error instanceof SliceExpired)) throw error;
          // The prefix already includes every selected decision, and its
          // mass excludes siblings enqueued at those decisions. Replay this
          // residual branch later; returning its original mass would overlap.
          pending.push(branch);
          break;
        }
        if (prng.cursor !== prng.decisions.length) throw new Error('Random replay did not consume its full prefix');
        const utility = terminalUtility(battle);
        const next = utility === null ? snapshotBattle(battle) : null;
        const key = next ? keyOf(next) : `terminal:${utility}`;
        const existing = outcomes.get(key);
        if (existing) existing.probability += branch.probability;
        else outcomes.set(key, next ? {snapshot: next, probability: branch.probability}
          : {utility, probability: branch.probability});
        completedProbability += branch.probability;
      }
      const complete = pending.branches.length === 0;
      if (complete && Math.abs(completedProbability - 1) > 1e-9) {
        throw new Error(`Transition probabilities sum to ${completedProbability}, not 1`);
      }
      return {
        outcomes: [...outcomes.values()].map(outcome => ({...outcome})),
        remainingProbability: complete ? 0 : Math.max(0, 1 - completedProbability),
        complete,
        simulatorRuns: runs,
      };
    },
  };
}
