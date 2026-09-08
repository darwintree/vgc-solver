# Snapshot throughput source review

Scope: `/tmp/pokemon-snapshot-throughput/src/showdown-adapter.ts` versus commit `682e043`, inspected using explicit work-tree diffs and `git show` after discovering shared git core.worktree configuration. Read-only review; no tests, build, simulator calls, or benchmarks were run for this review. Existing snapshot semantics are preserved contracts; the candidate implementation is unadopted.

## P2: Direct format metadata retains an omitted own property

At current `src/showdown-adapter.ts:160`, `state.formatid = normalizeJSON(state.formatid)` normalizes values but does not reproduce object-property omission. Native `State.serializeBattle` directly assigns `battle.format.id`. With `battle.format.id = undefined` (or a function), baseline `normalizeJSON(state)` skips that original property, whereas the candidate returns an own `formatid: undefined` property. This affects snapshot structural equality/detachment contract, not stock Champions play. Existing test `direct format metadata retains JSON normalization and detachment` covers NaN, -0, and an object, but not omission.

The minimal response must test the original value for undefined/function before assignment. Deleting every normalized-undefined value would also change baseline behavior: directly assigned Symbol/BigInt metadata normalizes to an own undefined property in the baseline helper. Root and implementation agent were notified; candidate was frozen for measurement before this follow-up fix.

The earlier direct-format NaN/-0/object normalization gap is corrected in inspected source by the normalization call; object detachment also follows the baseline helper.

## Retracted claim

| Comment | Target | Comment Claims | Response Claims | Decision | Evidence |
| --- | --- | --- | --- | --- | --- |
| “normalizeJSON on directly assigned choice.switchIns isn't JSON-equivalent for Date/toJSON/BigInt.” | serializeChoice wrapper | Grounded=true; Accurate=false as regression; Reachable=true via custom Set values; Material=false for this diff; Owned=true | Effective=false for preserving current behavior; others n/a | No change; retract recommendation to use cloneJSON | `git show 682e043:src/showdown-adapter.ts` shows native snapshot already returns normalizeJSON(state). Candidate normalizeJSON(switchIns) preserves that behavior, including Date/toJSON/BigInt limitations. |
| “formatid assignment preserves an own undefined property omitted by the baseline.” | snapshotBattle formatid assignment | Grounded/Accurate/Reachable/Material/Owned=true for snapshot structural parity | Effective/Complexity justified/Semantic fit/Verifiable=true for original-value omission check | Fix code with focused parity assertion | Baseline normalizeJSON object branch skips original undefined/function; candidate direct assignment retains the key. |

## No additional findings within inspected scope

- Native serializer method identity admission covers the actual State serialization helper call chain. Custom battle.toJSON or helper overrides retain the existing full JSON fallback.
- The private facade leaves State methods unchanged and delegates native isReferable with State as receiver, preserving its lazy REFERABLE cache rather than creating a separate facade cache.
- Ordinary nested arrays/objects are rebuilt on each visit; undefined array entries become null, nonfinite numbers become null, and negative zero becomes zero. Repeated aliases split as in the baseline normalized graph.
- Pokemon.set objects still pass through cloneJSON individually; native direct log/hints/PRNG fields are replaced by canonical values; switchIns is separately normalized because native serializeChoice assigns Array.from directly.
- Native temporary __proto__ assignments do not create enumerable own properties; omission in the facade matches the baseline's final normalization of the native graph.

Limits: source inspection does not replace the implementation agent's differential/transition tests or root's regression measurements. Exotic globally modified object/array prototypes and mutable serializer definitions during a snapshot call were not exhaustively analyzed. No claim of full future simulator-version compatibility is made.
