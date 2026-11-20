# Root proof-obligation diagnostics

Read-only instrumentation on `682e043`, Node 24.20.0, native maximum PP, synchronous backend, workers 0, cold process, no warmup, one 10-second diagnostic per case. Instrumentation adds overhead; these are diagnostic samples, not replacement acceptance benchmarks. Raw snapshots were not printed.

| Case | Interval | Native/cursor ms | Accept/intern ms | Backup ms | Select ms | Initialize ms | Discovered / initialized |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Primarina100 / Mimikyu100 | [-0.9864275, 0.3745848] | 9387 | 471 | 55 | 31 | 45 | 7957 / 227 |
| Primarina100 / Archaludon100 | [-0.1573472, 0.9986523] | 9409 | 362 | 128 | 64 | 46 | 5433 / 231 |

Neither sample obtained a terminal-envelope certificate. About 94% of search time remains in native transition/cursor execution. Cumulative acceptance traversed 14,794 outcome records for Mimikyu and 52,081 for Archaludon; its current 3.6–4.7% time share does not support prioritizing a broad delta-interface redesign over transition/proof work.

## Archaludon: the immediate root constraint is known, descendants are fragmented

The current lower certificate is pure Moonblast; the current upper certificate is pure Thunderbolt. The Moonblast×Thunderbolt cell alone is their shared active constraint. It consumed 40 batches / 1016 ms, generated 99.728% of its mass, yet 50.49% of the mass remains in uninitialized children. Its child uncertainty sum is 1.1506, maximum single-child contribution only 0.005765.

Across the graph, 3002 turn-2 states were discovered but only 230 initialized; all 2430 discovered turn-3 states remain uninitialized. The largest current contributions in the active root cell are ~0.003 probability branches with Primarina paralyzed and Archaludon still at full HP (the first Moonblast was denied). Typical damaged-Archaludon states have ~0.00226 individual probability and remain below those rare-but-more-concentrated branches in the greedy ordering. This is a concrete concentration/cost effect, not evidence that those rare branches may be discarded.

The root Flash Cannon response also consumed 885 ms and still carries 48.9% uninitialized mass; its lower-constraint margin is only 0.0077, so it cannot simply be excluded after refining Thunderbolt.

## Mimikyu: the mixed root misses a cheap-looking forced-action proof

The upper certificate mixes Swords Dance (0.3482) and Shadow Claw (0.6518). Current lower and upper matrices disagree substantially, and several constraints are tied; a raw node-count ratio is not sufficient to select a proof.

Encore×Swords Dance has exactly one successor of mass 1: turn 2, HP 187/131, intact Disguise, Mimikyu Attack +2 and native Encore duration 3 targeting Swords Dance. That child is initialized but still [-0.941667, 1]. Its root transition itself cost approximately 1 ms. The cross-bound joint scheduling weight is only 0.084, versus 0.306 for Encore×Play Rough and 0.262 for Encore×Shadow Claw. The expensive descendant Play Rough cells consume 130–254 ms each, often without immediate root endpoint gain.

Native source says Encore grants one additional duration tick when the target has already moved; legalActions honors native disabled moves. This suggests a three-action free window at that child, but the tactical win remains a hypothesis until native child-only replay/evaluation confirms the action dimensions, duration, and damage path. A child-only diagnostic is prepared in `/tmp/encore-child-diagnostic.cjs`; it has not yet run.

## Next controlled hypothesis

First reproduce the deterministic Encore successor in isolation. If it has the expected small forced-action proof, evaluate a structural cost-aware joint scheduler that accounts for represented unresolved successors and legal action dimensions while retaining original joint opportunities. Such costs are estimates, never bounds. This is better supported than another blind MAX/SUM threshold or HP hint adjustment. The prior SUM candidate narrowed one target but widened three, so it was not adopted.

Raw data:
- `/tmp/pokemon-game-insights-results/primarina-mimikyu-uncertainty.json`
- `/tmp/pokemon-game-insights-results/primarina-archaludon-uncertainty.json`
