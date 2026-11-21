import fs from 'node:fs';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {Teams, toID} = require('@pkmn/sim');
const {BoundedSolver} = require('../dist/src/bounded-solver');
const {canRunInEngine, compileContextFromBattle, stateFromBattle, legalSideActions} = require('../dist/src/engine');
const {createChampionsModBattle} = require('../dist/src/engine/ruleset');

const REPLAY_DIR = path.resolve('data/champions-replays/doubles');

function parseArgs(argv) {
  const opts = {
    rem: 2,
    maxMs: 5000,
    tol: 0.04,
    limit: 0,
    filter: '',
    includeForfeit: false,
    profile: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--rem' && argv[i + 1]) opts.rem = Number(argv[++i]);
    else if (a === '--max-ms' && argv[i + 1]) opts.maxMs = Number(argv[++i]);
    else if (a === '--tol' && argv[i + 1]) opts.tol = Number(argv[++i]);
    else if (a === '--limit' && argv[i + 1]) opts.limit = Number(argv[++i]);
    else if (a === '--filter' && argv[i + 1]) opts.filter = argv[++i];
    else if (a === '--include-forfeit') opts.includeForfeit = true;
    else if (a === '--profile') opts.profile = true;
  }
  return opts;
}

function speciesBase(details) {
  return details.split(',')[0].trim();
}

function parseHpFraction(hpStr) {
  if (!hpStr) return {pct: 100, status: ''};
  const parts = hpStr.trim().split(/\s+/);
  const status = parts[1] || '';
  if (parts[0] === '0' || parts[0].startsWith('0/')) return {pct: 0, status: 'fnt'};
  const m = parts[0].match(/^(\d+)\/(\d+)$/);
  if (!m) return {pct: 100, status};
  return {pct: (Number(m[1]) / Number(m[2])) * 100, status};
}

function findSetBySpecies(team, speciesName) {
  const id = toID(speciesName);
  const exact = team.find(s => toID(s.species) === id);
  if (exact) return exact;
  // Base species prefix match (e.g. Gardevoir-Mega -> Gardevoir, Ogerpon-Hearthflame -> Ogerpon-Hearthflame)
  return team.find(s => id.startsWith(toID(s.species)) || toID(s.species).startsWith(id)) || null;
}

/**
 * Parse a Champions VGC Bo3 OTS replay and reconstruct the battle state at
 * `targetTurn = finalTurn - (rem - 1)`. Returns null if the replay ended by
 * forfeit (unless allowed), has >3 alive Pokemon on either side, or has
 * unrevealed surviving Pokemon (incomplete information).
 */
function extractEndgameFromReplay(replayPath, rem, includeForfeit = false) {
  const raw = JSON.parse(fs.readFileSync(replayPath, 'utf8'));
  const lines = String(raw.log || '').split('\n');
  if (!includeForfeit && lines.some(l => l.startsWith('|-message|') && l.includes('forfeited'))) {
    return null;
  }

  let finalTurn = 0;
  for (const line of lines) {
    if (line.startsWith('|turn|')) {
      const t = Number(line.split('|')[2]);
      if (t > finalTurn) finalTurn = t;
    }
  }
  const targetTurn = finalTurn - (rem - 1);
  if (targetTurn < 1) return null;

  const showteams = {p1: [], p2: []};
  for (const line of lines) {
    if (line.startsWith('|showteam|p1|')) {
      showteams.p1 = Teams.unpack(line.slice('|showteam|p1|'.length)) || [];
    } else if (line.startsWith('|showteam|p2|')) {
      showteams.p2 = Teams.unpack(line.slice('|showteam|p2|'.length)) || [];
    }
  }
  if (!showteams.p1.length || !showteams.p2.length) return null;

  // Track dynamic state up to the start of `targetTurn`
  const sides = {
    p1: {
      revealed: new Map(), // speciesId -> monState
      active: [null, null], // speciesId per slot
      megaUsed: false,
      tailwindTurns: 0,
      reflectTurns: 0,
      lightScreenTurns: 0,
      auroraVeilTurns: 0,
      stealthRock: false,
      spikes: 0,
    },
    p2: {
      revealed: new Map(),
      active: [null, null],
      megaUsed: false,
      tailwindTurns: 0,
      reflectTurns: 0,
      lightScreenTurns: 0,
      auroraVeilTurns: 0,
      stealthRock: false,
      spikes: 0,
    },
  };
  const field = {
    weather: '',
    weatherTurns: 0,
    terrain: '',
    terrainTurns: 0,
    trickRoomTurns: 0,
  };

  const ensureMon = (sideKey, speciesName) => {
    const set = findSetBySpecies(showteams[sideKey], speciesName);
    if (!set) return null;
    const key = toID(set.species);
    let mon = sides[sideKey].revealed.get(key);
    if (!mon) {
      mon = {
        set,
        speciesKey: key,
        pct: 100,
        fainted: false,
        status: '',
        boosts: {atk: 0, def: 0, spa: 0, spd: 0, spe: 0, acc: 0, eva: 0},
        itemConsumed: false,
        megaEvolved: false,
        megaSpecies: null,
        ppUsed: new Map(),
      };
      sides[sideKey].revealed.set(key, mon);
    }
    return mon;
  };

  const parseSlot = token => {
    if (!token) return null;
    const m = token.match(/^(p1|p2)([ab]):/);
    if (!m) return null;
    return {sideKey: m[1], slot: m[2] === 'a' ? 0 : 1};
  };

  const getActiveMon = token => {
    const pos = parseSlot(token);
    if (!pos) return null;
    const key = sides[pos.sideKey].active[pos.slot];
    return key ? sides[pos.sideKey].revealed.get(key) || null : null;
  };

  let curTurn = 0;
  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    const parts = line.split('|');
    const cmd = parts[1];

    if (cmd === 'turn') {
      curTurn = Number(parts[2]);
      if (curTurn >= targetTurn) break;
      continue;
    }

    if (cmd === 'upkeep') {
      // End-of-turn duration decrements
      if (field.weatherTurns > 0 && --field.weatherTurns === 0) field.weather = '';
      if (field.terrainTurns > 0 && --field.terrainTurns === 0) field.terrain = '';
      if (field.trickRoomTurns > 0) field.trickRoomTurns--;
      for (const sk of ['p1', 'p2']) {
        const s = sides[sk];
        if (s.tailwindTurns > 0) s.tailwindTurns--;
        if (s.reflectTurns > 0) s.reflectTurns--;
        if (s.lightScreenTurns > 0) s.lightScreenTurns--;
        if (s.auroraVeilTurns > 0) s.auroraVeilTurns--;
      }
      continue;
    }

    if (cmd === 'switch' || cmd === 'drag') {
      const pos = parseSlot(parts[2]);
      if (!pos) continue;
      const mon = ensureMon(pos.sideKey, speciesBase(parts[3] || ''));
      if (!mon) continue;
      // Switching resets boosts
      mon.boosts = {atk: 0, def: 0, spa: 0, spd: 0, spe: 0, acc: 0, eva: 0};
      const hp = parseHpFraction(parts[4]);
      mon.pct = hp.pct;
      if (hp.status === 'fnt') mon.fainted = true;
      else mon.status = hp.status;
      sides[pos.sideKey].active[pos.slot] = mon.speciesKey;
    } else if (cmd === '-damage' || cmd === '-heal' || cmd === '-sethp') {
      const mon = getActiveMon(parts[2]);
      if (!mon) continue;
      const hp = parseHpFraction(parts[3]);
      mon.pct = hp.pct;
      if (hp.status === 'fnt') mon.fainted = true;
      else if (hp.status) mon.status = hp.status;
    } else if (cmd === 'faint') {
      const mon = getActiveMon(parts[2]);
      if (!mon) continue;
      mon.pct = 0;
      mon.fainted = true;
      mon.status = 'fnt';
    } else if (cmd === '-status') {
      const mon = getActiveMon(parts[2]);
      if (mon) mon.status = parts[3] || '';
    } else if (cmd === '-curestatus') {
      const mon = getActiveMon(parts[2]);
      if (mon) mon.status = '';
    } else if (cmd === '-boost' || cmd === '-unboost') {
      const mon = getActiveMon(parts[2]);
      const stat = parts[3];
      const amt = Number(parts[4] || 0);
      if (mon && stat in mon.boosts) {
        const delta = cmd === '-boost' ? amt : -amt;
        mon.boosts[stat] = Math.max(-6, Math.min(6, mon.boosts[stat] + delta));
      }
    } else if (cmd === '-setboost') {
      const mon = getActiveMon(parts[2]);
      const stat = parts[3];
      const amt = Number(parts[4] || 0);
      if (mon && stat in mon.boosts) mon.boosts[stat] = Math.max(-6, Math.min(6, amt));
    } else if (cmd === '-clearallboost') {
      for (const sk of ['p1', 'p2']) {
        for (const k of sides[sk].active) {
          const m = k ? sides[sk].revealed.get(k) : null;
          if (m) m.boosts = {atk: 0, def: 0, spa: 0, spd: 0, spe: 0, acc: 0, eva: 0};
        }
      }
    } else if (cmd === '-clearboost') {
      const mon = getActiveMon(parts[2]);
      if (mon) mon.boosts = {atk: 0, def: 0, spa: 0, spd: 0, spe: 0, acc: 0, eva: 0};
    } else if (cmd === '-clearnegativeboost') {
      const mon = getActiveMon(parts[2]);
      if (mon) {
        for (const k of Object.keys(mon.boosts)) {
          if (mon.boosts[k] < 0) mon.boosts[k] = 0;
        }
      }
    } else if (cmd === '-enditem') {
      const mon = getActiveMon(parts[2]);
      if (mon) mon.itemConsumed = true;
    } else if (cmd === '-mega') {
      const pos = parseSlot(parts[2]);
      const mon = getActiveMon(parts[2]);
      if (pos && mon) {
        sides[pos.sideKey].megaUsed = true;
        mon.megaEvolved = true;
        mon.megaSpecies = parts[3] || null;
      }
    } else if (cmd === 'move') {
      const mon = getActiveMon(parts[2]);
      const moveId = toID(parts[3] || '');
      if (mon && moveId) {
        mon.ppUsed.set(moveId, (mon.ppUsed.get(moveId) || 0) + 1);
      }
    } else if (cmd === '-weather') {
      const w = parts[2] || '';
      if (w === 'none') {
        field.weather = '';
        field.weatherTurns = 0;
      } else if (!parts.includes('[upkeep]')) {
        field.weather = toID(w);
        field.weatherTurns = 5;
      }
    } else if (cmd === '-fieldstart') {
      const eff = (parts[2] || '').replace(/^move:\s*/i, '');
      const id = toID(eff);
      if (id.endsWith('terrain')) {
        field.terrain = id;
        field.terrainTurns = 5;
      } else if (id === 'trickroom') {
        field.trickRoomTurns = 5;
      }
    } else if (cmd === '-fieldend') {
      const eff = (parts[2] || '').replace(/^move:\s*/i, '');
      const id = toID(eff);
      if (id === field.terrain) {
        field.terrain = '';
        field.terrainTurns = 0;
      } else if (id === 'trickroom') {
        field.trickRoomTurns = 0;
      }
    } else if (cmd === '-sidestart') {
      const sk = (parts[2] || '').slice(0, 2);
      const eff = toID((parts[3] || '').replace(/^move:\s*/i, ''));
      if (sk === 'p1' || sk === 'p2') {
        if (eff === 'tailwind') sides[sk].tailwindTurns = 4;
        else if (eff === 'reflect') sides[sk].reflectTurns = 5;
        else if (eff === 'lightscreen') sides[sk].lightScreenTurns = 5;
        else if (eff === 'auroraveil') sides[sk].auroraVeilTurns = 5;
        else if (eff === 'stealthrock') sides[sk].stealthRock = true;
        else if (eff === 'spikes') sides[sk].spikes = Math.min(3, sides[sk].spikes + 1);
      }
    } else if (cmd === '-sideend') {
      const sk = (parts[2] || '').slice(0, 2);
      const eff = toID((parts[3] || '').replace(/^move:\s*/i, ''));
      if (sk === 'p1' || sk === 'p2') {
        if (eff === 'tailwind') sides[sk].tailwindTurns = 0;
        else if (eff === 'reflect') sides[sk].reflectTurns = 0;
        else if (eff === 'lightscreen') sides[sk].lightScreenTurns = 0;
        else if (eff === 'auroraveil') sides[sk].auroraVeilTurns = 0;
        else if (eff === 'stealthrock') sides[sk].stealthRock = false;
        else if (eff === 'spikes') sides[sk].spikes = 0;
      }
    }
  }

  // Require complete information (all 4 brought mons revealed on each side, or <= 3 alive & all revealed)
  const buildSideRoster = sk => {
    const s = sides[sk];
    const faintedCount = [...s.revealed.values()].filter(m => m.fainted).length;
    const aliveExpected = 4 - faintedCount;
    const revealedAlive = [...s.revealed.values()].filter(m => !m.fainted);
    if (revealedAlive.length < aliveExpected) return null; // unrevealed bench mon
    if (aliveExpected < 1 || aliveExpected > 3) return null; // outside <= 3v3 endgame

    // Active slots first (slot 0, slot 1), then surviving bench
    const ordered = [];
    const used = new Set();
    for (let sl = 0; sl < 2; sl++) {
      const k = s.active[sl];
      if (k && s.revealed.has(k) && !s.revealed.get(k).fainted) {
        ordered.push(s.revealed.get(k));
        used.add(k);
      }
    }
    for (const m of revealedAlive) {
      if (!used.has(m.speciesKey)) ordered.push(m);
    }
    return ordered;
  };

  const r1 = buildSideRoster('p1');
  const r2 = buildSideRoster('p2');
  if (!r1 || !r2) return null;

  // Build Showdown Battle with official Champions doubles mod
  const makeTeam = (roster, sk) => {
    const sets = roster.map(m => ({
      name: m.set.name || m.set.species,
      species: m.set.species,
      item: m.itemConsumed ? '' : (m.set.item || ''),
      ability: m.set.ability || '',
      moves: (m.set.moves || []).slice(0, 4),
      nature: m.set.nature || 'Serious',
      evs: {hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0},
      ivs: {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31},
      level: m.set.level || 50,
    }));
    if (sets.length === 1) {
      // Pad doubles slot 1 with an already-fainted mon from the replay so Battle initializes cleanly
      const faintedMon = [...sides[sk].revealed.values()].find(m => m.fainted) || {set: showteams[sk][0]};
      sets.push({
        name: faintedMon.set.name || faintedMon.set.species,
        species: faintedMon.set.species,
        item: '',
        ability: faintedMon.set.ability || '',
        moves: (faintedMon.set.moves || []).slice(0, 4),
        nature: faintedMon.set.nature || 'Serious',
        evs: {hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0},
        ivs: {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31},
        level: faintedMon.set.level || 50,
      });
    }
    return sets;
  };

  const battle = createChampionsModBattle(makeTeam(r1, 'p1'), makeTeam(r2, 'p2'), {doubles: true});

  // Apply exact reconstructed HP, status, boosts, Mega state, PP, weather, terrain, side conditions
  const applyRoster = (side, sk, roster) => {
    const sInfo = sides[sk];
    if (roster.length === 1 && side.pokemon.length > 1) {
      const fnt = side.pokemon[1];
      fnt.hp = 0;
      fnt.fainted = true;
      fnt.status = 'fnt';
      side.pokemonLeft = 1;
    }
    for (let i = 0; i < roster.length; i++) {
      const m = roster[i];
      const p = side.pokemon[i];
      if (!p) continue;
      p.hp = Math.max(1, Math.min(p.maxhp, Math.round((p.maxhp * m.pct) / 100)));
      if (m.status && m.status !== 'fnt') {
        p.status = m.status;
        p.statusState = {id: m.status, target: p};
        if (m.status === 'tox') p.statusState.stage = 1;
        if (m.status === 'slp') {
          p.statusState.time = 2;
          p.statusState.startTime = 2;
        }
      }
      for (const [st, val] of Object.entries(m.boosts)) {
        if (val !== 0) p.boosts[st] = val;
      }
      for (const slot of p.moveSlots) {
        const used = m.ppUsed.get(slot.id) || 0;
        if (used > 0) slot.pp = Math.max(1, slot.maxpp - used);
      }
      if (m.megaEvolved && m.set.item) {
        const item = battle.dex.items.get(m.set.item);
        if (item && item.megaStone) {
          const targetForme = typeof item.megaStone === 'string'
            ? item.megaStone
            : Object.values(item.megaStone)[0];
          if (targetForme) {
            p.formeChange(targetForme, null, true);
            p.canMegaEvo = null;
          }
        }
      }
    }
    if (sInfo.megaUsed) {
      for (const p of side.pokemon) p.canMegaEvo = null;
    }
    if (sInfo.tailwindTurns > 0) side.sideConditions.tailwind = {id: 'tailwind', duration: sInfo.tailwindTurns};
    if (sInfo.reflectTurns > 0) side.sideConditions.reflect = {id: 'reflect', duration: sInfo.reflectTurns};
    if (sInfo.lightScreenTurns > 0) side.sideConditions.lightscreen = {id: 'lightscreen', duration: sInfo.lightScreenTurns};
    if (sInfo.auroraVeilTurns > 0) side.sideConditions.auroraveil = {id: 'auroraveil', duration: sInfo.auroraVeilTurns};
    if (sInfo.stealthRock) side.sideConditions.stealthrock = {id: 'stealthrock'};
    if (sInfo.spikes > 0) side.sideConditions.spikes = {id: 'spikes', layers: sInfo.spikes};
  };

  applyRoster(battle.p1, 'p1', r1);
  applyRoster(battle.p2, 'p2', r2);

  if (field.weather) {
    battle.field.weather = field.weather;
    battle.field.weatherState = {id: field.weather, duration: Math.max(1, field.weatherTurns)};
  }
  if (field.terrain) {
    battle.field.terrain = field.terrain;
    battle.field.terrainState = {id: field.terrain, duration: Math.max(1, field.terrainTurns)};
  }
  if (field.trickRoomTurns > 0) {
    battle.field.pseudoWeather.trickroom = {id: 'trickroom', duration: field.trickRoomTurns};
  }

  return {
    id: raw.id || path.basename(replayPath, '.json'),
    shortId: (raw.id || path.basename(replayPath, '.json')).split('-').pop(),
    targetTurn,
    finalTurn,
    rem,
    shape: `${r1.length}v${r2.length}`,
    battle,
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const files = fs.readdirSync(REPLAY_DIR).filter(f => f.endsWith('.json')).sort();
  const cases = [];
  for (const f of files) {
    if (opts.filter && !f.includes(opts.filter)) continue;
    const c = extractEndgameFromReplay(path.join(REPLAY_DIR, f), opts.rem, opts.includeForfeit);
    if (!c) continue;
    const adm = canRunInEngine(c.battle);
    if (!adm.supported) {
      console.log(`[SKIP] ${c.shortId} T${c.targetTurn} (${c.shape}): ${adm.reason}`);
      continue;
    }
    cases.push(c);
    if (opts.limit > 0 && cases.length >= opts.limit) break;
  }

  console.log(`VGC <=3v3 Endgame Benchmark | rem=${opts.rem} | maxSearchMs=${opts.maxMs} | tol=${opts.tol} | cases=${cases.length}`);
  console.log('─'.repeat(118));
  console.log(
    'ID'.padEnd(12),
    'Turn'.padEnd(6),
    'Fmt'.padEnd(5),
    'Matrix'.padEnd(9),
    'Prep'.padStart(7),
    'Search'.padStart(9),
    'Total'.padStart(9),
    'Conv'.padEnd(5),
    'Bounds'.padEnd(19),
    'Width'.padStart(7),
    'Nodes'.padStart(7),
    'Cells'.padStart(7),
    'Reason'
  );
  console.log('─'.repeat(118));

  let convergedCount = 0;
  let totalSearchMs = 0;
  const byShape = new Map();

  for (const c of cases) {
    const ctx = compileContextFromBattle(c.battle);
    const st = stateFromBattle(ctx, c.battle);
    const m = legalSideActions(ctx, st, 0).length;
    const n = legalSideActions(ctx, st, 1).length;

    const solver = new BoundedSolver({
      engine: 'compact',
      tolerance: opts.tol,
      maxSearchMs: opts.maxMs,
    });
    const t0 = performance.now();
    const res = solver.solve(c.battle);
    const totalMs = performance.now() - t0;

    if (res.converged) convergedCount++;
    totalSearchMs += res.stats.searchMs;
    const width = res.upperBound - res.lowerBound;
    const sStat = byShape.get(c.shape) || {total: 0, conv: 0, sumWidth: 0, sumMs: 0};
    sStat.total++;
    if (res.converged) sStat.conv++;
    sStat.sumWidth += width;
    sStat.sumMs += res.stats.searchMs;
    byShape.set(c.shape, sStat);

    console.log(
      c.shortId.padEnd(12),
      `T${c.targetTurn}/${c.finalTurn}`.padEnd(6),
      c.shape.padEnd(5),
      `${m}x${n}`.padEnd(9),
      `${res.stats.prepareMs.toFixed(1)}ms`.padStart(7),
      `${res.stats.searchMs.toFixed(1)}ms`.padStart(9),
      `${totalMs.toFixed(1)}ms`.padStart(9),
      (res.converged ? 'YES' : 'NO').padEnd(5),
      `[${res.lowerBound.toFixed(4)}, ${res.upperBound.toFixed(4)}]`.padEnd(19),
      width.toFixed(4).padStart(7),
      String(res.stats.nodes).padStart(7),
      String(res.stats.expandedCells).padStart(7),
      res.stopReason || (res.exact ? 'exact' : 'tol')
    );
    if (opts.profile) {
      const root = solver.rootNode;
      const cells = root.cells;
      let expRoot = 0, tightRoot = 0, winRoot = 0, lossRoot = 0;
      const rowBest = [];
      for (let i = 0; i < m; i++) {
        let minL = 1, maxL = -1, minU = 1, maxU = -1, exp = 0;
        for (let j = 0; j < n; j++) {
          const ce = cells[i][j];
          if (ce.outcomes) { exp++; expRoot++; }
          if (ce.upper - ce.lower < 1.99) tightRoot++;
          if (ce.lower > 0.5) winRoot++;
          if (ce.upper < -0.5) lossRoot++;
          if (ce.lower < minL) minL = ce.lower;
          if (ce.lower > maxL) maxL = ce.lower;
          if (ce.upper < minU) minU = ce.upper;
          if (ce.upper > maxU) maxU = ce.upper;
        }
        if (exp > 0) rowBest.push({i, name: root.actions1[i].name, exp, minL, maxL, minU, maxU});
      }
      const colBest = [];
      for (let j = 0; j < n; j++) {
        let minU = 1, maxU = -1, exp = 0;
        for (let i = 0; i < m; i++) {
          const ce = cells[i][j];
          if (ce.outcomes) exp++;
          if (ce.upper < minU) minU = ce.upper;
          if (ce.upper > maxU) maxU = ce.upper;
        }
        if (exp > 0) colBest.push({j, name: root.actions2[j].name, exp, minU, maxU});
      }
      console.log(`   DIAG: rootExp=${expRoot}/${m * n} tight=${tightRoot} win=${winRoot} loss=${lossRoot} equivFill=${res.stats.equivCellsFilled || 0} protCont=${res.stats.protectContractions || 0} ppHits=${res.stats.ppCacheHits} monoUpd=${res.stats.monotoneUpdates} ppUpd=${res.stats.ppBoundUpdates} boxSplits=${res.stats.boxSplits} matSolves=${res.stats.matrixSolves}`);
      console.log('   Rows:', rowBest.sort((a, b) => b.exp - a.exp).slice(0, 4).map(r => `[${r.i}]${r.name}(e=${r.exp},L=${r.minL.toFixed(2)}..${r.maxL.toFixed(2)},U=${r.minU.toFixed(2)}..${r.maxU.toFixed(2)})`).join(' | '));
      console.log('   Cols:', colBest.sort((a, b) => b.exp - a.exp).slice(0, 4).map(r => `[${r.j}]${r.name}(e=${r.exp},U=${r.minU.toFixed(2)}..${r.maxU.toFixed(2)})`).join(' | '));
    }
  }

  console.log('─'.repeat(118));
  console.log(`Summary: ${convergedCount}/${cases.length} converged | totalSearchMs=${(totalSearchMs / 1000).toFixed(2)}s`);
  for (const [shape, s] of [...byShape.entries()].sort()) {
    console.log(`  ${shape}: ${s.conv}/${s.total} converged | avgWidth=${(s.sumWidth / s.total).toFixed(4)} | avgSearchMs=${(s.sumMs / s.total).toFixed(1)}ms`);
  }
}

main();
