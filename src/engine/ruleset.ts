import {Battle, Dex, toID} from '@pkmn/sim';
import type {ID, ModData, PokemonSet} from '@pkmn/sim';

// `@pkmn/mods` ships official Pokémon Showdown mods (including `champions` and `championsregmb`).
// Loaded lazily via require so projects without mods still load cleanly if only using base Gen 9.
const championsModData = require('@pkmn/mods/champions') as ModData;

export type RulesetId = 'champions' | 'gen9';

export interface RulesetConfig {
  id: RulesetId;
  /** Paralysis full-para probability: 1/8 in Champions, 1/4 in mainline Gen 9. */
  paralysisChance: number;
  /** Sleep turn counter distribution on sleep start: [2,3,3] in Champions, [2,3,4] in Gen 9. */
  sleepDurationWeights: readonly {turns: number; prob: number}[];
  /** Per-turn thaw probability while frozen: 1/4 in Champions, 1/5 in Gen 9. */
  freezeThawChance: number;
  /** Maximum freeze turns before guaranteed thaw (3 in Champions, 0 = unlimited in Gen 9). */
  freezeMaxTurns: number;
  /** Champions removes Trick Room underflow by negating speed (`-speed`) instead of `trunc(10000 - speed, 13)`. */
  trickRoomNegatesSpeed: boolean;
  /** Whether Mega Evolution is enabled (once per side per battle). */
  megaEvolutionEnabled: boolean;
  /** Unseen Fist / Piercing Drill damage multiplier through Protect (0.25 in Champions, 1.0 in mainline Gen 9). */
  protectBypassMultiplier: number;
  /** Healer end-of-turn cure probability (0.5 in Champions, 0.3 in mainline Gen 9). */
  healerChance: number;
}

export const CHAMPIONS_RULESET: RulesetConfig = Object.freeze({
  id: 'champions',
  paralysisChance: 1 / 8,
  sleepDurationWeights: Object.freeze([
    {turns: 2, prob: 1 / 3},
    {turns: 3, prob: 2 / 3},
  ]),
  freezeThawChance: 1 / 4,
  freezeMaxTurns: 3,
  trickRoomNegatesSpeed: true,
  megaEvolutionEnabled: true,
  protectBypassMultiplier: 0.25,
  healerChance: 0.5,
});

export const GEN9_RULESET: RulesetConfig = Object.freeze({
  id: 'gen9',
  paralysisChance: 1 / 4,
  sleepDurationWeights: Object.freeze([
    {turns: 2, prob: 1 / 3},
    {turns: 3, prob: 1 / 3},
    {turns: 4, prob: 1 / 3},
  ]),
  freezeThawChance: 1 / 5,
  freezeMaxTurns: 0,
  trickRoomNegatesSpeed: false,
  megaEvolutionEnabled: false,
  protectBypassMultiplier: 1,
  healerChance: 0.3,
});

let cachedChampionsDex: Battle['dex'] | null = null;
let championsFormatsExtended = false;

/** Return the official Pokémon Champions Dex loaded from `@pkmn/mods/champions`. */
export function getChampionsDex(): Battle['dex'] {
  if (!cachedChampionsDex) {
    cachedChampionsDex = Dex.mod('champions' as ID, championsModData);
  }
  return cachedChampionsDex;
}

/**
 * Ensure global Dex.formats knows about Champions format IDs so `@pkmn/sim`'s
 * `Battle.fromJSON()` restores `mod: 'champions'` instead of falling back to `base`.
 */
export function registerChampionsFormats(): void {
  getChampionsDex();
  if (!championsFormatsExtended && (championsModData as any).Formats) {
    Dex.formats.extend((championsModData as any).Formats);
    championsFormatsExtended = true;
  }
}

/** Detect the active RulesetConfig directly from a `@pkmn/sim` Battle instance. */
export function detectRulesetFromBattle(battle: Battle): RulesetConfig {
  const mod = battle.dex?.currentMod;
  if (mod === 'champions' || mod === 'championsregmb') {
    return CHAMPIONS_RULESET;
  }
  const hasMega = battle.sides.some(side =>
    side.pokemon.some(p => !!p.canMegaEvo)
  );
  if (hasMega) {
    return {...GEN9_RULESET, megaEvolutionEnabled: true};
  }
  return GEN9_RULESET;
}

/**
 * Helper to create a real `@pkmn/sim` Battle running the official Pokémon Champions mod
 * (`gen9championscustomgame` or `gen9championsdoublescustomgame`) for testing & parity verification.
 */
export function createChampionsModBattle(
  p1Team: Partial<PokemonSet>[],
  p2Team: Partial<PokemonSet>[],
  options: {doubles?: boolean; seed?: [number, number, number, number]} = {}
): Battle {
  registerChampionsFormats();
  const dex = getChampionsDex();
  const formatid = toID(options.doubles ? 'gen9championsdoublescustomgame' : 'gen9championscustomgame');
  const format = dex.formats.get(formatid);
  const battle = new Battle({
    format,
    formatid,
    debug: true,
    strictChoices: true,
    seed: (options.seed ?? [1, 2, 3, 4]) as any,
    p1: {name: 'P1', team: p1Team as PokemonSet[]},
    p2: {name: 'P2', team: p2Team as PokemonSet[]},
  });
  if (battle.requestState === 'teampreview') {
    const pick1 = p1Team.map((_, i) => i + 1).join('');
    const pick2 = p2Team.map((_, i) => i + 1).join('');
    battle.makeChoices(`team ${pick1}`, `team ${pick2}`);
  }
  return battle;
}
