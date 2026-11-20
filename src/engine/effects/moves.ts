import type {Battle} from '@pkmn/sim';
import {toID} from '@pkmn/sim';
import {
  FeatureBit,
  type BoostStat,
  type MoveCategory,
  type MoveSecondarySpec,
  type MoveSpecialKind,
  type MoveTargetType,
  type StaticMoveData,
  type StatusId,
  type TerrainId,
  type WeatherId,
} from '../types';

const BOOST_KEYS: readonly BoostStat[] = ['atk', 'def', 'spa', 'spd', 'spe', 'acc', 'eva'];
const SUPPORTED_STATUSES = new Set<string>(['par', 'brn', 'psn', 'tox', 'slp', 'frz']);

/**
 * Callback & special-rule moves explicitly implemented in the engine's modular move handlers.
 * All 328+ pure-data moves (no custom JS callbacks on Dex.moves) are admitted
 * AUTOMATICALLY without needing to appear in this table!
 */
const SPECIAL_MOVE_KINDS: Record<string, {kind: MoveSpecialKind; featureBits?: number}> = {
  // Core standard & Champions fixtures
  struggle: {kind: 'struggle'},
  protect: {kind: 'protect', featureBits: FeatureBit.PROTECT_STALL},
  detect: {kind: 'protect', featureBits: FeatureBit.PROTECT_STALL},
  spikyshield: {kind: 'spiky-shield', featureBits: FeatureBit.PROTECT_STALL},
  kingsshield: {kind: 'kings-shield', featureBits: FeatureBit.PROTECT_STALL},
  banefulbunker: {kind: 'baneful-bunker', featureBits: FeatureBit.PROTECT_STALL},
  wideguard: {kind: 'wide-guard'},
  quickguard: {kind: 'quick-guard'},
  endure: {kind: 'endure', featureBits: FeatureBit.PROTECT_STALL},
  suckerpunch: {kind: 'sucker-punch'},
  upperhand: {kind: 'upper-hand'},
  fakeout: {kind: 'fake-out'},
  firstimpression: {kind: 'fake-out'},
  knockoff: {kind: 'knock-off'},
  encore: {kind: 'encore', featureBits: FeatureBit.ENCORE | FeatureBit.LAST_MOVE},
  taunt: {kind: 'taunt', featureBits: FeatureBit.TAUNT},
  substitute: {kind: 'substitute', featureBits: FeatureBit.SUBSTITUTE},
  throatchop: {kind: 'throat-chop'},
  sparklingaria: {kind: 'cures-burn'},

  // Healing & party utility moves
  recover: {kind: 'heal-half'},
  softboiled: {kind: 'heal-half'},
  slackoff: {kind: 'heal-half'},
  milkdrink: {kind: 'heal-half'},
  healorder: {kind: 'heal-half'},
  roost: {kind: 'roost'},
  moonlight: {kind: 'heal-weather'},
  synthesis: {kind: 'heal-weather'},
  morningsun: {kind: 'heal-weather'},
  shoreup: {kind: 'heal-weather'},
  rest: {kind: 'rest'},
  wish: {kind: 'wish'},
  healpulse: {kind: 'heal-pulse'},
  pollenpuff: {kind: 'pollen-puff'},
  healbell: {kind: 'heal-bell'},
  strengthsap: {kind: 'strength-sap'},
  painsplit: {kind: 'pain-split'},

  // Variable power & special formula moves
  facade: {kind: 'facade'},
  hex: {kind: 'hex'},
  infernalparade: {kind: 'hex'},
  venoshock: {kind: 'venoshock'},
  barbbarrage: {kind: 'venoshock'},
  acrobatics: {kind: 'acrobatics'},
  bodypress: {kind: 'body-press'},
  foulplay: {kind: 'foul-play'},
  psyshock: {kind: 'psyshock'},
  psystrike: {kind: 'psyshock'},
  secretsword: {kind: 'psyshock'},
  eruption: {kind: 'hp-scaled-bp'},
  waterspout: {kind: 'hp-scaled-bp'},
  dragonenergy: {kind: 'hp-scaled-bp'},
  storedpower: {kind: 'stored-power'},
  powertrip: {kind: 'stored-power'},
  brine: {kind: 'brine'},
  weatherball: {kind: 'weather-ball'},
  terrainpulse: {kind: 'terrain-pulse'},
  expandingforce: {kind: 'expanding-force'},
  risingvoltage: {kind: 'rising-voltage'},
  lowkick: {kind: 'weight-target'},
  grassknot: {kind: 'weight-target'},
  heavyslam: {kind: 'weight-ratio'},
  heatcrash: {kind: 'weight-ratio'},
  gyroball: {kind: 'gyro-ball'},
  electroball: {kind: 'electro-ball'},
  flail: {kind: 'flail'},
  reversal: {kind: 'flail'},
  hardpress: {kind: 'hard-press'},
  lastrespects: {kind: 'last-respects'},
  ragefist: {kind: 'rage-fist', featureBits: FeatureBit.TIMES_ATTACKED},
  payback: {kind: 'payback'},
  avalanche: {kind: 'avalanche'},
  assurance: {kind: 'assurance'},
  lashout: {kind: 'lash-out'},
  stompingtantrum: {kind: 'stomping-tantrum', featureBits: FeatureBit.LAST_MOVE},
  temperflare: {kind: 'stomping-tantrum', featureBits: FeatureBit.LAST_MOVE},
  tripleaxel: {kind: 'triple-axel'},
  watershuriken: {kind: 'standard'},
  ficklebeam: {kind: 'fickle-beam'},
  gravapple: {kind: 'grav-apple'},
  freezedry: {kind: 'freeze-dry'},
  flyingpress: {kind: 'flying-press'},
  thunder: {kind: 'weather-acc-rain'},
  hurricane: {kind: 'weather-acc-rain'},
  blizzard: {kind: 'weather-acc-snow'},
  grassyglide: {kind: 'grassy-glide'},
  highjumpkick: {kind: 'crash-recoil'},
  axekick: {kind: 'crash-recoil'},
  supercellslam: {kind: 'crash-recoil'},
  steelbeam: {kind: 'steel-beam'},
  fissure: {kind: 'ohko'},
  guillotine: {kind: 'ohko'},
  horndrill: {kind: 'ohko'},
  sheercold: {kind: 'ohko'},
  counter: {kind: 'counter'},
  mirrorcoat: {kind: 'mirror-coat'},
  metalburst: {kind: 'metal-burst'},
  comeuppance: {kind: 'metal-burst'},
  superfang: {kind: 'half-hp'},
  ruination: {kind: 'half-hp'},
  endeavor: {kind: 'endeavor'},
  finalgambit: {kind: 'final-gambit'},
  explosion: {kind: 'self-ko'},
  selfdestruct: {kind: 'self-ko'},
  mistyexplosion: {kind: 'self-ko'},
  brickbreak: {kind: 'screen-break'},
  psychicfangs: {kind: 'screen-break'},
  ragingbull: {kind: 'raging-bull'},
  feint: {kind: 'feint'},
  clearsmog: {kind: 'clear-smog'},
  haze: {kind: 'haze'},
  curse: {kind: 'curse'},
  bellydrum: {kind: 'belly-drum'},
  clangoroussoul: {kind: 'clangorous-soul'},
  noretreat: {kind: 'no-retreat'},
  burnup: {kind: 'burn-up'},
  doubleshock: {kind: 'double-shock'},
  glaiverush: {kind: 'glaive-rush'},
  syrupbomb: {kind: 'syrup-bomb'},
  fellstinger: {kind: 'fell-stinger'},
  ceaselessedge: {kind: 'ceaseless-edge', featureBits: FeatureBit.STEALTH_ROCK},
  stoneaxe: {kind: 'stone-axe', featureBits: FeatureBit.STEALTH_ROCK},
  icespinner: {kind: 'ice-spinner'},
  steelroller: {kind: 'steel-roller'},
  poltergeist: {kind: 'poltergeist'},

  // Volatiles, trapping, status & disruption
  disable: {kind: 'disable', featureBits: FeatureBit.LAST_MOVE},
  torment: {kind: 'torment', featureBits: FeatureBit.LAST_MOVE},
  perishsong: {kind: 'perish-song'},
  destinybond: {kind: 'destiny-bond'},
  courtchange: {kind: 'court-change'},
  corrosivegas: {kind: 'corrosive-gas'},
  soak: {kind: 'soak'},
  magicpowder: {kind: 'magic-powder'},
  trickortreat: {kind: 'trick-or-treat'},
  forestscurse: {kind: 'forests-curse'},
  topsyturvy: {kind: 'topsy-turvy'},
  psychup: {kind: 'psych-up'},
  powerswap: {kind: 'power-swap'},
  guardswap: {kind: 'guard-swap'},
  speedswap: {kind: 'speed-swap'},
  acupressure: {kind: 'acupressure'},
  spite: {kind: 'spite', featureBits: FeatureBit.LAST_MOVE},
  meanlook: {kind: 'trap-target'},
  block: {kind: 'trap-target'},
  jawlock: {kind: 'trap-target'},
  wrap: {kind: 'partial-trap'},
  bind: {kind: 'partial-trap'},
  firespin: {kind: 'partial-trap'},
  whirlpool: {kind: 'partial-trap'},
  sandtomb: {kind: 'partial-trap'},
  infestation: {kind: 'partial-trap'},
  snaptrap: {kind: 'partial-trap'},
  focusenergy: {kind: 'focus-energy'},
  dragoncheer: {kind: 'dragon-cheer'},
  charge: {kind: 'charge'},
  aquaring: {kind: 'aqua-ring'},
  ingrain: {kind: 'ingrain'},
  smackdown: {kind: 'smack-down'},
  minimize: {kind: 'standard'},
  leechseed: {kind: 'leech-seed'},
  yawn: {kind: 'yawn'},
  snore: {kind: 'snore'},

  // Two-turn charge moves (including Sun/Rain/Power Herb instant cast!)
  solarbeam: {kind: 'solar-beam'},
  solarblade: {kind: 'solar-beam'},
  meteorbeam: {kind: 'meteor-beam'},
  electroshot: {kind: 'electro-shot'},
  fly: {kind: 'two-turn-invuln'},
  bounce: {kind: 'two-turn-invuln'},
  dig: {kind: 'two-turn-invuln'},
  dive: {kind: 'two-turn-invuln'},
  phantomforce: {kind: 'two-turn-invuln'},
  skyattack: {kind: 'sky-attack'},
  futuresight: {kind: 'future-sight'},

  // Hazards, Screens, Weather, Terrain, Rooms, Field, Forced Switch, Pivot, Doubles Support
  stealthrock: {kind: 'stealth-rock', featureBits: FeatureBit.STEALTH_ROCK},
  spikes: {kind: 'spikes', featureBits: FeatureBit.STEALTH_ROCK},
  toxicspikes: {kind: 'toxic-spikes', featureBits: FeatureBit.STEALTH_ROCK},
  stickyweb: {kind: 'sticky-web', featureBits: FeatureBit.STEALTH_ROCK},
  rapidspin: {kind: 'hazard-clear-self'},
  mortalspin: {kind: 'hazard-clear-self'},
  defog: {kind: 'defog'},
  tidyup: {kind: 'tidy-up'},
  reflect: {kind: 'reflect'},
  lightscreen: {kind: 'light-screen'},
  auroraveil: {kind: 'aurora-veil'},
  safeguard: {kind: 'safeguard'},
  tailwind: {kind: 'tailwind'},
  trickroom: {kind: 'trick-room'},
  gravity: {kind: 'gravity'},
  fairylock: {kind: 'fairy-lock'},
  magicroom: {kind: 'magic-room'},
  wonderroom: {kind: 'wonder-room'},
  sunnyday: {kind: 'set-weather'},
  raindance: {kind: 'set-weather'},
  sandstorm: {kind: 'set-weather'},
  snowscape: {kind: 'set-weather'},
  electricterrain: {kind: 'set-terrain'},
  grassyterrain: {kind: 'set-terrain'},
  mistyterrain: {kind: 'set-terrain'},
  psychicterrain: {kind: 'set-terrain'},
  roar: {kind: 'force-switch'},
  whirlwind: {kind: 'force-switch'},
  dragontail: {kind: 'force-switch'},
  circlethrow: {kind: 'force-switch'},
  uturn: {kind: 'standard', featureBits: FeatureBit.PIVOT},
  voltswitch: {kind: 'standard', featureBits: FeatureBit.PIVOT},
  flipturn: {kind: 'standard', featureBits: FeatureBit.PIVOT},
  partingshot: {kind: 'parting-shot', featureBits: FeatureBit.PIVOT},
  chillyreception: {kind: 'chilly-reception', featureBits: FeatureBit.PIVOT},
  helpinghand: {kind: 'helping-hand'},
  followme: {kind: 'redirect'},
  ragepowder: {kind: 'redirect'},
  allyswitch: {kind: 'ally-switch'},
  afteryou: {kind: 'after-you'},
  quash: {kind: 'quash'},

  // Pure-data / explicitly listed standard moves
  scaleshot: {kind: 'standard'},
  hyperbeam: {kind: 'standard', featureBits: FeatureBit.RECHARGE},
  gigaimpact: {kind: 'standard', featureBits: FeatureBit.RECHARGE},
  technoblast: {kind: 'standard'},
  flareblitz: {kind: 'standard'},
  bravebird: {kind: 'standard'},
  doubleedge: {kind: 'standard'},
  woodhammer: {kind: 'standard'},
  wildcharge: {kind: 'standard'},
  wavecrash: {kind: 'standard'},
  headsmash: {kind: 'standard'},
  drainpunch: {kind: 'standard'},
  gigadrain: {kind: 'standard'},
  hornleech: {kind: 'standard'},
  bitterblade: {kind: 'standard'},
  matchagotcha: {kind: 'standard'},
  scald: {kind: 'standard'},
  willowisp: {kind: 'standard'},
  thunderwave: {kind: 'standard'},
  toxic: {kind: 'standard'},
  spore: {kind: 'standard'},
  sleeppowder: {kind: 'standard'},
  hypnosis: {kind: 'standard'},
  glare: {kind: 'standard'},
  stunspore: {kind: 'standard'},
  nuzzle: {kind: 'standard'},
  swordsdance: {kind: 'standard'},
  dragondance: {kind: 'standard'},
  nastyplot: {kind: 'standard'},
  calmmind: {kind: 'standard'},
  bulkup: {kind: 'standard'},
  irondefense: {kind: 'standard'},
  coil: {kind: 'standard'},
  quiverdance: {kind: 'standard'},
  shellsmash: {kind: 'standard'},
  agility: {kind: 'standard'},
  rockpolish: {kind: 'standard'},
  growth: {kind: 'standard'},
  workup: {kind: 'standard'},
  amnesia: {kind: 'standard'},
  acidarmor: {kind: 'standard'},
  barrier: {kind: 'standard'},
  cosmicpower: {kind: 'standard'},
  closecombat: {kind: 'standard'},
  dracometeor: {kind: 'standard'},
  overheat: {kind: 'standard'},
  leafstorm: {kind: 'standard'},
  makeitrain: {kind: 'standard'},
  superpower: {kind: 'standard'},
  headlongrush: {kind: 'standard'},
  armorcannon: {kind: 'standard'},
  psychoboost: {kind: 'standard'},
  fleurcannon: {kind: 'standard'},
  vcreate: {kind: 'standard'},
  seismictoss: {kind: 'standard'},
  nightshade: {kind: 'standard'},
  triattack: {kind: 'tri-attack'},
  saltcure: {kind: 'standard'},
};

function extractBoosts(raw: any): Partial<Record<BoostStat, number>> | null {
  if (!raw || typeof raw !== 'object') return null;
  const out: Partial<Record<BoostStat, number>> = {};
  let any = false;
  for (const key of BOOST_KEYS) {
    const v = raw[key];
    if (typeof v === 'number' && v !== 0) {
      out[key] = v;
      any = true;
    }
  }
  return any ? out : null;
}

function mapTargetType(raw: string): MoveTargetType {
  switch (raw) {
    case 'normal':
    case 'self':
    case 'allAdjacentFoes':
    case 'allAdjacent':
    case 'foeSide':
    case 'allySide':
    case 'adjacentAllyOrSelf':
    case 'randomNormal':
    case 'any':
      return raw;
    case 'adjacentAlly':
      return 'adjacentAllyOrSelf';
    case 'all':
      return 'self';
    default:
      return 'normal';
  }
}

function mapWeather(raw: string | undefined): WeatherId | undefined {
  switch (toID(raw || '')) {
    case 'sunnyday': return 'sun';
    case 'raindance': return 'rain';
    case 'sandstorm': return 'sand';
    case 'snowscape':
    case 'snow':
    case 'hail': return 'snow';
    default: return undefined;
  }
}

function mapTerrain(raw: string | undefined): TerrainId | undefined {
  switch (toID(raw || '')) {
    case 'electricterrain': return 'electric';
    case 'grassyterrain': return 'grassy';
    case 'mistyterrain': return 'misty';
    case 'psychicterrain': return 'psychic';
    default: return undefined;
  }
}

/**
 * Determine whether a Dex move is supported:
 * 1) Registered in SPECIAL_MOVE_KINDS, OR
 * 2) Pure data-driven move (no custom JS callbacks, no unsupported volatile/condition/OHKO/two-turn).
 */
export function isMoveSupported(dex: Battle['dex'], moveIdRaw: string): {supported: boolean; reason?: string} {
  const id = toID(moveIdRaw);
  if (Object.prototype.hasOwnProperty.call(SPECIAL_MOVE_KINDS, id)) {
    return {supported: true};
  }
  const raw: any = dex.moves.get(id);
  if (!raw || !raw.exists) return {supported: false, reason: `Unknown move: ${moveIdRaw}`};

  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'function') {
      return {supported: false, reason: `Move ${raw.name} has custom callback ${k}`};
    }
  }
  if (raw.ohko) return {supported: false, reason: `OHKO move not yet supported: ${raw.name}`};
  if (raw.flags?.charge) return {supported: false, reason: `Two-turn charge move not yet supported: ${raw.name}`};
  if (raw.volatileStatus && raw.volatileStatus !== 'flinch' && raw.volatileStatus !== 'confusion') {
    return {supported: false, reason: `Move ${raw.name} uses unsupported volatileStatus ${raw.volatileStatus}`};
  }
  if (raw.sideCondition && !['stealthrock', 'spikes', 'toxicspikes', 'stickyweb', 'tailwind', 'reflect', 'lightscreen', 'auroraveil', 'safeguard'].includes(raw.sideCondition)) {
    return {supported: false, reason: `Move ${raw.name} uses unsupported sideCondition ${raw.sideCondition}`};
  }
  if (raw.pseudoWeather && !['trickroom', 'gravity', 'fairylock', 'magicroom', 'wonderroom'].includes(raw.pseudoWeather)) {
    return {supported: false, reason: `Move ${raw.name} uses unsupported pseudoWeather ${raw.pseudoWeather}`};
  }
  if (raw.status && !SUPPORTED_STATUSES.has(raw.status)) {
    return {supported: false, reason: `Move ${raw.name} inflicts unsupported status ${raw.status}`};
  }
  if (raw.slotCondition) {
    return {supported: false, reason: `Move ${raw.name} uses slotCondition ${raw.slotCondition}`};
  }
  if (raw.condition && typeof raw.condition === 'object' && Object.values(raw.condition).some(v => typeof v === 'function')) {
    return {supported: false, reason: `Move ${raw.name} has custom condition callbacks`};
  }
  return {supported: true};
}

export function compileMoveSpec(
  dex: Battle['dex'],
  moveIdRaw: string,
  overrideMaxPP?: number
): {move: StaticMoveData; featureBits: number} {
  const id = toID(moveIdRaw);
  const raw: any = dex.moves.get(id);
  const flags = raw.flags || {};
  const specialEntry = SPECIAL_MOVE_KINDS[id];
  const specialKind: MoveSpecialKind = specialEntry?.kind ?? 'standard';
  let featureBits = specialEntry?.featureBits ?? FeatureBit.NONE;

  const secondaries: MoveSecondarySpec[] = [];
  const rawSecondaries: any[] = Array.isArray(raw.secondaries)
    ? raw.secondaries
    : raw.secondary
      ? [raw.secondary]
      : [];
  for (const sec of rawSecondaries) {
    if (!sec || typeof sec !== 'object') continue;
    const chance = typeof sec.chance === 'number' ? sec.chance : 100;
    const spec: MoveSecondarySpec = {chance};
    if (typeof sec.status === 'string' && SUPPORTED_STATUSES.has(sec.status)) {
      spec.status = sec.status as StatusId;
    }
    const boosts = extractBoosts(sec.boosts);
    if (boosts) spec.boosts = boosts;
    const selfBoosts = extractBoosts(sec.self?.boosts);
    if (selfBoosts) spec.selfBoosts = selfBoosts;
    if (sec.volatileStatus === 'flinch') spec.volatileStatus = 'flinch';
    if (spec.status || spec.boosts || spec.selfBoosts || spec.volatileStatus) {
      secondaries.push(spec);
    }
  }

  let fixedDamage: 'level' | number | null = null;
  if (raw.damage === 'level') fixedDamage = 'level';
  else if (typeof raw.damage === 'number') fixedDamage = raw.damage;

  let multihit: [number, number] | number | null = null;
  if (Array.isArray(raw.multihit) && raw.multihit.length === 2) {
    multihit = [raw.multihit[0], raw.multihit[1]];
  } else if (typeof raw.multihit === 'number') {
    multihit = raw.multihit;
  }

  const selfBoosts =
    raw.target === 'self'
      ? extractBoosts(raw.boosts) ?? extractBoosts(raw.self?.boosts)
      : extractBoosts(raw.self?.boosts) ?? extractBoosts(raw.selfBoost?.boosts);
  const targetBoosts = raw.target !== 'self' && raw.category === 'Status'
    ? extractBoosts(raw.boosts)
    : null;

  const statusInflict: StatusId | null =
    raw.category === 'Status' && typeof raw.status === 'string' && SUPPORTED_STATUSES.has(raw.status)
      ? (raw.status as StatusId)
      : null;

  const recoil: [number, number] | null =
    Array.isArray(raw.recoil) && raw.recoil.length === 2
      ? [raw.recoil[0], raw.recoil[1]]
      : null;
  const drain: [number, number] | null =
    Array.isArray(raw.drain) && raw.drain.length === 2
      ? [raw.drain[0], raw.drain[1]]
      : null;

  if (flags.recharge) featureBits |= FeatureBit.RECHARGE;
  if (raw.selfSwitch) featureBits |= FeatureBit.PIVOT;

  const maxpp = overrideMaxPP ?? (raw.noPPBoosts ? raw.pp : Math.floor(raw.pp * 8 / 5));

  const move: StaticMoveData = {
    id,
    name: raw.name || id,
    type: raw.type || 'Normal',
    category: raw.category as MoveCategory,
    basePower: raw.basePower || 0,
    accuracy: raw.accuracy === true ? true : (raw.accuracy ?? 100),
    priority: raw.priority || 0,
    pp: raw.pp || 1,
    maxpp,
    critRatio: raw.critRatio ?? 1,
    target: mapTargetType(raw.target),
    contact: !!flags.contact,
    protectable: !!flags.protect,
    sound: !!flags.sound,
    slicing: !!flags.slicing,
    bite: !!flags.bite,
    punch: !!flags.punch,
    pulse: !!flags.pulse,
    bullet: !!flags.bullet,
    powder: !!flags.powder,
    reflectable: !!flags.reflectable,
    bypassSub: !!flags.bypasssub || !!flags.sound,
    failEncore: !!flags.failencore || id === 'struggle',
    fixedDamage,
    multihit,
    selfSwitch: !!raw.selfSwitch,
    forceSwitch: !!raw.forceSwitch,
    recharge: !!flags.recharge,
    selfBoosts,
    targetBoosts,
    statusInflict,
    secondaries,
    recoil,
    drain,
    setsWeather: mapWeather(raw.weather),
    setsTerrain: mapTerrain(raw.terrain),
    specialKind,
    curesBurn: specialKind === 'cures-burn',
    knockOff: specialKind === 'knock-off',
    suckerPunch: specialKind === 'sucker-punch',
    protect: specialKind === 'protect' || specialKind === 'spiky-shield' || specialKind === 'kings-shield' || specialKind === 'baneful-bunker',
    encore: specialKind === 'encore',
    stealthRock: specialKind === 'stealth-rock',
  };

  return {move, featureBits};
}
