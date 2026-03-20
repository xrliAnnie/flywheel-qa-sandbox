# Product Lead Agent — TOOLS.md

> Deploy to OpenClaw workspace: `product-lead/TOOLS.md`
> Version: v1.5.0 (GEO-187)

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

GET /api/sessions?mode=by_identifier&identifier=GEO-XX
  Returns session by issue identifier

GET /api/sessions?mode=active
  Returns all active (running) sessions

GET /api/sessions?mode=pending
  Returns sessions awaiting review
```

Response includes `thread_id` — use for Forum Thread links:
`https://discord.com/channels/{guild_id}/{thread_id}`

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
