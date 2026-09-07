import type {PRNG} from '@pkmn/sim';
import type {Action, Snapshot} from '../../src/types';
import assert from 'node:assert/strict';
import {BranchingPRNG, NeedRandom} from '../../src/branching-prng';
import {
  restoreBattle,
  snapshotBattle,
  stateKey,
  terminalUtility,
} from '../../src/showdown-adapter';

interface DistributionOutcome {
  snapshot?: Snapshot | null;
  utility?: number | null;
  probability: number;
}

/** Enumerate with the pre-optimization throw-and-replay driver. */
function enumerateNative(snapshot: Snapshot, p1Action: Pick<Action, 'command'>, p2Action: Pick<Action, 'command'>) {
  const pending = [{decisions: [], probability: 1}];
  const outcomes = new Map<string, DistributionOutcome>();
  let simulatorRuns = 0;
  while (pending.length) {
    const branch = pending.pop();
    const battle = restoreBattle(snapshot);
    const prng = new BranchingPRNG(branch.decisions);
    battle.prng = prng as unknown as PRNG;
    try {
      simulatorRuns++;
      battle.makeChoices(p1Action.command, p2Action.command);
      assert.equal(prng.cursor, branch.decisions.length);
      const utility = terminalUtility(battle);
      const next = utility === null ? snapshotBattle(battle) : null;
      const key = next ? stateKey(next) : `terminal:${utility}`;
      const previous = outcomes.get(key);
      if (previous) previous.probability += branch.probability;
      else outcomes.set(key, {snapshot: next, utility, probability: branch.probability});
    } catch (error) {
      if (!(error instanceof NeedRandom)) throw error;
      for (const alternative of error.alternatives) {
        pending.push({
          decisions: [...branch.decisions, alternative.decision],
          probability: branch.probability * alternative.probability,
        });
      }
    }
  }
  return {outcomes: [...outcomes.values()], simulatorRuns};
}

function distribution(result: {outcomes: DistributionOutcome[]}): [string, number][] {
  return result.outcomes
    .map(outcome => [
      outcome.snapshot ? stateKey(outcome.snapshot) : `terminal:${outcome.utility}`,
      outcome.probability,
    ] as [string, number])
    .sort((left, right) => left[0].localeCompare(right[0]));
}

function assertSameDistribution(native: {outcomes: DistributionOutcome[]}, optimized: {outcomes: DistributionOutcome[]}, tolerance = 1e-12): void {
  const expected = distribution(native);
  const actual = distribution(optimized);
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < expected.length; i++) {
    assert.equal(actual[i][0], expected[i][0]);
    assert.ok(Math.abs(actual[i][1] - expected[i][1]) < tolerance,
      `probability mismatch at ${i}: ${actual[i][1]} != ${expected[i][1]}`);
  }
}

export {assertSameDistribution, distribution, enumerateNative};
