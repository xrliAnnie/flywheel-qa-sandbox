# Runner Re-Engage vs Terminate — Iteration-Loop Standard Op (FLY-229)

A Runner that has finished one unit of work is often **still alive and idle at
its prompt**, ready to do the next unit (v2 / deeper dig) on the SAME issue. This
is the core move of the iteration-loop workflow (e.g. a research/learning Runner:
finish v1 → re-engage for v2). Do NOT mistake "finished one round" for "exited".

## How to tell: `runner_terminal_list`

`runner_terminal_list` classifies each session by **CommDB status + live tmux
probe** (it does NOT see the Bridge FSM state):

- `class=running` — actively working.
- `class=parked-alive` — **finished in CommDB but tmux + agent are still alive,
  idle at the prompt → RE-ENGAGEABLE.** This is the one to watch for.
- `class=dead` — terminal and the tmux window is gone.

The default view (`active_only=true`) shows `running` + `parked-alive`. A
`parked-alive` row is a live resource you can pick straight back up.

## The rule

**For a `parked-alive` runner, RE-ENGAGE — do not terminate + start a new run.**

1. Send the next instruction via your normal Runner messaging path (`SendMessage`
   / `flywheel-comm send`). The idle runner wakes and continues on the same
   worktree/branch/context.
2. Do NOT `terminate` (or `close_runner --abandon`) just to "free a slot" and
   then start a fresh run for the same issue — that throws away the runner's
   context and risks losing its branch/work, and it's unnecessary: a
   `parked-alive` runner is already re-engageable.
3. If `POST /api/runs/start` (a new run) is rejected with 409 "already has an
   active session", that is usually exactly this case — check
   `runner_terminal_list`; if it's `parked-alive`, `send` to it instead of
   forcing a new run.

## When terminate IS correct

Terminate / `close_runner --abandon` is for **abandoning** work (founder decided
not to ship it), NOT for iteration. If you genuinely need to end a parked runner
(awaiting_review / approved_to_ship), use `close_runner` with `abandon=true` (it
routes through the audited, founder-consent-gated terminate path) — never a raw
`tmux kill`.
