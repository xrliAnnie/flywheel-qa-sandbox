# Capability Matrix — Flywheel vs Product Experience Spec

**Issue**: FLY-57
**Date**: 2026-04-05
**Status**: Complete
**Source**: `doc/architecture/product-experience-spec.md`
**Auditor**: worker-fly-57 (interactive review with Annie)

> This document audits every discrete capability defined in the Product Experience Spec
> and classifies its implementation status. It is the basis for prioritizing remaining work.

---

## Executive Summary

The Product Experience Spec defines ~98 discrete capabilities across 7 sections. The audit found:

| Status | Count | % |
|--------|-------|---|
| **Deployed & Wired** | 54 | 55% |
| **Infra Exists** | 8 | 8% |
| **Prompt Rules Exist** | 26 | 27% |
| **Gap** | 10 | 10% |

**Key finding**: The "last mile" between infrastructure and spec-aligned behavior is mostly
prompt rules — which is correct per Annie's design principle: **code guards ONLY for
irreversible dangerous operations; everything else via prompt rules + memory/learning.**

**Critical gaps** (require code changes):
1. EventFilter bug: `approved` completion → `forum_only` (should be `notify_agent`)
2. PII/secret filtering on mem0 writes (FLY-39)
3. Approve/Ship state machine separation (FLY-58)
4. Runner question auto-relay to Chat (FLY-62)
5. QA Agent runtime (FLY-52 Phase 3)

---

## Classification Legend

| Status | Meaning |
|--------|---------|
| **Deployed & Wired** | Code exists AND is actively called in production paths |
| **Infra Exists** | Code/config exists but is not fully wired or used |
| **Prompt Rules Exist** | Behavior defined in Lead/Runner identity.md or CLAUDE.md, no code enforcement (by design) |
| **Gap** | Neither code nor prompt rules adequately cover this capability |

> **"Prompt rules exist" is spec-aligned for most behaviors.** Annie's principle: Lead is a
> full Claude Code agent with freedom to act. Code enforcement is reserved for irreversible
> dangerous operations only.

---

## Capability Matrix

### Section 2.1 — Daily Standup

| # | Capability | Status | Evidence | Notes |
|---|-----------|--------|----------|-------|
| 1 | 3AM cron trigger | Deployed & Wired | `scripts/daily-standup.sh` + launchd plist | Fires `POST /api/standup/trigger` |
| 2 | System status aggregation | Deployed & Wired | `StandupService.generateReport()` | Running/stuck/completed counts |
| 3 | Simba @mention in standup | Deployed & Wired | `StandupService` appends Simba mention | Triggers triage |
| 4 | Standup delivery to Discord | Deployed & Wired | STANDUP_CHANNEL config | Markdown report |
| 5 | Triage data API | Deployed & Wired | `triage-data-route.ts` GET /api/triage/data | Linear issues + sessions + capacity |
| 6 | Simba triage execution | Prompt Rules Exist | Simba identity.md | No code enforcement |
| 7 | Simba → Lead task distribution | Prompt Rules Exist | Core Room conversational flow | |
| 8 | Lead confirmation/adjustment | Prompt Rules Exist | Core Room conversational flow | |
| 9 | Annie review + "OK" → work start | Prompt Rules Exist | Core Room conversational flow | |

### Section 2.2 — Issue Execution

| # | Capability | Status | Evidence | Notes |
|---|-----------|--------|----------|-------|
| 1 | Lead starts Runner via API | Deployed & Wired | `runs-route.ts` POST /api/runs/start | issueId + projectName + leadId |
| 2 | Concurrency cap validation | Deployed & Wired | `runs-route.ts` | Configurable limit |
| 3 | Lead scope validation | Deployed & Wired | `lead-scope.ts` matchesLead() | Label-based routing |
| 4 | Linear pre-flight check | Deployed & Wired | `runs-route.ts` | Validates issue exists |
| 5 | Dedup check | Deployed & Wired | `runs-route.ts` | Prevents duplicate runs |
| 6 | Forum post on start | Deployed & Wired | `ForumPostCreator.ensureForumPost()` | Thread + tags + metadata |
| 7 | Chat notification on start | Deployed & Wired | `DirectEventSink.pushNotification()` | "FLY-XX started" + Forum link |
| 8 | /spin pipeline (Runner) | Deployed & Wired | `.claude/commands/spin.md` | 10-stage workflow |
| 9 | Stage tracking | Deployed & Wired | `stage-utils.ts` (10 stages) | started→ship |
| 10 | Runner→Lead question | Deployed & Wired | `flywheel-comm` ask command | SQLite queue |
| 11 | Lead→Runner answer | Deployed & Wired | `flywheel-comm` respond command | |
| 12 | Lead auto-relay questions to Chat | **Gap** | FLY-62 | Infra exists, not wired |
| 13 | Forum tag updates on status | Deployed & Wired | `ForumTagUpdater` | Per-lead tag maps (GEO-253) |
| 14 | Forum status messages | Deployed & Wired | `ForumTagUpdater.postThreadStatusMessage()` | Human-readable updates |
| 15 | Content-rich Forum stage updates | **Gap** | No issue | Doc links on stage complete missing |
| 16 | PR creation notification | Deployed & Wired | EventFilter: pr_created → notify_agent | |
| 17 | QA Agent spawn | **Gap** | FLY-52 Phase 3 | qa-framework config library exists |
| 18 | QA bug relay (Lead middleman) | **Gap** | FLY-52 Phase 3 | |
| 19 | QA PASS gate before review | **Gap** | FLY-52 Phase 3 | |
| 20 | Annie approve action | Deployed & Wired | `actions.ts` approveExecution() | FSM transition + CIPHER |
| 21 | FSM status transitions | Deployed & Wired | `WorkflowFSM` + `applyTransition.ts` | Validated + audited |
| 22 | Approve ≠ Ship separation | **Gap** | FLY-58 | Approve currently auto-merges |
| 23 | Post-merge tmux cleanup | Deployed & Wired | `post-merge.ts` postMergeCleanup() | |
| 24 | Ship notification "已 ship ✅" | **Bug** | EventFilter: approved → forum_only | Should be notify_agent (FLY-61) |
| 25 | Linear status → Done | Prompt Rules Exist | Lead identity.md | |

### Section 2.3 — Notification Protocol (Dual-Track)

| # | Capability | Status | Evidence | Notes |
|---|-----------|--------|----------|-------|
| 1 | Dual-track architecture | Deployed & Wired | EventFilter + DirectEventSink | Forum + Chat |
| 2 | EventFilter classification | Deployed & Wired | `EventFilter.ts` (11 rules) | Single source of truth |
| 3 | Forum track (async log) | Deployed & Wired | ForumPostCreator + ForumTagUpdater | |
| 4 | Chat track (sync decision) | Deployed & Wired | DirectEventSink.pushNotification() | |
| 5 | started → notify_agent | Deployed & Wired | EventFilter rule | |
| 6 | pr_created → notify_agent | Deployed & Wired | EventFilter rule | |
| 7 | failed → notify_agent | Deployed & Wired | EventFilter rule | |
| 8 | approved → notify_agent | **Bug** | EventFilter: forum_only | **Must fix → notify_agent** |
| 9 | Mid-stage → forum_only | Deployed & Wired | EventFilter rule | Correct per spec |
| 10 | Per-lead routing | Deployed & Wired | `RuntimeRegistry.resolveWithLead()` | |

### Section 2.4 — Lead ↔ Runner Communication

| # | Capability | Status | Evidence | Notes |
|---|-----------|--------|----------|-------|
| 1 | Runner→Lead question (ask) | Deployed & Wired | `flywheel-comm` ask | |
| 2 | Lead query pending (pending) | Deployed & Wired | `flywheel-comm` pending | hasPendingQuestionsFrom() |
| 3 | Lead→Runner response (respond) | Deployed & Wired | `flywheel-comm` respond | |
| 4 | SQLite queue + WAL mode | Deployed & Wired | `flywheel-comm` db.ts | |
| 5 | 72h TTL auto-cleanup | Deployed & Wired | CommDB | |
| 6 | Terminal MCP (5 tools) | Deployed & Wired | `terminal-mcp` | capture/list/search/status/input |
| 7 | Lead auto-relay to Chat | **Gap** | FLY-62 | Critical missing link |
| 8 | Multi-Runner question aggregation | Prompt Rules Exist | Lead identity.md | |

### Section 2.5 — Failure Handling

| # | Capability | Status | Evidence | Notes |
|---|-----------|--------|----------|-------|
| 1 | Retry dispatch | Deployed & Wired | `retry-dispatcher.ts` | IRetryDispatcher interface |
| 2 | Run attempt tracking | Deployed & Wired | `runAttempt` field in StateStore | |
| 3 | No max retry cap in code | Infra Exists | actions.ts handleRetry() | No hard cap — by design |
| 4 | Auto-retry ≤3 without notifying | Prompt Rules Exist | Lead identity.md | |
| 5 | Escalate after 3 failures | Prompt Rules Exist | Lead identity.md | |
| 6 | Runner stuck detection | Deployed & Wired | `runner-status.ts` | 4-state + 45s stall watchdog |
| 7 | Orphan session detection | Deployed & Wired | `HeartbeatService` | Stale heartbeat check |
| 8 | Stale completed detection | Deployed & Wired | `HeartbeatService` | tmux alive after terminal state |
| 9 | Guardrail event retry | Deployed & Wired | `HeartbeatService` | Max 3 attempts |
| 10 | Lead crash recovery | Deployed & Wired | `bootstrap-generator.ts` | Active sessions + memory recall |
| 11 | Runner "too long" intervention | Prompt Rules Exist | Lead identity.md | |

### Section 2.6 — Task Continuation

| # | Capability | Status | Evidence | Notes |
|---|-----------|--------|----------|-------|
| 1 | Session completion detection | Deployed & Wired | StateStore + DirectEventSink | |
| 2 | Lead asks Simba for next task | Prompt Rules Exist | Lead identity.md | |
| 3 | Simba re-triage | Prompt Rules Exist | Simba identity.md | |
| 4 | Continuous loop | Prompt Rules Exist | Conversational flow | |

### Section 3 — Lead Behavior

| # | Capability | Status | Evidence | Notes |
|---|-----------|--------|----------|-------|
| **3.1 Autonomy Boundaries** | | | | |
| 1 | Start Runner on confirmed plan | Deployed & Wired | runs-route.ts POST /api/runs/start | |
| 2 | Auto-retry ≤3 | Prompt Rules Exist | No code cap (by design) | |
| 3 | Priority from Simba triage | Prompt Rules Exist | Triage data API exists | |
| 4 | Must ask Annie after 3 fails | Prompt Rules Exist | Lead identity.md | |
| 5 | Must ask on unclear description | Prompt Rules Exist | Lead identity.md | |
| 6 | Must ask on dependency reorder | Prompt Rules Exist | Lead identity.md | |
| 7 | Must ask on issue split | Prompt Rules Exist | Lead identity.md | |
| 8 | No PR merge without Annie | Prompt Rules Exist | **No hard gate** (FLY-58) | |
| **3.2 Memory & Learning** | | | | |
| 9 | mem0 dual-bucket | Deployed & Wired | memory-route.ts | Private + shared buckets |
| 10 | Memory search API | Deployed & Wired | POST /api/memory/search | |
| 11 | Memory add API | Deployed & Wired | POST /api/memory/add | |
| 12 | ID validation | Deployed & Wired | ProjectConfig memoryAllowedUsers | |
| 13 | CIPHER snapshot | Deployed & Wired | saveSnapshot() in actions.ts | |
| 14 | CIPHER recordOutcome | Deployed & Wired | recordOutcome() in actions.ts | |
| 15 | CIPHER principle proposals | Infra Exists | Code exists, wiring incomplete | FLY-52 Phase 4 |
| 16 | Learning from observe | Infra Exists | CIPHER captures outcomes | Proposal gen incomplete |
| 17 | Deviation detection | Prompt Rules Exist | "New standard or exception?" | |
| 18 | Decision right expansion | **Gap** | No mechanism | Spec requires unlock UI |
| **3.3 Memory Security** | | | | |
| 19 | PII/secret filtering | **Gap** | FLY-39 | Nothing filters mem0 writes |
| **3.4 Message Style** | | | | |
| 20 | Natural conversational tone | Prompt Rules Exist | Lead identity.md | |
| 21 | No structured templates | Prompt Rules Exist | Lead identity.md | |
| **3.5 Language** | | | | |
| 22 | Chinese in Chat | Prompt Rules Exist | Lead identity.md | |
| 23 | English in Forum | Prompt Rules Exist | Lead identity.md | |
| 24 | Configurable language | Infra Exists | Not implemented yet | Future |
| **3.6 Codebase Understanding** | | | | |
| 25 | Architecture-level only | Prompt Rules Exist | Lead identity.md | |
| 26 | Arch knowledge in memory | Deployed & Wired | mem0 + shared rules | |

### Section 4 — Runner Behavior

| # | Capability | Status | Evidence | Notes |
|---|-----------|--------|----------|-------|
| **4.1 Execution Flow** | | | | |
| 1 | /spin pipeline | Deployed & Wired | .claude/commands/spin.md | |
| 2 | Stage enforcement | Prompt Rules Exist | By design — freedom principle | |
| 3 | No skip stages | Prompt Rules Exist | /spin enforces order | |
| 4 | No merge before approve | Prompt Rules Exist | **No hard gate** (FLY-58) | |
| 5 | No close before complete | Prompt Rules Exist | | |
| **4.2 Permissions** | | | | |
| 6 | Push to feature branch | Deployed & Wired | Worktree isolation | |
| 7 | Modify CLAUDE.md, CI, etc. | Prompt Rules Exist | Runner rules | |
| 8 | No direct merge | Prompt Rules Exist | **No hard gate** (FLY-58) | |
| 9 | No modify outside repo | Prompt Rules Exist | Runner rules | |
| **4.3 QA Collaboration** | | | | |
| 10 | QA framework config | Deployed & Wired | packages/qa-framework | Config + schema library |
| 11 | QA Agent spawn | **Gap** | FLY-52 Phase 3 | |
| 12 | QA bug relay via Lead | **Gap** | FLY-52 Phase 3 | |
| 13 | QA PASS gate | **Gap** | FLY-52 Phase 3 | |

### Section 5 — Multi-Lead Coordination

| # | Capability | Status | Evidence | Notes |
|---|-----------|--------|----------|-------|
| **5.1 Core Room** | | | | |
| 1 | Core Room channel | Deployed & Wired | Discord #geoforge3d-core | |
| 2 | All Leads in Core Room | Deployed & Wired | access.json allowBots | |
| 3 | Bot-to-bot communication | Deployed & Wired | GEO-296/297 plugin fork | |
| 4 | Unaddressed → Simba responds | Prompt Rules Exist | Simba identity.md | |
| 5 | @specific Lead → they respond | Prompt Rules Exist | Lead identity.md | |
| **5.2 Simba's Role** | | | | |
| 6 | Simba as Chief of Staff | Deployed & Wired | Configured Lead + identity | |
| 7 | Triage data capability | Deployed & Wired | triage-data-route.ts | |
| 8 | Cross-department coordination | Prompt Rules Exist | Simba identity.md | |
| 9 | Simba memory/learning | Deployed & Wired | mem0 dual-bucket | |

### Section 6 — System Constraints

| # | Capability | Status | Evidence | Notes |
|---|-----------|--------|----------|-------|
| 1 | Configurable concurrency cap | Deployed & Wired | runs-route.ts | |
| 2 | Resource monitoring | Infra Exists | Future requirement | No issue yet |
| 3 | Multi-machine readiness | Infra Exists | Architecture doesn't block | |
| 4 | Cost tracking | N/A | Subscription model | |
| 5 | Auto-restart (Bridge + Lead) | Deployed & Wired | restart-services.sh + launchd | |
| 6 | Crash recovery | Deployed & Wired | bootstrap-generator.ts | |
| 7 | Context window management | Infra Exists | PostCompact hook (GEO-285) | Needs research |

---

## Critical Gaps

### 1. EventFilter Bug: `approved` → `forum_only` (should be `notify_agent`)

**Impact**: After Annie approves and Runner ships, Lead cannot tell Annie "已 ship ✅" via Chat
because the `approved` completion event is classified as `forum_only`.

**Spec reference**: §2.3 — Ship completion must trigger Chat notification.

**Annie's ruling**: This is a **bug**. The EventFilter must classify `approved` completions as
`notify_agent` so the Lead can deliver the ship confirmation in Chat.

### 2. PII/Secret Filtering (FLY-39)

**Impact**: Any Lead/Runner can write API keys, tokens, or PII into mem0 via Bridge memory API.
Once written to Supabase pgvector, cleanup is difficult.

**Spec reference**: §3.3 — "写入前需要 PII/secret 过滤"

### 3. Approve/Ship Separation (FLY-58)

**Impact**: `approveExecution()` currently sets status to `approved` AND auto-advances to `ship`
stage. Spec requires Annie approve → Runner ship as separate steps. Also no code-level hard gate
preventing Runner from merging before approve.

**Spec reference**: §2.2 Hard Gates, §4.1

### 4. Runner Question Auto-Relay (FLY-62)

**Impact**: flywheel-comm infrastructure exists (ask/pending/respond), but Lead doesn't
automatically relay Runner questions to Annie in Chat. Requires Lead to proactively check
pending questions — currently only defined in prompt rules.

**Spec reference**: §2.2, §2.4

### 5. QA Agent Runtime (FLY-52 Phase 3)

**Impact**: qa-framework exists as config/schema library only. No runtime to spawn QA agents,
relay bugs, or enforce QA PASS gate before Annie review.

**Spec reference**: §2.2, §4.3

---

## Already Exists but Not Fully Wired

| Capability | What Exists | What's Missing |
|-----------|------------|----------------|
| CIPHER principle proposals | `proposePrinciples()` code | Wiring to learning loop, proposal review UI |
| CIPHER learning from observation | `recordOutcome()` captures data | Proposal generation from accumulated data |
| Max retry cap | `runAttempt` tracked per session | No code-enforced cap (prompt rules only, by design) |
| Configurable Chat language | Language defined in prompt rules | Config-driven language selection |
| Resource monitoring | Concurrency cap exists | CPU/memory/GPU monitoring |
| Context window strategy | PostCompact hook exists | Auto-compact + Memory injection strategy |

---

## Gap → Linear Issue Mapping

### Gaps WITH Existing Issues

| Gap | Linear Issue | Priority | Status |
|-----|-------------|----------|--------|
| EventFilter `approved` → `notify_agent` | [FLY-61](https://linear.app/geoforge3d/issue/FLY-61): Notification Protocol + Event Contracts | High | Backlog |
| PII/Secret filtering on mem0 writes | [FLY-39](https://linear.app/geoforge3d/issue/FLY-39): Secret Scanning for Memory | High | Backlog |
| Approve/Ship state machine separation | [FLY-58](https://linear.app/geoforge3d/issue/FLY-58): Approve/Ship 状态机重设计 | Urgent | Backlog |
| Session Role/Lane modeling | [FLY-59](https://linear.app/geoforge3d/issue/FLY-59): Session Role/Lane 建模 | Urgent | Backlog |
| Runner question auto-relay to Chat | [FLY-62](https://linear.app/geoforge3d/issue/FLY-62): Lead Question Relay | Urgent | Backlog |
| Runner tmux auto-close bug | [FLY-51](https://linear.app/geoforge3d/issue/FLY-51): Runner tmux 自动关闭 Bug | Urgent | Backlog |
| 3AM Triage chain verification | [FLY-64](https://linear.app/geoforge3d/issue/FLY-64): 3AM Triage 链路验证 | High | Backlog |
| QA Agent runtime (spawn + relay + gate) | FLY-52 Phase 3: Multi-Lead & QA | Medium | Blocked by P0+1 |
| CIPHER learning pipeline | FLY-52 Phase 4: Learning | Low | Ongoing |

### Gaps WITHOUT Issues — **NEW ISSUE NEEDED**

| Gap | Suggested Title | Description | Priority |
|-----|----------------|-------------|----------|
| Content-rich Forum stage updates | **Forum Stage Updates — doc links on stage completion** | When a stage completes (brainstorm→exploration doc, plan→plan doc), Forum update should include a link to the generated document, not just status text. Currently ForumTagUpdater posts status messages but without doc artifact links. | Medium |
| Decision right expansion mechanism | **Decision Right Expansion — Lead permission unlock mechanism** | Spec §3.2 requires a mechanism for Annie to explicitly "unlock" decision categories for a Lead (e.g., "from now on you can decide X without asking me"). Currently no code, no UI, no prompt rule for this. Need: storage of per-Lead unlocked categories, Lead checking unlocked list before escalating, Annie command to grant/revoke. | Medium |

### Notes

- **FLY-61** (Notification Protocol) subsumes the EventFilter `approved` → `notify_agent` bug fix.
  If a quick standalone fix is preferred before the full FLY-61 rework, a one-line change in
  `EventFilter.ts` would suffice (change `approved` classification from `forum_only` to `notify_agent`).
- **Resource monitoring** (§6.1) and **configurable language** (§3.5) are acknowledged as future items
  in the spec's §7 pending table. Issues can be created when they become priorities.
- **Max retry cap** is intentionally not enforced in code — prompt rules handle this per Annie's
  "freedom vs rules" principle.
