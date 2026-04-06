---
source: "https://www.youtube.com/watch?v=We7BZVKbCVw"
date: 2026-02-26
speaker: "Boris Cherny (Head of Claude Code, Anthropic)"
topic: "AI-First Engineering — Claude Code, Agent Workflows, Future of Coding"
relevance: "High — validates Flywheel direction, raises model-agnosticity concern"
---

# Boris Cherny: Claude Code & The Future of AI-First Engineering

## Key Claims

- **100% of his code is written by Claude Code** — hasn't edited a line by hand since November 2025
- **10-30 PRs/day**, running multiple agents in parallel
- **Claude reviews 100% of PRs** at Anthropic (AI code review as standard)
- **"Coding is largely solved"** — bottleneck shifted to deciding what to build, prioritization, operating across adjacent tasks
- **4% of GitHub commits** authored by Claude Code (report claim), private-repo usage believed higher
- Growth is not just increasing — it is "increasing faster" (acceleration)

## Product Principles

1. **"The product is the model"** — don't over-scaffold, let the model do what it naturally does well
2. **"Be loose with tokens"** — let engineers experiment, individual engineers spending "hundreds of thousands a month" in some cases
3. **Latent demand**: watch what users hack the product to do (recovering photos, analyzing data, growing tomatoes)
4. **Under-resource early efforts** → forces clarity and speed
5. **Same-day execution** when possible

## Architecture & Future Vision

- Claude Code started as a terminal hack, expanded to desktop/web/mobile/integrations
- Terminal wasn't ideal UX but models were improving so fast that heavier form factors would lag
- Role boundaries blurring: "software engineer" → "builder", everyone codes in cross-functional teams
- Claude Code beginning to propose fixes/features by scanning feedback channels, bug reports, telemetry
- Code review becomes the bottleneck when output volume rises

## Safety Model (Three Layers)

1. Low-level: interpretability/alignment (mechanistic interpretability, superposition)
2. Lab evals: controlled testing
3. In-the-wild observation: early releases necessary to learn real-world dynamics

## Flywheel Takeaways

### Validates Our Direction
- Decision Layer as the core value (not just code execution) — confirmed by "coding is largely solved"
- DAG + parallel execution — confirmed by "multiple agents in parallel, 10-30 PRs/day"
- Code-reviewer subagent — confirmed by "Claude reviews 100% of PRs"
- Progressive autonomy — aligned with "the product is the model" (let model do more over time)

### Critical Architecture Concern: Model Agnosticity

Boris describes a world where models improve rapidly and product form factors must keep up. This means:

**Flywheel should NOT be hardcoded to Claude Code / Agent SDK.**

Current risk in our plan:
- Blueprint directly imports `@anthropic-ai/claude-agent-sdk`
- Subagent definitions use Claude-specific `model: "haiku"` parameter

What we should ensure:
- Blueprint's agent nodes go through `IAgentRunner` interface (Cyrus already has this)
- `RunnerSelectionService` is preserved (not simplified to claude-only in Task 2)
- Agent node configuration is declarative (model/tools/prompt in config, not hardcoded)
- Future runners: OpenAI Codex agent, Gemini coding agent, local models, etc.

**"What's good for humans is good for agents"** (Stripe) + **"The product is the model"** (Boris) = keep orchestration layer model-agnostic, let the best model win at runtime.

### Not Immediately Actionable But Worth Watching
- "Claude Code proposing fixes from telemetry" → our Decision Layer learning from patterns is the same idea
- "Everyone codes" → Phase 5 multi-team shouldn't assume traditional role boundaries
- Token cost will decrease → our budget caps should be regularly revisited
