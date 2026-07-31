# FLY-1547 Design Review — Round 2

**Review target**: `doc/engineer/plan/draft/FLY-1547-mailbox-service.md`  
**R1 baseline**: `/tmp/fly1547-design-review-r1.md`  
**Reviewed checkout**: `335cb684360021e4c5800d4886368135b7cc2ea4` (`feat/fly1547-mailbox-service`, clean and equal to `origin/feat/fly1547-mailbox-service` at final pin)  
**Scope**: verify the ten R1 findings against the revised design, the new Codex real-machine spike, current production seams/callers, the two founder directives, and the red-line matrix. This is a design verdict; the three already-landed FLY-1547 slices (`ask_kind` routing, `mailbox_status`, and `issueTitle` propagation) are used as current-source evidence rather than accepted from commit messages.

## Executive assessment

Round 2 materially improves the plan:

- the new spike genuinely proves that an external app-server turn against the current bare Codex TUI is a hidden fork, not a visible wake;
- the Claude lease is now a health-bearing, fail-stop contract rather than a PID-only hint;
- `mailbox_status` has a stable pending-sequence high-water field;
- the Lead/runner identity modes, exact import seams, v1 channel-lease extraction, polling assumption, and bounded load test are substantially clearer;
- founder routing is correctly split by `ask_kind`, with `founder_push` absent/defaulting to off;
- the descriptor-to-spawn `issueTitle` propagation is now present in source.

The plan is still not implementable safely as written. Its core FYI response-loss claim contradicts the current durable delivery-action replay contract; the “closed” disposition list omits multiple current production mailbox kinds; reply idempotency remains unsafe across response loss and Lead generation takeover; the proposed Codex runner switch omits the thread/bootstrap and detached-daemon ownership lifecycle that the cited FLY-398 implementation actually requires; and the claimed existing Claude Lead credential-registration path does not exist in the named launcher.

The new spike closes the negative half of R1 Finding 5 (“do not send JSON-RPC turns to a bare TUI”). It does not validate the replacement remote-attached runner form, which the plan itself explicitly says has not been tested in runner context (`plan:180-184`).

## R1 finding closure audit

| R1 | Status | Round-2 judgment |
|---|---|---|
| 1. Claim before `next`, especially Lead prefetch | **NOT RESOLVED** | Moving Lead polling to `next` is the right direction, but the design does not preserve the existing converter/settlement ownership, and its promised response-loss resume is false under the current delivery-action replay contract. See Finding 1. |
| 2. FYI applied before result reaches model | **NOT RESOLVED** | Delayed ack removes the old applied-before-return ordering, but after a flushed host response the same running attempt cannot currently return its envelope again. The FYI can remain permanently ambiguous rather than redeliver. See Finding 1. |
| 3. Reply then settle lacks crash-safe idempotency | **NOT RESOLVED** | Canonical source identity is added, but it is generation-scoped, the reply route is caller-selectable, and generic `send` cannot retry after a lost first response when the server generated the key. See Finding 3. |
| 4. Disposition is contradictory/incomplete | **NOT RESOLVED** | `runner_ask.ask_kind` is now parsed and unknown input fails closed, but the explicit supposedly exhaustive list omits current production kinds and is not actually shared by all named consumers. See Finding 2. |
| 5. Codex sender does not wake active TUI | **PARTIALLY RESOLVED** | The spike conclusively rejects the bare-TUI JSON-RPC path. The replacement remote-attached runner contract remains unspiked and lacks thread/bootstrap/daemon lifecycle. See Finding 4. |
| 6. PID lease is not channel health | **RESOLVED IN DESIGN** | `last_ok_at`, stale detection, channel rejection, bounded consecutive failures, fail-stop exit, lease deletion, durable failure event, and the required negative tests are now specified (`plan:100-106`). |
| 7. Status lacks sequence/dedup data | **PARTIALLY RESOLVED** | `max_pending_seq`, pending UIDs, and the replacement-at-same-count test close the data-shape defect. Durable ownership/recovery of the ring cursor/effect is still unspecified. See Finding 7. |
| 8. Lead install/identity lifecycle absent | **NOT RESOLVED** | The modes are frozen, but the plan’s assertion that `claude-lead.sh` already has a `register-lead` credential lifecycle is false in current source. See Finding 6. |
| 9. Import/reuse seams do not match source | **RESOLVED IN DESIGN, WITH LOW-SCOPE CLEANUP** | The sender now names existing `flywheel-claude-runner` exports, and the v1 lease/poll seam is explicitly extracted with reverse-compat coverage. The unused teamlead facade should not be delivered merely to “close” a review sentence. See Finding 9. |
| 10. 1-second load claim unsupported | **RESOLVED IN DESIGN** | It is now explicitly an assumption, with startup jitter and a bounded ≥8-session/restart load test (`plan:136-140,180-185`). |

## New-section review

### §2.7 `ask_kind` delivery split / founder push default OFF

**Sound and closed.** Current source parses exactly one optional runtime key, `founder_push`, validates it as boolean, and maps absence to false (`packages/v2-host/src/cli.ts:137-150,210`). `#ask` always enqueues to the issue Lead, and only calls the founder relay when `askKind === "progress"` and the option is true (`packages/v2-host/src/host.ts:1177-1209`). The pure routing matrix passed 6/6 in this review. `ask` and `blocked` cannot enter the relay helper through this call site.

One documentation note is advisable: the runtime config is read at host startup, so changing `founder_push` requires a host restart unless hot reload is separately introduced. This is not an approval blocker.

### §2.8 `issueTitle` into spawn context

**Propagation seam is sound; ingress contract is incomplete.** At the reviewed HEAD, `IssueDagDescriptor.issueTitle` is validated and stored in the `dag_issue` envelope (`packages/v2-dag/src/types.ts:164-173`; `packages/v2-dag/src/admission.ts:24-30,283-290`), `launchContext` reads it (`packages/v2-host/src/runtime-ports.ts:295-328`), and the launcher includes it in the bootstrap prompt (`packages/v2-host/src/tmux-runner-launcher.ts:270-284`). The launcher test file passed 22/22, including the title case.

However, the plan says “ingress 从 Linear 带入” while naming no actual producer. The only non-test in-repo call to `admitIssueDag` is the generic CLI request boundary (`packages/v2-cli/src/cli.ts:386-390`); no Linear-to-descriptor builder was found. Because `issueTitle` is optional and empty is accepted, the current acceptance path does not guarantee the founder directive for real Linear issues. See Finding 8.

### §2.5 Codex contract switch

**Bare-TUI decision is sound; replacement runner contract is not yet sound.** The spike shows `thread/resume` and `turn/start` succeed on an externally spawned app-server while the existing pane renders nothing (`FLY-1547-codex-wake-result.md:7-24`). The raw log shows an in-progress turn and agent-message deltas on the app-server side (`codex-wake-spike-output.log:29-46`), with no `turn/completed` record. This is sufficient negative evidence that the bare TUI must be rejected; it is not evidence for the proposed remote-attached runner lifecycle.

## Red-line / requirement matrix

| Requirement / red line | R2 judgment | Evidence |
|---|---|---|
| One process, three faces | **NOT SATISFIED** | The plan explicitly redefines this as one package running in two runtime positions (`plan:32-34`), plus a per-session detached Codex app-server. No single process owns all three faces. See Finding 5. |
| `next` creates the read claim | **PARTIAL, NOT CRASH-SOUND** | The Lead control-flow direction is correct, but the host-response/MCP-response boundary and existing delivery replay contradict the promised same-envelope resume. See Finding 1. |
| FYI settles on read without silent loss | **NOT SATISFIED** | Delayed ack avoids early `applied`, but the preceding envelope may become non-replayable after host flush. See Finding 1. |
| Ask settles only after one durable reply | **NOT SATISFIED** | Ordering is present; stable route and cross-generation idempotency are not. See Finding 3. |
| Bell carries pointer only; body via `next` | **SATISFIED IN DESIGN** | All three bell routes carry only a pointer and never settle the mailbox row (`plan:89-100`). |
| Paste only as last resort | **SATISFIED IN ROUTING INTENT** | Bare TUI and failed/stale official channels route to the issue-authorized pointer-only paste (`plan:91-106`). |
| No new feature flags | **SATISFIED WITH FOUNDER EXEMPTION** | `founder_push` is the sole added flag and is explicitly founder-directed/default-off (`plan:119-130,148-150`). |
| No new daemon | **NOT SATISFIED / AUTHORITY NEEDED** | The new design launches a detached, long-lived app-server per Codex session. Calling it a “per-session adjunct” does not remove its daemon/process lifecycle. See Findings 4 and 5. |
| No new fallback | **SATISFIED UNDER THE EXPLICIT POINTER-PASTE EXCEPTION** | No body-delivery fallback was added. |
| Agent-agnostic | **PARTIAL** | The five tools and settlement vocabulary are vendor-neutral, but Codex activation/lifecycle and Lead registration remain vendor-specific incomplete contracts. |
| Fail loud | **NOT SATISFIED END TO END** | Lease fail-stop is improved, but normal omitted mailbox kinds wedge as “unknown,” and bell external-effect recovery is not durably owned. See Findings 2 and 7. |
| Import, do not copy | **MOSTLY SATISFIED** | Existing Codex daemon/client seams are imported and the v1 lease helper is extracted. The unused teamlead facade is unnecessary scope. See Finding 9. |

## Findings

### 1. [HIGH] The promised response-loss redelivery contradicts the current delivery-action state machine; delayed FYI ack can leave a non-replayable running attempt

The revised contract says that after the host claim commits but the MCP/model does not receive the result, the processing attempt remains `running` and the next `next` resumes the same envelope (`plan:38-49`). Current source does not do that:

- `prepareDelivery` returns no envelope when the same delivery action has already reached `succeeded` (`packages/v2-host/src/delivery.ts:152-223`).
- A session `next` records that delivery as succeeded when the host socket frame flushes (`packages/v2-host/src/host.ts:1461-1485`).
- A replay with no envelope throws “already handed … settle … or report the ambiguity” (`packages/v2-host/src/host.ts:1474-1479`).
- The existing protocol states explicitly that a host response flush does not prove the recipient read it (`packages/v2-host/src/delivery.ts:39-46`).

Therefore this concrete window remains:

1. host claims the row and returns an envelope;
2. host socket write flushes, so `mailbox.deliver` becomes `succeeded`;
3. the mailbox MCP dies before its tool response reaches the model;
4. delayed FYI ack never runs;
5. the next `next` sees the same running attempt but cannot reconstruct/return its envelope.

The row is not silently `applied`, but it is durably stuck/ambiguous rather than at-least-once redelivered. That does not close R1 Findings 1 or 2.

The Lead refactor is also incomplete at the control-flow level. Today registration starts `#runLead`, and that method not only polls: it owns conversion action draining and calls `submitProposal`/`reportConversionFailure` (`packages/v2-engine/src/driver.ts:125-157,425-523`). The non-session host settle path requires the in-memory converter entry and otherwise throws “no host converter is waiting” (`packages/v2-host/src/host.ts:1617-1675`). The plan retires `#runLead` as a pull loop but does not name the replacement path that preserves `currentAttemptUid`, capability delivery, converter ownership, and settlement across host restart.

**Required change**: freeze and implement one exact runner/Lead delivery state machine that distinguishes host-frame flush from MCP-tool-result handoff. If the accepted contract is same-envelope retry, retain/reconstruct the envelope and capability for the same running attempt after a succeeded transport action; if that cannot be made safe, state a different founder-approved read boundary and recovery ceremony. Add fault injection at: claim commit, host frame flush, MCP result flush, delayed FYI submit, host restart, and Lead generation takeover. For Lead, specify the exact `pollOnce → prepare → pending/converter → submit` owner after `#runLead` changes.

### 2. [HIGH] The “closed shared disposition” list omits current production mailbox traffic and is located where its other claimed consumers cannot share it

The plan enumerates only a small FYI/actionable set and defers the real repository audit to implementation (`plan:51-57`). Current production append sites already emit omitted kinds, including:

- dynamic `task_contract_invalid_repeat` / `task_dispatch_invalid_repeat` (`packages/v2-dag/src/dispatch.ts:286-318`);
- `attempt_lost_open_candidate` (`packages/v2-dag/src/dispatch.ts:1249-1291`);
- `span_anchor_diverged` and `review_family_exhausted` (`packages/v2-dag/src/completion.ts:433-468,578-615`);
- `ship_authorized` and `ship_action_blocked` (`packages/v2-dag/src/gate.ts:500-543,642-658`);
- `ship_retry_exhausted` (`packages/v2-dag/src/reconcile.ts:67-87`);
- `lost_writer_span_adopted` (`packages/v2-dag/src/writer-gap.ts:562-586`).

Under the stated unknown-kind behavior, these normal rows fail-loud and remain pending indefinitely. That is fail-closed for corruption but a production wedge for known traffic.

The proposed single source is also inside `v2-mailbox-mcp`, while `mailbox_status` promises chapter counts and the engine doorbell needs actionable/overdue behavior. Host/DAG cannot import a service package that itself imports the CLI/host client without creating a reversed dependency or duplicating the classifier. The current `mailbox_status` implementation exposes raw kind/ask-kind groups rather than the plan’s `chapters`, illustrating the unresolved seam (`packages/v2-host/src/host.ts:994-1065`).

**Required change**: complete the append-site inventory before approval, classify every current recipient/kind/payload shape, and place the pure policy in a dependency-neutral shared module used by MCP, status projection/protocol text, and doorbell tests. Add an executable source-of-truth test that fails whenever a production append site introduces an unclassified kind; “grep during implementation” is not a closed design.

### 3. [HIGH] `settle(reply)` still allows a wrong reply route and its idempotency key changes across takeover; optional random `send` keys are not retryable after response loss

The incoming `runner_ask` already contains the authoritative `session_ref`, `uid`, and `ask_kind` (`packages/v2-host/src/host.ts:1177-1189`), and the existing reply shape routes `ask_response` to that session with payload `{v, uid, body}` (`packages/v2-host/src/__tests__/runner-injection.test.ts:411-438`). The proposed `settle({reply:{to,kind,body}})` instead lets the model select `to` and `kind` (`plan:59-74`). A first, syntactically valid but wrong route can be enqueued successfully and then the original ask settled.

The canonical source id `<message_uid>:<answerer agent_id>:<generation>` only deduplicates within one Lead generation. If generation A enqueues the reply and dies before settlement, generation B can receive the same pending ask and generate a different source id, producing a second answer. Generation belongs in authorization/fencing, not in the stable dedup family for the same question.

Generic `send` has the same response-loss hole: when the caller omits `dedupe_key`, the server generates a random value and returns it. If that first response is lost, the caller cannot know the key it must reuse and a retry creates a second message.

**Required change**: make reply input body-only (or reject any route that differs from the incoming envelope), derive recipient/kind/ask correlation server-side, and use a stable message/ask-scoped source id that survives Lead takeover while separately fencing the answering generation. Require a caller-provided `send` key or derive one from a durable caller operation; do not promise retry safety for a key that exists only in a lost response. Re-run the R1 crash/concurrency matrix including takeover between enqueue and settle.

### 4. [HIGH] The Codex spike proves only the bare-TUI negative; the replacement runner form lacks thread bootstrap plus detached-daemon restart/teardown ownership

The negative spike is valid and useful. It proves the current bare TUI must never receive an external app-server `turn/start` (`FLY-1547-codex-wake-result.md:7-24`). It did not launch the proposed runner form, and the plan acknowledges that exact runner context is unverified (`plan:180-184`).

The cited FLY-398 implementation is not just “socket path + `resume --remote`”:

- the window requires a pre-existing explicit `threadId` (`packages/teamlead/src/lead-backends/codex/tui-window.ts:29-36,67-97`);
- the runtime resumes or creates the thread and persists its id (`packages/teamlead/src/lead-backends/codex/codex-lead-tui-runtime.ts:523-550`);
- it runs a bounded first bootstrap turn because a turnless thread has no persisted rollout and cannot be resumed after eviction (`codex-lead-tui-runtime.ts:668-684`);
- shutdown explicitly tears down the remote TUI (`codex-lead-tui-runtime.ts:952-965`).

The revised runner plan says “resume the recorded threadId” but never says who performs `thread/start`, persists the id before the TUI attaches, delivers the runner’s first bootstrap envelope, handles turnless recovery, or arbitrates simultaneous TUI/sender clients. Current runner state has no daemon/thread ownership fields and current launch/stop manages only the tmux process (`packages/v2-host/src/tmux-runner-launcher.ts:82-94,1031-1137,1209-1223`).

The imported daemon is detached and owns a separate process group (`packages/claude-runner/src/codex-daemon-runtime.ts:652-668`). Its own contract requires group-wide `stop()` followed by `ensureDead()` and uses persisted process-group/socket-holder proof for crash recovery (`codex-daemon-runtime.ts:284-308,371-451`). “随会话生灭” is not a lifecycle design: launcher failure, host restart, activation crash, normal stop, and stale live socket all need an exact owner and proof of absence.

Finally, `turn/start` is an external effect. A crash after the turn starts but before `session_bell_rung` commits can start it again. The imported client already supports `clientUserMessageId` (`packages/claude-runner/src/codex-daemon-client.ts:513-526`), but the plan does not derive/use a stable bell id.

**Required change**: spike the exact proposed v2 runner form before accepting it. Freeze thread creation/persistence, first-envelope bootstrap, remote attach readiness, turnless recovery, sender concurrency, stable `clientUserMessageId`, durable bell intent/outcome, host-restart adoption/reap, and every teardown/error path (`stop` + `ensureDead`). If that spike fails, make pointer-only tmux ringing the complete current Codex contract and delete the unshippable sender/daemon switch from this issue.

### 5. [HIGH] The plan still redefines rather than satisfies “one process, three faces,” and now adds a detached per-session daemon

R1 explicitly required reconciliation with the literal issue contract. Round 2 instead says “一个进程” means one executable/package used in two runtime positions and asks review to waive the mismatch (`plan:32-34`). A package is not a process. The MCP child owns tools/Claude channel, the engine owns the Codex sender invocation, and the proposed Codex app-server is another detached, long-lived process.

The same mismatch appears in the red-line matrix: “per-session adjunct” does not make the app-server cease to be a daemon or remove its independent process/socket/restart lifecycle (`plan:148-155`). This may be a reasonable architecture, but reviewer discretion cannot amend an explicit founder/issue red line.

**Required change**: obtain and record an explicit authority amendment accepting this multi-process shape, or redesign so the approved owner/process boundary really holds all three faces. Also explicitly rule whether a per-session detached app-server is permitted under “不新增守护.” Until then both matrix rows remain unmet.

### 6. [HIGH] The claimed existing Claude Lead `register-lead`/credential lifecycle is absent from the named production launcher

The revised plan says the Lead delivery credential “已由 `register-lead --delivery-credential-out` 落盘” and that the existing registration flow rewrites it on takeover (`plan:108-117`). Current `packages/teamlead/scripts/claude-lead.sh` only materializes the legacy CommDB `flywheel-inbox` MCP (`claude-lead.sh:2142-2169`) and loads its development channel (`claude-lead.sh:2333-2358`). It contains no `register-lead` invocation or v2 delivery-credential path.

The actual CLI registration requires a live PID/start identity, host epoch, session id/proof root, agent, instance, socket/secret, and output path (`packages/v2-cli/src/cli.ts:491-524`). The only named production caller found is the separate Discord outbound service, registering `discord-messenger` with its own random instance and credential (`packages/teamlead/src/v2-discord-outbound.ts:169-188`). That is not a reusable Claude Lead registration.

Adding an MCP entry and credential environment variable to `claude-lead.sh` cannot authenticate a credential that no owner creates or rotates. If the stdio MCP child registers itself, its PID/session binding and fail-stop lifecycle differ from the long-lived Lead and must be designed explicitly.

**Required change**: name the process that owns Lead registration; specify where it obtains socket/secret/epoch/proof-root, which live PID and session are bound, when takeover atomically replaces the credential, how the MCP child observes rotation, and how old credentials/children are revoked. Add the exact launcher/service file and restart/takeover ordering to the change list.

### 7. [MEDIUM] `max_pending_seq` fixes the status projection but the durable ring cursor/effect owner and crash recovery are still unspecified

The revised status data can detect same-count replacement, which closes R1’s original projection defect (`plan:76-87`; current implementation at `packages/v2-host/src/host.ts:994-1065`). The design never states where the per-recipient/channel last-rung high-water and overdue episode live.

For the Claude channel the polling MCP can either ring all current pending mail again after restart or initialize its cursor to the current maximum and suppress mail whose earlier ring never completed; neither policy is frozen. Its five mailbox verbs have no described durable event/cursor write. For the engine/Codex path, an external bell can succeed before `session_bell_rung` commits, causing a duplicate token-consuming turn on replay. `session_bell_rung` is named, but the writer, ordering, and replay algorithm are not.

**Required change**: define a durable bell intent/cursor keyed by recipient, channel, `max_pending_seq`, and overdue episode; name its single writer and recovery sequence. Use a stable Codex `clientUserMessageId`. Test crash before effect, effect-success/commit-loss, restart with an existing pending batch, same-count replacement, and overdue re-ring.

### 8. [MEDIUM] `issueTitle` reaches the prompt only if an unnamed upstream producer supplies it; the claimed Linear ingress is not part of the design

The newly landed descriptor-to-prompt path is correct, and its local launcher test passes. But the actual founder outcome is “real issues spawn with their title,” not merely “an optional descriptor field is propagated when present.” The plan names “ingress from Linear” but no caller/file/API contract; the only non-test repo entry is a generic CLI request cast. Optional/blank input is silently omitted.

**Required change**: name and change the authoritative Linear/admission request producer, require a non-empty title on that real path (while preserving optional compatibility only for legacy/direct fixtures if necessary), validate a bounded safe string, and add an end-to-end fixture from ingress request through admission digest/`dag_issue`/`launchContext` to the runner prompt.

### 9. [LOW] The teamlead facade is explicitly unused and should not be delivered just to make an earlier review claim look closed

The revised sender correctly imports the existing `flywheel-claude-runner` daemon/client exports. The plan nevertheless adds a new teamlead subpath facade while admitting this issue does not consume it, solely “以关掉声称可 import 实则不可的账” (`plan:136-140`).

**Required change**: remove the unused facade from this issue, or name a real in-scope consumer and test. Review findings are closed by an accurate executable design, not inert exports.

## Verification performed

- Final source pin: `git rev-parse HEAD` → `335cb684360021e4c5800d4886368135b7cc2ea4`; `git status --short --branch` showed a clean branch equal to origin.
- `pnpm --filter flywheel-v2-host exec vitest run src/__tests__/ask-founder-routing.test.ts src/__tests__/runner-injection.test.ts`:
  - `ask-founder-routing.test.ts`: **6/6 passed**;
  - `runner-injection.test.ts`: could not start the Unix socket in this sandbox (`listen EPERM` at `host.sock`). This is environment evidence, not a product failure and not a pass.
- `pnpm --filter flywheel-v2-host exec vitest run src/__tests__/tmux-runner-launcher.test.ts`: **22/22 passed**, including the `issueTitle` bootstrap case.
- The review did not claim `pnpm lint`, a full build, full package tests, or the plan’s real-machine remote-attached Codex E2E; those were not run here and the latter is explicitly absent from the submitted evidence.

## Final decision

The round-2 plan closes R1 Findings 6 and 10, substantially closes the import/reuse portion of Finding 9, and improves but does not finish Findings 5 and 7. It does not genuinely close the core delivery/read semantics (R1 1–2), disposition (4), reply idempotency (3), or Lead registration (8). The literal one-process/no-new-daemon red lines also remain unresolved, and the replacement Codex runner form needs exact-form evidence and a full lifecycle contract before implementation.

VERDICT: CHANGES REQUESTED
