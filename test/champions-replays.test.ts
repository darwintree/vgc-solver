import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {pathToFileURL} from 'node:url';

const REPO_ROOT = path.resolve(__dirname, '../..');
const REPLAYS_DIR = path.join(REPO_ROOT, 'data/champions-replays');
const MANIFEST_PATH = path.join(REPLAYS_DIR, 'manifest.json');
const FETCH_SCRIPT_URL = pathToFileURL(path.join(REPO_ROOT, 'scripts/fetch-champions-replays.mjs')).href;

interface ReplayManifestEntry {
  id: string;
  category: 'doubles' | 'singles';
  format: string;
  formatid: string;
  file: string;
  players: string[];
  playerPairKey: string;
  winner: string;
  rating: number;
  turns: number;
  forfeited: boolean;
  hasShowteam: boolean;
  hasInputlog: boolean;
  tags: string[];
  tagDetails: {
    megas: string[];
    weathers: string[];
    terrains: string[];
    hazards: string[];
    statuses: string[];
  };
  bytes: number;
  sha256: string;
}

interface ReplayManifest {
  schemaVersion: number;
  rawPreservation: string;
  mechanismTagSchema: string[];
  totalCount: number;
  totalTagCounts: Record<string, number>;
  categories: Record<'doubles' | 'singles', {
    formatid: string;
    collectedCount: number;
    filters: {minRating: number; minTurns: number; requireShowteam: boolean};
    tagCounts: Record<string, number>;
  }>;
  replays: ReplayManifestEntry[];
}

function loadManifest(): ReplayManifest {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as ReplayManifest;
}

test('Champions replay dataset contains 30 doubles Bo3 and 30 singles BSS raw JSON files matching manifest', () => {
  const manifest = loadManifest();
  assert.equal(manifest.totalCount, 60);
  assert.equal(manifest.replays.length, 60);
  assert.equal(manifest.rawPreservation, 'unmodified-utf8-api-response');
  assert.deepEqual(manifest.mechanismTagSchema, [
    'mega',
    'trick_room',
    'tailwind',
    'weather',
    'terrain',
    'hazards',
    'boost',
    'status',
  ]);

  const doublesEntries = manifest.replays.filter(r => r.category === 'doubles');
  const singlesEntries = manifest.replays.filter(r => r.category === 'singles');
  assert.equal(doublesEntries.length, 30);
  assert.equal(singlesEntries.length, 30);
  assert.equal(manifest.categories.doubles.formatid, 'gen9championsvgc2026regmcbo3');
  assert.equal(manifest.categories.singles.formatid, 'gen9championsbssregmc');

  const doublesDisk = fs.readdirSync(path.join(REPLAYS_DIR, 'doubles')).filter(f => f.endsWith('.json')).sort();
  const singlesDisk = fs.readdirSync(path.join(REPLAYS_DIR, 'singles')).filter(f => f.endsWith('.json')).sort();
  assert.deepEqual(
    doublesDisk,
    doublesEntries.map(e => path.basename(e.file)).sort()
  );
  assert.deepEqual(
    singlesDisk,
    singlesEntries.map(e => path.basename(e.file)).sort()
  );
});

test('every saved replay preserves raw JSON integrity, quality filters, unique pairs, and accurate tags', async () => {
  const manifest = loadManifest();
  const {analyzeReplay} = await import(FETCH_SCRIPT_URL);

  const seenIds = new Set<string>();
  const pairsByCategory = {
    doubles: new Set<string>(),
    singles: new Set<string>(),
  };

  for (const entry of manifest.replays) {
    assert.ok(!seenIds.has(entry.id), `duplicate replay id: ${entry.id}`);
    seenIds.add(entry.id);

    assert.ok(entry.playerPairKey.length > 0, `empty playerPairKey for ${entry.id}`);
    assert.ok(
      !pairsByCategory[entry.category].has(entry.playerPairKey),
      `duplicate player pair in ${entry.category}: ${entry.playerPairKey}`
    );
    pairsByCategory[entry.category].add(entry.playerPairKey);

    const filePath = path.join(REPLAYS_DIR, entry.file);
    const rawBuffer = fs.readFileSync(filePath);
    assert.equal(rawBuffer.length, entry.bytes, `byte size mismatch for ${entry.id}`);
    const actualSha = createHash('sha256').update(rawBuffer).digest('hex');
    assert.equal(actualSha, entry.sha256, `sha256 mismatch for ${entry.id}`);

    const raw = JSON.parse(rawBuffer.toString('utf8'));
    assert.equal(raw.id, entry.id);
    assert.equal(raw.formatid, entry.formatid);
    assert.equal(typeof raw.log, 'string');
    assert.ok(raw.log.length > 0);
    assert.ok(Array.isArray(raw.players) && raw.players.length === 2);

    const analysis = analyzeReplay(raw);
    assert.ok(analysis.winner, `missing |win| for ${entry.id}`);
    assert.equal(analysis.tied, false, `unexpected |tie| for ${entry.id}`);
    assert.equal(analysis.inactivity, false, `inactivity timeout in ${entry.id}`);
    assert.equal(analysis.turns, entry.turns, `turns mismatch for ${entry.id}`);
    assert.deepEqual(analysis.tags, entry.tags, `tags mismatch for ${entry.id}`);
    assert.deepEqual(analysis.tagDetails, entry.tagDetails, `tagDetails mismatch for ${entry.id}`);

    if (entry.category === 'doubles') {
      assert.equal(entry.formatid, 'gen9championsvgc2026regmcbo3');
      assert.ok(entry.rating >= 1550, `doubles rating below floor: ${entry.id} (${entry.rating})`);
      assert.ok(entry.turns >= 5, `doubles turns below floor: ${entry.id} (${entry.turns})`);
      assert.equal(analysis.hasShowteam, true, `doubles Bo3 missing |showteam|: ${entry.id}`);
      assert.equal(entry.hasShowteam, true);
    } else {
      assert.equal(entry.formatid, 'gen9championsbssregmc');
      assert.ok(entry.rating >= 1400, `singles rating below floor: ${entry.id} (${entry.rating})`);
      assert.ok(entry.turns >= 6, `singles turns below floor: ${entry.id} (${entry.turns})`);
    }
  }

  for (const tag of manifest.mechanismTagSchema) {
    const actualTotal = manifest.replays.filter(r => r.tags.includes(tag)).length;
    assert.equal(manifest.totalTagCounts[tag], actualTotal, `totalTagCounts mismatch for ${tag}`);
    for (const cat of ['doubles', 'singles'] as const) {
      const actualCat = manifest.replays.filter(r => r.category === cat && r.tags.includes(tag)).length;
      assert.equal(manifest.categories[cat].tagCounts[tag], actualCat, `${cat} tagCounts mismatch for ${tag}`);
    }
  }
});
