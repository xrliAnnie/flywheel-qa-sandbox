# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Voice-in-the-Loop: a Hammerspoon plugin that enables voice control of Claude Code running in tmux panes. The system monitors tmux panes for prompts (approve/reject, numbered menus), reads them aloud via TTS, listens for voice commands, and writes the selection back to the correct pane.

- **Language**: Lua (Hammerspoon runtime)
- **Platform**: macOS only
- **Dependencies**: Hammerspoon, tmux
- **Design**: See `plan/overview.md` for architecture and shared design; `plan/phase-N/plan.md` for per-phase plans; `PLAN.md` for original full design (archive)

## Architecture

```
~/.hammerspoon/voice-loop/   # Lua source modules (this repo's code goes here)
~/.claude/voice-loop/        # Runtime config + logs (not in repo)
```

### Data flow

```
tmux capture-pane → Monitor → Parser → Queue (FIFO, dedupe)
                                          ↓
                              Dispatcher → TTS → ASR Listener → Router
                                                                  ↓
                                                        tmux send-keys (Writer)
```

### Module responsibilities

| Module | File | Role |
|--------|------|------|
| Monitor | `monitor.lua` | Poll `capture-pane` every 1.5s for all watched panes |
| Parser | `parser.lua` | Regex + heuristic detection of choice prompts |
| Queue | `queue.lua` | Event FIFO with dedupe, snooze, expiry state machine |
| Dispatcher | `dispatcher.lua` | Drives the TTS→ASR→Router→Writer cycle |
| TTS | `tts.lua` | `hs.speech` wrapper, announcement templates |
| Listener | `listener.lua` | `hs.speech.listener` wrapper, command vocabulary |
| Router | `router.lua` | Maps recognized voice commands to actions |
| Writer | `writer.lua` | `tmux send-keys` with pane validation and fingerprint re-check |
| Logger | `logger.lua` | JSONL event log to `~/.claude/voice-loop/logs/` |

Entry point: `init.lua` — loaded from `~/.hammerspoon/init.lua`.

## Development Workflow

### Loading in Hammerspoon

```lua
-- In ~/.hammerspoon/init.lua, add:
voiceLoop = require("voice-loop")
voiceLoop:start()
```

Reload after code changes: **Cmd+Shift+R** (Hammerspoon default) or run `hs.reload()` in the Hammerspoon console.

### Testing

No Lua test framework is set up yet. Plan calls for:
- **Unit tests**: Parser patterns against real `capture-pane` samples stored in `~/.claude/voice-loop/samples/`
- **Integration tests**: Script that `echo`s simulated prompts into a tmux pane and verifies the pipeline
- See `PLAN.md` Section 11 for the full test plan and end-to-end test script

### Useful Hammerspoon console commands

```lua
voiceLoop:start()   -- start monitoring
voiceLoop:pause()   -- pause (keep queue)
voiceLoop:resume()  -- resume
voiceLoop:stop()    -- stop + clear queue
```

## Key Technical Decisions

- `hs.speech.listener:foregroundOnly(false)` — required for background recognition
- **tmux reads** (`capture-pane`, `display-message`, `list-panes`): `hs.execute` sync — result needed immediately
- **tmux writes** (`send-keys`): `hs.task` async — avoid blocking Hammerspoon main loop
- Pane validation: `tmux display-message -p -t <target> '#{pane_id}'` (not `has-session`)
- Prompt fingerprint (dedupe_key) re-verified before every `send-keys` and every replay
- High-risk operations (yes/no, approve/reject, destructive keywords): two-step confirmation enabled by default
- `capture-pane` without `-e` flag — output is plain text, no ANSI stripping needed
- `NSSpeechRecognizer` provides no confidence scores — rely on small vocabulary + listen-only-when-waiting

## Development Conventions

- Code, comments, commit messages in **English**
- Design docs and plans in **Chinese** (technical terms in English)
- TTS announcements: Chinese sentence structure + English option text
- ASR: English command words by default; Chinese optional after Phase 0 gate passes

## Workflow

The project is organized into sequential phases under `plan/`:

```
plan/
├── README.md          # Workflow instructions
├── overview.md        # Shared design (architecture, data models, protocols)
├── phase-N/
│   ├── plan.md        # Phase goals, tasks, acceptance criteria
│   └── progress.md    # Implementation progress tracking
```

**Rules:**
- Work one phase at a time, in order: 0 → 1 → 2 → 3 → 4
- Before starting a phase: read `plan/phase-N/plan.md` and reference `plan/overview.md` for shared design
- During implementation: update `plan/phase-N/progress.md` as tasks complete (status: not started / in progress / done / blocked)
- A phase is complete only when all tasks are `done` and acceptance criteria pass
- If shared design needs changes, update `plan/overview.md` and note it in the phase progress log
- Original full design preserved in `PLAN.md` (archive)

## Phase Status

- [ ] Phase 0: Environment validation + single pane detect + TTS
- [ ] Phase 1: Voice command → tmux writeback
- [ ] Phase 2: Multi-pane auto-discovery + event queue
- [ ] Phase 3: Snooze/repeat/next + logging + notifications
- [ ] Phase 4: Whisper upgrade (optional)
