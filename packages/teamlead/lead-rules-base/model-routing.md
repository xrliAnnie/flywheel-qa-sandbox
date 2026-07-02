# Model Routing by Task Difficulty (FLY-728)

> **Layer**: flywheel base. Loaded by every **non-cos** department Lead (the
> roles that spawn Runners) via `claude-lead.sh`. Voice is generic — refer to
> abstract slots like `the founder`. Sits alongside `executor-routing.md`:
> that file picks WHICH executor owns an issue; this one picks WHICH MODEL a
> Claude runner runs on, by the issue's difficulty.

---

## You are the difficulty sorter

You (the Lead) are an LM that has followed this project. When you spawn a
Runner (`POST /api/runs/start`), you also decide **how heavy a model the task
warrants** — heavier tasks earn a stronger (more expensive) model, trivial
ones a cheap fast model. There is **no separate classifier and no extra LLM
call**: you already understand the issue at dispatch time, so you make a quick
**holistic judgment** from the signals below and pass the chosen model on the
same `/api/runs/start` call.

## The model tiers

| Difficulty | Model | `model` value |
|------------|-------|---------------|
| **Heavy** — architecture, migration, redesign, gnarly multi-file/cross-system change, deep debugging | Fable 5 | `fable` |
| **Medium** — a normal feature or bug fix of moderate scope | Opus 4.8 | `opus` |
| **Simple** — a small, well-scoped change | Sonnet 5 | `sonnet` |
| **Trivial** — a typo, a rename, a copy tweak, a version bump, a one-liner | Haiku 4.5 | `haiku` |

The bare aliases (`fable`/`opus`/`sonnet`/`haiku`) are accepted; so are the full
ids (`claude-fable-5`, `claude-opus-4-8`, `claude-sonnet-5`,
`claude-haiku-4-5-20251001`). Anything else is rejected `400 INVALID_MODEL`
(the error payload lists every accepted spelling).

## 1M context is explicit opt-in (FLY-751)

**Every tier runs a small (standard) context window by default.** A 1M-context
Claude process costs ~0.35GB more RAM per Runner, and the fleet hit swap
exhaustion when every runner inherited a 1M default — so 1M is now something
you ask for, not something you get.

- Pass `"model": "opus-1m"` (Opus 4.8 · 1M) or `"model": "fable-1m"`
  (Fable 5 · 1M) **only when the task genuinely needs the huge window** — e.g.
  it must hold a massive corpus/log/diff in one context and cannot be chunked.
- The same spellings work as issue labels (`opus-1m` / `fable-1m`) when the
  founder wants to pin 1M on an issue.
- A normal heavy task does NOT need 1M — `fable` (small context) is the right
  heavy tier.

## Signals for the judgment (holistic, not a checklist)

Weigh the issue as a whole — no rigid threshold:

- **Linear labels** — a size/estimate label (T-shirt size, points) or a type
  label (`refactor`/`architecture`/`migration` lean heavy; `chore`/`docs`/`typo`
  lean trivial; `bug`/`feature` are usually medium).
- **The title** — words like *refactor / redesign / architecture / migration /
  rewrite* lean heavy; *typo / rename / copy / bump / comment* lean trivial.
- **The description** — its length + how many systems/files it implies. A short,
  contained ask is lighter; a long, multi-part spec is heavier.

Your understanding of the actual work is authoritative — the signals assist, they
do not decide for you.

## How to pass it

Include `"model": "<tier>"` in the `/api/runs/start` body (your project layer
gives the concrete `curl`). Example: a heavy refactor → `"model": "fable"`.

## When to leave it off

- **The founder already chose a model** — if the issue carries a manual model
  label (`fable`/`opus`/`sonnet`/`haiku`/`opus-1m`/`fable-1m`, applied because
  the founder told you a model), that is the founder's explicit choice.
  **Respect it — do not pass a `model` param that fights it.** (Even if you
  did, the label wins.)
- **You genuinely can't tell** how heavy the task is — omit `model`. The run
  falls through to the project default, then the built-in runner default
  (Fable 5, small context — FLY-751; runs no longer inherit the account
  default). Don't guess wildly; a wrong-but-confident tier is worse than the
  default.

## When to ask instead of guess

If the difficulty is genuinely ambiguous **and** it matters (e.g. a task that
could be a quick fix or a deep rabbit hole, and the model choice would change
cost/quality a lot), **ask the founder** rather than pass a coin-flip tier. A
one-line question in the issue thread is cheap; a mis-routed heavy task is not.

## Visibility

The resolved model shows as a short code on the `[FLY-XX]` thread title
(**F**able / **O**pus / **S**onnet / **H**aiku) and on the Bridge dashboard, so
the founder can see at a glance which model each issue is running.

## Calibration is still being learned

The exact difficulty→tier boundaries are **not yet fixed** — the founder will
tune them with real examples and an eval of each model's capability. For now,
**trust your judgment** with the signals above; do not hard-code thresholds in
your head. This will get sharper over time.
