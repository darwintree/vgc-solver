# Final production review

Scope: `/tmp/pokemon-scalability-pr`, HEAD `8f67bdb`, against `51acee3`; explicit `git --work-tree` used. Source review only during the coordinated validation window. Applied simplify to recently changed production code; no production edits in the delivery worktree.

## Required correctness fix

**P1 — independently normalizing cumulative partial batches can preserve a false certificate.** `src/bounded-solver.ts:424–436`, combined with monotone intersections in `_cellBounds`.

A first partial batch with terminal win mass .75 and remaining mass .25−5e-10 passes the 1e-9 sum tolerance. Normalizing this batch yields lower bound about .50000000075. A final cumulative batch with win .75 and loss .25 has exact normalized value .5. The earlier lower endpoint is retained by the monotone intersection; even the node's 1e-10 numerical guard cannot enclose .5. Negating both utilities gives the mirrored invalid upper endpoint. All published completed mass is cumulative; only the permitted total rounding changes.

Root accepted this finding and assigned an isolated regression and repair in `/tmp/pokemon-partial-rounding-pr`, based on `8f67bdb`. Twelve positive/negative partial→complete regressions are source-ready, with independent initial and final sum errors. The old implementation is retained pending the CPU window to establish red.

Proposed repair: incomplete batches scale known raw mass by the largest admitted final total, 1+τ, and reserve the remainder as unknown. If known mass is m and its weighted lower bound is K, every future normalized completion has lower bound `(K+m)/T−1` and T≤1+τ. Since K+m≥0, the maximum denominator gives the conservative lower endpoint. The analogous upper expression `1+(K−m)/T` is also widest at the maximum denominator. Complete batches retain their actual-total normalization. This addresses cross-batch error without an arbitrary additive safety constant.

## Other source checks

No additional actionable correctness finding identified in the reviewed paths:

- The progressive cursor's canceled prefix returns only the active residual mass. Previously split siblings remain separate, and completed outcomes accumulate without conditioning away unknown probability. Batch and total replay limits remain distinct.
- Exact solving retains its full-matrix contract. Bounded cells with a live cursor or unknown mass do not become exact merely because a terminal envelope narrowed their interval.
- Terminal envelopes admit a narrow native subset, reject unsupported dynamic power/contact/healing/field/type states, audit callback event slots as well as identities, and leave the full transition as fallback. The native damage endpoint simplification relies on these admission conditions; it is not an unrestricted replacement for arbitrary native move damage enumeration.
- Native damage observations retain actual HP damage and audit the relevant native methods/effects; custom adapters retain their fallback path. No checkpoint experimental code is in this delivery candidate.

## Simplify assessment

The small probability heap, explicit native admission guards, and separation of partial evidence from full transitions serve behavioral contracts. Removing these layers or merging guard conditions would obscure correctness rather than simplify it. No speculative readability-only refactor is recommended during final acceptance. The normalization repair is the one material change recommended by this review.

## Limits

This report is a source review, not a new test/performance result. It does not claim 54/54 convergence, and the user's current contract is to finish review and create a PR with the measured partial result. Validation of the required rounding repair is pending the coordinated CPU window. Native large five-hit distributions were not exhaustively replayed as part of this review; relevant envelope coverage relies on admitted bounds plus existing smaller native differential tests.

## Repair validation update

The P1 repair is committed as `6ed786d` in `/tmp/pokemon-partial-rounding-pr`. Original implementation: 6/12 new cumulative-rounding regressions fail; detailed assertions are in `partial-rounding-red-detail.log`. Repaired implementation: typecheck and build pass, followed by all 54 tests in progressive-transition, bounded-strategy-proof, and terminal-envelope (`partial-rounding-green.log`, Node24, test-isolation=none). Documentation now distinguishes the cursor's raw unexplored probability from the internal normalization uncertainty reserve. No performance runs were added. Full integrated acceptance remains the coordinator's next step.
