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

All files are appended via `--append-system-prompt-file` in `packages/teamlead/scripts/claude-lead.sh`. They are conditional: if a base file is missing, behavior is identical to pre-FLY-127 (no failure, no warning — backward compatible for old flywheel checkouts).

## Backward compatibility

- Missing base file → `if [ -f ]` check fails silently → original project-only behavior preserved.
- Base file present, project file missing → claude-lead.sh's existing `exit 1` fail-fast still applies (project must provide its concrete file). The base layer does **not** stand alone — it's contract, not data.

## Adding new base rules

1. Create `lead-rules-base/<descriptive-name>.md` with generic voice
2. Add a `--append-system-prompt-file` invocation in `claude-lead.sh`, conditional on the file existing (and gated to the right Lead role if appropriate)
3. Update the table above
4. Update `test-fly26-rules-split.sh` to assert the new file appears in `CLAUDE_ARGS` and is positioned before any project-side counterpart

Avoid: project-specific names, tool IDs, channel IDs, URLs, Annie's name, dept-name → Lead-name mappings. Those live in the project layer.
