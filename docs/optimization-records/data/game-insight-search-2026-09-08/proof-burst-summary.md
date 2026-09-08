# Local proof burst result

Candidate `644e35f`, base `682e043`. Typecheck/build and 38 focused certificate and
solver tests pass (`proof-burst-validation.log`). No new convergence among the
five remaining cases. Native maximum PP including PP Ups, workers0, synchronous,
fresh cold process per fixture, one sample, tolerance .02, 10s search budget.
Separate prepare/search/total and full command: `proof-burst.jsonl`.

| Case | Lower | Upper | Gap |
|---|---:|---:|---:|
| Primarina50 / Archaludon100 | -.9221354166 | -.8683165144 | .0538189022 |
| Primarina100 / Archaludon100 | -.1569615808 | .9986523438 | 1.1556139247 |
| Primarina100 / Mimikyu50 | -.4354066802 | -.0297880332 | .4056186470 |
| Primarina100 / Mimikyu100 | -.9861785005 | .3714593041 | 1.3576378046 |
| Archaludon100 / Mimikyu100 | .7745668506 | .8031250002 | .0285581496 |

The targeted Encore continuation receives exactly seven visits in both baseline
and candidate, ending at `[-.9416666667,1]`. Baseline first visits at4.739s; it
initializes the4×1 child, generates its four action cells, initializes its Moonblast
successor, advances that successor's first cell once, then abandons it for the rest
of10s. Candidate confirms local origin admission, but the seventh operation spends
a whole cursor slice and expires the25ms burst. The continuation is again abandoned.
See `proof-burst-baseline-trace.json` and `proof-burst-candidate-trace.json`.

Thus the intended mechanism did not persist through multiple expensive slices.
This experiment does not refute longer proof commitments in general, but does not
justify choosing a larger constant from this single fixture. Do not adopt the
candidate based on these results; unchanged certificates alone are insufficient.
