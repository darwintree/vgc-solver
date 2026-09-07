# Implementation Trace: PP Template Admission

This candidate trace uses the local calendar date. Final validation is recorded in [the experiment report](../../optimization-records/strategy-certificates-2026-09-07.md), dated by the experiment's UTC start.

Date: 2026-09-08
Source: parent agent request for lazy PP-template admission
Language: English

## Entries

### 1. Solver-only admission policy

Type: unresolved-implementation-decision

Context:
The request asks to avoid installing PP trackers and constructing templates
for normalized keys seen only once, but direct cache consumers and existing
semantic tests currently expect `createPPTransitionCache()` to capture on its
first request. The source does not state whether that direct contract may
change.

Decision:
Keep the existing immediate-capture behavior for the default cache factory and
add a solve-scoped admission mode used by exact, bounded, and worker solver
contexts. In admission mode the first normalized request follows the native
enumeration path without tracker installation; the second request captures a
template, and subsequent requests may replay it after the existing interval,
shape, and audit checks.

Reason:
This removes tracker work from one-off search states while preserving the
established direct cache contract. The admission state remains solve-scoped and
is keyed by the same normalized action/state key, so it cannot create a
cross-solve or cross-rule reuse path.

Follow-up:
Validate useful admitted reuse against native distributions, PP exhaustion,
unsafe mechanisms, and full-PP solver fixtures.
