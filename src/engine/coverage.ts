import {getChampionsDex} from './ruleset';
import {compileItemSpec} from './effects/items';
import {isAbilitySupported} from './effects/abilities';
import {isMoveSupported} from './effects/moves';

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
}

/**
 * Audit engine coverage live against the official `@pkmn/mods/champions` Dex.
 * Re-run after every `@pkmn/sim` / `@pkmn/mods` upgrade to immediately see any
 * newly introduced species, Mega Evolutions, items, abilities, or moves.
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
  for (const m of moves) {
    if (!isMoveSupported(dex, m.id).supported) missingMoves.push(m.id);
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
  };
}

if (require.main === module) {
  const r = auditChampionsCoverage();
  console.log(`Champions Coverage Audit (mod=${r.mod})`);
  for (const [label, sec] of [
    ['Species', r.species],
    ['Megas', r.megas],
    ['Items', r.items],
    ['Abilities', r.abilities],
    ['Moves', r.moves],
  ] as const) {
    console.log(`  ${label.padEnd(10)}: ${sec.supported}/${sec.total} (${sec.percent}%)`);
    if (sec.missing.length > 0) {
      console.log(`    missing (${sec.missing.length}): ${sec.missing.slice(0, 25).join(', ')}${sec.missing.length > 25 ? ', ...' : ''}`);
    }
  }
}
