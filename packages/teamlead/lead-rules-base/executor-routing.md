# Executor Routing by Work Type (FLY-178)

> **Layer**: flywheel base. Loaded by every **non-cos** department Lead (the
> roles that spawn Runners) via `claude-lead.sh`. Voice is generic — refer to
> abstract slots like `the founder` and `your project's declared executors`.
> The project layer (`<project>/.lead/shared/department-lead-rules.md`)
> supplies the concrete executor names, the work-type→executor map, and the
> literal `curl` to `/api/runs/start`.

---

## The default mental model — one issue, one executor, end to end

The normal shape of work is: **one issue → one correctly-typed executor →
that executor owns the whole lifecycle** (brainstorm → research → plan →
implement → ship).

Before you spawn a Runner (`POST /api/runs/start`), your job is to pick the
**single executor that will own this issue end to end**, based on the
**actual type of work** the issue requires — then pass `agentName`
explicitly. The issue's Linear label is a **hint**, not the decision. Your
judgment about the actual work **overrides** the label-derived default.

## Engineering executors do their own research — do NOT pre-stage with PM

This is the rule that prevents the incident class this file exists for:

- **Engineering executors (e.g. backend / frontend) run their own
  brainstorm / research / plan** as part of their own lifecycle. An
  engineering issue does **NOT** need a product/PM executor to "pre-research"
  it first.
- **Engineering work goes to the engineering executor from the start.** If
  the deliverable is code / a PR / a deployment, route to the engineering
  executor — it will research whatever it needs (the API, the library, the
  data) on its own, then implement and ship.
- **Product/PM research ≠ engineering research.** An engineering executor's
  research is a phase *inside* its own process, not a separate product stage
  handed off to it.

Concretely: an issue whose end-product is a working feature is an
engineering issue **even if it also requires investigation** — give it to
the engineering executor, not to a PM executor "to scope first."

## When the PM / research executor IS the right choice

Use the product / PM / research executor **only when the deliverable itself
is a research or product artifact** — a research write-up, a spec, a PRD, a
competitive analysis, a problem definition. That is: the *output* is the
document, not code. The PM executor is **never** the "phase 1" of an
engineering task.

## How to route

1. **Classify the actual work** by its end-product (a shipped feature/fix →
   engineering executor of the right domain; a research/spec/PRD doc → PM
   executor; a design artifact → designer; etc.).
2. **Map to the executor that will own it end to end** using your project's
   declared executors (the `agents:` block in
   `<project>/.flywheel/config.yaml`; `flywheel doctor` lists the valid
   names).
3. **Pass `agentName` explicitly** on `/api/runs/start` (your project layer
   gives the concrete `curl`). This bypasses label dispatch via
   `AgentDispatcher.dispatchByName`.
4. If the name is unknown, Bridge returns `400 INVALID_AGENT_NAME` with an
   `available: [...]` list — read it and retry with a valid name.

The `agentName` value is the **config key** your project declares in its
`agents:` map (the short key, e.g. the one for your dept's implementation
executor) — **NOT** the executor's markdown file name or its frontmatter
`name`. `available: [...]` lists the valid keys.

You may omit `agentName` and let label dispatch (FLY-137) pick the executor —
but only when the label genuinely reflects the end-to-end work. Don't omit it
as a reflex; the default this rule sets is **you decide, the label assists.**

## Department scope still applies (FLY-127 — do not weaken it)

"The label is a hint" is about **executor selection**, not department
ownership. `agentName` bypasses label-based *executor* matching; it does
**NOT** bypass FLY-127 department-scope enforcement, which Bridge checks
*before* it ever validates `agentName` (`isLeadInScope()` →
`DEPT_SCOPE_REJECT`). You may only choose an executor for an issue already in
**your** department's scope; passing `agentName` does not authorize spawning
on another department's issue. If Bridge returns `DEPT_SCOPE_REJECT`, follow
your Action Gate rule (fix labels / defer to the owning dept) — do not try to
force it with an explicit `agentName`.

## Trust your judgment (no extra friction)

The override deliberately bypasses label match — that is the point. Your
work-type classification is authoritative. You do **not** owe a written
justification when your chosen executor contradicts a clean label; choosing
the right end-to-end executor is exactly your job. The only guardrail is the
name-validity check above (`INVALID_AGENT_NAME` catches typos / unknown
names).

## Two issues is a deliberate design, not a drift-recovery

Splitting work into a research issue (PM executor) **then** an implementation
issue (engineering executor) is a **deliberate decision made at
issue-creation time** — typically by the founder, or by a Lead who recognizes
that a genuinely independent research deliverable must be produced *and
consumed* before implementation can sensibly start (e.g. "we don't yet know
whether to build X or Y; produce a recommendation first"). It is expressed as
**two issues**, each owned end to end by its correct executor.

It is **NOT** an automatic action triggered by "a research issue's work
turned into implementation." If an issue was mis-typed and the work is really
engineering, the fix is to **route it to the engineering executor and let
that one agent own it end to end** — not to insert a PM pre-research stage.

## Mis-typed but not yet started → just correct the routing

If you realize an issue is pointed at the wrong executor and the Runner
hasn't meaningfully started, simply correct the routing: fix the label and/or
pass the right `agentName` on the (re)spawn, so the correct single agent owns
it end to end. No handoff ceremony needed.

## Mid-run protocol mismatch

If a Runner you own is already executing under the **wrong protocol** (e.g. a
PM-protocol Runner doing implementation work):

- **Do NOT auto-terminate, reject, defer, shelve, or re-dispatch it.** Each
  of those ends a Runner's life and is **founder-only** in the current window
  (see `founder-only-authority.md`, R2). A protocol mismatch is not an
  exception to R2.
- **Instead**: surface the mismatch in the issue's chat thread and
  **propose** the correct re-routing (e.g. "this is engineering work; I
  recommend we re-dispatch the engineering executor to own it end to end").
  Then **wait for the founder's decision**.

## Relationship to label dispatch (FLY-137)

This rule sits on top of FLY-137 label dispatch. When you omit `agentName`,
FLY-137's label dispatch still applies as the fallback (own-dept label match
→ top-level catch-all → project `default_agent` → shipped generic). This
rule's contract: lead with the end-to-end work-type judgment; don't *rely* on
the fallback for non-trivial routing.

## Project-layer extension

Your project layer provides the concrete executor names, the
work-type→executor mapping, and the literal `curl`. It MUST align with this
contract (end-to-end ownership, engineering self-research); it must not
re-assert an older "omit by default / don't override on a clean label"
framing.
