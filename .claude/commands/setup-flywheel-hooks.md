# Setup Flywheel Hooks

Install Flywheel PostToolUse hooks for automatic Lead → Runner instruction delivery.

**Usage**: `/setup-flywheel-hooks`

---

## What This Does

Installs the **inbox-check hook** — a PostToolUse hook that automatically checks CommDB for unread Lead instructions after every Runner tool call and injects them into the conversation via `additionalContext`.

After installation:
- `~/.flywheel/hooks/inbox-check.sh` — the hook script (self-contained, no Flywheel repo dependency)
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

## Step 2: Deploy Hook Script

1. Create the hooks directory:
   ```bash
   mkdir -p ~/.flywheel/hooks
   ```

2. Copy the hook script from the Flywheel repo:
   ```bash
   cp scripts/hooks/inbox-check.sh ~/.flywheel/hooks/inbox-check.sh
   chmod +x ~/.flywheel/hooks/inbox-check.sh
   ```

   **If Flywheel repo is not available** (e.g., running on a different machine), write the script content directly using the Write tool. The canonical content is in `scripts/hooks/inbox-check.sh`.

3. Verify the script exits cleanly without env vars:
   ```bash
   FLYWHEEL_EXEC_ID= FLYWHEEL_COMM_DB= ~/.flywheel/hooks/inbox-check.sh; echo "Exit code: $?"
   ```
   Expected: `Exit code: 0` with no output.

---

## Step 3: Register Hook in Settings

1. **Backup** the current settings:
   ```bash
   cp ~/.claude/settings.json ~/.claude/settings.json.bak.$(date +%s)
   ```

2. **Check if already registered** — look for `inbox-check.sh` in PostToolUse hooks:
   ```bash
   jq '.hooks.PostToolUse // [] | .. | .command? // empty' ~/.claude/settings.json | grep -q 'inbox-check'
   ```
   If found, log "Hook already registered — skipping" and go to Step 4.

3. **Resolve absolute path** (important — `~` expansion doesn't work in hook commands):
   ```bash
   HOOK_PATH="$HOME/.flywheel/hooks/inbox-check.sh"
   ```

4. **Structurally merge** the new hook entry into PostToolUse using `jq`:
   ```bash
   jq --arg cmd "$HOOK_PATH" '
     .hooks.PostToolUse += [{
       "matcher": "*",
       "hooks": [{
         "type": "command",
         "command": $cmd,
         "timeout": 5
       }]
     }]
   ' ~/.claude/settings.json > /tmp/flywheel-settings-merged.json
   ```

5. **Validate** the output is valid JSON:
   ```bash
   jq . /tmp/flywheel-settings-merged.json > /dev/null
   ```

6. **Write back** (only if validation passed):
   ```bash
   mv /tmp/flywheel-settings-merged.json ~/.claude/settings.json
   ```

---

## Step 4: Verify

1. Confirm hook is registered:
   ```bash
   jq '.hooks.PostToolUse[-1]' ~/.claude/settings.json
   ```
   Expected: shows the inbox-check hook entry with absolute path.

2. Confirm script is executable and exits cleanly:
   ```bash
   ~/.flywheel/hooks/inbox-check.sh
   echo "Exit code: $?"
   ```

3. Report success:
   ```
   ✅ Flywheel inbox-check hook installed
      Script: ~/.flywheel/hooks/inbox-check.sh
      Registered in: ~/.claude/settings.json (PostToolUse, matcher: *)
      Timeout: 5s

   The hook will automatically check for Lead instructions after every
   Runner tool call. Non-Runner sessions are unaffected (zero overhead).
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
