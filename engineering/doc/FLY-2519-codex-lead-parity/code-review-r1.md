# FLY-2519 Codex Lead 能力对等 — 代码评审 R1
Issue: FLY-2519
日期: 2026-09-14
基于: plan.md、gap-checklist.md

Effective verdict: APPROVED. Reviewed head: c97dd7be2a367222ee392d794c89f9210fb6ade8. Question: b6177176-7ef1-4149-9a2e-ed60836958f6. Request: 4d1e0e12-34ad-4477-90d6-329d2bc6e5e2. All findings were advisories at review time; bounded fix dispositions below record subsequent work.

Lead instruction f7cd32c1-bb5b-4a1f-a4d9-93c0bfa1b8da subsequently requires ONE bounded fix round covering exactly these 19 findings. Priority A must fix: v2 home overlap, patrol wiring, additive legacy terminal compatibility, terminal test race, Discord edit ownership, browser-only startup failure. Other 9 MEDIUM/4 LOW: fix as described; any individual item exceeding about 30 minutes becomes an explicit gap with reason. Focused tests only, no full package run. At most two further reviews; fix a new fix-caused HIGH once, report recurrence or unrelated HIGH. Then PR/exact-head CI/QA. Do not add scope.

The main sync was already in flight when the instruction was pulled and committed as 3eb2e63d7; preserve that merge. Keep kill inventory frozen again until final pre-PR synchronization. No PR yet.

## v2-parent-unstartable-prod-codex-home (MEDIUM)

The v2 capability parent always fails to start with the production Codex home layout

Production launchers set CODEX_HOME to ~/.codex-<key> (scripts/flywheel-lead.sh:179 with derive_codex_lead_home). codex-lead.sh does not override that for bundle v2. Meanwhile leadCredentialAliases (credential-paths.ts:118-128) adds every ~/.codex-* entry to the deny list, and the v2 readPaths add realpath(codexHome)/skills and a codexPath under that same home. renderLeadPermissionProfile (permission-profile.ts:67-75) then sees under(source, secret) is true and throws 'permission grant overlaps a credential source'. Result: setting codexCapabilityBundleVersion=2 on a real Lead takes that Lead down at startup. The failure is fail-closed and v1 is unaffected. No test uses a .codex-<key> home (runtime-parent/default-runtime tests use join(root,'home')). The P01-P17 parity rows must not be marked as runtime-proven until this is fixed.

- [x] Fixed: v2 parent explicitly identifies its trusted active home; historical homes stay fully denied, current private files remain denied under root-default-deny, and only verified public skills/executable paths are readable. Real .codex-fixture default assembly red -> green; 12 focused tests and typecheck pass. No production activation.

## receipt-dispatched-crash-never-recovered (MEDIUM)

A crash after 'dispatched' leaves the receipt returning 'pending' forever; plan §4.1 step 3 recovery is never wired

recoverDispatched has no production caller; the only calls are in receipts.test.ts. It is also scoped to the same activation_id, so a new activation could not recover old rows anyway. After a SIGKILL between the prepared→dispatched and result transitions, retrying the same requestId goes through broker.replay (broker.ts:390-393) and maps dispatched/prepared to 'pending'. handler.reconcile runs only for 'unknown', so the read-only reconciliation is never reached. No duplicate write happens, because the rule tells the model not to mint a new requestId, but the operation can never be resolved. The broker.test close/reopen case passes only because a graceful close writes 'unknown' first.

- [x] Fixed: current parent startup, before broker admission, recovers scoped prepared/dispatched receipts across prior activations to unknown. Actual SQLite abrupt-close/reopen + UDS regression red -> green proves read-only reconciliation without redispatch and foreign Lead preservation. Receipt/broker/default factory tests also pass; typecheck green.

## terminal-mcp-claude-lead-regression (MEDIUM)

The shared terminal core changes production Claude Lead terminal-mcp behaviour

terminal-mcp is registered for Claude Leads (claude-lead.sh:2347) and now routes through createTerminalSessionCore, with three behaviour changes. (1) runner_terminal_input now requires expectedSessionId and refuses to send unless status==='waiting'. (2) observe() classifies only the LAST non-empty line, whereas the old detector scanned 15 lines. Claude Code permission and menu prompts end in an option or border line, so they classify as 'executing' and input is refused. (3) runner_terminal_status for a dead pane used to return {status:'dead'} and now returns an error (terminal_unavailable), even though consumers such as claude-infra-bot identity.md:120 rely on it. Refusing input is the safer direction and is consistent with FLY-195, but these contract changes to a live Claude tool should be explicitly accepted or covered by multi-line prompt tests.

- [x] Fixed: explicit legacy adapter restores 15-line prompt detection, dead status and optional expectedSessionId/input compatibility. V2 retains required session pin and waiting guard. 22 MCP, 3 detector and 6 strict-core/real-pane tests pass.

## terminal-read-io-test-race-red (MEDIUM)

A real-tmux input test fails on every local run at HEAD

'submits literal input only to the observed waiting private pane' failed 3 of 3 isolated runs locally (expected 'waiting', received 'idle'). It calls core.status immediately after `tmux new-session -d` with no retry. The sibling test needs up to 20 retries before the canary text appears, so the pane is most likely still empty when status runs. CI installs tmux (ci.yml:196-198) at /usr/bin/tmux, so this test also runs in the teamlead shards and can turn them red. The other 1898 targeted tests passed, and teamlead and comm typecheck are clean.

- [x] Fixed: bounded 20 x 25ms readiness polling mirrors the sibling canary test; waiting and literal-input assertions remain. Reviewer recorded 3/3 red; this run before and after both passed (2 tests), so no local reproduction claimed.

## discord-edit-bridge-gate-cards (MEDIUM)

discord.message.edit accepts any message authored by the shared bot user, including Bridge founder-gate cards

The ownership check is message.authorId === botUserId. Bridge posts founder-gate cards with the same Lead bot token (founder-gate-bot-token.ts), and reaction confirmation binds only to card_message_id plus the founder id. So a Lead model could rewrite a gate card's text before the founder reacts. This is not a new privilege: the Claude Discord plugin's edit_message (server.ts:1319) edits any bot message in allowed channels. Plan §2 says Codex tools should not inherit founder-adjacent exposure just because Claude has it. Recommended fix: restrict edits to message ids produced by this Lead's outbox or capability receipts.

- [x] Fixed: edits require this Lead and thread matching a durable sent outbox message ID, checked again at actual side-effect guard. Shared-bot cards without evidence reject. SQLite restart/foreign Lead/thread tests, handler negative test red -> green, and real typed Bridge tests pass (124 tests across four files; Bridge gate-card case also passes).

## patrol-not-wired-in-bridge (MEDIUM)

patrol.* capability is not wired in production Bridge startup

createBridgeApp accepts leadPatrol and forwards it (plugin.ts:1540, 3073), but the startBridge call passes only leadEventDelivery and leadGithub, and nothing else produces leadPatrol or helperPins. The parent registers patrol handlers, so every patrol.snapshot and patrol.judgment.record call hits lead-capability-read.ts:393 and returns 403 scope_denied. This fails closed, but P10 cannot pass real acceptance on this head.

- [x] Fixed: startBridge now supplies deployed helper/rule pins and a private scratch root through a validated configuration builder. 22 focused configuration, HTTP and registration tests pass; teamlead typecheck passes. No production startup claimed.

## github-pr-binding-runner-claimed (MEDIUM)

Tier-B PR binding trusts the runner-reported pr_number and never checks the PR head against the session branch

sessions.pr_number comes from runner-written land-status (ExecutionEvidenceCollector) without verification. A Lead could have its runner claim a foreign PR number and so pass the same-lead binding for comment, edit, ready or rerun. No new privilege results, since that runner already holds gh credentials, but binding on pr.head.ref === session branch (already fetched in pull()) would make the §6 ruling hold on its own. resolvePatrolSessionOwner (db.ts:8372) also falls back to the issue cohort when the exact row has been deleted, which contradicts its doc comment and the binding's 'retention deletion revokes' claim.

- [x] Fixed: GitHub writes carry provider-observed head.ref into the synchronous binding guard and require matching session.branch. Ownership uses the exact live CommDB execution row; missing rows no longer fall back to issue cohorts for authorization (patrol attribution itself remains unchanged). Foreign-head and absent-execution tests red -> green. 22 Bridge/binding tests and 44 GitHub handler tests pass; typecheck green.

## discord-thread-create-repeat-rename-notify (MEDIUM)

Repeating discord.thread.create on an already-bound thread renames it and re-posts a channel notification each time

ensureChatThread goes through reuseOrRecoverCanonical, which always calls maybeBackfillThreadName and postChannelNotification even when a threadId is already bound. Each fresh requestId bypasses dedup, so the model can repeatedly rename the thread and notify the founder channel.

- [x] Fixed: after verified canonical reuse, the v2 handler returns the existing thread without invoking the legacy creator. Actual creator + StateStore test red -> green proves a fresh UUID and changed name produce no additional provider writes. 58 Discord/Bridge tests pass.

## discord-capability-inflight-map-wedge (MEDIUM)

The shared 64-slot request map never evicts unknown or timed-out writes

Write entries that end as 'unknown', or whose client disconnects mid-execute, are never removed. After 64 of them across all Leads, every Discord capability write returns 503 provider_capacity until Bridge restarts. Timeouts are realistic because assertCurrent makes several Linear calls per step. Durable state already lives in receipts and the outbox, so a TTL or per-Lead cap is safe.

- [ ] Deferred under the bounded ruling: simple TTL/eviction would remove the only Bridge-local dispatch barrier for uncertain edit/react/create calls; only reply/attachment paths have durable provider-side evidence today. A safe fix needs durable per-operation admission/replay plus bounded cancellation and crash tests across these write handlers, estimated beyond the per-item 30-minute budget. Keep fail-closed capacity behavior; no unsafe eviction or duplicate-write risk introduced. Track in gap-checklist.md and PR.

## browser-rpc-timeout-kills-session (MEDIUM)

Any callTool timeout or abort destroys the whole Chrome worker

Every rejection, including the SDK's 15s timeout, sets status 'lost' and closes the transport's process group. The model may pass a tool timeout of up to 15000ms, so a slow navigation predictably becomes browser_lost for the rest of the activation. Design §6.1 reserves browser_lost for crashes.

- [x] Fixed: MCP RequestTimeout and caller cancellation leave a still-ready worker alive and return browser_operation_interrupted; actual transport close/crash still invalidates generation. Real child MCP cancellation and SDK timeout regression red -> green, 8 worker tests pass.

## browser-startup-failure-blocks-all-handlers (MEDIUM)

A browser provider failure rejects the entire v2 runtime

startBrowserProvider is awaited unconditionally, and runtime_handler_coverage_incomplete rejects the runtime when browser.* handlers are missing. A host where Seatbelt or Chrome fails (the recorded host canary did fail) therefore also loses Linear, Discord, GitHub and patrol. Design §6.2 says only the browser capability should fail closed.

- [x] Fixed: failed native browser startup retains a restricted model egress proxy and 21 explicit browser_unavailable denials while other providers remain active. Existing partial browser cleanup remains tested. Runtime regression red -> green, real proxy close and actual artifact creation verified; no native browser host retry.

## model-isolation-canary-gaps (MEDIUM)

The model isolation canary does not exercise the deny rules the design relies on

The read and symlink probes target the parent tmpdir, which the :tmpdir and :slash_tmp deny rules cover, not :root=deny or the explicit credential [path] denies. There is also no unix-socket connect probe against the parent-owned app-server socket (capability-app-server.ts), which would be a full bypass if a shell could reach it. Plan §4.3 and §8.1 require these canaries.

- [ ] Deferred under the bounded ruling: current verifyModelIsolation runs before capability-tui-runtime creates the real app-server socket, so a temporary substitute socket would not prove the requested bypass guard. Root/explicit-credential discrimination also needs non-tmp host fixtures and fault-injected permissions. A post-app-server pre-admission gate plus real host canaries exceeds the bounded item budget; nested sandbox host retry is explicitly prohibited. Existing canaries remain mandatory but do not prove these missing properties. Track in gap-checklist.md and PR.

## tui-pane-env-and-trust (MEDIUM)

The v2 TUI pane may fail to initialise or stop at the trust prompt (plausible, not reproduced)

env -i uses the sidecar's own environment, where launchd provides no TERM or LANG. The v2 profile TOML also omits the [projects.<cwd>] trust_level entry that v1 writes to suppress the boot trust menu, so an unattended founder-visible pane could block.

- [x] Fixed: washed v2 environment supplies xterm-256color and en_US.UTF-8 when missing, preserves explicit terminal/locale values; generated TOML trusts only the pinned project cwd. Regression red -> green; environment/profile/sandbox/default-factory 18 tests pass. Unattended host TUI acceptance remains separate.

## seatbelt-opt-homebrew-broad-read (MEDIUM)

The Seatbelt policy grants read and map on all of /opt/homebrew

This exposes /opt/homebrew/etc and /opt/homebrew/var data to the browser worker. file: navigation is blocked at three layers, so this is weaker defence in depth rather than a direct leak. Narrowing to the dylib closure (Cellar, opt, lib) would match the ruling's intent.

- [x] Fixed: replace whole /opt/homebrew read/map grants with Cellar, opt and lib roots. Policy tests red -> green explicitly exclude whole-root/etc/var grants. Native dylib/Chrome host compatibility remains QA evidence, not claimed here.

## envelope-rejections-surface-unknown (MEDIUM)

Socket and envelope rejections reach the model as 'unknown' and lose their stable code

The socket sends requestId:null for request_too_large and similar errors. lead-operation-client treats the mismatch as broker_response_invalid, and the MCP proxy as broker_unavailable, so the model is told to reconcile a request that was never dispatched.

- [x] Fixed: the one-request UDS client correlates only allowlisted null-UUID pre-dispatch rejections with empty refs/no data; unknown or effect-bearing outcomes remain invalid. Includes newline in facade frame budgets. Native browser facade preserves stable rejected codes. Client red -> green; broker/socket/general/native facade 40 tests pass.

## denials-reported-as-unknown (LOW)

Policy denials collapse to status 'unknown'

Browser tool denials (file:, javascript:) and context7 scope denials (handlers/context7.ts:111) return 'unknown' instead of a stable rejected code. Wrong-owner batch acks (lead-inbox-batch-ack.ts:32) and pre-send terminal guard failures (lead-capability-read.ts:613) likewise mark side effects as possible before any side effect has happened.

- [x] Fixed: browser policy/scope and Context7 pre-authorization failures return rejected with stable broker-safe codes. Wrong-recipient mailbox exception is known to precede queue writes. Terminal marks possible effects only after the immediate send guard succeeds, retaining unknown after actual send uncertainty. Four denial regressions and terminal guard red -> green; 26 tests pass, including actual queue and Bridge HTTP.

## terminal-input-exit-command (LOW)

terminal.input text can end a Runner session

Text such as /exit or /quit typed into a waiting pane ends the runner, which is similar in effect to the reserved terminate. This matches existing Claude terminal-mcp behaviour, so it is not a regression; a small denylist would close it.

- [x] Fixed: only v2 terminal input rejects case-insensitive /exit and /quit command tokens before observation/send. Legacy adapter is unchanged. 8 strict core tests pass; 22 legacy MCP tests still pass.

## github-binding-commdb-rw-open (LOW)

The GitHub write path opens CommDB read-write for a read-only binding check

On a project with no comm.db this creates and migrates one as a side effect of a GitHub request. openReadonly would suffice.

- [x] Fixed: GitHub binding route uses CommDB.openReadonly. Actual direct/full Bridge tests prove a missing database remains absent and no provider write occurs; existing write/replay tests pass. Missing authority returns unknown through the existing failure projection.

## verify-deployment-symlink-main-guard (LOW)

Deployment preflight silently does nothing if the checkout path contains a symlink

The guard compares fileURLToPath(import.meta.url) with argv[1]. Node realpaths the first but not the second, so with a symlinked path the check is false and the script exits 0 without verifying. The runtime re-verifies, so this is defence in depth only.

- [x] Fixed: canonicalize argv entry before comparing with import.meta.url. Actual tsx child through a symlink previously exited 0, now executes preflight and fails missing deployment evidence with exit 78. All 3 deployment tests pass.

Bounded round disposition: 17 fixed, 2 explicitly deferred with reasons. No full package r5, production activation, provider write or native browser host retry. Fresh review remains required.
