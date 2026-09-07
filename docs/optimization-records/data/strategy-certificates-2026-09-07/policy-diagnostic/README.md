# Garchomp vs Archaludon policy certificate

These JSON files are diagnostic artifacts for the fixed policy “P1 uses
Earthquake every turn” on `garchomp-100-vs-archaludon-100`. The fixture is
created by `championsCases()` and `createChampionsBattle()`, so both sides keep
their native maximum PP. Every transition has complete probability mass and
every legal P2 reply is checked through turn two.

`policy-optimized.json` was produced by the optimized native transition
enumerator and contains 2,444 transitions, 52,206 simulator replays, and
3,054 outcome records. `policy-native.json` was produced by the independent
pre-optimization replay oracle and contains 189,060 replays. Aggregating both
outputs by successor HP and terminal utility gives identical probabilities to
within `3.8e-15`; insertion order differs.

From the repository root, after building, reproduce either path with:

```bash
npm run build
node dist/test/garchomp-archaludon-policy.js > docs/optimization-records/data/strategy-certificates-2026-09-07/policy-diagnostic/policy-optimized.json
node dist/test/garchomp-archaludon-policy.js --native > docs/optimization-records/data/strategy-certificates-2026-09-07/policy-diagnostic/policy-native.json
```

The optimized run took 21.07 seconds in the recorded environment. The native
oracle run took 2 minutes 10.22 seconds. The script exits unsuccessfully if a
transition is incomplete, probability mass is not one, or any reply/outcome
refutes the two-turn win certificate.
