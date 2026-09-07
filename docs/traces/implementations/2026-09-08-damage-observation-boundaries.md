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
