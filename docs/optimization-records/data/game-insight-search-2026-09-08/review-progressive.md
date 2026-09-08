# Progressive transition review — 091fe22

Read-only review against `091fe22^`; no builds, tests or performance runs were executed. Applied the code-review skill locally on both standards and contract axes; the explicit instruction forbidding extra agents takes precedence over its parallel-agent workflow.

## Findings

### P2 — Partial mass accepted within the existing sum tolerance lacks equivalent numerical protection

Target: `/tmp/pokemon-progressive-transitions/src/bounded-solver.ts:415`–`421`, `467`–`488`.

The validator permits total probability to differ from one by up to `1e-9`, but partial progress is deliberately not normalized and `_cellBounds` does not widen for that admitted error. The node-level `1e-10` guard is smaller than the accepted error. This differs from the complete path, which normalizes the full distribution.

Concrete accepted custom-adapter example: cumulative win mass `0.7500000005`, remaining mass `0.25`, `complete: false`. Total `1.0000000005` passes validation. The cell lower bound becomes `0.5000000005`; after the node guard it is approximately `0.5000000004`. Normalizing the entire reported mass gives a possible all-loss remainder value approximately `0.50000000025`, outside the returned lower bound. This is a numerical edge in the newly accepted partial interface, not evidence of wrong native branch accounting; no native reproduction was attempted. An explicit conservative allowance for total/aggregation error is safer than normalizing completed mass alone.

## Safety checks without further findings

- **Disjoint canceled prefixes:** `progressive-transition.ts:88`–`115` splits siblings before narrowing the active branch probability; `BranchingPRNG` appends selected decisions to the same prefix array. Cancellation occurs before a new split, and reinserts the narrowed active prefix, so its mass does not overlap siblings. The cancellation test checks completion against the native distribution (`test/progressive-transition.test.ts:94`).
- **Missing probability:** `bounded-solver.ts:471`–`481` retains unknown mass as `[-remaining,+remaining]`; accepted completed outcomes retain their unconditional weights. Partial outcomes replace the prior cumulative view rather than being appended twice (`:424`).
- **Snapshots and PP cache:** returned outcome records are copied (`progressive-transition.ts:132`), and accepting the view copies numeric probabilities into bounded outcomes. Snapshot restoration follows the existing detached native adapter. The cursor does not call PP-cache get/set/template methods; its bypass is an intentional performance cost, not cache poisoning.
- **Exactness:** `bounded-solver.ts:500` requires no cursor, no remaining mass, and all represented successors exact. Nearly complete probability does not become exact. Node-limit children remain null/unknown and prohibit exactness.
- **Custom adapters / workers:** `createTurnCursor` is optional; old adapters still use `enumerateTurn`. Custom async adapters fall back to `solveSync` (`async-bounded-solver.ts:53`). The native worker path never creates cursors and continues accepting complete distributions. No partial cursor can leak into worker `_cellBatch` through the reviewed solve path.
- **Limits:** the run limit is cumulative across advances (`progressive-transition.ts:82`); cancellation attempts count as replay work. A deadline is cooperative at branch boundaries. Neither property silently strengthens a certificate.

## Performance observations, not correctness defects

Every progress view copies all accumulated outcomes, and `_acceptTransition` re-interns all of them. Many small batches with many distinct successors can therefore incur quadratic cumulative processing. This is visible in `progressive-transition.ts:132` and `bounded-solver.ts:400`–`413`; it needs measurement before redesign. The independent PP-cache bypass and retained opaque-sibling scheduling may also explain regressions. No broad scalability claim follows from passing the included tests.
