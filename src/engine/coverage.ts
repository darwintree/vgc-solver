import {getChampionsDex} from './ruleset';
import {compileItemSpec} from './effects/items';
import {isAbilitySupported} from './effects/abilities';
import {compileMoveSpec, isMoveSupported} from './effects/moves';

export interface CoverageSection {
  total: number;
  supported: number;
  percent: number;
  missing: string[];
}

export interface ChampionsCoverageReport {
  mod: string;
  species: CoverageSection;
  megas: CoverageSection;
  items: CoverageSection;
  abilities: CoverageSection;
  moves: CoverageSection;
  semanticMismatches: string[];
}

/**
 * Audit engine coverage and mechanical Dex-field consistency live against the
 * official `@pkmn/mods/champions` Dex. Re-run after every `@pkmn/sim` / `@pkmn/mods`
 * upgrade to catch missing entries or silent flag drift (willCrit, lockedmove, drain, etc.).
 */
export function auditChampionsCoverage(): ChampionsCoverageReport {
  const dex = getChampionsDex();

  const species = dex.species.all().filter(s => s.exists && !s.isNonstandard);
  const megas = species.filter(s => s.isMega);

  const items = dex.items.all().filter(i => i.exists && !i.isNonstandard);
  const missingItems: string[] = [];
  for (const item of items) {
    if (!compileItemSpec(dex, item.id).supported) missingItems.push(item.id);
  }

  const usedAbilities = new Set<string>();
  for (const s of species) {
    for (const a of Object.values(s.abilities)) {
      if (a) usedAbilities.add(dex.abilities.get(a).id);
    }
  }
  const missingAbilities: string[] = [];
  for (const ab of [...usedAbilities].sort()) {
    if (!isAbilitySupported(ab)) missingAbilities.push(ab);
  }

  const moves = dex.moves.all().filter(m => m.exists && !m.isNonstandard && !m.isZ && !m.isMax);
  const missingMoves: string[] = [];
  const semanticMismatches: string[] = [];
  for (const m of moves) {
    if (!isMoveSupported(dex, m.id).supported) {
      missingMoves.push(m.id);
      continue;
    }
    const compiled = compileMoveSpec(dex, m.id).move;
    if (m.willCrit === true && compiled.critRatio < 4) {
      semanticMismatches.push(`${m.id}: raw.willCrit=true but compiled.critRatio=${compiled.critRatio}`);
    }
    if (m.willCrit === false && compiled.critRatio !== 0) {
      semanticMismatches.push(`${m.id}: raw.willCrit=false but compiled.critRatio=${compiled.critRatio}`);
    }
    if (m.self?.volatileStatus === 'lockedmove' && !compiled.selfLockedMove) {
      semanticMismatches.push(`${m.id}: raw.self.volatileStatus=lockedmove but compiled.selfLockedMove=false`);
    }
    if (Array.isArray(m.drain) && m.drain.length === 2 && (!compiled.drain || !compiled.optTraits.hasDrain)) {
      semanticMismatches.push(`${m.id}: raw.drain=${JSON.stringify(m.drain)} not propagated to compiled move/optTraits`);
    }
    if (m.priority !== compiled.priority) {
      semanticMismatches.push(`${m.id}: raw.priority=${m.priority} !== compiled.priority=${compiled.priority}`);
    }
    if (m.multihit && !compiled.multihit && compiled.specialKind !== 'triple-axel') {
      semanticMismatches.push(`${m.id}: raw.multihit=${JSON.stringify(m.multihit)} missing on compiled move`);
    }
  }

  const section = (total: number, missing: string[]): CoverageSection => ({
    total,
    supported: total - missing.length,
    percent: total === 0 ? 100 : Math.round(((total - missing.length) / total) * 1000) / 10,
    missing,
  });

  return {
    mod: dex.currentMod,
    species: section(species.length, []),
    megas: section(megas.length, []),
    items: section(items.length, missingItems),
    abilities: section(usedAbilities.size, missingAbilities),
    moves: section(moves.length, missingMoves),
    semanticMismatches,
  };
}

if (require.main === module) {
  const strict = process.argv.includes('--strict');
  const r = auditChampionsCoverage();
  console.log(`Champions Coverage Audit (mod=${r.mod})`);
  let totalMissing = 0;
  for (const [label, sec] of [
    ['Species', r.species],
    ['Megas', r.megas],
    ['Items', r.items],
    ['Abilities', r.abilities],
    ['Moves', r.moves],
  ] as const) {
    totalMissing += sec.missing.length;
    console.log(`  ${label.padEnd(10)}: ${sec.supported}/${sec.total} (${sec.percent}%)`);
    if (sec.missing.length > 0) {
      console.log(`    missing (${sec.missing.length}): ${sec.missing.slice(0, 25).join(', ')}${sec.missing.length > 25 ? ', ...' : ''}`);
    }
  }
  console.log(`  Semantic  : ${r.semanticMismatches.length === 0 ? 'OK (0 mismatches)' : `${r.semanticMismatches.length} mismatch(es)`}`);
  if (r.semanticMismatches.length > 0) {
    for (const msg of r.semanticMismatches.slice(0, 25)) console.log(`    - ${msg}`);
  }
  if (strict && (totalMissing > 0 || r.semanticMismatches.length > 0)) {
    console.error(`Coverage audit failed in --strict mode: ${totalMissing} unsupported entries, ${r.semanticMismatches.length} semantic mismatches.`);
    process.exitCode = 1;
  }
}
