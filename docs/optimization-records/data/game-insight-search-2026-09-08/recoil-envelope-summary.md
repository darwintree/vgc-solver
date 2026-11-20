# Recoil-safe successor envelope73fe8b6

Independent branchcodex/recoil-envelope at/tmp/pokemon-recoil-envelope, based prepared-envelope328e31b. Node24.20.0; native maximum PP; synchronous backend/workers0; no warmup; one cold-process sample per version; sequential baseline then candidate;10s search budget and0.02 tolerance.

| Fixture | Baseline search ms | Candidate search ms | Baseline width | Candidate width | Candidate converged |
|---|---:|---:|---:|---:|---|
| primarina-100-vs-mimikyu-50 | 10000.5 | 10000.4 | 0.444174 | 0.429056 | False |
| primarina-100-vs-mimikyu-100 | 10000.8 | 10000.4 | 1.501730 | 1.550927 | False |
| archaludon-100-vs-mimikyu-100 | 10000.6 | 4045.3 | 0.050886 | 0.019895 | True |
| primarina-50-vs-archaludon-100 | 10000.5 | 10000.4 | 0.127004 | 0.049851 | False |
| garchomp-100-vs-archaludon-100 | 2753.9 | 2748.7 | 0.019778 | 0.019778 | True |

Separate instrumented Prim100/Mimi100 diagnostic:280 node preparations,150 rejected,67.85ms preparation plus1183.80ms pair probing,2080 probes and700 successful certificates. Prior328e31b rejects this root factory, so this node proof cost is entirely newly enabled. Instrumented run is not acceptance timing.

Validation: typecheck/build pass. Initial terminal-envelope run37 passed and2 hit the existing50,000 native oracle branch cap. The fixtures were split so response survival/crit uses Shadow Claw and first-hit accuracy/secondary uses Play Rough. Final focused11 tests pass, including both previous cap cases; no production safety assertion failed or required a fix. Logs recoil-envelope-validation.log and recoil-envelope-validation-final.log preserve both runs. Full suite and full54-case sweep on this candidate were not run.

Conclusion: strong local benefit for Arch100/Mimi100, but mixed overall throughput and no convergence for the other three previously hard fixtures. Keep the experiment isolated unless a complete final acceptance validates adoption. No further optimization iteration is planned following the user stop instruction.
