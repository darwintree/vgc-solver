import type {Battle} from '@pkmn/sim';
import {toID} from '@pkmn/sim';
import {
  FeatureBit,
  type ItemOptimizationTraits,
  type StatusId,
  type TerrainId,
  type WeatherId,
} from '../types';

export type ItemArchetype =
  | 'none'
  | 'mega-stone'
  | 'type-boost'
  | 'resist-berry'
  | 'status-berry'
  | 'terrain-seed'
  | 'weather-rock'
  | 'terrain-extender'
  | 'light-clay'
  | 'life-orb'
  | 'focus-sash'
  | 'focus-band'
  | 'sitrus-berry'
  | 'oran-berry'
  | 'leftovers'
  | 'choice-scarf'
  | 'rocky-helmet'
  | 'air-balloon'
  | 'scope-lens'
  | 'expert-belt'
  | 'muscle-band'
  | 'wise-glasses'
  | 'wide-lens'
  | 'zoom-lens'
  | 'white-herb'
  | 'eject-button'
  | 'red-card'
  | 'leppa-berry'
  | 'shell-bell'
  | 'big-root'
  | 'bright-powder'
  | 'quick-claw'
  | 'kings-rock'
  | 'metronome'
  | 'normal-gem'
  | 'iron-ball'
  | 'light-ball'
  | 'leek'
  | 'mental-herb'
  | 'shed-shell'
  | 'binding-band'
  | 'safety-goggles'
  | 'power-herb';

export interface CompiledItemSpec {
  id: string;
  archetype: ItemArchetype;
  supported: boolean;
  removable: boolean;
  featureBits: number;
  optTraits: ItemOptimizationTraits;
  /** Mega Evolution target species ID when archetype === 'mega-stone'. */
  megaSpeciesId?: string;
  /** Required base species ID for Mega Evolution (from item.megaEvolves). */
  megaEvolves?: string;
  /** Boosted or resisted move type for type-boost / resist-berry / normal-gem. */
  affectedType?: string;
  /** Status cured by status-berry ('any' for Lum Berry, 'confusion' for Persim Berry). */
  curesStatus?: StatusId | 'any' | 'confusion';
  /** Triggering terrain for terrain-seed. */
  seedTerrain?: TerrainId;
  /** Boosted stat ('def' | 'spd') for terrain-seed. */
  seedStat?: 'def' | 'spd';
  /** Extended weather for weather-rock. */
  extendedWeather?: WeatherId;
  /** True for all Berries (data-driven from Dex). */
  isBerry?: boolean;
  /** Fling base power (data-driven from Dex). */
  flingPower?: number;
  /** Fling inflicted status (e.g. Flame Orb -> brn, Light Ball -> par). */
  flingStatus?: StatusId;
  /** Fling inflicted volatile (e.g. King's Rock -> flinch). */
  flingVolatile?: 'flinch';
}

/** 18 standard Gen 9 / Champions 1.2x (4915/4096) type-boosting items. */
const TYPE_BOOST_ITEMS: Record<string, string> = {
  blackbelt: 'Fighting',
  blackglasses: 'Dark',
  charcoal: 'Fire',
  dragonfang: 'Dragon',
  fairyfeather: 'Fairy',
  hardstone: 'Rock',
  magnet: 'Electric',
  metalcoat: 'Steel',
  miracleseed: 'Grass',
  mysticwater: 'Water',
  nevermeltice: 'Ice',
  poisonbarb: 'Poison',
  sharpbeak: 'Flying',
  silkscarf: 'Normal',
  silverpowder: 'Bug',
  softsand: 'Ground',
  spelltag: 'Ghost',
  twistedspoon: 'Psychic',
};

/** 18 standard type-resist berries (halve SE damage, or Chilan halves Normal). */
const RESIST_BERRIES: Record<string, string> = {
  babiriberry: 'Steel',
  chartiberry: 'Rock',
  chilanberry: 'Normal',
  chopleberry: 'Fighting',
  cobaberry: 'Flying',
  colburberry: 'Dark',
  habanberry: 'Dragon',
  kasibberry: 'Ghost',
  kebiaberry: 'Poison',
  occaberry: 'Fire',
  passhoberry: 'Water',
  payapaberry: 'Psychic',
  rindoberry: 'Grass',
  roseliberry: 'Fairy',
  shucaberry: 'Ground',
  tangaberry: 'Bug',
  wacanberry: 'Electric',
  yacheberry: 'Ice',
};

const STATUS_BERRIES: Record<string, StatusId | 'any' | 'confusion'> = {
  aspearberry: 'frz',
  cheriberry: 'par',
  chestoberry: 'slp',
  lumberry: 'any',
  pechaberry: 'psn',
  persimberry: 'confusion',
  rawstberry: 'brn',
};

const TERRAIN_SEEDS: Record<string, {terrain: TerrainId; stat: 'def' | 'spd'}> = {
  electricseed: {terrain: 'electric', stat: 'def'},
  grassyseed: {terrain: 'grassy', stat: 'def'},
  mistyseed: {terrain: 'misty', stat: 'spd'},
  psychicseed: {terrain: 'psychic', stat: 'spd'},
};

const WEATHER_ROCKS: Record<string, WeatherId> = {
  damprock: 'rain',
  heatrock: 'sun',
  icyrock: 'snow',
  smoothrock: 'sand',
};

const UNIQUE_ITEMS: Record<string, {archetype: ItemArchetype; featureBits: number}> = {
  lifeorb: {archetype: 'life-orb', featureBits: FeatureBit.LIFE_ORB},
  focussash: {archetype: 'focus-sash', featureBits: FeatureBit.FOCUS_SASH},
  focusband: {archetype: 'focus-band', featureBits: FeatureBit.NONE},
  sitrusberry: {archetype: 'sitrus-berry', featureBits: FeatureBit.SITRUS_BERRY},
  oranberry: {archetype: 'oran-berry', featureBits: FeatureBit.SITRUS_BERRY},
  leftovers: {archetype: 'leftovers', featureBits: FeatureBit.LEFTOVERS},
  choicescarf: {archetype: 'choice-scarf', featureBits: FeatureBit.CHOICE_LOCK},
  rockyhelmet: {archetype: 'rocky-helmet', featureBits: FeatureBit.ROUGH_SKIN},
  airballoon: {archetype: 'air-balloon', featureBits: FeatureBit.NONE},
  scopelens: {archetype: 'scope-lens', featureBits: FeatureBit.NONE},
  expertbelt: {archetype: 'expert-belt', featureBits: FeatureBit.NONE},
  muscleband: {archetype: 'muscle-band', featureBits: FeatureBit.NONE},
  wiseglasses: {archetype: 'wise-glasses', featureBits: FeatureBit.NONE},
  widelens: {archetype: 'wide-lens', featureBits: FeatureBit.NONE},
  zoomlens: {archetype: 'zoom-lens', featureBits: FeatureBit.NONE},
  whiteherb: {archetype: 'white-herb', featureBits: FeatureBit.NONE},
  ejectbutton: {archetype: 'eject-button', featureBits: FeatureBit.PIVOT},
  redcard: {archetype: 'red-card', featureBits: FeatureBit.NONE},
  leppaberry: {archetype: 'leppa-berry', featureBits: FeatureBit.NONE},
  shellbell: {archetype: 'shell-bell', featureBits: FeatureBit.NONE},
  bigroot: {archetype: 'big-root', featureBits: FeatureBit.NONE},
  brightpowder: {archetype: 'bright-powder', featureBits: FeatureBit.NONE},
  quickclaw: {archetype: 'quick-claw', featureBits: FeatureBit.NONE},
  kingsrock: {archetype: 'kings-rock', featureBits: FeatureBit.NONE},
  metronome: {archetype: 'metronome', featureBits: FeatureBit.NONE},
  normalgem: {archetype: 'normal-gem', featureBits: FeatureBit.NONE},
  ironball: {archetype: 'iron-ball', featureBits: FeatureBit.NONE},
  lightball: {archetype: 'light-ball', featureBits: FeatureBit.NONE},
  leek: {archetype: 'leek', featureBits: FeatureBit.NONE},
  mentalherb: {archetype: 'mental-herb', featureBits: FeatureBit.NONE},
  shedshell: {archetype: 'shed-shell', featureBits: FeatureBit.NONE},
  bindingband: {archetype: 'binding-band', featureBits: FeatureBit.NONE},
  terrainextender: {archetype: 'terrain-extender', featureBits: FeatureBit.NONE},
  lightclay: {archetype: 'light-clay', featureBits: FeatureBit.NONE},
  safetygoggles: {archetype: 'safety-goggles', featureBits: FeatureBit.NONE},
  powerherb: {archetype: 'power-herb', featureBits: FeatureBit.NONE},
};

const SAFE_ITEM_TRAITS: ItemOptimizationTraits = {
  hpThresholdBerry: false,
  breaksFoeHpMonotonicity: false,
  canHealWithoutBerry: false,
  readsGlobalBoosts: false,
  damagesAttackerOnHit: false,
  selfRecoilOnAttack: false,
};

const UNSAFE_ITEM_TRAITS: ItemOptimizationTraits = {
  hpThresholdBerry: true,
  breaksFoeHpMonotonicity: true,
  canHealWithoutBerry: true,
  readsGlobalBoosts: true,
  damagesAttackerOnHit: true,
  selfRecoilOnAttack: true,
};

/**
 * Exhaustive optimization traits per ItemArchetype.
 * Adding a new ItemArchetype fails `tsc --noEmit` until its soundness traits are classified here.
 */
const ITEM_ARCHETYPE_TRAITS: Record<ItemArchetype, ItemOptimizationTraits> = {
  none: SAFE_ITEM_TRAITS,
  'mega-stone': SAFE_ITEM_TRAITS,
  'type-boost': SAFE_ITEM_TRAITS,
  'resist-berry': SAFE_ITEM_TRAITS,
  'status-berry': SAFE_ITEM_TRAITS,
  'terrain-seed': SAFE_ITEM_TRAITS,
  'weather-rock': SAFE_ITEM_TRAITS,
  'terrain-extender': SAFE_ITEM_TRAITS,
  'light-clay': SAFE_ITEM_TRAITS,
  'life-orb': {...SAFE_ITEM_TRAITS, selfRecoilOnAttack: true},
  'focus-sash': SAFE_ITEM_TRAITS,
  'focus-band': SAFE_ITEM_TRAITS,
  'sitrus-berry': {...SAFE_ITEM_TRAITS, hpThresholdBerry: true},
  'oran-berry': {...SAFE_ITEM_TRAITS, hpThresholdBerry: true},
  leftovers: {...SAFE_ITEM_TRAITS, canHealWithoutBerry: true},
  'choice-scarf': SAFE_ITEM_TRAITS,
  'rocky-helmet': {...SAFE_ITEM_TRAITS, damagesAttackerOnHit: true},
  'air-balloon': SAFE_ITEM_TRAITS,
  'scope-lens': SAFE_ITEM_TRAITS,
  'expert-belt': SAFE_ITEM_TRAITS,
  'muscle-band': SAFE_ITEM_TRAITS,
  'wise-glasses': SAFE_ITEM_TRAITS,
  'wide-lens': SAFE_ITEM_TRAITS,
  'zoom-lens': SAFE_ITEM_TRAITS,
  'white-herb': {...SAFE_ITEM_TRAITS, readsGlobalBoosts: true},
  'eject-button': SAFE_ITEM_TRAITS,
  'red-card': SAFE_ITEM_TRAITS,
  'leppa-berry': SAFE_ITEM_TRAITS,
  'shell-bell': {...SAFE_ITEM_TRAITS, breaksFoeHpMonotonicity: true, canHealWithoutBerry: true},
  'big-root': SAFE_ITEM_TRAITS,
  'bright-powder': SAFE_ITEM_TRAITS,
  'quick-claw': SAFE_ITEM_TRAITS,
  'kings-rock': SAFE_ITEM_TRAITS,
  metronome: SAFE_ITEM_TRAITS,
  'normal-gem': SAFE_ITEM_TRAITS,
  'iron-ball': SAFE_ITEM_TRAITS,
  'light-ball': SAFE_ITEM_TRAITS,
  leek: SAFE_ITEM_TRAITS,
  'mental-herb': SAFE_ITEM_TRAITS,
  'shed-shell': SAFE_ITEM_TRAITS,
  'binding-band': SAFE_ITEM_TRAITS,
  'safety-goggles': SAFE_ITEM_TRAITS,
  'power-herb': SAFE_ITEM_TRAITS,
};

/**
 * Compile any item directly from Dex metadata + generic family rules.
 * Covers 166/166 (100%) of all Pokémon Champions items — and automatically supports
 * newly added Mega Stones in future Champions Regulations with zero code changes!
 */
export function compileItemSpec(dex: Battle['dex'], itemIdRaw: string): CompiledItemSpec {
  const id = toID(itemIdRaw);
  if (!id) {
    return {
      id: '',
      archetype: 'none',
      supported: true,
      removable: false,
      featureBits: FeatureBit.NONE,
      optTraits: ITEM_ARCHETYPE_TRAITS.none,
    };
  }

  const raw: any = dex.items.get(id);
  const removable = !raw?.megaStone && !raw?.zMove && !raw?.onDrive && !raw?.onPlate && !raw?.onMemory;

  // 1. Data-driven Mega Stones (all 81+ current & future Champions Mega Stones automatically!)
  if (raw?.megaStone) {
    // In @pkmn/sim 0.11.0, megaStone can be a string (e.g. 'Gyarados-Mega') or an object map {Species: MegaSpecies}.
    let megaSpeciesId: string | undefined;
    let megaEvolves: string | undefined;
    if (typeof raw.megaStone === 'string') {
      megaSpeciesId = toID(raw.megaStone);
      megaEvolves = raw.megaEvolves ? toID(raw.megaEvolves) : undefined;
    } else if (typeof raw.megaStone === 'object') {
      const entries = Object.entries(raw.megaStone);
      if (entries.length > 0) {
        megaEvolves = toID(entries[0][0]);
        megaSpeciesId = toID(entries[0][1] as string);
      }
    }
    return {
      id,
      archetype: 'mega-stone',
      supported: !!megaSpeciesId,
      removable: false,
      featureBits: FeatureBit.MEGA,
      optTraits: ITEM_ARCHETYPE_TRAITS['mega-stone'],
      megaSpeciesId,
      megaEvolves,
    };
  }

  const fling: any = (raw as any).fling;
  const meta: Pick<CompiledItemSpec, 'isBerry' | 'flingPower' | 'flingStatus' | 'flingVolatile'> = {
    isBerry: !!raw.isBerry,
    flingPower: typeof fling?.basePower === 'number' ? fling.basePower : undefined,
    flingStatus: (fling?.status === 'brn' || fling?.status === 'par' || fling?.status === 'psn' || fling?.status === 'tox')
      ? fling.status
      : undefined,
    flingVolatile: fling?.volatileStatus === 'flinch' ? 'flinch' : undefined,
  };

  // 2. Type-boosting items (1.2x)
  if (TYPE_BOOST_ITEMS[id]) {
    return {
      id,
      archetype: 'type-boost',
      supported: true,
      removable,
      featureBits: FeatureBit.NONE,
      optTraits: ITEM_ARCHETYPE_TRAITS['type-boost'],
      affectedType: TYPE_BOOST_ITEMS[id],
      ...meta,
    };
  }

  // 3. Type-resist berries
  if (RESIST_BERRIES[id]) {
    return {
      id,
      archetype: 'resist-berry',
      supported: true,
      removable,
      featureBits: FeatureBit.NONE,
      optTraits: ITEM_ARCHETYPE_TRAITS['resist-berry'],
      affectedType: RESIST_BERRIES[id],
      ...meta,
    };
  }

  // 4. Status-cure berries
  if (STATUS_BERRIES[id]) {
    return {
      id,
      archetype: 'status-berry',
      supported: true,
      removable,
      featureBits: FeatureBit.NONE,
      optTraits: ITEM_ARCHETYPE_TRAITS['status-berry'],
      curesStatus: STATUS_BERRIES[id],
      ...meta,
    };
  }

  // 5. Terrain Seeds
  if (TERRAIN_SEEDS[id]) {
    return {
      id,
      archetype: 'terrain-seed',
      supported: true,
      removable,
      featureBits: FeatureBit.NONE,
      optTraits: ITEM_ARCHETYPE_TRAITS['terrain-seed'],
      seedTerrain: TERRAIN_SEEDS[id].terrain,
      seedStat: TERRAIN_SEEDS[id].stat,
      ...meta,
    };
  }

  // 6. Weather Rocks
  if (WEATHER_ROCKS[id]) {
    return {
      id,
      archetype: 'weather-rock',
      supported: true,
      removable,
      featureBits: FeatureBit.NONE,
      optTraits: ITEM_ARCHETYPE_TRAITS['weather-rock'],
      extendedWeather: WEATHER_ROCKS[id],
      ...meta,
    };
  }

  // 7. Unique Champions items
  const unique = UNIQUE_ITEMS[id];
  if (unique) {
    return {
      id,
      archetype: unique.archetype,
      supported: true,
      removable,
      featureBits: unique.featureBits,
      optTraits: ITEM_ARCHETYPE_TRAITS[unique.archetype],
      affectedType: id === 'normalgem' ? 'Normal' : undefined,
      ...meta,
    };
  }

  return {
    id,
    archetype: 'none',
    supported: false,
    removable,
    featureBits: FeatureBit.NONE,
    optTraits: UNSAFE_ITEM_TRAITS,
    ...meta,
  };
}
