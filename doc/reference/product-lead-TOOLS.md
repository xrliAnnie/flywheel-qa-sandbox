# Product Lead Agent — TOOLS.md

> Deploy to OpenClaw workspace: `product-lead/TOOLS.md`
> Version: v1.11.0 (GEO-262)

---

## Bridge API

Base URL: configured in OpenClaw hooks. All endpoints require Bearer token auth.

### Actions

#### Resolve Action (always call first)
```
GET /api/resolve-action?issue_id={GEO-XX}&action={action}

Response: { can_execute: boolean, execution_id?: string, reason?: string }
```

Supported actions: `approve`, `retry`, `reject`, `defer`, `shelve`, `terminate`

#### Execute Action
```
POST /api/actions/approve
Body: { execution_id: "...", identifier: "GEO-XX" }

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
Note: Kills the tmux session. Only works on running sessions.
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

GET /api/sessions?mode=by_identifier&identifier=GEO-XX
  Returns session by issue identifier
```

Response includes `thread_id` — use for Forum Thread links:
`https://discord.com/channels/{guild_id}/{thread_id}`

### Session Capture (GEO-262)

Capture the current tmux terminal output of a runner session.

```
GET /api/sessions/:id/capture?lines=100

Parameters:
  :id    — execution_id or issue identifier (e.g., GEO-262)
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
- Check what a Runner is doing right now ("GEO-XX is doing what?")
- Diagnose stuck sessions ("stuck on npm install or waiting for CI?")
- Provide specific info when reporting to CEO

### Linear API (via Bridge proxy)

```
POST /api/linear/create-issue
Body: { title: "...", description?: "...", priority?: 0-4, labels?: ["label-id"] }
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

### Forum Tag (Legacy — Bridge handles automatically)

> Note: Forum tags are now managed automatically by ForumTagUpdater in Bridge.
> This endpoint is kept for backward compatibility but should NOT be used by the agent.

```
POST /api/forum-tag
Body: { thread_id: "...", tag_ids: ["..."] }
```

### Dashboard

```
GET /
  HTML dashboard (browser)

GET /sse
  Server-Sent Events stream for real-time updates

GET /api/dashboard
  JSON dashboard data
```
