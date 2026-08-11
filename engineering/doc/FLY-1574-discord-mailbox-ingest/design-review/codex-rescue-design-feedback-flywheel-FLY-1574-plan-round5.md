# Design Review — plan.md (Round 5)
Date: 2026-08-10
Author: Codex
Status: APPROVED

## Summary

Round 5 closes the last correctness blocker: the Codex singleton premise is now enforced by permanent, fail-closed infrastructure shared by TUI and headless runtimes, instead of relying on an operational convention. Together with the lane arbitration, write-ahead ingest intent, bounded autonomous retry, and explicit legacy-transition handling, the plan is feasible, complete enough to implement, and appropriately conservative for the founder’s highest-risk inbound path.

## What's Good (Keep)

- Acquiring a per-Lead runtime mutex before any REST polling or gateway startup gives §2.0c row 4 the missing structural premise and also fixes the pre-existing two-OFF-runtime double-injection hazard.
- The mutex lifecycle and test matrix are strong: fail closed, no socket-file surrogate, no unlink while held, process-death takeover, TUI/headless contention, zero-poll loser behavior, and exactly one winner under a start race.
- Codex transition behavior now matches the real journal and saga protocols under both flag states, including journal-hit completion, fenced recovery of an incomplete `xdept:` saga, and the ON-commit/OFF-replay case.
- The plugin path has a sound durability boundary: write-ahead ingest intent precedes the first CLI attempt, authoritative verdicts are idempotent, and unknown outcomes never fall back to raw direct push.
- The independent persisted-backoff worker and anti-spin tests directly address the FLY-1646 failure pattern while retaining autonomous recovery when no new message arrives.
- The five-state lane union, carrier-aware archived settlement, lane-specific CLI output, real old-path golden fixture, structural bypass checks, executable reconciliation audit, release fence, and revised QA criteria form a coherent end-to-end safety case.
- The cleanup inventory correctly covers all legacy transition rows while retaining the runtime mutex as permanent infrastructure.

## Issues & Recommendations

1. **Non-blocking — pin the mutex to a concrete kernel-backed implementation during implementation review.** Node core does not expose `flock`, and macOS does not normally provide a `flock` command. Use an FD-backed native mechanism or a parent-coupled helper using `fcntl.flock` (consistent with existing repository scripts); do not silently substitute a PID file, `mkdir`, or lease-style library if the contract remains immediate process-death release. Hold the lock for the entire runtime—including generation rebuilds—until every poll/gateway surface has stopped, and fail-stop the runtime if a lock-holder helper dies.
2. **Non-blocking — include mutex capability in the production census.** In addition to the CLI protocol probe and plugin capability evidence, require each running Codex Lead runtime to expose evidence that it is mutex-aware and currently holds the expected per-Lead lock before enabling the global flag. This prevents an old already-running Codex binary from invalidating the new correctness premise during a mixed-version rollout.

## Verdict

APPROVED — ready to implement
