# Implementation Trace: Damage observation boundaries

Date: 2026-09-08
Source: User request for an independent pkmn/sim efficiency branch
Language: English

## Entries

### 1. Distinguish events before and after the observable damage boundary

Type: unresolved-implementation-decision

Context:
The requested transfer-throughput improvement did not prescribe an implementation. Existing saturation guards reject WeatherModifyDamage and DamagingHit callbacks, including ordinary weather and contact retaliation.

Decision:
Preserve the stable native transition-distribution contract while removing these two empty-handler requirements. Require native spreadMoveHit in addition to the existing damage-path method checks. Keep ModifyDamage and Damage callbacks on the existing conservative path.

Reason:
In the pinned Gen 9 implementation, WeatherModifyDamage executes before the randomizer. DamagingHit receives the actual HP loss returned by spreadDamage, after target.damage clamps it to available HP. Neither can distinguish raw rolls belonging to the same proven post-tail saturation class. The callbacks still execute through native code. This is independent of species and works at the transition layer with a reserve team member; no broader action-generation support is claimed.

Follow-up:
Native-distribution tests and standalone performance comparison are pending the root agent's serialized validation slot.

Validation update: Node.js v24.20.0; `npm run typecheck`, `npm run build`, and `node --test dist/test/simulator-optimizations.test.js dist/test/native-distribution.test.js` pass. Full regression and standalone performance measurement remain coordinated by the root agent. Custom move.onDamage raw observers retain their native full-state distribution; custom spreadMoveHit wrappers retain native randomization.

### 2. Recognize one audited constant final-damage modifier

Type: unresolved-implementation-decision

Context:
Life Orb prevents existing post-tail grouping because ModifyDamage is nonempty, even though its pinned callback only chains a constant modifier. Executing arbitrary callbacks speculatively would create new side effects and random draws.

Decision:
Predict only an exactly identified native Life Orb callback when it is the sole ModifyDamage handler, is an Item handler belonging to the attacker, and the relevant native modifier and item-suppression methods retain their identities. Evaluate the native pure ignoringItem predicate and use modifier 1 when suppressed. Keep other callbacks and multiple handlers on the existing raw-damage grouping path.

Reason:
The native callback updates the fresh event modifier from 1 to 5324/4096 without returning a replacement damage. Prediction applies native Battle.modify at the original final-modifier position after STAB, effectiveness, and burn, before bypass-Protect and minimum-damage handling. It preserves the simulator's fixed-point rounding. Actual native callback execution and item recoil remain unchanged. This is a rule-capability audit, independent of any benchmark case or species; it does not generalize to arbitrary modifiers or Disguise.

Follow-up:
Source-only candidate while the root agent benchmarks the previous commit; validation will use full native distributions at low, threshold, and surviving HP, item suppression, an extra Reflect handler, and a custom raw-observing callback.

Validation update: Node.js v24.20.0; typecheck, build, simulator-optimizations and native-distribution tests pass, including the new Life Orb comparisons. Performance measurement and full regression remain coordinated by the root agent.

### 3. Prove inactive Disguise callbacks from their native state predicate

Type: unresolved-implementation-decision

Context:
Disguise callbacks remain registered after its forme change and keep the generic empty-event guard false. The root agent requested investigation of this rule-level no-op condition after the first two independent candidates.

Decision:
Allow only the exactly captured native Disguise Damage and Effectiveness callbacks when the target species is neither mimikyu nor mimikyutotem. Keep intact forms and every other callback on the conservative path. Compute the predicted effectiveness sum directly from native type effectiveness after proving handlers empty or inert, avoiding speculative callback execution.

Reason:
Both pinned callbacks return undefined for every other species before observing raw damage, invoking immunity, or modifying state. The condition follows the simulator's ability rule, including copied Disguise and both busted forms; it is unrelated to benchmark case selection. Actual callbacks still execute natively. The direct type sum also respects existing no-Type-handler, no-move-Effectiveness-handler, no-Tera-Shell, and no-terastallization guards.

Follow-up:
Source-only until the root agent's next validation window. Full native distribution tests cover both intact and busted forms, a copied ability, low and surviving HP, and a custom effectiveness observer.

Validation update: Node.js v24.20.0; typecheck, build, simulator-optimizations and native-distribution tests pass. Full regression and performance remain coordinated by the root agent.

### 4. Group rolls absorbed by the active native Disguise Damage callback

Type: unresolved-implementation-decision

Context:
The root agent requested an intact-Disguise candidate after the inert-callback change. Identical final HP alone is insufficient: earlier callbacks can observe raw damage, and Mold Breaker or transformed-ability suppression can prevent absorption.

Decision:
Admit an absorbing class only for intact active, untransformed Disguise, a Move parent, no ability-ignoring active move, the native cantsuppress flag, and exactly the target's native Disguise Damage/Effectiveness handlers. Keep the existing no-Type/ModifySTAB/raw-observer guards and only the audited final modifier. Require native immunity/item queries and no NegateImmunity handlers so Effectiveness cannot change the absorbing predicate. Return one raw representative roll for the class, never synthetic zero damage.

Reason:
Under these state and method conditions, runEvent invokes the sole Damage handler, which returns zero and sets the same busted flag for every roll. The native path still produces the actual type and critical records, ability state, forme change, self-damage, and later move. Intact Effectiveness callbacks may call native immunity checks, but those are pure under the additional guards. Unsupported suppression or extra raw observers use normal raw-roll grouping.

Follow-up:
Source-only during root benchmarking. Tests cover complete surviving states with a later Shadow Claw, item recoil, reserves, Mold Breaker, Ability Shield, transformed suppression, and a higher-priority raw observer.

Validation update: Node.js v24.20.0; typecheck, build, simulator-optimizations and native-distribution tests pass, including native full-state distribution comparisons for later moves and multi-hit Disguise breakage. The first test run exposed a fixture assertion error: a critical later Shadow Claw can KO Mew. Adding a reserve on each side preserves full observable state for those outcomes. Full regression and performance remain coordinated by the root agent.

### 5. Capture both Dex query identities used by damage prediction

Type: unresolved-implementation-decision

Context:
Independent review found that the new immunity guard compared against a mutable prototype property. The same comparison guarded getEffectiveness, now called directly by the prediction path. The requested immunity fix left whether to include that adjacent query to implementation judgment.

Decision:
Capture getImmunity and getEffectiveness at module initialization and compare resolved methods against those saved identities. Verify fallback using ordinary simulator state changes, without reading private PRNG decisions.

Reason:
Both new differentials fail against e504633: an immunity override removes Disguise during Effectiveness after the random roll, yielding 12 native HP outcomes versus one optimized outcome; an effectiveness override increments the active move's basePower, revealing two extra speculative queries in the optimized snapshot. Captured identities disable the corresponding damage-tail proof while retaining the native custom behavior. This confirms custom-prototype fallback failures, not a stock Champions error.

Follow-up:
Run typecheck, build, and focused native-distribution tests; full regression remains coordinated by the root agent.

Validation update: Node.js v24.20.0; typecheck, build, simulator-optimizations and native-distribution tests pass. Both new native full-state differentials passed after failing on the uncorrected guards.
