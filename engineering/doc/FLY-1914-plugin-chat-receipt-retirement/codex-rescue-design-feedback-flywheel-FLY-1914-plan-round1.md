# Design Review — FLY-1914 plan.md (Round 1)

Date: 2026-08-19
Author: Codex
Status: CHANGES REQUESTED

## Summary

The adopt-and-deploy approach is appropriately minimal, and the repository confirms the key mechanism claims: the dual-marker checker is present, the installer publishes the managed operations, the residue gate exists, and `request-restart.sh` is a durable updater handoff. The plan is not ready to execute yet because its exact-head preflight is not actually merge-time JIT, its drift branches are too coarse, and it carries a stale FLY-1715/main-deployment assumption into a restart path that has materially changed since FLY-1730.

## What's Good (Keep)

- Reusing fork PR #23 unchanged while its head remains `a3117e1cfef448304cf16d461d87ec5a874afbea` preserves the exact-head code-review and independent-QA evidence instead of rebuilding an already approved fix.
- Delta-1 is mechanically correct: `scripts/discord-plugin/check-discord-plugin.sh` accepts `ChatReceiptRuntime` or `ChatIngestRuntime`, and `scripts/install-discord-plugin-ops.sh` stages and atomically replaces each canonical checker/updater before registering the pointer marketplace.
- The managed deployment discipline is correct. `scripts/request-restart.sh` only enqueues a durable updater request, while `restart-services.sh` checks and, when needed, updates the plugin before the Lead wave.
- The plan preserves the important FLY-1730 safety properties: founder-gated merges, no raw plugin mutation fallback, pre/post process census, exact installed version/SHA verification, collision-safe residue archiving with `ingest/` excluded, and Phase-C rollback-flag retention.
- A1-A5 remain a suitable production acceptance set, and updating A5 with the current 43+4 intent snapshot strengthens the non-vacuous control.
- Focused repository verification passed: Discord operations 24/24, request-restart 11/11, shell syntax checks, and the main-only FLY-1645 residue gate over 1,466 files.

## Issues & Recommendations

1. **The P1-P3 check is not actually JIT relative to the fork merge, leaving an exact-head TOCTOU gap.** Section 8 runs it before authoring, reviewing, and merging the main-repo documentation PR; another fork PR can land during that interval. More importantly, `update-discord-plugin.sh` deploys the then-current fork `main`, so a PR landing after #23 is merged but before the updater wave can deploy a SHA that was never covered by the inherited QA, with the terminal receipt detecting the mismatch only after mutation. Keep the initial adoption check, but repeat a mandatory final preflight immediately before founder merge; record the full 40-character base/head OIDs, OPEN/base-main state, manifest version, and checks. Hold **all** writes/merges to fork `main` (not only #19) from that final check through the installed-SHA terminal receipt, then re-read fork `main` immediately before `request-restart.sh`; any mismatch stops before deployment.

2. **The drift matrix maps every P2 failure to `rebase`, which is not a sound state machine.** `mergeStateStatus=UNKNOWN`, a pending/failed check, `BLOCKED`, a closed/already-merged PR, a changed head, and a real base conflict require different actions; rebasing can needlessly destroy the exact QA binding and does not fix several of those states. Expand P2 to query `state,isDraft,baseRefName,headRefName,headRefOid,mergeable,mergeStateStatus,statusCheckRollup`. Retry transient `UNKNOWN`; stop on non-OPEN/wrong-base/wrong-head-branch; resolve policy/check failures without changing bytes; rebase only for actual base drift/conflict. Any byte/head change must still trigger tests, the exact cross-repo residue gate, fresh code review, and fresh independent QA.

3. **The current-main audit is stale and can hide an unintended co-deploy.** Research F17 and plan §§1/4 say FLY-1715 PR #821 is unmerged, but GitHub and the checked-out main history show it merged on 2026-08-13 as `e08c8d0a609e0c0a556a4ebafb7ab27393595cbe`. Since FLY-1730, `restart-services.sh` has also gained pull-to-latest-main, canonical identity preflights, managed voice-bridge replacement, legacy alert retirement, and non-Lead daemon convergence. Before Phase A, record production `deployed-sha` and audit the exact `deployed-sha..origin/main` range; if it contains FLY-1715 or another change with an unfulfilled ship precondition, do not silently co-deploy it in the FLY-1914 wave. Update F17 and the plan rationale. Keep the census because pre-existing or not-yet-restarted adapters can survive, not because #821 is unmerged.

4. **The terminal receipt does not fully bind success to this updater wave or the expanded restart result.** `leads-restart-status.json` already records `reason`, but the inherited gate does not require `.reason == "updater"`; a later unrelated healthy wave at the same main SHA can satisfy the file check. The current restart can also return success while emitting a separate `Flywheel restart degraded` warning for non-Lead daemon convergence, which the Lead-only JSON does not represent. Add `.reason == "updater"`, confirm the exact request marker/nonce captured at enqueue was acknowledged/cleared, and require no restart-degraded alert for this window (or stop for an explicit founder decision). This supplements, rather than replaces, the existing timestamp, SHA, health, installed-plugin, and cache sentinels.

5. **B2 would add a new milestone while leaving the directly related milestones factually wrong.** `CLAUDE.md` still describes FLY-1645 as waiting on both repository PRs and FLY-1730 as waiting on PR #817, although #808 and #817 are merged; its FLY-1715 row also still says #821 is pending. Make B2 explicitly update the FLY-1645/FLY-1730 rows to the split state documented by FLY-1914, and correct the FLY-1715 merge state used by this plan, in addition to adding the FLY-1914 row.

6. **Several claimed gates are descriptions rather than executable commands.** P2/P3 contain ellipses, and the drift path names the residue gate config but not the required cross-repo invocation. Replace them with copyable commands and explicit predicates, including `node scripts/fly1645-receipt-residue-gate.mjs --plugin-root <fork-root>`. For the new CLAUDE rule, require the PR evidence to state the sweep timestamp and explicitly report missing/inaccessible configured plugin-cache roots; otherwise “zero references” can be reported when no production cache was actually inspected.

## Verdict

CHANGES REQUESTED — address items above
