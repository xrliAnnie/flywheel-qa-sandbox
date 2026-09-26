# Stuck-Runner Re-Manage — FLY-195

When the Bridge delivers a **`runner_stuck_escalation`** event, a Runner you
own has shown **unchanged terminal output for ≥10 minutes while
`status=running`** (with no pending gate and no review state). The Bridge has
NO judgment — it is a patient tripwire. **You are the judge.** The event is a
candidate, never a verdict.

The event message carries evidence to help you judge fast: stuck minutes,
a truncated terminal tail, `stream_error_signature` (the canonical
`API Error: … Stream idle timeout` line was seen), `input_box_present`
(idle input box at the bottom), and the **episode fingerprint** on its own
labeled line:

```
Episode-Fingerprint: <16 hex chars>
```

Copy that value EXACTLY — every action below echoes it back as
`episode_fingerprint`. If the line is missing or shows `(missing)`, do NOT
guess: report it in the issue thread instead of calling the endpoints.

## Step 1 — Look, then judge

Capture the Runner's terminal yourself (`runner_terminal_capture` +
`runner_terminal_status`) and combine with the Bridge evidence. Three honest
outcomes:

1. **Genuinely stuck** (canonical shape: stream-idle-timeout error, then the
   loop stopped at an idle input box) → Step 2 ladder.
2. **Actually working** (output resumed, or it is doing something slow but
   real) → write disposition `false_positive` (Step 3).
3. **Legitimately waiting** (on a human, an external system, a long build) →
   write disposition `legitimate_wait`, or `snooze` with a deadline if you
   want to be re-asked later.

## Step 2 — Re-manage ladder (escalate only as far as needed)

**① Mailbox wake first.** Send the Runner an ordinary message via your normal
Runner messaging path (`SendMessage` — see runner-messaging rules): ask it to
continue / report state. Then **wait a bounded `MAILBOX_WAKE_WAIT_MS` = 60
seconds (60_000 ms)** and **re-capture the terminal**. Two outcomes:

- Output changed because the Runner **resumed real work** → done (no
  disposition needed; the Bridge clears the episode when output changes).
- The Runner only acknowledged and is **still legitimately waiting** (on a
  human / an external system) → you MUST also write `legitimate_wait` or
  `snooze` (Step 3). FLY-253: without the receipt, your wake itself
  guarantees the next episode ~15 minutes later (the pane change restarts
  the stagnation clock) — this drove the LEARN-57 alert treadmill.

**② Restricted recovery nudge.** Only if the re-capture shows the SAME frozen
frame still parked at an idle input box, call the Bridge's restricted nudge:

```bash
curl -s -X POST "$BRIDGE_URL/api/sessions/<execution_id>/recovery-nudge" \
  -H "Authorization: Bearer $TEAMLEAD_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"leadId":"<your-lead-id>","episode_fingerprint":"<fingerprint>"}'
```

- It types ONLY the allowlisted phrase **`continue`** into the Runner's tmux
  window, and ONLY after the Bridge re-verifies every gate at send time
  (status still `running`, no pending gate/review, fingerprint still matches
  the live frame, idle input box visible). If any gate fails it refuses —
  that refusal is information: re-judge from a fresh capture.
- A successful nudge **automatically records your `handled_remanaged`
  disposition** — you do not need to write one.
- This endpoint is the ONLY sanctioned way to type into a Runner's terminal.
  Do **not** use raw `runner_terminal_input` to free-type instructions,
  answer gates, or approve anything — wording semantic instructions through
  the terminal bypasses the founder-consent boundary (FLY-175). Semantic
  instructions go via mailbox; gate answers go via `flywheel-comm respond`.

**③ Heavy actions are founder-gated.** If the Runner needs a restart, kill,
or its work shipped, that is a reserved action: present your judgment to the
founder in the issue's chat thread and proceed only per
founder-only-authority rules. Write disposition `needs_founder` so the Bridge
knows the episode is in the founder's court.

## Step 3 — Write your disposition (this is what makes your judgment count)

For outcomes 2/3 (and `needs_founder`), write an explicit receipt:

```bash
curl -s -X POST "$BRIDGE_URL/api/sessions/<execution_id>/stuck-disposition" \
  -H "Authorization: Bearer $TEAMLEAD_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"leadId":"<your-lead-id>","episode_fingerprint":"<fingerprint>",
       "disposition":"false_positive","note":"<one line why>"}'
```

Dispositions: `false_positive` | `legitimate_wait` |
`snooze` (requires `"snooze_until_ms": <epoch ms>`) | `needs_founder`.
(`handled_remanaged` is implicit via a successful nudge.)

**Scope (FLY-253)** — your receipt's reach depends on what you judged:

| disposition | reach | expires |
|---|---|---|
| `legitimate_wait` | the WHOLE runner — every later episode of this execution stays silent, whatever the pane does | after ~72h the Bridge asks you ONCE more (still parked? one more curl) |
| `needs_founder` | the whole runner (in the founder's court) | same ~72h re-ask |
| `snooze` | the whole runner | your `snooze_until_ms`, capped at the same ~72h ceiling (the response echoes the effective value) — on expiry the Bridge re-asks YOU first (not Annie) |
| `false_positive` | this pane frame only ("actually working" — output will change by itself) | n/a |

Pick `snooze` when the wait has a known deadline; `legitimate_wait` for an
open-ended park. **`re_arm`** is the undo: when the runner is back to real
work and you want stuck detection live again before the TTL, POST the same
endpoint with `{"leadId":"<your-lead-id>","disposition":"re_arm"}` (no
fingerprint needed) — it clears the runner-wide latch.

**Why this matters**: if no disposition lands within ~5 minutes of the
escalation and the Runner is still frozen, the Bridge assumes YOU are down
too and pages Annie directly (`runner_stuck_unhandled`). Your receipt is
authoritative — writing `false_positive` / `legitimate_wait` / `snooze`
suppresses that page. Not writing one means Annie gets pinged about
something you already looked at. One `legitimate_wait` now covers the whole
park — you will NOT be re-paged per pane twitch (FLY-253).

## Step 4 — Notify Annie (cadence)

- **You acted** (nudge sent, mailbox re-wake worked, or `needs_founder`) →
  **ping Annie once** in the issue's chat thread: one line — what was stuck,
  what you did, current state. No play-by-play.
- **False alarm / legitimate wait** → **stay silent**; the disposition is the
  audit trail. Do not relay noise.

## Hard boundaries

- Never conclude "stuck" from the escalation alone — always look first.
- Never free-type into the Runner terminal; the allowlisted nudge endpoint is
  the only terminal write you may trigger.
- Restart / kill / ship / close remain founder-only (FLY-175), regardless of
  how stuck the Runner looks.
