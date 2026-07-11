# Design Review — plan.md (FLY-1018) (Round 1)

Date: 2026-07-08
Author: Codex
Status: CHANGES REQUESTED

## Summary
The plan is directionally strong and mostly buildable: the own-loop package boundary, clean-room discipline, M1→M2→M4→M3 sequencing, and M3 seam split match the locked decisions and the current monorepo shape. However, two Bridge-side contracts need correction before implementation: the new ship-approval request route does not yet map to the real CommDB/GatePoller relay contract, and the scoped-token design does not fail closed on token collision.

## What's Good (Keep)
- Keep the `packages/gemini-agent` monorepo package with a narrow public surface, pinned `@google/genai`, injectable model surface, audit-first loop, and no `teamlead` deep imports.
- Keep the M1→M2→M4→M3 order; it correctly lands the independent text surface before the auth hardening and keeps real `/meet` wiring out of scope until the voice-bridge PR-2 dependency exists.
- Keep the three-layer guardrail strategy: registry/schema dispatch, agent-side endpoint whitelist/static guard, and Bridge-side scoped-token reachability.
- Keep the test shape around loop terminals, hallucinated tool calls, unknown parameters, audit ordering, Bridge route tests, and true Bridge/Gemini QA.
- Keep the byte-compatible default for M4 when `TEAMLEAD_GEMINI_AGENT_TOKEN` is unset.

## Issues & Recommendations
1. `POST /api/ship-approval-request` is not yet buildable against the real GatePoller/CommDB relay contract.

   The plan says the route accepts only `{ prUrl, summary, requesterContext? }`, writes a pending question with `kind="ship_approval_request"` and `requester="gemini-agent"`, then relies on the existing gate-poller relay (`engineering/doc/FLY-1018-gemini-advanced-build/plan.md:244-253`). The current CommDB/gate path does not have that contract. `flywheel-comm` gate insertion requires `checkpoint`, `lead`, `execId`, and `dbPath`, and writes `from_agent=args.execId` / `to_agent=args.lead` (`packages/flywheel-comm/src/commands/gate.ts:16-23`, `packages/flywheel-comm/src/commands/gate.ts:97-115`). On `origin/main`, GatePoller then looks up `store.getSession(question.from_agent)` and skips orphan questions with no session (`origin/main:packages/teamlead/src/bridge/gate-poller.ts:472-480`). Gate questions also require active session and lead-scope checks before delivery (`origin/main:packages/teamlead/src/bridge/gate-poller.ts:1066-1088`).

   Why it matters: a pending question attributed to literal `gemini-agent` has no StateStore session, and the request body lacks the project/lead/execution identity needed to derive the right CommDB and route. As written, the new request can be recorded but not reliably delivered to the Lead/founder through the claimed existing relay. The proposed `kind`/`requester` fields are also not part of the current question routing contract.

   Suggested fix: choose one explicit, testable contract before implementation. Either require/derive `executionId`, `projectName`, and `leadId` from an existing owning runner session, validate that session is active and in scope for the PR, and write a runner/gate question using that session identity; or do not use CommDB questions for this feature and add a Bridge-native `ship_approval_request` LeadEvent/render path with its own idempotency and delivery tests. In either path, add tests proving no orphan question is produced, duplicate PR requests are idempotent, the request is visible in the intended Lead/founder surface, and the route does not create or answer an `approve_to_ship` gate.

2. M4 scoped-token collision currently grants full API access.

   On `origin/main`, `tokenAuthMiddleware` is pure bearer-token equality and no-ops when the token is unset (`origin/main:packages/teamlead/src/bridge/plugin.ts:635-645`). The plan extends it by checking the main token first, then the scoped token (`engineering/doc/FLY-1018-gemini-advanced-build/plan.md:313-321`). If `TEAMLEAD_GEMINI_AGENT_TOKEN` is accidentally equal to `TEAMLEAD_API_TOKEN`, an agent configured with the intended scoped token will match the main-token branch and receive full `/api` access.

   Why it matters: M4 is supposed to turn client discipline into a server-side authority boundary. A copy/paste or secret-manager alias collision would silently defeat that boundary, and the plan only covers the missing-main-token case.

   Suggested fix: add `geminiAgentToken` to `BridgeConfig` / `loadConfig()` and fail-start when `TEAMLEAD_GEMINI_AGENT_TOKEN === TEAMLEAD_API_TOKEN` after normalization. If fail-start is too disruptive, disable the scoped token with a hard error log, but do not allow it to become a full-access credential. Add tests for collision, missing main token, byte-compatible unset scoped token, main token full access, scoped-token allowed routes, and scoped-token denied reserved routes.

3. The scoped-token claim should explicitly exclude the no-auth `/actions/*` alias and keep the client-side guard strict.

   `origin/main` still mounts dashboard actions at `/actions` without token auth, marked "loopback only, same handlers as /api/actions" (`origin/main:packages/teamlead/src/bridge/plugin.ts:1016-1033`). The plan's static guard forbids `/actions/`, which is good, but the M4 wording says reserved endpoints are naturally unreachable through the token map (`engineering/doc/FLY-1018-gemini-advanced-build/plan.md:315-318`).

   Why it matters: the server-side token map only constrains the bearer-authenticated `/api` surface. It does not itself protect a same-origin `/actions/*` URL if the agent client can construct one.

   Suggested fix: keep `/actions/` in the static forbidden-string guard, add a `BridgeClient` exact-path allowlist test that attempts `/actions/approve` or a representative action path and fails before fetch, and scope the M4 design wording to "Bridge `/api` bearer surface" rather than all reserved handlers.

4. The new ship request route should fail closed on tokenless Bridge deployments.

   The global `/api` middleware no-ops when `TEAMLEAD_API_TOKEN` is unset (`origin/main:packages/teamlead/src/bridge/plugin.ts:635-645`, `origin/main:packages/teamlead/src/bridge/plugin.ts:1414-1418`). Existing privileged write paths already add explicit 503 behavior for tokenless deployments; for example, founder-consent gate response refuses unauthenticated approval writes when `config.apiToken` is absent (`origin/main:packages/teamlead/src/bridge/plugin.ts:1468-1485`).

   Why it matters: `ship-approval-request` is not a merge approval, but it is still a human-facing privileged request/audit write. Letting it become unauthenticated whenever the Bridge is tokenless would create a different security posture from the rest of the founder-consent write path.

   Suggested fix: mount or implement `ship-approval-request` with the same explicit tokenless 503 sentinel before parsing or recording the body. Add the route test alongside the planned 400/200/idempotency/401 cases.

## Verdict
CHANGES REQUESTED — address items above
