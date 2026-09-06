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
const {createMemoStateKey, privateSnapshotKey} = require('./native-memo-key');
const {createPPTransitionCache, auditPPBattle} = require('./pp-transition-cache');
const {createEventPlan} = require('./event-plan');
const {auditNativeRules} = require('./native-rules');

function createStats() {
  return {
    solvedStates: 0,
    simulatorRuns: 0,
    transitionCalls: 0,
    memoHits: 0,
    ppCacheHits: 0,
  };
}

class OneVsOneSolver {
  constructor(options = {}) {
    this.options = {
      maxStates: options.maxStates ?? 100000,
      maxSimulatorRunsPerTransition: options.maxSimulatorRunsPerTransition ?? 100000,
    };
    this.memoStateKey = stateKey;
    this.snapshotKeyCache = new WeakMap();
    this.memo = new Map();
    this.visiting = new Set();
    this.stats = createStats();
  }

  solve(battle) {
    // A solver instance is reusable, but each call must represent a fresh
    // search context.  Retaining memo entries across Dex/format changes would
    // silently return an answer proved for a different ruleset.
    this.memo.clear();
    this.visiting.clear();
    this.snapshotKeyCache = new WeakMap();
    this.stats = createStats();
    // Re-audit for every solve call. A solver instance may be reused with a
    // different format, Dex, or callback set; normalized keys use a separate
    // namespace from exact keys when that context changes.
    const nativeAudit = auditNativeRules(battle);
    this.memoStateKey = createMemoStateKey(battle, stateKey, nativeAudit);
    const root = snapshotBattle(battle);
    this.ppCache = createPPTransitionCache();
    this.ppAudit = auditPPBattle(battle, nativeAudit);
    const eventPlan = createEventPlan(battle, nativeAudit);
    // The root's strategy and complete payoff matrix are part of the public result.
    const solution = this._solve(root, true, eventPlan);
    return {...solution, stats: {...this.stats}};
  }

  _snapshotKey(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return this.memoStateKey(snapshot);
    let key = this.snapshotKeyCache.get(snapshot);
    if (key === undefined) {
      key = this.memoStateKey(snapshot);
      this.snapshotKeyCache.set(snapshot, key);
    }
    return key;
  }

  _solve(snapshot, wantStrategy = false, eventPlan = null) {
    const key = this._snapshotKey(snapshot);
    const cached = this.memo.get(key);
    if (cached && (cached.terminal || !wantStrategy || cached.p1Strategy)) {
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
    if (!cached && this.stats.solvedStates >= this.options.maxStates) {
      throw new Error(`State limit (${this.options.maxStates}) exceeded`);
    }

    this.visiting.add(key);
    try {
      const p1Actions = legalActions(battle, 0);
      const p2Actions = legalActions(battle, 1);
      const payoff = Array.from({length: p1Actions.length}, () =>
        Array(p2Actions.length).fill(null)
      );
      const cells = Array.from({length: p1Actions.length}, () =>
        Array(p2Actions.length).fill(null)
      );

      // A value-only child can often be certified from a transition before
      // any of its continuing outcomes need to be explored. Keep terminal
      // outcomes separate from unresolved continuations; only exact outcome
      // certificates are used for pruning here.
      const refreshCell = cell => {
        let knownValue = 0;
        let unresolvedCount = 0;
        for (let index = 0; index < cell.outcomes.length; index++) {
          const outcome = cell.outcomes[index];
          const value = cell.values[index];
          if (value === undefined) {
            unresolvedCount++;
          } else {
            knownValue += outcome.probability * value;
          }
        }
        cell.unresolvedCount = unresolvedCount;
        if (unresolvedCount === 0) {
          cell.value = knownValue;
          cell.exact = true;
        }
      };

      const ensureCell = (i, j) => {
        if (cells[i][j]) return cells[i][j];
        const transition = enumerateTurn(snapshot, p1Actions[i], p2Actions[j], {
          maxSimulatorRunsPerTransition: this.options.maxSimulatorRunsPerTransition,
          eventPlan,
          ppCache: this.ppCache,
          ppAudit: this.ppAudit,
          outcomeKey: this.memoStateKey.private ? privateSnapshotKey : undefined,
        });
        this.stats.transitionCalls++;
        this.stats.simulatorRuns += transition.simulatorRuns;
        this.stats.ppCacheHits += transition.cacheHits || 0;

        const childKeys = transition.outcomes.map(outcome =>
          outcome.snapshot === undefined ? undefined : this._snapshotKey(outcome.snapshot)
        );
        const values = transition.outcomes.map((outcome, index) => {
          if (outcome.snapshot === undefined) return outcome.utility;
          const childKey = childKeys[index];
          const cachedChild = this.memo.get(childKey);
          if (cachedChild && typeof cachedChild.value === 'number') {
            this.stats.memoHits++;
            return cachedChild.value;
          }
          return undefined;
        });
        const cell = {
          outcomes: transition.outcomes,
          values,
          childKeys,
          exact: false,
          value: null,
          unresolvedCount: 0,
        };
        refreshCell(cell);
        cells[i][j] = cell;
        if (cell.exact) payoff[i][j] = cell.value;
        return cell;
      };

      const resolveCell = (i, j) => {
        const cell = ensureCell(i, j);
        if (cell.exact) return cell.value;

        // Resolve each distinct child at most once within this transition.
        // The solver memo still provides cross-transition sharing.
        const childValues = new Map();
        for (let index = 0; index < cell.outcomes.length; index++) {
          if (cell.values[index] !== undefined) continue;
          const outcome = cell.outcomes[index];
          const childKey = cell.childKeys[index];
          let value = childValues.get(childKey);
          if (value === undefined) {
            value = this._solve(outcome.snapshot, false, eventPlan).value;
            childValues.set(childKey, value);
          }
          cell.values[index] = value;
        }
        refreshCell(cell);
        payoff[i][j] = cell.value;
        return cell.value;
      };

      const rowIsForcedWin = i => {
        for (let j = 0; j < p2Actions.length; j++) {
          const cell = ensureCell(i, j);
          if (!cell.exact) return false;
          if (cell.values.some(value => value !== 1)) return false;
        }
        return true;
      };

      const columnIsForcedLoss = j => {
        for (let i = 0; i < p1Actions.length; i++) {
          const cell = ensureCell(i, j);
          if (!cell.exact || cell.value !== -1) return false;
          if (cell.values.some(value => value !== -1)) return false;
        }
        return true;
      };

      const exactSaddle = i => {
        for (let j = 0; j < p2Actions.length; j++) {
          const candidate = cells[i][j];
          if (!candidate.exact) continue;
          const value = candidate.value;
          const rowMin = Math.min(...payoff[i]);
          if (value !== rowMin) continue;
          for (let k = 0; k < p1Actions.length; k++) resolveCell(k, j);
          if (Math.max(...payoff.map(row => row[j])) <= rowMin) return rowMin;
        }
        return null;
      };

      const storeValue = value => {
        const result = {value, terminal: false};
        if (!this.memo.has(key)) this.stats.solvedStates++;
        this.memo.set(key, result);
        return result;
      };

      if (!wantStrategy) {
        for (let i = 0; i < p1Actions.length; i++) {
          // Generate one complete row first so immediate terminal outcomes
          // can certify a forced win without descending into any child.
          for (let j = 0; j < p2Actions.length; j++) ensureCell(i, j);
          if (rowIsForcedWin(i)) {
            return storeValue(1);
          }

          // Probe all-terminal cells first. This allows an exact column
          // certificate to be checked before descending into long children.
          const order = Array.from({length: p2Actions.length}, (_, j) => j)
            .sort((a, b) => {
              const left = cells[i][a];
              const right = cells[i][b];
              return left.unresolvedCount - right.unresolvedCount;
          });
          for (const j of order) {
            resolveCell(i, j);
            if (rowIsForcedWin(i)) {
              return storeValue(1);
            }
            const cell = cells[i][j];
            if (cell.exact && cell.values.every(value => value === -1) && columnIsForcedLoss(j)) {
              return storeValue(-1);
            }
            if (cells[i].every(cell => cell.exact)) {
              const value = exactSaddle(i);
              if (value !== null) {
                return storeValue(value);
              }
            }
          }
        }
      }

      // The root must expose the complete payoff matrix, and a value-only
      // state reaches here only after all useful certificates failed.
      for (let i = 0; i < p1Actions.length; i++) {
        for (let j = 0; j < p2Actions.length; j++) resolveCell(i, j);
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

      if (!this.memo.has(key)) this.stats.solvedStates++;
      this.memo.set(key, result);
      return result;
    } finally {
      this.visiting.delete(key);
    }
  }
}

module.exports = {OneVsOneSolver};
