# Setup Flywheel Hooks

Install Flywheel PostToolUse hooks for Runner operation.

**Usage**: `/setup-flywheel-hooks`

---

## What This Does

Installs two PostToolUse hooks:

1. **inbox-check** — checks CommDB for unread Lead instructions after every tool call
2. **circuit-breaker** — detects stuck Runners and stops them (no-progress, repeated errors, total cap)

After installation:
- `~/.flywheel/hooks/inbox-check.sh` — instruction delivery hook
- `~/.flywheel/hooks/circuit-breaker.sh` — circuit breaker hook (FLY-9)
- `~/.claude/settings.json` — PostToolUse hooks registered with absolute paths

---

## Step 1: Check Prerequisites

```bash
# sqlite3 should always be available on macOS
which sqlite3 || echo "ERROR: sqlite3 not found"

# jq is required for JSON construction in the hook
which jq || echo "WARNING: jq not found — installing..."
```

If `jq` is missing, install it:
```bash
brew install jq
```

Verify both are available before proceeding.

---

## Step 2: Deploy Hook Scripts

1. Create the hooks directory:
   ```bash
   mkdir -p ~/.flywheel/hooks
   ```

2. Copy hook scripts from the Flywheel repo:
   ```bash
   cp scripts/hooks/inbox-check.sh ~/.flywheel/hooks/inbox-check.sh
   cp scripts/hooks/circuit-breaker.sh ~/.flywheel/hooks/circuit-breaker.sh
   chmod +x ~/.flywheel/hooks/inbox-check.sh ~/.flywheel/hooks/circuit-breaker.sh
   ```

   **If Flywheel repo is not available** (e.g., running on a different machine), write the script content directly using the Write tool. The canonical content is in `scripts/hooks/`.

3. Verify both scripts exit cleanly without env vars:
   ```bash
   FLYWHEEL_EXEC_ID= FLYWHEEL_COMM_DB= ~/.flywheel/hooks/inbox-check.sh; echo "Exit code: $?"
   FLYWHEEL_EXEC_ID= ~/.flywheel/hooks/circuit-breaker.sh < /dev/null; echo "Exit code: $?"
   ```
   Expected: `Exit code: 0` with no output for both.

---

## Step 3: Register Hooks in Settings

1. **Backup** the current settings:
   ```bash
   cp ~/.claude/settings.json ~/.claude/settings.json.bak.$(date +%s)
   ```

2. **Resolve absolute paths** (important — `~` expansion doesn't work in hook commands):
   ```bash
   INBOX_HOOK="$HOME/.flywheel/hooks/inbox-check.sh"
   CB_HOOK="$HOME/.flywheel/hooks/circuit-breaker.sh"
   ```

3. **Register both hooks** (idempotent — skips already-registered hooks):
   ```bash
   jq --arg inbox "$INBOX_HOOK" --arg cb "$CB_HOOK" '
     .hooks.PostToolUse //= [] |
     # Add inbox-check if not present
     if ([.hooks.PostToolUse[].hooks[]?.command // empty] | any(. == $inbox)) then . else
       .hooks.PostToolUse += [{"matcher": "*", "hooks": [{"type": "command", "command": $inbox, "timeout": 5}]}]
     end |
     # Add circuit-breaker if not present
     if ([.hooks.PostToolUse[].hooks[]?.command // empty] | any(. == $cb)) then . else
       .hooks.PostToolUse += [{"matcher": "*", "hooks": [{"type": "command", "command": $cb, "timeout": 5}]}]
     end
   ' ~/.claude/settings.json > /tmp/flywheel-settings-merged.json
   ```

4. **Validate** the output is valid JSON:
   ```bash
   jq . /tmp/flywheel-settings-merged.json > /dev/null
   ```

5. **Write back** (only if validation passed):
   ```bash
   mv /tmp/flywheel-settings-merged.json ~/.claude/settings.json
   ```

---

## Step 4: Verify

1. Confirm hooks are registered:
   ```bash
   jq '[.hooks.PostToolUse[].hooks[].command]' ~/.claude/settings.json
   ```
   Expected: shows both hook paths.

2. Confirm scripts are executable and exit cleanly:
   ```bash
   FLYWHEEL_EXEC_ID= ~/.flywheel/hooks/inbox-check.sh; echo "inbox-check: $?"
   FLYWHEEL_EXEC_ID= ~/.flywheel/hooks/circuit-breaker.sh < /dev/null; echo "circuit-breaker: $?"
   ```

3. Report success:
   ```
   Flywheel hooks installed:
      1. inbox-check.sh — Lead instruction delivery
      2. circuit-breaker.sh — Runner stuck detection + hard stop (FLY-9)
      Registered in: ~/.claude/settings.json (PostToolUse, matcher: *)
      Timeout: 5s each

   Both hooks are no-ops for non-Runner sessions (zero overhead).
   Circuit breaker signals: no-progress (15/20), repeated error (3/5), 50-call cap.
   ```

---

## Updating

To update the hook script after a Flywheel version upgrade:

```bash
/setup-flywheel-hooks
```

The skill is idempotent — it will overwrite the script but skip re-registering if already present.

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `jq: command not found` | `brew install jq` |
| Hook not firing | Check `~/.claude/settings.json` PostToolUse array contains the entry |
| Hook fires but no instructions appear | Verify `FLYWHEEL_EXEC_ID` and `FLYWHEEL_COMM_DB` are set in Runner tmux env |
| `SQLITE_BUSY` errors | Hook handles this gracefully (exit 0, retry next tool use) |
| Circuit breaker too aggressive | Adjust thresholds in `circuit-breaker.sh` (NO_PROGRESS_SOFT/HARD, ERROR_REPEAT_SOFT/HARD, TOTAL_CAP) |
| Circuit breaker not firing | Verify `FLYWHEEL_EXEC_ID` is set and `jq` is available. State file: `/tmp/flywheel-cb/${EXEC_ID}.json` |
| Need to uninstall | Remove entries from `~/.claude/settings.json` PostToolUse array; optionally `rm ~/.flywheel/hooks/*.sh` |
