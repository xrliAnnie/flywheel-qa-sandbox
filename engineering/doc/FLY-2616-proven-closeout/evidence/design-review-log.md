# FLY-2616 审阅与交付验证
Issue: FLY-2616 (https://linear.app/geoforge3d/issue/FLY-2616/land收尾-合入后收尾必须能证明每个体已消失session-行缺失窗口不存在心跳超时goneworktree)
日期: 2026-09-15
基于: ../plan.md

Round 1 gate: e838bbb6-5363-41b2-8bd0-c414efd36c6a
Request: 38ecb606-6f5e-49fe-8588-1e1507207c7b
Plan commit: f70f0a62d
Status: CHANGES_REQUESTED; one HIGH, seven MEDIUM, one LOW. Full structured verdict saved in review-r1.json.

HTML: static and JS VM tests passed (html-verification.json). This is not browser QA.
flow.mmd/model.mmd: local mmdc each failed initial attempt + required standard retry with Chromium MachPortRendezvousServer Permission denied (1100). Logs retained. Authorized DIAGRAM PENDING LOCAL RENDER fallback applied, no remote render.

Additional author audit while review pending: plugin.ts:7500-7514 returns source_session_unavailable before closeout if all source session rows missing; codex-phase-shutdown.ts owns earlier ACK/heartbeat gates; additive tables need retention registry fragments. Explicit integration details will be included with round-1 dispositions before final review, not silently treated as implemented.

## Round 1 dispositions

All findings verified against current source. HIGH fixed in design; advisory clarifications also incorporated within existing scope. No implementation claim.

| findingKey | Severity | Disposition |
|---|---|---|
| closeout-entry-gated-by-source-session | HIGH | Addressed: §2.5 / A: operation context, plugin wiring RED, no fabricated Session |
| evidence-freshness-budget-below-probe-timeouts | MEDIUM | Addressed: §2.2: per-observation 30s, bounded per-exec probes, no infinite restart loop |
| lease-shortening-vs-retry-budget | MEDIUM | Addressed: §4.1 / D: non-budget lease_lost, stale worker zero writes, health escalation |
| terminal-cleanup-reservation-no-release | MEDIUM | Addressed: §2.1 / A: claim-scoped reservation and explicit expiry/release/reopen lifecycle |
| retention-registry-fragments-missing | MEDIUM | Addressed: B / F: protectedCurrentOrReference fragments and full retention suites |
| worktree-absent-ancestor-enoent | MEDIUM | Addressed: §3 / C: direct parent identity/device presence before leaf ENOENT |
| finalize-api-duplication | MEDIUM | Addressed: §2.3 / B: one private transaction guard shared by legacy/trusted wrappers |
| acceptance-command-misses-sibling-suites | MEDIUM | Addressed: F: sibling suites, actual close-runner test path, stub-hygiene |
| wallclock-test-in-parallel-shard | LOW | Addressed: D: fake clock CI and separate controlled wall-clock QA gate |

Reviewer example says zero source sessions for two historical runs; Lead records only prove the named body missing. Plan explicitly separates an all-rows-absent boundary fixture from historical facts. Additional author fixes: row present is not live; codex-phase-shutdown earlier gates now explicitly consume trusted evidence.

## Round 2
Gate: 1bb59a60-6f51-4bba-b1fe-51b3a54ab933
Request: 94288b54-50a5-4ff2-a792-4436c9c88119
Reviewed plan commit: 1c0d766ab
Status: CHANGES_REQUESTED; one HIGH, one MEDIUM, one LOW; full response review-r2.json.

## Round 2 dispositions

| findingKey | Disposition |
|---|---|
| worktree-binding-not-durable-beyond-session-row | Verified. §2.5/A/C now mandatory operation-durable complete target snapshot at ensureLandOperation, legacy survivor/receipt recovery and explicit unresolved escalation, scoped never-created N/A. All-row fixture captures snapshot before deletion. No fake durable binding. |
| operation-path-audit-events-need-execution-id | Verified. §2.5/C operation audit uses existing land_operation_step aux receipts, preserving session_events NOT NULL real identities and retry epoch. |
| evidence-freshness-budget-below-probe-timeouts | R1 fixed; R2 low residual made explicit: width 4, per-exec 10s, N<=8 worst-case fits 20s+10s margin; larger inventories under worst timeout report budget failure rather than silently loop. |

No runtime code changed. Missing historical target evidence remains an honest failure requiring real provenance; a virtual land engine node never exempts its issue's real worktrees.

## Round 3
Gate: a945a8a9-3f01-4b84-a39d-fa1fd35f69d8
Request: cb64e870-0bbf-4652-9d74-22e4dece3994
Reviewed plan commit: 700e3f64d
Status: CHANGES_REQUESTED; one HIGH and one MEDIUM. Full response review-r3.json.

## Round 3 dispositions

| findingKey | Disposition |
|---|---|
| intent-refusal-has-no-escalation-path | Verified. §2.5/A adds typed refusal, engine holdLandRun + durable alertIdentity outbox, existing land_held_without_operation resume door; operator typed409; no log-only failure. |
| ensure-land-operation-sync-signature-and-idempotency | Verified. Explicit async provider + synchronous verifiedTargets SQL parameter; await all createIntent callers; NULL/stale INSERT OR IGNORE rows backfill; ordinary/reclose first-closeout both capture before any cleanup. |

All changes remain design corrections within source-proven entry/consumer boundaries.

## Round 4
Gate: 3aa676fc-bbbe-43b1-9d2c-574f7f7100e0
Request: 409e6126-409b-4f32-a62b-30f52a1c4393
Reviewed plan commit: 4e136009d
Status: effective reviewVerdict=APPROVED; reviewerVerdict=APPROVED. Two non-blocking advisories retained as Follow-ups; no HIGH remains. Full response review-r4.json.

## Final review authority
Approved request 409e6126-409b-4f32-a62b-30f52a1c4393 / gate 3aa676fc-bbbe-43b1-9d2c-574f7f7100e0 / plan commit 4e136009d. Plan bytes remain frozen (SHA256 f5f831f48b89c928b385c794498f708729b0a54707634ffdd7b3a1f8a89d7ae2). Approval is design only. Implementation/QA acceptance is not claimed.
