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
warrants** and map that difficulty through the live fleet policy. The mapping
is a founder decision, not a permanent price/strength ladder: today heavy work
uses Fable while every lower bucket uses Opus 5. There is **no separate
classifier and no extra LLM call**: you already understand the issue at
dispatch time, so you make a quick **holistic judgment** from the signals below
and pass the configured model on the same `/api/runs/start` call.

## The model tiers

| Difficulty | Model | `model` value |
|------------|-------|---------------|
| **Heavy** — architecture, migration, redesign, gnarly multi-file/cross-system change, deep debugging | Current Fable family | `fable` |
| **Medium** — a normal feature or bug fix of moderate scope | Opus 5 | `opus` |
| **Simple** — a small, well-scoped change | Opus 5 | `opus` |
| **Trivial** — a typo, a rename, a copy tweak, a version bump, a one-liner | Opus 5 | `opus` |

Use the stable aliases (`fable`/`opus`/`sonnet`/`haiku`) for new work. In
particular, `fable` always means the current Fable family; the live mapping
comes from `~/.flywheel/models.json` and is canonicalized before spawn. Full
model ids belong only in immutable run receipts and historical pins, not in new
routing instructions. Unknown values are rejected `400 INVALID_MODEL`. Sonnet
and Haiku remain recognizable for explicit legacy/manual choices but are not
default difficulty tiers.

There is **no model blocklist**. A model is used because config names it, so the
difficulty table above is the whole routing decision — do not expect the Bridge
to second-guess a value you send.

## 1M context is explicit opt-in (FLY-751)

**Every tier runs a small (standard) context window by default.** A 1M-context
Claude process costs ~0.35GB more RAM per Runner, and the fleet hit swap
exhaustion when every runner inherited a 1M default — so 1M is now something
you ask for, not something you get.

- Pass `"model": "opus-1m"` (Opus 5 · 1M) or `"model": "fable-1m"`
  (current Fable family · 1M) **only when the task genuinely needs the huge window** — e.g.
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
  (current Fable family, small context — FLY-751; runs no longer inherit the account
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

## Configuration is the authority

The table above is the built-in fail-safe. Read the live mapping from
`~/.flywheel/models.json` for each dispatch decision; an atomic config edit
changes the next decision without a code release. Do not maintain a second
mapping in prompts or scripts.

## DAG-enrolled projects (FLY-1372)

When a project is DAG-enrolled (the project-scoped `pipeline_dag` flag + the
workflow dispatch flags are ON), a fresh dispatch runs the workflow-template
(DAG) engine and the
TEMPLATE pins each node's vendor/model. **Keep passing `model` as usual** — it
is accepted, recorded for audit, and explicitly echoed back as overridden
(`templateAuthority.overrode` in the response). Nothing breaks; the template
simply wins over the sorter's run-level pin.

Enrollment is flag-store state, never project YAML. Change it only through the
governed scoped surface, for example
`node "$FLYWHEEL_COMM_CLI" feature-flags set --name pipeline_dag --to on --project <project> --reason "enroll DAG"`.
