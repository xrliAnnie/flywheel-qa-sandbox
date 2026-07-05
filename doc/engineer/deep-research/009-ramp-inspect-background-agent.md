---
source: "https://builders.ramp.com/post/why-we-built-our-background-agent"
date: 2026-02-26
author: "Ramp Engineering"
topic: "Ramp Inspect — Background Coding Agent (Production Fintech)"
relevance: "High — production agent at major fintech, validates owned-tooling approach"
---

# Ramp Inspect: Background Coding Agent

## Why They Built It

Existing agents lacked comprehensive context and verification. Engineers need access to test suites, telemetry, visual verification, live previews. Key insight: **"Owning the tooling lets you build something significantly more powerful than an off-the-shelf tool."**

## Core Architecture

### Sandbox: Modal
- Near-instant startup
- Filesystem snapshots
- 30-minute rebuild cycle for repo images
- Sessions start from pre-built, nearly-current states

### Agent: OpenCode (not Claude Code)
- Server-first architecture → multiple client implementations
- Comprehensive plugin system
- Open-source code agents can reference directly

### State: Cloudflare Durable Objects
- Per-session SQLite databases
- High performance with hundreds of concurrent sessions
- Complete isolation between sessions

## Autonomous Execution

- Full dev environment (Vite, Postgres, Temporal)
- Production tool integration (Sentry, Datadog, LaunchDarkly, GitHub, Slack, Buildkite)
- **Child session spawning** for parallel research or multi-repo tasks
- Voice interaction for async communication
- "Agents should have agency" — never limited by missing context

## Safety Mechanisms

- **Pre-execution optimization**: Pre-build repo images with cached dependencies
- **Sync safety**: Reads allowed during git sync, writes blocked until complete
- **Authentication**: Individual GitHub tokens (not app-level) — prevents self-approval
- **Visual verification**: Frontend agents must demonstrate working changes via screenshots

## Key Patterns

### Concurrent Prompt Handling
Follow-up prompts queued during execution, not injected mid-analysis.

### Repo Auto-Selection
Fast classifier model analyzes messages + thread context + channel names → determines target repo automatically.

### Multiplayer
Multiple users work in single session, each change attributed to author.

## Results

**~30% of all PRs** merged to frontend and backend repos written by Inspect.
Adoption was organic — no mandates.

## Flywheel Takeaways

### Validates Our Direction
- Custom tooling > off-the-shelf → we're building custom (Cyrus fork + extensions)
- Multiple interfaces (Slack, web, Chrome, VS Code) → we start with Slack, can expand
- Individual attribution → our Decision Layer tracks per-decision authorship

### Should Consider
- **Pre-built repo images** — our Blueprint's Pre-Hydrator could be extended to include workspace caching
- **Visual verification for frontend** — not in our plan, relevant for GeoForge3D (Three.js)
- **Concurrent prompt queueing** — CEO might send follow-up while Flywheel is working
- **Child session spawning** — our Blueprint could spawn sub-sessions for parallel research

### Not Immediately Actionable
- Modal/Cloudflare architecture — we're local-first (Mac → VPS)
- OpenCode agent — we use Claude Code via Agent SDK
- Voice interaction — interesting but Phase 5+ at earliest
