# Module 1: Daily Standup

**Source**: Product Spec `doc/architecture/product-experience-spec.md` SS2.1
**Trigger**: cron (3AM) or manual `~/.flywheel/daily-standup.sh`
**Related components**: standup-service, standup-route, triage

## Prerequisites

- [ ] Bridge running (`node dist/index.js --bridge --port 9876`)
- [ ] `STANDUP_CHANNEL` set to Core Room channel ID
- [ ] `LINEAR_API_KEY` set with Flywheel project access
- [ ] `~/.flywheel/daily-standup.sh` exists and is executable
- [ ] **Simba + Peter + Oliver Lead agents** running (S3-S5)

## Test Steps

### S1: Triage Execution

**Status**: Can test without Lead

| # | Step | Notes |
|---|------|-------|
| 1 | `~/.flywheel/daily-standup.sh` | Manual trigger. Script checks Bridge health first. |
| 2 | Observe script output | Expect: "Bridge is healthy" + "Standup triggered successfully" |

**Verify (API)**: `curl http://127.0.0.1:9876/api/standup/status` — recent timestamp + status

### S2: Core Room Message

**Status**: Can test without Lead

| # | Step | Notes |
|---|------|-------|
| 1 | Wait 5-15s for standup processing | Bridge queries Linear backlog, generates triage report |
| 2 | Chrome MCP: check Core Room | Open Discord Core Room channel |

**Verify (Discord - Core Room)**:
- [ ] Standup report posted by Bridge/Simba
- [ ] Contains: today's pending issues, Lead assignments, priority ordering
- [ ] **Style**: natural language conversation, NOT formatted template (spec SS3.4)

### S3: Lead Confirms Plan

**Status**: Needs Lead agents

| # | Step | Notes |
|---|------|-------|
| 1 | Observe Peter/Oliver response in Core Room | Leads should confirm or suggest adjustments |

**Verify (Discord - Core Room)**:
- [ ] Peter and/or Oliver replied to Simba's plan
- [ ] Reply is substantive (confirm/adjust), not just "OK"

### S4: Annie Reviews

**Status**: Manual / needs Lead agents

| # | Step | Notes |
|---|------|-------|
| 1 | Annie sees complete plan in Core Room | All Lead discussion visible |
| 2 | Annie replies OK or adjusts | Human interaction |

**Verify**: Manual — Annie can see and respond to the plan

### S5: Leads Start Work

**Status**: Needs Lead agents

| # | Step | Notes |
|---|------|-------|
| 1 | After Annie confirms, Leads start Runners | Leads should create tmux sessions |

**Verify (Discord + tmux)**:
- [ ] Chat: Lead posts "FLY-XX started" notification
- [ ] tmux: new Runner session created (`tmux list-sessions`)
