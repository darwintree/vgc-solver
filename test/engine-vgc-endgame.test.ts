import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BoundedSolver,
  type BoundedAdapter,
  type JointMonoPpSignature,
  type MonotoneBoxOutcome,
} from '../src/bounded-solver';
import type {Outcome} from '../src/types';
import {
  canonicalStateKey,
  cloneState,
  compileContextFromBattle,
  createEngineBoundedAdapter,
  createMonotoneAnalyzer,
  expandStateHpDists,
  legalSideActions,
  legalSlotActions,
  stateFromBattle,
  stepBattle,
  type DynamicState,
  type EngineActionEntry,
  type StaticBattleContext,
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

function distributionMap(
  ctx: StaticBattleContext,
  outcomes: Array<{state: DynamicState; probability: number}>
): Map<string, number> {
  const map = new Map<string, number>();
  for (const o of outcomes) {
    for (const ws of expandStateHpDists(o)) {
      const k = canonicalStateKey(ctx, ws.state);
      map.set(k, (map.get(k) ?? 0) + ws.probability);
    }
  }
  return map;
}

function tvdMaps(a: Map<string, number>, b: Map<string, number>): number {
  const keys = new Set([...a.keys(), ...b.keys()]);
  let sum = 0;
  for (const k of keys) {
    sum += Math.abs((a.get(k) ?? 0) - (b.get(k) ?? 0));
  }
  return 0.5 * sum;
}

test('action-equivalence folding achieves TVD=0 on unacted, Sucker Punch, and Follow Me turns and fails closed on Quick Draw', () => {
  // 1. Follow Me opponent-target folding + fainted-before-acting folding
  const battle = createChampionsModBattle(
    [
      makeMon({species: 'Indeedee-F', ability: 'Psychic Surge', moves: ['Follow Me', 'Psychic', 'Protect']}),
      makeMon({species: 'Dragapult', ability: 'Clear Body', moves: ['Dragon Pulse', 'Shadow Ball', 'Flamethrower', 'Protect']}),
    ],
    [
      makeMon({species: 'Arcanine', ability: 'Intimidate', moves: ['Flamethrower', 'Dragon Pulse', 'Snarl', 'Protect']}),
      makeMon({species: 'Gholdengo', ability: 'Good as Gold', moves: ['Shadow Ball', 'Thunderbolt', 'Nasty Plot', 'Protect']}),
    ],
    {doubles: true}
  );
  battle.p1.pokemon[0].hp = 120;
  battle.p1.pokemon[1].hp = 140;
  battle.p2.pokemon[0].hp = 1; // KOd before acting by faster Dragapult
  battle.p2.pokemon[1].hp = 120;

  const ctx = compileContextFromBattle(battle);
  const root = stateFromBattle(ctx, battle);
  const adapter = createEngineBoundedAdapter(battle, {hpOutputMode: 'discrete', progressive: false})!;
  const acts1 = adapter.legalActions!(root, 0) as EngineActionEntry[];
  const acts2 = adapter.legalActions!(root, 1) as EngineActionEntry[];

  // Follow Me + Dragon Pulse +1 (KOs Arcanine slot 0 before it acts, redirects Gholdengo's Shadow Ball)
  const fmIdx = acts1.findIndex(a => a.name.startsWith('Follow Me, Dragon Pulse +1'));
  const oppIdx = acts2.findIndex(a => a.name === 'Flamethrower +1, Shadow Ball +2');
  assert.ok(fmIdx >= 0 && oppIdx >= 0);

  const trans = adapter.enumerateTurn(root, acts1[fmIdx], acts2[oppIdx], {actions1: acts1, actions2: acts2});
  assert.equal(trans.complete, true);
  assert.ok((trans.equivalentCols?.length ?? 0) > 1, 'should fold unacted Arcanine moves and redirected Gholdengo targets');

  const refDist = distributionMap(
    ctx,
    stepBattle(ctx, root, acts1[fmIdx].sideAction, acts2[oppIdx].sideAction, {mode: 'certified', hpOutputMode: 'discrete'}).outcomes
  );
  for (const colIdx of trans.equivalentCols!) {
    const eqDist = distributionMap(
      ctx,
      stepBattle(ctx, root, acts1[fmIdx].sideAction, acts2[colIdx].sideAction, {mode: 'certified', hpOutputMode: 'discrete'}).outcomes
    );
    assert.ok(tvdMaps(refDist, eqDist) < 1e-12, `folded col ${acts2[colIdx].name} diverged from ${acts2[oppIdx].name}`);
  }

  // 2. Sucker Punch category observation: damaging moves fold together, Status moves do NOT fold with damaging moves
  const spBattle = createChampionsModBattle(
    [makeMon({species: 'Kingambit', ability: 'Defiant', moves: ['Sucker Punch', 'Kowtow Cleave']})],
    [makeMon({species: 'Dragapult', ability: 'Clear Body', moves: ['Dragon Pulse', 'Shadow Ball', 'Protect', 'Will-O-Wisp']})],
    {doubles: false}
  );
  spBattle.p2.pokemon[0].hp = 1; // Sucker Punch OHKOs on damaging move, fails on Status
  const spCtx = compileContextFromBattle(spBattle);
  const spRoot = stateFromBattle(spCtx, spBattle);
  const spAdapter = createEngineBoundedAdapter(spBattle, {hpOutputMode: 'discrete', progressive: false})!;
  const spA1 = spAdapter.legalActions!(spRoot, 0) as EngineActionEntry[];
  const spA2 = spAdapter.legalActions!(spRoot, 1) as EngineActionEntry[];
  const suckerIdx = spA1.findIndex(a => a.name === 'Sucker Punch');
  const dpIdx = spA2.findIndex(a => a.name === 'Dragon Pulse');
  const sbIdx = spA2.findIndex(a => a.name === 'Shadow Ball');
  const wowIdx = spA2.findIndex(a => a.name === 'Will-O-Wisp');
  const spTrans = spAdapter.enumerateTurn(spRoot, spA1[suckerIdx], spA2[dpIdx], {actions1: spA1, actions2: spA2});
  assert.ok(spTrans.equivalentCols?.includes(sbIdx), 'same-priority damaging move should fold under Sucker Punch');
  assert.ok(!spTrans.equivalentCols?.includes(wowIdx), 'Status move must NOT fold with damaging move under Sucker Punch');

  // 3. Negative guard: Quick Draw disables action-equivalence observation globally
  const qdBattle = createChampionsModBattle(
    [makeMon({species: 'Slowbro-Galar', ability: 'Quick Draw', moves: ['Sludge Bomb']})],
    [makeMon({species: 'Dragapult', ability: 'Clear Body', moves: ['Dragon Pulse', 'Shadow Ball']})],
    {doubles: false}
  );
  qdBattle.p2.pokemon[0].hp = 1;
  const qdCtx = compileContextFromBattle(qdBattle);
  const qdRoot = stateFromBattle(qdCtx, qdBattle);
  const qdAdapter = createEngineBoundedAdapter(qdBattle, {hpOutputMode: 'discrete', progressive: false})!;
  const qdA1 = qdAdapter.legalActions!(qdRoot, 0) as EngineActionEntry[];
  const qdA2 = qdAdapter.legalActions!(qdRoot, 1) as EngineActionEntry[];
  const qdTrans = qdAdapter.enumerateTurn(qdRoot, qdA1[0], qdA2[0], {actions1: qdA1, actions2: qdA2});
  assert.equal(qdTrans.equivalentCols, undefined, 'Quick Draw must disable action-equivalence folding');
});

test('N-D monotone signature, Choice-lock filtering, and dynamic foe threshold analysis are sound and fail-closed', () => {
  // 1. Safe 2v2 with 0 bench produces 4-element signed N-D monotone vector (+P1, -P2)
  const b2v2 = createChampionsModBattle(
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
  const ctx2 = compileContextFromBattle(b2v2);
  const st2 = stateFromBattle(ctx2, b2v2);
  const an2 = createMonotoneAnalyzer(ctx2);
  const sig = an2.monotoneSignature(st2);
  assert.ok(sig && sig.vec && sig.vec.length === 4);
  assert.deepEqual(sig.vec, [
    st2.sides[0].pokemon[0].hp,
    st2.sides[0].pokemon[1].hp,
    -st2.sides[1].pokemon[0].hp,
    -st2.sides[1].pokemon[1].hp,
  ]);

  // 2. Choice Scarf Last Respects: unlocked disables ally monotonicity; locked into Aqua Jet restores it
  const bChoice = createChampionsModBattle(
    [
      makeMon({species: 'Archaludon', ability: 'Stamina', moves: ['Dragon Pulse', 'Protect']}),
      makeMon({species: 'Basculegion', ability: 'Adaptability', item: 'Choice Scarf', moves: ['Aqua Jet', 'Last Respects']}),
    ],
    [
      makeMon({species: 'Dragonite', ability: 'Inner Focus', moves: ['Dragon Pulse', 'Protect']}),
      makeMon({species: 'Gholdengo', ability: 'Good as Gold', moves: ['Shadow Ball', 'Protect']}),
    ],
    {doubles: true}
  );
  bChoice.p2.pokemon[1].hp = 0;
  bChoice.p2.pokemon[1].fainted = true;
  bChoice.p2.pokemon[1].status = 'fnt' as any;
  bChoice.p2.pokemonLeft = 1;
  const ctxC = compileContextFromBattle(bChoice);
  const stUnlocked = stateFromBattle(ctxC, bChoice);
  const anC = createMonotoneAnalyzer(ctxC);
  assert.equal(anC.isPokeHpMonotone(stUnlocked, 0, 0, stUnlocked.sides[0].pokemon[0].hp), false);
  const stLocked = cloneState(stUnlocked);
  stLocked.sides[0].pokemon[1].choiceLockedMoveIdx = 0; // Aqua Jet
  assert.equal(anC.isPokeHpMonotone(stLocked, 0, 0, stLocked.sides[0].pokemon[0].hp), true);

  // 3. Negative guard: Knock Off on opponent disables Choice-lock move filtering
  const bKnock = createChampionsModBattle(
    [
      makeMon({species: 'Archaludon', ability: 'Stamina', moves: ['Dragon Pulse', 'Protect']}),
      makeMon({species: 'Basculegion', ability: 'Adaptability', item: 'Choice Scarf', moves: ['Aqua Jet', 'Last Respects']}),
    ],
    [
      makeMon({species: 'Incineroar', ability: 'Intimidate', moves: ['Knock Off', 'Protect']}),
      makeMon({species: 'Gholdengo', ability: 'Good as Gold', moves: ['Shadow Ball', 'Protect']}),
    ],
    {doubles: true}
  );
  bKnock.p2.pokemon[1].hp = 0;
  bKnock.p2.pokemon[1].fainted = true;
  bKnock.p2.pokemon[1].status = 'fnt' as any;
  bKnock.p2.pokemonLeft = 1;
  const ctxK = compileContextFromBattle(bKnock);
  const stK = stateFromBattle(ctxK, bKnock);
  stK.sides[0].pokemon[1].choiceLockedMoveIdx = 0;
  assert.equal(createMonotoneAnalyzer(ctxK).isPokeHpMonotone(stK, 0, 0, stK.sides[0].pokemon[0].hp), false);

  // 4. Dynamic foe threshold (Gale Wings + Flare Blitz): fails closed at full HP, allowed below max HP when foe cannot heal
  const bGw = createChampionsModBattle(
    [
      makeMon({species: 'Dragapult', ability: 'Clear Body', moves: ['Dragon Pulse']}),
      makeMon({species: 'Gholdengo', ability: 'Good as Gold', moves: ['Shadow Ball']}),
    ],
    [
      makeMon({species: 'Talonflame', ability: 'Gale Wings', moves: ['Flare Blitz', 'Protect']}),
      makeMon({species: 'Arcanine', ability: 'Intimidate', moves: ['Flamethrower']}),
    ],
    {doubles: true}
  );
  const ctxGw = compileContextFromBattle(bGw);
  const stGwFull = stateFromBattle(ctxGw, bGw);
  const anGw = createMonotoneAnalyzer(ctxGw);
  assert.equal(anGw.isPokeHpMonotone(stGwFull, 0, 0, stGwFull.sides[0].pokemon[0].hp), false);
  const stGwChipped = cloneState(stGwFull);
  stGwChipped.sides[1].pokemon[0].hp -= 10;
  assert.equal(anGw.isPokeHpMonotone(stGwChipped, 0, 0, stGwChipped.sides[0].pokemon[0].hp), true);
});

test('multi-Pokemon exact ppTemplateCache and protectStreak masking match uncached stepBattle bit-for-bit', () => {
  const battle = createChampionsModBattle(
    [
      makeMon({species: 'Dragapult', ability: 'Clear Body', moves: ['Dragon Pulse', 'Protect']}),
      makeMon({species: 'Gholdengo', ability: 'Good as Gold', moves: ['Shadow Ball', 'Protect']}),
    ],
    [
      makeMon({species: 'Arcanine', ability: 'Intimidate', moves: ['Flamethrower', 'Protect']}),
      makeMon({species: 'Gardevoir', ability: 'Synchronize', moves: ['Moonblast', 'Protect']}),
    ],
    {doubles: true}
  );
  const ctx = compileContextFromBattle(battle);
  const sPs0 = stateFromBattle(ctx, battle);
  const sPs1 = cloneState(sPs0);
  sPs1.sides[0].pokemon[0].protectStreak = 1;
  sPs1.sides[0].pokemon[0].pp[1] = 14; // Differing PP >= 3

  const adapter = createEngineBoundedAdapter(battle, {hpOutputMode: 'discrete', progressive: false})!;
  const a1 = adapter.legalActions!(sPs0, 0) as EngineActionEntry[];
  const a2 = adapter.legalActions!(sPs0, 1) as EngineActionEntry[];

  // Slot 0 (with PS1) uses Dragon Pulse (non-stall), slot 1 uses Protect (PS0); P2 attacks slot 0 & Protects slot 1
  const nonStall1 = a1.find(a => a.name === 'Dragon Pulse +1, Protect')!;
  const nonStall2 = a2.find(a => a.name === 'Flamethrower +1, Protect')!;
  const stall1 = a1.find(a => a.name === 'Protect, Shadow Ball +2')!;

  // Warm cache on PS0, then query PS1 with non-stall action on slot 0 -> must hit cache and match fresh stepBattle (TVD = 0)
  const r0 = adapter.enumerateTurn(sPs0, nonStall1, nonStall2);
  assert.equal(r0.cacheHits, 0);
  const r1 = adapter.enumerateTurn(sPs1, nonStall1, nonStall2);
  assert.equal(r1.cacheHits, 1, 'non-stall turn with PS1 should hit protectStreak-masked PP template cache');

  const freshNonStall = distributionMap(
    ctx,
    stepBattle(ctx, sPs1, nonStall1.sideAction, nonStall2.sideAction, {mode: 'certified', hpOutputMode: 'discrete'}).outcomes
  );
  const cachedNonStall = new Map<string, number>();
  const collectOutcomes = (list: any[]) => {
    for (const o of list) {
      if (typeof o.split === 'function') {
        collectOutcomes(o.split());
      } else {
        assert.ok('snapshot' in o && o.snapshot);
        const k = canonicalStateKey(ctx, o.snapshot as DynamicState);
        cachedNonStall.set(k, (cachedNonStall.get(k) ?? 0) + o.probability);
      }
    }
  };
  collectOutcomes(r1.outcomes);
  assert.ok(tvdMaps(freshNonStall, cachedNonStall) < 1e-12);

  // Stall turn (Protect on slot 0): PS0 vs PS1 MUST NOT collide in cache (100% vs 1/3 Protect success)
  const stR0 = adapter.enumerateTurn(sPs0, stall1, nonStall2);
  assert.equal(stR0.cacheHits, 0);
  const stR1 = adapter.enumerateTurn(sPs1, stall1, nonStall2);
  assert.equal(stR1.cacheHits, 0, 'stall turn must NOT collide between PS0 and PS1');
});

test('shared BoundedCell across equivalent siblings stays synchronized across splits on small and large matrices', () => {
  for (const dim of [4, 8]) {
    // 4x4 (small matrix) and 8x8 (large matrix): rows 0..dim-2 share an equivalent class with a splittable box
    const exactVal = 0.25;
    let evalCalls = 0;
    const adapter: BoundedAdapter = {
      snapshotBattle: s => s,
      restoreBattle: s => s,
      stateKey: s => String(s),
      terminalUtility: s => (typeof s === 'number' ? s : null),
      legalActions: (_s, side) => Array.from({length: side === 0 ? dim : dim}, (_, k) => k),
      enumerateTurn: (s, i, j) => {
        evalCalls++;
        if (s !== 'root') {
          return {outcomes: [{utility: exactVal, probability: 1}], simulatorRuns: 1, complete: true};
        }
        const ii = i as number;
        const jj = j as number;
        if (ii < dim - 1 && jj < dim - 1) {
          const box: MonotoneBoxOutcome = {
            probability: 1,
            lowerSnapshot: null,
            upperSnapshot: null,
            split: () => [
              {utility: 0.0, probability: 0.5},
              {utility: 0.5, probability: 0.5},
            ],
          };
          return {
            outcomes: [box],
            simulatorRuns: 1,
            complete: true,
            equivalentRows: Array.from({length: dim - 1}, (_, k) => k),
            equivalentCols: Array.from({length: dim - 1}, (_, k) => k),
          };
        }
        return {
          outcomes: [{utility: ii === dim - 1 ? -0.5 : 0.75, probability: 1}],
          simulatorRuns: 1,
          complete: true,
        };
      },
    };
    const solver = new BoundedSolver({adapter, tolerance: 1e-6, maxSearchMs: 5000});
    const res = solver.solve('root');
    assert.equal(res.converged, true);
    assert.equal(res.exact, dim === 4, `dim=${dim}: exactCertified should reflect whether all cells are populated`);
    assert.ok(Math.abs(res.value - exactVal) < 1e-9, `dim=${dim}: got ${res.value}`);
    assert.ok(res.lowerBound <= exactVal && exactVal <= res.upperBound);
    assert.ok(res.stats.equivCellsFilled >= (dim - 1) * (dim - 1) - 1);
    assert.ok(evalCalls < dim * dim, `dim=${dim}: expected equivalence folding to save transitions`);

    // When one equivalent class spans the entire dim x dim matrix and splits to terminals, exact === true
    const allIdx = Array.from({length: dim}, (_, k) => k);
    let fullCalls = 0;
    const fullAdapter: BoundedAdapter = {
      snapshotBattle: s => s,
      restoreBattle: s => s,
      stateKey: s => String(s),
      terminalUtility: () => null,
      legalActions: () => allIdx,
      enumerateTurn: () => {
        fullCalls++;
        return {
          outcomes: [{
            probability: 1,
            lowerSnapshot: null,
            upperSnapshot: null,
            split: () => [
              {utility: 0.0, probability: 0.5},
              {utility: 0.5, probability: 0.5},
            ],
          } as MonotoneBoxOutcome],
          simulatorRuns: 1,
          complete: true,
          equivalentRows: allIdx,
          equivalentCols: allIdx,
        };
      },
    };
    const fullRes = new BoundedSolver({adapter: fullAdapter, tolerance: 1e-6, maxSearchMs: 5000}).solve('root');
    assert.equal(fullRes.converged, true);
    assert.equal(fullRes.exact, true);
    assert.equal(fullCalls, 1);
    assert.equal(fullRes.stats.equivCellsFilled, dim * dim - 1);
    assert.ok(Math.abs(fullRes.value - exactVal) < 1e-9);
  }
});

test('single-pass HpDist folding matches discrete mode (TVD=0) and multi-axis non-monotone box peeling conserves probability', () => {
  // 2v2 with multi-target spread + recoil + drain -> exercises mergeActiveBranches, finalizeOutcomes, and multi-axis non-monotone box peeling
  const battle = createChampionsModBattle(
    [
      makeMon({species: 'Incineroar', ability: 'Intimidate', moves: ['Flare Blitz', 'Protect']}),
      makeMon({species: 'Rillaboom', ability: 'Grassy Surge', moves: ['Wood Hammer', 'Protect']}),
    ],
    [
      makeMon({species: 'Garchomp', ability: 'Rough Skin', moves: ['Earthquake', 'Protect']}),
      makeMon({species: 'Annihilape', ability: 'Defiant', moves: ['Drain Punch', 'Protect']}),
    ],
    {doubles: true}
  );
  const ctx = compileContextFromBattle(battle);
  const root = stateFromBattle(ctx, battle);
  const acts1 = legalSideActions(ctx, root, 0);
  const acts2 = legalSideActions(ctx, root, 1);

  // 1. Discrete vs distributional TVD=0 parity on a 2-attack recoil+drain turn (~16x16 discrete states)
  const a1Disc = acts1.find(sa => sa[0].kind === 'move' && sa[0].moveIndex === 0 && sa[0].targetSide === 1 && sa[0].targetSlot === 0 && sa[1].kind === 'move' && sa[1].moveIndex === 1)!;
  const a2Disc = acts2.find(sa => sa[0].kind === 'move' && sa[0].moveIndex === 1 && sa[1].kind === 'move' && sa[1].moveIndex === 0 && sa[1].targetSide === 0 && sa[1].targetSlot === 0)!;
  assert.ok(a1Disc && a2Disc);

  const distRes = stepBattle(ctx, root, a1Disc, a2Disc, {mode: 'certified', hpOutputMode: 'distributional'});
  const discRes = stepBattle(ctx, root, a1Disc, a2Disc, {mode: 'certified', hpOutputMode: 'discrete'});
  assert.equal(distRes.complete, true);
  assert.equal(discRes.complete, true);
  assert.ok(
    tvdMaps(distributionMap(ctx, distRes.outcomes), distributionMap(ctx, discRes.outcomes)) < 1e-11,
    'single-pass distributional folding must match discrete distribution exactly'
  );

  // 2. Multi-axis non-monotone box peeling on full 4-attack spread+recoil+drain turn conserves probability === 1
  const adapter = createEngineBoundedAdapter(battle, {hpOutputMode: 'distributional', progressive: false})!;
  const fmtA1 = (adapter.legalActions!(root, 0) as EngineActionEntry[]).find(e => e.name === 'Flare Blitz +1, Wood Hammer +2')!;
  const fmtA2 = (adapter.legalActions!(root, 1) as EngineActionEntry[]).find(e => e.name === 'Earthquake, Drain Punch +1')!;
  const trans = adapter.enumerateTurn(root, fmtA1, fmtA2);
  let totalProb = 0;
  let splitCount = 0;
  for (const o of trans.outcomes) {
    totalProb += o.probability;
    if ('split' in o && typeof o.split === 'function') {
      const subs = o.split();
      splitCount++;
      const subSum = subs.reduce((acc, s) => acc + s.probability, 0);
      assert.ok(Math.abs(subSum - o.probability) < 1e-12, `box split probability ${subSum} != ${o.probability}`);
    }
  }
  assert.ok(Math.abs(totalProb - 1) < 1e-12, `total probability ${totalProb} != 1`);
  assert.ok(splitCount > 0, 'expected at least one multi-axis box to exercise split()');
});

test('Protect/Endure chain contraction matches uncontracted exact solve on single-slot and double-Protect streaks and fails closed on unsafe states', () => {
  // 1. Single-slot 1v1 Protect contraction parity with non-trivial fractional value:
  // P1 (faster, 1 HP) has Air Slash (95% acc, OHKOs 1 HP P2); P2 (slower, 1 HP) has Protect + Aura Sphere.
  const b1 = createChampionsModBattle(
    [makeMon({species: 'Jolteon', ability: 'Volt Absorb', moves: ['Air Slash']})],
    [makeMon({species: 'Snorlax', ability: 'Immunity', moves: ['Protect', 'Aura Sphere']})]
  );
  b1.sides[0].active[0].hp = 1;
  b1.sides[1].active[0].hp = 1;
  b1.sides[0].active[0].activeTurns = 1;
  b1.sides[1].active[0].activeTurns = 1;
  const contractedAdapter1 = createEngineBoundedAdapter(b1, {hpOutputMode: 'distributional', progressive: false})!;
  const uncontractedAdapter1: BoundedAdapter = {...contractedAdapter1, protectContractionInfo: undefined};
  const resContracted1 = new BoundedSolver({adapter: contractedAdapter1, tolerance: 1e-3, maxSearchMs: 5000}).solve(b1);
  const resExact1 = new BoundedSolver({adapter: uncontractedAdapter1, tolerance: 1e-3, maxSearchMs: 5000}).solve(b1);
  assert.equal(resContracted1.converged, true);
  assert.equal(resExact1.converged, true);
  assert.ok(resContracted1.stats.protectContractions > 0, `expected protectContractions > 0, got ${resContracted1.stats.protectContractions}`);
  assert.ok(
    resContracted1.lowerBound <= resExact1.upperBound + 1e-6 &&
    resExact1.lowerBound <= resContracted1.upperBound + 1e-6,
    `contracted [${resContracted1.lowerBound}, ${resContracted1.upperBound}] must intersect uncontracted [${resExact1.lowerBound}, ${resExact1.upperBound}]`
  );
  assert.ok(Math.abs(resContracted1.value - resExact1.value) < 2e-3);

  // 2. Double-Protect [k, k] contraction parity on 2v2 endgame:
  // P1 has two fast attackers with Dazzling Gleam (100% acc spread OHKO on 1 HP foes);
  // P2 has two slow 1 HP mons with Protect + Tackle.
  const b2 = createChampionsModBattle(
    [
      makeMon({species: 'Alakazam', ability: 'Inner Focus', moves: ['Dazzling Gleam']}),
      makeMon({species: 'Jolteon', ability: 'Volt Absorb', moves: ['Swift']}),
    ],
    [
      makeMon({species: 'Snorlax', ability: 'Immunity', moves: ['Protect', 'Tackle']}),
      makeMon({species: 'Torkoal', ability: 'White Smoke', moves: ['Protect', 'Tackle']}),
    ],
    {doubles: true}
  );
  for (const side of b2.sides) {
    for (const p of side.active) p.activeTurns = 1;
  }
  b2.sides[1].active[0].hp = 1;
  b2.sides[1].active[1].hp = 1;
  const ctx2 = compileContextFromBattle(b2);
  const s2Root = stateFromBattle(ctx2, b2);
  const adapter2 = createEngineBoundedAdapter(b2, {hpOutputMode: 'distributional', progressive: false})!;
  // Verify protectContractionInfo recognizes equal-streak double-Protect [1, 1]
  const s2DoubleStreak = cloneState(s2Root);
  s2DoubleStreak.sides[1].pokemon[0].protectStreak = 1;
  s2DoubleStreak.sides[1].pokemon[1].protectStreak = 1;
  const info2 = adapter2.protectContractionInfo!(s2DoubleStreak);
  assert.ok(info2, 'expected double-Protect [1, 1] state to be eligible for contraction');
  assert.equal(info2.stallingSide, 1);
  assert.equal(info2.stallSlotsCount, 2);
  assert.equal(info2.streak, 1);

  const resContracted2 = new BoundedSolver({adapter: adapter2, tolerance: 0.02, maxSearchMs: 5000}).solve(b2);
  const uncontractedAdapter2: BoundedAdapter = {...adapter2, protectContractionInfo: undefined};
  const resExact2 = new BoundedSolver({adapter: uncontractedAdapter2, tolerance: 0.02, maxSearchMs: 5000}).solve(b2);
  assert.equal(resContracted2.converged, true);
  assert.equal(resExact2.converged, true);
  assert.ok(resContracted2.stats.protectContractions > 0, 'expected double-Protect contraction to fire');
  assert.ok(resContracted2.lowerBound <= 1.0 && resContracted2.upperBound >= 1.0 - 1e-9);
  assert.ok(Math.abs(resContracted2.value - resExact2.value) < 0.02);

  // 3. Fail-closed negative guards on protectContractionInfo:
  // 3a. activeTurns === 0 disables contraction when an active mon has Fake Out / First Impression,
  //     and remains eligible when no active mon has a Turn-1-only move.
  const sActive0NoFakeOut = cloneState(s2DoubleStreak);
  sActive0NoFakeOut.sides[0].pokemon[0].activeTurns = 0;
  assert.ok(
    adapter2.protectContractionInfo!(sActive0NoFakeOut),
    'activeTurns === 0 without Fake Out / First Impression should remain eligible'
  );
  const bFakeOut = createChampionsModBattle(
    [makeMon({species: 'Incineroar', ability: 'Intimidate', moves: ['Fake Out', 'Flare Blitz']})],
    [makeMon({species: 'Snorlax', ability: 'Immunity', moves: ['Protect', 'Tackle']})]
  );
  const ctxFakeOut = compileContextFromBattle(bFakeOut);
  const sFakeOut0 = stateFromBattle(ctxFakeOut, bFakeOut);
  sFakeOut0.sides[0].pokemon[0].activeTurns = 0;
  sFakeOut0.sides[1].pokemon[0].activeTurns = 1;
  sFakeOut0.sides[1].pokemon[0].protectStreak = 1;
  const adapterFakeOut = createEngineBoundedAdapter(bFakeOut, {hpOutputMode: 'distributional', progressive: false})!;
  assert.equal(adapterFakeOut.protectContractionInfo!(sFakeOut0), null, 'activeTurns === 0 with Fake Out must disable contraction');

  // 3b. Active weather / asymmetric tailwind timer
  const sWeather = cloneState(s2DoubleStreak);
  sWeather.field.weather = 'sun';
  sWeather.field.weatherTurns = 3;
  assert.equal(adapter2.protectContractionInfo!(sWeather), null, 'active weather timer must disable contraction');
  const sTailwind = cloneState(s2DoubleStreak);
  sTailwind.sides[0].tailwindTurns = 2;
  assert.equal(adapter2.protectContractionInfo!(sTailwind), null, 'asymmetric tailwind timer must disable contraction');

  // 3c. Low PP fails closed in maxSafeStreak when proving opponent move or only stalling move is low,
  //     while stalling-side Protect low PP remains sound when a safe high-PP backup attack prevents Struggle.
  const sLowOppPp = cloneState(s2DoubleStreak);
  sLowOppPp.sides[0].pokemon[0].pp[0] = 1;
  const infoLowOppPp = adapter2.protectContractionInfo!(sLowOppPp);
  assert.ok(infoLowOppPp);
  const a1Low = (adapter2.legalActions!(sLowOppPp, 0) as EngineActionEntry[])[0];
  const a2sLow = (adapter2.legalActions!(sLowOppPp, 1) as EngineActionEntry[]).filter(a => infoLowOppPp.stallActionCount(a) === 2);
  assert.ok(infoLowOppPp.maxSafeStreak(a1Low, a2sLow, 1) <= 1, 'low proving-opponent PP must prevent contraction beyond current streak');

  const sLowAllStallPp = cloneState(s2DoubleStreak);
  sLowAllStallPp.sides[1].pokemon[0].pp[0] = 1;
  sLowAllStallPp.sides[1].pokemon[0].pp[1] = 1;
  const infoLowAll = adapter2.protectContractionInfo!(sLowAllStallPp);
  assert.ok(infoLowAll);
  const a1All = (adapter2.legalActions!(sLowAllStallPp, 0) as EngineActionEntry[])[0];
  const a2sAll = (adapter2.legalActions!(sLowAllStallPp, 1) as EngineActionEntry[]).filter(a => infoLowAll.stallActionCount(a) === 2);
  assert.ok(infoLowAll.maxSafeStreak(a1All, a2sAll, 1) <= 1, 'low stalling PP without safe backup attack must fail closed');

  const sLowProtWithBackup = cloneState(s2DoubleStreak);
  sLowProtWithBackup.sides[1].pokemon[0].pp[0] = 1; // Protect PP=1, Tackle PP=35 (safe backup)
  const infoLowProtBackup = adapter2.protectContractionInfo!(sLowProtWithBackup);
  assert.ok(infoLowProtBackup);
  const a1Bk = (adapter2.legalActions!(sLowProtWithBackup, 0) as EngineActionEntry[])[0];
  const a2sBk = (adapter2.legalActions!(sLowProtWithBackup, 1) as EngineActionEntry[]).filter(a => infoLowProtBackup.stallActionCount(a) === 2);
  assert.ok(infoLowProtBackup.maxSafeStreak(a1Bk, a2sBk, 1) > 1, 'low Protect PP with safe backup attack should allow contraction');

  // 3d. Alive Encore on stalling side disables contraction; opponent Encore action is ineligible
  const bEncore = createChampionsModBattle(
    [makeMon({species: 'Whimsicott', ability: 'Infiltrator', moves: ['Encore', 'Moonblast']})],
    [makeMon({species: 'Snorlax', ability: 'Immunity', moves: ['Protect', 'Tackle']})]
  );
  bEncore.sides[0].active[0].activeTurns = 1;
  bEncore.sides[1].active[0].activeTurns = 1;
  const ctxEncore = compileContextFromBattle(bEncore);
  const sEncore = stateFromBattle(ctxEncore, bEncore);
  sEncore.sides[1].pokemon[0].protectStreak = 1;
  const adapterEncore = createEngineBoundedAdapter(bEncore, {hpOutputMode: 'distributional', progressive: false})!;
  const infoEncore = adapterEncore.protectContractionInfo!(sEncore);
  assert.ok(infoEncore, 'opponent having Encore should still allow non-Encore opponent actions');
  const p1ActsEncore = adapterEncore.legalActions!(sEncore, 0) as EngineActionEntry[];
  const encoreAct = p1ActsEncore.find(a => a.name.includes('Encore'))!;
  const moonblastAct = p1ActsEncore.find(a => a.name.includes('Moonblast'))!;
  assert.equal(infoEncore.isOpponentActionEligible(encoreAct), false, 'Encore action must not be eligible');
  assert.equal(infoEncore.isOpponentActionEligible(moonblastAct), true, 'non-Encore attack should remain eligible');

  // 3e. Spiky Shield + contact move must reject opponent contact action
  const bSpiky = createChampionsModBattle(
    [makeMon({species: 'Garchomp', ability: 'Sand Veil', moves: ['Dragon Claw', 'Earth Power']})],
    [makeMon({species: 'Chesnaught', ability: 'Overgrow', moves: ['Spiky Shield', 'Tackle']})]
  );
  bSpiky.sides[0].active[0].activeTurns = 1;
  bSpiky.sides[1].active[0].activeTurns = 1;
  const ctxSpiky = compileContextFromBattle(bSpiky);
  const sSpiky = stateFromBattle(ctxSpiky, bSpiky);
  sSpiky.sides[1].pokemon[0].protectStreak = 1;
  const adapterSpiky = createEngineBoundedAdapter(bSpiky, {hpOutputMode: 'distributional', progressive: false})!;
  const infoSpiky = adapterSpiky.protectContractionInfo!(sSpiky);
  assert.ok(infoSpiky);
  const p1ActsSpiky = adapterSpiky.legalActions!(sSpiky, 0) as EngineActionEntry[];
  const contactAct = p1ActsSpiky.find(a => a.name.includes('Dragon Claw'))!;
  const nonContactAct = p1ActsSpiky.find(a => a.name.includes('Earth Power'))!;
  assert.equal(infoSpiky.isOpponentActionEligible(contactAct), false, 'contact move into Spiky Shield must fail closed');
  assert.equal(infoSpiky.isOpponentActionEligible(nonContactAct), true, 'non-contact move into Spiky Shield should be eligible');
});

test('witness-conditioned monotonicity certifies survive-self and no-drain-opp boxes and splits soundly when violated', () => {
  // 1. Positive survive-self check with aliveBench > 0:
  // P1 has active + 1 healthy bench mon; P2 has 1 low-HP mon.
  // P2 hits P1 for a damage range (survive-self axis) while P1 hits P2.
  const bBench = createChampionsModBattle(
    [
      makeMon({species: 'Snorlax', ability: 'Immunity', moves: ['Body Slam']}),
      makeMon({species: 'Dragonite', ability: 'Inner Focus', moves: ['Dragon Claw']}),
    ],
    [makeMon({species: 'Jolteon', ability: 'Volt Absorb', moves: ['Thunderbolt']})]
  );
  bBench.sides[1].active[0].hp = 45;
  const adapterBench = createEngineBoundedAdapter(bBench, {hpOutputMode: 'distributional', progressive: false})!;
  const ctxBench = compileContextFromBattle(bBench);
  const rootBench = stateFromBattle(ctxBench, bBench);
  const a1Bench = (adapterBench.legalActions!(rootBench, 0) as EngineActionEntry[]).find(a => a.name.includes('Body Slam'))!;
  const a2Bench = (adapterBench.legalActions!(rootBench, 1) as EngineActionEntry[]).find(a => a.name.includes('Thunderbolt'))!;
  const transBench = adapterBench.enumerateTurn(rootBench, a1Bench, a2Bench);
  const condBenchBoxes = transBench.outcomes.filter(
    o => 'split' in o && typeof o.split === 'function' && ((o as MonotoneBoxOutcome).lowerReqNoFaintMask || 0) !== 0
  );
  assert.ok(condBenchBoxes.length > 0, 'expected survive-self conditional box with lowerReqNoFaintMask > 0 when bench > 0');

  const resDistBench = new BoundedSolver({
    adapter: adapterBench,
    tolerance: 0.02,
    maxSearchMs: 5000,
  }).solve(bBench);
  const resDiscBench = new BoundedSolver({
    adapter: createEngineBoundedAdapter(bBench, {hpOutputMode: 'discrete', progressive: false})!,
    tolerance: 0.02,
    maxSearchMs: 5000,
  }).solve(bBench);
  assert.equal(resDistBench.converged, true);
  assert.equal(resDiscBench.converged, true);
  assert.ok(
    resDistBench.lowerBound <= resDiscBench.upperBound + 1e-6 &&
    resDiscBench.lowerBound <= resDistBench.upperBound + 1e-6,
    `conditional box interval [${resDistBench.lowerBound}, ${resDistBench.upperBound}] must agree with discrete [${resDiscBench.lowerBound}, ${resDiscBench.upperBound}]`
  );

  // 2. Positive no-drain-opp check (multi-Pokemon doubles 2v1, 0 alive bench, foe has Drain Punch):
  const bDrain = createChampionsModBattle(
    [
      makeMon({species: 'Snorlax', ability: 'Immunity', moves: ['Tackle']}),
      makeMon({species: 'Dragonite', ability: 'Inner Focus', moves: ['Protect']}),
    ],
    [
      makeMon({species: 'Machamp', ability: 'No Guard', moves: ['Drain Punch', 'Tackle']}),
      makeMon({species: 'Torkoal', ability: 'White Smoke', moves: ['Protect']}),
    ],
    {doubles: true}
  );
  // Faint P2 slot 1 so it is a clean 2v1 with 0 bench on both sides and Drain Punch on foe
  bDrain.sides[1].active[1].hp = 0;
  bDrain.sides[1].active[1].fainted = true;
  bDrain.sides[1].pokemonLeft = 1;
  const adapterDrain = createEngineBoundedAdapter(bDrain, {hpOutputMode: 'distributional', progressive: false})!;
  const ctxDrain = compileContextFromBattle(bDrain);
  const rootDrain = stateFromBattle(ctxDrain, bDrain);
  const p2ActsDrain = adapterDrain.legalActions!(rootDrain, 1) as EngineActionEntry[];
  const dpAct = p2ActsDrain.find(a => a.name.includes('Drain Punch'))!;
  const tackleAct = p2ActsDrain.find(a => a.name.includes('Tackle +1'))!;
  assert.equal(dpAct.hasDrain, true, 'Drain Punch action must be tagged hasDrain=true');
  assert.equal(Boolean(tackleAct.hasDrain), false, 'Tackle action must not be tagged hasDrain=true');
  const a1Drain = (adapterDrain.legalActions!(rootDrain, 0) as EngineActionEntry[]).find(
    a => a.name.includes('Tackle +1') && a.name.includes('Protect')
  )!;
  const transDrain = adapterDrain.enumerateTurn(rootDrain, a1Drain, tackleAct);
  const condDrainBoxes = transDrain.outcomes.filter(
    o => 'split' in o && typeof o.split === 'function' &&
      (((o as MonotoneBoxOutcome).lowerReqNoFaintMask || 0) !== 0 || Boolean((o as MonotoneBoxOutcome).upperReqNoDrain))
  );
  assert.ok(condDrainBoxes.length > 0, 'expected conditional no-drain-opp box on P1 HP when foe has Drain Punch');

  // 3. Negative soundness guards: violated survive-self and no-drain-opp witnesses MUST be rejected and split.
  // Case 3a: lowerReqNoFaintMask = 1, lowerCorner proves +1.0 ONLY via an outcome with faintMask = 1,
  // while the box actually splits into [loCorner (+1.0), interior (-1.0)] (true expected value = 0.0).
  let splitFaintSide: string | undefined;
  const faintViolationAdapter: BoundedAdapter = {
    snapshotBattle: s => s,
    restoreBattle: s => s,
    stateKey: s => String((s as {id: string}).id),
    terminalUtility: () => null,
    legalActions: () => [{id: 'a', name: 'a', command: 'move 1'}],
    enumerateTurn: state => {
      const sid = (state as {id: string}).id;
      if (sid === 'root') {
        const box: MonotoneBoxOutcome = {
          probability: 1,
          lowerSnapshot: {id: 'loCorner'},
          upperSnapshot: {id: 'hiCorner'},
          lowerReqNoFaintMask: 1,
          split: (violatedSide): Outcome[] => {
            splitFaintSide = violatedSide;
            return [
              {snapshot: {id: 'loCorner'}, probability: 0.5},
              {utility: -1.0, probability: 0.5},
            ];
          },
        };
        return {outcomes: [box], simulatorRuns: 1, complete: true};
      }
      if (sid === 'loCorner') {
        return {outcomes: [{utility: 1.0, probability: 1, faintMask: 1}], simulatorRuns: 1, complete: true};
      }
      return {outcomes: [{utility: 1.0, probability: 1}], simulatorRuns: 1, complete: true};
    },
  };
  const resFaintGuard = new BoundedSolver({adapter: faintViolationAdapter, tolerance: 1e-6, maxSearchMs: 5000}).solve({id: 'root'});
  assert.equal(resFaintGuard.converged, true);
  assert.equal(splitFaintSide, 'lower', 'violated survive-self corner must report violatedSide="lower" to split()');
  assert.ok(resFaintGuard.stats.boxSplits >= 1);
  assert.ok(Math.abs(resFaintGuard.value - 0.0) < 1e-6, `expected exact split value 0.0, got ${resFaintGuard.value}`);
  assert.ok(resFaintGuard.lowerBound <= 1e-6 && resFaintGuard.upperBound >= -1e-6);

  // Case 3b: upperReqNoDrain = true, upperCorner proves -1.0 ONLY via a P2 action with hasDrain = true,
  // while the box actually splits into [hiCorner (-1.0), interior (+1.0)] (true expected value = 0.0).
  let splitDrainSide: string | undefined;
  const drainViolationAdapter: BoundedAdapter = {
    snapshotBattle: s => s,
    restoreBattle: s => s,
    stateKey: s => String((s as {id: string}).id),
    terminalUtility: () => null,
    legalActions: (state, sideIndex) =>
      (state as {id: string}).id === 'hiCorner' && sideIndex === 1
        ? [{id: 'drain', name: 'Drain', command: 'move 1', hasDrain: true}]
        : [{id: 'a', name: 'a', command: 'move 1'}],
    enumerateTurn: state => {
      const sid = (state as {id: string}).id;
      if (sid === 'root') {
        const box: MonotoneBoxOutcome = {
          probability: 1,
          lowerSnapshot: {id: 'loCorner'},
          upperSnapshot: {id: 'hiCorner'},
          upperReqNoDrain: true,
          split: (violatedSide): Outcome[] => {
            splitDrainSide = violatedSide;
            return [
              {snapshot: {id: 'hiCorner'}, probability: 0.5},
              {utility: 1.0, probability: 0.5},
            ];
          },
        };
        return {outcomes: [box], simulatorRuns: 1, complete: true};
      }
      if (sid === 'hiCorner') {
        return {outcomes: [{utility: -1.0, probability: 1}], simulatorRuns: 1, complete: true};
      }
      return {outcomes: [{utility: -1.0, probability: 1}], simulatorRuns: 1, complete: true};
    },
  };
  const resDrainGuard = new BoundedSolver({adapter: drainViolationAdapter, tolerance: 1e-6, maxSearchMs: 5000}).solve({id: 'root'});
  assert.equal(resDrainGuard.converged, true);
  assert.equal(splitDrainSide, 'upper', 'violated no-drain-opp corner must report violatedSide="upper" to split()');
  assert.ok(resDrainGuard.stats.boxSplits >= 1);
  assert.ok(Math.abs(resDrainGuard.value - 0.0) < 1e-6, `expected exact split value 0.0, got ${resDrainGuard.value}`);
  assert.ok(resDrainGuard.lowerBound <= 1e-6 && resDrainGuard.upperBound >= -1e-6);
});

test('lazy leaf interning on large matrices matches exact value, avoids allocating unvisited leaves, and respects maxNodes', () => {
  // 1. 6x6 (36 > 25 cells -> large matrix) game with saddle point at (0, 0) = +0.40.
  // Every cell produces 8 continuing leaf states, so eager interning across expanded cells would allocate dozens of nodes.
  const dim = 6;
  const actions = Array.from({length: dim}, (_, i) => i);
  const cellPayoff = (i: number, j: number) => {
    if (i === 0 && j === 0) return 0.4;
    if (i === 0) return 0.4 + 0.1 * j; // Row 0 secures >= 0.4 against all cols
    if (j === 0) return 0.4 - 0.1 * i; // Col 0 caps <= 0.4 against all rows
    return 0.4 + 0.05 * (j - i);
  };
  const largeAdapter: BoundedAdapter = {
    snapshotBattle: s => s,
    restoreBattle: s => s,
    stateKey: s => String(s),
    terminalUtility: () => null,
    legalActions: s => (s === 'root' ? actions : [0]),
    enumerateTurn: (state, a1, a2) => {
      if (state === 'root') {
        const i = Number(a1);
        const j = Number(a2);
        const outcomes = [];
        // 1 high-mass branch + 7 tiny sibling branches; with tol=0.04, unvisited leaves stay unallocated
        for (let k = 0; k < 8; k++) {
          outcomes.push({
            snapshot: `leaf:${i}:${j}:${k}`,
            probability: k === 0 ? 0.99 : 0.01 / 7,
          });
        }
        return {outcomes, simulatorRuns: 1, complete: true};
      }
      const [, si, sj] = String(state).split(':');
      return {
        outcomes: [{utility: cellPayoff(Number(si), Number(sj)), probability: 1}],
        simulatorRuns: 1,
        complete: true,
      };
    },
  };

  // With tol = 0.04, only the high-mass leaf (0.99) per needed saddle row/col needs materialization (11 cells => ~12 nodes, NOT 11*8=88!)
  const resTol = new BoundedSolver({adapter: largeAdapter, tolerance: 0.04, maxSearchMs: 5000}).solve('root');
  assert.equal(resTol.converged, true);
  assert.ok(resTol.lowerBound <= 0.4 + 1e-9 && resTol.upperBound >= 0.4 - 1e-9, `interval [${resTol.lowerBound}, ${resTol.upperBound}] must contain 0.4`);
  assert.ok(
    resTol.stats.nodes <= 20,
    `expected lazy leaf interning to keep materialized nodes small (<= 20 vs ~88 eager), got ${resTol.stats.nodes}`
  );

  // Exact convergence (tol = 1e-6) also succeeds cleanly
  const resExact = new BoundedSolver({adapter: largeAdapter, tolerance: 1e-6, maxSearchMs: 5000}).solve('root');
  assert.equal(resExact.converged, true);
  assert.ok(Math.abs(resExact.value - 0.4) < 1e-6, `expected exact 0.4, got ${resExact.value}`);
  assert.ok(resExact.lowerBound <= 0.4 + 1e-9 && resExact.upperBound >= 0.4 - 1e-9);

  // 2. maxNodes termination safety: never infinite-loops and preserves sound bounds
  const resCapped = new BoundedSolver({adapter: largeAdapter, tolerance: 1e-6, maxNodes: 3, maxSearchMs: 5000}).solve('root');
  assert.equal(resCapped.converged, false);
  assert.equal(resCapped.stopReason, 'node-limit');
  assert.ok(resCapped.stats.nodes <= 3, `expected nodes <= 3, got ${resCapped.stats.nodes}`);
  assert.ok(resCapped.lowerBound <= 0.4 + 1e-9 && resCapped.upperBound >= 0.4 - 1e-9);

  // 3. Monotone group read-only lazy query: solving one extreme leaf tightens 9 lazy siblings without interning them
  const monoLargeAdapter: BoundedAdapter = {
    snapshotBattle: s => s,
    restoreBattle: s => s,
    stateKey: s => String(s),
    terminalUtility: () => null,
    legalActions: s => (s === 'root' ? actions : [0]),
    monotoneSignature: s => {
      if (s === 'root') return null;
      const [, si, sj, sk] = String(s).split(':');
      const i = Number(si);
      const j = Number(sj);
      const k = Number(sk);
      // Higher k => higher P1 HP => monotonically higher value (all leaves in cell (i,j) share groupKey)
      return {groupKey: `g:${i}:${j}`, h1: k + 1, h2: null};
    },
    enumerateTurn: (state, a1, a2) => {
      if (state === 'root') {
        const i = Number(a1);
        const j = Number(a2);
        const outcomes = [];
        // Put slightly more probability on k=0 (the minimum h1 corner) so it is selected first;
        // once k=0 proves +1.0 (for Row 0), all k=1..9 lazy leaves tighten to +1.0 via _queryLazySnapshot without interning!
        for (let k = 0; k < 10; k++) {
          outcomes.push({
            snapshot: `m:${i}:${j}:${k}`,
            probability: k === 0 ? 0.19 : 0.09,
          });
        }
        return {outcomes, simulatorRuns: 1, complete: true};
      }
      const [, si] = String(state).split(':');
      const val = Number(si) === 0 ? 1.0 : -1.0;
      return {outcomes: [{utility: val, probability: 1}], simulatorRuns: 1, complete: true};
    },
  };
  const resMonoLazy = new BoundedSolver({adapter: monoLargeAdapter, tolerance: 1e-6, maxSearchMs: 5000}).solve('root');
  assert.equal(resMonoLazy.converged, true);
  assert.ok(Math.abs(resMonoLazy.value - 1.0) < 1e-6, `expected exact +1.0, got ${resMonoLazy.value}`);
  // Row 0 has 6 cells x 10 outcomes = 60 leaves; only 1 extreme leaf per cell (6 leaves + root = 7 nodes) should materialize!
  assert.ok(
    resMonoLazy.stats.nodes <= 12,
    `expected monotone lazy queries to resolve 9/10 siblings without interning (<= 12 nodes vs 61 eager), got ${resMonoLazy.stats.nodes}`
  );
});

test('joint (conditional-HP x PP-horizon) dominance pushes bounds into lazy outcomes and blocks violated/low-PP/Fake-Out transfers', () => {
  // 1. Engine-backed jointMonoPpSignature verifies survive-self (bench > 0), Fake Out turn0Mask separation,
  //    and Endure exclusion on conditional axes.
  const bJoint = createChampionsModBattle(
    [
      makeMon({species: 'Incineroar', ability: 'Intimidate', moves: ['Fake Out', 'Flare Blitz']}),
      makeMon({species: 'Dragonite', ability: 'Inner Focus', moves: ['Dragon Claw']}),
    ],
    [makeMon({species: 'Snorlax', ability: 'Immunity', moves: ['Body Slam', 'Protect']})]
  );
  const ctxJoint = compileContextFromBattle(bJoint);
  const sT0 = stateFromBattle(ctxJoint, bJoint);
  sT0.sides[0].pokemon[0].activeTurns = 0;
  sT0.sides[1].pokemon[0].activeTurns = 1;
  const sT1 = cloneState(sT0);
  sT1.sides[0].pokemon[0].activeTurns = 1;
  const sT1AltHpPp = cloneState(sT1);
  sT1AltHpPp.sides[0].pokemon[0].hp = Math.max(1, sT1.sides[0].pokemon[0].hp - 20);
  sT1AltHpPp.sides[1].pokemon[0].pp[0] = Math.max(5, sT1.sides[1].pokemon[0].pp[0] - 2);

  const adapterJoint = createEngineBoundedAdapter(bJoint, {hpOutputMode: 'distributional', progressive: false})!;
  const sigT0 = adapterJoint.jointMonoPpSignature!(sT0);
  const sigT1 = adapterJoint.jointMonoPpSignature!(sT1);
  const sigT1Alt = adapterJoint.jointMonoPpSignature!(sT1AltHpPp);
  assert.ok(sigT0 && sigT1 && sigT1Alt, 'expected jointMonoPpSignature on turn states');
  assert.notEqual(sigT0.groupKey, sigT1.groupKey, 'Fake Out activeTurns === 0 must not share joint groupKey with activeTurns >= 1');
  assert.equal(sigT1.groupKey, sigT1Alt.groupKey, 'states differing only in survive-self HP and PP must share joint groupKey');

  // 2. Zero-node push into unmaterialized lazy outcomes across BOTH HP and PP on a 6x6 large matrix,
  //    while rejecting transfers that violate survive-self faintMask, no-drain-opp drain, or PP horizon.
  const dim = 6;
  const actions = Array.from({length: dim}, (_, k) => k);
  // Leaves encode "j:<row>:<col>:<hp>:<pp>:<mode>:<faint>:<drain>"
  // Row 0 wins (+1) cleanly from hp=50, pp=10 with mode=2 (survive-self) and faint=0;
  // its 9 lazy siblings have higher hp (51..59) and lower pp (8 >= depth=1) -> must tighten via push watcher without interning!
  const makeJointLazyAdapter = (
    witnessFaint: number,
    witnessDrain: boolean,
    siblingPp: number,
    mode: 0 | 1 | 2,
    siblingSide: 0 | 1
  ): BoundedAdapter => ({
    snapshotBattle: s => s,
    restoreBattle: s => s,
    stateKey: s => String(s),
    terminalUtility: () => null,
    legalActions: (s, side) => {
      if (s === 'root') return actions;
      if (side === 0 && witnessDrain) return [{id: 'drain', name: 'Drain', command: 'move 1', hasDrain: true}];
      return [{id: 'atk', name: 'Atk', command: 'move 1'}];
    },
    jointMonoPpSignature: (s): JointMonoPpSignature | null => {
      if (s === 'root') return null;
      const parts = String(s).split(':');
      const r = Number(parts[1]);
      const c = Number(parts[2]);
      const hp = Number(parts[3]);
      const pp = Number(parts[4]);
      return {
        groupKey: `jg:${r}:${c}`,
        vec: [siblingSide === 0 ? hp : -hp],
        sides: [siblingSide],
        bits: [1 << (siblingSide * 6)],
        modes: [mode],
        pp: [pp],
        maxPpLossPerTurn: 1,
      };
    },
    enumerateTurn: (state, a1, a2) => {
      if (state === 'root') {
        const i = Number(a1);
        const j = Number(a2);
        if (i === 0) {
          const outs: Outcome[] = [];
          // k=0 has slightly higher mass (0.19) so solver expands k=0 first;
          // k=1..9 have better HP (higher for side 0, lower for side 1) and pp=siblingPp.
          for (let k = 0; k < 10; k++) {
            const hp = siblingSide === 0 ? 50 + k : 50 - k;
            const pp = k === 0 ? 10 : siblingPp;
            outs.push({snapshot: `j:${i}:${j}:${hp}:${pp}` as any, probability: k === 0 ? 0.19 : 0.09});
          }
          return {outcomes: outs, simulatorRuns: 1, complete: true};
        }
        return {outcomes: [{utility: -1.0, probability: 1}], simulatorRuns: 1, complete: true};
      }
      const parts = String(state).split(':');
      const hp = Number(parts[3]);
      // For negative guard tests, make sibling HPs actually return -1.0 so any false transfer would break soundness!
      const isWitness = hp === 50;
      const utility = isWitness ? 1.0 : (witnessFaint || witnessDrain || siblingPp <= 1 || (mode === 2 && siblingSide === 1) ? -1.0 : 1.0);
      return {
        outcomes: [{utility, probability: 1, ...(isWitness && witnessFaint ? {faintMask: witnessFaint} : {})}],
        simulatorRuns: 1,
        complete: true,
      };
    },
  });

  // 2a. Clean survive-self P1 HP increase + sufficient PP (siblingPp=8 > depth=1) -> pushes into all 9 lazy siblings!
  const resClean = new BoundedSolver({
    adapter: makeJointLazyAdapter(0, false, 8, 2, 0),
    tolerance: 1e-6,
    maxSearchMs: 5000,
  }).solve('root');
  assert.equal(resClean.converged, true);
  assert.ok(Math.abs(resClean.value - 1.0) < 1e-6);
  assert.ok(resClean.stats.nodes <= 12, `expected joint lazy watchers to avoid interning siblings (<= 12 nodes), got ${resClean.stats.nodes}`);
  assert.ok(resClean.stats.ppBoundUpdates > 0, 'expected joint HPxPP bound updates > 0');

  // 2b. Negative guard: violated survive-self faintMask (bit 0 = 1) MUST NOT transfer to higher P1 HP!
  const resViolFaint = new BoundedSolver({
    adapter: makeJointLazyAdapter(1, false, 8, 2, 0),
    tolerance: 1e-6,
    maxSearchMs: 5000,
  }).solve('root');
  assert.equal(resViolFaint.converged, true);
  // True value of row 0 is 0.19*(+1) + 0.81*(-1) = -0.62
  assert.ok(Math.abs(resViolFaint.value - (-0.62)) < 1e-5, `violated faintMask must not falsely transfer; expected -0.62, got ${resViolFaint.value}`);

  // 2c. Negative guard: survive-self (mode=2) on P2 (side=1) MUST NOT transfer lower bound to lower P2 HP!
  const resSurviveOpp = new BoundedSolver({
    adapter: makeJointLazyAdapter(0, false, 8, 2, 1),
    tolerance: 1e-6,
    maxSearchMs: 5000,
  }).solve('root');
  assert.equal(resSurviveOpp.converged, true);
  assert.ok(Math.abs(resSurviveOpp.value - (-0.62)) < 1e-5, `survive-self must forbid decreasing opp HP; expected -0.62, got ${resSurviveOpp.value}`);

  // 2d. Negative guard: violated no-drain-opp (mode=1, side=1, usedDrain=true) MUST NOT transfer!
  const resViolDrain = new BoundedSolver({
    adapter: makeJointLazyAdapter(0, true, 8, 1, 1),
    tolerance: 1e-6,
    maxSearchMs: 5000,
  }).solve('root');
  assert.equal(resViolDrain.converged, true);
  assert.ok(Math.abs(resViolDrain.value - (-0.62)) < 1e-5, `violated usedDrain must not transfer; expected -0.62, got ${resViolDrain.value}`);

  // 2e. Negative guard: insufficient PP horizon (siblingPp=1 <= depth=1) MUST NOT transfer!
  const resLowPp = new BoundedSolver({
    adapter: makeJointLazyAdapter(0, false, 1, 0, 0),
    tolerance: 1e-6,
    maxSearchMs: 5000,
  }).solve('root');
  assert.equal(resLowPp.converged, true);
  assert.ok(Math.abs(resLowPp.value - (-0.62)) < 1e-5, `low PP sibling (pp=1 <= depth=1) must not receive transfer; expected -0.62, got ${resLowPp.value}`);
});

test('asymmetric double-Protect (s0, s1), equal-Tailwind, inert-Terrain, and tail-bucket Protect contraction match uncontracted exact solves and fail closed', () => {
  // 1. Asymmetric double-Protect (1, 2) and (2, 1) parity vs uncontracted exact solve:
  const bAsym = createChampionsModBattle(
    [
      makeMon({species: 'Alakazam', ability: 'Inner Focus', moves: ['Dazzling Gleam']}),
      makeMon({species: 'Jolteon', ability: 'Volt Absorb', moves: ['Swift']}),
    ],
    [
      makeMon({species: 'Snorlax', ability: 'Immunity', moves: ['Protect', 'Tackle']}),
      makeMon({species: 'Torkoal', ability: 'White Smoke', moves: ['Protect', 'Tackle']}),
    ],
    {doubles: true}
  );
  for (const side of bAsym.sides) {
    for (const p of side.active) p.activeTurns = 1;
  }
  bAsym.sides[1].active[0].hp = 1;
  bAsym.sides[1].active[1].hp = 1;
  const ctxAsym = compileContextFromBattle(bAsym);
  const adapterAsym = createEngineBoundedAdapter(bAsym, {hpOutputMode: 'distributional', progressive: false})!;
  const sAsym12 = stateFromBattle(ctxAsym, bAsym);
  sAsym12.sides[1].pokemon[0].protectStreak = 1;
  sAsym12.sides[1].pokemon[1].protectStreak = 2;
  const infoAsym = adapterAsym.protectContractionInfo!(sAsym12);
  assert.ok(infoAsym, 'asymmetric double-Protect (1, 2) must be eligible');
  assert.equal(infoAsym.stallSlotsCount, 2);
  assert.equal(infoAsym.streak, 1);
  assert.deepEqual(infoAsym.streaks, [1, 2]);
  const p2ActsAsym = adapterAsym.legalActions!(sAsym12, 1) as EngineActionEntry[];
  const mask0Only = p2ActsAsym.find(a => a.name.startsWith('Protect,') && !a.name.endsWith('Protect'))!;
  const mask1Only = p2ActsAsym.find(a => !a.name.startsWith('Protect,') && a.name.endsWith('Protect'))!;
  const maskBoth = p2ActsAsym.find(a => a.name === 'Protect, Protect')!;
  assert.equal(infoAsym.stallActionMask!(mask0Only), 1);
  assert.equal(infoAsym.stallActionMask!(mask1Only), 2);
  assert.equal(infoAsym.stallActionMask!(maskBoth), 3);

  // Build a non-root solve starting at (0, 1) so (Protect, Protect) immediately visits (1, 2) and contracts it!
  const sStart01 = stateFromBattle(ctxAsym, bAsym);
  sStart01.sides[1].pokemon[0].protectStreak = 0;
  sStart01.sides[1].pokemon[1].protectStreak = 1;
  const uncontractedAsym: BoundedAdapter = {...adapterAsym, protectContractionInfo: undefined};
  const resAsymCont = new BoundedSolver({adapter: adapterAsym, tolerance: 0.02, maxSearchMs: 5000}).solve(sStart01);
  const resAsymExact = new BoundedSolver({adapter: uncontractedAsym, tolerance: 0.02, maxSearchMs: 5000}).solve(sStart01);
  assert.equal(resAsymCont.converged, true);
  assert.equal(resAsymExact.converged, true);
  assert.ok(resAsymCont.stats.protectContractions > 0, 'expected asymmetric double-Protect contraction to fire');
  assert.ok(
    resAsymCont.lowerBound <= resAsymExact.upperBound + 1e-6 &&
    resAsymExact.lowerBound <= resAsymCont.upperBound + 1e-6,
    `asymmetric contracted [${resAsymCont.lowerBound}, ${resAsymCont.upperBound}] must agree with exact [${resAsymExact.lowerBound}, ${resAsymExact.upperBound}]`
  );

  // 2. Equal positive Tailwind (tw0 === tw1 = 3) contraction parity + negative guards:
  const bEqTw = createChampionsModBattle(
    [makeMon({species: 'Jolteon', ability: 'Volt Absorb', moves: ['Air Slash', 'Tailwind']})],
    [makeMon({species: 'Snorlax', ability: 'Immunity', moves: ['Protect', 'Tackle']})]
  );
  bEqTw.sides[0].active[0].hp = 1;
  bEqTw.sides[1].active[0].hp = 1;
  bEqTw.sides[0].active[0].activeTurns = 1;
  bEqTw.sides[1].active[0].activeTurns = 1;
  const ctxEqTw = compileContextFromBattle(bEqTw);
  const sEqTw = stateFromBattle(ctxEqTw, bEqTw);
  sEqTw.sides[0].tailwindTurns = 3;
  sEqTw.sides[1].tailwindTurns = 3;
  const adapterEqTw = createEngineBoundedAdapter(bEqTw, {hpOutputMode: 'distributional', progressive: false})!;
  const sEqTwCheck = cloneState(sEqTw);
  sEqTwCheck.sides[1].pokemon[0].protectStreak = 1;
  const infoEqTw = adapterEqTw.protectContractionInfo!(sEqTwCheck);
  assert.ok(infoEqTw && infoEqTw.equalTailwind, 'equal positive Tailwind (3 === 3) with safe speeds must be eligible');
  const p1TwActs = adapterEqTw.legalActions!(sEqTwCheck, 0) as EngineActionEntry[];
  assert.equal(infoEqTw.isOpponentActionEligible(p1TwActs.find(a => a.name.includes('Tailwind'))!), false, 'opponent Tailwind action must be ineligible under equalTailwind');
  assert.equal(infoEqTw.isOpponentActionEligible(p1TwActs.find(a => a.name.includes('Air Slash'))!), true);

  const resEqTwCont = new BoundedSolver({adapter: adapterEqTw, tolerance: 2e-3, maxSearchMs: 5000}).solve(sEqTw);
  const resEqTwExact = new BoundedSolver({adapter: {...adapterEqTw, protectContractionInfo: undefined}, tolerance: 2e-3, maxSearchMs: 5000}).solve(sEqTw);
  assert.equal(resEqTwCont.converged, true);
  assert.equal(resEqTwExact.converged, true);
  assert.ok(resEqTwCont.stats.protectContractions > 0, 'expected equal-Tailwind Protect contraction to fire');
  assert.ok(
    resEqTwCont.lowerBound <= resEqTwExact.upperBound + 1e-6 &&
    resEqTwExact.lowerBound <= resEqTwCont.upperBound + 1e-6,
    `equal-Tailwind contracted [${resEqTwCont.lowerBound}, ${resEqTwCont.upperBound}] must match exact [${resEqTwExact.lowerBound}, ${resEqTwExact.upperBound}]`
  );

  // Negative guard: stalling side having Tailwind disables equal-Tailwind contraction
  const bStallTw = createChampionsModBattle(
    [makeMon({species: 'Jolteon', ability: 'Volt Absorb', moves: ['Air Slash']})],
    [makeMon({species: 'Pelipper', ability: 'Keen Eye', moves: ['Protect', 'Tailwind']})]
  );
  const ctxStallTw = compileContextFromBattle(bStallTw);
  const sStallTw = stateFromBattle(ctxStallTw, bStallTw);
  sStallTw.sides[0].tailwindTurns = 3;
  sStallTw.sides[1].tailwindTurns = 3;
  sStallTw.sides[1].pokemon[0].protectStreak = 1;
  sStallTw.sides[0].pokemon[0].activeTurns = 1;
  sStallTw.sides[1].pokemon[0].activeTurns = 1;
  assert.equal(
    createEngineBoundedAdapter(bStallTw, {hpOutputMode: 'distributional', progressive: false})!.protectContractionInfo!(sStallTw),
    null,
    'stalling side possessing Tailwind must fail closed under equalTailwind'
  );

  // 3. Inert Psychic Terrain vs non-inert Psychic Terrain guards:
  const sInertPsy = cloneState(sEqTwCheck);
  sInertPsy.sides[0].tailwindTurns = 0;
  sInertPsy.sides[1].tailwindTurns = 0;
  sInertPsy.field.terrain = 'psychic';
  sInertPsy.field.terrainTurns = 3;
  // Jolteon (Air Slash, Tailwind) vs Snorlax (Protect, Tackle): no Psychic damaging move, no opposing priority, no Terrain abilities
  assert.ok(adapterEqTw.protectContractionInfo!(sInertPsy), 'inert Psychic Terrain must allow Protect contraction');

  const bNonInertPsy = createChampionsModBattle(
    [makeMon({species: 'Jolteon', ability: 'Volt Absorb', moves: ['Quick Attack', 'Air Slash']})],
    [makeMon({species: 'Snorlax', ability: 'Immunity', moves: ['Protect', 'Tackle']})]
  );
  const ctxNonInertPsy = compileContextFromBattle(bNonInertPsy);
  const sNonInertPsy = stateFromBattle(ctxNonInertPsy, bNonInertPsy);
  sNonInertPsy.sides[0].pokemon[0].activeTurns = 1;
  sNonInertPsy.sides[1].pokemon[0].activeTurns = 1;
  sNonInertPsy.sides[1].pokemon[0].protectStreak = 1;
  sNonInertPsy.field.terrain = 'psychic';
  sNonInertPsy.field.terrainTurns = 3;
  assert.equal(
    createEngineBoundedAdapter(bNonInertPsy, {hpOutputMode: 'distributional', progressive: false})!.protectContractionInfo!(sNonInertPsy),
    null,
    'Psychic Terrain with opposing priority move (Quick Attack) must NOT be treated as inert'
  );
});

test('monotone clean-witness box cache prevents dirty-corner regression and complementary-slackness LP skip preserves exact equilibrium', () => {
  // 1. Box corner first proves clean upper bound -0.80 (faintMask=0), then later refines to dirty -1.0 (faintMask=1)
  //    violating upperReqNoFaintMask=1. The box must retain -0.80 (sound!) instead of regressing to +1.0.
  let cornerVisits = 0;
  const validBoxAdapter: BoundedAdapter = {
    snapshotBattle: s => s,
    restoreBattle: s => s,
    stateKey: s => String(s),
    terminalUtility: () => null,
    legalActions: s => (s === 'corner' ? [0, 1] : [0]),
    enumerateTurn: (state, _a1, a2) => {
      if (state === 'root') {
        const box: MonotoneBoxOutcome = {
          probability: 1,
          lowerSnapshot: null,
          upperSnapshot: 'corner' as any,
          upperReqNoFaintMask: 1,
          split: (): Outcome[] => [
            {utility: -0.9, probability: 0.5},
            {utility: -0.85, probability: 0.5},
          ],
        };
        return {outcomes: [box], simulatorRuns: 1, complete: true};
      }
      if (state === 'corner') {
        cornerVisits++;
        if (Number(a2) === 0) {
          // Clean witness: upper = -0.80, faintMask = 0
          return {outcomes: [{utility: -0.8, probability: 1}], simulatorRuns: 1, complete: true};
        }
        // Dirty witness: upper = -1.0, faintMask = 1 (violates upperReqNoFaintMask=1)
        return {outcomes: [{utility: -1.0, probability: 1, faintMask: 1}], simulatorRuns: 1, complete: true};
      }
      return {outcomes: [{utility: 0, probability: 1}], simulatorRuns: 1, complete: true};
    },
  };
  const resValidBox = new BoundedSolver({adapter: validBoxAdapter, tolerance: 1e-6, maxSearchMs: 5000}).solve('root');
  assert.equal(resValidBox.converged, true);
  assert.ok(cornerVisits >= 1);
  // True split value is -0.875; box must never falsely claim -1.0 from dirty witness!
  assert.ok(Math.abs(resValidBox.value - (-0.875)) < 1e-6, `expected exact split value -0.875, got ${resValidBox.value}`);
  assert.ok(resValidBox.lowerBound <= -0.875 + 1e-6 && resValidBox.upperBound >= -0.875 - 1e-6);

  // 2. Complementary-slackness LP skip on a 10x10 mixed game matches exact LP oracle
  const dim = 10;
  const payoff: number[][] = Array.from({length: dim}, (_, i) =>
    Array.from({length: dim}, (_, j) => {
      if (i < 2 && j < 2) return i === j ? 0.6 : -0.4; // 2x2 matching-pennies core (val = 0.1)
      if (i < 2) return 0.5 + 0.05 * j; // dominated cols for P2
      if (j < 2) return -0.5 - 0.05 * i; // dominated rows for P1
      return ((i * 7 + j * 13) % 11) / 10 - 0.5;
    })
  );
  const oracle = solveZeroSumMatrix(payoff);
  const acts = Array.from({length: dim}, (_, k) => k);
  const lpSkipAdapter: BoundedAdapter = {
    snapshotBattle: s => s,
    restoreBattle: s => s,
    stateKey: s => String(s),
    terminalUtility: () => null,
    legalActions: s => (s === 'root' ? acts : [0]),
    enumerateTurn: (s, a1, a2) => {
      if (s === 'root') {
        return {outcomes: [{snapshot: `c:${a1}:${a2}` as any, probability: 1}], simulatorRuns: 1, complete: true};
      }
      const [, si, sj] = String(s).split(':');
      return {outcomes: [{utility: payoff[Number(si)][Number(sj)], probability: 1}], simulatorRuns: 1, complete: true};
    },
  };
  const resLpSkip = new BoundedSolver({adapter: lpSkipAdapter, tolerance: 1e-5, maxSearchMs: 5000}).solve('root');
  assert.equal(resLpSkip.converged, true);
  assert.ok(
    Math.abs(resLpSkip.value - oracle.value) < 1e-4,
    `complementary-slackness LP skip value ${resLpSkip.value} must match exact LP ${oracle.value}`
  );
  assert.ok(resLpSkip.lowerBound <= oracle.value + 1e-6 && oracle.value <= resLpSkip.upperBound + 1e-6);
});


