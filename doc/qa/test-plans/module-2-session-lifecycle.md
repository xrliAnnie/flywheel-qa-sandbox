# Module 2: Session Lifecycle

**Source**: Product Spec SS2.2 + SS2.3
**Scope**: FLY-47 + FLY-62
**Related components**: gate-poller, event-route, ForumPostCreator, ForumTagUpdater, claude-discord-runtime

## Prerequisites

- [ ] Bridge running (`node dist/index.js --bridge --port 9876`)
- [ ] `source ~/.flywheel/.env` (CLAUDEBOT_TOKEN, PETER_BOT_TOKEN, TEAMLEAD_INGEST_TOKEN, TEAMLEAD_API_TOKEN)
- [ ] CommDB path accessible: `~/.flywheel/comm/geoforge3d/comm.db`
- [ ] **Peter Lead running** (L1, L3, L5, L10 — all Chat verifications)
- [ ] **access.json** contains `allowBots` with ClaudeBot user ID (L5)
- [ ] Chrome open with Discord (Chrome MCP verification)

## Test Steps

### L1: Session Started -> Lead Notifies Annie in Chat

**Status**: Needs Lead

```bash
curl -X POST http://127.0.0.1:9876/events \
  -H "Authorization: Bearer $TEAMLEAD_INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "event_id": "e2e-L1-001",
    "event_type": "session_started",
    "execution_id": "e2e-run-001",
    "issue_id": "FLY-E2E-1",
    "project_name": "geoforge3d",
    "payload": {
      "issueIdentifier": "FLY-E2E-1",
      "issueTitle": "E2E Session Lifecycle Test",
      "issueLabels": ["product"]
    }
  }'
```

**Verify (Discord - #product-chat)**:
- [ ] **Peter** posts a natural language message about FLY-E2E-1 starting
- [ ] Message includes Forum post link
- [ ] Sender is **Peter - Product Lead** (NOT ClaudeBot)

**Verify (DB)**:
```bash
curl http://127.0.0.1:9876/api/sessions | jq '.[] | select(.execution_id=="e2e-run-001")'
# Expect: status="running", issue_identifier="FLY-E2E-1", issue_title="E2E Session Lifecycle Test"
```

### L2: Forum Post Created

**Status**: Can test without Lead

Triggered automatically by L1's session_started event.

**Verify (Discord - #product-forum)**:
- [ ] New post with title `[FLY-E2E-1] E2E Session Lifecycle Test`
- [ ] Content includes: Issue, Title, Execution ID, Status
- [ ] Tag = In Progress (or statusTagMap equivalent)
- [ ] FLY-75 (skip): Linear clickable link not yet implemented

**Verify (DB)**:
```bash
curl http://127.0.0.1:9876/api/sessions | jq '.[] | select(.execution_id=="e2e-run-001") | .thread_id'
# Expect: non-null Discord thread ID
```

### L3: Gate Question -> Lead Relays to Annie in Chat

**Status**: Needs Lead

```bash
node packages/flywheel-comm/dist/index.js gate brainstorm \
  --lead product-lead \
  --exec-id e2e-run-001 \
  --project geoforge3d \
  --timeout 60000 \
  "Should we use Three.js or Babylon.js? Annie, please advise."
```

Wait 3-6s for GatePoller to detect and relay.

**Verify (Discord - #product-chat)**:
- [ ] **Peter** relays the Runner's question to Annie in natural language
- [ ] Message contains the question substance ("Three.js or Babylon.js")
- [ ] Sender is **Peter - Product Lead** (Lead identity, NOT ClaudeBot)

> PASS = Peter spoke. "No ClaudeBot message" alone is NOT a pass.

**Verify (Discord - #product-lead-control)**:
- [ ] ClaudeBot posted gate_question JSON envelope (machine-to-machine event)
- [ ] Envelope contains: checkpoint=brainstorm, question content, CommDB path

**Verify (DB - CommDB)**:
```bash
node packages/flywheel-comm/dist/index.js pending --project geoforge3d --lead product-lead --json
# Expect: checkpoint="brainstorm", from_agent="e2e-run-001", resolved_at=null
```

### L4: Annie Responds -> Gate Unlocks

**Status**: Can test without Lead

```bash
# Get question_id from L3 pending output
node packages/flywheel-comm/dist/index.js respond \
  --project geoforge3d \
  --id {question_id} \
  "Use Three.js, more mature ecosystem."
```

**Verify (CLI)**:
- [ ] `respond` command exits 0
- [ ] Gate process (from L3) exits 0

**Verify (DB - CommDB)**:
- [ ] `pending --json` no longer includes this question
- [ ] `resolved_at IS NOT NULL`, `read_at IS NOT NULL`

### L5: Lead Receives Control Channel Event

**Status**: Needs Lead + allowBots

| # | Step | Notes |
|---|------|-------|
| 1 | Confirm Peter Lead tmux running | `tmux has-session -t peter-lead` |
| 2 | Confirm access.json has allowBots | `jq '.allowBots' ~/.claude/channels/discord/access.json` |
| 3 | Trigger new gate question (or reuse L3) | |
| 4 | Check Peter Lead tmux output | `tmux capture-pane -t peter-lead -p \| grep gate_question` |

**Verify (Discord - #product-lead-control)**:
- [ ] ClaudeBot posted gate_question JSON envelope
- [ ] Sender is ClaudeBot (control channel is machine-to-machine, this is correct)

**Verify (Lead tmux)**:
- [ ] Peter Lead processed the event (visible in tmux output)

### L6-L8: Blocked Steps

| Step | Annie Expects | Blocked By |
|------|--------------|------------|
| L6: PR notification | Chat: "PR ready for review" | Lead autonomous notification |
| L7: QA notification | Chat: "QA passed" | FLY-62 Phase 2 (QA->Lead relay) |
| L8: Approve -> Ship | Chat: "Shipped!" + Forum update | FLY-58 (Approve/Ship state machine) |

### L9: Session Completed -> Forum Tag Update

**Status**: Can test without Lead

```bash
curl -X POST http://127.0.0.1:9876/events \
  -H "Authorization: Bearer $TEAMLEAD_INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "event_id": "e2e-L9-001",
    "event_type": "session_completed",
    "execution_id": "e2e-run-001",
    "issue_id": "FLY-E2E-1",
    "project_name": "geoforge3d",
    "payload": {
      "issueIdentifier": "FLY-E2E-1",
      "issueTitle": "E2E Session Lifecycle Test",
      "commitCount": 3, "linesAdded": 150, "linesRemoved": 20
    }
  }'
```

**Verify (Discord - #product-forum)**:
- [ ] Forum Post tag changes from In Progress to Awaiting Review (or equivalent)

**Verify (DB)**:
```bash
curl http://127.0.0.1:9876/api/sessions | jq '.[] | select(.execution_id=="e2e-run-001") | .status'
# Expect: "completed"
```

### L10: Dedup - No Duplicate Messages

**Status**: Needs Lead

| # | Step | Notes |
|---|------|-------|
| 1 | Create new session + gate question | Use fresh execution_id |
| 2 | Wait 15-20s (5-6 poll cycles) | Do NOT respond |
| 3 | Count Peter's messages in #product-chat | Chrome MCP |
| 4 | Count "Relaying" in Bridge log | `grep "Relaying" /tmp/bridge.log \| wc -l` |

**Verify (Discord - #product-chat)**:
- [ ] Peter relayed the gate question **exactly once**
- [ ] No duplicate messages after 5+ poll cycles

**Verify (Discord - #product-lead-control)**:
- [ ] Control channel event appears only once (markLeadEventDelivered works)
