# Flywheel — Project CLAUDE.md

## Onboarding

New session? Run `/onboarding` or read these files in order:

1. **Memory** → `~/.claude/projects/-Users-xiaorongli-Dev-flywheel/memory/MEMORY.md` (decisions, architecture, current progress)
2. **Workflow** → `WORKFLOW.md` (development pipeline: Linear → Brainstorm → Research → Plan → Implement → Archive)
3. **Active Explorations** (read based on task):
   - `doc/exploration/new/v0.3-memory-system.md` — per-project memory (GEO-145)
   - `doc/exploration/new/v0.4-voice-interface.md` — push/pull voice channel for CEO (GEO-150)
   - `doc/exploration/new/v0.5-remote-screenshot.md` — visual Slack notifications (GEO-151)
   - `doc/exploration/new/v0.6-slack-threading.md` — Slack threading + workflow engine (GEO-148)
   - `doc/exploration/new/v1.0-lead-experience.md` — Lead MVP experience (GEO-146)
   - `doc/exploration/new/v1.1-multi-lead.md` — Multi-lead agents (GEO-152)
4. **Reference** → `doc/reference/ralph-patterns.md` + `doc/reference/auto-claude-patterns.md`

Archived docs are in `doc/*/archive/` — read only if you need historical context.

## What Is Flywheel

TypeScript orchestrator (forked from [Cyrus](https://github.com/ceedaragents/cyrus)):

```
Linear issues → DAG resolver → Claude Code sessions (tmux) → auto PR
                                        ↓ (completed/failed)
                              Decision Layer → Bridge API → OpenClaw (product-lead) → Slack → CEO
```

**Goal**: Autonomous dev workflow — human attention is the bottleneck, not AI capability. CEO sets direction, Flywheel executes continuously, only escalating when it genuinely needs a human decision.

## Current Phase

**v1.0 Phase 1 complete** — Lead MVP + Memory System operational. Trial run in progress.

| Milestone | Status |
|-----------|--------|
| v0.1.0 Core Loop (headless `--print` mode) | ✅ Merged (PR #3) |
| v0.1.1 Interactive Runner (tmux sessions) | ✅ Merged (PR #4) |
| v0.2 Parallel + Decision + Slack | ✅ Merged (PR #5-9) |
| v0.4 TeamLead Daemon | ✅ Merged (PR #10) |
| v0.5 OpenClaw Bridge + Actions | ✅ Merged (PR #12 + main) |
| v0.3 Step 1 Memory System (mem0 + Gemini) | ✅ Merged (PR #16) |
| v1.0 Phase 1 Lead MVP | ✅ Merged (main) |
| GEO-145: Memory Production (Supabase pgvector) | ⬜ Todo |
| GEO-146: v1.0 Phase 2 (disable auto-approve) | ⬜ Todo |
| GEO-147: Formalize workflow pipeline | 🔄 In Progress |

## Doc Structure & Lifecycle

```
doc/
├── exploration/{new,backlog,archive}/  — Product exploration / design docs
├── research/{new,archive}/             — Technical research / evaluations
├── deep-research/                      — External LLM research results
├── plan/{draft,backlog,archive}/       — Implementation plans
├── implementation/                     — Implementation notes
├── architecture/{archive}/             — Unified architecture docs
└── reference/                          — Reference docs (Cyrus, Ralph, patterns)
```

### Document Lifecycle Rules

Documents flow through a pipeline. **A document can only be archived when its downstream artifact exists.**

```
Exploration (new/) → Research (new/) → Plan (draft/) → Implementation (code) → Archive
```

**Archive rules:**
- **Exploration** → archive when Research is complete (or when it's a reference-only doc with no further action)
- **Research** → archive when Plan is complete
- **Plan** → archive when Implementation is merged (or abandoned with documented reason)
- **Never archive** a document whose downstream stage hasn't been done yet

**Backlog rules:**
- `exploration/backlog/` — explorations deferred intentionally (not abandoned, will return to later)
- `plan/backlog/` — plans written but implementation deferred

**When moving to archive, do NOT delete.** Just `git mv` to the `archive/` subdirectory. The file keeps its name.

**After archiving, update:**
1. This CLAUDE.md (remove from "Active Explorations" list)
2. MEMORY.md doc index (update path and status)

### Current Active Documents

| Type | File | Status | Next Step |
|------|------|--------|-----------|
| Exploration | v0.3-memory-system.md | Complete, deferred | Wait for Annie, then plan |
| Exploration | v0.4-voice-interface.md | Draft | Research → Plan → Implement |
| Exploration | v0.5-remote-screenshot.md | Draft | Research → Plan → Implement |
| Research | 005-memory-architecture-survey.md | Complete | Waiting on v0.3 exploration decision |
| Research | 007-remote-execution-eval.md | Complete | Needs plan or archive decision |
| Research | 008-multi-machine-consensus.md | Complete | Phase 5+, waiting |
| Plan | v0.3-step1-memory-system.md | Backlog | Waiting for Annie |

## Key Architecture Decisions

| Decision | Choice |
|----------|--------|
| Base | Fork Cyrus (~80% reuse) |
| Notification | **Slack** via OpenClaw product-lead agent |
| Agent Gateway | **OpenClaw** (persistent session, tool use, memory, multi-agent) |
| Memory | Per-project (`.flywheel/` in each project repo) — deferred |
| Decision Layer | Hard Rules + Haiku Triage + Verify + Route |
| Runner | Claude Code CLI via tmux |
| Cost tracking | N/A (Claude subscription, no per-token billing) |

## Tech Stack

- **Runtime**: Node.js / TypeScript
- **Base**: Cyrus fork (pnpm monorepo)
- **AI**: Spawn Claude Code CLI via `IAgentRunner`; Haiku for Decision Layer
- **Storage**: SQLite (`sql.js`) for StateStore
- **Issue tracking**: Linear (`@linear/sdk`)
- **VCS**: GitHub
- **Agent**: OpenClaw gateway + product-lead agent → Slack

## Implementation Phases

1. **Core Loop** (v0.1.0): Fork Cyrus → DAG → headless → auto PR ✅
2. **Interactive Runner** (v0.1.1): tmux sessions → user can see & interact ✅
3. **Parallel + Decision** (v0.2): Worktree + Decision Layer + Skill injection + Slack ✅
4. **TeamLead Daemon** (v0.4): Event pipeline + Socket Mode Slack + actions + stuck watcher ✅
5. **OpenClaw Bridge** (v0.5): Bridge API + product-lead agent + actions + auto-notification ✅
6. **Memory** (v0.3): Per-project memory — DEFERRED (waiting for Annie)
7. **CIPHER**: Decision-making memory (learn from past approve/reject patterns)
8. **Multi-Team**: Config-driven multi-agent (marketing-lead, ops-lead)

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
