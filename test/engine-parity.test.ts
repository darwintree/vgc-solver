import assert from 'node:assert/strict';
import test from 'node:test';
import {Battle, toID} from '@pkmn/sim';
import {
  canRunInEngine,
  canonicalStateKey,
  compareTurnWithShowdown,
  compileContextFromBattle,
  createEngineBoundedAdapter,
  expandStateHpDists,
  legalSideActions,
  parseShowdownCommand,
  stateFromBattle,
  stepBattle,
} from '../src/engine';
import {BoundedSolver} from '../src/bounded-solver';
import {
  leftoversThreeHKO,
  suckerPunchGame,
  trivialPriorityKO,
} from '../src/cases';
import {championsCases, createChampionsBattle} from '../src/champions-cases';
import {FIXED_SEED} from '../src/branching-prng';

const IVS = {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31};
const EVS = {hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0};

function makeSet(spec: {species: string; ability: string; nature: string; moves: string[]; item?: string}) {
  return {
    name: spec.species,
    species: spec.species,
    item: spec.item ?? '',
    ability: spec.ability,
    moves: spec.moves,
    nature: spec.nature,
    gender: '',
    evs: EVS,
    ivs: IVS,
    level: 50,
  };
}

function assertParity(battle: Battle, p1Cmd: string, p2Cmd: string, label: string) {
  const report = compareTurnWithShowdown(battle, p1Cmd, p2Cmd, 1e-9);
  assert.equal(
    report.exactMatch,
    true,
    `${label} parity mismatch (TVD=${report.totalVariationDistance}, maxDiff=${report.maxProbDiff})\n` +
    `missing: ${JSON.stringify(report.missingFromEngine.slice(0, 3))}\n` +
    `extra: ${JSON.stringify(report.extraInEngine.slice(0, 3))}\n` +
    `mismatches: ${JSON.stringify(report.probMismatches.slice(0, 3))}`
  );
  return report;
}

test('standard 1v1 fixtures match @pkmn/sim exact distributions', () => {
  assertParity(trivialPriorityKO().battle, 'move 1', 'move 1', 'trivialPriorityKO');
  assertParity(leftoversThreeHKO().battle, 'move 1', 'move 1', 'leftovers: Seismic Toss x Seismic Toss');
  assertParity(leftoversThreeHKO().battle, 'move 1', 'move 2', 'leftovers: Seismic Toss x Protect');
  assertParity(leftoversThreeHKO().battle, 'move 2', 'move 2', 'leftovers: Protect x Protect');

  assertParity(suckerPunchGame().battle, 'move 1', 'move 2', 'suckerPunch: Sucker Punch x Tackle');
  assertParity(suckerPunchGame().battle, 'move 1', 'move 1', 'suckerPunch: Sucker Punch x Protect');
  assertParity(suckerPunchGame().battle, 'move 2', 'move 2', 'suckerPunch: Knock Off x Tackle');
});

test('all 810 Champions fixtures across 2026-09 and 2026-11 snapshots pass engine admission', () => {
  for (const snapshotId of ['2026-09', '2026-11'] as const) {
    const supported = championsCases(snapshotId).filter(c => c.skipReasons.length === 0);
    assert.equal(supported.length, 405, `${snapshotId} playable count`);
    for (const c of supported) {
      const battle = createChampionsBattle(c);
      const report = canRunInEngine(battle);
      assert.equal(report.supported, true, `${snapshotId}/${c.id} rejected: ${report.reasons.join('; ')}`);
    }
  }
});

test('Champions matchups match @pkmn/sim exact distributions across key mechanics', () => {
  const byId = new Map(championsCases().map(c => [c.id, c]));

  // Garchomp (Focus Sash, Rough Skin, EQ/SR/Scale Shot/SD) vs Archaludon (Sitrus, Stamina, FC/DM/TB/SR)
  const ga = byId.get('garchomp-100-vs-archaludon-100')!;
  assertParity(createChampionsBattle(ga), 'move 1', 'move 1', 'Garchomp EQ x Archaludon Flash Cannon');
  assertParity(createChampionsBattle(ga), 'move 1', 'move 2', 'Garchomp EQ x Archaludon Draco Meteor');
  assertParity(createChampionsBattle(ga), 'move 4', 'move 4', 'Garchomp SD x Archaludon Stealth Rock');

  // Scale Shot multi-hit + Stamina + Sitrus (Showdown enumerateTurn explodes on 5-hit, so verify exact mass & speed + Showdown 256-sample containment)
  const bss = createChampionsBattle(ga);
  const ssCtx = compileContextFromBattle(bss);
  const ssState = stateFromBattle(ssCtx, bss);
  const ssRes = stepBattle(
    ssCtx,
    ssState,
    parseShowdownCommand(ssCtx, ssState, 0, 'move 3'),
    parseShowdownCommand(ssCtx, ssState, 1, 'move 3'),
    {mode: 'certified', hpOutputMode: 'discrete'}
  );
  assert.equal(ssRes.complete, true);
  assert.ok(Math.abs(ssRes.outcomes.reduce((s, o) => s + o.probability, 0) - 1) < 1e-12);
  assert.ok(ssRes.stats.damageBatchHits > 0);
  // Sample 64 Showdown seeds and verify EVERY realized Showdown outcome is contained in our engine's exact discrete support!
  const ssSupport = new Set(ssRes.outcomes.map(o => canonicalStateKey(ssCtx, o.state)));
  for (let seed = 1; seed <= 64; seed++) {
    const sampleBattle = createChampionsBattle(ga);
    sampleBattle.resetRNG([seed, seed + 1, seed + 2, seed + 3] as any);
    sampleBattle.makeChoices('move 3', 'move 3');
    const sampleKey = canonicalStateKey(ssCtx, stateFromBattle(ssCtx, sampleBattle));
    assert.ok(ssSupport.has(sampleKey), `Showdown Scale Shot sample seed=${seed} produced ${sampleKey} outside engine support`);
  }

  // Primarina (Sitrus, Torrent, Moonblast/Aria/Aqua Jet/Encore) vs Archaludon
  const pa = byId.get('primarina-100-vs-archaludon-100')!;
  assertParity(createChampionsBattle(pa), 'move 1', 'move 3', 'Primarina Moonblast x Archaludon Thunderbolt');
  assertParity(createChampionsBattle(pa), 'move 2', 'move 1', 'Primarina Sparkling Aria x Archaludon Flash Cannon');
  assertParity(createChampionsBattle(pa), 'move 3', 'move 2', 'Primarina Aqua Jet x Archaludon Draco Meteor');

  // Primarina vs Mimikyu (Life Orb, Disguise, Play Rough/Shadow Sneak/SD/Shadow Claw)
  const pm = byId.get('primarina-100-vs-mimikyu-100')!;
  assertParity(createChampionsBattle(pm), 'move 1', 'move 1', 'Primarina Moonblast x Mimikyu Play Rough');
  assertParity(createChampionsBattle(pm), 'move 4', 'move 3', 'Primarina Encore x Mimikyu Swords Dance');
  assertParity(createChampionsBattle(pm), 'move 2', 'move 4', 'Primarina Aria x Mimikyu Shadow Claw');

  // Garchomp vs Mimikyu (Focus Sash + Rough Skin vs Disguise + Life Orb + contact)
  const gm = byId.get('garchomp-100-vs-mimikyu-100')!;
  assertParity(createChampionsBattle(gm), 'move 1', 'move 1', 'Garchomp EQ x Mimikyu Play Rough');
});

test('multi-turn Encore, Protect stall decay, and Sitrus/Torrent thresholds match @pkmn/sim', () => {
  const byId = new Map(championsCases().map(c => [c.id, c]));
  // Turn 1: Primarina Encore vs Mimikyu Swords Dance -> Turn 2: Mimikyu locked into Swords Dance!
  const b = createChampionsBattle(byId.get('primarina-100-vs-mimikyu-100')!);
  b.makeChoices('move 4', 'move 3');
  assertParity(b, 'move 1', 'move 3', 'Encore turn 2: Moonblast x encored SD');

  // Low HP Primarina triggers Torrent (<= 1/3 maxhp) and start-of-turn Sitrus Berry
  const bLow = createChampionsBattle(byId.get('primarina-25-vs-archaludon-50')!);
  assertParity(bLow, 'move 2', 'move 1', 'Torrent Sparkling Aria x Flash Cannon');

  // Protect stall decay (consecutive Protect has 1/3 chance)
  const lp = leftoversThreeHKO().battle;
  lp.p1.active[0].moveSlots[1].pp = 5;
  lp.p2.active[0].moveSlots[1].pp = 5;
  lp.makeChoices('move 2', 'move 1');
  assertParity(lp, 'move 2', 'move 1', 'Consecutive Protect 1/3 decay');
});

test('switching, Stealth Rock, Intimidate, and U-turn mid-turn pause match @pkmn/sim', () => {
  const battle = new Battle({
    formatid: toID('gen9customgame'),
    debug: true,
    strictChoices: true,
    seed: FIXED_SEED,
    p1: {
      name: 'P1',
      team: [
        makeSet({species: 'Dragapult', ability: 'Natural Cure', nature: 'Jolly', moves: ['U-turn', 'Quick Attack']}),
        makeSet({species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly', moves: ['Earthquake', 'Stealth Rock']}),
      ],
    },
    p2: {
      name: 'P2',
      team: [
        makeSet({species: 'Archaludon', ability: 'Stamina', nature: 'Modest', moves: ['Flash Cannon', 'Stealth Rock']}),
        makeSet({species: 'Incineroar', ability: 'Intimidate', nature: 'Careful', moves: ['Knock Off', 'Flare Blitz']}),
      ],
    },
  });
  battle.makeChoices('team 12', 'team 12');

  // Voluntary switch into Intimidate
  assertParity(battle, 'move 2', 'switch 2', 'Quick Attack x switch into Intimidate');

  // Stealth Rock then switch into Stealth Rock
  battle.makeChoices('move 2', 'move 2'); // P2 sets Stealth Rock
  assertParity(battle, 'switch 2', 'move 1', 'Switch into Stealth Rock');

  // U-turn mid-turn pause: P1 Scizor U-turns -> pauses for P1 switch, then P2 acts!
  const ctx = compileContextFromBattle(battle);
  const st0 = stateFromBattle(ctx, battle);
  const step1 = stepBattle(
    ctx,
    st0,
    parseShowdownCommand(ctx, st0, 0, 'move 1'),
    parseShowdownCommand(ctx, st0, 1, 'move 1'),
    {mode: 'certified', hpOutputMode: 'discrete'}
  );
  assert.equal(step1.complete, true);
  assert.ok(step1.outcomes.length > 0);
  // Every surviving U-turn outcome must pause in switch phase with P2's Flash Cannon still queued!
  for (const o of step1.outcomes) {
    assert.equal(o.state.phase.kind, 'switch');
    if (o.state.phase.kind === 'switch') {
      assert.deepEqual(o.state.phase.pendingSlots, [{side: 0, slot: 0}]);
      assert.equal(o.state.phase.remainingActions.length, 1);
      assert.equal(o.state.phase.remainingActions[0].side, 1);
      // Resume with P1 switching to Garchomp (index 1)
      const step2 = stepBattle(
        ctx,
        o.state,
        [{kind: 'switch', slot: 0, benchIndex: 1}],
        [{kind: 'pass', slot: 0}],
        {mode: 'certified', hpOutputMode: 'discrete'}
      );
      assert.equal(step2.complete, true);
      assert.ok(step2.outcomes.every(r => r.state.phase.kind === 'turn' || r.state.phase.kind === 'ended'));
      assert.ok(Math.abs(step2.outcomes.reduce((s, r) => s + r.probability, 0) - 1) < 1e-12);
    }
  }
});

test('doubles 2v2 spread damage, targeting, Protect, and redirection match @pkmn/sim', () => {
  const battle = new Battle({
    formatid: toID('gen9doublescustomgame'),
    debug: true,
    strictChoices: true,
    seed: FIXED_SEED,
    p1: {
      name: 'P1',
      team: [
        makeSet({species: 'Primarina', ability: 'Torrent', nature: 'Modest', moves: ['Dazzling Gleam', 'Moonblast', 'Protect']}),
        makeSet({species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly', moves: ['Earthquake', 'Protect']}),
      ],
    },
    p2: {
      name: 'P2',
      team: [
        makeSet({species: 'Archaludon', ability: 'Stamina', nature: 'Modest', moves: ['Flash Cannon', 'Protect']}),
        makeSet({species: 'Mimikyu', ability: 'Disguise', nature: 'Adamant', moves: ['Shadow Sneak', 'Protect']}),
      ],
    },
  });
  battle.makeChoices('team 12', 'team 12');

  // Verify legal doubles action generation works
  const ctx = compileContextFromBattle(battle);
  const st = stateFromBattle(ctx, battle);
  assert.ok(legalSideActions(ctx, st, 0).length > 4);

  // Exact Showdown parity on doubles spread + Protect + priority targeting
  assertParity(battle, 'move 1, move 2', 'move 2, move 2', 'Doubles: Dazzling Gleam + Protect vs Protect + Protect');
  assertParity(battle, 'move 2 +2, move 2', 'move 2, move 1 +1', 'Doubles: Moonblast + Protect vs Protect + Shadow Sneak');
  // 2-target spread hit (Dazzling Gleam hits both foes at 0.75x): verify 64 Showdown seeds all fall inside exact engine support!
  const spreadRes = stepBattle(
    ctx,
    st,
    parseShowdownCommand(ctx, st, 0, 'move 1, move 2'),
    parseShowdownCommand(ctx, st, 1, 'move 1 +1, move 1 +1'),
    {mode: 'certified', hpOutputMode: 'discrete'}
  );
  assert.equal(spreadRes.complete, true);
  assert.ok(Math.abs(spreadRes.outcomes.reduce((s, o) => s + o.probability, 0) - 1) < 1e-12);
  const spreadSupport = new Set(spreadRes.outcomes.map(o => canonicalStateKey(ctx, o.state)));
  for (let seed = 1; seed <= 64; seed++) {
    const sb = new Battle({
      formatid: toID('gen9doublescustomgame'),
      debug: true,
      strictChoices: true,
      seed: [seed, seed + 1, seed + 2, seed + 3] as any,
      p1: {
        name: 'P1',
        team: [
          makeSet({species: 'Primarina', ability: 'Torrent', nature: 'Modest', moves: ['Dazzling Gleam', 'Moonblast', 'Protect']}),
          makeSet({species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly', moves: ['Earthquake', 'Protect']}),
        ],
      },
      p2: {
        name: 'P2',
        team: [
          makeSet({species: 'Archaludon', ability: 'Stamina', nature: 'Modest', moves: ['Flash Cannon', 'Protect']}),
          makeSet({species: 'Mimikyu', ability: 'Disguise', nature: 'Adamant', moves: ['Shadow Sneak', 'Protect']}),
        ],
      },
    });
    sb.makeChoices('team 12', 'team 12');
    sb.makeChoices('move 1, move 2', 'move 1 +1, move 1 +1');
    const key = canonicalStateKey(ctx, stateFromBattle(ctx, sb));
    assert.ok(spreadSupport.has(key), `Doubles 2-target spread sample seed=${seed} produced ${key} outside engine support`);
  }
});

test('compute, certified (with deadline remainingMass), pruned, and distributional modes remain consistent', () => {
  const byId = new Map(championsCases().map(c => [c.id, c]));
  const battle = createChampionsBattle(byId.get('primarina-100-vs-archaludon-100')!);
  const ctx = compileContextFromBattle(battle);
  const st = stateFromBattle(ctx, battle);
  const a1 = parseShowdownCommand(ctx, st, 0, 'move 1'); // Moonblast
  const a2 = parseShowdownCommand(ctx, st, 1, 'move 3'); // Thunderbolt

  // 1. Exact discrete vs distributional -> expanding distributional must yield identical discrete distribution!
  const discreteRes = stepBattle(ctx, st, a1, a2, {mode: 'certified', hpOutputMode: 'discrete'});
  const distRes = stepBattle(ctx, st, a1, a2, {mode: 'certified', hpOutputMode: 'distributional'});
  assert.equal(discreteRes.complete, true);
  assert.equal(distRes.complete, true);
  assert.ok(
    distRes.outcomes.length < discreteRes.outcomes.length,
    `Expected distributional mode (${distRes.outcomes.length}) to be far more compact than discrete (${discreteRes.outcomes.length})`
  );

  const expandedMap = new Map<string, number>();
  for (const o of distRes.outcomes) {
    for (const d of expandStateHpDists(o)) {
      const k = canonicalStateKey(ctx, d.state);
      expandedMap.set(k, (expandedMap.get(k) ?? 0) + d.probability);
    }
  }
  const discreteMap = new Map(discreteRes.outcomes.map(o => [canonicalStateKey(ctx, o.state), o.probability]));
  assert.equal(expandedMap.size, discreteMap.size);
  for (const [k, p] of discreteMap) {
    assert.ok(Math.abs((expandedMap.get(k) ?? 0) - p) < 1e-12);
  }

  // 2. Certified mode with expired deadline preserves probability conservation: sum(outcomes) + remainingMass === 1
  const expiredRes = stepBattle(ctx, st, a1, a2, {mode: 'certified', deadline: performance.now() - 1});
  assert.equal(expiredRes.complete, false);
  const sumExpired = expiredRes.outcomes.reduce((s, o) => s + o.probability, 0) + expiredRes.remainingMass;
  assert.ok(Math.abs(sumExpired - 1) < 1e-12);

  // 3. Pruned mode (cap 8, non-renormalized) conserves mass; renormalized sums to 1
  const prunedRaw = stepBattle(ctx, st, a1, a2, {mode: 'pruned', maxBranches: 8, renormalize: false});
  assert.ok(prunedRaw.outcomes.length <= 8);
  const sumPruned = prunedRaw.outcomes.reduce((s, o) => s + o.probability, 0) + prunedRaw.remainingMass;
  assert.ok(Math.abs(sumPruned - 1) < 1e-12);

  const prunedRenorm = stepBattle(ctx, st, a1, a2, {mode: 'pruned', maxBranches: 8, renormalize: true});
  assert.equal(prunedRenorm.remainingMass, 0);
  assert.ok(Math.abs(prunedRenorm.outcomes.reduce((s, o) => s + o.probability, 0) - 1) < 1e-12);

  // 4. Compute mode returns a single timeline that lies inside the exact discrete support
  let seed = 42;
  const deterministicRng = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  for (let i = 0; i < 20; i++) {
    const comp = stepBattle(ctx, st, a1, a2, {mode: 'compute', rng: deterministicRng});
    assert.equal(comp.outcomes.length, 1);
    assert.equal(comp.outcomes[0].probability, 1);
    const k = canonicalStateKey(ctx, comp.outcomes[0].state);
    assert.ok(discreteMap.has(k), `Compute outcome ${k} not found in exact discrete support`);
  }
});

test('BoundedSolver backed by compact engine adapter matches exact reference values', () => {
  // 1. Trivial priority KO: +1
  {
    const {battle} = trivialPriorityKO();
    const adapter = createEngineBoundedAdapter(battle);
    assert.ok(adapter);
    const res = new BoundedSolver({adapter, tolerance: 1e-6, maxSearchMs: 5000}).solve(battle);
    assert.equal(res.converged, true);
    assert.ok(Math.abs(res.value - 1) < 1e-6);
  }

  // 2. Leftovers + Protect 3HKO: 0 by symmetry
  {
    const {battle} = leftoversThreeHKO();
    const adapter = createEngineBoundedAdapter(battle);
    assert.ok(adapter);
    const res = new BoundedSolver({adapter, tolerance: 0.001, maxSearchMs: 5000}).solve(battle);
    assert.equal(res.converged, true);
    assert.ok(res.lowerBound <= 1e-9 && res.upperBound >= -1e-9);
  }

  // 3. Full-PP Sucker Punch endgame: exact value 0.601097268633219
  {
    const exactValue = 0.601097268633219;
    const {battle} = suckerPunchGame();
    const adapter = createEngineBoundedAdapter(battle);
    assert.ok(adapter);
    const res = new BoundedSolver({adapter, tolerance: 0.02, maxSearchMs: 5000}).solve(battle);
    assert.equal(res.converged, true);
    assert.ok(res.lowerBound <= exactValue + 1e-9, `lower ${res.lowerBound} > exact ${exactValue}`);
    assert.ok(res.upperBound >= exactValue - 1e-9, `upper ${res.upperBound} < exact ${exactValue}`);
  }
});

test('Champions parity: Flower Trick (willCrit), Meowscarada, Hippowdon, and 2026-11 Mega Z sets match Showdown', () => {
  const cases09 = championsCases('2026-09');
  const cases11 = championsCases('2026-11');
  const find09 = (id: string) => {
    const c = cases09.find(x => x.id === id);
    assert.ok(c, `Missing 2026-09 case ${id}`);
    return c;
  };
  const find11 = (id: string) => {
    const c = cases11.find(x => x.id === id);
    assert.ok(c, `Missing 2026-11 case ${id}`);
    return c;
  };

  const probes: Array<{label: string; battle: Battle; p1: string; p2: string}> = [
    {
      label: 'Meowscarada Flower Trick (willCrit) vs Hippowdon Yawn',
      battle: createChampionsBattle(find09('meowscarada-100-vs-hippowdon-100')),
      p1: 'move 2',
      p2: 'move 2',
    },
    {
      label: 'Meowscarada Triple Axel vs Hippowdon Slack Off',
      battle: createChampionsBattle(find09('meowscarada-100-vs-hippowdon-100')),
      p1: 'move 1',
      p2: 'move 4',
    },
    {
      label: 'Garchomp-MZ Mega Outrage vs Hippowdon Slack Off',
      battle: createChampionsBattle(find11('garchomp-100-vs-hippowdon-100')),
      p1: 'move 3 mega',
      p2: 'move 4',
    },
    {
      label: 'Lucario-MZ Mega Close Combat vs Golisopod-M Mega First Impression',
      battle: createChampionsBattle(find11('lucario-100-vs-golisopod-100')),
      p1: 'move 1 mega',
      p2: 'move 1 mega',
    },
    {
      label: 'Charizard-MY Mega Solar Beam vs Basculegion Wave Crash',
      battle: createChampionsBattle(find11('charizard-100-vs-basculegion-100')),
      p1: 'move 2 mega',
      p2: 'move 1',
    },
    {
      label: 'Basculegion Aqua Jet vs Salamence-M Mega Double-Edge',
      battle: createChampionsBattle(find11('basculegion-100-vs-salamence-100')),
      p1: 'move 3',
      p2: 'move 1 mega',
    },
  ];

  for (const probe of probes) {
    const res = compareTurnWithShowdown(probe.battle, probe.p1, probe.p2);
    assert.equal(res.missingFromEngine.length, 0, `${probe.label}: missing ${res.missingFromEngine.slice(0, 3).join(', ')}`);
    assert.equal(res.extraInEngine.length, 0, `${probe.label}: extra ${res.extraInEngine.slice(0, 3).join(', ')}`);
    assert.ok(res.totalVariationDistance < 1e-8, `${probe.label}: TVD=${res.totalVariationDistance}`);
  }
});

test('Outrage lockedmove multi-turn lifecycle matches Showdown exactly (T1, T2 2/3-turn, T3 confusion, Fairy immunity, Protect disruption)', () => {
  function makeOutrageBattle(seed: [number, number, number, number], p2Moves = ['Protect', 'Slack Off']) {
    const b = new Battle({
      formatid: toID('gen9customgame'),
      seed: `${seed[0]},${seed[1]},${seed[2]},${seed[3]}`,
      p1: {
        name: 'P1',
        team: [{
          name: 'Garchomp',
          species: 'Garchomp',
          item: '',
          ability: 'Rough Skin',
          moves: ['Outrage', 'Earthquake'],
          nature: 'Jolly',
          gender: '',
          evs: {hp: 0, atk: 252, def: 0, spa: 0, spd: 0, spe: 252},
          ivs: IVS,
          level: 50,
        }],
      },
      p2: {
        name: 'P2',
        team: [{
          name: 'Hippowdon',
          species: 'Hippowdon',
          item: '',
          ability: 'Sand Force',
          moves: p2Moves,
          nature: 'Impish',
          gender: '',
          evs: {hp: 252, atk: 0, def: 252, spa: 0, spd: 0, spe: 0},
          ivs: IVS,
          level: 50,
        }],
      },
    });
    b.makeChoices('default', 'default');
    return b;
  }

  // Turn 1 vs Slack Off and Turn 1 vs Protect
  for (const [label, p2Choice] of [['T1 vs Slack Off', 'move 2'], ['T1 vs Protect', 'move 1']] as const) {
    const res = compareTurnWithShowdown(makeOutrageBattle([1, 2, 3, 4]), 'move 1', p2Choice);
    assert.equal(res.missingFromEngine.length, 0, `${label}: missing`);
    assert.equal(res.extraInEngine.length, 0, `${label}: extra`);
    assert.ok(res.totalVariationDistance < 1e-8, `${label}: TVD=${res.totalVariationDistance}`);
  }

  // Turn 2 (both trueDuration=1 2-turn end & trueDuration=2 3-turn continuation), Turn 3 end, and Protect disruption
  const seenSlackOff = new Set<number>();
  const seenProtect = new Set<number>();
  let checkedT3 = false;
  for (let seed = 1; seed <= 60 && (seenSlackOff.size < 2 || seenProtect.size < 2 || !checkedT3); seed++) {
    const b1 = makeOutrageBattle([seed, seed + 1, seed + 2, seed + 3]);
    b1.makeChoices('move 1', 'move 2');
    const lm = b1.sides[0].active[0].volatiles.lockedmove as {duration?: number; trueDuration?: number} | undefined;
    if (!lm?.trueDuration) continue;

    if (!seenSlackOff.has(lm.trueDuration)) {
      seenSlackOff.add(lm.trueDuration);
      const res2 = compareTurnWithShowdown(b1, 'move 1', 'move 2');
      assert.equal(res2.missingFromEngine.length, 0, `T2 trueDur=${lm.trueDuration} vs Slack Off: missing`);
      assert.equal(res2.extraInEngine.length, 0, `T2 trueDur=${lm.trueDuration} vs Slack Off: extra`);
      assert.ok(res2.totalVariationDistance < 1e-8, `T2 trueDur=${lm.trueDuration} vs Slack Off: TVD=${res2.totalVariationDistance}`);

      if (lm.trueDuration === 2 && !checkedT3) {
        b1.makeChoices('move 1', 'move 2');
        const res3 = compareTurnWithShowdown(b1, 'move 1', 'move 2');
        assert.equal(res3.missingFromEngine.length, 0, 'T3 final turn vs Slack Off: missing');
        assert.equal(res3.extraInEngine.length, 0, 'T3 final turn vs Slack Off: extra');
        assert.ok(res3.totalVariationDistance < 1e-8, `T3 final turn vs Slack Off: TVD=${res3.totalVariationDistance}`);
        checkedT3 = true;
      }
    }

    if (!seenProtect.has(lm.trueDuration)) {
      seenProtect.add(lm.trueDuration);
      const b2 = makeOutrageBattle([seed, seed + 1, seed + 2, seed + 3]);
      b2.makeChoices('move 1', 'move 2');
      const resP = compareTurnWithShowdown(b2, 'move 1', 'move 1');
      assert.equal(resP.missingFromEngine.length, 0, `T2 trueDur=${lm.trueDuration} vs Protect: missing`);
      assert.equal(resP.extraInEngine.length, 0, `T2 trueDur=${lm.trueDuration} vs Protect: extra`);
      assert.ok(resP.totalVariationDistance < 1e-8, `T2 trueDur=${lm.trueDuration} vs Protect: TVD=${resP.totalVariationDistance}`);
    }
  }
  assert.equal(seenSlackOff.size, 2, 'Expected to test both 2-turn and 3-turn Outrage locks vs Slack Off');
  assert.equal(seenProtect.size, 2, 'Expected to test both 2-turn and 3-turn Outrage locks vs Protect');
  assert.equal(checkedT3, true, 'Expected to test Turn 3 Outrage ending + confusion');

  // Fairy immunity does not lock or confuse
  const cases11 = championsCases('2026-11');
  const fairyCase = cases11.find(x => x.id === 'garchomp-100-vs-mimikyu-100');
  assert.ok(fairyCase);
  const resFairy = compareTurnWithShowdown(createChampionsBattle(fairyCase), 'move 3', 'move 1');
  assert.equal(resFairy.missingFromEngine.length, 0);
  assert.equal(resFairy.extraInEngine.length, 0);
  assert.ok(resFairy.totalVariationDistance < 1e-8);
});

