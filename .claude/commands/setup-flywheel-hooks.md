# Setup Flywheel Hooks

Install Flywheel PostToolUse hooks for Runner operation.

**Usage**: `/setup-flywheel-hooks`

---

## What This Does

Installs the PostToolUse hook:

1. **inbox-check** — checks CommDB for unread Lead instructions after every tool call

After installation:
- `~/.flywheel/hooks/inbox-check.sh` — instruction delivery hook
- `~/.claude/settings.json` — PostToolUse hook registered with absolute path

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

2. Copy hook script from the Flywheel repo:
   ```bash
   cp scripts/hooks/inbox-check.sh ~/.flywheel/hooks/inbox-check.sh
   chmod +x ~/.flywheel/hooks/inbox-check.sh
   ```

   **If Flywheel repo is not available** (e.g., running on a different machine), write the script content directly using the Write tool. The canonical content is in `scripts/hooks/`.

3. Verify script exits cleanly without env vars:
   ```bash
   FLYWHEEL_EXEC_ID= FLYWHEEL_COMM_DB= ~/.flywheel/hooks/inbox-check.sh; echo "Exit code: $?"
   ```
   Expected: `Exit code: 0` with no output.

---

## Step 3: Register Hooks in Settings

1. **Backup** the current settings:
   ```bash
   cp ~/.claude/settings.json ~/.claude/settings.json.bak.$(date +%s)
   ```

2. **Resolve absolute path** (important — `~` expansion doesn't work in hook commands):
   ```bash
   INBOX_HOOK="$HOME/.flywheel/hooks/inbox-check.sh"
   ```

3. **Register hook** (idempotent — skips if already registered):
   ```bash
   jq --arg inbox "$INBOX_HOOK" '
     .hooks.PostToolUse //= [] |
     # Add inbox-check if not present
     if ([.hooks.PostToolUse[].hooks[]?.command // empty] | any(. == $inbox)) then . else
       .hooks.PostToolUse += [{"matcher": "*", "hooks": [{"type": "command", "command": $inbox, "timeout": 5}]}]
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

1. Confirm hook is registered:
   ```bash
   jq '[.hooks.PostToolUse[].hooks[].command]' ~/.claude/settings.json
   ```
   Expected: shows inbox-check hook path.

2. Confirm script is executable and exits cleanly:
   ```bash
   FLYWHEEL_EXEC_ID= ~/.flywheel/hooks/inbox-check.sh; echo "inbox-check: $?"
   ```

3. Report success:
   ```
   Flywheel hook installed:
      1. inbox-check.sh — Lead instruction delivery
      Registered in: ~/.claude/settings.json (PostToolUse, matcher: *)
      Timeout: 5s

   Hook is a no-op for non-Runner sessions (zero overhead).
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
| Need to uninstall | Remove entry from `~/.claude/settings.json` PostToolUse array; optionally `rm ~/.flywheel/hooks/inbox-check.sh` |
