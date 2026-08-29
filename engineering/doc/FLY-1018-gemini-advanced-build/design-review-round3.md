# Design Review — plan.md (FLY-1018) (Round 3)

Date: 2026-07-08
Author: Codex
Status: CHANGES REQUESTED

## Summary
Round 3 materially improves section 2.8: the request path now has non-model `projectName`, typed render fields, retryable outbox semantics, and tests for the prior blackhole case. Two implementation-contract gaps remain: `projectName` alone is not enough to resolve a unique Lead in the current multi-Lead `ProjectEntry` model, and the outbox/request-row sequence needs an atomicity or deterministic-event-id rule to avoid orphan/duplicate lead events after a partial failure.

## What's Good (Keep)
- Keep `projectName` hidden from the model-facing tool schema and injected by the agent-side BridgeClient from session config.
- Keep the rule that no default Lead or fake session/issue identity may be invented.
- Keep typed `HookPayload` fields for `pr_url`, `requester`, and `requester_context`, with explicit rendered text asserting PR URL, requester, and the "nothing merged" note.
- Keep `ship_approval_request` in `RETRYABLE_LEAD_EVENT_TYPES`; that is the right way to make "queued means accepted" safe under transient runtime delivery failure.
- Keep idempotency scoped to durably queued prior rows rather than any half-written request record.

## Issues & Recommendations
1. `projectName -> unique leadId` is not an existing repo invariant.

   The plan says Bridge resolves `projectName` to a unique `leadId` through the existing `ProjectEntry` mapping, and rejects unknown/no-lead projects (`engineering/doc/FLY-1018-gemini-advanced-build/plan.md:250-255`). Current `ProjectEntry` is explicitly one project to many leads (`origin/main:packages/teamlead/src/ProjectConfig.ts:248-252`), and validation only requires `leads.length > 0`, not exactly one (`origin/main:packages/teamlead/src/ProjectConfig.ts:415-420`). The existing resolver needs issue labels and falls back to `project.leads[0]` when there is no label match (`origin/main:packages/teamlead/src/ProjectConfig.ts:988-1010`); `RuntimeRegistry.resolveWithLead()` likewise takes `labels` as part of lead resolution (`origin/main:packages/teamlead/src/bridge/runtime-registry.ts:35-49`).

   Why it matters: `request_ship_approval` has no labels and the plan explicitly forbids inventing a default Lead. On any normal multi-Lead project, the implementer must either silently pick the first Lead (violating the plan), fail 400 for otherwise valid projects, or invent a new convention not captured in the plan.

   Suggested fix: make the target Lead source explicit. Good options are: add a non-model `leadId` to the agent session/channel binding and have BridgeClient attach it alongside `projectName`; add a project-level `shipApprovalLeadId` / `geminiAgentLeadId` config field validated against `ProjectEntry.leads`; or state that this route only works when `project.leads.length === 1` and must 400 on multi-Lead projects. Add tests for multi-Lead project rejection or explicit configured lead selection, plus the current resolved-Lead assertion.

2. The outbox/request-row sequence needs an atomicity or deterministic dedup rule.

   The plan orders `appendLeadEvent` first, then inserts `ship_approval_requests` with a `lead_event_id`, and says a StateStore write failure returns 502 (`engineering/doc/FLY-1018-gemini-advanced-build/plan.md:252-260`). On `origin/main`, `appendLeadEvent()` dedups only by `(lead_id, event_id)` and returns the existing seq on conflict (`origin/main:packages/teamlead/src/StateStore.ts:4927-4953`), while `StateStore` has an explicit transaction primitive for multi-statement atomicity (`origin/main:packages/teamlead/src/StateStore.ts:115-120`). The current plan does not say whether `appendLeadEvent + insert ship_approval_requests` are one transaction, nor does it specify a deterministic event id derived from `(leadId, prUrl)`.

   Why it matters: if `appendLeadEvent` succeeds but the request-row insert fails, the route can return 502 after a durable Lead event has already been queued. A client retry may not find a request row for idempotency and may queue another event unless `event_id` is deterministic or the two writes are atomic.

   Suggested fix: define one of these explicitly. Prefer wrapping the lead event insert and request-row insert in `StateStore.transaction()` and treating the pair as the durable queue operation; then deliver only after commit. If the event must be appended outside that transaction, use a deterministic `event_id` such as `ship_approval_request:${leadId}:${hash(canonicalPrUrl)}` so retry dedups through `appendLeadEvent`. Add a failure-injection test where request-row insert fails after event append; assert no orphan lead event exists, or that retry reuses the same event id/seq without duplicate founder-visible delivery.

3. Render-file wording points at the wrong concrete runtime.

   The plan says the render branch goes into "lead-runtime.ts + mailbox-lead-runtime.ts" (`engineering/doc/FLY-1018-gemini-advanced-build/plan.md:256-257`). In the current tree, `lead-runtime.ts` is the interface/retryable-set file; the two concrete formatters are `commdb-lead-runtime.ts` and `mailbox-lead-runtime.ts` (`origin/main:packages/teamlead/src/bridge/commdb-lead-runtime.ts:74-186`, `origin/main:packages/teamlead/src/bridge/mailbox-lead-runtime.ts:202-320`).

   Why it matters: missing the CommDB runtime would regress one Lead surface back to the generic renderer, which is exactly the drift class the Round 2 feedback was trying to eliminate.

   Suggested fix: adjust the plan wording and tests to name `commdb-lead-runtime.ts` and `mailbox-lead-runtime.ts` as the renderer targets, with `lead-runtime.ts` limited to `RETRYABLE_LEAD_EVENT_TYPES` / shared types.

## Verdict
CHANGES REQUESTED — address items above
