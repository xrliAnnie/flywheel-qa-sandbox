# W4a — tmux hook empirical test for `tmux kill-window`

**Date**: 2026-05-05
**Wire**: FLY-60 W4a (per plan §12.5)
**Goal**: Identify which tmux hook fires deterministically on `tmux kill-window` and carries usable identity vars to clean the matching cmux mirror.

## Test environment

- macOS
- tmux 3.5a (verified via `tmux -V`)
- Test source session created fresh: `fly60-w4a-src-$$`
- 3 trials of: create victim window → `tmux kill-window` → record events

## Decision criteria (per plan §12.5)

A candidate hook is acceptable only if all three hold:
1. Fires deterministically on `tmux kill-window` (3× rerun).
2. ≥1 of `#{session_name}` / `#{hook_session_name}` non-empty AND identifies the SOURCE session.
3. ≥1 of `#{window_name}` / `#{hook_window_name}` non-empty AND identifies the destroyed window.

## Candidates tested

`window-unlinked`, `session-window-changed`, `window-renamed`, `window-pane-changed`, `pane-exited`, `pane-died`, `after-kill-window`.

## Raw results

```
=== Trial 1 ===
window-renamed|sn=fly60-w4a-src-71113|wn=tmux|wid=@52|hsn=|hw=@52|hwn=tmux
window-unlinked|sn=fly60-w4a-src-71113|wn=tmux|wid=@52|hsn=fly60-w4a-src-71113|hw=@53|hwn=fly60-w4a-victim
window-renamed|sn=fly60-w4a-src-71113|wn=zsh|wid=@52|hsn=|hw=@52|hwn=zsh

=== Trial 2 ===
window-unlinked|sn=fly60-w4a-src-71113|wn=zsh|wid=@52|hsn=fly60-w4a-src-71113|hw=@54|hwn=fly60-w4a-victim

=== Trial 3 ===
window-unlinked|sn=fly60-w4a-src-71113|wn=zsh|wid=@52|hsn=fly60-w4a-src-71113|hw=@56|hwn=fly60-w4a-victim
session-window-changed|sn=cmux-test-slot-4-flywheel-test-4|wn=test-slot-4-flywheel-test-4|wid=@55|hsn=cmux-test-slot-4-flywheel-test-4|hw=|hwn=  ← unrelated noise (sibling cmux mirror)
```

Failed candidates:
- `after-kill-window` — tmux returned `invalid option: after-kill-window[600]`. Not a valid hook in tmux 3.5a (despite earlier hypothesis). Dropped.
- `pane-exited`, `pane-died`, `window-pane-changed` — never fired on `tmux kill-window` (only fire on pane-process exit, per FLY-110 docs).

## Analysis per criterion

### `window-unlinked`

- **Criterion 1 (deterministic)**: ✅ fires on every trial.
- **Criterion 2 (source session)**: ✅
  - `#{hook_session_name}` = `fly60-w4a-src-71113` (source session, non-empty)
  - `#{session_name}` = `fly60-w4a-src-71113` (also works as fallback)
- **Criterion 3 (destroyed window)**: ✅
  - `#{hook_window_name}` = `fly60-w4a-victim` (the DESTROYED window, non-empty)
  - **Important**: `#{window_name}` returns the **current** window of the session (`tmux` / `zsh`), NOT the destroyed one. W4b MUST use `#{hook_window_name}`.

### `window-renamed`

- Fires before+after the `window-unlinked` event in Trial 1, but `#{hook_window_name}` returns the renamed window's NEW name (`tmux` / `zsh`), not the destroyed window. Not useful.

### `session-window-changed`

- Fires for unrelated sibling sessions (Trial 3 noise from `cmux-test-slot-4-...`). Identity vars present but session is NOT the source we care about — would need session-prefix filtering. Dismiss in favor of cleaner `window-unlinked`.

## Decision

**W4b uses `window-unlinked` global hook with these format vars:**
- Source session identity: `#{hook_session_name}`
- Destroyed window identity: `#{hook_window_name}`

Watcher loop format (event_type + keyed `sn=`/`wn=` columns):
```
unlinked|sn=<hook_session_name>|wn=<hook_window_name>
```

Filter in watcher: only act on events where `sn` matches `runner-` / `lead-test-` / similar source-session prefixes (skip `cmux-` mirror sessions and other unrelated tmux sessions to avoid feedback loops).

## Trap cleanup

The empirical test script registered hooks with index `[600]` and used `trap cleanup_all EXIT` to unset them and `tmux kill-session -t "$TEST_SRC_SESSION"` to remove the temp session. Cleanup verified: `tmux show-hooks -g | grep "[600]"` empty after script exit.

## Pointer to W4b

Plan §12.5 W4b — write `flywheel-cmux-sync.sh` to:
1. Register `window-unlinked[500]` global hook with `run-shell -b 'echo "unlinked|sn=#{hook_session_name}|wn=#{hook_window_name}" >> /tmp/flywheel-cmux-events'`.
2. Watcher loop sniffs format: line starts with `unlinked|sn=` → parse keyed `sn=`/`wn=`; legacy `pane-died` rows still positional `exited|<session>|<window>`.
3. Skip events where `sn` is `cmux-…` or doesn't match an active mirrored source session.

NOT chosen: 5s polling fallback (would have been the alternative if no hook fired).
