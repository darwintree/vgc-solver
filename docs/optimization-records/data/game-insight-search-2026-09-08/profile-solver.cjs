const base = process.argv[2];
const id = process.argv[3];
const {championsCases, createChampionsBattle} = require(base + '/dist/src/champions-cases.js');
const {BoundedSolver} = require(base + '/dist/src/bounded-solver.js');
const fixture = championsCases().find(value => value.id === id);
if (!fixture) throw new Error('Unknown fixture ' + id);
const start = performance.now();
const battle = createChampionsBattle(fixture);
const input = battle.sides.map(side => ({hp: side.active[0].hp, pp: side.active[0].moveSlots.map(move => move.pp)}));
const result = new BoundedSolver({tolerance: 0.02, maxSearchMs: 10000, lazyCells: false, selectionPolicy: 'auto'}).solve(battle);
console.log(JSON.stringify({id, node: process.version, input, totalMs: performance.now() - start,
  lower: result.lowerBound, upper: result.upperBound, converged: result.converged, stats: result.stats}));
