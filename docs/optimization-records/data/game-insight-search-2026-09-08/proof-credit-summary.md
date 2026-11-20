# Retained proof allowance: intermediate acceptance failed

Candidate `4ca7d80`, base `682e043`. Typecheck/build and39 focused tests pass
(`proof-credit-validation.log`). Remaining-five benchmark was not run because the
required target-child proof did not complete. CPU released after diagnosis.

Two cold ten-second native Primarina100/Mimikyu100 diagnostic runs preserve native
maximum PP, workers0/sync, tolerance.02. Both give the Encore×SwordsDance child only
seven ordinary global-selected visits and zero retained local visits, ending at
`[-.9416666667,1]`. First diagnostic sees this child at2.45s with99.57% uncertainty
share; second sees it at5.09s with55.22% share. It cannot obtain the single occupied
allowance slot. The aggregate intervals are respectively `[-.97710,.78063]` and
`[-.98903,.55636]`; these instrumented runs are diagnostic, not paired speed claims.

The second trace identifies an unrelated turn2 HP187/115 incumbent receiving214
local selections over4.60–7.68s, ending `[-1,-.79598]`. A later unrelated HP187/131
child receives76 selections without convergence. Holding a stale incumbent until
its wall-clock allowance expires prevents a newly dominant obligation from obtaining
persistent service. Alternating global operations preserves global access but does
not solve this allocation problem.

Files: `proof-credit-trace.json`, `proof-credit-origin-trace.json`. No adoption
recommended. A future retained-obligation mechanism needs arbitration or multiple
credits; merely enlarging the single slot's lifetime does not address this failure.
