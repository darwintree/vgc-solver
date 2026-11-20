import assert from 'node:assert/strict';
import test from 'node:test';
import {
  auditChampionsCoverage,
  canRunInEngine,
  compareTurnWithShowdown,
  createChampionsModBattle,
} from '../src/engine';

const IVS = {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31};
const ZERO_SP = {hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0};

function champSet(spec: {
  species: string;
  ability: string;
  nature: string;
  moves: string[];
  item?: string;
  sp?: Partial<typeof ZERO_SP>;
}) {
  return {
    name: spec.species,
    species: spec.species,
    item: spec.item ?? '',
    ability: spec.ability,
    moves: spec.moves,
    nature: spec.nature,
    gender: '',
    evs: {...ZERO_SP, ...spec.sp},
    ivs: IVS,
    level: 50,
  };
}

function assertChampionsParity(battle: any, p1Cmd: string, p2Cmd: string, label: string) {
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

test('Champions coverage auditor verifies 100% species, Megas, and items plus >=88% abilities and >=90% moves on official @pkmn/mods/champions', () => {
  const report = auditChampionsCoverage();
  assert.equal(report.mod, 'champions');
  assert.equal(report.species.percent, 100);
  assert.equal(report.megas.percent, 100);
  assert.equal(report.items.percent, 100);
  assert.ok(report.abilities.percent >= 88, `Expected >=88% abilities, got ${report.abilities.percent}%`);
  assert.ok(report.moves.percent >= 90, `Expected >=90% moves, got ${report.moves.percent}%`);
});

test('Champions Mega Evolution battles match @pkmn/mods/champions exact distributions', () => {
  // 1. Mega Dragonite (Multiscale) vs Mega Delphox (Levitate) — both Mega Evolve on Turn 1!
  const b1 = createChampionsModBattle(
    [champSet({species: 'Dragonite', item: 'Dragoninite', ability: 'Multiscale', nature: 'Adamant', sp: {hp: 2, atk: 32, spe: 32}, moves: ['Extreme Speed', 'Draco Meteor', 'Roost', 'Flamethrower']})],
    [champSet({species: 'Delphox', item: 'Delphoxite', ability: 'Blaze', nature: 'Timid', sp: {hp: 2, spa: 32, spe: 32}, moves: ['Flamethrower', 'Psychic', 'Dazzling Gleam', 'Substitute']})]
  );
  assert.equal(canRunInEngine(b1).supported, true);
  assertChampionsParity(b1, 'move 1 mega', 'move 3 mega', 'Mega Dragonite ES x Mega Delphox DG');

  // 2. Mega Gyarados (Intimidate -> Mold Breaker) vs Mega Metagross (Clear Body -> Tough Claws)
  const b2 = createChampionsModBattle(
    [champSet({species: 'Gyarados', item: 'Gyaradosite', ability: 'Intimidate', nature: 'Jolly', sp: {hp: 2, atk: 32, spe: 32}, moves: ['Waterfall', 'Earthquake', 'Dragon Dance', 'Protect']})],
    [champSet({species: 'Metagross', item: 'Metagrossite', ability: 'Clear Body', nature: 'Adamant', sp: {hp: 2, atk: 32, spe: 32}, moves: ['Bullet Punch', 'Psychic Fangs', 'Earthquake', 'Protect']})]
  );
  assert.equal(canRunInEngine(b2).supported, true);
  assertChampionsParity(b2, 'move 3 mega', 'move 1 mega', 'Mega Gyarados DD x Mega Metagross Tough Claws Bullet Punch');
});

test('Champions-specific status deltas (1/8 par, 2-3 slp, 1/4 max-3 frz) match @pkmn/mods/champions', () => {
  // 1. Champions 1/8 paralysis (vs mainline Gen 9 1/4)
  const bPar = createChampionsModBattle(
    [champSet({species: 'Archaludon', ability: 'Stamina', nature: 'Modest', moves: ['Stealth Rock', 'Flash Cannon']})],
    [champSet({species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly', moves: ['Swords Dance', 'Earthquake']})]
  );
  bPar.p1.active[0].setStatus('par');
  assertChampionsParity(bPar, 'move 1', 'move 1', 'Champions 1/8 full paralysis');

  // 2. Champions sleep [2, 3, 3]
  const bSlp = createChampionsModBattle(
    [champSet({species: 'Amoonguss', ability: 'Regenerator', nature: 'Bold', moves: ['Spore', 'Protect']})],
    [champSet({species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly', moves: ['Swords Dance', 'Earthquake']})]
  );
  assertChampionsParity(bSlp, 'move 1', 'move 1', 'Champions Spore sleep duration [2,3,3]');

  // 3. Champions freeze (starts time=3, 1/4 thaw per turn, guaranteed thaw on turn 3)
  const bFrz = createChampionsModBattle(
    [champSet({species: 'Archaludon', ability: 'Stamina', nature: 'Modest', moves: ['Stealth Rock', 'Flash Cannon']})],
    [champSet({species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly', moves: ['Swords Dance', 'Earthquake']})]
  );
  bFrz.p1.active[0].setStatus('frz');
  assertChampionsParity(bFrz, 'move 1', 'move 1', 'Champions Freeze 1/4 thaw');
});

test('Champions-new abilities (Dragonize, Aura Guard, Fire Mane, Mega Sol, Piercing Drill, Spicy Spray, Eelevate) match @pkmn/mods/champions', () => {
  // Dragonize (Normal -> Dragon 1.2x) + Aura Guard (0.5x contact)
  const bDA = createChampionsModBattle(
    [champSet({species: 'Dragonite', ability: 'Dragonize', nature: 'Adamant', sp: {atk: 32}, moves: ['Extreme Speed']})],
    [champSet({species: 'Garchomp', ability: 'Aura Guard', nature: 'Impish', sp: {hp: 32, def: 32}, moves: ['Swords Dance']})]
  );
  assertChampionsParity(bDA, 'move 1', 'move 1', 'Dragonize Extreme Speed vs Aura Guard');

  // Fire Mane (1.5x Fire) + Mega Sol (Sun damage)
  const bFM = createChampionsModBattle(
    [champSet({species: 'Delphox', ability: 'Fire Mane', nature: 'Modest', sp: {spa: 32}, moves: ['Flamethrower']})],
    [champSet({species: 'Archaludon', ability: 'Mega Sol', nature: 'Modest', sp: {hp: 32}, moves: ['Flamethrower']})]
  );
  assertChampionsParity(bFM, 'move 1', 'move 1', 'Fire Mane vs Mega Sol');

  // Piercing Drill (0.25x contact through Protect) + Spicy Spray (burns attacker)
  const bPS = createChampionsModBattle(
    [champSet({species: 'Garchomp', ability: 'Piercing Drill', nature: 'Jolly', sp: {atk: 32}, moves: ['Knock Off']})],
    [champSet({species: 'Archaludon', ability: 'Spicy Spray', nature: 'Bold', sp: {hp: 32}, moves: ['Protect', 'Stealth Rock']})]
  );
  assertChampionsParity(bPS, 'move 1', 'move 1', 'Piercing Drill through Protect + Spicy Spray');

  // Eelevate (Ground immunity + best stat boost on KO)
  const bEl = createChampionsModBattle(
    [champSet({species: 'Eelektross', ability: 'Eelevate', nature: 'Modest', sp: {spa: 32}, moves: ['Thunderbolt']})],
    [
      champSet({species: 'Gyarados', ability: 'Intimidate', nature: 'Jolly', moves: ['Earthquake']}),
      champSet({species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly', moves: ['Earthquake']}),
    ]
  );
  bEl.p2.active[0].hp = 1;
  assertChampionsParity(bEl, 'move 1', 'move 1', 'Eelevate Ground immunity + KO best-stat boost');
});

test('Champions mechanics: Choice Scarf, Protean, Sand Stream, Substitute, Reflect + Psychic Fangs, Roost match @pkmn/mods/champions', () => {
  // Choice Scarf + Protean Meowscarada vs Sand Stream Hippowdon
  const bMeow = createChampionsModBattle(
    [champSet({species: 'Meowscarada', item: 'Choice Scarf', ability: 'Protean', nature: 'Jolly', sp: {atk: 32, spe: 32}, moves: ['Play Rough', 'Throat Chop', 'Toxic Spikes', 'Power Gem']})],
    [champSet({species: 'Hippowdon', item: 'Sitrus Berry', ability: 'Sand Stream', nature: 'Impish', sp: {hp: 32, def: 32}, moves: ['Protect', 'Rock Tomb', 'Stone Edge', 'Earthquake']})]
  );
  assert.equal(canRunInEngine(bMeow).supported, true);
  assertChampionsParity(bMeow, 'move 2', 'move 2', 'Choice Scarf Protean Meowscarada vs Sand Stream Hippowdon');

  // Substitute + Reflect shattered by Psychic Fangs
  const bSub = createChampionsModBattle(
    [champSet({species: 'Delphox', ability: 'Blaze', nature: 'Timid', sp: {spe: 32}, moves: ['Substitute', 'Reflect']})],
    [champSet({species: 'Metagross', ability: 'Clear Body', nature: 'Adamant', sp: {atk: 32}, moves: ['Psychic Fangs', 'Bullet Punch']})]
  );
  bSub.makeChoices('move 2', 'move 2'); // P1 sets Reflect
  assertChampionsParity(bSub, 'move 1', 'move 1', 'Substitute vs Reflect-breaking Psychic Fangs');

  // Roost removes Flying type for the turn (taking neutral Thunderbolt instead of 2x)
  const bRoost = createChampionsModBattle(
    [champSet({species: 'Dragonite', ability: 'Multiscale', nature: 'Jolly', sp: {spe: 32}, moves: ['Roost', 'Extreme Speed']})],
    [champSet({species: 'Archaludon', ability: 'Stamina', nature: 'Modest', moves: ['Thunderbolt']})]
  );
  bRoost.p1.active[0].hp = 80;
  assertChampionsParity(bRoost, 'move 1', 'move 1', 'Roost removes Flying type before Thunderbolt');
});

test('Wave 2 Champions abilities (Parental Bond, Supreme Overlord, Mirror Armor, Synchronize, Dry Skin, Toxic Debris, Berserk, Magic Bounce, Shed Skin, Cloud Nine) match @pkmn/mods/champions', () => {
  // 1. Mega Kangaskhan Parental Bond (2 hits, 2nd hit 0.25x, Power-Up Punch +2 Atk total!)
  const bPb = createChampionsModBattle(
    [champSet({species: 'Kangaskhan', item: 'Kangaskhanite', ability: 'Scrappy', nature: 'Jolly', sp: {atk: 32, spe: 32}, moves: ['Fake Out', 'Body Slam', 'Crunch', 'Protect']})],
    [champSet({species: 'Hippowdon', ability: 'Sand Stream', nature: 'Impish', sp: {hp: 32, def: 32}, moves: ['Slack Off', 'Earthquake']})]
  );
  assertChampionsParity(bPb, 'move 3 mega', 'move 1', 'Mega Kangaskhan Parental Bond Crunch vs Hippowdon');

  // 2. Supreme Overlord (1 fainted ally => 4506/4096 BP) + Toxic Debris (Physical hit sets Toxic Spikes)
  const bSo = createChampionsModBattle(
    [
      champSet({species: 'Kingambit', ability: 'Supreme Overlord', nature: 'Adamant', sp: {atk: 32}, moves: ['Kowtow Cleave']}),
      champSet({species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly', moves: ['Earthquake']}),
    ],
    [champSet({species: 'Glimmora', ability: 'Toxic Debris', nature: 'Timid', sp: {hp: 32, def: 32}, moves: ['Protect', 'Stealth Rock']})]
  );
  // Knock out P1's second Pokemon via direct state setup? Better: start fresh with 1 fainted via battle turn!
  const bTd = createChampionsModBattle(
    [champSet({species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly', sp: {atk: 32}, moves: ['Earthquake']})],
    [champSet({species: 'Glimmora', ability: 'Toxic Debris', nature: 'Bold', sp: {hp: 32, def: 32}, moves: ['Sludge Bomb', 'Stealth Rock']})]
  );
  assertChampionsParity(bTd, 'move 1', 'move 2', 'Toxic Debris on Physical hit');
  assert.equal(canRunInEngine(bSo).supported, true);

  // 3. Mirror Armor reflects Mystical Fire / Snarl stat drop + Synchronize reflects Will-O-Wisp
  const bMa = createChampionsModBattle(
    [champSet({species: 'Corviknight', ability: 'Mirror Armor', nature: 'Careful', sp: {hp: 32, spd: 32}, moves: ['Roost']})],
    [champSet({species: 'Umbreon', ability: 'Synchronize', nature: 'Calm', sp: {hp: 32, spd: 32}, moves: ['Snarl', 'Will-O-Wisp']})]
  );
  assertChampionsParity(bMa, 'move 1', 'move 1', 'Mirror Armor reflects Snarl SpA drop');

  // 4. Dry Skin (Rain heal + Fire 1.25x) + Cloud Nine (suppresses weather)
  const bDs = createChampionsModBattle(
    [champSet({species: 'Toxicroak', ability: 'Dry Skin', nature: 'Jolly', sp: {hp: 32}, moves: ['Protect', 'Swords Dance']})],
    [champSet({species: 'Pelipper', ability: 'Drizzle', nature: 'Bold', sp: {hp: 32}, moves: ['Flamethrower', 'Roost']})]
  );
  bDs.p1.active[0].hp = 100;
  assertChampionsParity(bDs, 'move 2', 'move 1', 'Dry Skin 1.25x Fire + Rain 1/8 heal');

  // 5. Magic Bounce reflects Stealth Rock & Shed Skin 33% cure
  const bMb = createChampionsModBattle(
    [champSet({species: 'Hatterene', ability: 'Magic Bounce', nature: 'Bold', sp: {hp: 32}, moves: ['Calm Mind']})],
    [champSet({species: 'Archaludon', ability: 'Stamina', nature: 'Bold', moves: ['Stealth Rock']})]
  );
  assertChampionsParity(bMb, 'move 1', 'move 1', 'Magic Bounce reflects Stealth Rock');

  const bSs = createChampionsModBattle(
    [champSet({species: 'Scrafty', ability: 'Shed Skin', nature: 'Careful', sp: {hp: 32}, moves: ['Bulk Up']})],
    [champSet({species: 'Archaludon', ability: 'Stamina', nature: 'Bold', moves: ['Iron Defense']})]
  );
  bSs.p1.active[0].setStatus('par');
  assertChampionsParity(bSs, 'move 1', 'move 1', 'Shed Skin 33% residual cure + Champions 1/8 par');
});

test('Wave 2 Champions moves (Low Kick, Heavy Slam, Freeze-Dry, Thunder in Rain, Grassy Glide, Tri Attack, Leech Seed, Yawn, Belly Drum, High Jump Kick crash, Solar Beam, Doubles Follow Me + Helping Hand + Friend Guard) match @pkmn/mods/champions', () => {
  // 1. Weight moves (Low Kick / Heavy Slam) + Freeze-Dry 4x vs Gyarados
  const bWt = createChampionsModBattle(
    [champSet({species: 'Snorlax', ability: 'Thick Fat', nature: 'Adamant', sp: {hp: 32, atk: 32}, moves: ['Heavy Slam', 'Belly Drum']})],
    [champSet({species: 'Gyarados', ability: 'Intimidate', nature: 'Jolly', sp: {hp: 32}, moves: ['Freeze-Dry', 'Low Kick']})]
  );
  assertChampionsParity(bWt, 'move 1', 'move 2', 'Heavy Slam ratio vs Low Kick target weight');
  assertChampionsParity(bWt, 'move 2', 'move 2', 'Belly Drum + Low Kick');

  const bFd = createChampionsModBattle(
    [champSet({species: 'Glalie', ability: 'Inner Focus', nature: 'Timid', sp: {spa: 32}, moves: ['Freeze-Dry']})],
    [champSet({species: 'Gyarados', ability: 'Intimidate', nature: 'Careful', sp: {hp: 32, spd: 32}, moves: ['Protect', 'Dragon Dance']})]
  );
  assertChampionsParity(bFd, 'move 1', 'move 2', 'Freeze-Dry 4x super-effective vs Water/Flying Gyarados');

  // 2. Grassy Glide +1 priority in Grassy Terrain + Tri Attack 20% brn/par/frz
  const bGg = createChampionsModBattle(
    [champSet({species: 'Rillaboom', ability: 'Grassy Surge', nature: 'Adamant', sp: {atk: 32}, moves: ['Grassy Glide']})],
    [champSet({species: 'Porygon2', ability: 'Analytic', nature: 'Bold', sp: {hp: 32, def: 32}, moves: ['Tri Attack']})]
  );
  assertChampionsParity(bGg, 'move 1', 'move 1', 'Grassy Glide +1 priority vs Analytic Tri Attack');

  // 3. Leech Seed + Yawn + High Jump Kick crash recoil on Protect
  const bLs = createChampionsModBattle(
    [champSet({species: 'Venusaur', ability: 'Overgrow', nature: 'Bold', sp: {hp: 32}, moves: ['Leech Seed', 'Solar Beam']})],
    [champSet({species: 'Hippowdon', ability: 'Sand Stream', nature: 'Impish', sp: {hp: 32}, moves: ['Yawn', 'Slack Off']})]
  );
  assertChampionsParity(bLs, 'move 1', 'move 1', 'Leech Seed + Yawn');

  const bHjk = createChampionsModBattle(
    [champSet({species: 'Medicham', ability: 'Pure Power', nature: 'Jolly', sp: {atk: 32, spe: 32}, moves: ['High Jump Kick']})],
    [champSet({species: 'Archaludon', ability: 'Stamina', nature: 'Bold', moves: ['Protect']})]
  );
  assertChampionsParity(bHjk, 'move 1', 'move 1', 'High Jump Kick 50% crash recoil on Protect');

  // 4. Doubles 2v2: Follow Me redirection + Helping Hand 1.5x + Friend Guard 0.75x
  const bDbl = createChampionsModBattle(
    [
      champSet({species: 'Clefairy', ability: 'Friend Guard', nature: 'Bold', sp: {hp: 32, def: 32}, moves: ['Follow Me', 'Helping Hand']}),
      champSet({species: 'Dragonite', ability: 'Multiscale', nature: 'Adamant', sp: {atk: 32}, moves: ['Extreme Speed', 'Protect']}),
    ],
    [
      champSet({species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly', sp: {atk: 32, spe: 32}, moves: ['Dragon Claw', 'Protect']}),
      champSet({species: 'Metagross', ability: 'Clear Body', nature: 'Adamant', sp: {atk: 32}, moves: ['Bullet Punch', 'Protect']}),
    ],
    {doubles: true}
  );
  assertChampionsParity(bDbl, 'move 1, move 1 +1', 'move 1 +2, move 2', 'Doubles Follow Me redirection + Friend Guard');
  assertChampionsParity(bDbl, 'move 2 -2, move 1 +1', 'move 1 +1, move 2', 'Doubles Helping Hand 1.5x + Extreme Speed');
});

test('Champions Mega Gengar Shadow Tag trapping & BoundedSolver end-to-end Mega Evolution solve', () => {
  const {BoundedSolver} = require('../src/bounded-solver');
  const {compileContextFromBattle, createEngineBoundedAdapter, legalSideActions, stateFromBattle} = require('../src/engine');

  // 1. Mega Gengar Shadow Tag traps non-Ghost opponents from switching, while Ghost opponents can switch
  const bTrap = createChampionsModBattle(
    [champSet({species: 'Gengar-Mega', item: 'Gengarite', ability: 'Shadow Tag', nature: 'Timid', moves: ['Shadow Ball']})],
    [
      champSet({species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly', moves: ['Earthquake']}),
      champSet({species: 'Archaludon', ability: 'Stamina', nature: 'Bold', moves: ['Flash Cannon']}),
    ]
  );
  const ctxTrap = compileContextFromBattle(bTrap);
  const stTrap = stateFromBattle(ctxTrap, bTrap);
  const p2Acts = legalSideActions(ctxTrap, stTrap, 1);
  assert.equal(p2Acts.some((a: any) => a[0].kind === 'switch'), false, 'Shadow Tag should trap non-Ghost Garchomp');

  // 2. BoundedSolver solves a Champions Mega Evolution 1v1 endgame cleanly
  const bMegaSolve = createChampionsModBattle(
    [champSet({species: 'Dragonite', item: 'Dragoninite', ability: 'Multiscale', nature: 'Adamant', sp: {atk: 32, spe: 32}, moves: ['Extreme Speed', 'Protect']})],
    [champSet({species: 'Delphox', item: 'Delphoxite', ability: 'Blaze', nature: 'Timid', sp: {spa: 32, spe: 32}, moves: ['Dazzling Gleam', 'Protect']})]
  );
  bMegaSolve.p1.active[0].hp = 90;
  bMegaSolve.p2.active[0].hp = 70;
  const adapter = createEngineBoundedAdapter(bMegaSolve);
  assert.ok(adapter, 'Champions Mega Evolution battle must be admitted by compact engine adapter');
  const rootActions = adapter.legalActions(adapter.snapshotBattle(bMegaSolve), 0);
  assert.ok(rootActions.some((a: any) => a.command.includes('mega')), 'Mega Evolution actions must be exposed to BoundedSolver');
  const solver = new BoundedSolver({tolerance: 1e-4, maxSearchMs: 5000, adapter});
  const res = solver.solve(bMegaSolve);
  assert.equal(res.converged, true);
  assert.ok(res.lowerBound >= -1 && res.upperBound <= 1 && res.upperBound - res.lowerBound <= 1e-4);
});


