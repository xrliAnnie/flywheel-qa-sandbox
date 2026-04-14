# Exploration: Vendor-Neutral Agent Role Architecture — FLY-104

**Issue**: FLY-104 (Design vendor-neutral agent role architecture for Flywheel)
**Date**: 2026-04-13
**Status**: Draft

## Context

Flywheel today is structurally partway toward a multi-agent architecture, but production execution is still Claude-first.

Useful abstractions already exist:

- adapter protocol in `packages/core`
- runner selection logic in `packages/edge-worker`
- partial signs of Codex/Gemini support in session routing and session state

However, the actual runtime path still leans on Claude-specific implementations:

- direct `ClaudeRunner` construction in `edge-worker`
- direct `TmuxAdapter` construction in `teamlead`
- provider-specific session fields such as `claudeSessionId` / `codexSessionId`
- internal logic that still assumes Claude as the primary execution shape

## Why This Matters

The current system works best when Claude Code is both the orchestration brain and the implementation worker. That creates two practical problems:

1. Claude Code usage becomes expensive in long-running or high-parallel execution
2. The orchestrator becomes deeply coupled to one agent runtime, making future changes harder

The near-term operating model discussed in this session is:

- **Lead = Claude Code**
- **Runner = Codex**

The longer-term goal is more general:

- lead and runner should both be treated as roles, not vendor identities
- Flywheel should be able to swap agents without rewriting orchestrator logic

## Current Architectural Read

### What already points in the right direction

- `packages/core/src/adapter-types.ts` defines a unified adapter protocol
- `packages/core/src/AdapterRegistry.ts` provides registry-based adapter lookup
- `packages/edge-worker/src/RunnerSelectionService.ts` already reasons about multiple runner types

### What still blocks flexibility

- production code paths still instantiate Claude-specific implementations directly
- session persistence is provider-shaped rather than canonical
- orchestration decisions mix together role selection, adapter selection, and provider-specific behavior

## Target Direction

Flywheel should move toward this structure:

```text
Flywheel orchestrator
  -> resolves a role
  -> role binds to an adapter
  -> adapter wraps a concrete agent
```

Example:

- `lead -> claude-code adapter -> Claude Code`
- `runner -> codex adapter -> Codex`

This allows the orchestrator to reason about responsibilities instead of vendor names.

## Core Design Principle

Flywheel should be:

- **role-driven**
- **adapter-backed**
- **artifact-oriented**

That means:

- orchestrator chooses roles such as `lead`, `runner`, `reviewer`, `triager`
- a policy/config layer maps those roles to adapters and models
- adapters translate between Flywheel contracts and specific agent runtimes
- results are captured as canonical artifacts, not vendor-specific message formats

## Canonical Contracts To Introduce

These types should become the stable internal boundary:

- `TaskSpec`
- `AgentSessionRef`
- `AgentEvent`
- `AgentResult`

They should be Flywheel-owned and agent-agnostic.

### Example intent

- `TaskSpec`: what the role is asked to do
- `AgentSessionRef`: how Flywheel tracks a running session
- `AgentEvent`: normalized stream of status/messages/tool activity
- `AgentResult`: final output plus artifacts, risks, and verification info

## Configuration Direction

Role selection and agent selection should be separated.

Recommended layering:

1. global defaults
2. project-level overrides
3. task-level overrides

Recommended precedence:

```text
task override > project config > global default
```

This policy/config layer should sit between orchestrator and adapters.

The orchestrator should ask for a role.
The policy layer should decide which adapter/model fulfills that role.

## Recommended Migration Path

### Phase 1: Make Runner swappable first

Goal:

- keep `Lead = Claude Code`
- make `Runner = Codex` viable

Why first:

- highest practical value
- least conceptual disruption
- lets Flywheel reduce Claude usage in implementation work before touching lead behavior

### Phase 2: Canonical session and event cleanup

Goal:

- remove provider-shaped session assumptions
- unify event/message tracking behind Flywheel-owned types

### Phase 3: Make lead adapter-backed too

Goal:

- allow lead to be swapped in the future without rewriting orchestration logic

## Immediate Refactor Targets

The first cleanup targets should be:

- direct runner instantiation in `teamlead`
- direct runner instantiation in `edge-worker`
- provider-specific session handling in `AgentSessionManager`
- scattered role/provider assumptions in runtime startup paths

## Deliverables From This Exploration

- architecture diagram
- role/adapter target model
- configuration layering proposal
- phased migration plan
- follow-up implementation issues

## Files Produced During This Session

- `doc/architecture/flywheel-agent-architecture-diagram.html`
- `doc/architecture/flywheel-agent-architecture-diagram.svg`

## Suggested Next Step

Do not jump directly into a full multi-agent rewrite.

Start with a constrained intermediate target:

- retain Claude Code as lead
- introduce Codex as the first serious runner adapter
- make adapter-based execution the only runtime entrypoint for runner flows

That is the smallest change that creates real architectural leverage.
