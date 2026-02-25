# Flywheel

Autonomous dev workflow — once it spins up, it keeps going.

## The Idea

Two layers working together to minimize human-in-the-loop:

### Layer 1: Orchestrator (Claude Code Agent Teams)

- Pulls issues from Linear automatically
- Resolves dependency order between issues and plans
- Dispatches work to agent teammates
- Keeps executing as long as there are unblocked issues
- Goal: I set the direction, it does the work

### Layer 2: Messenger (OpenClaw → Discord / Telegram)

- **Summaries**: Periodic check-ins (e.g. hourly) — what did Claude Code accomplish, what's in progress
- **Questions**: Routes the rare approval/decision requests to me via messaging app
- Supports multiple Claude Code instances running different teams simultaneously
- I can respond from anywhere — phone, desk, wherever

### Why This Works

- Human involvement becomes rare, not constant
- I'm not the bottleneck sitting in front of tmux waiting for prompts
- Scales to multiple projects / teams running in parallel
- Discord/Telegram already have voice — can do voice responses if needed

## Status

Draft. Next step: figure out architecture and build plan together.
