# Lead → Runner Messaging — FLY-142 PR 1.4 Cutover

When you (the Lead) need to message a Runner agent, choose the path by purpose:

## Trusted runner-stop exception (FLY-2017)

Treat a Runner lifecycle declaration as an ACK-only report only when all three
complete values match: `question_kind=report`, Question ID
`rstop-<32 lowercase hex>`, and content beginning
`RUNNER-STOPPED kind=runner_stopped `. Bridge labels this trusted triple
`[REPORT]`. Relay the status once, then ACK the enclosing mailbox batch/event;
never run `flywheel-comm respond` for it. A response would wake the parked
Runner, while an ACK retires the report. Any near-match remains an ordinary
answerable `[ASK] runner_question`.

## Ordinary chat / non-gate instructions → `SendMessage` MCP tool

- For everyday "talk to Runner" — context handoff, status checks, follow-up
  questions, course corrections, "please look at X", etc. — use the **`SendMessage`**
  MCP tool (claude-code teammate API).
- The Runner's stock `useInboxPoller` reads its mailbox at
  `~/.claude/teams/<your-id>/inboxes/<runner-id>.json` on its own loop and
  injects your message directly into the Runner's conversation as a new turn.
- This path is **vendor-neutral** (works for Codex/other Runners once their
  adapters land) and **bypasses the buggy `inbox-check.sh` hook** that was the
  root cause of FLY-142 (hook only read `type='instruction'`, dropping
  `type='response'`).

## Non-ship hard gate responses → `flywheel-comm respond` CLI

- For unblocking a non-`approve_to_ship` `gate_question` Runner is waiting on (the Runner is sitting
  in `flywheel-comm gate wait` polling CommDB), you **must still** use:
  ```bash
  flywheel-comm respond --db <DB-path-from-gate-question> \
    --lead <your-id> <question-id> "<your-reply>"
  ```
- The Bridge bootstrap message includes the exact command for each pending
  gate question — copy-paste it.

### `approve_to_ship` is founder-gated

The `approve_to_ship` checkpoint (the merge-to-`main` gate) is a **reserved,
founder-only action**. Relay the pending gate to the founder and ask her to use
the Discord ship card. Do not run `flywheel-comm respond` for approval,
rejection, feedback, or `--kickback`: the CLI rejects every Lead-authored ship
gate response before any question or response state is written.

- The founder's reaction or reply on the Discord ship card is the authoritative
  path. It writes the founder response and `workflow_source_event` together.
- A Lead cannot proxy founder words by adding `--source-thread`, JSON approval,
  or any reserved identity.
- Other checkpoints (`clarify_question`, project-specific gates) are unchanged
  and use the plain `respond` command.

## Recipient ID + post-send verification (FLY-1942)

- `flywheel-comm send --to` / `respond` take the FULL execution UUID, or a hex PREFIX of ≥ 8
  chars that resolves to exactly one session. The CLI refuses, with exit ≠ 0 and a reason, any
  of: `recipient_malformed` (not hex / < 8 chars), `recipient_not_found` (no session ever had
  this id — check `flywheel-comm sessions list --project <p>`), `recipient_ambiguous` (prefix
  matches > 1 — use the full id), `recipient_terminal` (finalized or in a terminal status —
  the Runner lane would dead-letter it on the next tick; re-engage a live successor or start a
  new run via the Bridge). There is no override flag.
- `runner-<8char>` is the SendMessage address domain, NOT a `--to` value. Strip the `runner-`.
- Keep the printed message id. On your next patrol tick run `flywheel-comm message-status <id>`:
  `ACKED` = consumed; `QUEUED`/`LEASED` = not yet; `DEAD` = never delivered — read `dead_reason`
  (`recipient_missing` = you sent to a non-session; `recipient_terminal` = it died first) and
  resend to the right live recipient. A printed id is NOT delivery.

## Driving a parked / idle Runner — use a WAKING channel (FLY-369 RC-2)

To **drive or unblock a parked (awaiting-lead / idle) Runner**, use a channel that
**wakes** it: `SendMessage` (MCP) or `flywheel-comm send` (both write the Runner's
mailbox → its poller injects your message as a new turn). Do **NOT** reach for
`flywheel-comm respond` to answer a non-gate question as a way to "nudge" a parked
Runner — for a non-gate, markerless question `respond` writes CommDB but **does not
write the mailbox**, so it **silently fails to wake** the Runner (no error). That
footgun stranded parked Runners (FLY-351 S2/S3 diff-approval). Keep `respond` for
**gate answers only**.

### Wake matrix (which path actually wakes a parked Runner)

| Path | Wakes? | Why |
|------|:------:|-----|
| `SendMessage` / `flywheel-comm send` | ✅ when the recipient exists and is mailbox-live | unconditional mailbox write (FLY-168) once accepted; malformed, unknown, ambiguous or terminal recipients are rejected (FLY-1942) |
| `respond` to a checkpoint-less `ask` | ✅ | FLY-142 `wakeAskedRunnerBestEffort` (vendor-neutral) |
| `respond` to a trusted `[REPORT]` runner-stop declaration | Rejected | ACK-only by FLY-2017; never wake a parked Runner with a response |
| `respond` to a **marker-bearing** no-block gate (Codex) | ✅ | `wakeNoBlockGateRunnerBestEffort` via the gate marker |
| `respond` to a markerless non-`approve_to_ship` checkpoint (Claude) | ❌ | byte-compat: blocking gates poll for their own answer, no marker → no wake |
| Lead `respond` to `approve_to_ship` | Rejected | founder must use the Discord ship card; no gate state is consumed |

Rule of thumb: to **drive** a Runner, use `SendMessage` / `send` (always wakes).
Use `respond` only to answer an authorized non-ship gate — and never as a way
to push a parked Runner forward.

## Quick decision table

| Scenario | Path |
|---|---|
| "Hey Runner, can you also look at file X?" | `SendMessage` |
| "Status update — Annie wants ETA" | `SendMessage` |
| Approving or rejecting `approve_to_ship` gate | Relay the Discord ship card to the founder |
| Answering a `clarify_question` gate | `flywheel-comm respond` |
| Asking the Runner to abort | `SendMessage` (Runner cooperatively stops). ⚠️ Ending a Runner's work is reserved under **R2** whichever words you use — a cooperative stop is not a way around it |

## Sentinel safety net

Even if you accidentally use `flywheel-comm respond` for an ordinary message,
the Runner's `inbox-check.sh` hook now short-circuits to a no-op when the
`~/.flywheel/runner-state/<exec-id>/mailbox-active` sentinel is present
(written automatically by TmuxAdapter at Runner spawn). The message will land
in CommDB audit but **will not be delivered** to the Runner conversation. So
if the Runner doesn't acknowledge, switch to `SendMessage` and try again.

> Rollback: `FLYWHEEL_COMM_BACKEND=commdb` env var on the Bridge daemon
> reverts to the legacy CommDBLeadRuntime (Bridge → Lead via CommDB), and
> ops can `rm -f ~/.flywheel/runner-state/<exec-id>/mailbox-active` to
> re-enable the buggy CommDB hook polling for that Runner. Use only as a
> last resort during the PR 1.4 rollout window.
