# Product Lead Agent — TOOLS.md

> Deploy to OpenClaw workspace: `product-lead/TOOLS.md`
> Version: v1.11.0 (GEO-262)

---

## Bridge API

Base URL: configured in OpenClaw hooks. All endpoints require Bearer token auth.

### Actions

#### Resolve Action (always call first)
```
GET /api/resolve-action?issue_id={ISSUE-ID}&action={action}

Response: { can_execute: boolean, execution_id?: string, reason?: string }
```

Supported actions: `approve`, `retry`, `reject`, `defer`, `shelve`, `terminate`

#### Execute Action
```
POST /api/actions/approve
Body: { execution_id: "...", identifier: "GEO-XX or FLY-XX" }

POST /api/actions/retry
Body: { execution_id: "...", reason?: "...", context?: "CEO custom instructions" }
Note: `context` is optional — when provided, it's injected into the new session's system prompt

POST /api/actions/reject
Body: { execution_id: "...", reason?: "..." }

POST /api/actions/defer
Body: { execution_id: "...", reason?: "..." }

POST /api/actions/shelve
Body: { execution_id: "...", reason?: "..." }

POST /api/actions/terminate
Body: { execution_id: "..." }
Note: Works on any started session (running, awaiting_review, approved_to_ship,
blocked, failed, rejected, deferred). Kills tmux and transitions to terminated.
```

### Session Queries

```
GET /api/sessions/:id
  Returns session by execution_id (or identifier fallback)

GET /api/sessions/:id/history
  Returns all executions for the same issue

GET /api/sessions?mode=active
  Returns all active (running + awaiting_review) sessions

GET /api/sessions?mode=recent&limit=N
  Returns most recent N sessions (default 20, max 200)

GET /api/sessions?mode=stuck&stuck_threshold=15
  Returns sessions with no activity for N minutes

GET /api/sessions?mode=by_identifier&identifier={ISSUE-ID}
  Returns session by issue identifier
```

> FLY-163: forum `thread_id` field removed from session responses. Per-issue
> chat threads now live in `chat_threads` and surface via `chat_thread_id`
> on hook payloads — see the FLY-91 section below for chat thread routing.

### Session Capture (GEO-262)

Capture the current tmux terminal output of a runner session.

```
GET /api/sessions/:id/capture?lines=100

Parameters:
  :id    — execution_id or issue identifier (e.g., GEO-262 or FLY-1)
  lines  — number of lines to capture (1-500, default 100)

Response 200:
{
  "execution_id": "abc-123",
  "tmux_target": "flywheel:@42",
  "lines": 100,
  "output": "... terminal text ...",
  "captured_at": "2026-03-25T12:00:00Z"
}

Errors:
  404 — Session not found / CommDB not found / no tmux window
  502 — tmux window gone (pane died)
```

Use this to:
- Check what a Runner is doing right now ("GEO-XX or FLY-XX is doing what?")
- Diagnose stuck sessions ("stuck on npm install or waiting for CI?")
- Provide specific info when reporting to CEO

### Linear API (via Bridge proxy)

```
POST /api/linear/create-issue
Body: { title: "...", description?: "...", priority?: 0-4, labels?: ["label-id"],
        team: "FLY"|"GEO" (team key, required for multi-team workspace),
        project?: "Flywheel"|"GeoForge3D" (project name, optional) }
Response: { ok: true, issue: { id, identifier, url } }

PATCH /api/linear/update-issue
Body: { issueId: "...", title?: "...", description?: "...", priority?: 0-4, status?: "In Progress" }
Response: { ok: true }
```

Priority values: 0=No priority, 1=Urgent, 2=High, 3=Medium, 4=Low

### Configuration

```
GET /api/config/discord-guild-id
Response: { guild_id: "..." }
```

### Chat Thread Management (FLY-91)

Each issue can have a dedicated Discord thread in chatChannel for focused discussion.

#### Trigger and configuration matrix

| Path | Trigger | Required configuration | When automatic creation is off |
|------|---------|------------------------|--------------------------------|
| Runner automatic | `session_started` for any `sessionRole` (`main`, `qa`, `designer`, or custom) | `TEAMLEAD_CHAT_THREADS_ENABLED=true`, configured Lead `chatChannel`, Lead/global Discord bot token | Skipped; Runner startup continues |
| Lead manual create | `POST /api/chat-threads/create` with an issue UUID or identifier | `TEAMLEAD_API_TOKEN`, `LINEAR_API_KEY`, configured Lead/channel, Discord bot token | Still available |
| Lead issue reply | `POST /api/chat-threads/send`; creates on row miss, otherwise reuses | `TEAMLEAD_REPLY_BY_ISSUE_ENABLED=true`, `TEAMLEAD_API_TOKEN`, Linear + Discord configuration | Still available; the reply flag is its kill switch |
| Lookup | `GET /api/chat-threads` or `/api/chat-threads/by-thread/:threadId` | Bearer auth whenever `TEAMLEAD_API_TOKEN` is configured | Still available |
| Manual archive | `POST /api/chat-threads/archive` | `TEAMLEAD_API_TOKEN`, configured Lead/channel, Discord bot token | Still available |

`TEAMLEAD_CHAT_THREADS_ENABLED` controls only automatic/background creation.
Environment/config changes require a Bridge restart. Manual create is idempotent:
an existing mapping returns `created: false`.

#### Create/Get Thread
```
POST /api/chat-threads/create
Body: {
  "issueId": "abc-123-uuid",           // Linear internal UUID (from event payload)
  // — OR —
  "issueIdentifier": "FLY-91",         // Linear identifier (from direct chat)
  "channelId": "$CHAT_CHANNEL",
  "leadId": "$LEAD_ID",
  "projectName": "$PROJECT_NAME"
}
Response: { "threadId": "discord-thread-id", "created": true/false }
```

- Provide at least one of `issueId` or `issueIdentifier`
- Returns existing thread if one already exists (`created: false`)
- Requires a configured `TEAMLEAD_API_TOKEN`; Bridge refuses an unauthenticated write with 503
- `issueId` is the Linear internal UUID; `issueIdentifier` is like `FLY-91`
- Use `issueId` when you have it from an event payload's `issue_id` field
- Use `issueIdentifier` when Annie assigns a task directly in chat

#### Query Existing Thread
```
GET /api/chat-threads?issueId={LINEAR-UUID}&channelId=$CHAT_CHANNEL
Response: { "threadId": "..." | null }
```

#### When to Use
- When you receive a notification with `chat_thread_id`: reply directly in the thread
- Immediately after creating an ad-hoc issue in chat when the discussion should become issue-bound: call `/api/chat-threads/create`; a Runner does not need to exist
- When discussing an existing issue but no thread exists yet: call `/api/chat-threads/create`
- With automatic creation enabled, Bridge handles every Runner role on startup and returns/surfaces the same issue thread
- If `/api/chat-threads/create` fails, reply in chatChannel top-level instead (graceful degradation)

### Memory API (GEO-204)

Search and store memories for cross-session context. Requires `memoryAllowedUsers` configured for the project.

```
POST /api/memory/search
Body: {
  "query": "auth token issues",
  "project_name": "geoforge3d",
  "user_id": "annie",
  "agent_id": "product-lead",
  "limit": 10
}
Response: { "memories": ["Auth tokens expire after 1 hour", ...] }
```

- `query` (required): natural language search query
- `project_name` (required): must match a configured project
- `user_id` (required): must be in project's `memoryAllowedUsers`
- `agent_id` (required): must be a known lead for the project
- `limit` (optional): 1-50, default 10

```
POST /api/memory/add
Body: {
  "messages": [
    { "role": "user", "content": "I prefer dark mode" },
    { "role": "assistant", "content": "Noted, I'll remember that preference." }
  ],
  "project_name": "geoforge3d",
  "user_id": "annie",
  "agent_id": "product-lead",
  "metadata": { "source": "discord" }
}
Response: { "added": 1, "updated": 0 }
```

- `messages` (required): non-empty array of `{ role: "user"|"assistant", content: string }`
- `project_name`, `user_id`, `agent_id`: same validation as search
- `metadata` (optional): plain object, merged with internal tags

Error codes: 400 (validation), 401 (no token), 502 (mem0 error), 504 (30s timeout)

### Dashboard

```
GET /
  HTML dashboard (browser)

GET /sse
  Server-Sent Events stream for real-time updates

GET /api/dashboard
  JSON dashboard data
```
