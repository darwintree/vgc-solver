import type {Battle} from '@pkmn/sim';
import {
  enumerateTurn,
  restoreBattle,
  snapshotBattle,
} from '../showdown-adapter';
import {compileContextFromBattle} from './context';
import {
  canonicalStateKey,
  parseShowdownCommand,
  stateFromBattle,
} from './state';
import {stepBattle} from './turn';
import type {StepStats} from './types';

export interface ParityReport {
  exactMatch: boolean;
  totalVariationDistance: number;
  maxProbDiff: number;
  engineOutcomes: number;
  showdownOutcomes: number;
  missingFromEngine: {key: string; showdownProb: number}[];
  extraInEngine: {key: string; engineProb: number}[];
  probMismatches: {key: string; engineProb: number; showdownProb: number; diff: number}[];
  engineMs: number;
  showdownMs: number;
  showdownRuns: number;
  engineStats: StepStats;
}

/**
 * Compare the compact engine's exact discrete output distribution against
 * @pkmn/sim's exact enumerateTurn() for the same battle and commands.
 */
export function compareTurnWithShowdown(
  battle: Battle,
  p1Command: string,
  p2Command: string,
  tolerance = 1e-9
): ParityReport {
  const ctx = compileContextFromBattle(battle);
  const initialState = stateFromBattle(ctx, battle);
  const p1Action = parseShowdownCommand(ctx, initialState, 0, p1Command);
  const p2Action = parseShowdownCommand(ctx, initialState, 1, p2Command);

  const t0 = performance.now();
  const engineRes = stepBattle(ctx, initialState, p1Action, p2Action, {
    mode: 'certified',
    hpOutputMode: 'discrete',
  });
  const engineMs = performance.now() - t0;

  const snap = snapshotBattle(battle);
  const t1 = performance.now();
  const showdownRes = enumerateTurn(snap, {command: p1Command}, {command: p2Command});
  const showdownMs = performance.now() - t1;

  const engineDist = new Map<string, number>();
  for (const o of engineRes.outcomes) {
    const key = canonicalStateKey(ctx, o.state);
    engineDist.set(key, (engineDist.get(key) ?? 0) + o.probability);
  }

  const showdownDist = new Map<string, number>();
  for (const o of showdownRes.outcomes) {
    let key: string;
    if (o.utility !== undefined) {
      const winner = o.utility > 0 ? 0 : o.utility < 0 ? 1 : 2;
      key = `E:${winner}`;
    } else {
      const nextBattle = restoreBattle(o.snapshot);
      const nextState = stateFromBattle(ctx, nextBattle);
      key = canonicalStateKey(ctx, nextState);
    }
    showdownDist.set(key, (showdownDist.get(key) ?? 0) + o.probability);
  }

  const allKeys = new Set([...engineDist.keys(), ...showdownDist.keys()]);
  const missingFromEngine: {key: string; showdownProb: number}[] = [];
  const extraInEngine: {key: string; engineProb: number}[] = [];
  const probMismatches: {key: string; engineProb: number; showdownProb: number; diff: number}[] = [];
  let tvd = 0;
  let maxProbDiff = 0;

  for (const key of allKeys) {
    const ep = engineDist.get(key) ?? 0;
    const sp = showdownDist.get(key) ?? 0;
    const diff = Math.abs(ep - sp);
    tvd += 0.5 * diff;
    if (diff > maxProbDiff) maxProbDiff = diff;
    if (ep === 0 && sp > tolerance) {
      missingFromEngine.push({key, showdownProb: sp});
    } else if (sp === 0 && ep > tolerance) {
      extraInEngine.push({key, engineProb: ep});
    } else if (diff > tolerance) {
      probMismatches.push({key, engineProb: ep, showdownProb: sp, diff});
    }
  }

  return {
    exactMatch:
      engineRes.complete &&
      missingFromEngine.length === 0 &&
      extraInEngine.length === 0 &&
      probMismatches.length === 0,
    totalVariationDistance: tvd,
    maxProbDiff,
    engineOutcomes: engineDist.size,
    showdownOutcomes: showdownDist.size,
    missingFromEngine,
    extraInEngine,
    probMismatches,
    engineMs,
    showdownMs,
    showdownRuns: showdownRes.simulatorRuns,
    engineStats: engineRes.stats,
  };
}
