---
source: "https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents"
date: 2026-02-19
topic: "Stripe Minions — One-Shot End-to-End Coding Agents (Part 1)"
relevance: "Flywheel orchestrator architecture — same problem space"
---

# Minions: Stripe's One-Shot, End-to-End Coding Agents

## Overview

Minions are Stripe's custom-built, fully unattended coding agents responsible for merging "more than a thousand pull requests each week" without human code contribution. They handle complete tasks from inception to pull request, requiring only human review.

## Why Custom Implementation

Stripe determined that existing agentic solutions couldn't adequately handle their unique constraints:

- **Scale & Complexity**: Hundreds of millions of lines across major repositories
- **Uncommon Stack**: Ruby (non-Rails) with Sorbet typing and proprietary libraries unfamiliar to LLMs
- **High Stakes**: Code handles "$1 trillion per year of payment volume" in production
- **Regulatory Requirements**: Complex financial institution dependencies and compliance obligations

Rather than adapting general tools, Stripe integrated minions with existing developer productivity infrastructure—source control, environments, code generation, and CI systems—recognizing that "if it's good for humans, it's good for LLMs, too."

## User Interface & Entry Points

Engineers invoke minions through multiple ergonomic channels:

- **Slack**: Tag the minion app within discussion threads; agents access full context and linked resources
- **Internal Applications**: Integrated with docs platforms, feature flag systems, and ticketing UI
- **CLI/Web Interfaces**: Direct initiation options
- **Automated Triggers**: CI systems automatically create tickets for flaky tests with minion-fix options

## Workflow & Capabilities

A typical minion run:

1. Starts with a Slack message containing task instructions and context
2. Executes in an isolated "devbox" environment (pre-warmed, 10-second startup)
3. Produces a git branch pushed through CI
4. Creates a pull request following Stripe's templates
5. Completes entirely without mid-process human interaction

Engineers can iterate post-completion by providing additional instructions for code refinement, or manually enhance incomplete runs as starting points.

## Technical Architecture

### Core Agent Loop

Built on a fork of Block's "goose" coding agent, minions customize orchestration by "interleaving agent loops and deterministic code—for git operations, linters, testing."

### Context & Tool Integration

- **MCP Protocol**: Provides standardized LLM function calling for network-accessible tools
- **Toolshed**: Central internal MCP server hosting "more than 400 MCP tools spanning internal systems and SaaS platforms"
- **Pre-hydration**: Deterministic MCP tool execution before minion startup to maximize context quality

### Rule Configuration

Minions consume same agent rule files as human tools (Cursor, Claude Code), but implement conditional application "based on subdirectories" to avoid impractical unconditional rules at Stripe's scale.

## Feedback & Testing Strategy

### Shift-Left Approach

Testing prioritizes early detection over iterative loops:

- **Local Linting**: Automated heuristics select and run relevant lints within "less than five seconds"
- **CI Testing**: Selective execution from three million available tests; autofixes applied automatically
- **Iteration Limit**: Maximum two CI rounds—initial push plus one remedial attempt if failures occur
- **Philosophy**: "Only after we've fixed everything we can locally" does CI run occur

Developers recognize "diminishing marginal returns" from extensive LLM-CI iterations, favoring speed and completeness balance.

## Key Advantages

- **Parallelization**: Multiple minions enable engineers to parallelize task completion, particularly valuable during on-call rotations addressing multiple small issues simultaneously
- **Unattended Operation**: No mid-execution human checks required for isolated devbox environments
- **Production-Ready**: Pull requests pass CI and require only human review, containing zero human-written code
- **Iterative Refinement**: Failed runs serve as quality starting points for focused engineer work

## Design Principles

The minion implementation reflects recognition that scaling agents requires "sophisticated mental models" and integration with tools enabling both humans and agents to "effectively operate on our scale." By providing agents the exact same infrastructure as engineers, Stripe ensured consistency in coding standards and operational reliability.
