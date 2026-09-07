import {OneVsOneSolver} from './solver';
import {
  leftoversThreeHKO,
  suckerPunchGame,
  trivialPriorityKO,
} from './cases';

function rounded(number) {
  return Math.abs(number) < 5e-10 ? 0 : Number(number.toFixed(6));
}

function printStrategy(label, strategy) {
  const text = strategy
    .filter(entry => entry.probability > 1e-8)
    .map(entry => `${entry.action}: ${rounded(entry.probability)}`)
    .join(', ');
  console.log(`${label}: ${text}`);
}

for (const makeCase of [trivialPriorityKO, leftoversThreeHKO, suckerPunchGame]) {
  const testCase = makeCase();
  const solver = new OneVsOneSolver({maxStates: 100000});
  const solution = solver.solve(testCase.battle);

  console.log(`\n=== ${testCase.name} ===`);
  console.log(`Expected: ${testCase.expected}`);
  console.log(`Value: ${rounded(solution.value)}`);
  printStrategy('P1', solution.p1Strategy);
  printStrategy('P2', solution.p2Strategy);
  console.log('Root payoff matrix:');
  console.table(solution.payoffMatrix.map(row => row.map(rounded)));
  console.log('Stats:', solution.stats);
}
