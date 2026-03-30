# Lead Orchestration Patterns — Reference

**Issue**: GEO-292
**Date**: 2026-03-30
**Status**: Reference Document (not executable)

This document captures orchestration patterns for Lead agents (Peter/Oliver/Simba). It serves as a reference for updating Lead agent.md files in product repos.

---

## Reconcile Behavior

Lead periodically checks system state and dispatches work:

1. **Query active Runners**: `GET /api/runs/active` → `{ running, inflight, total, max }`
2. **Query available work**: `GET /api/linear/issues?state=todo&project=Flywheel` → unstarted issues
3. **Check capacity**: If `total < max`, dispatch next issue
4. **Start Runner**: `POST /api/runs/start { issueId, leadId }` → spawns Runner in tmux

```
Lead → Bridge: GET /api/runs/active
Lead → Bridge: GET /api/linear/issues?state=todo
Lead → Bridge: POST /api/runs/start {issueId, leadId}
```

## Monitor Behavior

Lead receives Runner progress updates via PostToolUse hook injection:

```
Runner → CommDB: progress message (stage + status)
CommDB → Lead hook: sqlite3 query unread progress
Lead hook → Lead context: additionalContext injection
```

Progress updates appear as:
```
RUNNER PROGRESS UPDATE — For your awareness, no action needed unless stuck

[Runner Progress] GEO-292 brainstorm completed (artifact: doc/exploration/new/GEO-292-orchestrator-patterns.md)
[Runner Progress] GEO-292 research started
```

### Multi-Runner Progress Aggregation

When monitoring multiple Runners, Lead should:
- Track each Runner's last known stage
- Report summary to Annie only at milestones (not every stage transition)
- Flag Runners stuck in a stage for > expected duration

## Progress Message Handling

| Scenario | Lead Action |
|----------|------------|
| Runner reports `started` | Update internal tracking, no action |
| Runner reports `completed` | Update tracking, note artifact path |
| Runner reports `failed` | Investigate via `GET /api/sessions/:id/capture`, decide retry |
| No progress for > 30 min | Check Runner health via Bridge API |

## Pipeline Stage Reference

Aligned with orchestrator 9-step template:

| Stage | Description | Expected Duration |
|-------|-------------|-------------------|
| `verify_env` | Parse issue, onboard, create worktree | 2-5 min |
| `brainstorm` | Explore design space, identify options | 5-15 min |
| `research` | Technical feasibility, codebase analysis | 5-15 min |
| `plan_review` | Write plan + Codex design review loop | 10-30 min |
| `implement` | Code changes + tests | 15-60 min |
| `code_review` | Codex/Gemini code review (Phase 2) | 5-15 min |
| `user_approval` | Annie reviews PR (Phase 2) | Variable |
| `ship` | Merge PR (Phase 2) | 2-5 min |
| `post_ship` | Archive docs, cleanup (Phase 2) | 2-5 min |
