import type {Ability, ModdedAbilityDataTable} from '@pkmn/sim';

// Rule-audit tests intentionally mutate the simulator's readonly runtime records.
export type Mutable<T> = {-readonly [K in keyof T]: T[K]};
export type RuntimeAbility = Ability & ModdedAbilityDataTable[keyof ModdedAbilityDataTable];
