# Endpoint envelope candidate cd04183

Node24.20.0; native maximum PP; synchronous backend/workers0; no warmup; one sample per version; sequential baseline682e043 then candidate per fixture; tolerance0.02;10s search budget. Profiling instrumentation excluded from paired timing.

| Fixture | Baseline search ms | Candidate search ms | Baseline converged | Candidate converged |
|---|---:|---:|---|---|
| garchomp-25-vs-archaludon-100 | 405.7 | 411.3 | True | True |
| garchomp-50-vs-archaludon-100 | 733.8 | 685.6 | True | True |
| garchomp-100-vs-archaludon-100 | 3517.5 | 2863.8 | True | True |
| primarina-50-vs-archaludon-100 | 10000.5 | 10000.5 | False | False |
| archaludon-100-vs-mimikyu-100 | 10000.4 | 8387.4 | False | True |

G100Arch probe instrumentation:6480 calls,0 certificates,1776ms baseline versus1118ms candidate. Search3536→2887ms. This supports reduction of proof execution overhead. Arch100Mimi excludes Disguise at envelope factory admission: the observed convergence difference cannot be attributed to endpoint changes and needs repetition. No new full-sweep acceptance claim.

Typecheck/build and all28 terminal-envelope/bounded-native-certificate tests passed. Full suite remains unrun. Raw paired JSON includes prepare/search/total, exact supplied HP/PP, intervals and counters.
