'use strict';

const {solveZeroSumMatrix} = require('./matrix-game');
const {
  enumerateTurn,
  legalActions,
  restoreBattle,
  snapshotBattle,
  stateKey,
  terminalUtility,
} = require('./showdown-adapter');

class OneVsOneSolver {
  constructor(options = {}) {
    this.options = {
      maxStates: options.maxStates ?? 100000,
      maxSimulatorRunsPerTransition: options.maxSimulatorRunsPerTransition ?? 100000,
    };
    this.memo = new Map();
    this.visiting = new Set();
    this.stats = {
      solvedStates: 0,
      simulatorRuns: 0,
      transitionCalls: 0,
      memoHits: 0,
    };
  }

  solve(battle) {
    const root = snapshotBattle(battle);
    const solution = this._solve(root);
    return {...solution, stats: {...this.stats}};
  }

  _solve(snapshot) {
    const key = stateKey(snapshot);
    const cached = this.memo.get(key);
    if (cached) {
      this.stats.memoHits++;
      return cached;
    }

    const battle = restoreBattle(snapshot);
    const utility = terminalUtility(battle);
    if (utility !== null) {
      const terminal = {value: utility, terminal: true};
      this.memo.set(key, terminal);
      return terminal;
    }

    if (this.visiting.has(key)) {
      throw new Error(
        'A true state cycle was found. This finite-horizon demo expects PP to decrease; ' +
        'a general stochastic-game fixed-point solver is needed for regenerative loops.'
      );
    }
    if (this.stats.solvedStates >= this.options.maxStates) {
      throw new Error(`State limit (${this.options.maxStates}) exceeded`);
    }

    this.visiting.add(key);
    try {
      const p1Actions = legalActions(battle, 0);
      const p2Actions = legalActions(battle, 1);
      const payoff = Array.from({length: p1Actions.length}, () =>
        Array(p2Actions.length).fill(0)
      );

      for (let i = 0; i < p1Actions.length; i++) {
        for (let j = 0; j < p2Actions.length; j++) {
          const transition = enumerateTurn(snapshot, p1Actions[i], p2Actions[j], {
            maxSimulatorRunsPerTransition: this.options.maxSimulatorRunsPerTransition,
          });
          this.stats.transitionCalls++;
          this.stats.simulatorRuns += transition.simulatorRuns;

          let expected = 0;
          for (const outcome of transition.outcomes) {
            expected += outcome.probability * this._solve(outcome.snapshot).value;
          }
          payoff[i][j] = expected;
        }
      }

      const matrixSolution = solveZeroSumMatrix(payoff);
      const result = {
        value: matrixSolution.value,
        terminal: false,
        p1Strategy: p1Actions.map((action, i) => ({
          action: action.name,
          probability: matrixSolution.p1[i],
        })),
        p2Strategy: p2Actions.map((action, j) => ({
          action: action.name,
          probability: matrixSolution.p2[j],
        })),
        payoffMatrix: payoff,
      };

      this.memo.set(key, result);
      this.stats.solvedStates++;
      return result;
    } finally {
      this.visiting.delete(key);
    }
  }
}

module.exports = {OneVsOneSolver};
