# Prepared envelope328e31b

Baseline78f621c has probability-envelope code792ff3e. Node24.20.0, native maximum PP, synchronous backend/workers0, no warmup, one cold-process sample per version, sequential baseline then candidate per fixture,10s search budget and0.02 tolerance. Instrumented runs separate.

| Fixture | Baseline search ms | Prepared search ms | Baseline width | Prepared width |
|---|---:|---:|---:|---:|
| primarina-50-vs-archaludon-100 | 10000.4 | 10000.5 | 0.173804 | 0.111937 |
| primarina-100-vs-archaludon-100 | 10001.5 | 10000.8 | 1.168386 | 1.168265 |
| garchomp-25-vs-archaludon-100 | 412.3 | 401.9 | 0.015005 | 0.015005 |
| garchomp-50-vs-archaludon-100 | 766.0 | 686.9 | 0.015629 | 0.015348 |
| garchomp-100-vs-archaludon-100 | 3988.3 | 2794.8 | 0.019778 | 0.019778 |

G100 cost attribution: baseline pair probes 2347.6ms; prepared context 125.7ms plus pair evaluation 888.1ms. Both produce zero successful certificates.

Typecheck/build and29 terminal-envelope tests pass, including independent native intervals, prepared/fresh cache equivalence in both pair orders at three Torrent HP regimes, repeated calls and snapshot detachment. Full suite unrun.

The sharing reduces probability-envelope overhead but does not solve either Primarina/Archaludon case. Prim50 width remains substantially above leading682e043 historical~0.046, so no adoption recommended on these results. No changes to PP, native rules, probability mass, exact payoff matrices or action coverage.
