# Research: Cron stale-session guard — FLY-742

**Issue**: FLY-742
**Date**: 2026-07-01
**Source**: `doc/engineer/exploration/new/FLY-742-cron-stale-session-guard.md`

---

## 1. run-start 阻塞点(唯一 choke point,所有 caller 都过它)

`packages/teamlead/src/bridge/runs-route.ts:187-206`:

```ts
const role = (typeof sessionRole === "string" ? sessionRole : undefined) ?? "main";
const activeSessions = store.getActiveSessions();
const alreadyActive = activeSessions.find(
  (s) => s.issue_id === issueId
      && (s.session_role ?? "main") === role
      && ["running", "awaiting_review"].includes(s.status),   // ← note: 少了 approved_to_ship
);
if (alreadyActive) {
  res.status(409).json({ success:false, message: `Issue ${issueId} already has an active session ...` });
  return;                                                     // ← 静默 409,零告警
}
```

**发现**:阻塞判定用的 inline 数组是 `["running","awaiting_review"]`,**没含 `approved_to_ship`**,但 `getActiveSessions()` SQL 是 `IN ('running','awaiting_review','approved_to_ship')`。即:`approved_to_ship` 的 blocker 也会出现在 `activeSessions`,但当前 `alreadyActive.find` 的 status 白名单漏了它 → 一个 `approved_to_ship` 的 lingering session **不会**触发 409(会被允许重开新 run)。这是相关但独立的松口;FLY-742 主场景是 `awaiting_review`。我的改动会把 blocker 判定与 park 态处理对齐(下详)。

`createRunsRouter(startDispatcher, store, projects, runnerAdmission, _discordGuildId?, chatThreadsEnabled?)` —— 目前**不持有** `registry`(LeadRuntimeRegistry)、tmux teardown 原语、gh checker。需要注入一个封装好的 guard(见 plan)。

## 2. StateStore 事实

- `getActiveSessions()`(`StateStore.ts:1727`)= `status IN ('running','awaiting_review','approved_to_ship')`。
- Session 字段:`pr_number?`(`:260/339`)、`awaiting_review_entered_at?`(FLY-191,`:282/355`,进入 awaiting_review 时戳、每次 fresh 进入重置)、`last_activity_at?`、`heartbeat_at?`、`session_role?`、`decision_route?`、`session_stage?`。
- `getStaleCompletedSessions(hours)`(`:2068`)= completed/failed/blocked;`getOrphanSessions(min)`(`:2052`)= running only。**都不覆盖 awaiting_review/approved_to_ship 的 stale blocker** → 这是 FLY-742 的空白。
- **无** repo full-name 字段;项目 repo 靠 `ProjectEntry.projectRoot`(`ProjectConfig.ts:192`)的 git remote 推断。

## 3. FSM 事实(auto-finalize 合法且有先例)

`packages/core/src/workflow-fsm.ts:120-154`:

- `awaiting_review → completed` **合法**(`:132`,FLY-60 W2b)。注释(`:124-129`)明写:该 transition 的 **merge-proof 守卫在 call site**(必须先验 landing_status 才能调 applyTransition)。
- `approved_to_ship → completed` **合法**(`:144`)。
- event-route 已在实践这条:`event-route.ts:921/930/973` 在 `landingStatus?.status === "merged"` 时才做 `→ completed`。

⇒ 我的 auto-finalize = **同一 transition + 同一 merge-proof 纪律**,只是把关信号用 live `gh` 权威查询(而非可能 stale 的 landing 文件)。

## 4. 复用基建

### 4.1 teardown 原语(已在 plugin.ts 为 crash-reaper 注入)

`crashReaperConfig`(`plugin.ts:2706+`)已注入:`lookupTmuxTarget`、`probeLiveness`、`captureScrollback`、`killCmuxLinkedSession`、`killTmuxWindow`、`closeTerminalView`、`deleteCommDbSession`、`archiveThread`。auto-finalize 的 teardown 复用**同一组**(等价于 `close_runner done=true` 语义 = 手动 mitigation 用的那招)。

`crash-reaper.ts:reapOne` 的顺序纪律可镜像:kill cmux → kill window → close terminal(best-effort)→ **re-read status** → applyTransition → prune CommDB → archiveThread → insertEvent。差异:目标态 `completed`(非 `terminated`),trigger `cron_stale_finalize`。

### 4.2 告警投递(GEO-270 control-channel 模式)

`plugin.ts:1502-1540`:`store.appendLeadEvent(leadId, eventId, eventType, JSON.stringify(payload))` → `registry.getForLead(leadId).deliver(envelope)` → `markLeadEventDelivered(seq)` / `recordDeliveryFailure(seq, err)`。Lead 收到后 relay 给 Annie(`notification_context`)。Lead 解析:`resolveLeadForIssue(projects, projectName, labels)`(`ProjectConfig.ts`)。

⇒ never-silent 告警复用这条:新 event_type `scheduled_run_blocked`,payload 含 issue、blocker exec-id/status/idle 时长/PR 号+状态、"清它(close_runner)或 ship 它的 PR 来解阻"。

### 4.3 applyTransition

`applyTransition(opts, executionId, targetStatus, ctx, fields?)`(`applyTransition.ts:26`)→ `{ok:true}|{ok:false,error}`。`opts = {store, fsm, executor}`。crash-reaper 已在用。

## 5. gh PR-state 查询(auto-finalize 的权威把关)

- PR 号:`session.pr_number`。repo:`gh pr view <n>` 在 `cwd=projectRoot` 时从 git remote 自动识别、无需 repo-config 铺管。
- 命令:`gh pr view <pr_number> --json state,mergedAt,closed`(cwd=projectRoot,**bounded timeout ~10s**)。判定:`mergedAt` 非空 → `merged`;`state==="CLOSED"` → `closed`;`state==="OPEN"` → `open`;任何错误/无 pr_number/超时 → `unknown`。
- **fail-safe**:`unknown` 一律当"未证实 merged" → 走 `alert_block`,**绝不** auto-close。gh 是本机 self-ship 已依赖的工具(auth 现成)。

## 6. scheduler 侧(repo 内 xhs)

`xhs-scheduler.ts:314-327`:`r.status === 409 || isDuplicateSpawn(r.message)` → `report.skipped.push({reason:"already_active"})` + `log`(非 `alert`)。**不改它**(Lead 拍板:Bridge 侧 409 告警已覆盖;外部 Sub cron 同理不动)。但会在 plan 里记录:Bridge 端的告警对这个 caller 同样生效(它 POST 同一 endpoint)。

## 7. 风险 / 边界

| 风险 | 处理 |
|------|------|
| 误清合法 park-等-founder session | auto-finalize 硬 gate 在 `gh merged/closed`;非-merged 只告警 |
| gh 查询失败/慢阻塞 run-start | bounded timeout;`unknown`→alert-only(不阻塞正确性,只是不自愈) |
| finalize 与并发终态事件 race | teardown 后 **re-read status**,非 `awaiting_review/approved_to_ship` 就不强转(镜像 crash-reaper R2 MED-3) |
| 告警噪音(快 scheduler 每 tick 告警) | 按 `(exec_id, awaiting_review_entered_at)` 去重,一 park-incident 只报一次 |
| 健康在跑的 running blocker 被误动 | classify 只对 park 态(awaiting_review/approved_to_ship)动作;running → block_silent(现状 in-flight guard 不变) |
| thread archive churn(daily 复用 issue) | archive best-effort、跟随 completed 常规行为;若 churn → Codex/QA 阶段再收(记为 open question) |
| 字节兼容 | guard 未注入时回退到纯静默 409;生产 guard 已由 FLY-1807 固化开启 |

## 8. Open questions(带进 Codex design review)

1. stale TTL 默认值 + 是否复用 `reviewTimeoutHours` 还是独立短 TTL(倾向独立、默认 ~1-2h,env 可调)。
2. 告警去重:in-memory `(exec_id, entered_at)` vs 持久 stamp(倾向 in-memory MVP,restart 后至多重报一次 = 可接受)。
3. auto-finalize 是否 archive thread(daily 复用 issue 的 churn 顾虑)。
4. `approved_to_ship` blocker 是否一并纳入 blocker 判定(修 §1 发现的白名单漏 approved_to_ship)—— 倾向纳入,与 park-态处理对齐。
