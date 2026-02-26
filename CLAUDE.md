# Flywheel — Project CLAUDE.md

## Onboarding

New session? Run `/onboarding` or read these files in order:

1. **Memory** → `~/.claude/projects/-Users-xiaorongli-Dev-flywheel/memory/MEMORY.md` (decisions, architecture, current progress)
2. **Exploration** → `doc/exploration/new/001-flywheel-autonomous-dev-workflow.md` (product vision, user decisions, architecture diagrams)
3. **Research 001** → `doc/research/new/001-flywheel-orchestrator.md` (Cyrus, Agent SDK, Linear API, memory isolation)
4. **Research 002** → `doc/research/new/002-research-gaps-supplement.md` (Cyrus deep eval, Decision Layer, per-project memory, cost model, Slack)
5. **Research 003** → `doc/research/new/003-decision-layer-cross-reference.md` (Gemini vs ChatGPT synthesis)
6. **Deep Research** → `doc/deep-research/` (Gemini + ChatGPT raw results on Decision Layer)

## What Is Flywheel

TypeScript orchestrator (forked from [Cyrus](https://github.com/ceedaragents/cyrus)):

```
Linear issues → DAG resolver → Claude Code sessions → auto PR
                                        ↓ (blocked/failed)
                              Decision Layer (Haiku) → Slack → OpenClaw → CEO
```

**Goal**: Autonomous dev workflow — human attention is the bottleneck, not AI capability. CEO sets direction, Flywheel executes continuously, only escalating when it genuinely needs a human decision.

**Decision Layer** is not a message relay — it's a progressive autonomy engine that learns CEO's decision patterns (CIPHER/PRELUDE framework) and gradually handles more decisions independently.

## Current Phase

**Pre-implementation**: Research complete, awaiting CEO review → then `/write-plan`.

| Milestone | Status |
|-----------|--------|
| Exploration (product vision + user decisions) | ✅ Done |
| Research 001 (core tech) | ✅ Done, awaiting review |
| Research 002 (gaps: Cyrus eval, memory, cost, Slack) | ✅ Done, awaiting review |
| Research 003 (Decision Layer cross-reference) | ✅ Done, awaiting review |
| Deep Research (Gemini + ChatGPT on Decision Layer) | ✅ Done |
| Plan | ⬜ Next (`/write-plan` after research approved) |
| Implementation | ⬜ Not started |

## Key Architecture Decisions

| Decision | Choice |
|----------|--------|
| Base | Fork Cyrus (~80% reuse) |
| Notification | **Slack** (Cyrus has transport, OpenClaw supports it, threads > Discord) |
| Memory | Per-project (`.flywheel/` in each project repo, not centralized) |
| Memory Architecture | **MemoryGateway** — unified API, 3 physical adapters: SQLite+sqlite-vec (Decision Layer), Mem0 (OpenClaw), Filesystem (Project). Single-direction sync, no Mem0 for decisions. |
| Decision Layer | CIPHER learning + Haiku classification + SQLite + sqlite-vec + local embeddings |
| Phase 1 autonomy | Pass-through (architect for extension) |
| Runner | Claude Code only (Phase 2: multi-runner via Cyrus RunnerSelectionService) |

## Doc Structure

```
doc/
├── exploration/{new,archive,backlog}/   — Product exploration docs
├── research/{new,archive,backlog}/      — Technical research (our own)
│   └── prompts/                         — Prompts for external deep research
├── deep-research/                       — External LLM research results (GPT, Gemini)
├── plan/{new,archive,backlog}/          — Implementation plans
└── reference/                           — Reference docs (Cyrus overview, etc.)
```

**Lifecycle**: `backlog → new → archive` (when superseded or completed).

## Commands

### `/onboarding`

Read memory + latest docs, present current status to CEO. Use when starting a new session.

### `/update`

Update memory file + CLAUDE.md with new decisions/ideas from this session. Run at the end of a session or after significant decisions.

## Tech Stack (planned)

- **Runtime**: Node.js / TypeScript
- **Base**: Cyrus fork (pnpm monorepo)
- **AI**: Claude Code Agent SDK (`@anthropic-ai/claude-agent-sdk`), Haiku for Decision Layer
- **Storage**: SQLite (`better-sqlite3`) + `sqlite-vec` for vector search
- **Embeddings**: `@xenova/transformers` (local, zero API cost)
- **Messaging**: Slack (via Cyrus `slack-event-transport`) + OpenClaw
- **Issue tracking**: Linear (`@linear/sdk`)
- **VCS**: GitHub

## Implementation Phases (from research)

1. **Core Loop** (W1-2): Fork Cyrus → DAG resolver → 1 issue end-to-end
2. **Decision Loop** (W3): Slack + Decision Logger → blocked → notify → resume
3. **Auto-Loop + Memory** (W4): Continuous execution + per-project memory
4. **Decision Intelligence** (W5-6): CIPHER learning + auto-approve + digest
5. **Multi-Team** (W7-8, optional): Content/Marketing teams
