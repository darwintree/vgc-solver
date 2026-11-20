# Prefix-aware action checkpoints: mixed evidence, not adopted

Code chain: abfe802 (complete action checkpoints), 9a276bb (damaging suffix gate), 4f75d2d (capture only after known prefix consumed), based682e043. Native PP and every action/probability unchanged. Global cache bound32; complete joint-state checkpoints; eviction preserves full replay.

Typecheck/build and28 focused native/progressive/strategy tests passed. Original checkpoint candidate also passed4 bounded native/stochastic certificate checks. Logs: action-checkpoint-prefix-validation.log, action-checkpoints-certificates.log.

## Fixed-work mechanism evidence

Same-process order off/on/on/off, two runs each; not a cold complete-search comparison. Attack pair Primarina100/Archaludon100 Moonblast/Thunderbolt: all runs1725 simulator runs and1626 exactly matching canonical outcomes/probabilities. Full replay1556.5/1416.2ms; checkpoint1327.5/1242.1ms. Captures50, resumes1486, executed actions3828, skipped2972. Earlier32-entry implementation re-captured1557 boundaries and resumed168, taking1731.7/1687.1ms. Prefix gating removes measured re-capture churn without increasing capacity.

Status→attack pair Mimikyu SwordsDance then Primarina Moonblast: all runs4 simulator runs/2 identical outcomes. Full15.51/5.41ms, checkpoint8.44/5.44ms; too small and warmup-sensitive to claim a speedup.

## Complete-search evidence

Node24.20.0, @pkmn/sim0.10.11, sync workers0, native maximum PP, tolerance .02, search10000ms, fresh cold process per case, warmup0, samples1. External preload only appends internal counters after solve. Extra factory native audit is included in prepare.

|Case|prepare ms|search ms|total ms|gap|converged|captures|resumes|evictions|executed|skipped|
|---|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|
|primarina-50-vs-archaludon-100|308.34|10000.53|10317.23|0.057268|False|5048|14983|5016|54234|29966|
|primarina-100-vs-archaludon-100|299.49|10000.80|10310.25|1.156956|False|9747|7101|9715|48767|14202|
|primarina-100-vs-mimikyu-50|298.24|10000.58|10307.54|0.509883|False|6271|8654|6239|40876|17308|
|primarina-100-vs-mimikyu-100|300.60|10002.01|10311.15|1.522619|False|3566|6413|3534|37122|12826|
|archaludon-100-vs-mimikyu-100|293.32|10000.55|10302.07|0.054175|False|6185|6945|6153|41937|13890|
|garchomp-100-vs-archaludon-100|299.19|3781.06|4088.44|0.019778|True|87|175|55|10443|350|

All five remaining cases still fail. The previously solved full-HP Garchomp/Archaludon regression converges. The fixed-work speedup does not establish improved full-search convergence; changing slice completion timing also changes how the anytime frontier spends its budget. No adoption is supported by these whole-search results. Capacity remains bounded at32; no blind capacity sweep was performed.
