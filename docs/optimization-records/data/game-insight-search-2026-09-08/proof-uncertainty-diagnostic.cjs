// Run alone: node proof-uncertainty-diagnostic.cjs WORKTREE CASE MS
const path = require('node:path');
const directory = process.argv[2];
process.chdir(directory);
const {BoundedSolver} = require(path.join(directory, 'dist/src/bounded-solver.js'));
const {championsCases, createChampionsBattle} = require(path.join(directory, 'dist/src/champions-cases.js'));
const fixture = championsCases().find(entry => entry.id === process.argv[3]);
const solver = new BoundedSolver({tolerance: .02, maxSearchMs: Number(process.argv[4] || 2000)});
const ids = new Map();
function id(node) { if (!ids.has(node)) ids.set(node, ids.size); return ids.get(node); }
function state(node) {
  return {id: id(node), turn: node.snapshot?.turn, lower: node.lower, upper: node.upper,
    initialized: node.initialized, pokemon: node.snapshot?.sides?.map(side => {
      const p = side.pokemon[0];
      return {hp: p.hp, status: p.status, boosts: p.boosts, species: p.species,
        volatiles: Object.fromEntries(Object.entries(p.volatiles || {}).map(([key, value]) => [key, {
          duration: value.duration, move: value.move, layers: value.layers,
        }]))};
    })};
}
const work = new Map();
let latest;
let latestInitialization = null, initializationLowerGain = 0, initializationUpperGain = 0;
let acceptMs = 0, acceptRecords = 0, selectionMs = 0, initializeMs = 0;
const accept = solver._acceptTransition.bind(solver);
solver._acceptTransition = (...args) => {
  acceptRecords += args[3].outcomes?.length || 0;
  const start = performance.now();
  try { return accept(...args); } finally { acceptMs += performance.now() - start; }
};
const select = solver._selectFrontier.bind(solver);
solver._selectFrontier = (...args) => {
  const start = performance.now();
  try { return select(...args); } finally { selectionMs += performance.now() - start; }
};
const initialize = solver._initializeNode.bind(solver);
solver._initializeNode = (...args) => {
  latest = null;
  latestInitialization = args[0];
  const start = performance.now();
  try { return initialize(...args); } finally { initializeMs += performance.now() - start; }
};
const expandCell = solver._expandCell.bind(solver);
solver._expandCell = (node, i, j) => {
  latestInitialization = null;
  const key = `${id(node)}:${i}:${j}`;
  if (!work.has(key)) work.set(key, {node, i, j, advances: 0, ms: 0, lowerGain: 0, upperGain: 0});
  latest = work.get(key);
  latest.advances++;
  const start = performance.now();
  const acceptStart = acceptMs;
  expandCell(node, i, j);
  latest.ms += performance.now() - start;
  latest.acceptMs = (latest.acceptMs || 0) + acceptMs - acceptStart;
};
const backup = solver._backupFrom.bind(solver);
let backupMs = 0;
solver._backupFrom = nodes => {
  const lower = solver.rootNode?.lower;
  const upper = solver.rootNode?.upper;
  const start = performance.now();
  const result = backup(nodes);
  backupMs += performance.now() - start;
  if (latest && lower !== undefined) {
    latest.lowerGain += solver.rootNode.lower - lower;
    latest.upperGain += upper - solver.rootNode.upper;
  } else if (latestInitialization && lower !== undefined) {
    initializationLowerGain += solver.rootNode.lower - lower;
    initializationUpperGain += upper - solver.rootNode.upper;
  }
  return result;
};
const result = solver.solve(createChampionsBattle(fixture));
const root = solver.rootNode;
const p1 = root.lowerSolution.p1;
const p2 = root.upperSolution.p2;
const lowerColumns = root.cells[0].map((_, j) => root.cells.reduce((sum, row, i) => sum + p1[i] * row[j].lower, 0));
const upperRows = root.cells.map(row => row.reduce((sum, cell, j) => sum + p2[j] * cell.upper, 0));
function cellSummary(node, i, j) {
  const cell = node.cells[i][j];
  let terminalMass = 0, uninitializedMass = 0, initializedMass = 0;
  let missingChildMass = 0, childUncertainty = 0, maxChildUncertainty = 0;
  const children = [];
  for (const outcome of cell.outcomes || []) {
    if (outcome.utility !== null) { terminalMass += outcome.probability; continue; }
    if (!outcome.child) { missingChildMass += outcome.probability; continue; }
    const child = outcome.child;
    if (child.initialized) initializedMass += outcome.probability;
    else uninitializedMass += outcome.probability;
    const uncertainty = outcome.probability * (child.upper - child.lower);
    childUncertainty += uncertainty;
    maxChildUncertainty = Math.max(maxChildUncertainty, uncertainty);
    children.push({probability: outcome.probability, uncertainty, ...state(child)});
  }
  children.sort((a, b) => b.uncertainty - a.uncertainty);
  return {i, j, action1: node.actions1[i].name || node.actions1[i].command || node.actions1[i],
    action2: node.actions2[j].name || node.actions2[j].command || node.actions2[j],
    lower: cell.lower, upper: cell.upper, cursor: Boolean(cell.cursor),
    notGenerated: !cell.outcomes, ungeneratedWidth: cell.outcomes ? 0 : cell.upper - cell.lower,
    remainingProbability: cell.outcomes ? cell.remainingProbability || 0 : null,
    outcomes: cell.outcomes?.length || 0,
    terminalMass, uninitializedMass, initializedMass, missingChildMass,
    childUncertainty, maxChildUncertainty,
    work: work.has(`${id(node)}:${i}:${j}`) ? (({node, ...rest}) => rest)(work.get(`${id(node)}:${i}:${j}`)) : null,
    largestChildren: children.slice(0, 12)};
}
const rootCells = root.cells.flatMap((row, i) => row.map((_, j) => ({...cellSummary(root, i, j),
  lowerCertificateRowWeight: p1[i], upperCertificateColumnWeight: p2[j],
  lowerConstraintMargin: lowerColumns[j] - Math.min(...lowerColumns),
  upperConstraintMargin: Math.max(...upperRows) - upperRows[i],
  jointSchedulingWeight: (root.upperSolution.p1[i] || 0) * (root.lowerSolution.p2[j] || 0),
})));
const byTurn = {};
for (const node of solver.nodes.values()) {
  const turn = node.snapshot?.turn ?? 'unknown';
  byTurn[turn] ||= {discovered: 0, initialized: 0, terminal: 0};
  byTurn[turn].discovered++;
  if (node.initialized) byTurn[turn].initialized++;
  if (node.terminal !== null) byTurn[turn].terminal++;
}
const costlyCells = [...work.values()].sort((a, b) => b.ms - a.ms).slice(0, 30)
  .map(entry => ({node: state(entry.node), ...cellSummary(entry.node, entry.i, entry.j)}));
console.log(JSON.stringify({case: fixture.id, bounds: [result.lowerBound, result.upperBound],
  converged: result.converged, stats: result.stats,
  costs: {transitionAndCursorMs: [...work.values()].reduce((sum, item) => sum + item.ms, 0) - acceptMs,
    acceptMs, acceptRecords, backupMs, selectionMs, initializeMs,
    initializationLowerGain, initializationUpperGain}, byTurn,
  certificates: {p1Lower: p1, p2Upper: p2, lowerColumns, upperRows}, rootCells, costlyCells,
  interpretation: 'Constraint margins use each opponent reply separately. Weights are current interval-certificate or scheduling weights, not a proved joint equilibrium or win probability.'}));
