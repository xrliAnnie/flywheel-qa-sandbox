# FLY-2519 Codex Lead 能力对等 — 代码评审 R2
Issue: FLY-2519 (https://linear.app/geoforge3d/issue/FLY-2519)
日期: 2026-09-14
基于: code-review-r1.md、plan.md

Effective/raw verdict: CHANGES_REQUESTED. Reviewed head: d6067bcdf6a7e4af1b6c7b1b274b9dc72e1cdea4. Question: 6a52314b-c054-4ce3-8f89-828f65fdadbd. Request: a8b529fe-2329-42ec-ac67-b8822cfe0b46.

## Authorized HIGH repair

`patrol-config-crashes-bridge-startup` is the one fix-caused HIGH repair permitted by Lead instruction f7cd32c1-bb5b-4a1f-a4d9-93c0bfa1b8da. The optional Bridge patrol configuration builder now catches state/helper validation failures, logs only an allowlisted reason, and returns undefined. startBridge no longer resolves the state path outside this boundary. Existing patrol authorization rejects unavailable configuration; unrelated Bridge services stay available. Strict source pins and private directory checks remain unchanged. Packaged helpers are not newly shipped.

Red: /tmp/fly2519-r2-patrol-start-red.log, both unsafe scratch and missing state tests failed against the previous implementation. Green: /tmp/fly2519-r2-patrol-start-green.log, 22 tests including actual Bridge HTTP routes with unavailable patrol. Additional packaged-layout real Node subprocess: /tmp/fly2519-r2-patrol-package-green.log, 3 configuration tests passed. The subprocess loads transpiled production modules under node_modules/flywheel-teamlead/dist/bridge with missing monorepo helpers and exits successfully with patrol disabled. This is isolated executable evidence, not production activation. Teamlead typecheck: /tmp/fly2519-r2-patrol-typecheck.log, exit 0.

The next review is final R3 (second of the two permitted further reviews). No additional advisory fix round is authorized; the five R2 advisories below remain visible PR followups. A recurring or unrelated HIGH requires a Lead report, not another repair loop.

## Structured findings

### HIGH — patrol-config-crashes-bridge-startup

packages/teamlead/src/bridge/plugin.ts:8315

This was introduced by the round-1 fix 9fe5c3899. startBridge now calls createLeadPatrolConfiguration(...) inline in the createBridgeApp arguments with no try/catch. That function throws if any of the following fails: (1) the state directory is group- or other-writable, or has a realpath or uid mismatch; (2) pinLeadPatrolSources cannot read one of five helper files or the rule file, via bytes() in lead-patrol-snapshot.ts:27, which requires realpath equality, nlink 1, the same uid, no group/other write bit and a size of at most 1 MiB. deploymentRoot is computed as resolve(dist/bridge, '../../../..'). In the packaged payload the teamlead dist lives at node_modules/flywheel-teamlead/dist/bridge (package-onboard.sh po_compile_run_bridge), so the root is the package root. The payload allowlist (scripts/package-onboard-files.allow) does not contain scripts/lead-patrol-github-facts.mjs, scripts/flywheel-snapshot-control.mjs or packages/teamlead/lead-rules-base/runner-patrol-rules.md; the rules ship only under node_modules/flywheel-teamlead/lead-rules-base. realpathSync therefore throws ENOENT, startBridge rejects, and the packaged Bridge (dist/run-bridge.js, the target of package-onboard-smoke.test.sh ④c) can never serve /health. That takes down every Lead and runner on a customer install after auto-update. On monorepo hosts, a single helper file with a group-write bit, a hardlink or a different owner would likewise crash the production Bridge instead of just disabling patrol. patrol.* must fail closed (leave leadPatrol undefined so requests return 403, and log the reason), not abort Bridge startup.

Disposition: Repaired above; pending final R3.

### MEDIUM — browser-startup-failure-evidence-discarded

packages/teamlead/src/lead-capabilities/runtime-factory.ts:351

The fix correctly keeps the other providers alive when the browser fails to start. However, .catch(async () => {...}) drops the error completely: nothing is logged and nothing goes into a receipt. The operator sees only browser_unavailable, with no Seatbelt denial line, host-identity drift or worker exit detail. design-correction.md §3 requires startup failure evidence to be kept, and the non-negotiables forbid silently swallowed failure paths. Record a sanitized reason code in the startup receipt or log before returning the denial handlers.

Disposition: Non-blocking advisory retained for PR followup under the bounded review instruction; not repaired in this HIGH-only round.

### MEDIUM — discord-capability-inflight-map-wedge

packages/teamlead/src/bridge/lead-capability-discord.ts:106

The ledger defers this with a stated reason. It still fails closed: after 64 stuck entries across all Leads, Discord capability writes return 503 until Bridge restarts. It remains a non-blocking advisory and needs durable per-operation admission before any eviction.

Disposition: Non-blocking advisory retained for PR followup under the bounded review instruction; not repaired in this HIGH-only round.

### MEDIUM — model-isolation-canary-gaps

packages/teamlead/src/lead-capabilities/model-isolation.ts:72

Deferred in the ledger with a stated reason. Parity and isolation rows must stay unverified until a post-app-server, pre-admission canary proves these deny rules.

Disposition: Non-blocking advisory retained for PR followup under the bounded review instruction; not repaired in this HIGH-only round.

### LOW — terminal-mcp-claude-lead-regression

packages/flywheel-comm/src/terminal-observation.ts:193

legacyContract restores the 15-line detection, the dead status, optional expectedSessionId and input without the waiting gate. The legacy input path still goes through session(executionId, true), which now requires CommDB status === 'running'. The old getSessionScoped({requireExactLead:true}) accepted any status, so Claude Leads can no longer type into runners whose CommDB row is 'blocked'. Confirm this is intended or relax it for legacyContract.

Disposition: Non-blocking advisory retained for PR followup under the bounded review instruction; not repaired in this HIGH-only round.

### LOW — discord-typed-route-test-timeout-under-load

packages/teamlead/src/bridge/__tests__/lead-capability-discord.test.ts:1

'resolves a real registry-owned canonical thread through the typed route' timed out at 5000ms when run together with 87 related files, but passed 2 of 2 in isolation. The teamlead CI shards also run in parallel, so this may flake there; consider an explicit longer timeout.

Disposition: Non-blocking advisory retained for PR followup under the bounded review instruction; not repaired in this HIGH-only round.


## Final verification

pnpm lint: exit 0, 18 existing warnings (/tmp/fly2519-r2-high-lint.log). pnpm -r build: exit 0 (/tmp/fly2519-r2-high-build.log). git diff --check: exit 0 for this repair. No package r5, host retry, kill inventory change or production action.
