import type {CompiledAbilitySpec} from './effects/abilities';
import type {CompiledItemSpec} from './effects/items';
import type {RulesetConfig} from './ruleset';

export type GameType = 'singles' | 'doubles';
export type MoveCategory = 'Physical' | 'Special' | 'Status';
export type StatusId = '' | 'par' | 'brn' | 'psn' | 'tox' | 'slp' | 'frz';
export type WeatherId = '' | 'sun' | 'rain' | 'sand' | 'snow';
export type TerrainId = '' | 'electric' | 'grassy' | 'misty' | 'psychic';

export type MoveTargetType =
  | 'normal'
  | 'self'
  | 'allAdjacentFoes'
  | 'allAdjacent'
  | 'foeSide'
  | 'allySide'
  | 'adjacentAllyOrSelf'
  | 'randomNormal'
  | 'any';

export type MoveSpecialKind =
  | 'standard'
  | 'struggle'
  | 'protect'
  | 'spiky-shield'
  | 'kings-shield'
  | 'baneful-bunker'
  | 'wide-guard'
  | 'quick-guard'
  | 'endure'
  | 'sucker-punch'
  | 'upper-hand'
  | 'fake-out'
  | 'knock-off'
  | 'encore'
  | 'taunt'
  | 'substitute'
  | 'throat-chop'
  | 'cures-burn'
  | 'heal-half'
  | 'roost'
  | 'heal-weather'
  | 'rest'
  | 'facade'
  | 'hex'
  | 'venoshock'
  | 'acrobatics'
  | 'body-press'
  | 'foul-play'
  | 'psyshock'
  | 'hp-scaled-bp'
  | 'stored-power'
  | 'brine'
  | 'weather-ball'
  | 'terrain-pulse'
  | 'expanding-force'
  | 'rising-voltage'
  | 'weight-target'
  | 'weight-ratio'
  | 'gyro-ball'
  | 'electro-ball'
  | 'flail'
  | 'hard-press'
  | 'last-respects'
  | 'rage-fist'
  | 'payback'
  | 'avalanche'
  | 'assurance'
  | 'lash-out'
  | 'stomping-tantrum'
  | 'triple-axel'
  | 'fickle-beam'
  | 'grav-apple'
  | 'freeze-dry'
  | 'flying-press'
  | 'weather-acc-rain'
  | 'weather-acc-snow'
  | 'grassy-glide'
  | 'crash-recoil'
  | 'steel-beam'
  | 'ohko'
  | 'counter'
  | 'mirror-coat'
  | 'metal-burst'
  | 'half-hp'
  | 'endeavor'
  | 'final-gambit'
  | 'self-ko'
  | 'screen-break'
  | 'feint'
  | 'clear-smog'
  | 'haze'
  | 'curse'
  | 'belly-drum'
  | 'clangorous-soul'
  | 'no-retreat'
  | 'burn-up'
  | 'double-shock'
  | 'glaive-rush'
  | 'syrup-bomb'
  | 'fell-stinger'
  | 'ceaseless-edge'
  | 'stone-axe'
  | 'ice-spinner'
  | 'steel-roller'
  | 'poltergeist'
  | 'pollen-puff'
  | 'heal-pulse'
  | 'heal-bell'
  | 'strength-sap'
  | 'pain-split'
  | 'disable'
  | 'torment'
  | 'perish-song'
  | 'destiny-bond'
  | 'court-change'
  | 'corrosive-gas'
  | 'soak'
  | 'magic-powder'
  | 'trick-or-treat'
  | 'forests-curse'
  | 'topsy-turvy'
  | 'psych-up'
  | 'power-swap'
  | 'guard-swap'
  | 'speed-swap'
  | 'acupressure'
  | 'spite'
  | 'trap-target'
  | 'partial-trap'
  | 'focus-energy'
  | 'dragon-cheer'
  | 'charge'
  | 'aqua-ring'
  | 'ingrain'
  | 'smack-down'
  | 'safeguard'
  | 'gravity'
  | 'fairy-lock'
  | 'magic-room'
  | 'wonder-room'
  | 'wish'
  | 'future-sight'
  | 'solar-beam'
  | 'meteor-beam'
  | 'electro-shot'
  | 'two-turn-invuln'
  | 'sky-attack'
  | 'ally-switch'
  | 'after-you'
  | 'quash'
  | 'stealth-rock'
  | 'spikes'
  | 'toxic-spikes'
  | 'sticky-web'
  | 'hazard-clear-self'
  | 'defog'
  | 'tidy-up'
  | 'reflect'
  | 'light-screen'
  | 'aurora-veil'
  | 'tailwind'
  | 'trick-room'
  | 'set-weather'
  | 'set-terrain'
  | 'force-switch'
  | 'parting-shot'
  | 'chilly-reception'
  | 'helping-hand'
  | 'redirect'
  | 'tri-attack'
  | 'leech-seed'
  | 'yawn'
  | 'snore'
  | 'belch'
  | 'last-resort'
  | 'uproar'
  | 'flinch-only-turn1'
  | 'raging-bull'
  | 'beak-blast'
  | 'electrify'
  | 'octolock'
  | 'power-shift'
  | 'stuff-cheeks'
  | 'steal-item'
  | 'trick'
  | 'attract'
  | 'aura-wheel'
  | 'baton-pass'
  | 'beat-up'
  | 'steal-berry'
  | 'copycat'
  | 'entrainment'
  | 'fling'
  | 'focus-punch'
  | 'gastro-acid'
  | 'guard-split'
  | 'healing-wish'
  | 'imprison'
  | 'instruct'
  | 'lock-on'
  | 'magnetic-flux'
  | 'magnet-rise'
  | 'power-split'
  | 'power-trick'
  | 'recycle'
  | 'reflect-type'
  | 'revival-blessing'
  | 'role-play'
  | 'round'
  | 'shed-tail'
  | 'shell-side-arm'
  | 'simple-beam'
  | 'skill-swap'
  | 'sleep-talk'
  | 'spit-up'
  | 'stockpile'
  | 'swallow'
  | 'teatime'
  | 'transform'
  | 'worry-seed';

/**
 * Bitmask tracking which optional/historical fields are actually read by moves,
 * abilities, or items present in the battle. Fields whose reader bit is clear
 * are omitted from canonical state keys to prevent spurious state splits.
 */
export const FeatureBit = {
  NONE: 0,
  LAST_MOVE: 1 << 0,
  TIMES_ATTACKED: 1 << 1,
  PROTECT_STALL: 1 << 2,
  ENCORE: 1 << 3,
  DISGUISE: 1 << 4,
  STAMINA: 1 << 5,
  PINCH_ABILITY: 1 << 6,
  ROUGH_SKIN: 1 << 7,
  FOCUS_SASH: 1 << 8,
  SITRUS_BERRY: 1 << 9,
  LIFE_ORB: 1 << 10,
  LEFTOVERS: 1 << 11,
  STEALTH_ROCK: 1 << 12,
  DEFIANT: 1 << 13,
  RECHARGE: 1 << 14,
  PIVOT: 1 << 15,
  SOUNDPROOF: 1 << 16,
  LIGHTNING_ROD: 1 << 17,
  INTIMIDATE: 1 << 18,
  MEGA: 1 << 19,
  SUBSTITUTE: 1 << 20,
  TAUNT: 1 << 21,
  CHOICE_LOCK: 1 << 22,
  FIELD_LAST_MOVE: 1 << 23,
  LAST_MOVE_ID: 1 << 24,
  LAST_MOVE_FAILED: 1 << 25,
  LAST_ITEM: 1 << 26,
  ATE_BERRY: 1 << 27,
  SIDE0_LAST_MOVE_IDX: 1 << 28,
  SIDE1_LAST_MOVE_IDX: 1 << 29,
} as const;

export type BoostStat = 'atk' | 'def' | 'spa' | 'spd' | 'spe' | 'acc' | 'eva';
export type BoostArray = [number, number, number, number, number, number, number];

export interface MoveSecondarySpec {
  chance: number; // 1..100
  status?: StatusId;
  boosts?: Partial<Record<BoostStat, number>>;
  selfBoosts?: Partial<Record<BoostStat, number>>;
  volatileStatus?: 'flinch' | 'confusion';
}

export interface StaticMoveData {
  id: string;
  name: string;
  type: string;
  category: MoveCategory;
  basePower: number;
  accuracy: number | true;
  priority: number;
  pp: number;
  maxpp: number;
  critRatio: number; // 1 = normal (1/24), 2 = high (1/8), etc.
  target: MoveTargetType;
  contact: boolean;
  protectable: boolean;
  sound: boolean;
  slicing: boolean;
  bite: boolean;
  punch: boolean;
  pulse: boolean;
  bullet: boolean;
  powder: boolean;
  reflectable: boolean;
  bypassSub: boolean;
  failEncore: boolean;
  failCopycat?: boolean;
  noSleepTalk?: boolean;
  failInstruct?: boolean;
  volatileStatus?: 'confusion' | 'flinch';
  fixedDamage: 'level' | number | null;
  multihit: [number, number] | number | null;
  selfSwitch: boolean;
  forceSwitch: boolean;
  recharge: boolean;
  selfBoosts: Partial<Record<BoostStat, number>> | null;
  targetBoosts: Partial<Record<BoostStat, number>> | null;
  statusInflict: StatusId | null;
  secondaries: MoveSecondarySpec[];
  recoil: [number, number] | null; // [num, den] of damage dealt
  drain: [number, number] | null;  // [num, den] of damage dealt
  setsWeather?: WeatherId;
  setsTerrain?: TerrainId;
  specialKind: MoveSpecialKind;
  curesBurn: boolean;
  knockOff: boolean;
  suckerPunch: boolean;
  protect: boolean;
  encore: boolean;
  stealthRock: boolean;
}

export interface StaticStats {
  atk: number;
  def: number;
  spa: number;
  spd: number;
  spe: number;
}

export interface StaticMegaFormeData {
  speciesId: string;
  name: string;
  types: readonly string[];
  weightkg: number;
  stats: StaticStats;
  abilityId: string;
  abilitySpec: CompiledAbilitySpec;
}

export type StaticFormeData = StaticMegaFormeData;

export interface TransformedOverlay {
  speciesId: string;
  types: readonly string[];
  weightkg: number;
  stats: StaticStats;
  abilityId: string;
  moves: readonly StaticMoveData[];
  sourceSide: 0 | 1;
  sourceIdx: number;
}

export interface StaticPokemonData {
  speciesId: string;
  name: string;
  level: number;
  gender: 'M' | 'F' | '';
  baseAtk: number;
  baseTypes: readonly string[];
  weightkg: number;
  maxhp: number;
  stats: StaticStats;
  abilityId: string;
  abilitySpec: CompiledAbilitySpec;
  itemId: string;
  itemSpec: CompiledItemSpec;
  itemRemovable: boolean;
  megaForme: StaticMegaFormeData | null;
  altFormes: Readonly<Record<string, StaticFormeData>>;
  moves: readonly StaticMoveData[];
}

export interface StaticSideData {
  id: 'p1' | 'p2';
  name: string;
  team: readonly StaticPokemonData[];
}

export interface StaticBattleContext {
  dex: import('@pkmn/sim').Battle['dex'];
  ruleset: RulesetConfig;
  gameType: GameType;
  activeCount: 1 | 2;
  /** True when battle.trunc uses bit-wrapping Dex.trunc (standard VGC/OU); false for customgame Math.trunc. */
  truncBits: boolean;
  featureMask: number;
  /** Whether side s's SpA boost (boosts[2]) can be observed by any move, item, or ability. */
  trackSpaBoost: readonly [boolean, boolean];
  /** Whether side s's SpD boost (boosts[3]) can be observed by any move, item, or ability. */
  trackSpdBoost: readonly [boolean, boolean];
  sides: readonly [StaticSideData, StaticSideData];
  /** Precomputed type effectiveness exponent: +1 = 2x, -1 = 0.5x, -99 = immune. */
  typeChart: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** Cached CompiledItemSpec by item ID (for dynamic Trick/Thief/Recycle/Fling). */
  itemSpecCache: Map<string, CompiledItemSpec>;
  /** Struggle move spec used when no normal move has PP/is enabled. */
  struggleMove: StaticMoveData;
}

export interface HpEntry {
  hp: number;
  prob: number;
}

/**
 * Sparse sorted HP distribution (ascending hp, prob > 0, sum(prob) === 1).
 * Kept null on PokemonState when HP is deterministic (the common fast path).
 */
export type HpDist = HpEntry[];

export interface FutureMoveSlot {
  turns: number;
  sourceSide: 0 | 1;
  sourceIdx: number;
  moveId: string;
}

export interface PokemonState {
  hp: number;
  hpDist: HpDist | null;
  fainted: boolean;
  pp: number[];
  status: StatusId;
  statusTurns: number;
  boosts: BoostArray;
  itemActive: boolean;
  itemOverride: string | null;     // null => original sp.itemId, '' => none, else item ID
  lastItemId: string;              // last consumed/flung item ID (for Recycle)
  ateBerry: boolean;               // true once a Berry was eaten (for Belch)
  cudchewBerry: string;            // berry ID queued by Cud Chew
  cudchewTurns: number;            // countdown for Cud Chew (2 -> 1 -> trigger at 0)
  abilityActive: boolean;
  abilityOverride: string | null;  // null => base/mega/forme ability, else overridden ability ID
  gastroAcid: boolean;             // ability suppressed by Gastro Acid
  abilityUsed: boolean;
  megaEvolved: boolean;
  formeId: string | null;          // non-null when in alt forme (Palafin-Hero, Eiscue-Noice, Minior-Meteor, Aegislash-Blade, Castform-*, Morpeko-Hangry, Cramorant-*)
  bondTriggered: boolean;          // Battle Bond once-per-battle flag
  illusionActive: boolean;         // Illusion cosmetic disguise active (blocks Transform until damaged)
  transformed: TransformedOverlay | null;
  savedPp: number[] | null;        // original PP saved while transformed
  disguiseBusted: boolean;
  proteanUsed: boolean;
  flashFireActive: boolean;
  unburdenActive: boolean;
  substituteHp: number;
  types: readonly string[] | null; // null => use active (base or mega) types
  protectStreak: number;           // 0 => no stall volatile; k >= 1 => stall counter = min(729, 3^k)
  protecting: boolean;             // transient within a turn
  protectKind: '' | 'protect' | 'spiky' | 'kings' | 'baneful'; // transient within a turn
  enduring: boolean;               // transient within a turn
  roosted: boolean;                // transient within a turn (loses Flying type)
  flinched: boolean;               // transient within a turn
  mustRecharge: boolean;
  confusionTurns: number;          // 0 if not confused; else remaining turns (2..5)
  attractSide: -1 | 0 | 1;         // -1 if not infatuated
  attractSlot: number;             // slot of infatuation source
  magnetRiseTurns: number;         // 0 if none; else 1..5
  lockOnTurns: number;             // 0 if none; else 1..2
  lockOnSide: -1 | 0 | 1;
  lockOnSlot: number;
  stockpileLayers: number;         // 0..3
  stockpileDef: number;            // actual Def boost delta applied by Stockpile
  stockpileSpd: number;            // actual SpD boost delta applied by Stockpile
  powerTrick: boolean;             // Power Trick / Power Shift Atk<->Def swap
  statOverride: Partial<StaticStats> | null; // Power Split / Guard Split stored stat override
  usedMovesMask: number;           // bitmask of move indices used since switch-in (Last Resort)
  imprison: boolean;               // Imprison volatile
  octolockSide: -1 | 0 | 1;        // -1 if not octolocked
  octolockSlot: number;
  uproarTurns: number;             // 0 if not in Uproar; else 1..3
  encoreMoveIdx: number;           // -1 if not encored
  encoreTurns: number;             // remaining turns
  tauntTurns: number;              // 0 if not taunted
  throatChopTurns: number;         // 0 if not throat-chopped
  choiceLockedMoveIdx: number;     // -1 if not choice-locked
  disabledMoveIdx: number;         // -1 if none
  disabledTurns: number;           // 0 if none
  tormented: boolean;
  leechSeedSlot: number;           // -1 if not seeded, else opponent slot
  yawnTurns: number;               // 0 if none; 2 on applied -> 1 at EOT -> triggers sleep at next EOT
  cursed: boolean;                 // Ghost-type Curse volatile
  perishTurns: number;             // 0 if none; 4 -> 3 -> 2 -> 1 -> faints
  trapped: boolean;                // Mean Look / Block / Jaw Lock / No Retreat / Ingrain
  partialTrapTurns: number;        // 0 if none; Wrap / Bind / Fire Spin / etc.
  aquaRing: boolean;
  ingrain: boolean;
  smackedDown: boolean;
  focusEnergy: boolean;            // +2 crit stage
  dragonCheer: number;             // 0, 1, or 2 crit stage
  charged: boolean;                // Charge / Electromorphosis: 2x next Electric move
  glaiveRush: boolean;             // incoming moves 2x & never miss until user's next move
  syrupBombTurns: number;          // -1 Spe at EOT for 3 turns
  destinyBond: boolean;
  noRetreatUsed: boolean;
  timesAttacked: number;           // Rage Fist counter (FeatureBit.TIMES_ATTACKED)
  lastMoveFailed: boolean;         // Stomping Tantrum / Temper Flare
  chargingMoveIdx: number;         // -1 if not charging a two-turn move
  invulnerable: '' | 'fly' | 'dig' | 'dive' | 'shadow';
  lastMoveIdx: number;             // -1 if none, -2 if struggle
  lastMoveId: string;              // ID of last executed move (for Instruct / Copycat)
  activeTurns: number;             // tracks turn-1 Fake Out / First Impression eligibility
  movedThisTurn: boolean;          // transient within a turn
  switchedInThisTurn: boolean;     // transient within a turn
  helpingHandCount: number;        // transient within a turn
  redirectKind: '' | 'followme' | 'ragepowder'; // transient within a turn
  focusPunchReady: boolean;        // transient within a turn (Focus Punch pre-turn focus)
  focusPunchLost: boolean;         // transient within a turn
  beakBlastHeating: boolean;       // transient within a turn (Beak Blast pre-turn burn shield)
  electrified: boolean;            // transient within a turn (Electrify -> Electric type)
  emergencyExitTriggered: boolean; // transient within a turn
  damagedThisTurn: number;         // transient within a turn (Counter / Mirror Coat / Metal Burst / Assurance)
  damagedCategory: '' | 'Physical' | 'Special'; // transient within a turn
  damagedBySide: -1 | 0 | 1;       // transient within a turn
  damagedBySlot: number;           // transient within a turn
  statLoweredThisTurn: boolean;    // transient within a turn (Lash Out)
}

export interface SideState {
  /** Active team indices per active slot (-1 if empty). */
  active: number[];
  megaUsed: boolean;
  stealthRock: boolean;
  spikes: number;
  toxicSpikes: number;
  stickyWeb: boolean;
  tailwindTurns: number;
  reflectTurns: number;
  lightScreenTurns: number;
  auroraVeilTurns: number;
  safeguardTurns: number;
  wishTurns: number[];
  wishHp: number[];
  healingWish: boolean[];
  futureMoves: (FutureMoveSlot | null)[];
  wideGuard: boolean;   // transient within a turn
  quickGuard: boolean;  // transient within a turn
  roundUsedThisTurn: boolean; // transient within a turn (doubles Round 2x BP)
  pokemon: PokemonState[];
}

export interface FieldState {
  weather: WeatherId;
  weatherTurns: number;
  terrain: TerrainId;
  terrainTurns: number;
  trickRoomTurns: number;
  gravityTurns: number;
  magicRoomTurns: number;
  wonderRoomTurns: number;
  fairyLockTurns: number;
  lastMoveId: string; // last move used on field (for Copycat)
}

export interface MoveAction {
  kind: 'move';
  slot: number;
  /** 0..moves.length-1, or -1 for Struggle */
  moveIndex: number;
  /** True when Mega Evolving on this turn (Champions / Mega ruleset). */
  mega?: boolean;
  /** Target side (0 or 1) and active slot (0 or 1); optional for self/spread/singles. */
  targetSide?: 0 | 1;
  targetSlot?: number;
}

export interface SwitchAction {
  kind: 'switch';
  slot: number;
  benchIndex: number;
}

export interface PassAction {
  kind: 'pass';
  slot: number;
}

export type SlotAction = MoveAction | SwitchAction | PassAction;
export type SideAction = SlotAction[];

export interface PendingQueuedAction {
  side: 0 | 1;
  action: MoveAction;
  priority: number;
  speed: number;
  subOrder: number;
}

export interface PendingSwitchSlot {
  side: 0 | 1;
  slot: number;
  /** True when Revival Blessing is selecting a fainted bench Pokemon to revive. */
  revive?: boolean;
  /** True when Baton Pass is transferring boosts and passable volatiles. */
  batonPass?: boolean;
  /** Positive Substitute HP passed by Shed Tail. */
  shedTailHp?: number;
}

export type BattlePhase =
  | {kind: 'turn'}
  | {
      kind: 'switch';
      /** Which sides/slots must pick a replacement (or revival target) before continuing. */
      pendingSlots: PendingSwitchSlot[];
      /** Non-empty when paused mid-turn (e.g., U-turn / Volt Switch); empty for end-of-turn faint switches. */
      remainingActions: PendingQueuedAction[];
      /** True if residual end-of-turn effects still need to run after this switch. */
      needsEndOfTurn: boolean;
    }
  | {kind: 'ended'; winner: 0 | 1 | 2}; // 0=p1, 1=p2, 2=draw

export interface DynamicState {
  field: FieldState;
  sides: [SideState, SideState];
  phase: BattlePhase;
}

export interface WeightedState {
  state: DynamicState;
  probability: number;
}

export type BranchMode = 'compute' | 'certified' | 'pruned';
export type HpOutputMode = 'discrete' | 'distributional';

export interface BranchPolicy {
  mode: BranchMode;
  /** Output HP mode at turn boundary: 'discrete' (exact default) or 'distributional' (PokaiEngine-style). */
  hpOutputMode?: HpOutputMode;
  /** Required in 'compute' mode: returns float in [0, 1). Defaults to Math.random if omitted. */
  rng?: () => number;
  /** Absolute performance.now() deadline for cooperative stopping in 'certified' mode. */
  deadline?: number;
  /** Maximum active branches allowed during a turn step before stopping (certified) or capping (pruned). */
  maxBranches?: number;
  /** Minimum branch probability kept in 'pruned' mode. */
  minBranchProb?: number;
  /** Whether 'pruned' mode renormalizes surviving branches to sum to 1 (default false keeps exact dropped mass in remainingMass). */
  renormalize?: boolean;
}

export interface StepStats {
  forks: number;
  merges: number;
  damageBatchHits: number;
  damageBatchMisses: number;
  hpSplits: number;
  peakBranches: number;
}

export interface StepResult {
  outcomes: WeightedState[];
  /** Probability mass not expanded (certified budget hit) or dropped (pruned without renormalize). Always 0 on complete exact step. */
  remainingMass: number;
  complete: boolean;
  stats: StepStats;
}

export interface EngineSupportReport {
  supported: boolean;
  reasons: string[];
}
