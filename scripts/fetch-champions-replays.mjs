#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {mkdir, readdir, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';

const API_ORIGIN = 'https://replay.pokemonshowdown.com';
const USER_AGENT = 'curl/8.5.0';
const HAZARD_NAMES = new Set([
  'Stealth Rock',
  'Spikes',
  'Toxic Spikes',
  'Sticky Web',
]);
const BOOST_TOKENS = new Set([
  '-boost',
  '-unboost',
  '-setboost',
  '-swapboost',
  '-copyboost',
  '-clearboost',
  '-clearallboost',
  '-clearnegativeboost',
  '-clearpositiveboost',
  '-invertboost',
]);
const MECHANISM_TAGS = [
  'mega',
  'trick_room',
  'tailwind',
  'weather',
  'terrain',
  'hazards',
  'boost',
  'status',
];

function parseArgs(argv) {
  const args = {
    out: 'data/champions-replays',
    count: 30,
    doublesFormat: 'gen9championsvgc2026regmcbo3',
    doublesMinRating: 1550,
    doublesMinTurns: 5,
    singlesFormat: 'gen9championsbssregmc',
    singlesMinRating: 1400,
    singlesMinTurns: 6,
    maxPages: 15,
    delayMs: 120,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    switch (flag) {
      case '--out':
        args.out = next;
        i++;
        break;
      case '--count':
        args.count = Number(next);
        i++;
        break;
      case '--doubles-format':
        args.doublesFormat = next;
        i++;
        break;
      case '--doubles-min-rating':
        args.doublesMinRating = Number(next);
        i++;
        break;
      case '--doubles-min-turns':
        args.doublesMinTurns = Number(next);
        i++;
        break;
      case '--singles-format':
        args.singlesFormat = next;
        i++;
        break;
      case '--singles-min-rating':
        args.singlesMinRating = Number(next);
        i++;
        break;
      case '--singles-min-turns':
        args.singlesMinTurns = Number(next);
        i++;
        break;
      case '--max-pages':
        args.maxPages = Number(next);
        i++;
        break;
      case '--delay-ms':
        args.delayMs = Number(next);
        i++;
        break;
      default:
        throw new Error(`Unknown argument: ${flag}`);
    }
  }
  return args;
}

function toId(text) {
  return String(text ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function pairKey(players) {
  const ids = (Array.isArray(players) ? players : []).map(toId).filter(Boolean).sort();
  return ids.join('::');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchText(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) {
      return await res.text();
    }
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      await sleep(500 * attempt);
      continue;
    }
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  throw new Error(`Failed after ${retries} attempts: ${url}`);
}

async function fetchSearchCandidates(formatid, minRating, maxPages, delayMs) {
  const byId = new Map();
  let pagesFetched = 0;

  for (let page = 1; page <= maxPages; page++) {
    const url = `${API_ORIGIN}/search.json?format=${encodeURIComponent(formatid)}&sort=rating&page=${page}`;
    const text = await fetchText(url);
    const items = JSON.parse(text);
    pagesFetched++;
    if (!Array.isArray(items) || items.length === 0) break;

    let pageMinRating = Infinity;
    for (const item of items) {
      if (typeof item.rating === 'number' && item.rating < pageMinRating) {
        pageMinRating = item.rating;
      }
      if (!byId.has(item.id)) {
        byId.set(item.id, item);
      }
    }

    if (items.length < 51 || pageMinRating < minRating) {
      break;
    }
    if (delayMs > 0) await sleep(delayMs);
  }

  const sorted = [...byId.values()].sort((a, b) => {
    const ratingDiff = (b.rating ?? -1) - (a.rating ?? -1);
    if (ratingDiff !== 0) return ratingDiff;
    const timeDiff = (b.uploadtime ?? 0) - (a.uploadtime ?? 0);
    if (timeDiff !== 0) return timeDiff;
    return String(a.id).localeCompare(String(b.id));
  });

  return {candidates: sorted, pagesFetched};
}

export function analyzeReplay(replay) {
  const log = typeof replay.log === 'string' ? replay.log : '';
  const lines = log.split(/\r?\n/);

  let winner = null;
  let tied = false;
  let inactivity = false;
  let forfeited = false;
  let turns = 0;
  const showteamSides = new Set();
  let hasInputlog = typeof replay.inputlog === 'string' && replay.inputlog.length > 0;
  const teams = {p1: [], p2: []};

  const tags = new Set();
  const megas = new Set();
  const weathers = new Set();
  const terrains = new Set();
  const hazards = new Set();
  const statuses = new Set();

  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    const parts = line.split('|');
    const cmd = parts[1] ?? '';

    if (cmd === 'c' || cmd === 'c☆' || cmd === 'chat' || cmd === 'raw' || cmd === 'html' || cmd === 'uhtml') {
      continue;
    }

    if (cmd === 'win') {
      winner = parts[2] ?? null;
    } else if (cmd === 'tie') {
      tied = true;
    } else if (cmd === 'turn') {
      const n = Number(parts[2]);
      if (Number.isInteger(n) && n > turns) turns = n;
    } else if (cmd === 'showteam') {
      if (parts[2] === 'p1' || parts[2] === 'p2') showteamSides.add(parts[2]);
    } else if (cmd === 'inputlog') {
      hasInputlog = true;
    } else if (cmd === 'poke') {
      const side = parts[2];
      const details = parts[3] ?? '';
      const species = details.split(',')[0]?.trim();
      if ((side === 'p1' || side === 'p2') && species) {
        teams[side].push(species);
      }
    } else if (cmd === '-message' || cmd === 'inactive') {
      const msg = parts.slice(2).join('|');
      if (/lost due to inactivity/i.test(msg)) {
        inactivity = true;
      }
      if (cmd === '-message' && /\bforfeited\.?\s*$/i.test(msg)) {
        forfeited = true;
      }
    } else if (cmd === '-mega') {
      tags.add('mega');
      const species = parts[3]?.trim();
      const stone = parts[4]?.trim();
      if (species || stone) {
        megas.add(stone ? `${species} (${stone})` : species);
      }
    } else if (cmd === '-fieldstart') {
      const effect = (parts[2] ?? '').replace(/^move:\s*/i, '').trim();
      if (effect === 'Trick Room') {
        tags.add('trick_room');
      } else if (/Terrain$/i.test(effect)) {
        tags.add('terrain');
        terrains.add(effect);
      }
    } else if (cmd === '-sidestart') {
      const effect = (parts[3] ?? '').replace(/^move:\s*/i, '').trim();
      if (effect === 'Tailwind') {
        tags.add('tailwind');
      } else if (HAZARD_NAMES.has(effect)) {
        tags.add('hazards');
        hazards.add(effect);
      }
    } else if (cmd === '-weather') {
      const weather = (parts[2] ?? '').trim();
      if (weather && weather !== 'none') {
        tags.add('weather');
        weathers.add(weather);
      }
    } else if (BOOST_TOKENS.has(cmd)) {
      tags.add('boost');
    } else if (cmd === '-status') {
      const status = (parts[3] ?? '').trim();
      if (status) {
        tags.add('status');
        statuses.add(status);
      }
    }
  }

  return {
    winner,
    tied,
    inactivity,
    forfeited,
    turns,
    hasShowteam: showteamSides.has('p1') && showteamSides.has('p2'),
    showteamCount: showteamSides.size,
    hasInputlog,
    teams,
    tags: MECHANISM_TAGS.filter(t => tags.has(t)),
    tagDetails: {
      megas: [...megas].sort(),
      weathers: [...weathers].sort(),
      terrains: [...terrains].sort(),
      hazards: [...hazards].sort(),
      statuses: [...statuses].sort(),
    },
  };
}

async function cleanJsonDir(dirPath) {
  await mkdir(dirPath, {recursive: true});
  const existing = await readdir(dirPath);
  for (const name of existing) {
    if (name.endsWith('.json')) {
      await rm(path.join(dirPath, name));
    }
  }
}

async function collectCategory(spec, outDir, delayMs) {
  const categoryDir = path.join(outDir, spec.category);
  await cleanJsonDir(categoryDir);

  const {candidates, pagesFetched} = await fetchSearchCandidates(
    spec.formatid,
    spec.minRating,
    spec.maxPages,
    delayMs
  );

  const rejections = {
    private_or_password: 0,
    below_min_rating: 0,
    duplicate_pair: 0,
    missing_log: 0,
    no_win: 0,
    inactivity: 0,
    too_few_turns: 0,
    missing_showteam: 0,
    fetch_error: 0,
  };

  const usedPairs = new Set();
  const entries = [];
  let fetchedReplays = 0;

  for (const item of candidates) {
    if (entries.length >= spec.targetCount) break;

    if (item.private || item.password) {
      rejections.private_or_password++;
      continue;
    }
    if (typeof item.rating !== 'number' || item.rating < spec.minRating) {
      rejections.below_min_rating++;
      continue;
    }

    const pKey = pairKey(item.players);
    if (pKey && usedPairs.has(pKey)) {
      rejections.duplicate_pair++;
      continue;
    }

    const apiUrl = `${API_ORIGIN}/${encodeURIComponent(item.id)}.json`;
    let rawText;
    let replay;
    try {
      rawText = await fetchText(apiUrl);
      replay = JSON.parse(rawText);
      fetchedReplays++;
    } catch (err) {
      rejections.fetch_error++;
      console.error(`[${spec.category}] fetch failed for ${item.id}: ${err.message}`);
      continue;
    }
    if (delayMs > 0) await sleep(delayMs);

    if (typeof replay.log !== 'string' || replay.log.length === 0) {
      rejections.missing_log++;
      continue;
    }

    const analysis = analyzeReplay(replay);
    if (!analysis.winner || analysis.tied) {
      rejections.no_win++;
      continue;
    }
    if (analysis.inactivity) {
      rejections.inactivity++;
      continue;
    }
    if (analysis.turns < spec.minTurns) {
      rejections.too_few_turns++;
      continue;
    }
    if (spec.requireShowteam && !analysis.hasShowteam) {
      rejections.missing_showteam++;
      continue;
    }

    const actualPairKey = pairKey(replay.players ?? item.players);
    if (actualPairKey && usedPairs.has(actualPairKey)) {
      rejections.duplicate_pair++;
      continue;
    }
    if (actualPairKey) usedPairs.add(actualPairKey);

    const filename = `${replay.id}.json`;
    const relativeFile = `${spec.category}/${filename}`;
    const targetPath = path.join(categoryDir, filename);
    const rawBuffer = Buffer.from(rawText, 'utf8');
    await writeFile(targetPath, rawBuffer);
    const sha256 = createHash('sha256').update(rawBuffer).digest('hex');

    const uploadtime = replay.uploadtime ?? item.uploadtime ?? null;
    entries.push({
      id: replay.id,
      category: spec.category,
      format: replay.format ?? item.format ?? null,
      formatid: replay.formatid ?? spec.formatid,
      file: relativeFile,
      url: `${API_ORIGIN}/${replay.id}`,
      apiUrl,
      players: replay.players ?? item.players ?? [],
      playerPairKey: actualPairKey,
      winner: analysis.winner,
      rating: replay.rating ?? item.rating ?? null,
      uploadtime,
      uploadedAt: typeof uploadtime === 'number' ? new Date(uploadtime * 1000).toISOString() : null,
      views: replay.views ?? null,
      turns: analysis.turns,
      forfeited: analysis.forfeited,
      hasShowteam: analysis.hasShowteam,
      hasInputlog: analysis.hasInputlog,
      teams: analysis.teams,
      tags: analysis.tags,
      tagDetails: analysis.tagDetails,
      bytes: rawBuffer.length,
      sha256,
    });
  }

  if (entries.length < spec.targetCount) {
    throw new Error(
      `[${spec.category}] Collected only ${entries.length}/${spec.targetCount} replays for ${spec.formatid} ` +
        `(minRating=${spec.minRating}, minTurns=${spec.minTurns}, pagesFetched=${pagesFetched}, ` +
        `candidates=${candidates.length}, fetchedReplays=${fetchedReplays}, rejections=${JSON.stringify(rejections)})`
    );
  }

  const ratings = entries.map(e => e.rating).filter(r => typeof r === 'number');
  const turnList = entries.map(e => e.turns);
  const tagCounts = Object.fromEntries(
    MECHANISM_TAGS.map(tag => [tag, entries.filter(e => e.tags.includes(tag)).length])
  );

  return {
    summary: {
      category: spec.category,
      formatid: spec.formatid,
      targetCount: spec.targetCount,
      collectedCount: entries.length,
      filters: {
        minRating: spec.minRating,
        minTurns: spec.minTurns,
        requireWin: true,
        excludeInactivity: true,
        requireShowteam: spec.requireShowteam,
        maxPerPlayerPair: 1,
      },
      searchStats: {
        pagesFetched,
        candidatesScanned: candidates.length,
        replaysFetched: fetchedReplays,
        rejections,
      },
      ratingRange: {
        min: Math.min(...ratings),
        max: Math.max(...ratings),
      },
      turnRange: {
        min: Math.min(...turnList),
        max: Math.max(...turnList),
      },
      forfeitedCount: entries.filter(e => e.forfeited).length,
      showteamCount: entries.filter(e => e.hasShowteam).length,
      tagCounts,
    },
    entries,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(args.out);
  await mkdir(outDir, {recursive: true});

  const specs = [
    {
      category: 'doubles',
      formatid: args.doublesFormat,
      targetCount: args.count,
      minRating: args.doublesMinRating,
      minTurns: args.doublesMinTurns,
      requireShowteam: args.doublesFormat.includes('bo3'),
      maxPages: args.maxPages,
    },
    {
      category: 'singles',
      formatid: args.singlesFormat,
      targetCount: args.count,
      minRating: args.singlesMinRating,
      minTurns: args.singlesMinTurns,
      requireShowteam: args.singlesFormat.includes('bo3'),
      maxPages: args.maxPages,
    },
  ];

  const categories = {};
  const replays = [];

  for (const spec of specs) {
    console.log(
      `Collecting ${spec.targetCount} ${spec.category} replays from ${spec.formatid} ` +
        `(rating>=${spec.minRating}, turns>=${spec.minTurns})...`
    );
    const result = await collectCategory(spec, outDir, args.delayMs);
    categories[spec.category] = result.summary;
    replays.push(...result.entries);
    console.log(
      `  Done [${spec.category}]: ${result.summary.collectedCount} replays, ` +
        `rating ${result.summary.ratingRange.min}–${result.summary.ratingRange.max}, ` +
        `turns ${result.summary.turnRange.min}–${result.summary.turnRange.max}, ` +
        `tags=${JSON.stringify(result.summary.tagCounts)}`
    );
  }

  const totalTagCounts = Object.fromEntries(
    MECHANISM_TAGS.map(tag => [tag, replays.filter(r => r.tags.includes(tag)).length])
  );

  const manifest = {
    schemaVersion: 1,
    source: API_ORIGIN,
    retrievedAt: new Date().toISOString(),
    rawPreservation: 'unmodified-utf8-api-response',
    mechanismTagSchema: MECHANISM_TAGS,
    totalCount: replays.length,
    totalTagCounts,
    categories,
    replays,
  };

  const manifestPath = path.join(outDir, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${manifestPath} (${replays.length} total replays).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
