# FLY-1547 Design Review — Round 1

**Review target**: `doc/engineer/plan/draft/FLY-1547-mailbox-service.md`  
**Reviewed checkout**: `b5dd9450d08292fd690235212f12a545ed0c22b2` (`feat/fly1547-mailbox-service`)  
**Scope**: design only; cross-checked against the current v2 host/kernel/delivery/launcher code, the FLY-1546 feasibility artifacts, and the named v1 precedents.

## Executive assessment

The direction is right in two important respects:

1. replacing “paste the body and immediately CAS the mailbox row to applied” with “ring only; retrieve the body through `next`” fixes the current doorbell’s most serious semantic error (`packages/v2-dag/src/doorbell.ts:46-55,88-95,124-150`);
2. reusing the existing proposal settlement is the correct kernel seam. A successful proposal already commits effects, `mailbox.state='applied'`, and `processing_attempts.outcome='succeeded'` in one kernel transaction (`packages/v2-engine/src/settlement.ts:214-305`), while identical replay is accepted and a different digest is refused (`packages/v2-host/src/host.ts:1556-1585,1596-1613`).

However, the proposed design does not yet satisfy the issue’s central “read receipt” and “one process, three faces” contracts. It also leaves crash windows in both FYI auto-settlement and ask reply ordering, and its Claude/Codex bell health detection can silently strand pending mail. FLY-1546 proves that Claude and Codex can call a read-only MCP tool and that Claude channel injection works; the evidence explicitly does **not** prove a real `next`/`processing_attempts`/settlement path, and it did not test Codex push (`FLY-1546-result.md:41-50`). Those untested parts are precisely where the blocking gaps lie.

## Requirement / red-line matrix

| Requirement | Judgment | Reason |
|---|---|---|
| One process, three faces | **Not satisfied** | The plan creates one MCP child per session for tools + Claude channel, but places the Codex sender in the host/doorbell and spawns another app-server child per ring (`plan:38-42,75-85,127-131`). No process owns all three faces. |
| `next` records read in the same transaction | **Not satisfied** | Runner polling starts a processing attempt inside `pollOnce`, but before the response is flushed. Lead delivery is worse: the existing driver starts the attempt before an MCP `next` call at all. See Finding 1. |
| FYI settles on read | **Not sound yet** | The server plans to submit the empty proposal before returning the body, creating an applied-but-never-returned crash window. See Finding 2. |
| Ask settles only after reply | **Partially expressed, not crash-safe** | The ordering is written down, but the reply enqueue has no specified stable idempotency key or atomic coupling to settlement. See Finding 3. |
| Bell announces only; body comes via `next` | **Satisfied in intent** | The proposed bell text carries no body and the old paste-and-CAS path is removed (`plan:61-73,87-106`). |
| Paste only as last resort | **Partially satisfied** | The routing order says this, but channel health and Codex reachability are not actually provable, so fallback can either fail to engage or become the de facto primary path. See Findings 4 and 5. |
| No new feature flags / daemon | **Satisfied** | The design adds no rollout flag or independent daemon; stdio MCP children are session-owned. |
| No new fallbacks | **Satisfied only under the issue’s explicit paste exception** | The only message fallback is the issue-mandated terminal bell. Consent automation is launcher setup, not a second delivery contract. |
| Agent-agnostic | **Partial** | The mailbox/settlement seam is vendor-neutral, but tool identity and Lead wiring are underspecified, while the Codex path is a separate, unproven special case. |
| Fail loud | **Not satisfied** | A live PID lease can mask a broken status poll or channel notification forever, with no durable `session_bell_failed` event. See Finding 5. |
| Import v1; do not copy-paste it | **Not demonstrated** | The plan imports the Codex client seam, but the v1 inbox lease/poll/channel code is currently top-level and non-reusable; the plan does not identify an extraction/import seam. See Finding 8. |

## Findings

### 1. [HIGH] `processing_attempts` is a delivery/processing claim, not the proposed proof that MCP `next` was read; the Lead path can create it before `next` is called

The plan’s core assertion is that `pollRunnerDelivery` writes the `processing_attempts` row “in the same transaction,” and that this row therefore proves who read which message and when (`plan:44-59`). That assertion is not true across the named callers:

- For a runner, `pollOnce` inserts the row while selecting the candidate (`packages/v2-engine/src/consume-loop.ts:217-284`; `packages/v2-engine/src/transitions.ts:251-344`). The host only writes the delivery action outcome after the response frame flushes (`packages/v2-host/src/host.ts:1359-1376`). A disconnect between those points leaves a running processing attempt even though the MCP caller never received the body.
- For a Lead, registration immediately starts `EngineDriver.#runLead` (`packages/v2-engine/src/driver.ts:125-157,425-490`). That loop polls and starts the processing attempt, then the host converter merely queues the envelope and waits (`packages/v2-host/src/host.ts:920-963`). The later Lead `next_delivery` path drains/awaits that already-prepared envelope (`packages/v2-host/src/host.ts:1418-1505`). Thus the receipt is not created by `next`, much less in the same transaction as `next`.
- The existing protocol already states the underlying truth: the delivery response leaving the host does not prove the agent read it (`packages/v2-host/src/delivery.ts:39-46`). Renaming the processing attempt conceptually does not remove this crash window.

This breaks the issue’s explicit read-receipt requirement and makes the recorded timestamp misleading, especially for Leads.

**Required change**: make `next_delivery` itself the claim boundary for both runner and Lead. The Lead driver must not pre-poll/start an attempt before a `next` request. Either refactor Lead pull to the durable session-style path or introduce an equally explicit host-side pull transaction that validates the Lead credential, selects/resumes one message, and creates the processing attempt there. Document exactly what “read” means at the response-loss boundary and test: no call, disconnected call before response flush, successful call, and resumed call after host/MCP restart. If `processing_attempts` must remain the receipt per the issue, the control flow—not merely the label—has to make that true.

### 2. [HIGH] FYI auto-ack happens before the tool returns the body, so an FYI can be durably applied without ever reaching the model

The plan says MCP `next` will fetch an FYI, immediately issue an empty-effects `submit`, and only then return its content to the model (`plan:54-57`). If the submit commits and the MCP process/session dies before the tool response is delivered, the mailbox row is already `applied`; a later `next` cannot redeliver the FYI. This recreates, inside the MCP tool, the same “transport action is mistaken for recipient read” class that the doorbell rewrite is intended to remove.

The existing oneShot digest contract prevents a second *distinct settlement*, but it cannot make the later MCP response delivery atomic with the prior SQLite commit. The test plan only says “FYI auto ack exactly once” (`plan:136-142`); it does not cover the applied-before-tool-result crash window.

**Required change**: define an explicit, reviewable read boundary and make the FYI state machine consistent with it. At minimum, add a durable delivered/read stage that can distinguish “host claimed” from “MCP result actually handed back,” or change the product contract so a model-issued `next` invocation (not receipt of its result) is explicitly the accepted read event. If the latter is the founder-approved meaning, the plan must say so and add a failure-injection test at each boundary: after host `next`, after empty submit commit, and before MCP response flush. Do not claim end-recipient read evidence while accepting silent loss in that window.

### 3. [HIGH] “Send reply, then settle ask” has no idempotency/atomicity design, so crash replay can send duplicate answers

The plan correctly orders Lead handling as `send ask_response` followed by `settle` (`plan:56-59`), but the two calls are separate transactions. A crash after reply enqueue and before settlement leaves the original `runner_ask` pending. On redelivery, the Lead can send the answer again.

The existing protection is available but the plan does not bind to it: `enqueue` deduplicates only by canonical `(source_kind, source_id)` and rejects a conflicting replay (`packages/v2-engine/src/enqueue.ts:120-123,162-198`). The proposed `send` contract lists only recipient/kind/retention validation (`plan:46-52`) and never defines caller-supplied or server-derived canonical source identity. oneShot proposal digest only protects the later settlement; it does not protect the preceding reply side effect.

**Required change**: specify the complete `send` schema and a server-derived idempotency key for replies, bound to the incoming `message_uid`/ask `uid`, sender generation, recipient session, and reply kind. Prefer a narrow `reply`/`reply-and-settle` host operation if the issue allows it; otherwise prove that repeated `send` uses the byte-identical canonical source and that a different reply conflicts fail-loud before settlement. Add crash tests for: enqueue committed/response lost, enqueue committed/process dies before settle, identical replay, conflicting replay, and two concurrent settle attempts.

### 4. [HIGH] The two-chapter classifier is contradictory and not a closed server-side contract

The plan classifies “progress” as FYI but also places `runner_ask` in the requires-settle chapter (`plan:54-58`). In current source, `ask`, `progress`, and `blocked` all enqueue with **the same mailbox kind** `runner_ask`; only `payload.ask_kind` distinguishes them (`packages/v2-host/src/host.ts:1021-1087`). Therefore a kind-only classifier cannot implement the existing protocol, which says progress asks settle immediately but answer-requiring runner asks settle after the reply (`packages/v2-host/src/delivery.ts:71-75`).

The ellipses in both kind lists are also unsafe. `mailbox.kind` is a non-empty string, not a closed database enum (`packages/v2-engine/src/enqueue.ts:104-110,162-174`). A new or malformed kind could be silently auto-settled if matched too broadly, or wedge forever if matched too narrowly.

**Required change**: define one exhaustive, shared `settlementDisposition(envelope)` policy in an importable module. It must validate structured `runner_ask` payloads, classify `progress` separately from `ask`/`blocked`, enumerate every current lifecycle kind, and default unknown/malformed inputs to fail-loud + remain pending. Use this same policy for MCP behavior, protocol text, and tests; do not duplicate an informal list in prompts.

### 5. [HIGH] The Codex “official sender” is not a demonstrated wake of the running TUI and its proposed lifecycle can terminate the turn it just started

The current runner is a plain `codex` TUI launched in tmux, not a TUI attached to a persistent remote app-server (`packages/v2-host/src/tmux-runner-launcher.ts:313-365`). The plan proposes spawning a *new* `codex app-server`, resuming a scraped thread id, calling `turn/start`, and then closing that process (`plan:75-85`). This has four blocking problems:

1. `turn/start` only acknowledges/returns an active turn id; turn completion arrives later as `turn/completed` (`CodexLeadProcess.ts:409-429,525-529`). Closing the child immediately can kill the bell turn before it runs.
2. The new app-server executes a second, hidden turn. The plan itself admits it will not render in the running TUI (`plan:83-85`). That is not a wake of the target session; it may instead create a competing mailbox consumer whose output the operator/model in the pane never sees.
3. “Read the latest rollout under `CODEX_HOME/sessions`” is not an identity binding. Concurrent Codex launches sharing `CODEX_HOME` can select another session’s thread. Current runner state has no thread field (`tmux-runner-launcher.ts:82-94`), and the launcher does not request a deterministic Codex thread id.
4. FLY-1546 only proved MCP tool use under `codex exec`; it explicitly did not test Codex push (`FLY-1546-result.md:48-51`).

The risk is acknowledged, but leaving a core requirement conditional on implementation-time discovery is not a complete design. Keeping an inert sender “for a future app-server form” is also out-of-scope machinery, not fulfillment of today’s TUI contract.

**Required change**: run a focused pre-implementation spike against the exact current tmux TUI form and freeze one viable contract: either inject/steer through the app-server actually backing that TUI with a deterministic thread/turn identity, or state that no official Codex wake exists today and use the issue-authorized pointer-only terminal bell as the current Codex path. If a new app-server process remains, specify config/policy parity, exact thread ownership, wait-for-completion/timeout/cleanup, server-request handling, and proof that it cannot consume mail on behalf of the wrong or hidden agent. Reconcile this with the literal “one process, three faces” requirement rather than redefining it as two faces in one MCP child plus a separate host child.

### 6. [HIGH] A live PID lease does not prove the Claude bell path is healthy, so the engine can suppress the last-resort bell while failures remain silent

For Claude, the doorbell does “nothing” whenever the MCP lease PID appears live (`plan:87-103`). The proposed lease only proves that the stdio server once started. It does not prove that:

- `mailbox_status` can still reach/authenticate to the host;
- the 1-second poll loop is still running;
- `notifications/claude/channel` was accepted by the client;
- the dev-channel consent state is complete.

The v1 precedent writes its lease after transport connect and logs poll failures to stderr (`packages/inbox-mcp/src/index.ts:168-195,197-252`), but even that source explicitly relies on separate ack/retry behavior for the remaining readiness race (`index.ts:227-230`). In this plan the engine trusts the lease and skips its fallback, while the MCP background failure has no path to append the promised durable `session_bell_failed` event. A live-but-broken child can therefore strand pending mail quietly, violating “fail loud.”

**Required change**: define a health-bearing lease/heartbeat or a fail-stop contract. Repeated status/channel failure must invalidate/unlink the lease (or exit), and the existing host/coordinator must durably emit a deduplicated failure with session/message context before selecting the pointer-only terminal bell. Tests must cover live PID + dead host socket, channel notification rejection, consent not completed, stale lease/PID reuse, MCP restart, and recovery without duplicate body delivery.

### 7. [MEDIUM] `mailbox_status` does not expose the sequence information required by the proposed bell dedup algorithm

The proposed status response contains pending count plus oldest age per kind (`plan:46-52,61-71`), but the bell algorithm says “ring once for the same batch; ring again only when a new `seq` appears.” Count/kind/age cannot detect that condition. For example, settling one message while another is enqueued can leave the count unchanged; age changes continuously and cannot be used as a stable batch key. The plan also proposes `session_bell_rung` keyed by `message_uid`, yet an aggregate status response does not expose message UIDs.

**Required change**: add a non-content stable high-water field such as `max_pending_seq` plus clearly defined unread/in-progress counts, or return a bounded digest of the pending UID set. Specify restart behavior and overdue re-ring timing using existing config/fields, not an unstated hard-coded threshold. Add the replacement-at-same-count and settle/new-enqueue race tests.

### 8. [MEDIUM] Lead installation and identity lifecycle are promised but absent from the file/wiring plan

The plan says a long-lived Claude Lead will register the same MCP server and use `--agent` plus its delivery credential (`plan:108-115`), but the change list only wires `tmux-runner-launcher.ts` (`plan:127-132`). That launcher creates runner sessions, not the long-lived Lead process. No named module owns:

- registering/re-registering the Lead MCP config;
- placing and rotating the credential file across generation takeover;
- setting the Lead’s MCP environment;
- removing/replacing the MCP child on Lead restart.

Identity selection is also ambiguous: runners already receive `FLYWHEEL_V2_AGENT_ID=${taskKind}` even though their ledger recipient is `FLYWHEEL_V2_SESSION_REF` (`tmux-runner-launcher.ts:1055-1066`). A generic server that treats `FLYWHEEL_V2_AGENT_ID` as Lead identity can select the wrong mode unless precedence and exact env schemas are frozen.

**Required change**: name and include the actual Claude Lead launcher/config builder and credential lifecycle in the change list. Define mutually exclusive runner vs Lead startup schemas, fail on mixed/partial identity, and test takeover/restart/revoked credential behavior. If Lead MCP installation is not part of this issue, remove the acceptance claim rather than leaving it implied.

### 9. [MEDIUM] The claimed reuse/import seams do not match the current exports, and the v1 inbox reuse boundary is unspecified

The plan says the sender will reuse both `CodexLeadProcess` and `spawnCodexAppServer`, while adding only a `./lead-backends/codex/codex-lead-process` subpath export (`plan:75-85,129-131`). Today `CodexLeadProcess` is in `CodexLeadProcess.ts`, but `spawnCodexAppServer` is exported from `codex-lead-runtime.ts` (`packages/teamlead/src/lead-backends/codex/codex-lead-runtime.ts:1165-1229`). The proposed subpath cannot expose both without an additional narrow facade or re-export.

Likewise, the v1 inbox precedent places lease management, MCP construction, and the poll loop in a top-level executable with no reusable exports (`packages/inbox-mcp/src/index.ts:28-104,168-254`). A new package that recreates those blocks would conflict with the “import, do not copy-paste v1” red line unless the plan first extracts a shared module.

**Required change**: freeze exact package exports/imports and add all package manifest/build-order changes. Prefer narrow shared modules: one Codex app-server transport facade, and one reusable channel/lease helper extracted from v1 with reverse-compat tests for `flywheel-inbox-mcp`.

### 10. [LOW] The 1-second polling load claim is not supported by the v1 precedent cited

The plan says `1s × N` is production-proven because v1 inbox-mcp uses the same cadence (`plan:144-150`). v1 polls a local CommDB directly in each process; the new design sends every poll through one host socket/event loop and runs aggregate mailbox queries. Those are different contention and failure domains.

**Required change**: keep the simple 1-second cadence if desired, but label it as an assumption and add a bounded multi-session load test (including host restart and synchronized reconnect). A small per-process startup jitter/backoff can avoid a thundering herd without adding a feature flag or daemon.

## Kernel / ledger conclusion

- **oneShot settlement**: sound in the current kernel/host implementation when the MCP wrapper faithfully reuses the exact envelope handle, capability, and byte-identical effects. Identical successful replay returns the stored receipt; different effects conflict.
- **No double-settle**: sound for the proposal itself. It does **not** deduplicate a separate reply/send side effect; Finding 3 must be closed.
- **`processing_attempts` as read receipt**: not sound under the planned callers. It currently records a processing/delivery attempt, and the Lead driver can create it before `next`. Finding 1 is a fundamental redesign item, not a documentation tweak.
- **FYI one-call semantics**: not sound at the MCP-response crash boundary as written.

## Minimum bar for Round 2

1. Rework Lead pull so the processing attempt is created by the authenticated `next` operation, and state the accepted response-loss definition of “read.”
2. Freeze an exhaustive settlement-disposition policy, including `runner_ask.payload.ask_kind`, unknown-kind fail-loud behavior, and FYI crash semantics.
3. Add idempotent reply identity or an atomic reply-and-settle operation.
4. Resolve the Codex TUI wake with exact-form evidence and deterministic session/thread binding; remove the speculative sender if it cannot wake the active TUI.
5. Make Claude lease health failure visible and fallback-capable.
6. Add the status high-water mark, actual Lead launcher/credential wiring, exact import seams, and crash/concurrency E2E cases described above.

VERDICT: CHANGES REQUESTED
