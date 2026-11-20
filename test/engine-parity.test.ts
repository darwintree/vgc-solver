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

test('all 252 supported Champions fixtures (including Mega Evolution) pass engine admission', () => {
  const supported = championsCases().filter(c => c.skipReasons.length === 0);
  assert.equal(supported.length, 252);
  for (const c of supported) {
    const battle = createChampionsBattle(c);
    const report = canRunInEngine(battle);
    assert.equal(report.supported, true, `${c.id} rejected: ${report.reasons.join('; ')}`);
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
