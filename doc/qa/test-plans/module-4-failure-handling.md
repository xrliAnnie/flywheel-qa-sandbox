# Module 4: Failure Handling

**Source**: Product Spec SS2.5
**Scope**: FLY-47 + FLY-62
**Related components**: flywheel-comm (gate CLI), CommDB, Lead agents

## Prerequisites

- [ ] Bridge running (`node dist/index.js --bridge --port 9876`)
- [ ] flywheel-comm CLI available (`node packages/flywheel-comm/dist/index.js`)
- [ ] CommDB path accessible: `~/.flywheel/comm/geoforge3d/comm.db`
- [ ] **Lead agent running** (E3, E4 — failure notification tests)

## Test Steps

### E1: Gate Timeout - Fail-Open (Question Checkpoint)

**Status**: Can test without Lead

```bash
node packages/flywheel-comm/dist/index.js gate question \
  --lead product-lead \
  --exec-id timeout-test-1 \
  --project geoforge3d \
  --timeout 5000 \
  "This should timeout gracefully"
```

Do NOT respond. Wait ~5 seconds.

**Verify (CLI)**:
- [ ] Gate process exits with code **0** (fail-open: Runner continues)
- [ ] Output indicates timeout, not error

> `question` checkpoint = fail-open. Runner proceeds when no answer arrives.

### E2: Gate Timeout - Fail-Close (Brainstorm Checkpoint)

**Status**: Can test without Lead

```bash
node packages/flywheel-comm/dist/index.js gate brainstorm \
  --lead product-lead \
  --exec-id timeout-test-2 \
  --project geoforge3d \
  --timeout 5000 \
  "This should timeout and block"
```

Do NOT respond. Wait ~5 seconds.

**Verify (CLI)**:
- [ ] Gate process exits with code **1** (fail-close: Runner stops)
- [ ] Output indicates timeout with blocking behavior

> `brainstorm` checkpoint = fail-close. Runner must stop when no answer arrives.

### E3: Runner Fails 1-3 Times - Annie NOT Notified

**Status**: Needs Lead

```bash
# Send session_failed with low retry count
curl -X POST http://127.0.0.1:9876/events \
  -H "Authorization: Bearer $TEAMLEAD_INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "event_id": "fail-e3-001",
    "event_type": "session_failed",
    "execution_id": "fail-run-001",
    "issue_id": "FLY-FAIL-1",
    "project_name": "geoforge3d",
    "payload": {
      "issueIdentifier": "FLY-FAIL-1",
      "issueTitle": "Failure Handling Test",
      "error": "Build failed",
      "retryCount": 1
    }
  }'
```

**Verify (Discord - #product-chat)**:
- [ ] **No message from Peter about this failure** — Lead handles silently
- [ ] Lead should auto-retry without disturbing Annie (spec SS2.5)

**Verify (Lead tmux)**:
- [ ] Lead received the failure event and processed it internally

### E4: Runner Fails 3+ Times - Annie MUST Be Notified

**Status**: Needs Lead

```bash
curl -X POST http://127.0.0.1:9876/events \
  -H "Authorization: Bearer $TEAMLEAD_INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "event_id": "fail-e4-001",
    "event_type": "session_failed",
    "execution_id": "fail-run-002",
    "issue_id": "FLY-FAIL-2",
    "project_name": "geoforge3d",
    "payload": {
      "issueIdentifier": "FLY-FAIL-2",
      "issueTitle": "Repeated Failure Test",
      "error": "Tests failing consistently",
      "retryCount": 3
    }
  }'
```

**Verify (Discord - #product-chat)**:
- [ ] **Peter sends failure report to Annie** (positive assertion — Lead SPOKE)
- [ ] Report includes: what failed, what was tried, why it's still failing
- [ ] Sender is **Peter - Product Lead** (Lead identity, NOT ClaudeBot)

> CRITICAL: "Peter spoke about the failure" is the PASS condition. "No message" = FAIL.
