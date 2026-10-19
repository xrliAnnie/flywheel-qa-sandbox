# Lead → Runner Messaging — mailbox path details (FLY-142 → FLY-3083)

The rule itself lives in the **Runner channel contract** (`runner-channel-contract.md`,
loaded for every Runner-capable Lead): the ONLY Lead → Runner path is
`flywheel-comm send` (ordinary messages) / `flywheel-comm respond` (gate answers).
This file is the mailbox-mode detail behind it.

## Ordinary chat / non-gate instructions → `flywheel-comm send`

- Everyday "talk to Runner" — context handoff, status checks, follow-up
  questions, course corrections, "please look at X", asking it to abort:
  ```bash
  flywheel-comm send --from <your-id> --to <runner-xxxxxxxx | execution-id> -- "<text>"
  ```
  `--to` takes the Runner's team name (`runner-` + first 8 hex of its execution
  id; resolved against YOUR sessions, fail-closed if 0 or >1 match) or the full id.
  Put the body after `--` so text starting with `--` is never read as a flag.
- `send` writes CommDB first (message id, `delivered_at` audit stamp), then the
  Runner's mailbox routed by its transport vendor; the Runner sees
  `[lead-instruction <id>]` + your text as a new turn.
- A `SendMessage` to a Runner is **denied** by the runner-msg-guard hook (FLY-3083) —
  `to:"runner-…"`, any spelling that lands in the same inbox file, and the broadcast
  `to:"*"` alike: it would reach the inbox with no id, no audit row and no loss
  signal. The denial carries a ready-to-run `flywheel-comm send` command — run that.

## Hard gate responses → `flywheel-comm respond` CLI (still required, Batch 2 will replace)

- For unblocking a `gate_question` Runner is waiting on (the Runner is sitting
  in `flywheel-comm gate wait` polling CommDB), you **must still** use:
  ```bash
  flywheel-comm respond --db <DB-path-from-gate-question> \
    --lead <your-id> <question-id> "<your-reply>"
  ```
- The Bridge bootstrap message includes the exact command for each pending
  gate question — copy-paste it.

### FLY-175 Track 2 — `approve_to_ship` is founder-gated

The `approve_to_ship` checkpoint (the merge-to-`main` gate) is a **reserved,
founder-only action**. Its reply command in your inbox envelope now carries an
extra `--bridge-url $BRIDGE_URL` flag:
```bash
flywheel-comm respond --db <DB-path> --bridge-url $BRIDGE_URL \
  --lead <your-id> <question-id> "<your-reply>"
```
- **Why**: the CLI routes the response through the Bridge founder-consent
  evaluator, which verifies the founder authorized this ship in the issue's
  chat thread before the CommDB response is written.
- **Fail-closed**: if you omit `--bridge-url` (and `BRIDGE_URL` is unset) for an
  `approve_to_ship` gate, the CLI **refuses** to write and exits non-zero. You
  cannot resolve this gate directly. Always copy-paste the exact command from
  the envelope — it already includes the flag.
- Other checkpoints (`clarify_question`, project-specific gates) are unchanged
  and use the plain command without `--bridge-url`.
- Why this still uses CommDB: the Runner's gate-wait loop polls CommDB
  directly via `getResponse(questionId)`. It does NOT go through the
  `inbox-check.sh` hook, so it is unaffected by the FLY-142 wake bug. PR 1.4
  preserves this path; **Batch 2 PR 2.1** will replace it with await-mcp +
  `StructuredInboxRouter`.

## Driving a parked / idle Runner — use a WAKING channel (FLY-369 RC-2)

To **drive or unblock a parked (awaiting-lead / idle) Runner**, use the channel that
**wakes** it: `flywheel-comm send` (writes the Runner's mailbox → its poller injects
your message as a new turn). Do **NOT** reach for
`flywheel-comm respond` to answer a non-gate question as a way to "nudge" a parked
Runner — for a non-gate, markerless question `respond` writes CommDB but **does not
write the mailbox**, so it **silently fails to wake** the Runner (no error). That
footgun stranded parked Runners (FLY-351 S2/S3 diff-approval). Keep `respond` for
**gate answers only**.

### Wake matrix (which path actually wakes a parked Runner)

| Path | Wakes? | Why |
|------|:------:|-----|
| `flywheel-comm send` | ✅ | unconditional mailbox write (FLY-168) — the driver path |
| `respond` to a checkpoint-less `ask` | ✅ | FLY-142 `wakeAskedRunnerBestEffort` (vendor-neutral) |
| `respond` to a **marker-bearing** no-block gate (Codex) | ✅ | `wakeNoBlockGateRunnerBestEffort` via the gate marker |
| `respond` to a markerless non-`approve_to_ship` checkpoint (Claude) | ❌ | byte-compat: blocking gates poll for their own answer, no marker → no wake |
| `respond` to `approve_to_ship` | ✅ | Bridge founder-consent / bypass path writes the wake |

Rule of thumb: to **drive** a Runner, use `flywheel-comm send` (always wakes).
Use `respond` only to **answer a gate** — and never as a way to push a parked
Runner forward.

## Quick decision table

| Scenario | Path |
|---|---|
| "Hey Runner, can you also look at file X?" | `flywheel-comm send` |
| "Status update — Annie wants ETA" | `flywheel-comm send` |
| Approving `approve_to_ship` gate | `flywheel-comm respond` |
| Answering a `clarify_question` gate | `flywheel-comm respond` |
| Asking the Runner to abort | `flywheel-comm send` (Runner cooperatively stops) |

## Sentinel safety net

Even if you accidentally use `flywheel-comm respond` for an ordinary message,
the Runner's `inbox-check.sh` hook now short-circuits to a no-op when the
`~/.flywheel/runner-state/<exec-id>/mailbox-active` sentinel is present
(written automatically by TmuxAdapter at Runner spawn). The message will land
in CommDB audit but **will not be delivered** to the Runner conversation. So
if the Runner doesn't acknowledge, resend with `flywheel-comm send --json` and
read `transport_write`; if the channel itself is at fault, follow the channel
fault table below — never a side channel.

## Channel fault table (FLY-3083)

| `send --json` result | Meaning | Lead action |
|---|---|---|
| `transport_write:"ok"` | recorded + written to the Runner transport; consumption unknown | Normal. Consumption evidence = the Runner's receipt (`flywheel-comm ask --report`, or `[lead-instruction <id>]` visible in its terminal). |
| `ok`, no receipt for **10 minutes**, **and** the Bridge reports `runner_idle_detected` / stuck for that Runner (or its terminal capture is unchanged) | **suspected** consumption/delivery stall — an investigation trigger, not a diagnosis (the Runner may have consumed it and be waiting on something else) | Collect: instruction id, the CommDB row's `created_at` / `delivered_at`, the last terminal capture, the Bridge idle event time; alert `subkind=suspected_stall` (template in the Runner channel contract) and word it as "suspected". Do **not** restart the Runner, do **not** switch channels. Bridge `/health` only proves the Bridge process answers — it is not delivery evidence. |
| `skipped` + `backend_commdb` | rollback mode — the Runner reads CommDB | Normal, no action. |
| `skipped` + `no_transport` | no-transport backend (antigravity / kimi) | Normal; that Runner follows pr_handoff, no wake expected. |
| `skipped` + `no_session_lead` | the session row is missing its lead_id (registration fault) | Alert `subkind=transport_error`; check the `sessions` registration. |
| `error` + `wake_error` | immediate transport failure (inbox unwritable, …) | The CommDB row is recorded; alert `subkind=transport_error`; once the channel is fixed, resend the same content (new id — only when you've confirmed it was not delivered). |

Alert with the exact `mailbox_channel_fault` template in the Runner channel
contract (`bash "$FLYWHEEL_LEAD_ALERT_SCRIPT" … --strict-delivery`) and read its
last line: `sent` / `queued_transient` = escalated; `duplicate` = that signature
was already claimed and its **delivery is unknown** — unless you hold an earlier
`sent` / `queued_transient` result (or an issue-thread report) for the same
episode, also report in the issue thread and say the alert's delivery is unknown;
`dead_lettered` / `config_error` / anything else = **not** escalated — report the
channel fault to the founder in the issue thread in plain words.

> Rollback: `FLYWHEEL_COMM_BACKEND=commdb` env var on the Bridge daemon
> reverts to the legacy CommDBLeadRuntime (Bridge → Lead via CommDB), and
> ops can `rm -f ~/.flywheel/runner-state/<exec-id>/mailbox-active` to
> re-enable the buggy CommDB hook polling for that Runner. Use only as a
> last resort during the PR 1.4 rollout window.
