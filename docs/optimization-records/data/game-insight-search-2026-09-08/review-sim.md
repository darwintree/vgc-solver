# Independent simulator review

Scope: `74cfe20..e504633`, `/tmp/pokemon-pkmn-sim-efficiency`. Read-only inspection; no builds, tests, or performance runs were executed during this review.

## Finding

### P2 — Capture the audited immunity implementation instead of comparing against the mutable prototype

Location: `src/simulator-optimizations.ts:233` (new Disguise absorption guard; reference methods captured at lines 23–55).

`battle.dex.getImmunity !== Dex.ModdedDex.prototype.getImmunity` does not reject replacement of `Dex.ModdedDex.prototype.getImmunity`: an ordinary Dex instance inherits that same replacement. This is materially different from the neighboring frozen `runImmunity`, `typesGet`, and `typesIsName` checks. Intact Disguise can therefore enter the all-rolls-one-class path even though the native Disguise Effectiveness callback subsequently calls an unaudited custom immunity method after the damage randomizer.

Concrete counterexample construction (static, not executed): after importing the optimizer, replace `Dex.ModdedDex.prototype.getImmunity` with a wrapper around its original function. When its target is a Pokémon and `target.battle.event.id === 'Effectiveness'`, record the currently selected damage roll from the replay PRNG into `target.abilityState.observedRoll`; otherwise behave natively. Attack an intact Mimikyu with a high-base-damage physical move so the unoptimized raw randomizer has distinct damage values for all rolls, retaining a reserve Pokémon so the resulting state is observable. Both native Disguise callbacks remain unchanged, and the new prototype comparison still passes. Native enumeration retains distinct recorded states; the absorber collapses all rolls before the custom immunity observer. Even though HP damage is always zero, the complete state distribution is different.

The conservative fix is to capture `Dex.ModdedDex.prototype.getImmunity` alongside the other import-time audited references and compare with that saved identity. A regression should replace the prototype after module import and require native fallback/full distribution equality. Existing older `getEffectiveness`/Pokemon prototype comparisons elsewhere also use mutable prototypes; those broader inherited audit gaps are outside this diff's newly introduced immunity check.

Confidence: high for the audit bypass by source inspection; the concrete distribution counterexample still requires execution. This does not establish a defect for the unmodified stock Champions inputs.

## Other reviewed boundaries

- Life Orb's pinned callback only chains `5324/4096`; its return value is undefined, and `runEvent` starts a fresh modifier of 1. The proposed fixed modifier and native final rounding order match the inspected pinned implementation. Item suppression uses the native `ignoringItem` path; active/Klutz/Magic Room/Reflect and custom ModifyDamage callback tests cover the main branches.
- Busted/non-Mimikyu Disguise's pinned Damage and Effectiveness callbacks return before observing the raw damage or immunity. Callback identity is checked, and unknown additional handlers prevent grouping.
- Intact Disguise grouping requires sole native Damage/Effectiveness handlers belonging to the target's ability, intact species, active/untransformed target, cantsuppress, no ability-ignoring active move, no substitute, and no NegateImmunity handlers. Mold Breaker, transformation, Ability Shield, raw move Damage observers, and later multi-hit behavior have dedicated complete-state distribution tests in the diff.
- Parent-move Damage callbacks are explicitly rejected before absorption; Damage runEvent occurs before HP saturation, while DamagingHit receives actual HP loss after saturation. Native callbacks, Disguise form change/self-damage, recoil, and later actions still run.

No other concrete newly introduced defect was identified by static inspection. This is not a proof that every custom method/table/getter mutation is covered; broad custom-query auditing and all runtime tests remain outside this read-only review.
