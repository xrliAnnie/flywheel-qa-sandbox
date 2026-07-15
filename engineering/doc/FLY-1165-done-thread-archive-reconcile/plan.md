# FLY-1165 Done-thread 积压扫清 + 归档级联根因修 — 实施计划

Issue: FLY-1165 (https://linear.app/geoforge3d/issue/FLY-1165/infracleanup-扫清-flywheel-engineer-已完成但未归档的-thread-积压-48-根因修-auto)
日期: 2026-07-10
基于: research.md
修订: R3（吸收 Codex design review Round 1 全部 8 项 + Round 2 全部 7 项反馈 + Round 3 非阻塞注意事项；**Codex design review APPROVED（3 轮，2026-07-11）**）

> **For agentic workers:** 本 plan 由三段式 Implement 阶段执行（TDD，checkbox 逐项勾）。交付 1 是操作任务（先跑，Annie 等着看板干净）；交付 2 是源码任务。全程不 ship 不 merge——停在 ship gate 等 Annie。

**Goal**: 扫清 #flywheel-engineer 的 done-but-unarchived thread 积压（实测 35 个），并用「双票 gate 的 reconcile sweep（boot + 周期）」根治归档级联的四类结构性泄漏（terminate-only / husk-block / never-closed / blocked-preserve）。

**Architecture**: 不动 FLY-369 close 级联的触发逻辑；新增独立模块 `bridge/done-thread-reconcile.ts` 作纯增量兜底。归档动作收敛到唯一 token sink `archiveThreadAndRecord`——本次给它加 **per-thread 串行化 + archive-once guard**，并把 post-ship 的直调 `archiveChatThread` 收编进该 sink（Codex R2 #3：否则「重开永不再 PATCH」契约有洞）。交付 1 的所有写操作走**现在跑着的** Bridge 的既有 HTTP endpoint（StateStore 是 sql.js，外部直写必被 clobber——FLY-663；新 Bridge 代码要等 batched restart 才活，所以交付 1 不能依赖交付 2 的新代码——对 Codex R1 #1「脚本只触发 Bridge 内新 guarded op」的明确取舍：安全策略在脚本内实现 + 决策函数与主循环都有测试锁）。

**Tech Stack**: TypeScript（`flywheel-teamlead` 包，vitest）、sql.js StateStore、Linear GraphQL（`lookupLinearIssueByIdentifier`）、Discord REST（Bridge 内既有 sink）。

**安全红线（每个任务都要遵守）**:
1. token 绝不出 Bridge 进程（FLY-369 硬约束）；
2. 绝不归档有**活着的** runner 的 issue thread（FLY-117）。liveness veto 集合 = 该 issue **全部** alias 命中的 session 行（**全状态**——completed/failed/blocked 行也可能挂活进程，HeartbeatService.ts:872 生产先例）；判定 fail-closed：probe `"alive"`/`"indeterminate"`、target lookup `error`、probe throw、tmux 命令异常 → 一律按「活」；
3. 逐 issue fresh 查 Linear（`issue(id:)` 单查，identifier/UUID 都接受），绝不用缓存 list；Linear 失败 → fail-closed 跳过；
4. archive-once：`archived_at` 已设的行永不再 PATCH（尊重 Annie 重开）——sink 内 per-thread 串行段强制执行，**所有**归档调用方（级联/reconcile/manual route/post-ship）都走该 sink；
5. 绝不 kill 活 tmux——finalize 只对「确认死」且 status ∈ FINALIZE_DONE_SOURCE_STATES 的行；
6. veto 优先于一切动作，且**每段慢操作（Linear await、closeRunner await）之后、archive 之前都要复核**：同一 issue 只要有一票「活」或一个 finalize 失败，本轮整条 thread 跳过（不 finalize 剩余、不 archive）。

---

## Milestone 0 — 交付 1：安全扫清（操作 + 一个脚本 + 两层测试，Implement 阶段第一件事）

**Files:**
- Create: `scripts/fly1165-archive-done-threads.mjs`
- Create: `scripts/__tests__/fly1165-sweep-decision.test.mjs`（node:test，照 `scripts/__tests__/` 现有惯例）
- Create: `engineering/doc/FLY-1165-done-thread-archive-reconcile/deliverable1-report.md`（跑完生成）

### Task 0.1 决策函数 + 主循环编排测试（安全核心先测后写）

决策函数契约（Codex R2 #1：输入是**全状态** `sessions`，不叫 `husks`，防契约悄悄收窄）：

```js
// decideThreadAction(input)
// input: { linear: {stateType,identifier}|null|{error:true},
//          sessions: [{execution_id, status, live: true|false|"error"}] }  // ← 该 issue 全部 alias 命中行，任意 status
// returns: { action:"archive"|"skip", reason, finalizeExecIds: string[] }
// 规则：
//   linear null/error            → skip "unresolved"
//   stateType ∉ {completed,canceled} → skip "active_in_linear"
//   任一 session.live !== false  → skip "live_session"（terminal-status 活进程也算！）
//   否则 archive；finalizeExecIds = 死行中 status ∈
//     {running,awaiting_review,approved_to_ship,design_done} 的 execution_id
```

- [x] **Step 1（RED）**: 写 `scripts/__tests__/fly1165-sweep-decision.test.mjs`：
  1. Done + 全死 + 混合状态（awaiting_review 死 + completed 死）→ archive，finalizeExecIds 只含 awaiting_review 行；
  2. Done + 一个活 awaiting_review → skip "live_session"，finalizeExecIds 空（Codex R1 #1）；
  3. **Done + terminal-status（completed）行活着 → skip**（Codex R2 #1）；
  4. live:"error" → skip；
  5. Linear active → skip "active_in_linear"；
  6. Linear null / {error:true} → skip "unresolved"；
  7. Canceled + 无 session → archive。
  再加**主循环编排测试**（Codex R2 #1：证明主循环服从决策，不只测纯函数）：导出 `processThread(row, io)`（io = {fetchLinear, listSessions, probeTmux, closeRunner, archiveThread, record} 全注入），用例：
  8. skip 决策（live session）→ `io.closeRunner` 与 `io.archiveThread` 调用数都为 0；
  9. archive 决策但某 finalize 返回 `{closed:false}`（非 alreadyGone）→ 记 `husk_finalize_failed`，`io.archiveThread` 调用数 0（该 thread 本轮降级 skip）；
  10. archive 决策 + finalize 全部 `closed||alreadyGone` → `io.archiveThread` 恰被调 1 次。
- [x] **Step 2**: `node --test scripts/__tests__/fly1165-sweep-decision.test.mjs` → FAIL（函数不存在）。

### Task 0.2 扫清脚本（默认 dry-run，`--execute` 才动手）

- [x] **Step 1（GREEN）**: 写 `scripts/fly1165-archive-done-threads.mjs`（导出 `decideThreadAction` + `processThread`；`import.meta.url` 判主入口）。骨架：

```js
#!/usr/bin/env node
/**
 * FLY-1165 deliverable 1: one-off SAFE sweep of done-but-unarchived issue threads.
 * READS teamlead.db read-only (sqlite3 CLI, mode=ro); ALL writes go through the
 * RUNNING Bridge's existing endpoints (StateStore is sql.js — direct file writes
 * get clobbered, FLY-663). Default DRY-RUN; pass --execute to act.
 * env: FLYWHEEL_BRIDGE_URL(=http://localhost:9876) TEAMLEAD_API_TOKEN LINEAR_API_KEY FLYWHEEL_STATE_DIR(=~/.flywheel)
 * args: [--execute] [--channel 1516209714097291335] [--project flywheel] [--lead flywheel-eng-lead] [--spacing-ms 1200]
 */

// 1) 候选（READ-ONLY）：SELECT thread_id, issue_id FROM chat_threads
//     WHERE channel_id=? AND (archived_at IS NULL OR archived_at='')
//       AND discord_missing_at IS NULL AND issue_id LIKE 'FLY-%' ORDER BY created_at
// 2) fresh Linear：GraphQL issue(id:$key){identifier state{name type}}，
//    Authorization: <raw LINEAR_API_KEY>，10s timeout；任何错误 → {error:true}。
// 3) sessions（**全状态**，alias 双查——Codex R2 #1 / R1 #2）：
//      SELECT execution_id, status FROM sessions
//       WHERE issue_id=? OR issue_identifier=?          -- ? = row.issue_id 两处
//    每行 liveness：tmux list-windows -a -F '#{session_name}:#{window_name}'
//      输出含 issue identifier（精确子串）→ 该 issue 所有行 live:true（窗名是 issue 级的，
//      按 issue 判活——保守方向，宁可多 veto）；exit 0 不含 → live:false；
//      明确 "no server running" → live:false；其它任何错误（ENOENT/EACCES/timeout）→ live:"error"。
// 4) const d = decideThreadAction({linear, sessions})；processThread 按 d 执行：
//    - skip → record(d.reason)
//    - archive → 逐个 finalize d.finalizeExecIds：
//        POST /api/sessions/{id}/close-runner {leadId, reason:"FLY-1165 stale husk finalize (issue Done, tmux gone)", done:true}
//        response.closed===true || alreadyGone===true → 计 husk_finalized；
//        其它（409/closed:false/网络错误）→ 记 husk_finalize_failed，**整条 thread 本轮降级 skip**（fail-closed）。
//      finalize 全成后归档：POST /api/chat-threads/archive
//        {issueIdentifier: row.issue_id, channelId, leadId, projectName}
//        （不做 issueId 二次重试——对 FLY-* 字符串两个字段走同一 canonicalize 路径，
//         重试是无效安慰剂，Codex R2 #4。404 → 记 archive_failed，**留给交付 2 boot sweep**，
//         它按精确 thread 行工作无 canonicalize 问题。取证注：当前 35 行 sessions join
//         全部按 identifier 命中，404 属理论路径。）
//        archived===true 或 reason==="already_archived"（FLY-980 手写行幂等覆盖）→ 计 archived。
//      每次 archive 间 sleep(SPACING_MS)。
// 5) 单 thread 失败 → record + continue。
// 6) 报告 deliverable1-report.md：archived[] / skipped_active[] / skipped_live_session[] /
//    unresolved[] / husk_finalized[] / husk_finalize_failed[] / archive_failed[]，各带 issue id+title。
```

- [x] **Step 2**: `node --test scripts/__tests__/fly1165-sweep-decision.test.mjs` → PASS（10 用例）。
- [x] **Step 3**: dry-run。Expected: ~35 候选；`skipped_active` 至少含 FLY-1165（本票）、FLY-1160、FLY-1159（除非其间已 Done）；零写操作。
- [x] **Step 4**: dry-run 摘要经 `flywheel-comm ask` 报 Lead（不等回复——gate 已预批「实现阶段就先跑」）；分类反常（active 清单为空/候选暴涨）→ 停，`gate question`。
- [x] **Step 5**: `--execute` → 再 dry-run 复核（候选只剩 skip 类）→ 生成报告。
- [x] **Step 6**: Commit（script + test + report），`flywheel-comm ask` 报 Lead（Lead 转呈 Annie 目视验收）。

---

## Milestone 1 — 交付 2A：StateStore 方法

**Files:**
- Modify: `packages/teamlead/src/StateStore.ts`（chat_threads 方法区，~L4368）
- Test: `packages/teamlead/src/__tests__/StateStore.fly1165-chat-threads.test.ts`（新 per-issue 文件，照 `StateStore.fly887-*.test.ts` 惯例）

### Task 1.1 三个方法（TDD 一起做）

- [x] **Step 1（RED）**:
```ts
describe("FLY-1165 StateStore reconcile helpers", () => {
  it("getUnarchivedIssueChatThreads: 只返回未归档、未 missing、有 issue key 的主表行（含 lead_id）");
  it("getSessionsForIssueAliases: issue_id OR issue_identifier 任一别名命中（UUID↔identifier 双向）");
  it("isChatThreadArchived: fresh 读 archived_at（mark 前 false / 后 true）");
});
```
- [x] **Step 2**: `pnpm --filter flywheel-teamlead exec vitest run src/__tests__/StateStore.fly1165-chat-threads.test.ts` → FAIL（确认 3 用例被收集，非 no-tests）。
- [x] **Step 3（GREEN）**:
```ts
/** FLY-1165: reconcile 候选 — 未归档、未 missing、有 issue key 的主表 thread。 */
getUnarchivedIssueChatThreads(): Array<{ thread_id: string; channel_id: string; issue_id: string; lead_id: string | null }>
  // WHERE (archived_at IS NULL OR archived_at='') AND discord_missing_at IS NULL AND issue_id IS NOT NULL AND issue_id != ''

/** FLY-1165: alias-aware sessions（照 StateStore.ts:3181 的 issue_id/issue_identifier 兼容模式，参数化 IN 展开）。 */
getSessionsForIssueAliases(keys: string[]): Array<{ execution_id: string; status: string; project_name: string; issue_id: string; issue_identifier: string | null }>

/** FLY-1165: fresh archive-once 读（sink guard 用）。 */
isChatThreadArchived(threadId: string): boolean
```
- [x] **Step 4**: PASS → Commit。

---

## Milestone 2 — 交付 2B：sink 级 archive-once（串行化 + 收编 post-ship）+ reconcile 模块

**Files:**
- Modify: `packages/teamlead/src/bridge/done-thread-archiver.ts`（`archiveThreadAndRecord` + per-thread mutex）
- Modify: `packages/teamlead/src/bridge/post-ship-finalization.ts`（~L434 直调 `archiveChatThread` 改走 sink）
- Create: `packages/teamlead/src/bridge/done-thread-reconcile.ts`
- Test: `packages/teamlead/src/bridge/__tests__/done-thread-reconcile.test.ts` + archiver / post-ship 现有测试文件扩展

### Task 2.1 sink：per-thread 串行 + archive-once + 收编 post-ship（Codex R1 #3 / R2 #3）

- [x] **Step 1（RED）**:
```ts
it("sink no-ops when archived_at set: archiveFn 未被调, reason='already_archived', attempts 0");
it("close cascade path respects sink-level archive-once（重开不被再 PATCH）");
it("CONCURRENT double-call on same thread serializes: archiveFn 恰 1 次, 第二个 caller 得 already_archived", async () => {
  // archiveFn 挂 deferred promise 制造重叠；两个 archiveThreadAndRecord 并发 → 串行化
});
it("post-ship finalization on an already-archived thread does NOT re-PATCH（走 sink 后天然获得 guard）");
```
- [x] **Step 2（GREEN）**:
  - `done-thread-archiver.ts` 加模块级 `const threadArchiveLocks = new Map<string, Promise<void>>()`；`archiveThreadAndRecord` 全体（fresh `store.isChatThreadArchived` 检查 → removeUser → PATCH → mark/audit）搬进 per-thread 临界段。**mutex 抗前驱 rejection（Codex R3 #1）**：接尾用 settled tail——`const prev = locks.get(id) ?? Promise.resolve(); const cur = prev.catch(() => undefined).then(run); locks.set(id, cur)`，`finally` 清理时 identity-check（map 里还是自己才删）；保持 `archiveThreadAndRecord` never-throws 契约。已归档 → `{ archived: false, attempts: 0, reason: "already_archived" }`；`ArchiveReason` 加 `"already_archived"`。
  - `post-ship-finalization.ts` 的直调 `archiveChatThread` 改为 `archiveThreadAndRecord`（**保持 notifier-先于-archive 的现有顺序与审计字段**；其原有的 removeUser 调用并入 sink 参数，避免双删）。**post-ship 收到 `reason:"already_archived"` 记为幂等 no-op 成功，绝不落 `chat_thread_archive_failed`（Codex R3 #2）**——现源码只按 `archiveResult.archived` 分支，需显式新分支；回归测试断言「零 Discord PATCH + 非 failure 审计来源」两件事。HTTP route 的早退检查保留（无害双保险）。
  - **行为声明**（PR 描述写明）：这是有意的全局修复——此前 close 级联/post-ship 都可能对 Annie 重开过的 thread 再归档，本次统一根治；post-ship 唯一语义变化 = 已归档时不再重复 PATCH + 多落一条 audit 事件（chat_thread_archived 来源字段照旧传入）。
- [x] **Step 3**: archiver + post-ship 相关既有测试全绿 → Commit `feat(FLY-1165): sink-level archive-once with per-thread serialization; route post-ship archive through the shared sink`.

### Task 2.2 配置解析（env 每轮重读）

- [x] **Step 1（RED→GREEN）**: `resolveDoneThreadReconcileConfig(env = process.env)`：
```ts
defaults: { enabled: true, intervalMin: 360, dryRun: false, maxArchivesPerRun: 25, maxCandidatesPerRun: 200, runDeadlineMs: 120_000 }
// FLYWHEEL_DONE_THREAD_RECONCILE=0 → enabled:false；…_INTERVAL_MIN=0 → boot-only；junk/负 → 默认；…_DRYRUN=1；…_MAX_PER_RUN
```
- [x] **Step 2**: Commit。

### Task 2.3 `reconcileDoneThreads()` 主流程（TDD，逐 case）

模块契约：

```ts
export const RECONCILE_FINALIZABLE_STATUSES = ["running","awaiting_review","approved_to_ship","design_done"] as const; // = FINALIZE_DONE_SOURCE_STATES

export interface DoneThreadReconcileDeps {
  store: StateStore; projects: ProjectEntry[];
  linearApiKey?: string; globalBotToken?: string; discordOwnerUserId?: string;
  transitionOpts?: ApplyTransitionOpts;
  dryRun?: boolean; maxArchivesPerRun?: number; maxCandidatesPerRun?: number;
  runDeadlineMs?: number; archiveSpacingMs?: number;
  /** 协作停机（Codex R2 #5）：调度器 stop 时置 true，候选间检查。 */
  shouldAbort?: () => boolean;
  // seams（默认接真实现）
  lookupIssue?: typeof lookupLinearIssueByIdentifier;
  archiveFn?: typeof archiveChatThread; removeUserFn?: typeof removeUserFromChatThread; fetchImpl?: typeof fetch;
  /** 三态 discriminated lookup（found/gone/error）——复用 crash-reaper 注入的 lookupTmuxTarget
   *  （plugin.ts:366），error ⇒ 活（Codex R1 #2）。 */
  lookupTarget?: typeof lookupTmuxTarget;
  probeLiveness?: (tmuxWindow: string) => Promise<RunnerLiveness>;
  closeRunnerFn?: typeof closeRunner;
  sleepImpl?: (ms: number) => Promise<void>; now?: () => number; log?: (msg: string) => void;
}

export interface DoneThreadReconcileResult {
  scanned: number; archived: number; huskFinalized: number; huskFinalizeFailed: number;
  skippedActive: number; skippedNotDone: number; skippedUnresolved: number;
  skippedNoToken: number; skippedNoProject: number; skippedAlreadyArchived: number;
  failed: number; capped: boolean; deadlineHit: boolean; aborted: boolean; dryRunWouldArchive: number;
}
```

每 thread 流水线（**顺序即安全设计，不许调换**；`checkLiveness(keys)` = 对 `getSessionsForIssueAliases(keys)` 的**全状态**行做三态 target lookup + probe，任一活即 true）：

1. **预算/停机**：`shouldAbort()` → `aborted=true` break；`scanned >= maxCandidatesPerRun` 或超 `runDeadlineMs` → `capped/deadlineHit=true`，log 剩余数（不许静默截断），break。
2. **veto #1（便宜挡刀）**：`checkLiveness([thread.issue_id])` 活 → `skippedActive`，continue（连 Linear 都不查）。
3. **fresh Linear**：无 `linearApiKey` → sweep 开头整体 return（log 一次）。`lookupIssue(linearApiKey, thread.issue_id)`：null/throw → `skippedUnresolved`（per-thread try/catch）；`stateType` ∉ {completed, canceled} → `skippedNotDone`。`aliasKeys = dedupe([thread.issue_id, linear.id, linear.identifier])`。
4. **veto #2（Linear await 后）**：`checkLiveness(aliasKeys)` 活 → `skippedActive`。全死 → husk finalize：对死行中 status ∈ `RECONCILE_FINALIZABLE_STATUSES` 的逐个 `closeRunnerFn({ executionId, issueId: thread.issue_id, projectName: row.project_name, reason: "FLY-1165 reconcile: dead husk on Done issue", leadId: "bridge.done-thread-reconcile", finalizeDone: true, transitionOpts }, store)`——**不带 archive deps**。任一结果非 `closed||alreadyGone` → `huskFinalizeFailed++`，**整条 thread 本轮 skip**（Codex R2 #2，对齐交付 1）。**`transitionOpts` 缺失且存在 finalizable 死行 → 同样 `huskFinalizeFailed` + skip（Codex R3 #3：finalize 不可用 = finalize 失败，fail-closed 一致；生产必有 transitionOpts，此分支只防测试/异常装配）**。dryRun → 不调 close。
5. **veto #3（finalize await 后、archive 之前——Codex R2 #2）**：closeRunner 可能 await cmux/tmux/osascript 数秒到更久，必须再 `checkLiveness(aliasKeys)`；活 → `skippedActive`。再 fresh `store.isChatThreadArchived(thread.thread_id)` / missing 检查 → 已归档/missing → `skippedAlreadyArchived`（期间别的路径归档过/Annie 重开过，绝不再 PATCH；sink 内 guard 是第二重）。
6. **归档**：project 解析 **fail-closed**（Codex R2 #6）：aliasKeys 命中的 session 行的 `project_name`（去重后唯一才用）→ 否则要求 `(thread.lead_id, thread.channel_id)` 对**恰好唯一**匹配一个 project 的 lead 配置；0 或 >1 匹配 → `skippedNoProject`，skip + log。botToken = `resolveBotTokenForThread(projects, { projectName, leadId: thread.lead_id, labels: session ? store.getSessionLabels(session.execution_id) : [], fallbackBotToken: globalBotToken })`；无 → `skippedNoToken`。dryRun → `dryRunWouldArchive++`。否则 `archiveThreadAndRecord(...)`：`reason==="already_archived"` → `skippedAlreadyArchived`（**不算 failed**，Codex R2 #3）；`archived` → `archived++`；其它 → `failed++`（404 由 sink 内部 markMissing 自然出候选）。`sleepImpl(archiveSpacingMs)`；`archived + dryRunWouldArchive >= maxArchivesPerRun` → `capped=true` break。
7. 收尾 log 一行结构化 summary。整个函数 never throws。

- [x] **Step 1（RED）**: 逐 case 测试（mock 全 seam；store 用真 StateStore 内存实例）。**必须覆盖**（R2 后 23 条）：
  1. Done+无 session → 归档 + markChatThreadArchived；再跑候选为空（幂等）；
  2. Canceled → 归档；
  3. Linear active → 跳过，archiveFn 未调；
  4. lookupIssue null/throw → skippedUnresolved，后续 thread 不受影响；
  5. 活 runner（probe alive）→ skippedActive，lookupIssue 未被调（veto #1 在前）；
  6. indeterminate / probe throw → 按活跳过；
  7. lookupTarget `error` 三态 → 按活跳过（CommDB lock ≠ dead）；
  8. terminal-status（completed）行挂活进程 → veto；
  9. alias：thread key=identifier、session key=UUID → veto #2 枚举命中；
  10. TOCTOU-A：veto #1 干净、lookupIssue await 期间新 live session 落库 → veto #2 挡下；
  11. **TOCTOU-B：closeRunnerFn await 期间新 live session 落库 → veto #3 挡下，archiveFn 0 次**（Codex R2 #2）；
  12. **finalize 返回 closed:false → huskFinalizeFailed++，整 thread skip，archiveFn 0 次**；
  13. 死 husk（gone）+ Done → closeRunnerFn finalizeDone:true 被调 + 归档；
  14. **veto #3 时 archived_at 已被别的路径设置 → skippedAlreadyArchived，archiveFn 未调**；
  15. **sink 返回 already_archived → 计 skippedAlreadyArchived 非 failed**；
  16. cap=1、两 Done 候选 → 归档 1，capped:true；
  17. maxCandidatesPerRun=1、两候选 → 扫 1，capped:true；
  18. runDeadlineMs 超支（fake now）→ deadlineHit:true；
  19. **shouldAbort 中途翻 true → aborted:true，后续候选不开工**；
  20. dryRun → close/archive 都未调，计数正确；
  21. 无 linearApiKey → 全场 no-op（零网络调用）；
  22. 无 botToken → skippedNoToken；**project 解析 0 匹配与 2 匹配（duplicate-config）→ skippedNoProject**（Codex R2 #6）；
  23. UUID 形态 issue_id → 原样传 lookupIssue（断言实参）。
- [x] **Step 2**: FAIL → **Step 3（GREEN）** 实现 → **Step 4** PASS（`pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/done-thread-reconcile.test.ts`，确认 23 用例全收集）。
- [x] **Step 5**: Commit `feat(FLY-1165): done-thread reconcile sweep (triple-veto, recheck-before-archive, husk finalize fail-closed)`.

---

## Milestone 3 — 交付 2C：调度器 + plugin 接线 + flag 注册 + QA-slot 隔离

**Files:**
- Modify: `packages/teamlead/src/bridge/plugin.ts`（boot 链接线 ~L3968；teardown 跟 `fleetReconcileTimer` 清理同点位）
- Modify: `packages/config/src/feature-flags/registry.ts`
- Modify: `scripts/test-deploy.sh`（+ 其 contract test，若有）
- Test: 调度测试并入 `done-thread-reconcile.test.ts`

### Task 3.1 调度器：不阻塞 boot + 真 direct-toggle + 可排水停机（Codex R1 #4/#5 + R2 #5）

```ts
export function startDoneThreadReconcileScheduler(opts: {
  runOnce: (shouldAbort: () => boolean) => Promise<DoneThreadReconcileResult | undefined>;
  resolveConfig?: () => DoneThreadReconcileConfig;
  bootDelayMs?: number;   // 默认 15_000 — boot pass 异步起，boot 链零 await
  tickMs?: number;        // 默认 60_000 — 心跳 tick
  setTimeoutImpl?/setIntervalImpl?/now?;  // test seams
}): { stop: () => Promise<void> }
```
语义（模块级测试锁死）：
- boot pass：`setTimeout(bootDelayMs)` 一次（fire-and-forget + catch）；
- 周期：60s 心跳，每 tick fresh `resolveConfig()`：`!enabled` → no-op（off→on / on→off 无需重启）；`intervalMin===0` → boot-only；`now - lastRunAt >= intervalMin*60_000` 且 `!inFlight` → run；
- single-flight：`inFlight` 布尔；
- **`stop(): Promise<void>`（Codex R2 #5）**：置 `stopped=true`（新 run 不再开工 + 通过 `shouldAbort` 让在跑的 pass 在候选间协作退出）→ 清两个 timer → `await` 当前 in-flight promise（若有）。plugin teardown **`await doneThreadReconcile.stop()` 在 `store.close()` 之前**。
- 两 timer 都 `unref?.()`。

- [x] **Step 1（RED）**: 调度测试（fake timers）：boot 延迟一次；off→on 下一 tick 生效；on→off 停跑；interval 改动生效；in-flight 不并发；**stop() 等待在跑 pass 完成且之后零新 run**（pending-promise 测试）。
- [x] **Step 2（GREEN）**: 实现 → PASS。
- [x] **Step 3**: plugin.ts 接线（boot 链只调 `startDoneThreadReconcileScheduler`，`runOnce` 内 fresh resolve config + 组装 `reconcileDoneThreads` deps：`lookupTarget: lookupTmuxTarget`、`probeLiveness: probeRunnerProcessLiveness`、`shouldAbort` 由调度器传入）；teardown 位置 `await doneThreadReconcile.stop()`（先于 store 关闭）。
- [x] **Step 4**: Commit。

### Task 3.2 flag 注册（诚实 toggle 语义）

- [x] `registry.ts` 增 `done_thread_reconcile`（bool kill-switch，`envVar:"FLYWHEEL_DONE_THREAD_RECONCILE"`，`polarity:"default_on"`，readSite=`resolveDoneThreadReconcileConfig` `call_time`/env-param——每 tick 重读为真 + directToggleProof 测试；完整字段照 `auto_qa_killswitch` 模板）。`…_INTERVAL_MIN`/`…_DRYRUN`/`…_MAX_PER_RUN` 按 registry value-knob 既有形态注册（无先例则 description 点名伴生 env）。registry contract 测试绿 → Commit。

### Task 3.3 QA-slot 隔离进代码（Codex R1 #7）

- [x] `scripts/test-deploy.sh` 给 slot Bridge 环境显式注入 `FLYWHEEL_DONE_THREAD_RECONCILE=0`（跟现有 slot env 注入同点位；QA 要测 sweep 时显式 override opt-in）。**扩展既有 shell contract test `scripts/__tests__/test-deploy-qa-room.test.sh`（Codex R3 #4 确认存在）断言每个 slot Bridge 都拿到该 env**。Commit。

---

## Milestone 4 — 全量验证 + PR

- [x] Vitest：`pnpm --filter flywheel-teamlead test`（全包；确认 2 个新 vitest 文件被收集：StateStore.fly1165 3 例 + done-thread-reconcile 23+调度用例，数字写进 PR 描述）+ `pnpm --filter flywheel-config test`（registry）。
- [x] **单独跑** Node 脚本测试（vitest 收集不到它——Codex R2 #7）：`node --test scripts/__tests__/fly1165-sweep-decision.test.mjs`（10 例），计数单独报告。
- [x] `pnpm lint`（全仓，push 前必跑）。
- [x] `pnpm build` 后模块驱动冒烟：拷生产 DB 到 scratch（**拷贝**），dist 的 `reconcileDoneThreads` + `dryRun:true` + mock archiveFn，人工核对分类与交付 1 报告一致（交付 1 已清板则 `dryRunWouldArchive` ≈ 0）。
- [x] PR：单 PR 含交付1 script+test+report + 交付2 代码 + 本文件夹 docs。PR body 讲清：交付 1 已执行结果（数字）、交付 2 纯增量兜底、**有意的既有路径变化只有两处并写明理由**（① sink 级 archive-once + per-thread 串行；② post-ship 直调收编进 sink）、flag 矩阵与真实 toggle 语义、**deploy = merge 后下次 batched Bridge restart（不为本 PR 单独重启）**、QA-slot 已在 test-deploy.sh 隔离。
- [x] `flywheel-comm stage set pr_created` → Codex code review 循环 → APPROVE GATE 流程停在 ship gate。**不 merge 不 :cool:**。

## QA 阶段要点（QA phase 参考，非 Implement 勾选项）

1. 交付 1 复核：fresh `mode=ro` 查询——channel 内未归档 FLY-% 集合 == 报告 skip 类集合；抽 3-5 个已归档 thread 用 bot GET `/channels/{id}` 验 `thread_metadata.archived === true`（或 Claude-in-Chrome 目视）。
2. 交付 2 行为级：全部单测独立重跑（vitest 两文件 + node --test 脚本测试）；模块驱动 dist dry-run（同 M4 冒烟）；一条真归档路径——529 Room 测试 channel 造真 thread + 隔离 DB 假行 + Linear mock Done，非 dry-run 跑，验 Discord 真 archived + `archived_at` 落库 + `chat_thread_archived` 审计事件。
3. 红线复验：live/indeterminate/lookup-error/terminal-status-live fixture 绝不归档；TOCTOU-A/B 用例；sink 并发串行化 + 重开不再 PATCH（含 post-ship 路径）；flag=0 sentinel；stop() 排水。
4. 生产 boot sweep 生效性属于**下次 batched restart 的 post-restart verify**（挂 Lead 重启清单），不阻塞本票 QA verdict。

## 风险与对策

| 风险 | 对策 |
|------|------|
| Done 但 Annie 还在聊的 thread 被 sweep 归档 | 本票 Annie 明确要求 sweep（政策更新）；auto-unarchive + **sink 级 archive-once（per-thread 串行，全调用方含 post-ship）**。不加静默期（跟随「Done 即归档」拍板），要护栏后续一行 env 可加 |
| 误归档 active thread（FLY-117 / task#117 前科） | 双票 + 全状态 liveness veto（error/indeterminate=活）+ **三段 veto（初筛/Linear 后/finalize 后紧贴 archive）** + 23 条单测锁死。残余窗口 = veto #3 与 PATCH 之间的网络毫秒级，新 run 首条消息 Discord auto-unarchive 自愈 |
| 误杀活 runner | 一票活 → 整 thread 跳过；finalize 只对 gone/probe 死 + finalizable 状态行；finalize 失败 → 整 thread skip（fail-closed） |
| CommDB lock/corruption 误判 dead | 三态 `lookupTmuxTarget`，error ⇒ 活 |
| boot 拖慢 / 停机竞态 | 调度器异步（boot 零 await）+ maxCandidates + 墙钟 deadline + single-flight + **async stop() 排水后才 store.close()** |
| Discord 429 | cap/轮 + 500ms 间隔 + sink 自带 bounded retry/Retry-After |
| Linear 故障/超时 | per-thread fail-closed 跳过；deadline 保证整轮有界 |
| 直写 DB 被 clobber（980 前科） | 全部写路径在 Bridge 进程内；脚本只读 mode=ro；980 行幂等收正 |
| QA-slot Bridge 扫真 Linear | test-deploy.sh 显式注入 flag=0（进代码） |
| identifier/UUID 混键 | StateStore alias 查询 + 交付 2 按精确 thread 行工作；交付 1 的混键 404 记 archive_failed 留给交付 2（不做无效的同串重试——Codex R2 #4） |
| project 解析歧义 | fail-closed：唯一 session project_name 或 (lead_id, channel_id) 恰一匹配，否则 skippedNoProject |

## 验收（对照 issue 原文）

- 交付 1：#flywheel-engineer thread 列表只剩 active issue 的 thread（Annie 目视确认 = 终验）；报告列出归档 N / 跳过 M / husk 清理数（含活 session 跳过与 finalize 失败清单）。
- 交付 2：新 Done issue 走既有即时路径自动归档；reconcile sweep 兜住四类漏网并有 23+ 单测锁死；flag 可关且 toggle 无需重启；本票自己的 thread 在 issue Done 后被 sweep 自动归档（天然 dogfood 证据）。
