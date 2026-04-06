# Module 3: Forum Lifecycle

**Source**: Product Spec SS2.3
**Scope**: FLY-47
**Related components**: ForumPostCreator, ForumTagUpdater, event-route

## Prerequisites

- [ ] Bridge running (`node dist/index.js --bridge --port 9876`)
- [ ] `source ~/.flywheel/.env` (TEAMLEAD_INGEST_TOKEN)
- [ ] Forum channel has status tags configured (In Progress, Awaiting Review, Failed)
- [ ] Bot permissions: Peter bot has CREATE_POSTS + MANAGE_THREADS on forum channel

## Test Steps

### F1: Forum Post Creation + Title Verification

**Status**: Can test without Lead

```bash
curl -X POST http://127.0.0.1:9876/events \
  -H "Authorization: Bearer $TEAMLEAD_INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "event_id": "forum-f1-001",
    "event_type": "session_started",
    "execution_id": "forum-run-001",
    "issue_id": "FLY-FORUM-1",
    "project_name": "geoforge3d",
    "payload": {
      "issueIdentifier": "FLY-FORUM-1",
      "issueTitle": "Forum Lifecycle Test",
      "issueLabels": ["product"]
    }
  }'
```

**Verify (Discord - #product-forum)**:
- [ ] New post created with title `[FLY-FORUM-1] Forum Lifecycle Test`
- [ ] Content includes: Issue, Title, Execution ID, Status
- [ ] Tag = In Progress (or statusTagMap equivalent for "running")

**Verify (DB)**:
```bash
curl http://127.0.0.1:9876/api/sessions | jq '.[] | select(.execution_id=="forum-run-001") | .thread_id'
# Expect: non-null Discord thread ID
```

### F2: Session Completed -> Tag Change

**Status**: Can test without Lead

```bash
curl -X POST http://127.0.0.1:9876/events \
  -H "Authorization: Bearer $TEAMLEAD_INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "event_id": "forum-f2-001",
    "event_type": "session_completed",
    "execution_id": "forum-run-001",
    "issue_id": "FLY-FORUM-1",
    "project_name": "geoforge3d",
    "payload": {
      "issueIdentifier": "FLY-FORUM-1",
      "commitCount": 5,
      "linesAdded": 200,
      "linesRemoved": 30
    }
  }'
```

**Verify (Discord - #product-forum)**:
- [ ] Forum Post tag changes from In Progress to Awaiting Review
- [ ] Post content or tag reflects completed status

**Verify (DB)**:
```bash
curl http://127.0.0.1:9876/api/sessions | jq '.[] | select(.execution_id=="forum-run-001") | .status'
# Expect: "completed"
```

### F3: Session Failed -> Tag Change

**Status**: Can test without Lead

```bash
# Use a fresh session for failure test
curl -X POST http://127.0.0.1:9876/events \
  -H "Authorization: Bearer $TEAMLEAD_INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "event_id": "forum-f3-start",
    "event_type": "session_started",
    "execution_id": "forum-fail-001",
    "issue_id": "FLY-FORUM-2",
    "project_name": "geoforge3d",
    "payload": {
      "issueIdentifier": "FLY-FORUM-2",
      "issueTitle": "Forum Failure Test",
      "issueLabels": ["product"]
    }
  }'

# Then send failure
curl -X POST http://127.0.0.1:9876/events \
  -H "Authorization: Bearer $TEAMLEAD_INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "event_id": "forum-f3-fail",
    "event_type": "session_failed",
    "execution_id": "forum-fail-001",
    "issue_id": "FLY-FORUM-2",
    "project_name": "geoforge3d",
    "payload": {
      "issueIdentifier": "FLY-FORUM-2",
      "error": "Build failed: TypeScript compilation error"
    }
  }'
```

**Verify (Discord - #product-forum)**:
- [ ] Forum Post tag changes to Failed (or statusTagMap equivalent)

### F4: Idempotency - Duplicate session_started Does Not Create New Post

**Status**: Can test without Lead

```bash
# Send session_started for an issue that already has a forum post (FLY-FORUM-1 from F1)
curl -X POST http://127.0.0.1:9876/events \
  -H "Authorization: Bearer $TEAMLEAD_INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "event_id": "forum-f4-dedup",
    "event_type": "session_started",
    "execution_id": "forum-run-002",
    "issue_id": "FLY-FORUM-1",
    "project_name": "geoforge3d",
    "payload": {
      "issueIdentifier": "FLY-FORUM-1",
      "issueTitle": "Forum Lifecycle Test",
      "issueLabels": ["product"]
    }
  }'
```

**Verify (Discord - #product-forum)**:
- [ ] Only ONE forum post exists for FLY-FORUM-1 (not two)
- [ ] Bridge log shows "already has thread" or similar skip message

**Verify (DB)**:
```bash
curl http://127.0.0.1:9876/api/sessions | jq '[.[] | select(.issue_identifier=="FLY-FORUM-1")] | length'
# Expect: thread_id is the same for both sessions (reused)
```

### F5: Linear Link in Forum Post

**Status**: FLY-75 skip

Forum Post should contain clickable Linear issue link. FLY-75 issue created, not yet implemented.

Requires: `LINEAR_WORKSPACE_SLUG` env var + ForumPostCreator link generation logic.
