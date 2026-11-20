# Independent review: terminal envelope 39a1621

Read-only source review; no builds, tests, or performance commands were run.

## P1 — Callback admission loses the callback's event slot

`src/terminal-envelope.ts:22–25` admits an approved native callback at **any** `on*` property. The monotonicity argument depends on the original event and argument positions, however. `src/native-rules.ts:329` deliberately accepts relocated native callback identities, so the broad native audit does not close this gap. The attacker-healing guard at `src/terminal-envelope.ts:160–167` only recognizes the Sitrus `onUpdate` callback.

Concrete counterexample to validate: before creating the solver, assign the captured native `Sitrus Berry.onEat` function to `Focus Sash.onAfterMoveSecondarySelf`. Use a fast level-100 Garchomp at 1 HP with Focus Sash and Water Gun, against a healthy bulky level-100 Blissey using Mud-Slap (admitted/no-hook ability). Water Gun cannot KO Blissey; Mud-Slap's minimum damage exceeds initial 1 HP, so the envelope claims certain P2 victory. In the actual native phase order, `battle-actions.js:502–503` invokes AfterMoveSecondarySelf after Water Gun and the borrowed Sitrus callback heals Garchomp by one quarter of base max HP. It then survives Mud-Slap. The original `onUpdate` is absent, so the healing exclusion does not fire. This violates the one-turn interval enclosure; the bounded solver can keep the erroneous certainty without expanding the cell.

Recommended correction: admit `(event-property, callback-identity)` pairs, including exact prefixes, rather than callback identity alone, and add this relocated-native-callback oracle test. This is a static counterexample, not an executed reproduction.

## P2 proof gap — Effective third types bypass the stated overflow bound

`src/terminal-envelope.ts:78` checks `pokemon.types.length <= 2`, while native `Pokemon.getTypes()` appends `addedType` and `Pokemon.addType()` does not require a volatile. The maximum effectiveness factor assumed at `src/terminal-envelope.ts:90–92` can therefore be 8 rather than 4. The module admits Gen 9 singles broadly, including formats with native 16-bit truncation. Numeric rule/state changes also survive the callback-only native audit. With a sufficiently large permitted response and a first-move defensive drop, the unproved overflow region can invalidate monotonic damage after the drop.

This is not a reproduced Champions defect: the current Gen 9 Custom Game format installs Math.trunc. Reject nonempty addedType / more than two effective types, calculate a sound effectiveness maximum, or explicitly restrict the supported truncation/format contract. I did not execute a complete overflow counterexample.

## Other inspected limits

No additional concrete defect found in ordinary stock callback placement: first-hit maximum with Stamina/Sitrus on the responder, response minimum after allowed first selfBoost defense drops, first-move miss handling, response accuracy mass, crit/noncrit range coverage, deterministic speed/priority order, immunity fallback, or retaining null outcomes and exact=false. Native audit occurs once at factory creation; safety against externally mutating the Dex/methods between factory creation and invocation is not rechecked, but the internal synchronous solve path provides no normal external interleaving. Full regression and adversarial executions remain outstanding.
