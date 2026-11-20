# Work-aware joint selection result

Candidate `333ddccb6f02b4dd2cad0678769028d187a7c2d0`, base `682e043`.
Typecheck, build, and 39 focused strategy, stochastic, bounded, and native
certificate tests pass. Log: `proof-cost-validation.log`.

Cold fresh process per case, one sample, native maximum PP including PP Ups,
workers 0, sync backend, no warmup, 10,000 ms search budget, tolerance .02.
Command and separate prepare/search/total measurements: `proof-cost.jsonl`.

| Case | Lower | Upper | Gap | Converged |
|---|---:|---:|---:|---|
| Primarina50 / Archaludon100 | -.9221354166 | -.8742101709 | .0479252458 | no |
| Primarina100 / Archaludon100 | -.1569615808 | .9986523438 | 1.1556139247 | no |
| Primarina100 / Mimikyu50 | -.4307126976 | -.0325511259 | .3981615717 | no |
| Primarina100 / Mimikyu100 | -.9888272869 | .4533736272 | 1.4422009140 | no |
| Archaludon100 / Mimikyu100 | .7497529466 | .8031250002 | .0533720536 | no |

No new convergence. Mimikyu50 improves modestly versus the leading sweep, while
Mimikyu100 worsens. Do not adopt this candidate from these observations.
The estimate counts currently exposed work rather than future subtree cost;
initializing a child changes its estimate and can interrupt a promising proof.
Also, dividing current joint support by work cannot prioritize a certificate
whose current optimistic/pessimistic cross-support is zero. These are structural
limitations, not justification for tuning constants from five fixtures.

The separate Encore continuation diagnosis remains useful: fresh native auto
search certifies its lower bound .9892187497 in 191.5 ms. Therefore full-root
starvation is demonstrable, but this heuristic does not reliably fix it.
