# Flywheel Lead Rules — Base Layer

This directory contains **flywheel-shipped, project-agnostic Lead rules** that apply to every project running Flywheel. They define abstract behavior contracts; project-specific files instantiate those contracts with concrete data.

## Why a base layer

When the same rule needs to be enforced across every project (e.g., "before spawning a Runner, classify the message as direct-spawn / ambiguous / discussion / Bridge-rejected" — see FLY-127), the rule logic should live in one place: flywheel. Putting it in each project's `.lead/shared/` would mean:

- Every new project re-derives the same rule (drift, missed edge cases)
- Bug fixes require touching N projects
- The rule's voice gets entangled with project-specific data

## Extension model (Java analog)

```
flywheel base                  ↔   abstract class
project's .lead/shared/        ↔   concrete subclass that extends the base
```

| Layer | Voice | Content |
|-------|-------|---------|
| **Base** (`lead-rules-base/<name>.md`) | Generic — `each dept Lead`, `your dept`, `the Linear label that maps to your dept`, `the cos-lead role` | Abstract behavior: "what 4 cases of spawn message exist", "how to react when Bridge returns DEPT_SCOPE_REJECT", "split routing by Lead" |
| **Project** (`<project>/.lead/shared/<name>.md` or `<project>/.lead/<role>/identity.md`) | Concrete — `Peter`, `Oliver`, `Simba`, `1485896147951419434`, `https://discord.com/channels/...` | Concrete data: "Peter is the Product Lead", "Bridge URL is X", channel IDs, Lead bot IDs, project-specific tone, project-specific tools |

The **same filename** across both layers makes the inheritance relationship explicit. `<project>/.lead/shared/department-lead-rules.md` extends `lead-rules-base/department-lead-rules.md`. The base provides the contract; the project fills in the specifics.

## Load order

`claude-lead.sh` appends the base file **first**, then the project file:

```
--append-system-prompt-file lead-rules-base/<file>.md          ← base, abstract
--append-system-prompt-file ~/.flywheel/lead-rules/<lead>/<file>.md  ← project, concrete
```

Project comes second so it can:
- Add concrete instantiation (most cases) — base rules stay enforced; project just plugs in real names / IDs / channels
- Override base in safety-critical edge cases (rare — should be rare)

This matches `class Project extends Base` semantics: subclass declarations sit on top of superclass; subclass methods can call back to or override superclass methods.

## Files

| File | Audience | Purpose |
|------|----------|---------|
| [`department-lead-rules.md`](department-lead-rules.md) | Department Leads (non-cos roles) | FLY-127 Action Gate, Multi-Lead Mentions handling, Bridge rejection diagnostic templates; FLY-152 Shared Channel Reply Discipline |
| [`cos-lead-rules.md`](cos-lead-rules.md) | Cos-lead role only | FLY-127 Department Routing Discipline (one Lead per backend spawn directive); FLY-152 Shared Channel Reply Discipline |
| [`founder-only-authority.md`](founder-only-authority.md) | **Every** Lead role (cos AND dept) | FLY-175 Track 1 — merge-to-main and stop-runner are founder-only authorized actions; Lead self-judgment is not consent |
| `founder-html-delivery.md` | universal (cos + dept) | FLY-203: any HTML artifact the founder asks to see is delivered via `flywheel-comm publish-report` (one message: title + full-page image + link); local file paths are never posted as delivery |
| [`executor-routing.md`](executor-routing.md) | Department Leads (non-cos roles) | FLY-178 — route the Runner executor by the ACTUAL work type (pass `agentName`), end-to-end ownership; engineering executors self-research, so engineering work is not pre-staged through a PM executor |
| [`runner-patrol-rules.md`](runner-patrol-rules.md) | Department Leads (non-cos roles; both mailbox + commdb) | FLY-369 — relay every Runner lifecycle event to the `[FLY-XX]` thread (runner-done ≠ acceptance-met), drive parked Runners via a waking channel (never `respond` for non-gate), proactively patrol your Runners, and make continuation Runners read the committed plan first |
| [`default-enable-policy.md`](default-enable-policy.md) | Department Leads (non-cos roles) | FLY-707 (FLY-698 epic) — built features ship ENABLED (config opt-ins like `doc_flow.enabled`, default-off env flags), not left dormant; enablement + a real fires-check is part of shipping. Security/governance gates (`founder_consent`, branch protection) are EXPLICITLY EXEMPT (blind `enforce` can wedge merge/ship) |

All files are appended via `--append-system-prompt-file` in `packages/teamlead/scripts/claude-lead.sh`. They are conditional: if a base file is missing, behavior is identical to pre-FLY-127 (no failure, no warning — backward compatible for old flywheel checkouts).

> **Pattern note (FLY-178)**: `executor-routing.md` is a base file whose
> project-side instantiation does **not** use a same-named project file.
> Instead, the concrete executor names / work-type→executor map / `curl`
> live in the project's `department-lead-rules.md` "Start Runner" subsection
> (a small, documented deviation from the same-filename inheritance pattern —
> chosen to avoid a new project file + extra wiring for a few lines of
> concrete data).

## Backward compatibility

- Missing base file → `if [ -f ]` check fails silently → original project-only behavior preserved.
- Base file present, project file missing → claude-lead.sh's existing `exit 1` fail-fast still applies (project must provide its concrete file). The base layer does **not** stand alone — it's contract, not data.

## Adding new base rules

1. Create `lead-rules-base/<descriptive-name>.md` with generic voice
2. Wire it into **both** load paths so they cannot drift:
   - `claude-lead.sh` — add a `--append-system-prompt-file` invocation, conditional on the file existing, gated to the right Lead role
   - `lead-rules-bundle.sh` — add a matching `_lrb_emit` for the same role (this is the shared resolver the Codex full-access path uses)
3. Update the table above
4. **Primary gate** — update `packages/teamlead/src/__tests__/lead-rules-bundle.test.ts`: add the file to the pinned per-role ordered bundle. Its parity tests then assert `claude-lead.sh` references the file in the same monotonic order, so the resolver and `claude-lead.sh` cannot drift. (The older `test-fly26-rules-split.sh` shell simulator is stale relative to the modern `claude-lead.sh` and is no longer the primary coverage; update it only if your team still treats it as live.)
5. Optionally add a content-contract fixture (see `fly369-patrol-rule.test.ts` / `fly222-memory-rule.test.ts`) pinning the rule's key elements against future trims.

Avoid: project-specific names, tool IDs, channel IDs, URLs, Annie's name, dept-name → Lead-name mappings. Those live in the project layer.
