# Design Review — FLY-1251 plan.md (Round 12)
Date: 2026-07-14
Author: Codex
Status: APPROVED

## Summary

Round 12 closes the remaining boot-drain, unhealthy-lane churn, and layer-ownership gaps. The plan is feasible and implementable within the current architecture, preserves the FLY-1244 boundary, and now gives every material race, half-failure, restart state, and recovery path a fail-closed disposition with an adversarial test.

## What's Good (Keep)

- The four boot dispositions are closed: successful 200 reconciliation, durable retirement for 404/config drift, other durable retirement, or boot-local isolation after a failed retirement.
- `isolated_for_boot` permits healthy lanes and `startBridge()` to progress while every authority-capable path remains closed for the failed card/lane; the next boot re-runs reconciliation.
- Step 0 prevents any attempt row or Discord POST while the lane is unknown, unhealthy, configuration-drifted, or poisoned. The independent step-5 recheck correctly remains as the race-closing activation guard.
- Boot-time invalidation is cleanly separated from reposting, so producer exclusion is preserved and the normal pending-gate scan creates the later attempt.
- Live-card 404 handling, `message_gone=0` USE-time authority, boot-scoped health trust, and lane/card poison jointly close deleted-message and mutation-failure windows.
- Quarantine is durable before response, re-armable per episode, convergent under CAS races, and unable to carry a rejected reaction into later authorization.
- The PR-1 incident predicate still mechanically blocks the 2026-07-14 shape: main code PR, `qa_required=0`, no three-stage label, zero `auto_qa_record`, and satisfied Codex gate yields `qa_evidence_missing` and no approve card.
- Manual QA cannot mint evidence: it can only trigger a server-owned standard QA runner whose result passes through the unchanged verdict chain.
- Persistence and orchestration are now assigned to appropriate layers: StateStore owns atomic rows/CAS, the bridge service owns network/policy workflows, and `plugin.ts` owns startup ordering and injection.
- The test matrix covers POST ambiguity, every persisted card state, activation/scanner races, stale reactions, channel outcomes, boot isolation, lane independence, poison persistence, and all six approval routes.
- Scope and sequencing remain honest: merge-gate tightening and run-level readiness stay deferred, while §4.3 is explicitly blocked until the separate FLY-1244 route-source/authority-hook seam is landed and pinned. The four forbidden sibling files remain out of scope.

## Issues & Recommendations

1. **[LOW] One boot-disposition sentence still says there are “only three” terminal outcomes immediately before introducing the fourth `isolated_for_boot` disposition.** The later text correctly declares all four dispositions closed, so this does not create a safety or implementation blocker. **Suggested fix:** change the introductory sentence to “four closed dispositions” and state whether `isolated_for_boot` poison is immutable until the next boot or may be promoted in the same boot only by rerunning the full 200 + durable-health + quarantine reconciliation. Either policy is safe; one explicit sentence will remove the last wording ambiguity.

## Verdict

APPROVED — ready to implement
