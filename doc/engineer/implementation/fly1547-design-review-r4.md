# FLY-1547 Design/Code Review — Round 4

**Review target**: cross-vendor FLY-1547 implementation plus `doc/engineer/plan/draft/FLY-1547-mailbox-service.md`  
**R3 source**: `/tmp/fly1547-design-review-r3.md`  
**Reviewed landed pin**: `703c52ca593b0c248e3d5a98c45aa625a6c4fec5`  
**Remote pin**: `origin/feat/fly1547-mailbox-service` was the same SHA at final verification  
**R3 baseline**: `3c113dda6ab812cc06c6c9cc9d80cdc6d78c038a`

## Scope and pin notes

1. The request describes R3 as **5 HIGH + 3 MEDIUM**, but the actual R3 artifact on disk contains **6 HIGH + 3 MEDIUM** (Findings 1–9). I reviewed all nine, including the separate Codex daemon-lifecycle finding, rather than silently dropping it.
2. `$PLAN` and `$OUT` were not exported in this process. The plan was located at the path above; the R4 output is `/tmp/fly1547-design-review-r4.md`.
3. The plan is intentionally excluded by `.git/info/exclude`, so its R3 edits are not part of commit `703c52ca`; I reviewed the exact current on-disk bytes (mtime 2026-07-30 16:19:30 -0700).
4. The worktree was clean when the review pinned `703c52ca`. During the review, an external uncommitted change appeared at `packages/v2-host/src/host.ts:654-667` (a socket `error` handler). It was not made by this reviewer and is not in `703c52ca`; it is preserved but excluded from landed-closure judgments.

## Executive decision

**CHANGES REQUESTED.**

The R4 delta makes real progress:

- the mailbox tool face now serializes all service/bell operations;
- bare settlement of answer-requiring asks and ordinary settlement of unknown input are refused;
- unknown debt has its own status chapter;
- Claude bell health is refreshed only after a complete successful cycle, with an in-flight guard;
- a Lead MCP caches its startup credential, and CLI credential publication is now temp-file + fsync + rename + directory-fsync;
- generic MCP `send` is restricted to `MAILBOX_SEND_KINDS`;
- §9.2 now records the daemon ruling as an explicit exception;
- the CLI now prints the promised missing-`issueTitle` warning.

Those changes close R3 Findings 1, 3, and 7. They do not make the implementation complete. The two largest blockers remain the Codex effect/lifecycle path:

1. `sendCodexTurn` is a non-atomic read-before-start check. Concurrent sends with the same key both start turns, while every coordinator sync calls `activate()` again and `activate()` returns before its send finishes.
2. Production still persists no usable daemon process-group identity, does not dual-probe the daemon, ignores several teardown results, and can now leak a daemon when the newly added partial-state callback throws.

The Lead takeover procedure, malformed/unknown visibility, producer-vocabulary closure, and `issueTitle` production invariant also remain incomplete.

## R3 finding-by-finding closure

| R3 | Severity | R4 status | Evidence and judgment |
|---|---|---|---|
| F1. Lost-handoff recovery assumes serialization | HIGH | **CLOSED** | `MailboxService.#serial` owns one per-service promise chain (`packages/v2-mailbox-mcp/src/service.ts:99-118`), and `next`, `settle`, `send`, `ask`, `status`, and the bell-only `peekMaxPendingSeq` all enter it (`service.ts:134-181,300-389`). The held-first-promise test proves a second `next` cannot enter the host (`service.test.ts:267-293`). This matches the host’s explicitly documented concurrency bound (`packages/v2-host/src/delivery.ts:255-275`). |
| F2. Ask can settle without a reply; unknown/malformed input can settle normally | HIGH | **PARTIALLY CLOSED** | Bare answer-requiring settlement is rejected (`service.ts:203-227`); a successful/duplicate enqueue is required, or an observed `CanonicalConflict` marks in-memory proof before a later bare settlement (`service.ts:249-297`). Unknown settlement is refused (`service.ts:195-201`) and status has an `unknown` chapter/stderr warning (`service.ts:352-384`). However, `next()` still returns unknown input as an ordinary successful tool result and tells the model “人工确认后用 settle” even though `settle` now refuses it (`service.ts:155-163`; `server-main.ts:84-94`). More importantly, host status applies unguarded `json_extract` to `runner_ask.payload` (`packages/v2-host/src/host.ts@HEAD:1037-1053`); a direct SQLite probe with `payload='not-json'` produced `malformed JSON`, so malformed debt cannot be reported in the promised unknown chapter and drives the bell toward fail-stop instead. The conflict proof also matches error text with `/canonical|conflict/i` rather than the preserved `CanonicalConflict` error name (`service.ts:264-276`). |
| F3. Notification failure refreshes health and suppresses fallback | HIGH | **CLOSED** | `runBellCycle` increments one shared failure counter for status and notification errors, updates `lastBelledSeq` only after notification success, touches the lease only after the full cycle, and guards overlapping cycles (`packages/v2-mailbox-mcp/src/bell.ts:33-80`). `server-main` uses this state machine (`server-main.ts:169-218`). Tests cover notify-only failure to fail-stop, no lease touch, quiet-cycle recovery, and overlap (`bell.test.ts:34-100`); the DAG test separately proves the same pending debt falls to pointer paste after channel health becomes false (`packages/v2-dag/src/__tests__/doorbell.test.ts:180-207`). A single real-process/channel-to-DAG integration test would be useful but is follow-up, not a remaining code defect in this finding. |
| F4. Shared Lead credential lets the superseded MCP adopt the replacement bearer | HIGH | **PARTIALLY CLOSED** | `createHostPort` now reads the Lead credential once (`packages/v2-mailbox-mcp/src/host-port.ts:35-50`), with a rewrite-resistance test (`service.test.ts:296-329`). `stashDeliveryCredential` now does a 0600 `wx` temp write, file fsync, rename, and directory fsync (`packages/v2-cli/src/cli.ts:298-327`). But the production operator script still selects `ps ... | head -1` and still omits `--delivery-credential-out` (`/Users/xiaorongli/.flywheel/v2/bin/register-operator-lead.sh:3-15`). The ops note only proposes that external edit and still does not identify the exact replacement PID/session, stop the old child, or test two simultaneously live MCP children (`doc/engineer/implementation/FLY-1547-ops-notes.md:7-23`). The bearer-adoption hole is fixed in the package; the takeover lifecycle is not. |
| F5. Codex assignment/bell confuses RPC acceptance with completion and correlation with idempotency | HIGH | **PARTIALLY CLOSED; BLOCKING** | Sequential response-loss replay is better: `sendCodexTurn` now calls `thread/read` first and returns `already_present` when it finds the correlation id (`packages/v2-host/src/codex-remote.ts:155-217`). But READY still waits only for `turn/start` RPC acceptance (`codex-remote.ts:117-135` versus `packages/claude-runner/src/codex-daemon-client.ts:504-530`), and assignment remains fire-and-forget after the gate is released (`tmux-runner-launcher.ts:1370-1403`). Every host sync calls `activateSession` for every live binding (`packages/v2-host/src/host.ts@HEAD:633-650`), so the sender must be safe under overlapping activation calls; it is not. A direct fake-transport probe held two `thread/read`s at proven absence and observed `startCalls=2`, with both same-key calls returning `"started"`. The read-before-start check is TOCTOU, not a single-effect primitive. The sender does not adopt a real turn id or distinguish active/completed/failed turns. Doorbell overdue replay also reuses `bell:<session>:<maxSeq>` (`packages/v2-dag/src/doorbell.ts:155-170`), so reconciliation suppresses the specified later overdue re-ring for the same high-water. |
| F6. Codex daemon lifecycle is not restart/teardown safe | HIGH | **PARTIALLY CLOSED; BLOCKING** | The launcher now writes a partial daemon record through `onDaemonUp` and tears down a recorded threadless state on the next launch (`tmux-runner-launcher.ts:1221-1261`). This is useful but does not satisfy the authority condition. Production `processGroupOf` still returns `null` (`packages/v2-host/src/codex-remote.ts:52-74`), so restart teardown cannot signal the daemon. `onDaemonUp` runs outside the cleanup `try` (`codex-remote.ts:102-116`); a direct probe made it throw and observed `stopCalls=0, ensureDeadCalls=0`, a newly introduced leak path. The launcher ignores the boolean from threadless-orphan teardown (`tmux-runner-launcher.ts:1227-1235`), its tmux failure catch kills only tmux (`tmux-runner-launcher.ts:1301-1362`), `probe()` still checks only tmux (`tmux-runner-launcher.ts:1500-1553`), the live-handle stop path still ignores `ensureDead() === false` (`tmux-runner-launcher.ts:1555-1577`), and persisted-PGID teardown still lacks socket-holder + group proof (`codex-remote.ts:239-272`). The only changed launcher test adds a fake `readThread`; the happy-path test injects a non-null PGID and `ensureDead:true` (`tmux-runner-launcher.test.ts:393-449`). None of the R3 restart/crash/stale-PGID matrix landed. |
| F7. §9 rewrites an explicit exception as compliance | MEDIUM | **CLOSED** | §9.2 now says the daemon is exactly what the hard red line meant to prevent, records why A was nevertheless selected, names it an explicit exception, and conditions it on real same-lifecycle ownership (`plan:149-152`). No new authority round is needed; the implementation must still satisfy that condition. |
| F8. Producer roll-call is not closed; generic send can make unknown debt | MEDIUM | **PARTIALLY CLOSED** | MCP `send` now rejects kinds outside the shared `MAILBOX_SEND_KINDS` (`service.ts:300-334`; `packages/v2-dag/src/settlement-disposition.ts:104-115`) and has a negative test (`service.test.ts:332-361`). The producer roll-call itself is unchanged: it scans only v2-dag source and asserts a hand-written four-kind host list (`settlement-disposition.test.ts:17-73`). The host `enqueue` endpoint and CLI `enqueue` still accept any non-empty string kind (`packages/v2-host/src/host.ts@HEAD:1079-1103`; `packages/v2-cli/src/cli.ts:552-560`). A host producer or privileged generic enqueue can therefore introduce unclassified debt without failing the roll-call. |
| F9. `issueTitle` is optional human discipline, not an admission invariant | MEDIUM | **PARTIALLY CLOSED** | The CLI warning is present at the actual direct-verb boundary (`packages/v2-cli/src/cli.ts:396-413`). Admission still deliberately accepts absent/blank titles (`packages/v2-dag/src/admission.ts:24-30,283-290`). No test exercises the warning, no request-file-to-prompt E2E was added, and the promised `.flywheel/agents/nodes` admit-template instruction is absent (the only node-manual hits are generic mailbox-tool text). The warning closes the requested observability slice, not the claimed production outcome that real admissions have bounded non-empty titles. |

## New defects or regressions in the R4 fixes

### 1. [HIGH] Partial-state persistence can itself leak the newly spawned daemon

`prepareCodexRemote` calls `onDaemonUp` before entering its cleanup `try` (`codex-remote.ts:102-116`). The production callback performs synchronous state persistence (`tmux-runner-launcher.ts:1248-1255`). Any state-path I/O or authority error therefore escapes without `handle.stop()` or `ensureDead()`.

Direct probe result:

```json
{"probe":"onDaemonUp-throw","error":"persist failed","stopCalls":0,"ensureDeadCalls":0}
```

The design also still has an unavoidable unrecorded window between successful spawn and the callback. A durable launch intent must precede spawn, and every post-spawn exception must enter one cleanup path that treats `ensureDead() === false` as failure.

### 2. [HIGH] Reconcile-first sending is still duplicate-prone under normal host activation

The new sender does `thread/read` and then `turn/start` without a per-thread/key lock or a durable claim. Two callers can both prove absence before either starts. This is reachable because `activate()` detaches the send and returns while the host re-invokes activation on later syncs.

Direct probe result:

```json
{"probe":"concurrent-same-key","readCalls":2,"startCalls":2,"results":["started","started"]}
```

The fix needs one serialized sender per thread (or a durable CAS claim), plus post-ambiguity reconciliation. Correlation remains evidence; it is not mutual exclusion.

### 3. [MEDIUM] Unknown-letter instructions now contradict executable behavior

The fix correctly refuses unknown settlement, but `next()` still tells the model to use `settle`, and the MCP tool description says unknown letters remain until `settle` (`service.ts:155-163`; `server-main.ts:84-99`). That guarantees a confusing failed action on the exact fail-loud path. The response should be `isError` and direct the operator to the ledger-side repair path.

## Plan synchronization

- **§9.2: synced and faithful.**
- **§2.3: partially synced.** Line 62 correctly points readers to `CLASSIFIED_MAILBOX_KINDS` and records the restricted MCP-send vocabulary. Line 63 still overstates the hand-maintained host list as closed source evidence; actual host/raw enqueue is not tied to that vocabulary.
- **§2.6: not synced to executable reality.** Line 88 correctly retracts the dedup claim and says reconcile-first, but still calls RPC timeout normal; that timeout bounds RPC acceptance, not model-task duration. Line 89 claims actual PGID persistence, dual tmux+socket probing, teardown on every failure, and restart reconciliation that current code does not implement.
- **§2.5 conflicts with §2.6.** Line 76 still says the same `clientUserMessageId` makes crash replay idempotent, while §2.6 correctly says it is only correlation data. Its fixed effect key also contradicts overdue re-ring.
- **§2.7 is stale after the credential fix.** Line 98 still requires per-call credential reread and calls it naturally rotation-safe; current code correctly caches once.
- **§2.8 remains only partially delivered.** The warning exists; the promised manual change and request-file E2E do not.

## What blocks implementation-complete status

The following are not rollout chores; they require code/design changes before this implementation can be called complete:

1. **Codex turn effect contract**: wait for/reconcile READY state, serialize same-thread sends, make activation retry/outcome explicit, adopt real turn identity/state, distinguish ambiguous RPC acceptance from task duration, and give overdue episodes distinct effect identity.
2. **Codex daemon lifecycle**: durable pre-spawn intent; real group identity in production; cleanup on every post-spawn path; `ensureDead:false` rejection; dual tmux+socket/thread probe; safe restart reap using socket-holder + process-group proof; tests for every R3 crash/restart/stale-PGID window.
3. **Lead takeover**: exact replacement PID/session selection, old-child shutdown, applied credential-out registration, and a two-child takeover fixture. A documentation diff against an unchanged `ps | head -1` operator script is not an implemented lifecycle.
4. **Unknown/malformed protocol path**: make first read fail loud without offering settlement, make status JSON-safe so malformed debt is visible, and use a typed canonical-conflict signal.
5. **Closed producer vocabulary**: tie host/raw enqueue producers to the shared vocabulary or make a deliberately typed raw/admin escape hatch that cannot masquerade as ordinary mailbox protocol.
6. **`issueTitle` outcome**: either enforce a bounded non-empty title at the real operator intake boundary, or obtain/document an explicit authority decision that warning-only is acceptable and stop claiming the stronger invariant.

## Acceptable follow-up after those blockers close

- one real-process integration joining notification rejection → lease deletion/staleness → DAG pointer fallback for the same pending seq (the component logic is already correct);
- crash-injection coverage around CLI temp-file cleanup and directory-fsync failure;
- applying the external operator/runtime config during the deployment window and running the documented Claude/Codex/Lead real-machine acceptance;
- improving warning/manual wording once the actual `issueTitle` authority choice is settled.

## Verification performed

- Pin:
  - `git rev-parse HEAD` → `703c52ca593b0c248e3d5a98c45aa625a6c4fec5`
  - `git rev-parse origin/feat/fly1547-mailbox-service` → same SHA
- `git diff --check 3c113dda..HEAD`: passed.
- `pnpm lint`: exit 0 (17 existing warnings, no errors).
- `pnpm build`: exit 0 across 31 workspace packages.
- Six owning package runs in this sandbox:
  - `flywheel-v2-engine`: **71/71 passed**.
  - `flywheel-inbox-mcp`: **25/25 passed**.
  - `flywheel-v2-dag`: **93/93 passed**.
  - `flywheel-v2-mailbox-mcp`: **18/18 passed**.
  - `flywheel-v2-host`: **46/62 passed locally**; all **25/25** launcher tests passed. The remaining run was blocked before product assertions by Unix-socket `listen EPERM` (including one downstream timeout) and the sandbox’s unavailable absolute-`ps` process probe. This is environment evidence, not a product failure or a pass.
  - `flywheel-v2-cli`: **20/23 passed locally**; its three real-host E2Es were blocked by the same Unix-socket `listen EPERM`.
- Direct no-socket probes:
  - concurrent same-key `sendCodexTurn`: reproduced two `startTurn` calls;
  - `onDaemonUp` throw: reproduced zero daemon cleanup calls;
  - host mailbox-status SQL over malformed `runner_ask` JSON: reproduced SQLite `malformed JSON`.

The user-reported fully green 93+62+23+18+71+25 suite run is consistent with the test inventory, but this review does not relabel sandbox-blocked tests as locally passed.

VERDICT: CHANGES REQUESTED
