# Flywheel — Project CLAUDE.md

## Onboarding

New session? Run `/onboarding` or read these files in order:

1. **Memory** → `~/.claude/projects/-Users-xiaorongli-Dev-flywheel/memory/MEMORY.md` (decisions, architecture, current progress)
2. **Design Docs** (read based on task):
   - `doc/exploration/new/v0.2-parallel-execution.md` — worktree + concurrency design
   - `doc/exploration/new/v0.2-decision-layer.md` — Hard Rules + Haiku Triage
   - `doc/exploration/new/v0.2-skill-system.md` — SKILL.md injection
   - `doc/exploration/new/v0.3-memory-system.md` — per-project memory (Phase 3)
3. **Reference** → `doc/reference/ralph-patterns.md` + `doc/reference/auto-claude-patterns.md`

Archived docs (v0.1.0, v0.1.1) are in `doc/*/archive/` — read only if you need historical context.

## What Is Flywheel

TypeScript orchestrator (forked from [Cyrus](https://github.com/ceedaragents/cyrus)):

```
Linear issues → DAG resolver → Claude Code sessions (tmux) → auto PR
                                        ↓ (blocked/failed)
                              Decision Layer (Haiku) → Slack → OpenClaw → CEO
```

**Goal**: Autonomous dev workflow — human attention is the bottleneck, not AI capability. CEO sets direction, Flywheel executes continuously, only escalating when it genuinely needs a human decision.

## Current Phase

**v0.2 research complete** — ready for implementation planning.

| Milestone | Status |
|-----------|--------|
| v0.1.0 Core Loop (headless `--print` mode) | ✅ Merged (PR #3) |
| v0.1.1 Interactive Runner (tmux sessions) | ✅ Merged (PR #4) |
| v0.2 Research (6 deep research sessions) | ✅ Complete (6,474 lines of design docs) |
| v0.2 Implementation | ⬜ **Next** — turn exploration docs into implementation plans |

## Key Architecture Decisions (project-wide)

| Decision | Choice |
|----------|--------|
| Base | Fork Cyrus (~80% reuse) |
| Notification | **Slack** (Cyrus has transport, OpenClaw supports it) |
| Memory | Per-project (`.flywheel/` in each project repo) |
| Decision Layer | CIPHER learning + Haiku + SQLite + sqlite-vec + local embeddings |
| Phase 1 autonomy | Pass-through (architect for extension) |
| Runner | Claude Code only (Phase 2: multi-runner) |

## Doc Structure

```
doc/
├── architecture/{archive}/      — Unified architecture docs (v0.1.0, v0.2)
├── exploration/{new,archive}/   — Product exploration / design docs
├── research/{new,archive}/      — Technical research / evaluations
├── deep-research/               — External LLM research results
├── plan/{draft,backlog,archive}/ — Implementation plans
├── implementation/              — Implementation notes
└── reference/                   — Reference docs (Cyrus, Ralph, patterns)
```

**Lifecycle**: `backlog → draft → new → archive` (when superseded or completed).

**Current exploration docs** (v0.2+):
- `v0.2-parallel-execution.md` — Worktree, hooks, concurrency (R1)
- `v0.2-decision-layer.md` — Hard Rules, Haiku Triage, CIPHER (R3)
- `v0.2-skill-system.md` — SKILL.md injection (R4)
- `v0.3-memory-system.md` — Per-project memory with mem0/memU/deer-flow (R2)

## Commands

### `/onboarding`

Read memory + plan + present current status. Use when starting a new session.

### `/update`

Update memory file + CLAUDE.md with new decisions from this session. Run at end of session or after significant decisions.

## Tech Stack

- **Runtime**: Node.js / TypeScript
- **Base**: Cyrus fork (pnpm monorepo)
- **AI**: Spawn CLI tools (Claude Code CLI) via `IAgentRunner`; Haiku for Decision Layer (Phase 2+)
- **Storage**: SQLite (`better-sqlite3`) + `sqlite-vec` for vector search (Phase 2+)
- **Issue tracking**: Linear (`@linear/sdk`)
- **VCS**: GitHub

## Implementation Phases

1. **Core Loop** (v0.1.0): Fork Cyrus → DAG → headless `--print` → auto PR ✅
2. **Interactive Runner** (v0.1.1): tmux sessions → user can see & interact ✅
3. **Parallel + Decision** (v0.2): Worktree parallel execution + Decision Layer + Skill injection ⬜
4. **Memory** (v0.3): Per-project memory (`.flywheel/memory.json` → SQLite + sqlite-vec) ⬜
5. **Decision Intelligence**: CIPHER learning + auto-approve + digest
6. **Multi-Team** (optional): Content/Marketing teams

## Core Behaviors

- **Surface assumptions**: Before implementing anything non-trivial, list your assumptions explicitly. Never silently fill in ambiguous requirements.
- **Push back**: You are not a yes-machine. Point out problems directly, explain downsides, propose alternatives.
- **Enforce simplicity**: Actively resist overcomplication. Prefer the boring, obvious solution.
- **Scope discipline**: Touch only what you're asked to touch. No unsolicited cleanup.
- **Dead code hygiene**: After refactoring, list newly unreachable code and ask before removing.
- **Confusion = stop**: On inconsistencies or unclear specs, stop and ask.

## Non-Negotiables

- External input must be validated at system boundaries.
- Handle failure paths explicitly — no silent swallowing of errors.
- No hardcoded secrets; use environment variables or config.
- Auth/authz boundaries must be verified, not assumed.

## Agent Strategy

- Independent checks/tasks should run in parallel (use multiple Task calls in one message).
- Complex changes: call planner agent first, code-reviewer agent after implementation.

## Output

After modifications, summarize: what changed and why, what you intentionally left alone, potential concerns.

## Mermaid Diagrams

Prefer Mermaid diagrams for plans, architecture docs, and any document describing flows or relationships.
