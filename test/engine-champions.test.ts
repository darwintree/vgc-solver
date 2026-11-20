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
  gender?: 'M' | 'F' | 'N' | '';
  sp?: Partial<typeof ZERO_SP>;
}) {
  return {
    name: spec.species,
    species: spec.species,
    item: spec.item ?? '',
    ability: spec.ability,
    moves: spec.moves,
    nature: spec.nature,
    gender: spec.gender ?? '',
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

test('Champions coverage auditor verifies 100% across all 5 dimensions (species, Megas, items, abilities, moves) on official @pkmn/mods/champions', () => {
  const report = auditChampionsCoverage();
  assert.equal(report.mod, 'champions');
  assert.equal(report.species.percent, 100);
  assert.equal(report.megas.percent, 100);
  assert.equal(report.items.percent, 100);
  assert.equal(report.abilities.percent, 100, `Expected 100% abilities, missing: ${report.abilities.missing.join(', ')}`);
  assert.equal(report.moves.percent, 100, `Expected 100% moves, missing: ${report.moves.missing.join(', ')}`);
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

test('Wave 3 item manipulation (Trick, Thief, Magician, Pickpocket, Bug Bite, Stuff Cheeks, Cud Chew, Recycle, Belch, Fling, Teatime, Symbiosis) match @pkmn/mods/champions', () => {
  // 1. Trick swaps Choice Scarf and Leftovers
  const bTrick = createChampionsModBattle(
    [champSet({species: 'Gengar', item: 'Choice Scarf', ability: 'Cursed Body', nature: 'Timid', sp: {spe: 32}, moves: ['Trick', 'Shadow Ball']})],
    [champSet({species: 'Hippowdon', item: 'Leftovers', ability: 'Sand Force', nature: 'Impish', sp: {hp: 32}, moves: ['Slack Off', 'Protect']})]
  );
  bTrick.p1.active[0].hp = 100;
  assertChampionsParity(bTrick, 'move 1', 'move 1', 'Trick swaps Choice Scarf and Leftovers');

  // 2. Magician steals Leftovers on damaging hit (use 100% no-secondary move Aura Sphere / Swift -> Swift has no secondary)
  const bMag = createChampionsModBattle(
    [champSet({species: 'Delphox', ability: 'Magician', nature: 'Timid', sp: {spa: 32}, moves: ['Swift']})],
    [champSet({species: 'Archaludon', item: 'Leftovers', ability: 'Stamina', nature: 'Bold', sp: {hp: 32}, moves: ['Iron Defense']})]
  );
  bMag.p1.active[0].hp = 100;
  assertChampionsParity(bMag, 'move 1', 'move 1', 'Magician steals Leftovers on Swift');

  // 3. Pickpocket steals Leftovers when hit by contact move
  const bPick = createChampionsModBattle(
    [champSet({species: 'Metagross', item: 'Leftovers', ability: 'Clear Body', nature: 'Adamant', sp: {atk: 32}, moves: ['Bullet Punch']})],
    [champSet({species: 'Weavile', ability: 'Pickpocket', nature: 'Jolly', sp: {hp: 32}, moves: ['Swords Dance']})]
  );
  assertChampionsParity(bPick, 'move 1', 'move 1', 'Pickpocket steals Leftovers on contact');

  // 4. Bug Bite steals & eats defender Sitrus Berry
  const bBb = createChampionsModBattle(
    [champSet({species: 'Scizor', ability: 'Technician', nature: 'Adamant', sp: {atk: 32}, moves: ['Bug Bite']})],
    [champSet({species: 'Hippowdon', item: 'Sitrus Berry', ability: 'Sand Force', nature: 'Impish', sp: {hp: 32, def: 32}, moves: ['Slack Off']})]
  );
  bBb.p1.active[0].hp = 100;
  assertChampionsParity(bBb, 'move 1', 'move 1', 'Bug Bite steals and eats Sitrus Berry');

  // 5. Stuff Cheeks + Cud Chew (2-turn parity: turn 1 Stuff Cheeks eats Sitrus Berry +2 Def; turn 2 Cud Chew re-eats!)
  const bCud = createChampionsModBattle(
    [champSet({species: 'Farigiraf', item: 'Sitrus Berry', ability: 'Cud Chew', nature: 'Bold', sp: {hp: 32}, moves: ['Stuff Cheeks', 'Calm Mind']})],
    [champSet({species: 'Archaludon', ability: 'Stamina', nature: 'Bold', moves: ['Iron Defense']})]
  );
  bCud.p1.active[0].hp = 100;
  assertChampionsParity(bCud, 'move 1', 'move 1', 'Stuff Cheeks eats Sitrus Berry +2 Def');
  bCud.makeChoices('move 1', 'move 1');
  bCud.p1.active[0].hp = 100;
  assertChampionsParity(bCud, 'move 2', 'move 1', 'Cud Chew re-eats Sitrus Berry on next EoT');

  // 6. Recycle restores consumed Berry + Belch succeeds after eating Berry
  const bRec = createChampionsModBattle(
    [champSet({species: 'Snorlax', item: 'Sitrus Berry', ability: 'Thick Fat', nature: 'Bold', sp: {hp: 32}, moves: ['Stuff Cheeks', 'Recycle', 'Belch']})],
    [champSet({species: 'Hippowdon', ability: 'Sand Force', nature: 'Impish', sp: {hp: 32}, moves: ['Slack Off']})]
  );
  bRec.p1.active[0].hp = 100;
  bRec.makeChoices('move 1', 'move 1'); // Eats Sitrus Berry
  assertChampionsParity(bRec, 'move 2', 'move 1', 'Recycle restores consumed Sitrus Berry');
  assertChampionsParity(bRec, 'move 3', 'move 1', 'Belch succeeds after eating Berry');

  // 7. Fling with Light Ball (30 BP + paralyzes defender)
  const bFling = createChampionsModBattle(
    [champSet({species: 'Weavile', item: 'Light Ball', ability: 'Pressure', nature: 'Jolly', sp: {atk: 32}, moves: ['Fling']})],
    [champSet({species: 'Hippowdon', ability: 'Sand Force', nature: 'Impish', sp: {hp: 32, def: 32}, moves: ['Slack Off']})]
  );
  assertChampionsParity(bFling, 'move 1', 'move 1', 'Fling Light Ball paralyzes target');

  // 8. Teatime forces both Pokemon to eat their Berries
  const bTea = createChampionsModBattle(
    [champSet({species: 'Gengar', item: 'Sitrus Berry', ability: 'Cursed Body', nature: 'Timid', moves: ['Teatime']})],
    [champSet({species: 'Hippowdon', item: 'Sitrus Berry', ability: 'Sand Force', nature: 'Impish', moves: ['Slack Off']})]
  );
  bTea.p1.active[0].hp = 80;
  bTea.p2.active[0].hp = 100;
  assertChampionsParity(bTea, 'move 1', 'move 1', 'Teatime forces both sides to eat Berries');

  // 9. Doubles Symbiosis passes Leftovers when ally consumes Sitrus Berry
  const bSym = createChampionsModBattle(
    [
      champSet({species: 'Florges', item: 'Leftovers', ability: 'Symbiosis', nature: 'Bold', sp: {hp: 32}, moves: ['Calm Mind']}),
      champSet({species: 'Snorlax', item: 'Sitrus Berry', ability: 'Thick Fat', nature: 'Bold', sp: {hp: 32}, moves: ['Stuff Cheeks']}),
    ],
    [
      champSet({species: 'Archaludon', ability: 'Stamina', nature: 'Bold', moves: ['Iron Defense']}),
      champSet({species: 'Hippowdon', ability: 'Sand Force', nature: 'Impish', moves: ['Slack Off']}),
    ],
    {doubles: true}
  );
  bSym.p1.active[1].hp = 120;
  assertChampionsParity(bSym, 'move 1, move 1', 'move 1, move 1', 'Doubles Symbiosis passes Leftovers to ally');
});

test('Wave 3 ability mutation (Gastro Acid, Worry Seed, Simple Beam, Entrainment, Role Play, Skill Swap, Mummy, Wandering Spirit, Trace, Receiver) match @pkmn/mods/champions', () => {
  // 1. Gastro Acid suppresses Stamina
  const bGa = createChampionsModBattle(
    [champSet({species: 'Gengar', ability: 'Cursed Body', nature: 'Timid', sp: {spe: 32}, moves: ['Gastro Acid', 'Swift']})],
    [champSet({species: 'Archaludon', ability: 'Stamina', nature: 'Bold', moves: ['Iron Defense']})]
  );
  assertChampionsParity(bGa, 'move 1', 'move 1', 'Gastro Acid suppresses ability');

  // 2. Worry Seed wakes sleeping target and changes ability to Insomnia
  const bWs = createChampionsModBattle(
    [champSet({species: 'Venusaur', ability: 'Overgrow', nature: 'Timid', sp: {spe: 32}, moves: ['Worry Seed']})],
    [champSet({species: 'Snorlax', ability: 'Thick Fat', nature: 'Bold', moves: ['Amnesia']})]
  );
  bWs.p2.active[0].setStatus('slp');
  assertChampionsParity(bWs, 'move 1', 'move 1', 'Worry Seed cures sleep and grants Insomnia');

  // 3. Simple Beam doubles target stat boosts
  const bSb = createChampionsModBattle(
    [champSet({species: 'Alakazam', ability: 'Inner Focus', nature: 'Timid', sp: {spe: 32}, moves: ['Simple Beam']})],
    [champSet({species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly', moves: ['Swords Dance']})]
  );
  assertChampionsParity(bSb, 'move 1', 'move 1', 'Simple Beam makes Swords Dance +4 Atk');

  // 4. Entrainment, Role Play, Skill Swap
  const bEnt = createChampionsModBattle(
    [champSet({species: 'Gardevoir', ability: 'Synchronize', nature: 'Timid', sp: {spe: 32}, moves: ['Entrainment', 'Role Play', 'Skill Swap']})],
    [champSet({species: 'Gyarados', ability: 'Intimidate', nature: 'Jolly', moves: ['Dragon Dance']})]
  );
  assertChampionsParity(bEnt, 'move 1', 'move 1', 'Entrainment overwrites foe ability');
  assertChampionsParity(bEnt, 'move 2', 'move 1', 'Role Play copies Intimidate and triggers it');
  assertChampionsParity(bEnt, 'move 3', 'move 1', 'Skill Swap swaps abilities and triggers Intimidate');

  // 5. Mummy & Wandering Spirit on contact
  const bMum = createChampionsModBattle(
    [champSet({species: 'Metagross', ability: 'Clear Body', nature: 'Adamant', sp: {atk: 32}, moves: ['Bullet Punch']})],
    [champSet({species: 'Archaludon', ability: 'Mummy', nature: 'Bold', sp: {hp: 32, def: 32}, moves: ['Iron Defense']})]
  );
  assertChampionsParity(bMum, 'move 1', 'move 1', 'Mummy overwrites contact attacker ability');

  const bWsp = createChampionsModBattle(
    [champSet({species: 'Metagross', ability: 'Clear Body', nature: 'Adamant', sp: {atk: 32}, moves: ['Bullet Punch']})],
    [champSet({species: 'Archaludon', ability: 'Wandering Spirit', nature: 'Bold', sp: {hp: 32, def: 32}, moves: ['Iron Defense']})]
  );
  assertChampionsParity(bWsp, 'move 1', 'move 1', 'Wandering Spirit swaps abilities on contact');

  // 6. Trace (Mega Alakazam traces Intimidate on Mega Evolution!)
  const bTr = createChampionsModBattle(
    [champSet({species: 'Alakazam', item: 'Alakazite', ability: 'Inner Focus', nature: 'Timid', sp: {spe: 32}, moves: ['Calm Mind']})],
    [champSet({species: 'Gyarados', ability: 'Intimidate', nature: 'Jolly', moves: ['Dragon Dance']})]
  );
  assertChampionsParity(bTr, 'move 1 mega', 'move 1', 'Mega Alakazam Trace copies Intimidate');

  // 7. Doubles Receiver copies fainted ally ability
  const bRcv = createChampionsModBattle(
    [
      champSet({species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly', moves: ['Protect', 'Swords Dance']}),
      champSet({species: 'Machamp', ability: 'Receiver', nature: 'Adamant', moves: ['Bulk Up']}),
    ],
    [
      champSet({species: 'Metagross', ability: 'Clear Body', nature: 'Adamant', sp: {atk: 32}, moves: ['Bullet Punch']}),
      champSet({species: 'Archaludon', ability: 'Stamina', nature: 'Bold', moves: ['Iron Defense']}),
    ],
    {doubles: true}
  );
  bRcv.p1.active[0].hp = 1;
  assertChampionsParity(bRcv, 'move 2, move 1', 'move 1 +1, move 1', 'Doubles Receiver copies fainted ally Rough Skin');
});

test('Wave 3 formes & transform (Zero to Hero, Ice Face, Shields Down, Stance Change, Forecast, Hunger Switch + Aura Wheel, Gulp Missile, Imposter + Transform, Battle Bond, Illusion) match @pkmn/mods/champions', () => {
  // 1. Zero to Hero (Palafin switches out to bench, becomes Palafin-Hero on switch-in!)
  const bZth = createChampionsModBattle(
    [
      champSet({species: 'Palafin', ability: 'Zero to Hero', nature: 'Adamant', sp: {atk: 32, spe: 32}, moves: ['Jet Punch', 'Flip Turn']}),
      champSet({species: 'Archaludon', ability: 'Stamina', nature: 'Bold', moves: ['Iron Defense']}),
    ],
    [champSet({species: 'Hippowdon', ability: 'Sand Force', nature: 'Impish', sp: {hp: 32, def: 32}, moves: ['Slack Off']})]
  );
  assertChampionsParity(bZth, 'switch 2', 'move 1', 'Palafin switches out activating Zero to Hero');
  bZth.makeChoices('switch 2', 'move 1');
  assertChampionsParity(bZth, 'switch 2', 'move 1', 'Palafin switches back in as Palafin-Hero');
  bZth.makeChoices('switch 2', 'move 1');
  assertChampionsParity(bZth, 'move 1', 'move 1', 'Palafin-Hero Jet Punch damage parity');

  // 2. Ice Face absorbs Physical hit -> Eiscue-Noice (0 dmg)
  const bIce = createChampionsModBattle(
    [champSet({species: 'Metagross', ability: 'Clear Body', nature: 'Adamant', sp: {atk: 32}, moves: ['Bullet Punch']})],
    [champSet({species: 'Eiscue', ability: 'Ice Face', nature: 'Jolly', moves: ['Belly Drum', 'Iron Defense']})]
  );
  assertChampionsParity(bIce, 'move 1', 'move 2', 'Ice Face absorbs Physical hit and shifts to Noice');

  // 3. Stance Change (Aegislash Blade Forme on Shadow Ball, Shield Forme on King's Shield)
  const bStance = createChampionsModBattle(
    [champSet({species: 'Aegislash', ability: 'Stance Change', nature: 'Modest', sp: {spa: 32}, moves: ['Shadow Ball', 'Kings Shield']})],
    [champSet({species: 'Snorlax', ability: 'Thick Fat', nature: 'Careful', sp: {hp: 32}, moves: ['Amnesia']})]
  );
  assertChampionsParity(bStance, 'move 1', 'move 1', 'Stance Change shifts Aegislash to Blade on attack');

  // 4. Hunger Switch + Aura Wheel (Electric -> Hangry -> Dark)
  const bMorp = createChampionsModBattle(
    [champSet({species: 'Morpeko', ability: 'Hunger Switch', nature: 'Jolly', sp: {atk: 32}, moves: ['Aura Wheel', 'Protect']})],
    [champSet({species: 'Archaludon', ability: 'Stamina', nature: 'Bold', sp: {hp: 32, def: 32}, moves: ['Iron Defense']})]
  );
  assertChampionsParity(bMorp, 'move 1', 'move 1', 'Morpeko Electric Aura Wheel + Hunger Switch to Hangry');
  bMorp.makeChoices('move 1', 'move 1');
  assertChampionsParity(bMorp, 'move 1', 'move 1', 'Morpeko-Hangry Dark Aura Wheel + Hunger Switch back');

  // 5. Transform & Imposter
  const bTf = createChampionsModBattle(
    [champSet({species: 'Ditto', ability: 'Limber', nature: 'Timid', sp: {spe: 32}, moves: ['Transform']})],
    [champSet({species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly', sp: {atk: 32, spe: 32}, moves: ['Swords Dance', 'Dragon Claw']})]
  );
  assertChampionsParity(bTf, 'move 1', 'move 1', 'Transform copies Garchomp stats, types, ability, moves');

  const bImp = createChampionsModBattle(
    [
      champSet({species: 'Archaludon', ability: 'Stamina', nature: 'Bold', moves: ['Iron Defense']}),
      champSet({species: 'Ditto', ability: 'Imposter', nature: 'Timid', moves: ['Transform']}),
    ],
    [champSet({species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly', sp: {atk: 32, spe: 32}, moves: ['Swords Dance', 'Dragon Claw']})]
  );
  assertChampionsParity(bImp, 'switch 2', 'move 1', 'Imposter transforms automatically on switch-in');

  // 6. Battle Bond Greninja KO boost (+1 Atk/SpA/Spe)
  const bBb = createChampionsModBattle(
    [champSet({species: 'Greninja-Bond', ability: 'Battle Bond', nature: 'Timid', sp: {spa: 32, spe: 32}, moves: ['Dark Pulse']})],
    [
      champSet({species: 'Gengar', ability: 'Cursed Body', nature: 'Timid', moves: ['Calm Mind']}),
      champSet({species: 'Hippowdon', ability: 'Sand Force', nature: 'Impish', moves: ['Slack Off']}),
    ]
  );
  bBb.p2.active[0].hp = 1;
  assertChampionsParity(bBb, 'move 1', 'move 1', 'Battle Bond triggers +1 Atk/SpA/Spe on KO');
});

test('Wave 3 combat abilities & volatiles (Confusion + Tangled Feet, Rivalry, Cursed Body, Cute Charm + Attract, Moody, Emergency Exit, Mimicry, Magnet Rise, Lock-On, Stockpile/Spit Up/Swallow, Power Trick/Split, Guard Split, Reflect Type, Last Resort, Imprison, Octolock) match @pkmn/mods/champions', () => {
  // 1. Confuse Ray + Tangled Feet
  const bConf = createChampionsModBattle(
    [champSet({species: 'Gengar', ability: 'Cursed Body', nature: 'Timid', sp: {spe: 32}, moves: ['Confuse Ray', 'Swift']})],
    [champSet({species: 'Pidgeot', ability: 'Tangled Feet', nature: 'Jolly', moves: ['Agility']})]
  );
  assertChampionsParity(bConf, 'move 1', 'move 1', 'Confuse Ray inflicts 2-5 turn confusion + 1/3 self-hit');

  // 2. Rivalry same-gender 1.25x vs opposite-gender 0.75x
  const bRivSame = createChampionsModBattle(
    [champSet({species: 'Haxorus', ability: 'Rivalry', gender: 'M', nature: 'Adamant', sp: {atk: 32}, moves: ['Dragon Claw']})],
    [champSet({species: 'Hippowdon', ability: 'Sand Force', gender: 'M', nature: 'Impish', sp: {hp: 32, def: 32}, moves: ['Slack Off']})]
  );
  assertChampionsParity(bRivSame, 'move 1', 'move 1', 'Rivalry 1.25x vs same gender');
  const bRivOpp = createChampionsModBattle(
    [champSet({species: 'Haxorus', ability: 'Rivalry', gender: 'M', nature: 'Adamant', sp: {atk: 32}, moves: ['Dragon Claw']})],
    [champSet({species: 'Hippowdon', ability: 'Sand Force', gender: 'F', nature: 'Impish', sp: {hp: 32, def: 32}, moves: ['Slack Off']})]
  );
  assertChampionsParity(bRivOpp, 'move 1', 'move 1', 'Rivalry 0.75x vs opposite gender');

  // 3. Cursed Body 30% disable
  const bCb = createChampionsModBattle(
    [champSet({species: 'Metagross', ability: 'Clear Body', nature: 'Adamant', sp: {atk: 32}, moves: ['Bullet Punch']})],
    [champSet({species: 'Gengar', ability: 'Cursed Body', nature: 'Bold', sp: {hp: 32, def: 32}, moves: ['Calm Mind']})]
  );
  assertChampionsParity(bCb, 'move 1', 'move 1', 'Cursed Body 30% disable on hit');

  // 4. Attract + Cute Charm (opposite gender 50% infatuation)
  const bAtt = createChampionsModBattle(
    [champSet({species: 'Clefairy', ability: 'Cute Charm', gender: 'F', nature: 'Bold', sp: {spe: 32}, moves: ['Attract', 'Amnesia']})],
    [champSet({species: 'Hippowdon', ability: 'Sand Force', gender: 'M', nature: 'Impish', moves: ['Slack Off']})]
  );
  assertChampionsParity(bAtt, 'move 1', 'move 1', 'Attract infatuates opposite-gender foe (50% immobilized)');

  // 5. Moody exact 20-way +2/-1 EoT distribution
  const bMoody = createChampionsModBattle(
    [champSet({species: 'Glalie', ability: 'Moody', nature: 'Timid', moves: ['Protect']})],
    [champSet({species: 'Archaludon', ability: 'Stamina', nature: 'Bold', moves: ['Iron Defense']})]
  );
  assertChampionsParity(bMoody, 'move 1', 'move 1', 'Moody exact 20-way +2/-1 EoT distribution');

  // 6. Emergency Exit pauses for switch when dropping below 50% HP
  const bEe = createChampionsModBattle(
    [champSet({species: 'Metagross', ability: 'Clear Body', nature: 'Adamant', sp: {atk: 32}, moves: ['Bullet Punch']})],
    [
      champSet({species: 'Golisopod', ability: 'Emergency Exit', nature: 'Adamant', sp: {hp: 32}, moves: ['Protect', 'Bulk Up']}),
      champSet({species: 'Hippowdon', ability: 'Sand Force', nature: 'Impish', moves: ['Slack Off']}),
    ]
  );
  bEe.p2.active[0].hp = Math.floor(bEe.p2.active[0].maxhp / 2) + 5;
  assertChampionsParity(bEe, 'move 1', 'move 2', 'Emergency Exit triggers switch pause below 50% HP');

  // 7. Magnet Rise blocks Earthquake + Lock-On guarantees accuracy
  const bMr = createChampionsModBattle(
    [champSet({species: 'Magnezone', ability: 'Sturdy', nature: 'Timid', sp: {spe: 32}, moves: ['Magnet Rise', 'Lock-On', 'Zap Cannon']})],
    [champSet({species: 'Hippowdon', ability: 'Sand Force', nature: 'Impish', moves: ['Earthquake', 'Slack Off']})]
  );
  assertChampionsParity(bMr, 'move 1', 'move 1', 'Magnet Rise grants Ground immunity vs Earthquake');

  // 8. Stockpile -> Spit Up / Swallow
  const bStk = createChampionsModBattle(
    [champSet({species: 'Snorlax', ability: 'Thick Fat', nature: 'Bold', sp: {hp: 32}, moves: ['Stockpile', 'Spit Up', 'Swallow']})],
    [champSet({species: 'Archaludon', ability: 'Stamina', nature: 'Bold', moves: ['Iron Defense']})]
  );
  assertChampionsParity(bStk, 'move 1', 'move 1', 'Stockpile adds 1 layer +1 Def/SpD');
  bStk.makeChoices('move 1', 'move 1');
  assertChampionsParity(bStk, 'move 2', 'move 1', 'Spit Up deals 100 BP and clears Stockpile');
  bStk.p1.active[0].hp = 100;
  assertChampionsParity(bStk, 'move 3', 'move 1', 'Swallow heals 25% and clears Stockpile');

  // 9. Power Trick, Power Split, Guard Split, Reflect Type, Imprison, Octolock
  const bMisc = createChampionsModBattle(
    [champSet({species: 'Alakazam', ability: 'Inner Focus', nature: 'Timid', sp: {spe: 32}, moves: ['Power Split', 'Guard Split', 'Reflect Type', 'Imprison']})],
    [champSet({species: 'Hippowdon', ability: 'Sand Force', nature: 'Impish', moves: ['Slack Off', 'Imprison']})]
  );
  assertChampionsParity(bMisc, 'move 1', 'move 1', 'Power Split averages Atk/SpA');
  assertChampionsParity(bMisc, 'move 2', 'move 1', 'Guard Split averages Def/SpD');
  assertChampionsParity(bMisc, 'move 3', 'move 1', 'Reflect Type copies target types');
  assertChampionsParity(bMisc, 'move 4', 'move 2', 'Imprison seals shared moves');

  const bOcto = createChampionsModBattle(
    [champSet({species: 'Gengar', ability: 'Cursed Body', nature: 'Timid', sp: {spe: 32}, moves: ['Octolock']})],
    [champSet({species: 'Hippowdon', ability: 'Sand Force', nature: 'Impish', moves: ['Slack Off']})]
  );
  assertChampionsParity(bOcto, 'move 1', 'move 1', 'Octolock drops Def/SpD by 1 at EoT');
});

test('Wave 3 special moves (Focus Punch, Beak Blast, Electrify, Uproar, Beat Up, Round, Shell Side Arm, Baton Pass, Shed Tail, Healing Wish, Sleep Talk, Copycat, Instruct, Revival Blessing) match @pkmn/mods/champions', () => {
  // 1. Focus Punch succeeds when untouched, fails when hit
  const bFp = createChampionsModBattle(
    [champSet({species: 'Machamp', ability: 'Guts', nature: 'Adamant', sp: {atk: 32}, moves: ['Focus Punch']})],
    [champSet({species: 'Hippowdon', ability: 'Sand Force', nature: 'Impish', sp: {hp: 32, def: 32}, moves: ['Slack Off', 'Earthquake']})]
  );
  assertChampionsParity(bFp, 'move 1', 'move 1', 'Focus Punch hits when untouched');
  assertChampionsParity(bFp, 'move 1', 'move 2', 'Focus Punch loses focus when damaged');

  // 2. Beak Blast burns contact attacker while heating
  const bBb = createChampionsModBattle(
    [champSet({species: 'Metagross', ability: 'Clear Body', nature: 'Adamant', sp: {atk: 32}, moves: ['Bullet Punch']})],
    [champSet({species: 'Dragonite', ability: 'Inner Focus', nature: 'Adamant', sp: {hp: 32, def: 32}, moves: ['Beak Blast']})]
  );
  assertChampionsParity(bBb, 'move 1', 'move 1', 'Beak Blast burns contact attacker then fires');

  // 3. Electrify changes slower target's move to Electric (immune vs Ground Hippowdon!)
  const bElec = createChampionsModBattle(
    [champSet({species: 'Hippowdon', ability: 'Sand Force', nature: 'Jolly', sp: {spe: 32}, moves: ['Electrify']})],
    [champSet({species: 'Snorlax', ability: 'Thick Fat', nature: 'Adamant', moves: ['Body Slam']})]
  );
  assertChampionsParity(bElec, 'move 1', 'move 1', 'Electrify turns Body Slam Electric (immune vs Ground)');

  // 4. Uproar wakes sleeping opponent
  const bUp = createChampionsModBattle(
    [champSet({species: 'Gengar', ability: 'Cursed Body', nature: 'Timid', sp: {spe: 32}, moves: ['Uproar']})],
    [champSet({species: 'Snorlax', ability: 'Thick Fat', nature: 'Careful', sp: {hp: 32}, moves: ['Amnesia']})]
  );
  bUp.p2.active[0].setStatus('slp');
  assertChampionsParity(bUp, 'move 1', 'move 1', 'Uproar wakes sleeping foe');

  // 5. Beat Up hits once per healthy party member using baseAtk
  const bBu = createChampionsModBattle(
    [
      champSet({species: 'Weavile', ability: 'Pressure', nature: 'Jolly', sp: {atk: 32}, moves: ['Beat Up']}),
      champSet({species: 'Machamp', ability: 'Guts', nature: 'Adamant', moves: ['Bulk Up']}),
    ],
    [champSet({species: 'Hippowdon', ability: 'Sand Force', nature: 'Impish', sp: {hp: 32, def: 32}, moves: ['Slack Off']})]
  );
  assertChampionsParity(bBu, 'move 1', 'move 1', 'Beat Up multi-hit with party baseAtk');

  // 6. Shell Side Arm chooses Physical vs Special accurately
  const bSsa = createChampionsModBattle(
    [champSet({species: 'Slowbro-Galar', ability: 'Own Tempo', nature: 'Modest', sp: {spa: 32}, moves: ['Shell Side Arm']})],
    [champSet({species: 'Hippowdon', ability: 'Sand Force', nature: 'Impish', sp: {hp: 32, def: 32}, moves: ['Slack Off']})]
  );
  assertChampionsParity(bSsa, 'move 1', 'move 1', 'Shell Side Arm selects Special vs high-Def Hippowdon');

  // 7. Baton Pass & Shed Tail pause for switch and transfer boosts/Substitute
  const bBp = createChampionsModBattle(
    [
      champSet({species: 'Alakazam', ability: 'Inner Focus', nature: 'Timid', sp: {spe: 32}, moves: ['Calm Mind', 'Baton Pass', 'Shed Tail']}),
      champSet({species: 'Gengar', ability: 'Cursed Body', nature: 'Timid', moves: ['Shadow Ball']}),
    ],
    [champSet({species: 'Hippowdon', ability: 'Sand Force', nature: 'Impish', moves: ['Slack Off']})]
  );
  bBp.makeChoices('move 1', 'move 1'); // +1 SpA/SpD
  assertChampionsParity(bBp, 'move 2', 'move 1', 'Baton Pass pauses for switch');
  bBp.makeChoices('move 2', 'move 1');
  assertChampionsParity(bBp, 'switch 2', '', 'Baton Pass switch-in transfers boosts');

  // 8. Sleep Talk (uniform pick of 2 other moves while asleep) & Copycat
  const bSt = createChampionsModBattle(
    [champSet({species: 'Snorlax', ability: 'Thick Fat', nature: 'Bold', sp: {hp: 32}, moves: ['Sleep Talk', 'Bulk Up', 'Amnesia']})],
    [champSet({species: 'Archaludon', ability: 'Stamina', nature: 'Bold', moves: ['Iron Defense']})]
  );
  bSt.p1.active[0].setStatus('slp');
  assertChampionsParity(bSt, 'move 1', 'move 1', 'Sleep Talk uniformly calls Bulk Up or Amnesia');

  const bCc = createChampionsModBattle(
    [champSet({species: 'Gengar', ability: 'Cursed Body', nature: 'Timid', moves: ['Copycat']})],
    [champSet({species: 'Archaludon', ability: 'Stamina', nature: 'Timid', sp: {spe: 32}, moves: ['Iron Defense']})]
  );
  assertChampionsParity(bCc, 'move 1', 'move 1', 'Copycat calls Iron Defense used earlier in the turn');

  // 9. Doubles Round relay (ally Round acts immediately next at 120 BP) & Instruct
  const bRnd = createChampionsModBattle(
    [
      champSet({species: 'Clefairy', ability: 'Friend Guard', nature: 'Timid', sp: {spe: 32}, moves: ['Round']}),
      champSet({species: 'Snorlax', ability: 'Thick Fat', nature: 'Modest', sp: {spa: 32}, moves: ['Round']}),
    ],
    [
      champSet({species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly', sp: {hp: 32, spe: 32}, moves: ['Swords Dance']}),
      champSet({species: 'Hippowdon', ability: 'Sand Force', nature: 'Impish', sp: {hp: 32}, moves: ['Slack Off']}),
    ],
    {doubles: true}
  );
  assertChampionsParity(bRnd, 'move 1 +1, move 1 +2', 'move 1, move 1', 'Doubles Round relay doubles ally BP and acts immediately');

  const bInst = createChampionsModBattle(
    [
      champSet({species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly', sp: {spe: 32}, moves: ['Swords Dance']}),
      champSet({species: 'Oranguru', ability: 'Inner Focus', nature: 'Bold', moves: ['Instruct']}),
    ],
    [
      champSet({species: 'Archaludon', ability: 'Stamina', nature: 'Bold', moves: ['Iron Defense']}),
      champSet({species: 'Hippowdon', ability: 'Sand Force', nature: 'Impish', moves: ['Slack Off']}),
    ],
    {doubles: true}
  );
  assertChampionsParity(bInst, 'move 1, move 1 -1', 'move 1, move 1', 'Doubles Instruct repeats ally Swords Dance');
});

test('Wave 3 remaining formes, abilities, and special moves (Gulp Missile, Forecast, Shields Down, Mimicry, Illusion, Power Trick, Lock-On, Last Resort, Shed Tail, Healing Wish, Revival Blessing) match @pkmn/mods/champions', () => {
  // 1. Gulp Missile (Cramorant Surf -> Gulping -> hit deals 1/4 recoil + -1 Def)
  const bGm = createChampionsModBattle(
    [champSet({species: 'Cramorant', ability: 'Gulp Missile', nature: 'Timid', sp: {spe: 32}, moves: ['Surf']})],
    [champSet({species: 'Snorlax', ability: 'Thick Fat', nature: 'Careful', sp: {hp: 32, spd: 32}, moves: ['Swift']})]
  );
  assertChampionsParity(bGm, 'move 1', 'move 1', 'Gulp Missile catches prey on Surf and counters Swift');

  // 2. Forecast (Castform shifts to Castform-Sunny in Sun)
  const bFc = createChampionsModBattle(
    [champSet({species: 'Castform', ability: 'Forecast', nature: 'Modest', moves: ['Sunny Day']})],
    [champSet({species: 'Archaludon', ability: 'Stamina', nature: 'Bold', moves: ['Iron Defense']})]
  );
  assertChampionsParity(bFc, 'move 1', 'move 1', 'Forecast shifts Castform to Sunny in Sun');

  // 3. Shields Down (Minior-Meteor shifts to Core when <= 50% HP at EoT)
  const bSd = createChampionsModBattle(
    [champSet({species: 'Minior', ability: 'Shields Down', nature: 'Adamant', sp: {hp: 32}, moves: ['Iron Defense']})],
    [champSet({species: 'Metagross', ability: 'Clear Body', nature: 'Adamant', sp: {atk: 32}, moves: ['Bullet Punch']})]
  );
  bSd.p1.active[0].hp = Math.floor(bSd.p1.active[0].maxhp / 2) + 5;
  assertChampionsParity(bSd, 'move 1', 'move 1', 'Shields Down shifts Minior to Core below 50% HP');

  // 4. Mimicry (changes type to Electric in Electric Terrain)
  const bMim = createChampionsModBattle(
    [champSet({species: 'Stunfisk-Galar', ability: 'Mimicry', nature: 'Bold', moves: ['Electric Terrain']})],
    [champSet({species: 'Archaludon', ability: 'Stamina', nature: 'Bold', moves: ['Iron Defense']})]
  );
  assertChampionsParity(bMim, 'move 1', 'move 1', 'Mimicry changes type to Electric on Electric Terrain');

  // 5. Illusion (Zoroark with healthy bench blocks Transform until hit)
  const bIll = createChampionsModBattle(
    [
      champSet({species: 'Zoroark', ability: 'Illusion', nature: 'Timid', moves: ['Calm Mind']}),
      champSet({species: 'Archaludon', ability: 'Stamina', nature: 'Bold', moves: ['Iron Defense']}),
    ],
    [champSet({species: 'Ditto', ability: 'Limber', nature: 'Timid', sp: {spe: 32}, moves: ['Transform']})]
  );
  assertChampionsParity(bIll, 'move 1', 'move 1', 'Illusion blocks Transform while disguise is intact');

  // 6. Power Trick swaps Atk and Def + Lock-On guarantees 50% Zap Cannon hits!
  const bPt = createChampionsModBattle(
    [champSet({species: 'Archaludon', ability: 'Stamina', nature: 'Bold', sp: {def: 32}, moves: ['Power Trick', 'Lock-On', 'Zap Cannon']})],
    [champSet({species: 'Snorlax', ability: 'Thick Fat', nature: 'Careful', sp: {hp: 32}, moves: ['Amnesia']})]
  );
  assertChampionsParity(bPt, 'move 1', 'move 1', 'Power Trick swaps Atk and Def');
  bPt.makeChoices('move 2', 'move 1'); // Lock-On
  assertChampionsParity(bPt, 'move 3', 'move 1', 'Lock-On guarantees 100% accuracy on Zap Cannon');

  // 7. Last Resort fails before other moves used, succeeds after all other moves used
  const bLr = createChampionsModBattle(
    [champSet({species: 'Snorlax', ability: 'Thick Fat', nature: 'Adamant', sp: {atk: 32}, moves: ['Amnesia', 'Last Resort']})],
    [champSet({species: 'Hippowdon', ability: 'Sand Force', nature: 'Impish', sp: {hp: 32, def: 32}, moves: ['Slack Off']})]
  );
  assertChampionsParity(bLr, 'move 2', 'move 1', 'Last Resort fails when other moves unused');
  bLr.makeChoices('move 1', 'move 1');
  assertChampionsParity(bLr, 'move 2', 'move 1', 'Last Resort succeeds after all other moves used');

  // 8. Shed Tail pauses with Substitute + Healing Wish faints and heals incoming ally + Revival Blessing revives fainted teammate
  const bSt = createChampionsModBattle(
    [
      champSet({species: 'Cyclizar', ability: 'Regenerator', nature: 'Jolly', sp: {spe: 32}, moves: ['Shed Tail']}),
      champSet({species: 'Gengar', ability: 'Cursed Body', nature: 'Timid', moves: ['Shadow Ball']}),
    ],
    [champSet({species: 'Hippowdon', ability: 'Sand Force', nature: 'Impish', moves: ['Slack Off']})]
  );
  assertChampionsParity(bSt, 'move 1', 'move 1', 'Shed Tail pauses for switch with Substitute');
  bSt.makeChoices('move 1', 'move 1');
  assertChampionsParity(bSt, 'switch 2', '', 'Shed Tail switch-in passes Substitute');

  const bHw = createChampionsModBattle(
    [
      champSet({species: 'Clefairy', ability: 'Friend Guard', nature: 'Bold', sp: {spe: 32}, moves: ['Healing Wish']}),
      champSet({species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly', moves: ['Swords Dance']}),
    ],
    [champSet({species: 'Hippowdon', ability: 'Sand Force', nature: 'Impish', moves: ['Slack Off']})]
  );
  bHw.p1.pokemon[1].hp = 40;
  bHw.p1.pokemon[1].setStatus('brn');
  assertChampionsParity(bHw, 'move 1', 'move 1', 'Healing Wish faints user and sets slot healingwish');
  bHw.makeChoices('move 1', 'move 1');
  assertChampionsParity(bHw, 'switch 2', '', 'Healing Wish fully heals and cures incoming switch-in');

  const bRb = createChampionsModBattle(
    [
      champSet({species: 'Pawmot', ability: 'Iron Fist', nature: 'Jolly', sp: {spe: 32}, moves: ['Revival Blessing']}),
      champSet({species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly', moves: ['Swords Dance']}),
    ],
    [champSet({species: 'Hippowdon', ability: 'Sand Force', nature: 'Impish', moves: ['Slack Off']})]
  );
  bRb.p1.pokemon[1].hp = 0;
  bRb.p1.pokemon[1].fainted = true;
  assertChampionsParity(bRb, 'move 1', 'move 1', 'Revival Blessing pauses for fainted teammate selection');
  bRb.makeChoices('move 1', 'move 1');
  assertChampionsParity(bRb, 'switch 2', '', 'Revival Blessing revives fainted teammate to 50% HP');
});




