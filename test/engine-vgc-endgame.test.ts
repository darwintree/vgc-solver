import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BoundedSolver,
  type BoundedAdapter,
} from '../src/bounded-solver';
import {
  compileContextFromBattle,
  createEngineBoundedAdapter,
  createMonotoneAnalyzer,
  legalSideActions,
  legalSlotActions,
  stateFromBattle,
  stepBattle,
} from '../src/engine';
import {createChampionsModBattle} from '../src/engine/ruleset';
import {solveZeroSumMatrix} from '../src/matrix-game';

const IVS = {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31};
const EVS = {hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0};

function makeMon(spec: {
  species: string;
  ability: string;
  moves: string[];
  item?: string;
  nature?: string;
}) {
  return {
    name: spec.species,
    species: spec.species,
    item: spec.item ?? '',
    ability: spec.ability,
    moves: spec.moves,
    nature: spec.nature ?? 'Hardy',
    evs: EVS,
    ivs: IVS,
    level: 50,
  };
}

test('doubles legalSlotActions respects target semantics and skips fainted opponent slots', () => {
  const battle = createChampionsModBattle(
    [
      makeMon({species: 'Incineroar', ability: 'Intimidate', moves: ['Helping Hand', 'Flare Blitz', 'Acupressure', 'Protect']}),
      makeMon({species: 'Rillaboom', ability: 'Overgrow', moves: ['Counter', 'Dazzling Gleam', 'Fake Out', 'Protect']}),
    ],
    [
      makeMon({species: 'Gardevoir', ability: 'Synchronize', moves: ['Moonblast', 'Dazzling Gleam', 'Protect']}),
      makeMon({species: 'Lucario', ability: 'Inner Focus', moves: ['Close Combat', 'Protect']}),
    ],
    {doubles: true}
  );
  const ctx = compileContextFromBattle(battle);
  const st2v2 = stateFromBattle(ctx, battle);

  const p1s0 = legalSlotActions(ctx, st2v2, 0, 0);
  const hhActions = p1s0.filter(a => a.kind === 'move' && a.moveIndex === 0);
  // Helping Hand (adjacentAlly): ONLY targets ally slot (slot 1 on side 0), never opponent slots
  assert.equal(hhActions.length, 1);
  assert.equal(hhActions[0].kind === 'move' && hhActions[0].targetSide, 0);
  assert.equal(hhActions[0].kind === 'move' && hhActions[0].targetSlot, 1);

  const acuActions = p1s0.filter(a => a.kind === 'move' && a.moveIndex === 2);
  // Acupressure (adjacentAllyOrSelf): ONLY self (slot 0) and ally (slot 1), never opponent slots
  assert.equal(acuActions.length, 2);
  assert.ok(acuActions.every(a => a.kind === 'move' && a.targetSide === 0));

  const protActions = p1s0.filter(a => a.kind === 'move' && a.moveIndex === 3);
  // Protect (self): single action with no target fan-out
  assert.equal(protActions.length, 1);

  const p1s1 = legalSlotActions(ctx, st2v2, 0, 1);
  const counterActions = p1s1.filter(a => a.kind === 'move' && a.moveIndex === 0);
  // Counter (scripted): single action with no target fan-out
  assert.equal(counterActions.length, 1);

  // In 2v1 (opponent slot 1 fainted), Flare Blitz should only target alive opp slot 0 and alive ally slot 1
  const st2v1 = stateFromBattle(ctx, battle);
  st2v1.sides[1].pokemon[1].hp = 0;
  st2v1.sides[1].pokemon[1].fainted = true;
  const p1s0_2v1 = legalSlotActions(ctx, st2v1, 0, 0);
  const fb2v1 = p1s0_2v1.filter(a => a.kind === 'move' && a.moveIndex === 1);
  assert.equal(fb2v1.length, 2);
  assert.ok(!fb2v1.some(a => a.kind === 'move' && a.targetSide === 1 && a.targetSlot === 1));
});

test('multi-Pokemon monotone analyzer certifies safe 0-bench doubles and fails closed on hazards', () => {
  // 1. Safe 2v2 with 0 bench -> both sides monotone
  const safe2v2 = createChampionsModBattle(
    [
      makeMon({species: 'Arcanine', ability: 'Intimidate', moves: ['Flamethrower', 'Protect']}),
      makeMon({species: 'Gardevoir', ability: 'Synchronize', moves: ['Moonblast', 'Protect']}),
    ],
    [
      makeMon({species: 'Dragapult', ability: 'Clear Body', moves: ['Dragon Pulse', 'Protect']}),
      makeMon({species: 'Gholdengo', ability: 'Good as Gold', moves: ['Shadow Ball', 'Protect']}),
    ],
    {doubles: true}
  );
  const ctxSafe = compileContextFromBattle(safe2v2);
  const stSafe = stateFromBattle(ctxSafe, safe2v2);
  const anSafe = createMonotoneAnalyzer(ctxSafe);
  assert.equal(anSafe.anyAxisAllowed, true);
  assert.equal(anSafe.isPokeHpMonotone(stSafe, 0, 0, stSafe.sides[0].pokemon[0].hp), true);
  assert.equal(anSafe.isPokeHpMonotone(stSafe, 1, 1, stSafe.sides[1].pokemon[1].hp), true);

  // 2. Alive bench mon -> fails closed on the side with bench, stays monotone on 0-bench side
  const withBench = createChampionsModBattle(
    [
      makeMon({species: 'Arcanine', ability: 'Intimidate', moves: ['Flamethrower', 'Protect']}),
      makeMon({species: 'Gardevoir', ability: 'Synchronize', moves: ['Moonblast', 'Protect']}),
      makeMon({species: 'Milotic', ability: 'Marvel Scale', moves: ['Surf', 'Protect']}),
    ],
    [
      makeMon({species: 'Dragapult', ability: 'Clear Body', moves: ['Dragon Pulse', 'Protect']}),
      makeMon({species: 'Gholdengo', ability: 'Good as Gold', moves: ['Shadow Ball', 'Protect']}),
    ],
    {doubles: true}
  );
  const ctxBench = compileContextFromBattle(withBench);
  const stBench = stateFromBattle(ctxBench, withBench);
  const anBench = createMonotoneAnalyzer(ctxBench);
  assert.equal(anBench.isPokeHpMonotone(stBench, 0, 0, stBench.sides[0].pokemon[0].hp), false);
  assert.equal(anBench.isPokeHpMonotone(stBench, 1, 0, stBench.sides[1].pokemon[0].hp), true);

  // 3. Ally has allAdjacent damaging move (Earthquake) -> fails closed against 0.75x->1.0x spread shift
  const withEq = createChampionsModBattle(
    [
      makeMon({species: 'Arcanine', ability: 'Intimidate', moves: ['Flamethrower', 'Protect']}),
      makeMon({species: 'Garchomp', ability: 'Sand Veil', moves: ['Earthquake', 'Protect']}),
    ],
    [
      makeMon({species: 'Dragapult', ability: 'Clear Body', moves: ['Dragon Pulse', 'Protect']}),
      makeMon({species: 'Gholdengo', ability: 'Good as Gold', moves: ['Shadow Ball', 'Protect']}),
    ],
    {doubles: true}
  );
  const ctxEq = compileContextFromBattle(withEq);
  const stEq = stateFromBattle(ctxEq, withEq);
  const anEq = createMonotoneAnalyzer(ctxEq);
  assert.equal(anEq.isPokeHpMonotone(stEq, 0, 0, stEq.sides[0].pokemon[0].hp), false);
  assert.equal(anEq.isPokeHpMonotone(stEq, 0, 1, stEq.sides[0].pokemon[1].hp), true);

  // 4. Foe has drain move in 2v2 -> fails closed on side with >1 alive mon
  const withDrain = createChampionsModBattle(
    [
      makeMon({species: 'Arcanine', ability: 'Intimidate', moves: ['Flamethrower', 'Protect']}),
      makeMon({species: 'Gardevoir', ability: 'Synchronize', moves: ['Moonblast', 'Protect']}),
    ],
    [
      makeMon({species: 'Annihilape', ability: 'Inner Focus', moves: ['Drain Punch', 'Protect']}),
      makeMon({species: 'Gholdengo', ability: 'Good as Gold', moves: ['Shadow Ball', 'Protect']}),
    ],
    {doubles: true}
  );
  const ctxDrain = compileContextFromBattle(withDrain);
  const stDrain = stateFromBattle(ctxDrain, withDrain);
  const anDrain = createMonotoneAnalyzer(ctxDrain);
  assert.equal(anDrain.isPokeHpMonotone(stDrain, 0, 0, stDrain.sides[0].pokemon[0].hp), false);
  assert.equal(anDrain.isPokeHpMonotone(stDrain, 1, 0, stDrain.sides[1].pokemon[0].hp), true);
});

test('multi-Pokemon MonotoneBoxOutcome agrees with discrete oracle on 2v1 doubles endgame', () => {
  const make2v1 = () => {
    const b = createChampionsModBattle(
      [
        makeMon({species: 'Dragapult', ability: 'Clear Body', moves: ['Dragon Pulse', 'Shadow Ball']}),
        makeMon({species: 'Gardevoir', ability: 'Synchronize', moves: ['Moonblast', 'Dazzling Gleam']}),
      ],
      [
        makeMon({species: 'Arcanine', ability: 'Intimidate', moves: ['Flamethrower', 'Extreme Speed']}),
        makeMon({species: 'Gholdengo', ability: 'Good as Gold', moves: ['Shadow Ball']}),
      ],
      {doubles: true}
    );
    b.p1.pokemon[0].hp = 45;
    b.p1.pokemon[1].hp = 55;
    b.p2.pokemon[0].hp = 90;
    b.p2.pokemon[1].hp = 0;
    b.p2.pokemon[1].fainted = true;
    b.p2.pokemon[1].status = 'fnt' as any;
    b.p2.pokemonLeft = 1;
    return b;
  };

  const bBox = make2v1();
  const bDisc = make2v1();
  const discAdapter = createEngineBoundedAdapter(bDisc, {hpOutputMode: 'discrete', progressive: false})!;
  const boxSolver = new BoundedSolver({engine: 'compact', tolerance: 0.02, maxSearchMs: 10000});
  const discSolver = new BoundedSolver({adapter: discAdapter, tolerance: 0.02, maxSearchMs: 10000});

  const resBox = boxSolver.solve(bBox);
  const resDisc = discSolver.solve(bDisc);

  assert.equal(resBox.converged, true, 'box solver should converge on 2v1 fixture');
  assert.equal(resDisc.converged, true, 'discrete solver should converge on 2v1 fixture');
  // Certified intervals must overlap (soundness check)
  assert.ok(resBox.lowerBound <= resDisc.upperBound + 1e-6);
  assert.ok(resDisc.lowerBound <= resBox.upperBound + 1e-6);
});

test('forced 1x1 bench switch auto-resolution matches explicit stepBattle sequence', () => {
  // 2v1 singles (1 bench on P1, active P1 at 1 HP so P2 KOs P1 active and forces switch)
  const battle = createChampionsModBattle(
    [
      makeMon({species: 'Gardevoir', ability: 'Synchronize', moves: ['Moonblast']}),
      makeMon({species: 'Dragapult', ability: 'Clear Body', moves: ['Shadow Ball']}),
    ],
    [
      makeMon({species: 'Arcanine', ability: 'Intimidate', moves: ['Extreme Speed', 'Flamethrower']}),
    ],
    {doubles: false}
  );
  battle.p1.pokemon[0].hp = 1;
  battle.p1.pokemon[1].hp = 120;
  battle.p2.pokemon[0].hp = 95;

  const adapter = createEngineBoundedAdapter(battle, {progressive: false})!;
  const ctx = compileContextFromBattle(battle);
  const root = stateFromBattle(ctx, battle);
  const a1 = adapter.legalActions!(root, 0)[0]; // Moonblast (P1 active faints to Extreme Speed)
  const a2 = adapter.legalActions!(root, 1)[0]; // Extreme Speed (priority +2 -> KOs Gardevoir!)

  const trans = adapter.enumerateTurn(root, a1, a2);
  assert.equal(trans.complete, true);
  // Every surviving successor must already have auto-switched Dragapult into slot 0 (phase.kind === 'turn')
  for (const o of trans.outcomes) {
    const snap = 'snapshot' in o ? o.snapshot : ('lowerSnapshot' in o ? o.lowerSnapshot : null);
    if (snap) {
      assert.equal(snap.phase.kind, 'turn');
      assert.equal(snap.sides[0].active[0], 1);
    }
  }

  // Also verify stepBattle raw still emits phase.kind === 'switch' (Showdown parity contract preserved)
  const rawActs1 = legalSideActions(ctx, root, 0);
  const rawActs2 = legalSideActions(ctx, root, 1);
  const rawStep = stepBattle(ctx, root, rawActs1[0], rawActs2[0]);
  assert.ok(rawStep.outcomes.some(o => o.state.phase.kind === 'switch'));
});

test('Double-Oracle large-matrix BoundedSolver matches exact LP value on 30x30 mixed game', () => {
  const m = 30;
  const n = 30;
  // Build deterministic 30x30 zero-sum game with a non-trivial mixed saddle in the top-left 4x4
  // and dominated/mixed decoy actions elsewhere.
  const payoff: number[][] = Array.from({length: m}, (_, i) =>
    Array.from({length: n}, (_, j) => {
      if (i < 4 && j < 4) {
        return (((i * 7 + j * 13) % 11) - 5) / 10;
      }
      if (i < 4) return 0.6 + ((i + j) % 3) * 0.1;
      if (j < 4) return -0.6 - ((i + j) % 3) * 0.1;
      return (((i * 3 + j * 5) % 9) - 4) / 10;
    })
  );
  const exactSol = solveZeroSumMatrix(payoff);

  const adapter: BoundedAdapter = {
    snapshotBattle: s => s,
    restoreBattle: s => s,
    stateKey: s => String(s),
    terminalUtility: () => null,
    legalActions: (_s, side) => Array.from({length: side === 0 ? m : n}, (_, k) => k),
    enumerateTurn: (_s, i, j) => ({
      outcomes: [{utility: payoff[i as number][j as number], probability: 1}],
      simulatorRuns: 1,
      complete: true,
    }),
  };

  const solver = new BoundedSolver({adapter, tolerance: 0.001, maxSearchMs: 5000});
  const res = solver.solve('root');
  assert.equal(res.converged, true);
  assert.ok(Math.abs(res.value - exactSol.value) <= 0.001 + 1e-6, `got ${res.value}, expected ${exactSol.value}`);
  assert.ok(res.lowerBound <= exactSol.value + 1e-6);
  assert.ok(exactSol.value <= res.upperBound + 1e-6);
});
