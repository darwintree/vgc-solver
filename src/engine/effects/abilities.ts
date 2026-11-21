import {toID} from '@pkmn/sim';
import {
  FeatureBit,
  type AbilityOptimizationTraits,
  type BoostStat,
  type StatusId,
  type TerrainId,
  type WeatherId,
} from '../types';

export interface CompiledAbilitySpec {
  id: string;
  supported: boolean;
  featureBits: number;
  optTraits: AbilityOptimizationTraits;
  // Weather & Terrain setters on switch-in
  setsWeather?: WeatherId;
  setsTerrain?: TerrainId;
  // Weather / Terrain / Stat speed & defense modifiers
  speedDoubleWeather?: WeatherId;
  speedDoubleTerrain?: TerrainId;
  evasionWeather?: WeatherId;   // Sand Veil / Snow Cloak (0.8x accuracy + sand immunity)
  grassPelt?: boolean;          // 1.5x Def in Grassy Terrain
  cloudNine?: boolean;          // Suppresses weather effects while active
  // Pinch abilities (1.5x Atk/SpA at <= 1/3 HP)
  pinchType?: string;
  // Unconditional offensive type boost (Fire Mane 1.5x Fire)
  offenseTypeBoost?: {type: string; mult: number};
  // Normal -> X type converter + 1.2x BP (Dragonize, Pixilate, Aerilate, Refrigerate)
  ateType?: string;
  // Sound -> Water (Liquid Voice)
  liquidVoice?: boolean;
  // Type immunity & optional effect
  immuneType?: string;
  immuneHealQuarter?: boolean;
  immuneBoostStat?: 'atk' | 'spa' | 'spe' | 'def';
  immuneBoostStages?: number;
  drySkin?: boolean;            // Water immune+heal 1/4, 1.25x Fire taken, Rain +1/8, Sun -1/8
  flashFire?: boolean;
  soundproof?: boolean;
  bulletproof?: boolean;
  goodAsGold?: boolean;
  // Damage / Stat multipliers
  hugePower?: boolean;          // Huge Power / Pure Power (2x Atk)
  toughClaws?: boolean;         // 1.3x contact BP
  technician?: boolean;         // 1.5x if BP <= 60
  sheerForce?: boolean;         // 1.3x if has secondary, suppresses secondaries & LO recoil
  sharpness?: boolean;          // 1.5x slicing moves
  strongJaw?: boolean;          // 1.5x bite moves
  ironFist?: boolean;           // 1.2x punch moves
  megaLauncher?: boolean;       // 1.5x pulse moves
  reckless?: boolean;           // 1.2x recoil moves
  adaptability?: boolean;       // STAB 2x instead of 1.5x
  tintedLens?: boolean;         // 2x on resisted hits
  sniper?: boolean;             // 1.5x extra on crits
  sandForce?: boolean;          // 1.3x Rock/Ground/Steel in Sand
  guts?: boolean;               // 1.5x Atk when statused, ignore burn drop
  marvelScale?: boolean;        // 1.5x Def when statused
  hustle?: boolean;             // 1.5x Atk, 0.8x physical acc
  waterBubble?: boolean;        // 2x Water offense, 0.5x Fire taken, burn immune
  punkRock?: boolean;           // 1.3x sound offense, 0.5x sound taken
  megaSol?: boolean;            // Champions Mega Sol: moves act as if Sun is active
  analytic?: boolean;           // 1.3x BP when moving last
  fairyAura?: boolean;          // 4/3 Fairy BP globally while active
  steelySpirit?: boolean;       // 1.5x Steel BP for self & ally
  stakeout?: boolean;           // 2x Atk/SpA vs switched-in target
  supremeOverlord?: boolean;    // +10% BP per fainted ally (up to 5)
  plusMinus?: boolean;          // 1.5x SpA if active ally also has Plus or Minus
  merciless?: boolean;          // Always crit poisoned targets
  parentalBond?: boolean;       // Single-target non-multihit attacks hit twice (2nd hit 0.25x)
  // Defensive / Ally modifiers
  multiscale?: boolean;         // 0.5x damage at full HP
  teraShell?: boolean;          // At full HP, non-immune hits have 0.5x effectiveness
  auraGuard?: boolean;          // Champions Aura Guard: 0.5x damage from contact moves
  filter?: boolean;             // Filter / Solid Rock: 0.75x super-effective damage
  thickFat?: boolean;           // 0.5x Fire & Ice taken
  furCoat?: boolean;            // 2x Def
  fluffy?: boolean;             // 0.5x contact taken, 2x Fire taken
  iceScales?: boolean;          // 0.5x special damage taken
  heatproof?: boolean;          // 0.5x Fire taken, 0.5x burn damage
  purifyingSalt?: boolean;      // Status immune + 0.5x Ghost taken
  battleArmor?: boolean;        // Battle Armor / Shell Armor: crit immune
  shieldDust?: boolean;         // Immune to secondary effects
  overcoat?: boolean;           // Immune to weather damage & powder
  magicGuard?: boolean;         // Immune to indirect damage
  unaware?: boolean;            // Ignore opponent stat boosts
  friendGuard?: boolean;        // Ally takes 0.75x damage
  telepathy?: boolean;          // Immune to ally damaging moves
  damp?: boolean;               // Blocks Explosion / Self-Destruct / Misty Explosion / Aftermath
  // Switch / Hit / KO / Stat triggers
  intimidate?: boolean;
  embodyAspectStat?: BoostStat; // Ogerpon switch-in +1 stat
  curiousMedicine?: boolean;    // Switch-in resets ally boosts
  hospitality?: boolean;        // Switch-in heals ally 1/4 maxHP
  screenCleaner?: boolean;      // Switch-in clears screens on both sides
  supersweetSyrup?: boolean;    // Once-per-battle switch-in -1 Eva on opponents
  regenerator?: boolean;
  naturalCure?: boolean;
  moxie?: boolean;              // +1 Atk on KO
  eelevate?: boolean;           // Champions Eelevate: Ground immune + +1 best stat on KO
  disguise?: boolean;
  sturdy?: boolean;
  stamina?: boolean;
  roughSkin?: boolean;          // Rough Skin / Iron Barbs: 1/8 contact recoil
  aftermath?: boolean;          // Contact KO deals 1/4 maxHP to attacker
  innardsOut?: boolean;         // Direct-hit KO deals remaining HP damage to attacker
  contactStatus?: {status: StatusId; chance: number}; // Static, Flame Body, Poison Point
  effectSpore?: boolean;        // Contact 11% slp, 10% par, 9% psn (powder-blocked)
  gooey?: boolean;              // Contact lowers attacker Speed -1
  poisonTouch?: boolean;        // Attacker contact moves 30% poison
  stench?: boolean;             // 10% flinch if move doesn't already flinch
  spicyspray?: boolean;         // Champions Spicy Spray: burns attacker on any damaging hit
  angerPoint?: boolean;         // Surviving a crit sets Atk to +6
  electromorphosis?: boolean;   // Taking damage grants Charge
  rattled?: boolean;            // Bug/Dark/Ghost hit or Intimidate -> +1 Spe
  thermalExchange?: boolean;    // Fire hit -> +1 Atk, burn immune
  sandSpit?: boolean;           // Hit -> sets Sandstorm
  seedSower?: boolean;          // Hit -> sets Grassy Terrain
  toxicDebris?: boolean;        // Physical hit -> sets Toxic Spikes on foe side
  defiant?: boolean;
  competitive?: boolean;
  guardDog?: boolean;           // Intimidated -> +1 Atk; cannot be force-switched
  mirrorArmor?: boolean;        // Reflects opponent stat drops back to attacker
  opportunist?: boolean;        // Copies opponent stat raises
  synchronize?: boolean;        // Copies brn/par/psn/tox inflicted by foe back onto foe
  steadfast?: boolean;          // Flinch -> +1 Spe
  clearBody?: boolean;          // Clear Body / White Smoke: blocks opponent stat drops
  hyperCutter?: boolean;        // Blocks Atk drops
  bigPecks?: boolean;           // Blocks Def drops
  innerFocus?: boolean;         // Blocks flinch & Intimidate
  oblivious?: boolean;          // Blocks Intimidate & Taunt
  ownTempo?: boolean;           // Blocks Confusion & Intimidate
  aromaVeil?: boolean;          // Protects side from Taunt, Encore, Disable, Torment
  flowerVeil?: boolean;         // Protects side Grass-types from foe stat drops & status
  sweetVeil?: boolean;          // Protects side from Sleep & Yawn
  leafGuard?: boolean;          // Status immune in Sun
  statusImmune?: StatusId | 'all';
  corrosion?: boolean;          // Can poison Poison & Steel types
  earlyBird?: boolean;          // Sleep ticks down twice as fast
  contrary?: boolean;
  prankster?: boolean;
  galeWings?: boolean;
  moldBreaker?: boolean;
  protectBypassContact?: boolean; // Unseen Fist / Champions Piercing Drill
  infiltrator?: boolean;        // Bypass screens & Substitute
  compoundEyes?: boolean;       // 1.3x accuracy
  noGuard?: boolean;            // Moves always hit
  sereneGrace?: boolean;        // 2x secondary chance
  skillLink?: boolean;          // Multi-hit always 5 hits
  superLuck?: boolean;          // +1 crit stage
  speedBoost?: boolean;         // +1 Spe end of turn
  protean?: boolean;            // Protean / Libero: change type to move type once per switch-in
  rockHead?: boolean;           // No recoil damage
  unburden?: boolean;           // 2x speed after losing item
  weakArmor?: boolean;          // Physical hit: -1 Def, +2 Spe
  justified?: boolean;          // Dark hit: +1 Atk
  berserk?: boolean;            // Dropping below 50% HP: +1 SpA
  scrappy?: boolean;            // Normal/Fighting hit Ghost, blocks Intimidate
  priorityBlock?: boolean;      // Armor Tail / Queenly Majesty
  magicBounce?: boolean;        // Reflects reflectable status moves
  pressure?: boolean;           // Opponent moves targeting this Pokemon cost +1 PP
  healer?: boolean;             // Champions 50% / Gen 9 30% ally status cure at residual
  hydration?: boolean;          // Cure status at residual in Rain
  shedSkin?: boolean;           // 33% chance to cure status at residual
  harvest?: boolean;            // 50% (100% Sun) restore consumed Berry at residual
  rainDish?: boolean;           // Heal 1/16 in Rain
  iceBody?: boolean;            // Heal 1/16 in Snow
  solarPower?: boolean;         // 1.5x SpA, -1/8 HP in Sun
  poisonHeal?: boolean;         // Heal 1/8 when poisoned instead of damage
  quickFeet?: boolean;          // 1.5x Spe when statused, ignore par speed drop
  lightMetal?: boolean;         // Half weight
  heavyMetal?: boolean;         // Double weight
  longReach?: boolean;          // Moves do not make contact
  stickyHold?: boolean;         // Held item cannot be removed
  suctionCups?: boolean;        // Cannot be force-switched
  klutz?: boolean;              // Held item has no effect
  unnerve?: boolean;            // Prevents foes from eating Berries
  cheekPouch?: boolean;         // Eating a Berry heals +1/3 maxHP
  ripen?: boolean;              // Doubles Berry heal/boost/resist effects
  gluttony?: boolean;           // Pinch Berries activate at 50%
  liquidOoze?: boolean;         // Draining HP from this Pokemon damages drainer instead
  shadowTag?: boolean;          // Prevents opposing non-Ghost/non-Shadow Tag switches
  stalwart?: boolean;           // Moves ignore redirection
  stall?: boolean;              // Moves last in priority bracket
  quickDraw?: boolean;          // 30% chance to move first in priority bracket with attacks
  tangledFeet?: boolean;        // 0.5x incoming accuracy when confused
  rivalry?: boolean;            // 1.25x BP same gender, 0.75x opposite gender
  cursedBody?: boolean;         // 30% chance on hit to disable attacker's move
  cuteCharm?: boolean;          // 30% chance on contact hit to infatuate opposite gender
  moody?: boolean;              // Residual +2 random stat, -1 different random stat
  cudChew?: boolean;            // Re-eat consumed Berry at end of next turn
  emergencyExit?: boolean;      // Switch out when HP drops to <= 50% from > 50%
  mimicry?: boolean;            // Type changes to match active Terrain
  battleBond?: boolean;         // Once-per-battle +1 Atk/SpA/Spe on KO for Greninja-Bond
  mummy?: boolean;              // Contact hit overwrites attacker ability with Mummy
  wanderingSpirit?: boolean;    // Contact hit swaps abilities
  trace?: boolean;              // Switch-in copies random foe ability
  receiver?: boolean;           // Doubles ally faint copies ally ability
  magician?: boolean;           // Damaging move steals target item if user has none
  pickpocket?: boolean;         // Contact hit steals attacker item if defender has none
  symbiosis?: boolean;          // Doubles ally consuming item receives holder's item
  illusion?: boolean;           // Cosmetic disguise (cleared on hit, blocks Transform)
  zeroToHero?: boolean;         // Palafin transforms to Hero on switch-out
  iceFace?: boolean;            // Eiscue blocks 1 physical hit, restores in Snow
  shieldsDown?: boolean;        // Minior Meteor (>50% HP, status immune) <-> Core (<=50% HP)
  stanceChange?: boolean;       // Aegislash Blade on attack, Shield on King's Shield
  forecast?: boolean;           // Castform changes forme & type with Weather
  hungerSwitch?: boolean;       // Morpeko toggles Full Belly <-> Hangry at residual
  gulpMissile?: boolean;        // Cramorant Surf/Dive catches prey & counters on hit
  imposter?: boolean;           // Switch-in transforms into opposing active Pokemon
  noOpInBattle?: boolean;       // Abilities with no competitive battle effect (Illuminate, Pickup, etc.)
}

type AbilityEffectFields = Omit<CompiledAbilitySpec, 'id' | 'supported' | 'featureBits' | 'optTraits'>;

const ABILITY_SPECS: Record<string, AbilityEffectFields & {featureBits?: number}> = {
  // --- Champions new abilities (7/7 = 100%) ---
  auraguard: {auraGuard: true},
  dragonize: {ateType: 'Dragon'},
  eelevate: {immuneType: 'Ground', eelevate: true},
  firemane: {offenseTypeBoost: {type: 'Fire', mult: 1.5}},
  megasol: {megaSol: true},
  piercingdrill: {protectBypassContact: true},
  spicyspray: {spicyspray: true},

  // --- Pinch abilities ---
  torrent: {pinchType: 'Water', featureBits: FeatureBit.PINCH_ABILITY},
  overgrow: {pinchType: 'Grass', featureBits: FeatureBit.PINCH_ABILITY},
  blaze: {pinchType: 'Fire', featureBits: FeatureBit.PINCH_ABILITY},
  swarm: {pinchType: 'Bug', featureBits: FeatureBit.PINCH_ABILITY},

  // --- Weather & Terrain setters / abusers ---
  drought: {setsWeather: 'sun'},
  drizzle: {setsWeather: 'rain'},
  sandstream: {setsWeather: 'sand'},
  snowwarning: {setsWeather: 'snow'},
  electricsurge: {setsTerrain: 'electric'},
  grassysurge: {setsTerrain: 'grassy'},
  psychicsurge: {setsTerrain: 'psychic'},
  chlorophyll: {speedDoubleWeather: 'sun'},
  swiftswim: {speedDoubleWeather: 'rain'},
  sandrush: {speedDoubleWeather: 'sand'},
  slushrush: {speedDoubleWeather: 'snow'},
  surgesurfer: {speedDoubleTerrain: 'electric'},
  sandforce: {sandForce: true},
  solarpower: {solarPower: true},
  raindish: {rainDish: true},
  icebody: {iceBody: true},
  sandveil: {evasionWeather: 'sand'},
  snowcloak: {evasionWeather: 'snow'},
  grasspelt: {grassPelt: true},
  cloudnine: {cloudNine: true},
  hydration: {hydration: true},
  leafguard: {leafGuard: true},

  // --- Type converters ---
  pixilate: {ateType: 'Fairy'},
  aerilate: {ateType: 'Flying'},
  refrigerate: {ateType: 'Ice'},
  liquidvoice: {liquidVoice: true},
  protean: {protean: true},
  libero: {protean: true},
  scrappy: {scrappy: true},

  // --- Type immunities & absorbers ---
  levitate: {immuneType: 'Ground'},
  eartheater: {immuneType: 'Ground', immuneHealQuarter: true},
  waterabsorb: {immuneType: 'Water', immuneHealQuarter: true},
  voltabsorb: {immuneType: 'Electric', immuneHealQuarter: true},
  dryskin: {immuneType: 'Water', immuneHealQuarter: true, drySkin: true},
  stormdrain: {immuneType: 'Water', immuneBoostStat: 'spa', immuneBoostStages: 1},
  lightningrod: {immuneType: 'Electric', immuneBoostStat: 'spa', immuneBoostStages: 1, featureBits: FeatureBit.LIGHTNING_ROD},
  sapsipper: {immuneType: 'Grass', immuneBoostStat: 'atk', immuneBoostStages: 1},
  motordrive: {immuneType: 'Electric', immuneBoostStat: 'spe', immuneBoostStages: 1},
  wellbakedbody: {immuneType: 'Fire', immuneBoostStat: 'def', immuneBoostStages: 2},
  flashfire: {immuneType: 'Fire', flashFire: true},
  soundproof: {soundproof: true, featureBits: FeatureBit.SOUNDPROOF},
  bulletproof: {bulletproof: true},
  goodasgold: {goodAsGold: true},

  // --- Offensive multipliers ---
  hugepower: {hugePower: true},
  purepower: {hugePower: true},
  toughclaws: {toughClaws: true},
  technician: {technician: true},
  sheerforce: {sheerForce: true},
  sharpness: {sharpness: true},
  strongjaw: {strongJaw: true},
  ironfist: {ironFist: true},
  megalauncher: {megaLauncher: true},
  reckless: {reckless: true},
  adaptability: {adaptability: true},
  tintedlens: {tintedLens: true},
  sniper: {sniper: true},
  guts: {guts: true},
  marvelscale: {marvelScale: true},
  hustle: {hustle: true},
  waterbubble: {waterBubble: true, statusImmune: 'brn'},
  punkrock: {punkRock: true},
  analytic: {analytic: true},
  fairyaura: {fairyAura: true},
  steelyspirit: {steelySpirit: true},
  stakeout: {stakeout: true},
  supremeoverlord: {supremeOverlord: true},
  plus: {plusMinus: true},
  minus: {plusMinus: true},
  merciless: {merciless: true},
  parentalbond: {parentalBond: true},

  // --- Defensive & Ally modifiers ---
  multiscale: {multiscale: true},
  terashell: {teraShell: true},
  filter: {filter: true},
  solidrock: {filter: true},
  thickfat: {thickFat: true},
  furcoat: {furCoat: true},
  fluffy: {fluffy: true},
  icescales: {iceScales: true},
  heatproof: {heatproof: true},
  purifyingsalt: {purifyingSalt: true, statusImmune: 'all'},
  battlearmor: {battleArmor: true},
  shellarmor: {battleArmor: true},
  shielddust: {shieldDust: true},
  overcoat: {overcoat: true},
  magicguard: {magicGuard: true},
  unaware: {unaware: true},
  friendguard: {friendGuard: true},
  telepathy: {telepathy: true},
  damp: {damp: true},

  // --- Switch, Contact, KO, Stat & Mechanics ---
  intimidate: {intimidate: true, featureBits: FeatureBit.INTIMIDATE},
  embodyaspectcornerstone: {embodyAspectStat: 'def'},
  embodyaspecthearthflame: {embodyAspectStat: 'atk'},
  embodyaspectteal: {embodyAspectStat: 'spe'},
  embodyaspectwellspring: {embodyAspectStat: 'spd'},
  curiousmedicine: {curiousMedicine: true},
  hospitality: {hospitality: true},
  screencleaner: {screenCleaner: true},
  supersweetsyrup: {supersweetSyrup: true},
  regenerator: {regenerator: true},
  naturalcure: {naturalCure: true},
  moxie: {moxie: true},
  disguise: {disguise: true, featureBits: FeatureBit.DISGUISE},
  sturdy: {sturdy: true, featureBits: FeatureBit.FOCUS_SASH},
  stamina: {stamina: true, featureBits: FeatureBit.STAMINA},
  roughskin: {roughSkin: true, featureBits: FeatureBit.ROUGH_SKIN},
  ironbarbs: {roughSkin: true, featureBits: FeatureBit.ROUGH_SKIN},
  aftermath: {aftermath: true},
  innardsout: {innardsOut: true},
  static: {contactStatus: {status: 'par', chance: 30}},
  flamebody: {contactStatus: {status: 'brn', chance: 30}},
  poisonpoint: {contactStatus: {status: 'psn', chance: 30}},
  effectspore: {effectSpore: true},
  gooey: {gooey: true},
  poisontouch: {poisonTouch: true},
  stench: {stench: true},
  angerpoint: {angerPoint: true},
  electromorphosis: {electromorphosis: true},
  rattled: {rattled: true},
  thermalexchange: {thermalExchange: true, statusImmune: 'brn'},
  sandspit: {sandSpit: true},
  seedsower: {seedSower: true},
  toxicdebris: {toxicDebris: true},
  defiant: {defiant: true, featureBits: FeatureBit.DEFIANT},
  competitive: {competitive: true, featureBits: FeatureBit.DEFIANT},
  guarddog: {guardDog: true},
  mirrorarmor: {mirrorArmor: true},
  opportunist: {opportunist: true},
  synchronize: {synchronize: true},
  steadfast: {steadfast: true},
  clearbody: {clearBody: true},
  whitesmoke: {clearBody: true},
  hypercutter: {hyperCutter: true},
  bigpecks: {bigPecks: true},
  innerfocus: {innerFocus: true},
  oblivious: {oblivious: true},
  owntempo: {ownTempo: true},
  aromaveil: {aromaVeil: true},
  flowerveil: {flowerVeil: true},
  sweetveil: {sweetVeil: true},
  insomnia: {statusImmune: 'slp'},
  vitalspirit: {statusImmune: 'slp'},
  immunity: {statusImmune: 'psn'},
  limber: {statusImmune: 'par'},
  magmaarmor: {statusImmune: 'frz'},
  corrosion: {corrosion: true},
  earlybird: {earlyBird: true},
  contrary: {contrary: true},
  prankster: {prankster: true},
  galewings: {galeWings: true},
  moldbreaker: {moldBreaker: true},
  unseenfist: {protectBypassContact: true},
  infiltrator: {infiltrator: true},
  compoundeyes: {compoundEyes: true},
  noguard: {noGuard: true},
  serenegrace: {sereneGrace: true},
  skilllink: {skillLink: true},
  superluck: {superLuck: true},
  speedboost: {speedBoost: true},
  rockhead: {rockHead: true},
  unburden: {unburden: true},
  weakarmor: {weakArmor: true},
  justified: {justified: true},
  berserk: {berserk: true},
  armortail: {priorityBlock: true},
  queenlymajesty: {priorityBlock: true},
  magicbounce: {magicBounce: true},
  pressure: {pressure: true},
  healer: {healer: true},
  shedskin: {shedSkin: true},
  harvest: {harvest: true},
  poisonheal: {poisonHeal: true},
  quickfeet: {quickFeet: true},
  lightmetal: {lightMetal: true},
  heavymetal: {heavyMetal: true},
  longreach: {longReach: true},
  stickyhold: {stickyHold: true},
  suctioncups: {suctionCups: true},
  klutz: {klutz: true},
  unnerve: {unnerve: true},
  cheekpouch: {cheekPouch: true},
  ripen: {ripen: true},
  gluttony: {gluttony: true},
  liquidooze: {liquidOoze: true},
  shadowtag: {shadowTag: true},
  stalwart: {stalwart: true},
  stall: {stall: true},
  quickdraw: {quickDraw: true},
  tangledfeet: {tangledFeet: true},
  rivalry: {rivalry: true},
  cursedbody: {cursedBody: true, featureBits: FeatureBit.LAST_MOVE},
  cutecharm: {cuteCharm: true},
  moody: {moody: true},
  cudchew: {cudChew: true},
  emergencyexit: {emergencyExit: true, featureBits: FeatureBit.PIVOT},
  mimicry: {mimicry: true},
  battlebond: {battleBond: true},
  mummy: {mummy: true},
  wanderingspirit: {wanderingSpirit: true},
  trace: {trace: true},
  receiver: {receiver: true},
  magician: {magician: true},
  pickpocket: {pickpocket: true},
  symbiosis: {symbiosis: true},
  illusion: {illusion: true},
  zerotohero: {zeroToHero: true},
  iceface: {iceFace: true, featureBits: FeatureBit.DISGUISE},
  shieldsdown: {shieldsDown: true},
  stancechange: {stanceChange: true},
  forecast: {forecast: true},
  hungerswitch: {hungerSwitch: true},
  gulpmissile: {gulpMissile: true},
  imposter: {imposter: true},
  keeneye: {noOpInBattle: true},
  runaway: {noOpInBattle: true},
  illuminate: {noOpInBattle: true},
  pickup: {noOpInBattle: true},
  frisk: {noOpInBattle: true},
  anticipation: {noOpInBattle: true},
  forewarn: {noOpInBattle: true},
};

type AbilityFlagRole =
  | 'safe'
  | 'terrain-setter'
  | 'mutates-abilities'
  | 'mutates-abilities-and-boosts'
  | 'mutates-berry'
  | 'heals-self'
  | 'heals-both'
  | 'reads-boosts'
  | 'hp-pinch'
  | 'hp-half'
  | 'hp-below-max';

/**
 * Exhaustive optimization classification of every effect field on CompiledAbilitySpec.
 * Adding a new ability effect field fails `tsc --noEmit` until classified here,
 * preventing future rules updates from silently breaking soundness.
 */
const ABILITY_FLAG_CLASS: Record<keyof AbilityEffectFields, AbilityFlagRole> = {
  setsWeather: 'safe',
  setsTerrain: 'terrain-setter',
  speedDoubleWeather: 'safe',
  speedDoubleTerrain: 'safe',
  evasionWeather: 'safe',
  grassPelt: 'safe',
  cloudNine: 'safe',
  pinchType: 'hp-pinch',
  offenseTypeBoost: 'safe',
  ateType: 'safe',
  liquidVoice: 'safe',
  immuneType: 'safe',
  immuneHealQuarter: 'heals-self',
  immuneBoostStat: 'safe',
  immuneBoostStages: 'safe',
  drySkin: 'heals-self',
  flashFire: 'safe',
  soundproof: 'safe',
  bulletproof: 'safe',
  goodAsGold: 'safe',
  hugePower: 'safe',
  toughClaws: 'safe',
  technician: 'safe',
  sheerForce: 'safe',
  sharpness: 'safe',
  strongJaw: 'safe',
  ironFist: 'safe',
  megaLauncher: 'safe',
  reckless: 'safe',
  adaptability: 'safe',
  tintedLens: 'safe',
  sniper: 'safe',
  sandForce: 'safe',
  guts: 'safe',
  marvelScale: 'safe',
  hustle: 'safe',
  waterBubble: 'safe',
  punkRock: 'safe',
  megaSol: 'safe',
  analytic: 'safe',
  fairyAura: 'safe',
  steelySpirit: 'safe',
  stakeout: 'safe',
  supremeOverlord: 'safe',
  plusMinus: 'safe',
  merciless: 'safe',
  parentalBond: 'safe',
  multiscale: 'safe',
  teraShell: 'safe',
  auraGuard: 'safe',
  filter: 'safe',
  thickFat: 'safe',
  furCoat: 'safe',
  fluffy: 'safe',
  iceScales: 'safe',
  heatproof: 'safe',
  purifyingSalt: 'safe',
  battleArmor: 'safe',
  shieldDust: 'safe',
  overcoat: 'safe',
  magicGuard: 'safe',
  unaware: 'safe',
  friendGuard: 'safe',
  telepathy: 'safe',
  damp: 'safe',
  intimidate: 'safe',
  embodyAspectStat: 'safe',
  curiousMedicine: 'reads-boosts',
  hospitality: 'heals-self',
  screenCleaner: 'safe',
  supersweetSyrup: 'safe',
  regenerator: 'heals-self',
  naturalCure: 'safe',
  moxie: 'safe',
  eelevate: 'safe',
  disguise: 'safe',
  sturdy: 'safe',
  stamina: 'safe',
  roughSkin: 'safe',
  aftermath: 'safe',
  innardsOut: 'safe',
  contactStatus: 'safe',
  effectSpore: 'safe',
  gooey: 'safe',
  poisonTouch: 'safe',
  stench: 'safe',
  spicyspray: 'safe',
  angerPoint: 'safe',
  electromorphosis: 'safe',
  rattled: 'safe',
  thermalExchange: 'safe',
  sandSpit: 'safe',
  seedSower: 'heals-both',
  toxicDebris: 'safe',
  defiant: 'reads-boosts',
  competitive: 'reads-boosts',
  guardDog: 'safe',
  mirrorArmor: 'reads-boosts',
  opportunist: 'reads-boosts',
  synchronize: 'safe',
  steadfast: 'safe',
  clearBody: 'safe',
  hyperCutter: 'safe',
  bigPecks: 'safe',
  innerFocus: 'safe',
  oblivious: 'safe',
  ownTempo: 'safe',
  aromaVeil: 'safe',
  flowerVeil: 'safe',
  sweetVeil: 'safe',
  leafGuard: 'safe',
  statusImmune: 'safe',
  corrosion: 'safe',
  earlyBird: 'safe',
  contrary: 'reads-boosts',
  prankster: 'safe',
  galeWings: 'hp-below-max',
  moldBreaker: 'safe',
  protectBypassContact: 'safe',
  infiltrator: 'safe',
  compoundEyes: 'safe',
  noGuard: 'safe',
  sereneGrace: 'safe',
  skillLink: 'safe',
  superLuck: 'safe',
  speedBoost: 'safe',
  protean: 'safe',
  rockHead: 'safe',
  unburden: 'safe',
  weakArmor: 'safe',
  justified: 'safe',
  berserk: 'hp-half',
  scrappy: 'safe',
  priorityBlock: 'safe',
  magicBounce: 'safe',
  pressure: 'safe',
  healer: 'safe',
  hydration: 'safe',
  shedSkin: 'safe',
  harvest: 'mutates-berry',
  rainDish: 'heals-self',
  iceBody: 'heals-self',
  solarPower: 'safe',
  poisonHeal: 'heals-self',
  quickFeet: 'safe',
  lightMetal: 'safe',
  heavyMetal: 'safe',
  longReach: 'safe',
  stickyHold: 'safe',
  suctionCups: 'safe',
  klutz: 'safe',
  unnerve: 'safe',
  cheekPouch: 'heals-self',
  ripen: 'safe',
  gluttony: 'safe',
  liquidOoze: 'safe',
  shadowTag: 'safe',
  stalwart: 'safe',
  stall: 'safe',
  quickDraw: 'safe',
  tangledFeet: 'safe',
  rivalry: 'safe',
  cursedBody: 'safe',
  cuteCharm: 'safe',
  moody: 'reads-boosts',
  cudChew: 'safe',
  emergencyExit: 'hp-half',
  mimicry: 'safe',
  battleBond: 'safe',
  mummy: 'mutates-abilities',
  wanderingSpirit: 'mutates-abilities',
  trace: 'mutates-abilities',
  receiver: 'mutates-abilities',
  magician: 'mutates-berry',
  pickpocket: 'mutates-berry',
  symbiosis: 'mutates-berry',
  illusion: 'safe',
  zeroToHero: 'safe',
  iceFace: 'safe',
  shieldsDown: 'hp-half',
  stanceChange: 'safe',
  forecast: 'safe',
  hungerSwitch: 'safe',
  gulpMissile: 'hp-half',
  imposter: 'mutates-abilities-and-boosts',
  noOpInBattle: 'safe',
};

const SAFE_ABILITY_TRAITS: AbilityOptimizationTraits = {
  mutatesAbilities: false,
  mutatesBerry: false,
  canHealSelf: false,
  canHealFoe: false,
  readsGlobalBoosts: false,
  hpThreshold: 'none',
};

const UNSAFE_ABILITY_TRAITS: AbilityOptimizationTraits = {
  mutatesAbilities: true,
  mutatesBerry: true,
  canHealSelf: true,
  canHealFoe: true,
  readsGlobalBoosts: true,
  hpThreshold: 'below-maxhp',
};

function deriveAbilityOptTraits(spec: AbilityEffectFields): AbilityOptimizationTraits {
  let mutatesAbilities = false;
  let mutatesBerry = false;
  let canHealSelf = false;
  let canHealFoe = false;
  let readsGlobalBoosts = false;
  let hpThreshold: AbilityOptimizationTraits['hpThreshold'] = 'none';

  for (const key of Object.keys(spec) as (keyof AbilityEffectFields | 'featureBits')[]) {
    if (key === 'featureBits') continue;
    const val = spec[key];
    if (!val) continue;
    const role = ABILITY_FLAG_CLASS[key];
    if (!role) {
      // Fail closed if an unclassified field somehow appears at runtime
      return UNSAFE_ABILITY_TRAITS;
    }
    switch (role) {
      case 'safe':
        break;
      case 'terrain-setter':
        if (val === 'grassy') {
          canHealSelf = true;
          canHealFoe = true;
        }
        break;
      case 'mutates-abilities':
        mutatesAbilities = true;
        break;
      case 'mutates-abilities-and-boosts':
        mutatesAbilities = true;
        readsGlobalBoosts = true;
        break;
      case 'mutates-berry':
        mutatesBerry = true;
        break;
      case 'heals-self':
        canHealSelf = true;
        break;
      case 'heals-both':
        canHealSelf = true;
        canHealFoe = true;
        break;
      case 'reads-boosts':
        readsGlobalBoosts = true;
        break;
      case 'hp-pinch':
        hpThreshold = 'pinch-third';
        break;
      case 'hp-half':
        hpThreshold = 'half-maxhp';
        break;
      case 'hp-below-max':
        hpThreshold = 'below-maxhp';
        break;
    }
  }

  return {mutatesAbilities, mutatesBerry, canHealSelf, canHealFoe, readsGlobalBoosts, hpThreshold};
}

export function compileAbilitySpec(abilityIdRaw: string): CompiledAbilitySpec {
  const id = toID(abilityIdRaw);
  if (!id) {
    return {id: '', supported: true, featureBits: FeatureBit.NONE, optTraits: SAFE_ABILITY_TRAITS};
  }
  const spec = ABILITY_SPECS[id];
  if (!spec) {
    return {id, supported: false, featureBits: FeatureBit.NONE, optTraits: UNSAFE_ABILITY_TRAITS};
  }
  return {
    id,
    supported: true,
    featureBits: spec.featureBits ?? FeatureBit.NONE,
    optTraits: deriveAbilityOptTraits(spec),
    ...spec,
  };
}

export function isAbilitySupported(abilityIdRaw: string): boolean {
  const id = toID(abilityIdRaw);
  return id === '' || Object.prototype.hasOwnProperty.call(ABILITY_SPECS, id);
}
