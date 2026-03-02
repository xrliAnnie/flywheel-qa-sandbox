# Flywheel Onboarding

Read the following files in order, then present a status summary to the user in Chinese.

## Step 1: Memory

Read the auto-memory file for accumulated decisions and architecture context:

```
~/.claude/projects/-Users-xiaorongli-Dev-flywheel/memory/MEMORY.md
```

## Step 2: Current Implementation Plan

Read the active implementation plan:

```
doc/plan/draft/v0.1.1-interactive-runner.md
```

Only read the first 60 lines (header + context + product contract) — do NOT read the full plan unless asked.

## Step 3: Architecture Exploration (if needed)

If the user's task requires understanding the architecture decisions behind the plan, also read:

```
doc/exploration/new/v0.1.1-interactive-runner-architecture.md
```

## Step 4: Codebase Orientation

Run a quick scan of current packages and their key files:

```bash
ls packages/
```

For implementation tasks, also check current test status:

```bash
pnpm test 2>&1 | tail -20
```

## Output Format

Present to the user (in Chinese):

1. **Project**: One-line description of Flywheel
2. **Current milestone**: What's been done (v0.1.0) and what's next (v0.1.1)
3. **v0.1.1 goal**: Interactive tmux-based Claude Code sessions (replace headless mode)
4. **Key design decisions**: TmuxRunner, SessionEnd hook, git SHA-range detection
5. **Plan status**: 7 tasks, dependency graph, what's ready to start
6. **Test status**: Current build/test health
7. **Ask**: "What would you like to work on?"
