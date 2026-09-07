/**
 * Diagnostic only: exhaustively checks the fixed policy "P1 uses Earthquake"
 * for at most two turns against every legal P2 reply.  The default optimized
 * native replay path still materializes a complete random distribution. Pass
 * --native to use the independent pre-optimization replay oracle for a
 * distribution cross-check; this is not a production solver or benchmark.
 */
import assert from 'node:assert/strict';
import {
  championsCases,
  createChampionsBattle,
} from '../src/champions-cases';
import {
  enumerateTurn,
  legalActions,
  restoreBattle,
  snapshotBattle,
} from '../src/showdown-adapter';
import type {Action, Snapshot} from '../src/types';
import {enumerateNative} from './helpers/distribution';

const MODE = process.argv.includes('--native') ? 'native' : 'optimized';

const CASE_ID = 'garchomp-100-vs-archaludon-100';

type NativeOutcome = {
  snapshot?: Snapshot | null;
  utility?: number | null;
  probability: number;
};

type TransitionReport = {
  p1Action: string;
  p2Action: string;
  outcomes: NativeOutcome[];
  simulatorRuns: number;
};

function enumerateComplete(snapshot: Snapshot, p1Action: Action, p2Action: Action) {
  const result = MODE === 'native'
    ? enumerateNative(snapshot, p1Action, p2Action)
    : enumerateTurn(snapshot, p1Action, p2Action);
  assert.notEqual((result as {complete?: boolean}).complete, false,
    `${MODE} native transition was incomplete`);
  const mass = result.outcomes.reduce((sum, outcome) => sum + outcome.probability, 0);
  assert.ok(Math.abs(mass - 1) <= 1e-9, `${MODE} transition probability mass is ${mass}`);
  return result;
}

function actionLabel(action: Action): string {
  return `${action.name} (${action.id})`;
}

function actionById(snapshot: Snapshot, side: number, id: string): Action {
  const action = legalActions(restoreBattle(snapshot), side).find(candidate => candidate.id === id);
  assert.ok(action, `side ${side + 1} has no legal ${id} action`);
  return action;
}

function hpSummary(snapshot: Snapshot): string {
  const battle = restoreBattle(snapshot);
  return battle.sides.map(side => {
    const pokemon = side.active[0];
    return `${side.id}:${pokemon.hp}/${pokemon.maxhp}`;
  }).join(' ');
}

function firstTurn(root: Snapshot, p2Action: Action): TransitionReport {
  const p1Action = actionById(root, 0, 'earthquake');
  const result = enumerateComplete(root, p1Action, p2Action);
  return {...result, p1Action: actionLabel(p1Action), p2Action: actionLabel(p2Action)};
}

function secondTurn(snapshot: Snapshot, p2Action: Action): TransitionReport {
  const p1Action = actionById(snapshot, 0, 'earthquake');
  const result = enumerateComplete(snapshot, p1Action, p2Action);
  return {...result, p1Action: actionLabel(p1Action), p2Action: actionLabel(p2Action)};
}

function terminal(outcome: NativeOutcome): number | null {
  return outcome.snapshot == null ? (outcome.utility ?? 0) : null;
}

function outcomeSummary(outcome: NativeOutcome): Record<string, unknown> {
  return {
    probability: outcome.probability,
    utility: terminal(outcome),
    hp: outcome.snapshot ? hpSummary(outcome.snapshot) : null,
  };
}

function checkReply(root: Snapshot, firstReply: Action) {
  const first = firstTurn(root, firstReply);
  let transitions = 1;
  let simulatorRuns = first.simulatorRuns;
  let secondReplyCount = 0;
  let outcomeCount = first.outcomes.length;
  const refutations: Record<string, unknown>[] = [];

  for (const [firstIndex, outcome] of first.outcomes.entries()) {
    const utility = terminal(outcome);
    if (utility !== null) {
      if (utility !== 1) {
        refutations.push({turn: 1, firstOutcome: firstIndex, outcome: outcomeSummary(outcome)});
      }
      continue;
    }

    const child = outcome.snapshot!;
    const replies = legalActions(restoreBattle(child), 1);
    secondReplyCount += replies.length;
    if (!replies.length) {
      refutations.push({turn: 2, firstOutcome: firstIndex, reason: 'no-legal-p2-reply'});
      continue;
    }
    for (const reply of replies) {
      const second = secondTurn(child, reply);
      transitions++;
      simulatorRuns += second.simulatorRuns;
      outcomeCount += second.outcomes.length;
      for (const [secondIndex, leaf] of second.outcomes.entries()) {
        if (terminal(leaf) !== 1) {
          refutations.push({
            turn: 2,
            firstOutcome: firstIndex,
            secondReply: actionLabel(reply),
            secondOutcome: secondIndex,
            outcome: outcomeSummary(leaf),
          });
        }
      }
    }
  }

  return {
    firstReply: actionLabel(firstReply),
    firstOutcomes: first.outcomes.map(outcomeSummary),
    firstSimulatorRuns: first.simulatorRuns,
    secondReplyCount,
    transitions,
    simulatorRuns,
    outcomeCount,
    guaranteedWinByTwoTurns: refutations.length === 0,
    refutations,
  };
}

function run() {
  const fixture = championsCases().find(candidate => candidate.id === CASE_ID);
  assert.ok(fixture, `unknown fixture ${CASE_ID}`);
  assert.equal(fixture.skipReasons.length, 0, fixture.skipReasons.join('; '));
  const battle = createChampionsBattle(fixture);
  const root = snapshotBattle(battle);
  const rootBattle = restoreBattle(root);
  const p1 = rootBattle.sides[0].active[0];
  const p2 = rootBattle.sides[1].active[0];
  const pp = rootBattle.sides.map(side => side.active[0].moveSlots.map(slot => ({
    id: slot.id,
    pp: slot.pp,
    maxpp: slot.maxpp,
  })));
  for (const side of rootBattle.sides) {
    for (const pokemon of side.active) {
      for (const slot of pokemon.moveSlots) assert.equal(slot.pp, slot.maxpp);
    }
  }

  const replies = legalActions(rootBattle, 1);
  const reports = replies.map(reply => checkReply(root, reply));
  assert.ok(reports.every(report => report.guaranteedWinByTwoTurns),
    'Earthquake policy has a refuting reply/outcome');
  const total = reports.reduce((sum, report) => ({
    transitions: sum.transitions + report.transitions,
    simulatorRuns: sum.simulatorRuns + report.simulatorRuns,
    outcomes: sum.outcomes + report.outcomeCount,
  }), {transitions: 0, simulatorRuns: 0, outcomes: 0});

  console.log(JSON.stringify({
    case: CASE_ID,
    mode: MODE,
    policy: 'P1 Earthquake every turn; P2 adversarial legal replies',
    hp: {p1: `${p1.hp}/${p1.maxhp}`, p2: `${p2.hp}/${p2.maxhp}`},
    pp,
    replies: reports,
    certificate: {
      completeNativeRandomDistributions: true,
      depth: 2,
      guaranteedWinByTwoTurns: reports.every(report => report.guaranteedWinByTwoTurns),
      total,
    },
  }, null, 2));
}

if (require.main === module) run();
