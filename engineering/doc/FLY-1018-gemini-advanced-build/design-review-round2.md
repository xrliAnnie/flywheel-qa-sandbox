# Design Review — plan.md (FLY-1018) (Round 2)

Date: 2026-07-08
Author: Codex
Status: CHANGES REQUESTED

## Summary
Round 2 closes the Round 1 auth findings: token collision now fail-starts, tokenless ship-request writes fail closed, and the M4 scope is correctly limited to the bearer-authenticated `/api` surface with `/actions/*` defended on the agent side. The remaining blockers are in the rewritten Bridge-native `ship_approval_request` path: the plan still does not define a concrete Lead target / renderable payload contract, and its 24h idempotency can suppress retries after a delivery failure.

## What's Good (Keep)
- Keep the decision to abandon CommDB question writes for `ship-approval-request`; the GatePoller orphan-skip issue is addressed in the right direction.
- Keep the explicit route tests for zero CommDB writes, idempotency, sink delivery, and no `approve_to_ship` gate creation/answer.
- Keep `TEAMLEAD_GEMINI_AGENT_TOKEN` in `BridgeConfig` / `loadConfig()` and the fail-start check when it equals `TEAMLEAD_API_TOKEN` after trim.
- Keep the tokenless 503 before body parsing; it matches the founder-consent write-route precedent.
- Keep the narrowed M4 wording: server-side scoped-token enforcement covers `/api` bearer routes only, while `/actions/*` remains an agent-side allowlist/static-guard concern.

## Issues & Recommendations
1. The Bridge-native ship request event still lacks a buildable Lead target and render contract.

   The updated request body is still only `{ prUrl, summary, requesterContext? }`, and the new `ship_approval_requests` table shape listed in the plan has no `projectName`, `leadId`, `issueId`, or session key (`engineering/doc/FLY-1018-gemini-advanced-build/plan.md:248-253`). But the existing Lead delivery journal is not a targetless broadcast surface: `StateStore.appendLeadEvent()` requires `leadId` (`origin/main:packages/teamlead/src/StateStore.ts:4927-4939`), `LeadEventEnvelope` carries `leadId` and a `HookPayload` (`origin/main:packages/teamlead/src/bridge/lead-runtime.ts:45-51`), and `HookPayload` currently requires `execution_id` and `issue_id` while having no `prUrl`, `requester`, or `requesterContext` fields (`origin/main:packages/teamlead/src/bridge/hook-payload.ts:1-14`). The existing `runner_question` path gets those values from a real session and the current Lead iteration before appending the event (`origin/main:packages/teamlead/src/bridge/gate-poller.ts:1115-1153`), and bootstrap routing is explicitly filtered by `to_agent=leadId` / project membership (`origin/main:packages/teamlead/src/bridge/bootstrap-generator.ts:208-224`, `origin/main:packages/teamlead/src/bridge/bootstrap-generator.ts:283-310`).

   Why it matters: option (b) is viable, but it still needs an explicit answer to "which Lead receives this request?" and "what exactly does the Lead see?" As written, an implementer either has to invent a default Lead, fake session/issue identifiers, or append a payload with extra JSON fields that the current mailbox/CommDB renderers ignore. The generic renderer only prints known fields such as `summary`, `status`, `pr_number`, and `stage_context`; it does not render unknown `prUrl` or requester fields (`origin/main:packages/teamlead/src/bridge/mailbox-lead-runtime.ts:292-320`).

   Suggested fix: make the route contract explicit. Add `projectName` and/or `leadId` to the request, or define a deterministic PR-url-to-project/Lead resolver and fail closed on ambiguity. Persist that target in `ship_approval_requests`. Then add a first-class `ship_approval_request` payload/render branch for both Lead runtimes, or extend `HookPayload` with typed fields and update the generic renderer so the PR URL, requester, requester context, and "nothing merged" note are always visible. Tests should assert the chosen Lead, the exact rendered text contains the PR URL/requester/note, and no fake session identity is required.

2. The idempotency and delivery-failure semantics can blackhole a ship request.

   The plan records a `ship_approval_requests` row, suppresses any same-`prUrl` request for 24h, marks `delivered_at` only after successful delivery, and returns 502 on StateStore write or event delivery failure (`engineering/doc/FLY-1018-gemini-advanced-build/plan.md:251-253`). If the row is written but runtime delivery fails, a retry of the same PR can hit the 24h dedup path and skip re-delivery. The current redelivery loop only retries event types in `RETRYABLE_LEAD_EVENT_TYPES`, which on `origin/main` is guardrails plus `artifact_delivery`, not `ship_approval_request` (`origin/main:packages/teamlead/src/bridge/lead-runtime.ts:30-43`); HeartbeatService fetches undelivered rows using that retryable type list (`origin/main:packages/teamlead/src/HeartbeatService.ts:1321-1327`).

   Why it matters: this is a human-facing request path. A transient Lead-runtime failure should not turn into "already_pending" while no Lead/founder surface ever received the request.

   Suggested fix: define outbox semantics before implementation. Either make `ship_approval_request` retryable and leave an undelivered `lead_events` row for HeartbeatService to redeliver, or allow the same `prUrl` to retry when the prior row has `delivered_at IS NULL` / no successfully queued event. Prefer a transaction or explicit rollback/delete when delivery fails before durable queueing. Add tests for `runtime.deliver` throwing/returning false followed by a same-PR retry, and for heartbeat redelivery if the event is made retryable.

## Verdict
CHANGES REQUESTED — address items above
