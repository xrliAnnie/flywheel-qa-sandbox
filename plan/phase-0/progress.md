# Phase 0 — Implementation Progress

## Status: in progress

## Tasks

| # | Task | Status | Notes |
|---|------|--------|-------|
| 1 | Hammerspoon installed and running Lua scripts | done | v1.1.0 via `brew install --cask hammerspoon` |
| 2 | Microphone permission granted to Hammerspoon | not started | Needed for Phase 1 (ASR), not Phase 0 |
| 3 | `hs.speech.listener` background recognition verified | not started | Phase 1 prerequisite |
| 4 | Audio device test (speakers + Bluetooth headphones) | done | MacBook speakers + Shokz OpenRun verified. `coreaudiod` restart needed after 14-day uptime. |
| 5 | tmux reachable from Hammerspoon | done | `hs.execute('tmux list-sessions', true)` OK |
| 6 | `capture-pane` returns content for test pane | done | `voiceloop-test:0.0` pane, 85+ chars captured |
| 7 | Register Chinese command words and test recognition | not started | |
| 8 | Chinese recognition gate: >= 8/10 correct | not started | |
| 9 | Record gate result (pass/fail + data) | not started | |
| 10 | Trigger 10+ Claude Code choice prompts | not started | |
| 11 | Save capture-pane samples to `~/.claude/voice-loop/samples/` | not started | |
| 12 | Calibrate parser regex from real samples | not started | Patterns work on simulated prompts; needs real Claude Code samples |
| 13 | Build sample regression test set | not started | |
| 14 | Create `~/.hammerspoon/voice-loop/` directory structure | done | Symlink: `~/.hammerspoon/voice-loop` → repo |
| 15 | Implement `monitor.lua` | done | capture-pane + pane_exists, shell-escaped, hs.execute sync |
| 16 | Implement `parser.lua` | done | Numbered (paren/dot/bracket) + yesno + approve_reject; dedupe via djb2 hash |
| 17 | Implement `tts.lua` | done | Two-stage: `say -o` synth via hs.task → `hs.sound` playback (hs.speech + direct `say` both broken on Sequoia) |
| 18 | Config file with pane target + alias | done | `~/.claude/voice-loop/config.lua` with defaults in `config.lua` loader |
| 19 | E2E test: echo prompt in pane → hear TTS | done | Full E2E verified: echo 3 choices → parser detects → TTS announces via hs.sound |

## Log

<!-- Log entries in reverse chronological order -->

### 2026-02-22 (cont.)
- **E2E TTS verified**: Full pipeline working with audio. Root cause was twofold: (1) `coreaudiod` stale after 14-day uptime — `sudo killall coreaudiod` fixed system audio; (2) macOS Sequoia breaks `say` real-time audio from Hammerspoon subprocesses — fixed by two-stage approach: `say -o file.aiff` (synthesis) → `hs.sound` (playback). Codex proposed the fix, validated end-to-end.
- Testing gotcha: Claude Code Stop hook (`afplay done.aiff` "搞定") interrupts `hs.sound` playback during interactive testing. Not an issue in production (voiceLoop runs on internal timer, not triggered by Claude Code tool calls).
- `hs.speech.listener` confirmed broken on macOS Sonoma+ (Hammerspoon #3529). Phase 1 ASR will need alternative approach.

### 2026-02-22
- E2E pipeline working: `capture-pane → parser → detect 3 choices → log event`. Dedupe prevents re-announcement.
- `hs.speech.new():speak()` produces no audio on this system (macOS Sequoia + Hammerspoon 1.1.0). Switched TTS to `say` command via `hs.task`. `say` verified working earlier but audio device (Shokz OpenRun BT) became unavailable during testing.
- Parser bug: `capture-pane` pads output with blank trailing lines. Fixed by stripping trailing empty lines before selecting "last 15 lines".
- Parser bug: removed hard `is_waiting_for_input` gate — real prompts detected in pane with shell prompt after choices. Dedupe key handles repeat prevention.
- Parser: added choice deduplication by key (handles `quote>` artifacts from multiline echo).
- Created all Phase 0 modules: init.lua, config.lua, monitor.lua, parser.lua, tts.lua, logger.lua
- Hammerspoon installed, IPC enabled, accessibility permission granted, tmux reachable
