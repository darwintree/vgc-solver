const path = require('node:path');
const directory = process.argv[2];
process.chdir(directory);
const {BoundedSolver} = require(path.join(directory, 'dist/src/bounded-solver.js'));
const native = require(path.join(directory, 'dist/src/showdown-adapter.js'));
const {createTurnCursor} = require(path.join(directory, 'dist/src/progressive-transition.js'));
const {championsCases, createChampionsBattle} = require(path.join(directory, 'dist/src/champions-cases.js'));
const fixture = championsCases().find(entry => entry.id === 'primarina-100-vs-mimikyu-100');
const battle = createChampionsBattle(fixture);
battle.makeChoices('move 4', 'move 3');
const input = {turn: battle.turn, actions: [0, 1].map(side => native.legalActions(battle, side)),
  pokemon: battle.sides.map(side => {const p = side.active[0]; return {hp: p.hp, boosts: p.boosts,
    species: p.species.name, encore: p.volatiles.encore && {duration: p.volatiles.encore.duration, move: p.volatiles.encore.move}};})};
const mode = process.argv[3] || 'auto';
const solver = new BoundedSolver({maxSearchMs: 10000, tolerance: .02,
  ...(mode === 'first-policy' ? {adapter: {...native, createTurnCursor,
    legalActions: (state, side) => side === 0 ? native.legalActions(state, side).slice(0, 1) : native.legalActions(state, side)}} : {})});
const work = [];
const original = solver._expandCell.bind(solver);
solver._expandCell = (node, i, j) => {
  const t = performance.now(); original(node, i, j);
  work.push({turn: node.snapshot.turn, i, j, actions: [node.actions1[i].name, node.actions2[j].name],
    dimensions: [node.actions1.length, node.actions2.length], ms: performance.now()-t,
    hp: node.snapshot.sides.map(side => side.pokemon[0].hp)});
};
const result = solver.solve(battle);
console.log(JSON.stringify({mode, input, result, work: work.slice(0, 150), workCount: work.length}));
