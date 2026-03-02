# Flywheel — Project CLAUDE.md

## Onboarding

New session? Run `/onboarding` or read these files in order:

1. **Memory** → `~/.claude/projects/-Users-xiaorongli-Dev-flywheel/memory/MEMORY.md` (decisions, architecture, current progress)
2. **Implementation Plan** → `doc/plan/draft/v0.1.1-interactive-runner.md` (active plan, 7 tasks, Codex approved)
3. **Architecture** → `doc/exploration/new/v0.1.1-interactive-runner-architecture.md` (design decisions, tradeoffs)
4. **Reference** → `doc/reference/ralph-patterns.md` + `doc/reference/auto-claude-patterns.md` (industry patterns)

Archived docs (v0.1.0) are in `doc/*/archive/` — read only if you need historical context.

## What Is Flywheel

TypeScript orchestrator (forked from [Cyrus](https://github.com/ceedaragents/cyrus)):

```
Linear issues → DAG resolver → Claude Code sessions (tmux) → auto PR
                                        ↓ (blocked/failed)
                              Decision Layer (Haiku) → Slack → OpenClaw → CEO
```

**Goal**: Autonomous dev workflow — human attention is the bottleneck, not AI capability. CEO sets direction, Flywheel executes continuously, only escalating when it genuinely needs a human decision.

## Current Phase

**v0.1.1 implementation** — converting headless runner to interactive tmux-based sessions.

| Milestone | Status |
|-----------|--------|
| v0.1.0 Core Loop (headless `--print` mode) | ✅ Merged (PR #3) |
| v0.1.1 Exploration (interactive runner architecture) | ✅ Codex approved |
| v0.1.1 Plan (7 tasks, ~280 LOC net reduction) | ✅ Codex approved |
| v0.1.1 Implementation | ⬜ **Next** — follow `doc/plan/draft/v0.1.1-interactive-runner.md` |

## v0.1.1 Key Design Decisions

| Decision | Choice |
|----------|--------|
| Runner | TmuxRunner (interactive tmux window, replaces headless ClaudeCodeRunner) |
| Completion detection | SessionEnd hook (primary) + pane_dead polling (fallback) |
| Result detection | Git SHA-range: `baseSha..HEAD` commit count |
| Success criteria | `commitCount > 0` (Phase 1) |
| Preflight | `assertCleanTree()` — fail fast on dirty working tree |
| CLI arg order | `claude [options] [prompt]` — options before prompt |
| Blueprint | Simplified: hydrate → one-line prompt → run tmux → git check |
| PreHydrator | Minimal: only fetch Linear title + description |
| Execution | Sequential (Phase 1), parallel deferred to Phase 2+ |

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
├── exploration/{new,archive}/   — Product exploration docs
├── research/{archive}/          — Technical research
├── deep-research/               — External LLM research results
├── plan/{draft,archive}/        — Implementation plans
├── implementation/              — Implementation notes
└── reference/                   — Reference docs (Cyrus, Ralph, patterns)
```

**Lifecycle**: `draft → new → archive` (when superseded or completed).

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
2. **Interactive Runner** (v0.1.1): tmux sessions → user can see & interact ⬜
3. **Decision Loop**: Slack + Decision Logger → blocked → notify → resume
4. **Auto-Loop + Memory**: Continuous execution + per-project memory
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
