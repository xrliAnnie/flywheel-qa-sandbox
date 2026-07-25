# Design Review — plan.md FLY-1446 (Round 4)

Date: 2026-07-24
Author: Codex
Status: APPROVED

## Summary

Round 4 closes all three Round 3 findings against the current HEAD contracts. The plan now has conclusive read authority for roster verdicts, an accurate and explicit observer scope cut, and a fully observable locked policy seed; no blocking feasibility, correctness, risk, scope, sequencing, or consistency issue remains.

## What's Good (Keep)

- R-phase now owns a dedicated `ok_nonempty | ok_empty | indeterminate` inventory seam instead of inheriting `get_tmux_agent_windows()`’s `|| true` behavior. Only conclusive snapshots authorize missing/orphan verdicts or healthy re-arm; indeterminate rounds preserve every subject episode.
- “Server confirmed dead means empty” is tied to independent server-generation/socket evidence rather than overloaded tmux command rc, preserving the all-windows-gone acceptance case without turning transient IPC failure into alert storms.
- R/M separation remains clean: read-only visibility can proceed when linked-view recovery is inconclusive, while every cmux mutation still passes WAL recovery and the per-round blocked set.
- The observer follow-up rationale is now source-accurate. It acknowledges the existing `/api/sessions/:id` route and its execution-id→identifier fallback, requires exact response/receipt execution-id equality, and records the token-unset middleware caveat instead of claiming the endpoint is absent.
- The deliberate observer scope cut is honest and bounded: this PR ships exec-id orphan detection/alerting only, while durable log rotation, receipt ownership, terminal authority and real-machine QA remain explicit follow-up prerequisites.
- `policy-enforce` is specified as a first-class rescue verb across instrumentation, pending-decision replay, owner evidence, lock dispatch and usage. Separate audit identity, crash replay, long-hold alerting, unreachable-server zero mutation and rollout fact checks make the seed path consistent with existing rescue architecture.
- The earlier design strengths remain intact: archive-first atomic symlink convergence, launchd as sole watcher starter, transaction-internal ledger uniqueness, typed WAL recovery, durable alert episodes, evidence-first forensics and explicit flag propagation.

## Issues & Recommendations

1. **No blocking issues.** The plan is ready to implement within the stated watcher/script boundary.
2. **Implementation checkpoint (non-blocking):** keep the typed inventory snapshot unpublished until every command and row parse succeeds; the listed partial-session, command-failure, true-empty and recovery tests should remain merge gates.
3. **Implementation checkpoint (non-blocking):** when adding `policy-enforce`, update every verb closed set named in the plan and verify receipt/replay behavior under `/bin/bash` 3.2, not only mutual exclusion and the happy-path sentinel result.
4. **Process checkpoint (non-blocking):** create/link the observer Linear follow-up before closing FLY-1446 so the deliberate literal-scope deviation and its four enabling prerequisites remain visible.

## Verdict

APPROVED — ready to implement
