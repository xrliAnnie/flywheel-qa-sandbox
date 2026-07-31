# FLY-1547 Design/Code Review — Round 5

**Review target**: merge-readiness of the cross-vendor FLY-1547 implementation  
**R4 source**: `/tmp/fly1547-design-review-r4.md`  
**Reviewed pin**: `ad9c4cf166687431653aeb2421bc21f1b70baa7b`  
**Remote pin**: `origin/feat/fly1547-mailbox-service` was the same SHA at final verification  
**R4 baseline**: `703c52ca593b0c248e3d5a98c45aa625a6c4fec5`  
**Additional evidence commit**: `a8e07d2c931c7f108f199bdc5e6f6cdbfe4afeb6`

## Executive decision

**CHANGES REQUESTED.**

Round 5 closes most of the mailbox protocol findings and several concrete
daemon regressions. In particular:

- the malformed-status SQL, typed conflict propagation, host enqueue vocabulary,
  and unknown-letter wording are materially better;
- same-process Codex sends now share one per-session chain, and normal repeated
  activation has a once-per-process latch;
- overdue re-rings receive fresh episode keys;
- `onDaemonUp` is inside the cleanup scope, live-handle/persisted teardown results
  are checked in `stop()`, a failed tmux launch attempts daemon teardown, and a
  failed orphan reap refuses a second spawn;
- the Lead takeover order is now explicitly documented;
- the real-host/real-socket/real-Claude evidence demonstrates the Lead mailbox
  happy path, and the accepted-socket `error` handler closes the observed EPIPE
  process crash.

Two R4 blocker families remain blocking, however:

1. **Codex assignment delivery is not a retryable state machine.** The bootstrap
   wait proves only that the user message appeared, not that the READY turn
   completed. `activate()` then marks the assignment sent before the detached
   send succeeds and never clears that latch on failure. A direct probe made the
   first assignment send fail and then called `activate()` again; total assignment
   attempts remained **1**. A fresh Codex runner can therefore attach but never
   receive its task until the host process is restarted.
2. **Codex daemon restart/teardown authority is still unsafe and incomplete.**
   Persisted-PGID teardown signals the group before proving that the group owns
   the socket. A direct probe with an always-dead socket still emitted
   `SIGTERM` to the supplied PGID. PGID reuse can therefore kill an unrelated
   process group. The launch lifecycle also still has unrecorded/post-prepare
   leak windows and `probe()` still proves tmux only, not the daemon.

These are not polish or rollout chores: they sit on the new Codex production
form selected by FLY-1547. The Claude Lead E2E does not exercise them.

## Blocking findings

### 1. [HIGH] READY/assignment delivery can fail once and then be suppressed forever

`prepareCodexRemote()` submits the bootstrap turn and polls only for its
`clientUserMessageId` to appear (`packages/v2-host/src/codex-remote.ts:143-163`).
That is durable acceptance, not READY completion. The underlying
`CodexDaemonClient.startTurn()` is explicitly an asynchronous RPC-acceptance
operation (`packages/claude-runner/src/codex-daemon-client.ts:504-530`).
Consequently the assignment can race the still-active bootstrap turn.

At activation, the launcher adds the session to `#assignmentSent` before the
send begins (`packages/v2-host/src/tmux-runner-launcher.ts:1404-1424`). Its catch
only logs; it does not clear the latch, schedule reconciliation, or persist an
outcome (`tmux-runner-launcher.ts:1424-1433`). The host calls activation on every
coordinator sync (`packages/v2-host/src/host.ts:637-655`), but all later calls
are suppressed by that latch.

Fresh no-socket probe:

```json
{"assignmentRetry":{"assignmentAttempts":1}}
```

The probe launched a Codex-form fixture, injected a failure for the first
`assignment:<sessionRef>` turn, called `activate()` twice, and observed only one
attempt.

The comment/log also still describes an RPC timeout as normal full-task runtime
(`tmux-runner-launcher.ts:123-127,1426-1431`), although `startTurn()` does not
wait for the task. A timeout is ambiguous acceptance, not evidence that the task
is running.

**Required before merge**:

- wait for a real bootstrap-turn completion/READY state, not merely presence of
  its input message;
- represent assignment send as an explicit per-session state/promise;
- clear/retry after a proven pre-acceptance failure;
- after timeout/transport ambiguity, reconcile `thread/read` before deciding
  whether to retry;
- add tests for bootstrap-active rejection, first-send failure followed by the
  next coordinator tick, ambiguous timeout, and successful once-only replay.

The new `#sendTurnSerial` is the right same-process mutual-exclusion primitive,
but it does not provide the missing outcome/retry state.

### 2. [HIGH] Persisted daemon teardown can signal an unrelated recycled PGID

`teardownCodexRemote()` immediately calls `killGroup(persistedPgid, "SIGTERM")`
and only then probes the socket (`packages/v2-host/src/codex-remote.ts:265-293`).
Its production `killGroup` is a bare `process.kill(-pgid, signal)`
(`codex-remote.ts:80-85`). It does not apply the existing FLY-1188 two-fact
authority rule: OS socket-holder PID plus `processGroupOf(holder) ===
persistedPgid`. It also does not use the protection in
`createDefaultKillGroup()` against the Bridge/parent process group.

Fresh no-socket probe:

```json
{"persistedPgid":{"dead":true,"signals":[{"pgid":7777,"signal":"SIGTERM"}]}}
```

The injected connect probe always returned “no listener”; teardown nevertheless
signalled PGID 7777. After a restart, the daemon can already be gone and that
PGID can belong to an unrelated process. This is a destructive authority bug,
not merely a daemon leak.

**Required before merge**: if the socket is already dead, do not signal any
group. If it is live, resolve its actual holder(s) and require holder→PGID proof
before TERM/KILL. If the proof is unavailable or disagrees, refuse destructively
and surface the orphan. Cover dead-socket/recycled-PGID, live-proven-holder,
live-mismatched-holder, lsof/ps unavailable, and protected-group cases.

### 3. [HIGH] The daemon launch/probe lifecycle still has unowned windows

The R4 `onDaemonUp` regression is improved: the hook now runs inside the catch
scope and the direct probe observed `stopCalls=1, ensureDeadCalls=1`
(`packages/v2-host/src/codex-remote.ts:120-180`). But the boolean result from
`ensureDead()` is ignored. In the probe it returned `false`; the caller still
received only the original `"persist failed"` error:

```json
{"prepareCleanup":{"error":"persist failed","stopCalls":1,"ensureDeadCalls":1}}
```

If persistence itself failed, there is no durable record from which the next
host can reap the survivor.

Other R4 lifecycle gaps also remain:

- there is still no durable pre-spawn intent; a process death after
  `spawnDaemon()` resolves but before `onDaemonUp` persists leaves an unrecorded
  resident (`codex-remote.ts:113-130`);
- after `prepareCodexRemote()` returns, `commandForVendor`, final state
  persistence, and the pre-existing-session probe run outside the tmux cleanup
  `try` (`packages/v2-host/src/tmux-runner-launcher.ts:1246-1311`). A concrete
  reachable example is effort validation: the daemon is prepared first, while
  unsupported effort is rejected later by `commandForVendor`
  (`tmux-runner-launcher.ts:367-378`);
- the tmux-failure cleanup calls `ensureDead()` but ignores `false`
  (`tmux-runner-launcher.ts:1371-1381`);
- `probe()` still proves only tmux environment/pane identity and never probes
  the persisted daemon socket/thread (`tmux-runner-launcher.ts:1545-1598`).

`stop()` now correctly throws for `ensureDead() === false`, and a failed
threadless-orphan teardown correctly refuses a second spawn
(`tmux-runner-launcher.ts:1232-1244,1600-1643`). Those are real closures, but
they do not close the whole invocation lifecycle.

**Required before merge**: establish durable launch intent before spawn; put
every post-spawn operation under one cleanup owner; treat `ensureDead() ===
false` as a first-class failure everywhere; and make session liveness require
both tmux and daemon evidence for the Codex remote form. Add crash/failure
fixtures for each phase and for host restart with tmux-live/daemon-dead and
tmux-dead/daemon-live states.

## R4 finding-by-finding status

| R4 finding | R5 status | Judgment |
|---|---|---|
| F1. Lost-handoff recovery assumes serialization | **CLOSED** | All model-facing mailbox operations remain behind the per-service promise chain (`packages/v2-mailbox-mcp/src/service.ts:99-181,304-397`). Fresh mailbox tests are 18/18. |
| F2. Reply-required ask and unknown/malformed settlement | **CLOSED for the core invariant; bounded follow-up remains** | Bare answer-required settlement and unknown settlement are refused (`service.ts:184-227`); reply route/key are derived from the envelope (`service.ts:229-301`); host status guards `json_extract` with `json_valid` (`packages/v2-host/src/host.ts:1047-1063`); IPC preserves `CanonicalConflict.name` (`packages/v2-host/src/host.ts:730-739`; `packages/v2-host/src/protocol.ts:161-165`). The regex fallback in `service.ts:264-280` is still broader than the typed proof and should be removed, but current production conflict errors carry the name. |
| F3. Notification failure refreshes health | **CLOSED** | The R3 state machine remains intact; 5/5 bell tests pass and the DAG fallback behavior remains covered. |
| F4. Superseded Lead adopts replacement bearer | **CLOSED in package; rollout follow-up** | Lead credentials are cached once, CLI publication is atomic, and the ops note now freezes stop-old → exact-PID → atomic publish → start-new (`doc/engineer/implementation/FLY-1547-ops-notes.md:23-29`). The external production script is still `ps ... | head -1` and lacks `--delivery-credential-out`; this is acceptable only because the feature remains unconfigured/default-off and the note says to apply it after merge. |
| F5. Codex assignment/bell effect contract | **PARTIALLY CLOSED; BLOCKING** | Per-session serialization and fresh overdue keys close the normal overlap/re-ring defects (`tmux-runner-launcher.ts:1481-1511`; `packages/v2-dag/src/doorbell.ts:133-177`). READY completion, assignment failure retry, and ambiguous acceptance remain open as Blocking Finding 1. |
| F6. Codex daemon lifecycle | **PARTIALLY CLOSED; BLOCKING** | Real PGID lookup, strict `stop()`, tmux-failure cleanup attempt, and refusal after failed orphan reap landed. Unsafe stale-PGID signalling, incomplete cleanup coverage, missing pre-spawn intent, and tmux-only probing remain open as Blocking Findings 2–3. |
| F7. Daemon authority exception wording | **CLOSED** | No regression in the explicit §9.2 exception/ownership condition. |
| F8. Producer vocabulary is not closed | **CLOSED** | The host `enqueue` boundary now rejects every kind outside `CLASSIFIED_MAILBOX_KINDS` (`packages/v2-host/src/host.ts:1090-1123`), in addition to the narrower MCP-send vocabulary. This closes the ordinary/raw host ingress that R4 identified. |
| F9. `issueTitle` is not an admission invariant | **ACCEPTABLE FIRST-MERGE FOLLOW-UP** | The warning remains at the direct CLI boundary, and a present title reaches the runner prompt. Admission still accepts absent/blank titles (`packages/v2-dag/src/admission.ts:24-30,279-290`), with no production admit-template update or request→prompt E2E. This is a bounded UX/outcome gap, not a ledger or authority failure; it must be named rather than claimed closed. |

## The three new R4 defects

1. **Throwing `onDaemonUp` hook** — **PARTIALLY CLOSED, still part of blocker F6**.
   The hook is now inside the cleanup scope, but cleanup proof failure is ignored
   and the pre-spawn/post-prepare gaps remain.
2. **Concurrent reconcile-first sends** — **CLOSED for normal in-process
   production calls**. Assignment and bell calls both enter
   `#sendTurnSerial`, so their read→start sequences cannot interleave. The
   remaining problem is not the original normal-overlap reproduction; it is
   assignment outcome/retry and crash/timeout ambiguity, covered by Blocking
   Finding 1.
3. **Unknown-letter instruction contradiction** — **PARTIALLY CLOSED;
   acceptable follow-up**. The returned note now explicitly says the letter
   cannot be settled (`packages/v2-mailbox-mcp/src/service.ts:152-163`), but the
   MCP `next` description still says unknown letters remain until `settle`
   (`packages/v2-mailbox-mcp/src/server-main.ts:84-94`), and the committed E2E
   prompt explicitly tells Claude to settle unclassified mail
   (`doc/engineer/research/new/FLY-1547-e2e/e2e-mailbox.mjs:204-210`).
   `next()` also still returns an ordinary successful tool result rather than
   `isError`. The row cannot be lost because `settle` refuses it and host ingress
   is vocabulary-fenced.

## `a8e07d2c` real-machine evidence

The committed log is useful evidence for the scope it actually covers:

- real host + real Unix socket + real Claude `-p` Lead session;
- FYI deferred ack applied the FYI row;
- processing-attempt rows prove reads;
- answer-required `runner_ask` settled through a derived `ask_response`;
- the reply source is message-scoped in the observed row;
- current host source installs an accepted-socket `error` handler
  (`packages/v2-host/src/host.ts:658-684`), closing the observed EPIPE crash.

It does **not** cover Codex remote launch, READY, assignment, bell turn,
host-restart daemon adoption/reap, or daemon teardown. It also writes the
credential file directly rather than exercising CLI atomic publication, does
not record the tested commit/dist digest, permits `crashed` processing attempts
under an assertion named “every consumed PA succeeded,” and contains the stale
unknown-letter instruction noted above. These limitations do not invalidate the
Lead happy-path evidence, but they prevent it from closing F5/F6.

## Explicit acceptable follow-ups after the blockers close

1. **Lead takeover rollout**: update
   `~/.flywheel/v2/bin/register-operator-lead.sh`, stop the old child first,
   select the exact replacement PID/session, add
   `--delivery-credential-out`, and run a two-live-child negative fixture before
   enabling the Lead MCP. The current external script and runtime config are
   unchanged, so this must happen before rollout, not be forgotten after merge.
2. **Unknown protocol UX**: remove the message-regex conflict fallback, make the
   unknown read an MCP error/explicit operator flow, and synchronize the tool
   description plus E2E prompt.
3. **`issueTitle` production outcome**: add it to the actual admit request
   template/manual and a request-file→runner-prompt E2E, or enforce bounded
   non-empty input at the chosen authority boundary.
4. **Integration depth**: add a real-process notification-rejection → stale
   lease → same-seq DAG fallback test and, after the blocking lifecycle fixes,
   one isolated real-machine Codex remote launch/restart/stop acceptance.
5. **E2E evidence hygiene**: build/pin the tested SHA, fail on any
   `uncaughtException`, assert the exact `mailbox_reply:<message_uid>` source ID,
   require every consumed PA to be `succeeded`, and remove the trailing
   whitespace in the committed log.

## Verification performed

- `git rev-parse HEAD` and
  `git rev-parse origin/feat/fly1547-mailbox-service` both returned
  `ad9c4cf166687431653aeb2421bc21f1b70baa7b`.
- Worktree was clean before and after verification.
- `git diff --check 703c52ca..HEAD` found one trailing-whitespace line in the
  committed E2E output log; no source-code whitespace error was reported.
- `pnpm lint`: exit 0, 20 warnings/no errors. Three warnings are in the new E2E
  script (unused import, unused variable, optional-chain suggestion).
- `pnpm build`: exit 0 across 31 workspace packages.
- Fresh package tests in this sandbox:
  - `flywheel-v2-dag`: **93/93 passed**.
  - `flywheel-v2-engine`: **71/71 passed**.
  - `flywheel-inbox-mcp`: **25/25 passed**.
  - `flywheel-v2-mailbox-mcp`: **18/18 passed**.
  - `flywheel-v2-host`: **46/62 passed locally**; all **25/25 launcher tests**
    passed. The remaining tests were blocked before product assertions by Unix
    socket `listen EPERM`, the sandbox-denied `/bin/ps`, and one downstream
    timeout from the failed socket listen.
  - `flywheel-v2-cli`: **20/23 passed locally**; all three real-host E2Es were
    blocked by the same Unix socket `listen EPERM`.
- The user-reported real-machine 93/62/23/18/71/25 green run matches the test
  inventory, and the committed E2E output records its Lead-path assertions. This
  review does not relabel sandbox-blocked tests as locally passed.
- Fresh no-socket failure probes after the full build:

```json
{
  "prepareCleanup": {
    "error": "persist failed",
    "stopCalls": 1,
    "ensureDeadCalls": 1
  },
  "persistedPgid": {
    "dead": true,
    "signals": [
      {
        "pgid": 7777,
        "signal": "SIGTERM"
      }
    ]
  },
  "assignmentRetry": {
    "assignmentAttempts": 1
  }
}
```

VERDICT: CHANGES REQUESTED
