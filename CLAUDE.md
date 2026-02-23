## Project Overview

Voice-in-the-Loop: a Hammerspoon plugin that enables voice control of Claude Code running in tmux panes.

- **Language**: Lua (Hammerspoon)
- **Platform**: macOS only
- **Dependencies**: Hammerspoon, tmux
- **Plan**: See `PLAN.md` for full design (Codex-approved after 4 review rounds)

## Architecture

```
~/.hammerspoon/voice-loop/   # Lua source modules
~/.claude/voice-loop/        # Config + logs (runtime)
```

Key modules: monitor, parser, queue, dispatcher, tts, listener, router, writer, logger.

## Development Conventions

- Code, comments, commit messages in **English**
- Design docs and plans in **Chinese** (technical terms in English)
- TTS: Chinese framework + English option text
- ASR: English command words by default; Chinese optional after Phase 0 gate

## Key Technical Decisions (from Plan)

- `hs.speech.listener:foregroundOnly(false)` — must set for background recognition
- tmux reads: `hs.execute` sync; tmux writes: `hs.task` async
- Pane validation: `tmux display-message -p -t <target> '#{pane_id}'` (not `has-session`)
- Prompt fingerprint re-verification before every command execution
- High-risk operations (yes/no, approve/reject, destructive keywords): confirmation enabled by default
- `capture-pane` without `-e` flag (no ANSI codes in output)
- `NSSpeechRecognizer` provides no confidence scores

## Phase Status

- [x] Phase 0: Environment validation + single pane detect + TTS — NOT STARTED
- [ ] Phase 1: Voice command → tmux writeback
- [ ] Phase 2: Multi-pane auto-discovery + event queue
- [ ] Phase 3: Snooze/repeat/next + logging + notifications
- [ ] Phase 4: Whisper upgrade (optional)
