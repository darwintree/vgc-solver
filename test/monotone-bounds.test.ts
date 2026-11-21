import assert from 'node:assert/strict';
import test from 'node:test';
import {Battle} from '@pkmn/sim';
import {
  BoundedSolver,
  type BoundedAdapter,
  type MonotoneBoxOutcome,
} from '../src/bounded-solver';
import {
  FeatureBit,
  canonicalStateKey,
  cloneState,
  compileContextFromBattle,
  createEngineBoundedAdapter,
  createMonotoneAnalyzer,
  stateFromBattle,
  stepBattle,
} from '../src/engine';
import {championsCases, createChampionsBattle} from '../src/champions-cases';
import {FIXED_SEED} from '../src/branching-prng';

const IVS = {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31};
const EVS = {hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0};

function makeBattle(
  p1: {species: string; ability: string; moves: string[]; item?: string; hp?: number},
  p2: {species: string; ability: string; moves: string[]; item?: string; hp?: number}
): Battle {
  const battle = new Battle({formatid: 'gen9customgame' as any, seed: FIXED_SEED});
  battle.setPlayer('p1', {
    name: 'P1',
    team: [{
      name: p1.species,
      species: p1.species,
      item: p1.item ?? '',
      ability: p1.ability,
      moves: p1.moves,
      nature: 'Hardy',
      gender: '',
      evs: EVS,
      ivs: IVS,
      level: 50,
    }],
  });
  battle.setPlayer('p2', {
    name: 'P2',
    team: [{
      name: p2.species,
      species: p2.species,
      item: p2.item ?? '',
      ability: p2.ability,
      moves: p2.moves,
      nature: 'Hardy',
      gender: '',
      evs: EVS,
      ivs: IVS,
      level: 50,
    }],
  });
  if (p1.hp !== undefined) battle.p1.active[0].hp = p1.hp;
  if (p2.hp !== undefined) battle.p2.active[0].hp = p2.hp;
  return battle;
}

test('reader-driven FeatureBit and dead SpA/SpD boost masking omit unobservable fields only', () => {
  const primVsMimikyu = createChampionsBattle(
    championsCases().find(c => c.id === 'primarina-100-vs-mimikyu-100')!
  );
  const ctx = compileContextFromBattle(primVsMimikyu);

  // Primarina has Encore -> tracks Mimikyu lastMoveIdx (SIDE1), not Primarina's (SIDE0)
  assert.equal((ctx.featureMask & FeatureBit.SIDE0_LAST_MOVE_IDX) !== 0, false);
  assert.equal((ctx.featureMask & FeatureBit.SIDE1_LAST_MOVE_IDX) !== 0, true);
  assert.equal((ctx.featureMask & FeatureBit.FIELD_LAST_MOVE) !== 0, false);
  assert.equal((ctx.featureMask & FeatureBit.LAST_MOVE_FAILED) !== 0, false);
  assert.equal((ctx.featureMask & FeatureBit.LAST_ITEM) !== 0, false);
  assert.equal((ctx.featureMask & FeatureBit.ATE_BERRY) !== 0, false);

  // Mimikyu has only physical moves -> Mimikyu's SpA boost and Primarina's SpD boost are unobservable
  assert.deepEqual(ctx.trackSpaBoost, [true, false]);
  assert.deepEqual(ctx.trackSpdBoost, [false, true]);

  const st1 = stateFromBattle(ctx, primVsMimikyu);
  const st2 = cloneState(st1);
  st2.sides[1].pokemon[0].boosts[2] = -2; // dead Mimikyu SpA drop
  st2.sides[0].pokemon[0].boosts[3] = -1; // dead Primarina SpD drop
  assert.equal(canonicalStateKey(ctx, st1), canonicalStateKey(ctx, st2));

  // Observable boosts still split keys
  const st3 = cloneState(st1);
  st3.sides[0].pokemon[0].boosts[2] = -1; // Primarina SpA IS observable
  assert.notEqual(canonicalStateKey(ctx, st1), canonicalStateKey(ctx, st3));

  // Boost-reading moves/items/abilities must preserve SpA/SpD tracking
  for (const [label, b] of [
    ['Stored Power', makeBattle(
      {species: 'Espeon', ability: 'Synchronize', moves: ['Stored Power']},
      {species: 'Mimikyu', ability: 'Disguise', moves: ['Play Rough']}
    )],
    ['White Herb', makeBattle(
      {species: 'Primarina', ability: 'Torrent', moves: ['Moonblast']},
      {species: 'Mimikyu', ability: 'Disguise', moves: ['Play Rough'], item: 'White Herb'}
    )],
    ['Defiant', makeBattle(
      {species: 'Primarina', ability: 'Torrent', moves: ['Moonblast']},
      {species: 'Annihilape', ability: 'Defiant', moves: ['Close Combat']}
    )],
    ['Psych Up', makeBattle(
      {species: 'Primarina', ability: 'Torrent', moves: ['Moonblast']},
      {species: 'Mimikyu', ability: 'Disguise', moves: ['Play Rough', 'Psych Up']}
    )],
  ] as const) {
    const c = compileContextFromBattle(b);
    assert.deepEqual(c.trackSpaBoost, [true, true], `${label} must keep trackSpaBoost`);
    assert.deepEqual(c.trackSpdBoost, [true, true], `${label} must keep trackSpdBoost`);
  }
});

test('createMonotoneAnalyzer conservatively disables non-monotone HP hazards', () => {
  // 1. Sitrus Berry intact -> axis disabled; once consumed (no Recycle/Harvest) -> enabled
  const bSitrus = makeBattle(
    {species: 'Archaludon', ability: 'Stamina', moves: ['Flash Cannon'], item: 'Sitrus Berry'},
    {species: 'Garchomp', ability: 'Rough Skin', moves: ['Earthquake']}
  );
  const ctxSitrus = compileContextFromBattle(bSitrus);
  const anSitrus = createMonotoneAnalyzer(ctxSitrus);
  const stSitrus = stateFromBattle(ctxSitrus, bSitrus);
  assert.equal(anSitrus.isHpMonotone(stSitrus, 0, stSitrus.sides[0].pokemon[0].hp), false);
  assert.equal(anSitrus.isHpMonotone(stSitrus, 1, stSitrus.sides[1].pokemon[0].hp), true);
  const stConsumed = cloneState(stSitrus);
  stConsumed.sides[0].pokemon[0].itemActive = false;
  assert.equal(anSitrus.isHpMonotone(stConsumed, 0, stConsumed.sides[0].pokemon[0].hp), true);

  // 2. Sitrus Berry + Recycle -> permanently disabled even when itemActive is false
  const bRecycle = makeBattle(
    {species: 'Snorlax', ability: 'Thick Fat', moves: ['Body Slam', 'Recycle'], item: 'Sitrus Berry'},
    {species: 'Garchomp', ability: 'Rough Skin', moves: ['Earthquake']}
  );
  const ctxRecycle = compileContextFromBattle(bRecycle);
  assert.equal(createMonotoneAnalyzer(ctxRecycle).anyAxisAllowed, false);

  // 3. Torrent with Water move: disabled above floor(maxhp/3), enabled at <= floor(maxhp/3) when no heal
  const bTorrent = makeBattle(
    {species: 'Primarina', ability: 'Torrent', moves: ['Hydro Pump']},
    {species: 'Garchomp', ability: 'Rough Skin', moves: ['Earthquake']}
  );
  const ctxTorrent = compileContextFromBattle(bTorrent);
  const anTorrent = createMonotoneAnalyzer(ctxTorrent);
  const stTorrent = stateFromBattle(ctxTorrent, bTorrent);
  const pinch = Math.floor(ctxTorrent.sides[0].team[0].maxhp / 3);
  assert.equal(anTorrent.isHpMonotone(stTorrent, 0, pinch + 1), false);
  assert.equal(anTorrent.isHpMonotone(stTorrent, 0, pinch), true);
  assert.equal(anTorrent.isHpMonotone(stTorrent, 0, 1), true);

  // 4. Torrent + Leftovers (can heal back above 1/3) -> disabled even at <= 1/3 HP
  const bTorrentHeal = makeBattle(
    {species: 'Primarina', ability: 'Torrent', moves: ['Hydro Pump'], item: 'Leftovers'},
    {species: 'Garchomp', ability: 'Rough Skin', moves: ['Earthquake']}
  );
  const ctxTorrentHeal = compileContextFromBattle(bTorrentHeal);
  const anTorrentHeal = createMonotoneAnalyzer(ctxTorrentHeal);
  const stTorrentHeal = stateFromBattle(ctxTorrentHeal, bTorrentHeal);
  assert.equal(anTorrentHeal.isHpMonotone(stTorrentHeal, 0, 10), false);

  // 5. Flail / Endeavor / Rest disable self axis; Hard Press / Drain / Shell Bell disable foe axis
  for (const [label, b, expectP1, expectP2] of [
    ['Flail', makeBattle(
      {species: 'Lucario', ability: 'Inner Focus', moves: ['Flail']},
      {species: 'Garchomp', ability: 'Rough Skin', moves: ['Earthquake']}
    ), false, true],
    ['Endeavor', makeBattle(
      {species: 'Staraptor', ability: 'Intimidate', moves: ['Endeavor']},
      {species: 'Garchomp', ability: 'Rough Skin', moves: ['Earthquake']}
    ), false, true],
    ['Rest', makeBattle(
      {species: 'Snorlax', ability: 'Thick Fat', moves: ['Body Slam', 'Rest']},
      {species: 'Garchomp', ability: 'Rough Skin', moves: ['Earthquake']}
    ), false, true],
    ['Hard Press', makeBattle(
      {species: 'Archaludon', ability: 'Stamina', moves: ['Flash Cannon']},
      {species: 'Metagross', ability: 'Clear Body', moves: ['Hard Press']}
    ), false, true],
    ['Drain move (safe in 1v1 without contact/faint dmg or attacker Life Orb)', makeBattle(
      {species: 'Archaludon', ability: 'Stamina', moves: ['Flash Cannon']},
      {species: 'Venusaur', ability: 'Overgrow', moves: ['Giga Drain']}
    ), true, false],
    ['Drain move vs Rough Skin (fail-closed)', makeBattle(
      {species: 'Garchomp', ability: 'Rough Skin', moves: ['Earthquake']},
      {species: 'Golisopod', ability: 'Emergency Exit', moves: ['Leech Life']}
    ), false, true],
    ['Drain move vs Rocky Helmet (fail-closed)', makeBattle(
      {species: 'Archaludon', ability: 'Stamina', moves: ['Flash Cannon'], item: 'Rocky Helmet'},
      {species: 'Golisopod', ability: 'Emergency Exit', moves: ['Leech Life']}
    ), false, true],
    ['Drain move with attacker Life Orb (fail-closed)', makeBattle(
      {species: 'Archaludon', ability: 'Stamina', moves: ['Flash Cannon']},
      {species: 'Golisopod', ability: 'Emergency Exit', moves: ['Leech Life'], item: 'Life Orb'}
    ), false, true],
    ['Emergency Exit in 1v1 (no bench -> safe)', makeBattle(
      {species: 'Golisopod', ability: 'Emergency Exit', moves: ['Leech Life', 'Sucker Punch']},
      {species: 'Archaludon', ability: 'Stamina', moves: ['Flash Cannon']}
    ), true, true],
    ['Aftermath & Destiny Bond (fail-closed self)', makeBattle(
      {species: 'Skuntank', ability: 'Aftermath', moves: ['Crunch']},
      {species: 'Gengar', ability: 'Cursed Body', moves: ['Shadow Ball', 'Destiny Bond']}
    ), false, false],
    ['Pain Split', makeBattle(
      {species: 'Rotom', ability: 'Levitate', moves: ['Pain Split']},
      {species: 'Garchomp', ability: 'Rough Skin', moves: ['Earthquake']}
    ), false, false],
  ] as const) {
    const c = compileContextFromBattle(b);
    const an = createMonotoneAnalyzer(c);
    const st = stateFromBattle(c, b);
    assert.equal(an.isHpMonotone(st, 0, st.sides[0].pokemon[0].hp), expectP1, `${label} P1`);
    assert.equal(an.isHpMonotone(st, 1, st.sides[1].pokemon[0].hp), expectP2, `${label} P2`);
  }

  // 6. Berserk (> 1/2 disabled, <= 1/2 enabled) and Gale Wings (maxhp disabled, < maxhp enabled)
  const bBerserk = makeBattle(
    {species: 'Drampa', ability: 'Berserk', moves: ['Hyper Voice']},
    {species: 'Garchomp', ability: 'Rough Skin', moves: ['Earthquake']}
  );
  const ctxBerserk = compileContextFromBattle(bBerserk);
  const anBerserk = createMonotoneAnalyzer(ctxBerserk);
  const stBerserk = stateFromBattle(ctxBerserk, bBerserk);
  const half = Math.floor(ctxBerserk.sides[0].team[0].maxhp / 2);
  assert.equal(anBerserk.isHpMonotone(stBerserk, 0, half + 1), false);
  assert.equal(anBerserk.isHpMonotone(stBerserk, 0, half), true);

  const bGale = makeBattle(
    {species: 'Talonflame', ability: 'Gale Wings', moves: ['Brave Bird']},
    {species: 'Garchomp', ability: 'Rough Skin', moves: ['Earthquake']}
  );
  const ctxGale = compileContextFromBattle(bGale);
  const anGale = createMonotoneAnalyzer(ctxGale);
  const stGale = stateFromBattle(ctxGale, bGale);
  const maxhp = ctxGale.sides[0].team[0].maxhp;
  assert.equal(anGale.isHpMonotone(stGale, 0, maxhp), false);
  assert.equal(anGale.isHpMonotone(stGale, 0, maxhp - 1), true);
});

test('BoundedSolver adaptive MonotoneBoxOutcome bisects honestly and certifies exact value at tol=0', () => {
  // Synthetic 1-ply stochastic monotone game over h in {1..16}:
  // true value V(h) = -1 for h <= 5, +1 for h >= 6. Exact mean = (11 - 5) / 16 = 0.375.
  const exactTruth = (11 - 5) / 16;

  function makeBox(lo: number, hi: number, prob: number): MonotoneBoxOutcome | {snapshot: {id: string}; probability: number} {
    if (lo === hi) return {snapshot: {id: `leaf:${lo}`}, probability: prob};
    return {
      probability: prob,
      lowerSnapshot: {id: `leaf:${lo}`},
      upperSnapshot: {id: `leaf:${hi}`},
      split: () => {
        const mid = (lo + hi) >>> 1;
        const leftCount = mid - lo + 1;
        const rightCount = hi - mid;
        const total = leftCount + rightCount;
        return [
          makeBox(lo, mid, prob * (leftCount / total)),
          makeBox(mid + 1, hi, prob * (rightCount / total)),
        ];
      },
    };
  }

  const adapter: BoundedAdapter = {
    stateKey: s => s.id,
    monotoneSignature: s => {
      const m = /^leaf:(\d+)$/.exec(s.id);
      return m ? {groupKey: 'leaf', h1: Number(m[1]), h2: null} : null;
    },
    terminalUtility: () => null,
    legalActions: () => ['A'],
    enumerateTurn(snapshot) {
      if (snapshot.id === 'root') {
        return {outcomes: [makeBox(1, 16, 1)], complete: true};
      }
      const h = Number(snapshot.id.slice(5));
      return {outcomes: [{utility: h >= 6 ? 1 : -1, probability: 1}], complete: true};
    },
  };

  // Coarse tolerance stops early via bisection without claiming exactness
  const coarse = new BoundedSolver({tolerance: 0.15, adapter}).solve({id: 'root'});
  assert.equal(coarse.converged, true);
  assert.equal(coarse.exact, false);
  assert.ok(coarse.lowerBound <= exactTruth + 1e-9, `L=${coarse.lowerBound} <= ${exactTruth}`);
  assert.ok(coarse.upperBound >= exactTruth - 1e-9, `U=${coarse.upperBound} >= ${exactTruth}`);
  assert.ok(coarse.stats.boxSplits > 0);

  // Tight tolerance bisects the step boundary to tight bounds (within 1e-7 of exactTruth)
  // while keeping exactCertified honestly false when constant-value interior boxes stay unsplit.
  const tight = new BoundedSolver({tolerance: 1e-6, adapter}).solve({id: 'root'});
  assert.equal(tight.converged, true);
  assert.equal(tight.exact, false);
  assert.ok(Math.abs(tight.lowerBound - exactTruth) < 1e-7);
  assert.ok(Math.abs(tight.upperBound - exactTruth) < 1e-7);
  assert.ok(Math.abs(tight.value - exactTruth) < 1e-7);
});

test('adaptive monotone solver agrees with discrete oracle and preserves root strategy certificates', () => {
  const sampleIds = [
    'primarina-25-vs-archaludon-25',
    'primarina-50-vs-archaludon-50',
    'primarina-50-vs-mimikyu-50',
    'primarina-100-vs-mimikyu-50',
    'archaludon-50-vs-mimikyu-50',
  ];
  const all = championsCases();

  for (const id of sampleIds) {
    const fixture = all.find(c => c.id === id)!;
    const bAdaptive = createChampionsBattle(fixture);
    const rAdaptive = new BoundedSolver({tolerance: 0.02, maxSearchMs: 10000, engine: 'compact'}).solve(bAdaptive);
    assert.equal(rAdaptive.converged, true, `${id} adaptive converged`);

    const bDiscrete = createChampionsBattle(fixture);
    const discreteAdapter = createEngineBoundedAdapter(bDiscrete, {hpOutputMode: 'discrete'})!;
    const rDiscrete = new BoundedSolver({tolerance: 0.02, maxSearchMs: 10000, adapter: discreteAdapter}).solve(bDiscrete);
    assert.equal(rDiscrete.converged, true, `${id} discrete converged`);

    // Certified intervals must overlap (both enclose the true minimax value)
    assert.ok(
      Math.max(rAdaptive.lowerBound, rDiscrete.lowerBound) <=
      Math.min(rAdaptive.upperBound, rDiscrete.upperBound) + 1e-6,
      `${id} adaptive [${rAdaptive.lowerBound}, ${rAdaptive.upperBound}] vs discrete [${rDiscrete.lowerBound}, ${rDiscrete.upperBound}]`
    );

    // Root strategy certificates must match lowerBound/upperBound against payoffMatrixLower/Upper
    const p1 = rAdaptive.p1Strategy.map(e => e.probability);
    const p2 = rAdaptive.p2Strategy.map(e => e.probability);
    const lowM = rAdaptive.payoffMatrixLower;
    const upM = rAdaptive.payoffMatrixUpper;
    const minCol = Math.min(...lowM[0].map((_, j) => lowM.reduce((s, row, i) => s + p1[i] * row[j], 0)));
    const maxRow = Math.max(...upM.map(row => row.reduce((s, v, j) => s + v * p2[j], 0)));
    assert.ok(minCol >= rAdaptive.lowerBound - 1e-6, `${id} P1 certificate ${minCol} >= ${rAdaptive.lowerBound}`);
    assert.ok(maxRow <= rAdaptive.upperBound + 1e-6, `${id} P2 certificate ${maxRow} <= ${rAdaptive.upperBound}`);
  }
});

test('FeatureBit.HAZARDS masks unobservable entry hazards in 1v1 and tracks them when observable', () => {
  // 1v1 with Stealth Rock and no hazard reader/bench: FeatureBit.HAZARDS must be clear
  const b1v1 = makeBattle(
    {species: 'Garchomp', ability: 'Rough Skin', moves: ['Earthquake', 'Stealth Rock']},
    {species: 'Hippowdon', ability: 'Sand Stream', moves: ['Earthquake', 'Slack Off']}
  );
  const ctx1v1 = compileContextFromBattle(b1v1);
  assert.equal((ctx1v1.featureMask & FeatureBit.HAZARDS) !== 0, false);
  const s1 = stateFromBattle(ctx1v1, b1v1);
  const s2 = cloneState(s1);
  s2.sides[1].stealthRock = true;
  assert.equal(canonicalStateKey(ctx1v1, s1), canonicalStateKey(ctx1v1, s2));

  // 1v1 with Rapid Spin or Stomping Tantrum: FeatureBit.HAZARDS must be set
  const bSpin = makeBattle(
    {species: 'Garchomp', ability: 'Rough Skin', moves: ['Earthquake', 'Stealth Rock']},
    {species: 'Excadrill', ability: 'Sand Rush', moves: ['Earthquake', 'Rapid Spin']}
  );
  const ctxSpin = compileContextFromBattle(bSpin);
  assert.equal((ctxSpin.featureMask & FeatureBit.HAZARDS) !== 0, true);
  const ss1 = stateFromBattle(ctxSpin, bSpin);
  const ss2 = cloneState(ss1);
  ss2.sides[1].stealthRock = true;
  assert.notEqual(canonicalStateKey(ctxSpin, ss1), canonicalStateKey(ctxSpin, ss2));

  const bStomp = makeBattle(
    {species: 'Garchomp', ability: 'Rough Skin', moves: ['Stomping Tantrum', 'Stealth Rock']},
    {species: 'Hippowdon', ability: 'Sand Stream', moves: ['Earthquake', 'Slack Off']}
  );
  assert.equal((compileContextFromBattle(bStomp).featureMask & FeatureBit.HAZARDS) !== 0, true);
});

test('compact adapter PP-template cache matches fresh stepBattle bit-for-bit across PP>=3 and PP=1..2 Encore boundaries', () => {
  const b = makeBattle(
    {species: 'Primarina', ability: 'Torrent', moves: ['Moonblast', 'Encore']},
    {species: 'Archaludon', ability: 'Stamina', moves: ['Flash Cannon', 'Protect']}
  );
  const ctx = compileContextFromBattle(b);
  const adapter = createEngineBoundedAdapter(b, {hpOutputMode: 'discrete'})!;
  const base = stateFromBattle(ctx, b);
  const actions1 = adapter.legalActions(base, 0);
  const actions2 = adapter.legalActions(base, 1);

  const testCases: Array<{pp0: number[]; pp1: number[]; encoreTurns?: number; encoreIdx?: number}> = [
    {pp0: [15, 8], pp1: [16, 16]},
    {pp0: [12, 7], pp1: [10, 14]}, // hits cached PP-template from [15,8] / [16,16]
    {pp0: [3, 3], pp1: [3, 3]},    // hits same '+' bucket, stays >= 1 after turn
    {pp0: [2, 5], pp1: [2, 5], encoreTurns: 2, encoreIdx: 0},
    {pp0: [1, 5], pp1: [1, 5], encoreTurns: 2, encoreIdx: 0}, // drops to 0 PP -> ends Encore early!
  ];

  for (const tc of testCases) {
    const st = cloneState(base);
    st.sides[0].pokemon[0].pp = tc.pp0.slice();
    st.sides[1].pokemon[0].pp = tc.pp1.slice();
    if (tc.encoreTurns) {
      st.sides[1].pokemon[0].encoreTurns = tc.encoreTurns;
      st.sides[1].pokemon[0].encoreMoveIdx = tc.encoreIdx ?? 0;
    }

    const a1 = actions1[0]; // Moonblast
    const a2 = actions2[0]; // Flash Cannon
    const cachedRes = adapter.enumerateTurn(st, a1, a2, {});
    const freshRes = stepBattle(ctx, st, (a1 as any).sideAction, (a2 as any).sideAction, {
      mode: 'certified',
      hpOutputMode: 'discrete',
    });
    assert.equal(cachedRes.complete, true);
    assert.equal(freshRes.complete, true);

    const mapOf = (items: Array<{key: string; p: number}>) => {
      const m = new Map<string, number>();
      for (const x of items) m.set(x.key, (m.get(x.key) ?? 0) + x.p);
      return m;
    };
    const mCached = mapOf(cachedRes.outcomes.map((o: any) => ({
      key: o.utility !== undefined ? `U:${o.utility}` : canonicalStateKey(ctx, o.snapshot),
      p: o.probability,
    })));
    const mFresh = mapOf(freshRes.outcomes.map(o => ({
      key: o.state.phase.kind === 'ended' ? `U:${o.state.phase.winner === 0 ? 1 : o.state.phase.winner === 1 ? -1 : 0}` : canonicalStateKey(ctx, o.state),
      p: o.probability,
    })));
    assert.equal(mCached.size, mFresh.size, `Outcome count mismatch for pp=${tc.pp0}/${tc.pp1}`);
    for (const [k, p] of mFresh) {
      assert.ok(mCached.has(k), `Missing key ${k} for pp=${tc.pp0}/${tc.pp1}`);
      assert.ok(Math.abs((mCached.get(k) ?? 0) - p) < 1e-12, `Prob diff on ${k}`);
    }
  }
});

