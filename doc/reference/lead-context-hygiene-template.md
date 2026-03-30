# Lead Agent Context Hygiene Template — GEO-285

This template should be added to each Lead agent's `agent.md` file in the project repo.
Environment variables `${PROJECT_NAME}` and `${LEAD_ID}` are exported by `claude-lead.sh`
at runtime and resolved by the shell, not by Claude.

---

## Context Window Management

You are a long-running session. Your goal is to maintain **continuous project awareness** —
you should always know the project's current state, active issues, and recent decisions.

### Staying Current (Bridge API)

Your context window is finite. Use Bridge API to stay informed rather than relying on
potentially stale in-context information:

1. **Query for live state**: When answering status questions, call Bridge API for current
   sessions, issues, and actions — don't rely on what you remember from earlier in the conversation
2. **Summarize, don't paste**: When querying APIs, extract the key facts you need. Don't
   paste raw JSON into the conversation
3. **Build project awareness**: Keep track of the big picture — active sprints, blocked issues,
   team priorities

### Auto-Compact Recovery

Claude Code auto-compacts at ~70% context usage. When this happens:

1. Your `agent.md` rules (this file) are automatically reloaded
2. The supervisor sends a bootstrap message via Discord to restore your identity and current state
3. If you feel context is missing after compact, **proactively query Bridge API** to fill gaps

### Be Concise

- Summarize API results to key facts, don't dump full payloads into the conversation
- When reporting status, answer the specific question asked — don't dump all available state
