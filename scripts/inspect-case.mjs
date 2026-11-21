import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {championsCases, createChampionsBattle} = require('../dist/src/champions-cases.js');
const {
  compareTurnWithShowdown,
  compileContextFromBattle,
  createEngineBoundedAdapter,
  createMonotoneAnalyzer,
  stateFromBattle,
} = require('../dist/src/engine/index.js');
const {BoundedSolver} = require('../dist/src/bounded-solver.js');

const args = new Map();
let caseId = null;
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) {
    const eq = a.indexOf('=');
    if (eq >= 0) args.set(a.slice(2, eq), a.slice(eq + 1));
    else args.set(a.slice(2), 'true');
  } else if (!caseId) {
    caseId = a;
  }
}

if (!caseId || args.has('help')) {
  console.log(
    'Usage: node scripts/inspect-case.mjs <case-id> [--snapshot=2026-09|2026-11] [--search-ms=1500] [--matrix] [--profile] [--parity --p1="move 1" --p2="move 1"]'
  );
  process.exit(caseId ? 0 : 1);
}

const snapshotId = args.get('snapshot') === '2026-11' ? '2026-11' : '2026-09';
const searchMs = Number(args.get('search-ms') ?? 1500);
const showMatrix = args.get('matrix') === 'true';
const showProfile = args.get('profile') === 'true';
const showParity = args.get('parity') === 'true';

const all = championsCases(snapshotId);
const fixture = all.find(c => c.id === caseId);
if (!fixture) {
  console.error(`Unknown case "${caseId}" in snapshot "${snapshotId}".`);
  const prefix = caseId.split('-')[0];
  const matches = all.filter(c => c.id.includes(prefix)).slice(0, 8).map(c => c.id);
  if (matches.length) console.error(`Did you mean: ${matches.join(', ')}`);
  process.exit(2);
}

const battle = createChampionsBattle(fixture);
const ctx = compileContextFromBattle(battle);
const st = stateFromBattle(ctx, battle);
const mono = createMonotoneAnalyzer(ctx);
const m0 = ctx.sides[0].team[0];
const m1 = ctx.sides[1].team[0];

console.log(`=== ${snapshotId} :: ${caseId} ===`);
console.log(`  P1: ${m0.name} (${m0.abilitySpec.id}${m0.megaForme ? `->${m0.megaForme.abilitySpec.id}` : ''}, ${m0.itemSpec.id || 'none'}) HP=${st.sides[0].pokemon[0].hp}/${m0.maxhp} mono=${mono.isHpMonotone(st, 0, st.sides[0].pokemon[0].hp)} moves=[${m0.moves.map(m => m.name).join(', ')}]`);
console.log(`  P2: ${m1.name} (${m1.abilitySpec.id}${m1.megaForme ? `->${m1.megaForme.abilitySpec.id}` : ''}, ${m1.itemSpec.id || 'none'}) HP=${st.sides[1].pokemon[0].hp}/${m1.maxhp} mono=${mono.isHpMonotone(st, 1, st.sides[1].pokemon[0].hp)} moves=[${m1.moves.map(m => m.name).join(', ')}]`);

if (showParity) {
  const p1Cmd = args.get('p1') ?? 'move 1';
  const p2Cmd = args.get('p2') ?? 'move 1';
  const rep = compareTurnWithShowdown(battle, p1Cmd, p2Cmd);
  console.log(`  Parity (${p1Cmd} vs ${p2Cmd}): exactMatch=${rep.exactMatch} TVD=${rep.totalVariationDistance.toExponential(3)} maxProbDiff=${rep.maxProbDiff.toExponential(3)} eng=${rep.engineOutcomes} sd=${rep.showdownOutcomes} missing=${rep.missingFromEngine.length} extra=${rep.extraInEngine.length}`);
  if (!rep.exactMatch) {
    if (rep.missingFromEngine.length) console.log('  missing:', rep.missingFromEngine.slice(0, 5));
    if (rep.extraInEngine.length) console.log('  extra:', rep.extraInEngine.slice(0, 5));
    if (rep.probMismatches.length) console.log('  probMismatches:', rep.probMismatches.slice(0, 5));
  }
  process.exit(0);
}

const adapter = createEngineBoundedAdapter(battle);
let tStep = 0, nStep = 0, tRefresh = 0, nRefresh = 0;
if (showProfile) {
  const origEnum = adapter.enumerateTurn;
  adapter.enumerateTurn = (...callArgs) => {
    const t0 = performance.now();
    const r = origEnum(...callArgs);
    tStep += performance.now() - t0;
    nStep++;
    return r;
  };
}
const solver = new BoundedSolver({adapter, tolerance: 0.02, maxSearchMs: searchMs, lazyCells: false});
if (showProfile) {
  const origRefresh = solver._refresh.bind(solver);
  solver._refresh = n => {
    const t0 = performance.now();
    const r = origRefresh(n);
    tRefresh += performance.now() - t0;
    nRefresh++;
    return r;
  };
}
const res = solver.solve(battle);
console.log(`  Result: converged=${res.converged} stop=${res.stopReason} bounds=[${res.lowerBound.toFixed(4)}, ${res.upperBound.toFixed(4)}] search=${res.stats.searchMs.toFixed(1)}ms nodes=${res.stats.nodes} matSolves=${res.stats.matrixSolves} monoUpd=${res.stats.monotoneUpdates} boxSplits=${res.stats.boxSplits}`);
if (showProfile) {
  console.log(`  Profile: enumerateTurn=${tStep.toFixed(1)}ms (${nStep} calls) _refresh=${tRefresh.toFixed(1)}ms (${nRefresh} calls)`);
}
if (showMatrix && solver.rootNode) {
  const root = solver.rootNode;
  console.log(`  P2 cols: ${root.actions2.map((a, j) => `c${j}:${a.name}`).join(' | ')}`);
  for (let i = 0; i < root.cells.length; i++) {
    const row = root.cells[i]
      .map(cell => `${cell.outcomes ? '*' : '.'}[${cell.lower.toFixed(2)},${cell.upper.toFixed(2)}]`)
      .join(' ');
    console.log(`  r${i}(${root.actions1[i].name}): ${row}`);
  }
}
