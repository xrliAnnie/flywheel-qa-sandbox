# Bridge Daemon Management — launchd + env wrapper (FLY-151)

The Bridge process (`scripts/run-bridge.ts`) is supervised by `launchd` via a
thin wrapper that loads `~/.flywheel/.env` before starting Node. This mirrors
the Lead daemon pattern (FLY-74, `scripts/flywheel-lead-wrapper.sh`).

## Architecture

```
launchctl  →  scripts/launchd/com.flywheel.bridge.plist
                       │
                       ▼
            scripts/flywheel-bridge-wrapper.sh
                       │   (sources ~/.flywheel/.env, expands PATH)
                       ▼
                npx tsx scripts/run-bridge.ts
```

The wrapper is the single source of truth for the Bridge's environment. The
plist deliberately omits an `EnvironmentVariables` key so there is no second
copy of env vars to keep in sync.

## Install (one-time)

```bash
cp scripts/launchd/com.flywheel.bridge.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.flywheel.bridge.plist
```

`RunAtLoad=true` starts the Bridge immediately and `KeepAlive=true` respawns
it on crash (throttled to one restart per 30 s).

## Common operations

| Task | Command |
|------|---------|
| Restart Bridge | `launchctl kickstart -k gui/$(id -u)/com.flywheel.bridge` |
| Pause (stop, no respawn) | `launchctl stop com.flywheel.bridge` then `launchctl unload ...` |
| Disable on next login | `launchctl unload ~/Library/LaunchAgents/com.flywheel.bridge.plist` |
| Re-enable | `launchctl load ~/Library/LaunchAgents/com.flywheel.bridge.plist` |
| Inspect job | `launchctl print gui/$(id -u)/com.flywheel.bridge` |
| Tail log | `tail -f /tmp/flywheel-bridge.log` |

`scripts/restart-services.sh` automatically prefers `launchctl kickstart` when
the plist is loaded; otherwise it falls back to the legacy `nohup` branch and
logs a warning.

## Chat-thread trigger configuration (FLY-147)

These switches are independent. Edit `~/.flywheel/.env`, then restart Bridge;
the running process does not reload them dynamically.

| Variable | Scope | Required companion configuration |
|----------|-------|----------------------------------|
| `TEAMLEAD_CHAT_THREADS_ENABLED=true` | Automatic/background create-or-reuse on `session_started` for every `sessionRole` | Lead `chatChannel`; Lead/global Discord bot token |
| `TEAMLEAD_API_TOKEN=<secret>` | Authenticates Bridge API calls; required for manual create/register/archive writes | Callers send `Authorization: Bearer ...`; manual create also needs `LINEAR_API_KEY` and Discord config |
| `TEAMLEAD_REPLY_BY_ISSUE_ENABLED=true` | Enables `POST /api/chat-threads/send`; on a mapping miss, `/send` may create the thread | `TEAMLEAD_API_TOKEN` is mandatory (Bridge fails startup otherwise), plus Linear + Discord config |

`TEAMLEAD_CHAT_THREADS_ENABLED=false` disables only automatic/background
creation. It does not disable authenticated manual create, send, lookup, or
archive routes. The two GET lookup routes read local mappings and are protected
by Bearer auth whenever `TEAMLEAD_API_TOKEN` is configured.

Use placeholder variables for smoke tests; never paste real tokens into docs or
shell history. The issue must already exist in Linear and belong to a configured
project/Lead channel.

```bash
export BRIDGE_URL="http://localhost:9876"
export ISSUE_IDENTIFIER="FLY-EXAMPLE"
export PROJECT_NAME="Flywheel"
export LEAD_ID="product-lead"
export CHAT_CHANNEL="discord-channel-id"
```

### Smoke 1 — manual create while automatic creation is off

Set `TEAMLEAD_CHAT_THREADS_ENABLED=false`, keep `TEAMLEAD_API_TOKEN` and the
Linear/Discord configuration present, restart Bridge, then:

```bash
PAYLOAD=$(jq -n \
  --arg issueIdentifier "$ISSUE_IDENTIFIER" \
  --arg channelId "$CHAT_CHANNEL" \
  --arg leadId "$LEAD_ID" \
  --arg projectName "$PROJECT_NAME" \
  '{issueIdentifier: $issueIdentifier, channelId: $channelId, leadId: $leadId, projectName: $projectName}')

curl -sS -X POST "$BRIDGE_URL/api/chat-threads/create" \
  -H "Authorization: Bearer $TEAMLEAD_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD"
# Expect 200: {"threadId":"...","created":true|false}
```

Repeat the call and expect `created:false` for the same issue/channel.

### Smoke 2 — automatic creation for any Runner role

Set `TEAMLEAD_CHAT_THREADS_ENABLED=true`, restart Bridge, and use a disposable
issue with the normal run-start API. `designer` is intentional; `main`, `qa`,
and custom roles follow the same `session_started` path.

```bash
START=$(jq -n \
  --arg issueId "$ISSUE_IDENTIFIER" \
  --arg projectName "$PROJECT_NAME" \
  '{issueId: $issueId, projectName: $projectName, sessionRole: "designer"}' |
  curl -sS -X POST "$BRIDGE_URL/api/runs/start" \
    -H "Authorization: Bearer $TEAMLEAD_API_TOKEN" \
    -H "Content-Type: application/json" \
    -d @-)

EXECUTION_ID=$(printf '%s' "$START" | jq -r '.executionId')
SESSION=$(curl -sS "$BRIDGE_URL/api/sessions/$EXECUTION_ID" \
  -H "Authorization: Bearer $TEAMLEAD_API_TOKEN")
ISSUE_KEY=$(printf '%s' "$SESSION" | jq -r '.issue_id')

curl -sS "$BRIDGE_URL/api/chat-threads?issueId=$ISSUE_KEY&channelId=$CHAT_CHANNEL" \
  -H "Authorization: Bearer $TEAMLEAD_API_TOKEN"
# Expect 200 with a non-null threadId after session_started is processed.
```

### Smoke 3 — reply-by-issue while automatic creation is off or on

Set `TEAMLEAD_REPLY_BY_ISSUE_ENABLED=true`, restart Bridge, then:

```bash
PAYLOAD=$(jq -n \
  --arg issueIdentifier "$ISSUE_IDENTIFIER" \
  --arg channelId "$CHAT_CHANNEL" \
  --arg leadId "$LEAD_ID" \
  --arg projectName "$PROJECT_NAME" \
  --arg text "FLY-147 chat-thread smoke" \
  '{issueIdentifier: $issueIdentifier, channelId: $channelId, leadId: $leadId, projectName: $projectName, text: $text}')

curl -sS -X POST "$BRIDGE_URL/api/chat-threads/send" \
  -H "Authorization: Bearer $TEAMLEAD_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD"
# Expect 200 with threadId/messageIds. A row miss may return created:true.
```

For manual writes, 503 means a required API token, Linear key, or Discord bot
token is unavailable. For `/send`, 404 means reply-by-issue is disabled (or the
project is unknown), not that automatic creation is disabled.

## Troubleshooting — confirm env actually loaded

After a restart, verify the new process inherited the expected environment:

```bash
# 1. Get the live Bridge PID
pgrep -f run-bridge.ts

# 2. Inspect its env (BSD ps shows the per-process environment)
ps eww -p <pid> | tr ' ' '\n' | grep TEAMLEAD_CHAT_THREADS_ENABLED

# 3. Confirm the wrapper logged the expected value at startup
grep 'TEAMLEAD_CHAT_THREADS_ENABLED' /tmp/flywheel-bridge.log | tail -3

# 4. End-to-end smoke test against the Bridge HTTP API.
# The Bridge port defaults to 9876 (see packages/teamlead/src/config.ts);
# override with TEAMLEAD_PORT in ~/.flywheel/.env if you've changed it.
curl -s "${BRIDGE_URL:-http://localhost:9876}/api/runs/active" \
  -H "Authorization: Bearer $TEAMLEAD_API_TOKEN"
# Expect: HTTP 200 with a JSON body.
```

If the env var is missing from `ps eww`, the wrapper either failed to source
`~/.flywheel/.env` (check `/tmp/flywheel-bridge.log` for `[bridge-wrapper] ERROR`)
or the var is not actually defined in that file.

## PID lock — avoiding double-start

The wrapper writes its own PID to `~/.flywheel/pids/bridge.pid` immediately
before `exec npx tsx ...`. The bash `EXIT` trap that removes the file fires
only on wrapper exits *before* the exec succeeds (e.g. exec failure or any
script error after the PID file was claimed). On the success path the wrapper
process is replaced by Node, the trap never runs, and the file persists
holding the live Bridge PID (PIDs are preserved across `exec`). The next
wrapper invocation sees the live PID via `kill -0`, exits 0, and lets the
existing Bridge keep serving.

If `restart-services.sh` (legacy nohup branch) and launchd race, the later
wrapper run sees the existing live PID and exits 0; launchd retries after
the 30 s `ThrottleInterval` and takes over once the prior instance dies. The
stale PID file from a hard-crashed Bridge is overwritten on the next wrapper
run because `kill -0` on the dead PID returns non-zero.

## Related

- `scripts/flywheel-lead-wrapper.sh` (FLY-74) — same wrapper pattern for Lead
  daemons. Read that file alongside `flywheel-bridge-wrapper.sh` for the
  parallel structure.
- `scripts/restart-services.sh` `start_bridge()` — the launchd-first / nohup
  fallback logic lives there. The `nohup` branch will be removed in v1.28+
  once everyone has installed the plist.
