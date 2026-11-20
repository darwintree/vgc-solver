export * from './types';
export {
  CHAMPIONS_RULESET,
  GEN9_RULESET,
  createChampionsModBattle,
  detectRulesetFromBattle,
  getChampionsDex,
  registerChampionsFormats,
  type RulesetConfig,
  type RulesetId,
} from './ruleset';
export {compileItemSpec, type CompiledItemSpec, type ItemArchetype} from './effects/items';
export {compileAbilitySpec, isAbilitySupported, type CompiledAbilitySpec} from './effects/abilities';
export {compileMoveSpec, isMoveSupported} from './effects/moves';
export {auditChampionsCoverage, type ChampionsCoverageReport, type CoverageSection} from './coverage';
export {canRunInEngine, compileContextFromBattle} from './context';
export {
  activeAbilitySpec,
  activeItemId,
  activeItemSpec,
  activeMoves,
  activeSpeciesId,
  activeStats,
  activeTypes,
  activeWeightHg,
  canSlotMegaEvolve,
  canonicalStateKey,
  cloneState,
  expandStateHpDists,
  getItemSpec,
  isGrounded,
  isItemEffectActive,
  legalSideActions,
  legalSlotActions,
  parseShowdownCommand,
  stateFromBattle,
  terminalUtilityFromState,
} from './state';
export {
  DamageBatchCache,
  computeDamageRolls,
  effectiveFieldWeather,
  effectiveSpeed,
  pokeRound,
  rawEffectiveSpeed,
  resolveMoveType,
  trunc,
  typeEffectiveness,
} from './damage';
export {stepBattle} from './turn';
export {compareTurnWithShowdown, type ParityReport} from './parity';
export {
  createEngineBoundedAdapter,
  createMonotoneAnalyzer,
  createMonotoneSignature,
  type EngineActionEntry,
  type EngineAdapterOptions,
  type MonotoneAnalyzer,
} from './adapter';
