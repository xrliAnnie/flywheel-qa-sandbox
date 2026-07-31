# FLY-1547 Design Review — Round 3

**Review target**: `doc/engineer/plan/draft/FLY-1547-mailbox-service.md`  
**Prior reviews**: `/tmp/fly1547-design-review-r1.md`, `/tmp/fly1547-design-review-r2.md`  
**Reviewed landed pin**: `3c113dda6ab812cc06c6c9cc9d80cdc6d78c038a` (`feat/fly1547-mailbox-service`, equal to `origin/feat/fly1547-mailbox-service` at the final pin)  
**R2 baseline**: `335cb684360021e4c5800d4886368135b7cc2ea4`  
**Authority evidence**: production mailbox reply `8e2c14c4-cbfc-4160-9f72-63bc4600c747`, read directly from the v2 database  
**Scope note**: four additional commits landed and were pushed while this review was running: Codex remote-attached launch (`e93e6d61`), Codex official bell (`fe7a026a`), Lead launcher wiring/ops notes (`186bdb65`), and protocol/manual text (`3c113dda`). They are included as actual landed code, not treated as future plan. After the clean `3c113dda` build/test run, a new uncommitted remediation delta appeared in `v2-cli`, `v2-dag`, `v2-host`, and `v2-mailbox-mcp`; it is not part of the pushed PR head and is excluded from closure judgments.

All source line references below are to the reviewed landed pin unless explicitly qualified otherwise.

## Executive assessment

Round 3 contains substantial real progress:

- response-loss redelivery is implemented for runner and Lead delivery;
- Lead pull now claims at `next`, and Lead settlement no longer depends on an in-memory converter;
- the settlement classifier is in a dependency-neutral package;
- reply routing and reply/send source identities are materially safer;
- the doorbell is pointer-only and has a durable high-water cursor;
- the v1 channel lease was extracted rather than copied;
- the five-tool mailbox MCP exists with tests;
- the remote-attached Codex experiment proves that an externally injected bell turn can render in an attached TUI;
- Claude runner MCP/channel wiring, Codex daemon/thread/TUI wiring, the Codex bell route, and `claude-lead.sh` MCP registration are now landed.

Those accomplishments close several R2 objections, but the submitted design and implementation are not ready for approval. Six correctness/lifecycle defects remain blocking:

1. the lost-handoff proof assumes serialized MCP calls, but `MailboxService`, the MCP SDK, and `V2Client` do not serialize them;
2. an actionable `runner_ask` can be settled without any durable reply, and an unknown/malformed message can be settled through the ordinary tool;
3. a failed Claude channel notification refreshes the lease and resets the failure counter before failing, so notification failure can permanently suppress the pointer-paste fallback;
4. Lead takeover rewrites one shared credential file while every old and new MCP rereads it, allowing the superseded MCP to adopt the new bearer instead of being fenced;
5. Codex turn delivery treats `turn/start` RPC acceptance as turn completion and `clientUserMessageId` as idempotency, so assignment and bell effects can be lost or duplicated;
6. the Codex daemon lifecycle is not restart-safe: production persists `daemon_pgid:null`, launch failure can leak a daemon, probe ignores the daemon, and in-memory teardown ignores a failed `ensureDead()` result.

The two authority decisions exist and authorize the architectural outcome. Ruling 1 is recorded faithfully. Ruling 2 authorizes remote-attached form A despite the daemon red line; the plan should record that exception honestly rather than rewrite it as compliance.

## R2 nine-finding closure audit

| R2 finding | R3 status | Actual-code/design judgment |
|---|---|---|
| 1. Host response-loss redelivery and Lead converter state | **PARTIALLY RESOLVED; BLOCKED** | `redeliverLostHandoffTx`, runner/Lead re-poll, host-owned Lead pull, and durable Lead settlement are real. The proof depends on the false assertion that the MCP serializes calls. Concurrent tool calls can crash-settle an envelope still in flight. See Finding 1. |
| 2. Closed disposition list and shared location | **PARTIALLY RESOLVED** | The policy is correctly located in `v2-dag` and current known kinds are classified. Unknown/malformed input is returned as an ordinary letter and can be explicitly settled, contrary to the fail-loud contract; the source roll-call does not actually close host or generic-send producers. See Findings 2 and 8. |
| 3. `settle(reply)` / `send` route and idempotency | **PARTIALLY RESOLVED; BLOCKED** | Reply route/kind are server-derived, the reply key is message-scoped and generation-free, and `send` requires a caller key. However, bare `settle()` still applies an answer-requiring ask, and the promised existing-reply readback has no service/host API. See Finding 2. |
| 4. Exact Codex runner form and lifecycle | **PARTIALLY RESOLVED; BLOCKED IN LANDED CODE** | The positive spike proves remote-attached visibility, and the launcher now uses a harmless READY turn before attaching. The code does not wait for READY completion, starts assignment fire-and-forget, has no effect reconciliation, and does not close restart/teardown crash windows. See Findings 5 and 6. |
| 5. “One process” / no-daemon authority | **AUTHORITY RESOLVED; IMPLEMENTATION CONDITION OPEN** | Both rulings are present and outcome A is authorized. The exact reply calls the per-session daemon the thing the hard red line was meant to stop, then chooses A because B lost production deliveries. The plan omits that exception, and landed lifecycle ownership does not yet meet the ruling’s condition. See Findings 6 and 7. |
| 6. Lead registration and credential lifecycle | **PARTIALLY IMPLEMENTED; NOT RESOLVED** | `claude-lead.sh` now registers the MCP/channel and ops notes name the external operator edit. The proposed shared-file/per-call reread contract defeats generation fencing, and the CLI writer is not atomic. See Finding 4. |
| 7. Bell cursor/effect ownership | **PARTIALLY RESOLVED; BLOCKED** | Pointer-only paste, `bell_cursor`, overdue re-ring, intent recording, and the Codex port landed. Claude notification health is incorrect, and Codex crash replay is not idempotent merely because the correlation field is stable. See Findings 3 and 5. |
| 8. `issueTitle` producer | **NOT RESOLVED AS A PRODUCTION CONTRACT** | The propagation path remains sound, and the plan now correctly identifies the human operator Lead as producer. Manuals landed, but the non-gating CLI warning did not, and neither a warning nor manual text guarantees that real admissions contain a bounded non-empty title. See Finding 9. |
| 9. Unused teamlead facade / shared lease | **RESOLVED** | The inert facade was removed from scope. `channel-lease.ts` is extracted and reused with reverse-compat tests. |

## Landed-code audit

### Delivery and Lead settlement

The core R2-F1 changes are real:

- `redeliverLostHandoffTx` CAS-settles the old running PA as `crashed` and records `delivery_handoff_lost` (`packages/v2-host/src/delivery.ts:255-314`);
- runner re-poll and Lead re-poll invoke it when a succeeded delivery action replays without an envelope (`packages/v2-host/src/host.ts:1473-1505,1552-1608`);
- Lead delivery is claimed inside authenticated `next_delivery`, and the response marks the delivery action succeeded only after frame flush (`host.ts:1571-1636`);
- the host creates `EngineDriver` with `leadMailboxPull: "host"` (`host.ts:457-462`), and the driver does not start its Lead mailbox loop in that mode (`packages/v2-engine/src/driver.ts:62-70,120-168,173-213`);
- a Lead proposal with no in-memory pending converter is durably settled and re-read for a succeeded receipt (`host.ts:1687-1711`).

This repairs the old converter/restart ownership problem. It is not sufficient because the redelivery predicate is only sound for one in-flight pull per recipient, and that condition is not enforced.

### Disposition and mailbox service

The shared classifier includes the current vocabulary and validates `runner_ask.ask_kind` (`packages/v2-dag/src/settlement-disposition.ts:26-110`). The mailbox service derives reply routing from the received ask, uses `mailbox_reply:<messageUid>`, and requires `send.dedupeKey` (`packages/v2-mailbox-mcp/src/service.ts:169-208,224-243`).

The landed service nevertheless contradicts the frozen design and newly landed protocol text:

- it allows `settle()` without `reply` for any outstanding actionable ask (`service.ts:157-217`);
- it returns unknown input as an ordinary `status:"letter"` and tells the model to settle it (`service.ts:135-143`); the unit test explicitly locks that behavior (`service.test.ts:229-244`), although plan §2.3 says unknown/malformed input must remain pending and surface as `isError`;
- the delivery protocol now says an answer-requiring ask settles only after its reply is sent (`packages/v2-host/src/delivery.ts`, `leadSettlement`), but the MCP surface does not enforce that rule.

### Doorbell, channel lease, and Claude launcher

The engine-side doorbell is pointer-only, does not settle the mailbox row, excludes already-claimed rows, and persists `bell_cursor:<sessionRef>` (`packages/v2-dag/src/doorbell.ts:12-38,88-135,202-232`). The shared lease predicate requires a live PID and fresh `lastOkAt` (`packages/inbox-mcp/src/channel-lease.ts:66-85`).

The Claude launcher correctly materializes the per-activation MCP config, passes authenticated paths/session identity, adds the development channel flags, and exposes the fresh-lease predicate (`packages/v2-host/src/tmux-runner-launcher.ts:367-415,734-791,1345-1418`). The final health chain is still unsafe because the MCP touches the lease before proving the notification succeeded. See Finding 3.

### Codex remote-attached form

The late slices are real:

- `prepareCodexRemote` imports `spawnCodexDaemon`, creates a thread, and starts a harmless READY turn (`packages/v2-host/src/codex-remote.ts:81-136`);
- runner state carries socket/thread/pid/pgid, and the pane uses `codex resume --remote` (`tmux-runner-launcher.ts:99-115,418-436,522-547`);
- activation sends the assignment as a real external turn, and the doorbell routes pointer turns through `codexBell` (`tmux-runner-launcher.ts:1345-1378,1421-1441`);
- runtime ports expose the Codex route to the DAG doorbell (`packages/v2-host/src/runtime-ports.ts:598-603,657-665`);
- stop attempts to pair tmux teardown with daemon teardown (`tmux-runner-launcher.ts:1530-1568`).

These implement the chosen shape but not its claimed completion, idempotency, or restart safety. See Findings 5 and 6.

### Lead wiring

`claude-lead.sh` now conditionally registers `flywheel-v2-mailbox`, supplies Lead identity/credential paths, adds the dev channel, and preserves disabled byte compatibility (`packages/teamlead/scripts/claude-lead.sh:2174-2210,2395-2400`). The repo-side wiring is present. The external registration edit and takeover lifecycle remain unsafe as documented in `doc/engineer/implementation/FLY-1547-ops-notes.md:7-23`. See Finding 4.

### Authority rulings

The production reply contains both requested decisions:

- ruling 1 says “one process” was legislative intent against a separately operated/restarted resident, and accepts two runtime positions when they share configuration and lifecycle;
- ruling 2 says the per-session daemon is exactly the kind of resident the hard no-daemon red line was meant to prevent, but selects remote-attached A because pointer paste had already lost three deliveries, the spike evidence favors A, and A preserves a visible TUI.

Reviewer authority is no longer the blocker. The remaining blockers are accurately recording the exception and making its lifecycle conditions true.

## Red-line / requirement matrix

| Requirement / red line | R3 judgment | Evidence |
|---|---|---|
| One process, three faces | **AUTHORIZED SHAPE; CONDITION NOT CLOSED** | Ruling 1 allows the package/two-runtime-position interpretation only when the parts share configuration and lifecycle. Codex daemon restart/teardown ownership is still incomplete. |
| `next` creates the read claim | **PARTIAL** | Runner and Lead now claim at authenticated pull, but parallel tool calls violate the one-pull premise. |
| FYI settles on read without silent loss | **PARTIAL** | Deferred FYI ack plus redelivery is materially better, but absent serialization permits a healthy handoff to be crash-settled by a concurrent call. |
| Ask settles only after one durable reply | **NOT SATISFIED** | `settle()` without `reply` applies `runner_ask`. |
| Bell carries pointer only; body via `next` | **SATISFIED** | Engine paste, Codex turn, and Claude channel notification contain only a pointer; rows stay pending. |
| Paste only as last resort | **NOT SATISFIED END TO END** | Routing intent is correct, but a failing Claude notification keeps refreshing a healthy lease and suppresses paste. |
| No new feature flags | **SATISFIED WITH THE EXISTING FOUNDER EXEMPTION** | No additional mailbox rollout flag was introduced; `founder_push` remains the separately authorized default-off flag. |
| No new daemon | **EXPLICIT AUTHORITY EXCEPTION; LIFECYCLE NOT CLOSED** | Ruling 2 selects form A despite identifying the daemon as a hard-red-line object. The exception is real; same-lifecycle proof is not. |
| No new fallback | **SATISFIED UNDER THE POINTER-PASTE EXCEPTION** | No body-delivery fallback was introduced. |
| Agent-agnostic tools and settlement | **MOSTLY SATISFIED** | The five tools and disposition are shared; vendor-specific activation/bell adapters are at the boundary. |
| Fail loud | **NOT SATISFIED** | Unknown messages are ordinarily settleable; notification failures can keep a healthy lease; Codex assignment failure is only stderr; Lead takeover can silently reuse the new credential in the old child. |
| Import; do not copy | **SATISFIED** | The channel lease is extracted/reused, and Codex imports existing daemon/client seams. |
| Real admissions include `issueTitle` | **NOT SATISFIED** | The field propagates when supplied, but the production producer remains non-gating human discipline. |

## Findings

### 1. [HIGH] Lost-handoff recovery depends on MCP serialization that does not exist

The redelivery implementation explicitly acknowledges that two concurrent pulls can crash-settle an envelope still in flight, then declares that “the MCP tool face serializes calls” (`packages/v2-host/src/delivery.ts:271-275`). The declaration is false:

- `MailboxService` has mutable `#outstanding` state but no mutex/single-flight wrapper (`packages/v2-mailbox-mcp/src/service.ts:94-145`);
- the MCP SDK starts each request on its own promise chain rather than a shared queue (`@modelcontextprotocol/sdk/dist/esm/shared/protocol.js:341-350`);
- every `V2Client.request` opens an independent host request, so the client does not serialize at the socket layer (`packages/v2-cli/src/client.ts:29-36`).

A direct concurrent-service probe confirmed that two `next()` calls can both enter `HostPort.next()` before either result is returned. In production, the later pull can observe the first delivery action as succeeded, crash-settle its still-live PA, and issue a new capability. The first caller then holds a capability fenced by the second caller. Concurrent `status`/`send`/`settle` calls can also race deferred FYI ack and `#outstanding`.

**Required change**: enforce the serial protocol in executable code. Put every model-facing mailbox operation that reads or mutates `#outstanding`/deferred ack behind one per-service async lock, define cancellation behavior, and add parallel-call tests that hold the first host promise open. Prove that a second `next`, `status`, `send`, or `settle` cannot reach the host until the first operation has installed/cleared its outstanding state.

### 2. [HIGH] The service can apply an answer-requiring ask without a reply and can normally settle unknown protocol input

`settle()` makes `reply` optional and unconditionally submits the outstanding envelope after the optional reply block (`packages/v2-mailbox-mcp/src/service.ts:157-217`). It never checks that an actionable `runner_ask` has a durably enqueued reply. A runtime probe with an `ask_kind:"ask"` envelope showed bare `settle()` returning success and calling `submit`.

Unknown/malformed input is also not fail-loud as specified. `next()` returns a normal letter with a note inviting explicit settlement (`service.ts:135-143`), `settle()` applies it, and the committed test requires that behavior (`service.test.ts:229-244`). `status()` folds unknown rows into the actionable count rather than exposing an error/debt class (`service.ts:254-269`).

The byte-different reply conflict path is incomplete too. The error text says “read it and settle without reply” (`service.ts:202-206`), but `HostPort` exposes no operation that reads the existing canonical reply. Bare settlement therefore cannot distinguish “this ask already has one proven durable reply” from “no reply was ever sent.”

**Required change**:

1. for `runner_ask` with `ask_kind in {ask,blocked}`, require either a successful/duplicate reply enqueue in this call or a durable lookup proving the canonical reply already exists;
2. keep unknown/malformed envelopes outstanding and return `isError` without offering ordinary settlement;
3. expose unknown debt separately in status/stderr;
4. test response loss after reply enqueue, generation takeover, identical replay, conflicting replay, and bare-settle rejection.

### 3. [HIGH] Claude notification failure refreshes channel health and can suppress the last-resort bell forever

`bellOnce()` reads status, immediately resets `consecutiveFailures` and touches `lastOkAt`, and only then awaits the channel notification (`packages/v2-mailbox-mcp/src/server-main.ts:180-194`). If notification delivery fails, the catch increments the just-reset counter from zero to one (`server-main.ts:195-204`). On the next poll, a successful status read resets it again and refreshes the lease before the next failed notification.

Consequences:

- notification-only failures never reach the five-failure fail-stop threshold;
- the lease stays fresh and `channelHealthy()` remains true;
- the engine defers its doorbell and does not paste the pointer (`packages/v2-dag/src/doorbell.ts:136-149`);
- the row remains pending with no usable announcement.

The timer has no in-flight guard (`server-main.ts:212-217`), so a slow status/notification can overlap the next poll and make counter/cursor ordering nondeterministic. The consent poller also treats pane-capture failure as success and its detached caller only writes stderr (`tmux-runner-launcher.ts:1380-1391,1443-1473`), weaker than plan §2.6’s “fail-loud 留事件.”

**Required change**: update `lastOkAt` and reset the failure counter only after the entire status-plus-notification cycle that needed to ring has succeeded; serialize bell polls; make five notification failures delete/expire the lease and surface a durable failure or equivalent host-visible error. Add a negative integration test proving that repeated notification rejection makes `channelHealthy` false and the engine rings the pointer fallback for the same pending sequence.

### 4. [HIGH] The Lead credential rotation lets the superseded MCP adopt the replacement generation’s bearer

The current operator script chooses the first matching Lead process and does not write a delivery credential (`/Users/xiaorongli/.flywheel/v2/bin/register-operator-lead.sh:3-15`). Ops notes propose adding `--delivery-credential-out` and state that takeover atomically rewrites the credential, fences the old MCP, and causes it to fail-stop (`doc/engineer/implementation/FLY-1547-ops-notes.md:7-23`). That contract is internally contradictory:

- every Lead MCP reads the same fixed credential file on every call (`packages/v2-mailbox-mcp/src/host-port.ts:17-40`);
- takeover overwrites that file with the new generation’s credential;
- the old MCP therefore stops presenting the revoked old credential and begins presenting the valid new credential;
- host authorization binds the bearer to agent/instance/generation, not to the calling MCP process, so the old child is accepted as the new generation.

The promised old-child fence cannot occur under shared-file per-call reread. In addition, `stashDeliveryCredential` uses `openSync(path, "w")` followed by write/fsync (`packages/v2-cli/src/cli.ts:298-316`); this truncates in place and is not an atomic rewrite. A crash can leave an empty/partial credential file after host registration revoked the old generation. `ps | head -1` can also bind takeover to the old Lead process when both are alive.

**Required change**: freeze a generation-safe lifecycle. For example, publish a generation-specific immutable credential file, have each MCP load/cache only its own generation at startup, revoke the old bearer before enabling the new child, and atomically publish via private temp file + fsync + rename + directory fsync. Name how the operator selects the exact new Lead PID/session, how the old child is stopped, and what happens in every crash window. Add a real takeover fixture with both old and new MCP children.

### 5. [HIGH] Codex assignment and bell delivery mistake RPC acceptance for completion and correlation for idempotency

The new bootstrap ordering is directionally better than the plan: it uses a harmless READY turn, attaches the TUI, then sends the assignment at activation. The implementation still misreads the imported client contract:

- `CodexDaemonClient.startTurn` returns after the `turn/start` RPC is accepted and explicitly says the turn runs asynchronously (`packages/claude-runner/src/codex-daemon-client.ts:504-530`);
- `prepareCodexRemote` awaits only that RPC, closes the client, and returns (`packages/v2-host/src/codex-remote.ts:99-130`), so it has not proved READY completion before the TUI/assignment path proceeds;
- activation releases the pane gate, fire-and-forgets another `turn/start`, and reports only stderr on rejection (`tmux-runner-launcher.ts:1345-1378`). The assignment can race the still-active READY turn. `activate()` nevertheless returns success;
- the timeout passed to `startTurn` bounds the RPC request, not the model task. Treating any timeout as “normal, the full task keeps running” (`tmux-runner-launcher.ts:1371-1376`) converts an ambiguous/not-accepted external effect into apparent success.

`clientUserMessageId` is also correlation data, not a demonstrated app-server dedup primitive. Existing production Codex code reconciles with `thread/read(includeTurns)` and matches that id (`packages/teamlead/src/lead-backends/codex/CodexTurnExecutor.ts:173-187,273-322`); existing input routing marks uncertain effects ambiguous instead of blindly replaying (`LeadInputRouter.ts:273-315`); the imported daemon client warns not to replay `turn/start` once it may have committed (`codex-daemon-client.ts:909-913`).

The doorbell records an intent, ignores whether it was replayed, calls `codexBell`, and writes no action outcome (`packages/v2-dag/src/doorbell.ts:155-173,202-232`). A crash after accepted `turn/start` but before cursor commit sends another turn. Conversely, if the server ever did dedup by correlation id, overdue re-ring uses the same `bell:<session>:<maxSeq>` key and could never re-ring the same high-water.

**Required change**: wait for/filter the READY turn’s real completion before assignment eligibility; make activation durably fail/retry rather than return success when assignment acceptance is unproved; reconcile stable correlation with `thread/read` before any replay; record/adopt the real turn id and durable action outcome; include an overdue episode in the bell effect identity. Add active-bootstrap, response-loss, effect-before-outcome, duplicate activation, overdue, and host-restart tests against a transport that behaves asynchronously like the real daemon.

### 6. [HIGH] The landed Codex daemon lifecycle does not satisfy same-lifecycle restart/teardown ownership

Several concrete gaps contradict plan §2.6 and the authority condition:

1. Production `defaultPorts.processGroupOf` always returns `null` (`packages/v2-host/src/codex-remote.ts:52-75`), and only the unit test injects `() => 4242`. Therefore normal runner state persists `daemon_pgid:null` (`codex-remote.ts:121-129`).
2. After a host restart there is no live `DaemonHandle`; `teardownCodexRemote` cannot signal a null PGID, so a live daemon remains and teardown returns false (`codex-remote.ts:182-218`; `tmux-runner-launcher.ts:1554-1566`). The advertised restart-safe group teardown is not available in production.
3. With a live in-memory handle, `stop()` awaits `handle.ensureDead()` but ignores its boolean result and returns (`tmux-runner-launcher.ts:1547-1552`). The imported contract returns false precisely when the daemon survived; that is not proof of absence.
4. A crash after detached daemon spawn but before runner-state persistence leaves an unrecorded resident. A tmux/config/state failure after `prepareCodexRemote` returns also does not call `stop()+ensureDead()` in the launcher catch (`tmux-runner-launcher.ts:1205-1249,1276-1337`).
5. `probe()` checks only tmux identity, not the daemon socket (`tmux-runner-launcher.ts:1475-1528`). A present pane with a dead daemon is reported healthy/present. Conversely, a persisted `codex_daemon` is reused without a liveness probe (`tmux-runner-launcher.ts:1211-1236`), so a dead socket is not rebuilt.
6. If a non-null PGID is ever persisted, `teardownCodexRemote` signals it without the socket-holder/process-group two-fact proof used by the imported daemon runtime (`codex-remote.ts:185-210` versus `packages/claude-runner/src/codex-daemon-runtime.ts:371-451`). A stale/recycled PGID must not authorize killing an unrelated process group.

**Required change**: persist the actual detached group identity using the imported runtime’s proven contract; introduce a durable launch-phase record before/around spawn; on every post-spawn failure stop and prove absence; make probe dual tmux+socket/thread; adopt or safely reap a persisted daemon using socket-holder plus process-group proof; reject `ensureDead() === false`; and cover spawn-before-state, state-before-tmux, tmux failure, host crash/restart, dead socket, live orphan, stale PGID, and TERM-resistant descendant paths.

### 7. [MEDIUM] The authority outcome is valid, but §9 rewrites an explicit exception as compliance

Ruling 1 is faithfully recorded. Ruling 2’s selected outcome and delivery-reliability reasoning are also real. However, the exact ruling says:

- no new daemon is a hard red line;
- a per-session daemon is exactly the separately failing/rescuing resident the red line meant to stop;
- form A is nevertheless selected because form B had already lost three deliveries and A has positive visibility evidence.

Plan §9.2 omits the first two facts and adds that the daemon “does not constitute” such a resident and is consistent with ruling 1 (`plan:148-151`). That is not what the authority said. The decision is an explicit tradeoff/exception, not a finding that the daemon falls outside the red line.

**Required change**: record the ruling faithfully: A is authorized as an exception because delivery reliability and visible-TUI evidence win, conditional on the launcher truly owning the daemon in the same lifecycle. No additional authority round is required unless the lifecycle shape changes.

### 8. [MEDIUM] The “source roll-call” is not closed over all producers, and generic `send` can manufacture unclassified debt

The classifier itself is better than the plan’s written list: it includes `ship_authority_recovered`, `ship_actor_authority_recovered`, `action_unsettleable_generation`, and `ship_retry_rearmed` (`packages/v2-dag/src/settlement-disposition.ts:26-52`), which plan §2.3 omits.

The test does not provide the promised repository closure:

- it scans only `packages/v2-dag/src/*.ts` (`settlement-disposition.test.ts:17-47`);
- the “host vocabulary” is a hard-coded four-item array, not a scan/registry tied to host producers (`settlement-disposition.test.ts:64-73`);
- `MailboxService.send` accepts any string `kind` (`service.ts:224-243`), so a caller can enqueue a kind absent from both classifier and roll-call.

A new host producer or generic send kind can pass tests and become unknown production debt.

**Required change**: make producer vocabulary executable and closed: restrict generic send to a protocol union (or always emit a classified envelope kind with subtype in payload), and have every producer import/register against the same vocabulary. If source scanning is retained, scan the actual host producer files rather than asserting a second hand-maintained list. Synchronize the plan’s list from `CLASSIFIED_MAILBOX_KINDS`.

### 9. [MEDIUM] `issueTitle` remains optional human discipline rather than a production admission invariant

The descriptor-to-prompt propagation is sound: admission validates and stores a supplied title, runtime ports pass it, and the launcher includes it in the prompt (`packages/v2-dag/src/admission.ts:24-30,283-290`; `packages/v2-host/src/runtime-ports.ts:311-330`; `tmux-runner-launcher.ts:321-341`).

Plan §2.8 now correctly says the human operator Lead authors the request file. Node manuals have also gained mailbox contract text, but the promised CLI warning did not land. The CLI still casts the parsed request directly into `admitIssueDag` (`packages/v2-cli/src/cli.ts:380-390`). Even if the warning lands, plan §2.8 explicitly keeps it non-gating. Optional/blank `issueTitle` therefore remains a valid real admission, with no title-specific bound.

**Required change**: identify the actual operator intake wrapper/template as the production boundary and require a trimmed, bounded non-empty title there; keep optional compatibility only on a clearly separate legacy/direct test boundary if necessary. Add the promised request-file-to-prompt E2E. A warning cannot establish the founder-facing outcome.

## Verification performed

- Final source pin:
  - `git rev-parse HEAD` → `3c113dda6ab812cc06c6c9cc9d80cdc6d78c038a`;
  - `git rev-parse origin/feat/fly1547-mailbox-service` → the same SHA;
  - the owning build/tests below ran while that pin was clean; the final status check later showed the uncommitted remediation delta described in the scope note. Those later bytes were preserved and not counted as landed fixes.
- `pnpm --filter flywheel-v2-host build`: **passed**.
- `pnpm --filter flywheel-v2-host exec vitest run src/__tests__/tmux-runner-launcher.test.ts`: **25/25 passed**.
- `pnpm --filter flywheel-v2-mailbox-mcp test`: **10/10 passed**.
- `pnpm --filter flywheel-v2-dag test`: **93/93 passed**, including disposition and the new Codex doorbell test.
- `pnpm --filter flywheel-v2-engine test`: **71/71 passed**.
- `pnpm --filter flywheel-inbox-mcp run build` and `pnpm --filter flywheel-inbox-mcp test`: build passed; **25/25 tests passed**.
- `bash -n packages/teamlead/scripts/claude-lead.sh`: **passed**.
- `runner-injection.test.ts` plus `fly1503-host-gaps.test.ts` could not reach their assertions in this sandbox because Unix socket `listen` failed with `EPERM` (13 affected tests, including one downstream timeout). This is environment evidence, neither a product failure nor a pass.
- Direct service probes reproduced:
  - bare settlement of an answer-requiring `runner_ask`;
  - explicit settlement of an unknown kind;
  - two concurrent `next()` calls entering `HostPort.next()` before the first resolved.
- The exact authority response was queried read-only from the production v2 database by message UID; the plan’s summary was not accepted as the authority source.

Passing unit tests do not exercise the blocking negative paths above: concurrent MCP requests, notify-failure lease expiry, two-child Lead takeover, asynchronous Codex turn overlap/reconciliation, or host-restart daemon ownership.

## Final decision

Round 3 closes the old Lead converter ownership, reply route/key, shared-module placement, pointer-only cursor, reuse seam, remote-attached visibility feasibility, and much of the launcher wiring. It does not close the executable single-reader invariant, ask-before-reply red line, Claude channel health/fallback chain, Lead generation credential fencing, Codex turn-effect recovery, or Codex daemon lifecycle. The remaining external registration edit and real-machine E2E cannot repair these contracts without code/design changes, so this round still requires further review.

VERDICT: CHANGES REQUESTED
