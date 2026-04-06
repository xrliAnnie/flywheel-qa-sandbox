---
source: "https://pkarnal.com/blog/parallel-ai-agents"
date: 2026-02-26
author: "Piotr Karnal"
topic: "Parallel AI Agent Orchestration — Architecture & Patterns"
relevance: "High — production patterns for multi-agent execution, isolation, observation"
---

# Parallel AI Agent Orchestration: Architecture & Patterns

## Core Architecture

- **Hierarchical model**: Orchestrator agent manages project-specific agents (not peer coordination)
- **Isolation via git worktrees**: each agent gets own worktree/branch (few MB, shared .git/ objects)
- **tmux sessions**: persistent, observable execution; can "peek" without interrupting
- **No direct agent-to-agent communication** — coordination through orchestrator only

## Key Patterns

### State Observation (No Self-Reporting)
Two-layer tracking:
1. Manual metadata files (can become stale)
2. **Live Claude JSONL session files** — "follow the chain: tmux session → pane TTY → Claude PID → working directory → Claude's session file"

Dashboard introspects actual process tree rather than trusting agent self-reports.

### Error Handling
- Self-polling loops detect CI failures and retry autonomously
- `claude-review-check` auto-sends fix prompts for review comments
- Permission boundaries require human approval for AWS/database/Slack/protected branches

### Cost Control
- "$2-5 per PR" budget in spawn prompts
- `max_turns` parameter as hard cutoff
- Rules: use Task tool for exploration, filter output, batch commits

### Tooling
~25 bash scripts (2,000 LOC total), each 60-220 lines. No framework — direct shell composition.

## Flywheel Takeaways

### Validates Our Direction
- Git worktree isolation → we should consider for parallel execution (Phase 5 multi-team)
- Budget caps per issue → matches our $5/$10 model
- CI auto-retry → already in our Blueprint pattern

### Should Consider
- **JSONL session introspection** — more reliable than agent self-reporting for status tracking
- **tmux-based observability** — letting CEO "peek" at running agents without interrupting
- **Filesystem-based state** over agent self-reports for dashboard

### Not Actionable Now
- 80/20 human/agent split — our Decision Layer aims to shrink the 20% over time
- Bash-only tooling — we're building TypeScript (more maintainable at scale)
