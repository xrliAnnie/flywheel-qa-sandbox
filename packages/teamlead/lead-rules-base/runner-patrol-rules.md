# Runner Status Relay + Proactive Patrol — FLY-369

Bridge does **not** auto-post Runner status to the founder's Discord (FLY-163, by
design). You (the Lead) are the **only** channel that surfaces a Runner's real
state to the founder. When you drop a beat, the founder's experience is "I handed
work down and it vanished" — even if the Runner is mid-flight or already done.
This file is the discipline that closes that gap. It is **discipline, not a
guarantee** — the automated relay / patrol engine (stuck detection, auto-recovery,
unified alerting) belongs to **FLY-271** and **FLY-368**, NOT here.

---

## 1. Proactive patrol — sweep your Runners, don't wait to be paged (RC-3)

Reactive detection already exists (Bridge pushes `runner_idle_detected`,
`runner_stuck_escalation`, `session_stuck`/`session_orphaned`, gate events to your
inbox). But **parked / done-lingering Runners produce no new event** — "no alert"
is silently read as "all fine." So you must **actively** take stock.

**When**: after you finish handling a batch of inbox messages (natural cadence —
no new timer), and at task boundaries (before starting a new subtask, before
committing). This is an active roll-call, not waiting for an escalation.

**Starting point (NOT an acceptance oracle)**: `runner_terminal_list`. It
classifies each session by **CommDB status + a live tmux probe** — `running` /
`parked-alive` / `dead`. It does **not** see Bridge FSM or Linear completion
state, so treat it as "which Runners exist and are they alive," never as proof
that work is accepted.

**Per-class action**:

| Class | What it means | Your move |
|---|---|---|
| `running` | actively working | check output freshness; stale → judge per `stuck-runner-remanage.md` and relay status |
| `parked-alive` | finished a unit, idle at prompt, **re-engageable** | re-engage (see `runner-reengage-rules.md`) for the next unit, or wrap up + close — **never leave it sitting silently** |
| `dead` / done-lingering | terminal / tmux gone | wrap up + close (`done-running-reconciler` FLY-324 + the close-driven archive, FLY-369 RC-5) |

**Cross-check before any close / reopen / Linear status change**: never act on
`runner_terminal_list` alone. Before closing a Runner or moving a Linear issue's
status, cross-check the issue thread + session state + PR/commit evidence +
founder/QA acceptance. The terminal list tells you a process is idle; it does NOT
tell you the work is accepted.

---

## 2. Relay EVERY lifecycle event to the founder's thread (RC-1) — mandatory

For **every** Runner lifecycle event below, you MUST relay the status to the
issue's `[FLY-XX]` chat thread via `POST /api/chat-threads/send` (mechanics +
fallbacks: see `department-lead-rules.md` §"Issue-Bound Reply"). This is a
**checklist, not a judgement call** — relay is the default, silence is the bug.

- `session_completed` — Runner finished / opened a PR.
- `session_failed` — Runner errored / blocked.
- `runner_stuck_escalation` — per `stuck-runner-remanage.md` cadence (act → ping once; false alarm → stay silent + write disposition).
- `runner_question` / `gate_question` — surface the question + your answer.
- parked-awaiting-lead — a Runner waiting on you for a decision/approval.

### "Runner delivered work" ≠ "acceptance met" ≠ "OK to mark Done" (FLY-576)

The sharpest failure is the founder seeing a **fake** completion. Distinguish
three states and **never collapse them**:

1. **Runner delivered** — PR opened / merged, Runner idle. This is "work handed
   in," not "work accepted."
2. **Acceptance met** — QA passed and/or the founder accepted it.
3. **OK to mark Done** — acceptance met.

**Never report "Runner done" or "Linear flipped to Done" as "accepted."** Linear's
Done can flip automatically when a linked PR/branch merges (Linear's native GitHub
integration — a PR merge is **not** an acceptance signal). If acceptance is not
met, say so plainly in the thread and, **as an explicit acceptance correction**,
reopen the issue (e.g. via the Bridge's manual `PATCH /api/linear/update-issue`
proxy — token-authed, resolves a `status` name to a workflow state). That manual
proxy is for founder-directed / acceptance corrections **only** — it is not a
routine status machine.

---

## 3. Driving a parked / idle Runner — use a WAKING channel (RC-2)

To drive or unblock a parked (awaiting-lead / idle) Runner, use a channel that
**wakes** it. Do **not** use `flywheel-comm respond` to reply to a non-gate
question as a way to "nudge" it — for a non-gate, markerless question `respond`
writes CommDB but does **not** write the mailbox, so it **silently fails to wake**
(no error). `respond` is for **gate answers only** (`approve_to_ship`,
`clarify_question`, …).

**Backend-self-contained** (this file loads on both the mailbox path AND the
`commdb` rollback path, where `runner-messaging-rules.md` is intentionally
skipped): use the waking Runner channel **for your current backend** —

- **mailbox** mode (prod default): `SendMessage` (MCP teammate API) or
  `flywheel-comm send`.
- **commdb** rollback: the legacy `flywheel-comm send` path.

Either way: **never** use `respond` as an ordinary driver. The full wake matrix
(which exact paths wake which Runner) lives in `runner-messaging-rules.md` for the
mailbox path; the rule in this paragraph stands on its own without it.

---

## 4. Continuation / handoff Runner — make it read the committed plan first (RC-6)

When you hand work to a **fresh continuation Runner** on an issue that already has
committed design, do NOT let it re-derive from scratch — it may rebuild a path the
team already superseded (FLY-350: a fresh Runner re-walked an abandoned design).

When you dispatch a continuation / handoff Runner:

1. **Explicitly command it** to first read the **committed plan** (in
   `doc/engineer/plan/…`) + the branch's existing commits before designing.
2. **Verify its first brainstorm aligns** with the committed design before you
   greenlight it — do **not** rubber-stamp. If it drifted, re-anchor it to the
   committed plan before any implementation.
