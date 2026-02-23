# Voice-in-the-Loop — Plan Workflow

## Structure

```
plan/
├── README.md          # This file — workflow instructions
├── overview.md        # Shared design (architecture, data models, protocols)
├── phase-N/
│   ├── plan.md        # Phase goals, tasks, acceptance criteria
│   └── progress.md    # Implementation progress tracking
```

## How to Use

1. **Before starting a phase**: Read `plan/phase-N/plan.md` to understand the goals, tasks, and acceptance criteria. Reference `plan/overview.md` for shared design details.

2. **During implementation**: Update `plan/phase-N/progress.md` as tasks are completed. Log key decisions, blockers, and solutions in the Log section.

3. **Phase completion**: All tasks in `progress.md` should be marked `done`. Acceptance criteria must pass. Only then proceed to the next phase.

4. **Shared design changes**: If a phase requires changes to the shared architecture, update `plan/overview.md` and note the change in the phase's progress log.

## Progress Status Values

| Status | Meaning |
|--------|---------|
| `not started` | Work has not begun |
| `in progress` | Currently being worked on |
| `done` | Completed and verified |
| `blocked` | Cannot proceed — see Notes column |

## Phase Order

Phases are sequential: **0 → 1 → 2 → 3 → 4**. Each phase builds on the previous one. Do not skip phases.

## Original Design

The full original design document is preserved in `PLAN.md` at the repo root (archive / single source of truth).
