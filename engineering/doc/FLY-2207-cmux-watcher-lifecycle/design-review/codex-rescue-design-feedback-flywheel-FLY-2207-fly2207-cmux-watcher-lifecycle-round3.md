# Design Review — plan.md FLY-2207 cmux-watcher-lifecycle (Round 3)

Date: 2026-08-31
Author: Codex
Status: APPROVED

## Summary

Revision R3 closes all four Round 2 blockers with source-compatible, testable contracts and without adding lifecycle machinery. The plan now preserves launchd management, makes lease ownership—not process census—the recovery authority, gives founder escalation a complete generation lifecycle, and defines hermetic evidence for the actual cold-start backfill path.

## What's Good (Keep)

- The `--recover` probe now requires a live, incarnation-matching new `mode=watch` lease owner, a matching heartbeat PID, and a PID distinct from the kickstarted owner. Demoting same-argv census candidates to diagnostic detail removes the incident's false veto without weakening single-mutator authority.
- The decisive residue test directly covers the former failure shape: a valid replacement remains healthy while an old same-argv watchdog candidate survives beyond the former 30-second probe crutch. Keeping the existing probe defaults is simpler and correct because probe success no longer waits for unrelated residue to disappear.
- `unhealthyGeneration` now initializes on the first tracked unhealthy observation, including Bridge cold start; survives every non-healthy/non-park transitional verdict; and clears only on verified healthy or either park verdict. The three added transition tests pin initialization, inheritance, and reset semantics.
- T5.4 now uses `scripts/test-cmux-sync.sh` as the isolation boundary, enumerates HOME, state, lease, heartbeat, maintenance, event, tmux, and cmux seams, and proves `sync_additive_bootstrap` cold-start reconciliation rather than the unrelated reopen-sweep path. Treating 529 only as an optional runner-fixture producer preserves the hermetic contract.
- The rendered plist assertion correctly separates the static KeepAlive/Throttle contract from what a PATH stub can prove. Real launchd drills remain optional, founder-authorized, and audited.
- The timeout tests now cover both PING and CALL at the accepted boundary and above it, including the respective default fallback and WARN behavior.
- The earlier Round 1 closures remain intact: park-before-job-absence plus mutation-time marker fencing, success-only recovery latching, kickstart/rebuild path separation, full-union escalation routing, FLY-913 decision-matrix preservation, and removal of the proposed `/health` component and straggler-killer mechanism.

## Issues & Recommendations

No blocking issues. Implement the plan as written and retain the specified negative/race tests; in particular, do not reintroduce a census-count health veto or broaden the FLY-913 decision matrix during implementation.

## Verdict

APPROVED — ready to implement.
