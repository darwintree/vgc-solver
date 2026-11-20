# Implementation Trace: Terminal envelope throughput

Date: 2026-09-08
Source: Regression follow-up to validated candidate 682e043
Language: English

## Entries

### 1. Evaluate audited damage extrema at random endpoints

Type: unresolved-implementation-decision

Context:
The full-HP Garchomp/Archaludon search regressed from roughly1.7s before envelopes to3.5s with them despite equal405 expanded states, approximately4122 replays and zero successful terminal certificates. Each eager cell probe restores a battle and can evaluate32 native damage values for each move. The existing envelope has strict native source, callback and overflow admission.

Decision:
Preserve the bounded certificate contract and action coverage. For each critical branch, evaluate native damage at rolls0 and15. Keep both critical branches, all admission checks, exact native damage calculation and deadline checks. Export the internal range helper solely from its implementation module to compare its result directly with an independent all32-roll native oracle; no package entrypoint change.

Reason:
Within the admitted native path, the randomizer scales damage by a positive factor. Subsequent STAB and type factors, native rounding and the minimum-one clamp are monotone. No admitted hook modifies damage. The existing overflow bound excludes native16-bit wrapping, so extrema occur at endpoints. This removes repeated proof execution without caching mutable battle data or changing which cells receive certificates.

Follow-up:
Validate boosted statistics, dual types, both critical branches, defense drops and all existing native interval/fallback tests. Instrument and benchmark separately after exclusive CPU becomes available, retaining G25/G50 envelope wins. No performance acceptance claim yet.
