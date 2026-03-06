# Flywheel Operations Runbook

**Last Updated:** 2026-03-06

## Architecture Overview

```
Linear issues
     |
     v
DAG Resolver (topological sort)
     |
     v
Edge Worker (Blueprint + Decision Layer + Reactions)
     |
     v
Claude Runner (tmux sessions running Claude Code CLI)
     |
     v
Git (commits, branches, PRs)
     |
     v
TeamLead Daemon (event pipeline + Slack notifications)
     |
     v
Slack (Socket Mode: notifications, interactive buttons, stuck alerts)
```

The **TeamLead daemon** is the long-running process that:
1. Ingests execution events via HTTP (`POST /events`)
2. Stores session state in SQLite
3. Sends Slack notifications (session started, completed, failed, stuck)
4. Handles Slack interactive actions (approve, reject, retry buttons)
5. Monitors for stuck sessions

## Starting the TeamLead Daemon

### Build first

```bash
cd /path/to/flywheel
pnpm build
```

### Run the daemon

```bash
cd packages/teamlead
source .env  # or export env vars manually
node dist/index.js
```

On success you will see one of:
- `[TeamLead] Daemon started -- events on :9876, Slack Socket Mode connected` (Slack mode)
- `[TeamLead] Daemon started (event-only mode) -- events on :9876` (event-only mode)

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TEAMLEAD_OWNS_SLACK` | For Slack mode | `false` | Set to `"true"` to enable Slack Socket Mode |
| `SLACK_BOT_TOKEN` | If Slack enabled | -- | `xoxb-...` Bot User OAuth Token |
| `SLACK_APP_TOKEN` | If Slack enabled | -- | `xapp-...` App-Level Token (needs `connections:write` scope) |
| `FLYWHEEL_SLACK_CHANNEL` | If Slack enabled | -- | Slack channel ID (e.g., `CD5QZVAP6`) |
| `TEAMLEAD_PORT` | No | `9876` | HTTP port for event ingestion |
| `TEAMLEAD_DB_PATH` | No | `~/.flywheel/teamlead.db` | SQLite database file path |
| `TEAMLEAD_INGEST_TOKEN` | No | -- | Bearer token for event ingestion auth. If set, both daemon and orchestrator must share the same token. If unset, auth is disabled. |
| `TEAMLEAD_PROJECTS` | For actions | -- | JSON array of `[{"projectName":"...","projectRoot":"/path/to/repo"}]` |
| `TEAMLEAD_STUCK_THRESHOLD` | No | `15` | Minutes before a session is considered stuck |
| `TEAMLEAD_STUCK_INTERVAL` | No | `300000` | Stuck check polling interval in milliseconds (default: 5 minutes) |

When `TEAMLEAD_OWNS_SLACK=true`, three additional variables become required: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, and `FLYWHEEL_SLACK_CHANNEL`. The daemon will refuse to start if any are missing.

### Modes of Operation

**Slack mode** (`TEAMLEAD_OWNS_SLACK=true`):
- Full functionality: event ingestion + Slack notifications + interactive actions + stuck watcher
- Requires Slack app configuration (see below)

**Event-only mode** (default):
- Event ingestion and SQLite storage only
- No Slack notifications or interactive features
- Useful for development/testing

## Sending Test Events

```bash
# Session started
curl -X POST http://127.0.0.1:9876/events \
  -H "Content-Type: application/json" \
  -d '{
    "event_id": "test-001",
    "execution_id": "exec-001",
    "issue_id": "GEO-99",
    "project_name": "GeoForge3D",
    "event_type": "session_started",
    "payload": {
      "issueIdentifier": "GEO-99",
      "issueTitle": "Fix rendering bug"
    }
  }'

# Session completed (triggers Decision Layer routing)
curl -X POST http://127.0.0.1:9876/events \
  -H "Content-Type: application/json" \
  -d '{
    "event_id": "test-002",
    "execution_id": "exec-001",
    "issue_id": "GEO-99",
    "project_name": "GeoForge3D",
    "event_type": "session_completed",
    "payload": {
      "summary": "Fixed the rendering bug",
      "decision": {"route": "needs_review", "reasoning": "Non-trivial change"},
      "evidence": {"commitCount": 2, "filesChangedCount": 3, "linesAdded": 50, "linesRemoved": 10}
    }
  }'

# Session failed
curl -X POST http://127.0.0.1:9876/events \
  -H "Content-Type: application/json" \
  -d '{
    "event_id": "test-003",
    "execution_id": "exec-001",
    "issue_id": "GEO-99",
    "project_name": "GeoForge3D",
    "event_type": "session_failed",
    "payload": {"error": "Build failed: type errors in src/renderer.ts"}
  }'
```

If `TEAMLEAD_INGEST_TOKEN` is configured, add the auth header:

```bash
curl -X POST http://127.0.0.1:9876/events \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <your-token>" \
  -d '{ ... }'
```

### Event Types

| Event Type | Effect |
|------------|--------|
| `session_started` | Creates/updates session with status `running` |
| `session_completed` | Updates session status based on decision route (`approved`, `awaiting_review`, `blocked`, or `completed`) |
| `session_failed` | Updates session status to `failed`, stores error message |

Events are **idempotent** -- duplicate `event_id` values return `200 OK` with `{"ok": true, "duplicate": true}` and skip all side effects.

### Required Fields

Every event must include these string fields (validated at ingestion boundary):
- `event_id` -- unique identifier for deduplication
- `execution_id` -- groups events into a session
- `issue_id` -- Linear issue ID
- `project_name` -- project identifier
- `event_type` -- one of the types above

## Slack App Setup

The Flywheel Slack app (`A0AJULRQXUN`) runs on the "little piggy" workspace.

### Configuration Checklist

1. **Socket Mode**: Enable Socket Mode in the app settings. Generate an App-Level Token with the `connections:write` scope. This becomes `SLACK_APP_TOKEN`.

2. **Bot Token Scopes** (OAuth & Permissions):
   - `chat:write` -- send messages
   - `chat:write.public` -- post to channels the bot hasn't joined
   - `reactions:write` -- add emoji reactions to messages

3. **Interactivity**: Enable Interactivity in the app settings. No request URL is needed (Socket Mode handles it).

4. **Install/Reinstall**: After changing scopes or enabling Socket Mode, reinstall the app to the workspace. The Bot User OAuth Token (`xoxb-...`) becomes `SLACK_BOT_TOKEN`.

### Finding the Channel ID

The `FLYWHEEL_SLACK_CHANNEL` value is a Slack channel ID (not the channel name). To find it:
- Right-click the channel name in Slack -> "View channel details" -> the ID is at the bottom of the "About" tab
- Or use the Slack API: `https://slack.com/api/conversations.list`

## Common Issues

### Port already in use

```bash
lsof -i :9876 -t | xargs kill
```

Then restart the daemon.

### Socket Mode not receiving actions

If interactive buttons (approve, reject, retry) do not trigger callbacks:
1. Verify Socket Mode is **enabled** in the Slack app settings
2. Verify Interactivity is **enabled**
3. **Reinstall the app** to the workspace after making changes -- this is the most common fix
4. Check that `SLACK_APP_TOKEN` starts with `xapp-` and has `connections:write` scope

### Chrome automation cannot click Slack buttons

This is a known limitation. Slack's interactive components (buttons in messages) cannot be reliably automated via browser automation tools. Use manual clicks or the Slack API directly.

### Database locked errors

The SQLite database (`~/.flywheel/teamlead.db` by default) does not support concurrent writers. Only one TeamLead daemon instance should run at a time. If a previous instance did not shut down cleanly:

```bash
# Check for running instances
ps aux | grep teamlead

# Remove stale lock (if applicable)
rm -f ~/.flywheel/teamlead.db-journal
```

### Events returning 401 Unauthorized

Both the daemon and the orchestrator (event sender) must share the same `TEAMLEAD_INGEST_TOKEN` value. If the daemon has a token configured but the sender does not (or vice versa), requests will be rejected.

## Graceful Shutdown

Send `SIGINT` (Ctrl+C) or `SIGTERM` to the daemon process:

```bash
kill -SIGTERM $(pgrep -f "node dist/index.js")
```

The daemon will:
1. Stop the stuck watcher
2. Close the HTTP event ingestion server
3. Disconnect Slack Socket Mode (if active)
4. Close the SQLite database
5. Log `[TeamLead] Bye.` and exit with code 0

## Health Checks

The daemon does not expose a dedicated health endpoint. To verify it is running:

```bash
# Check the process
pgrep -f "teamlead"

# Check the port is listening
lsof -i :9876

# Send a malformed request (should return 400, proving the server is alive)
curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:9876/events \
  -H "Content-Type: application/json" \
  -d '{}'
# Expected: 400
```

## Log Output

All log lines are prefixed with `[TeamLead]`. Key lines to watch for:

| Log | Meaning |
|-----|---------|
| `[TeamLead] Daemon started -- events on :9876, Slack Socket Mode connected` | Normal startup with Slack |
| `[TeamLead] Daemon started (event-only mode) -- events on :9876` | Normal startup without Slack |
| `[TeamLead] Notification error: ...` | Failed to send a Slack notification |
| `[TeamLead] Shutting down...` | Graceful shutdown initiated |
| `[TeamLead] Bye.` | Clean shutdown complete |
| `[TeamLead] Fatal: ...` | Unrecoverable error, process exiting |
