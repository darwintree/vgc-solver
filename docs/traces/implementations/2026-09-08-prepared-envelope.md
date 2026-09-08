# Implementation Trace: Prepared probability envelopes

Date: 2026-09-08
Source: Shared native computation follow-up after probability envelope candidate792ff3e
Language: English

## Entries

### 1. Share numeric move summaries within one prepared snapshot

Type: unresolved-implementation-decision

Context:
The probability-envelope experiment repeats native damage and accuracy enumeration for each action pair. One four-by-four node has at most eight distinct directed moves. Its HP intervals, stats, types, abilities, items and native Torrent regimes are fixed before either move is simulated. The existing proof already separates role-dependent admission and interval algebra from those native probes.

Decision:
Add an explicitly prepared evaluator used only during synchronous initialization of one bounded node. Preparation restores and snapshots a detached context. Each distinct side/move obtains an independent fresh native probe; the cache stores role-admission booleans, ordering numbers, HP bounds and numeric probability summaries. The lazy native computation is discarded after producing a result. No mutable Battle is reused for another move or pair, and no cache is shared across nodes or HP states. The unmerged internal module exposes a single prepared interface; internal callers and tests use it directly. Fresh preparations remain independent.

Reason:
The role changes whether a move is allowed first or in response, and which terminal-event expression uses its probabilities. It does not change the damageProfile or hitProbability arguments: each directed move still faces the same target, HP bounds and source HP regimes. Native self boosts are not simulated by either existing probe; the prior monotonicity proof still accounts for their future effect. Reusing the numeric result preserves the full native random mass, unlike replacing a probability profile with damage endpoints.

Follow-up:
Compare prepared and fresh probes in both pair orders across Torrent HP regimes; test snapshot detachment, unsupported moves/callbacks and native terminal intervals. Typecheck/build and serial performance await the root-coordinated CPU window. No acceptance claim yet.

Compatibility clarification:
The terminal-envelope module is unmerged experimental code with no released external consumers. Root review established that a callable-plus-prepare compatibility wrapper had no stable consumer. It was removed in favor of one prepared interface; fresh preparations provide the test comparison without a second production entry point.
