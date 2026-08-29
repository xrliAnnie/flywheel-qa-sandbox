# FLY-1165 Done-thread 积压扫清 + 归档级联根因修 — 调研

Issue: FLY-1165 (https://linear.app/geoforge3d/issue/FLY-1165/infracleanup-扫清-flywheel-engineer-已完成但未归档的-thread-积压-48-根因修-auto)
日期: 2026-07-10
基于: exploration.md

Brainstorm gate 已过（Lead 批准方向 + 4 点逐条确认 + 1 条提醒：FLY-980 是手动直写归档的，`archived_at` 可能被 export 冲掉 → sweep 幂等重扫即可，Discord 侧已 archived 无副作用）。

---

## 1. 归档基础设施现状（代码证据，全部已核）

### 1.1 唯一 token sink 与 endpoint

| 组件 | 位置 | 关键行为 |
|------|------|---------|
| `archiveChatThread` | `bridge/chat-thread-utils.ts:113` | 已硬化：per-attempt 5s timeout、3 次 bounded retry（429 尊重 Retry-After、5xx backoff）、2xx 后验证 `thread_metadata.archived`、404 → `markDiscordMissing`。never throws，返回结构化 `ArchiveChatThreadResult` |
| `archiveThreadAndRecord` | `bridge/done-thread-archiver.ts:74` | **唯一 token-bearing 归档 sink**：可选 removeUser（founder sidebar 清理）→ `archiveChatThread` → 成功 `markChatThreadArchived` + `chat_thread_archived` 审计事件；失败 `chat_thread_archive_failed` 事件。never throws |
| `archiveIssueThreadIfNoOtherActive` | `done-thread-archiver.ts:171` | 级联策略面：(a) `allowStatuses` gate；(b) 同 issue 无其它 active runner（`running/awaiting_review/approved_to_ship`，`CLOSE_ARCHIVE_ACTIVE_STATUSES`）；(c) label→lead→chatChannel 解析；(d) `resolveBotTokenForThread`（thread 建时 lead_id 优先） |
| `POST /api/chat-threads/archive` | `bridge/tools.ts:983` | FLY-369 backfill 通道。前置：`chatThreadsEnabled` + `apiTokenConfigured`（未配 token → 503 fail-closed）。body `{issueId?\|issueIdentifier?, channelId, leadId, projectName}`；`validateChatThreadParams` 做 Lead scope 校验；identifier↔UUID canonicalize（经 session 行 + Linear 交叉解析）；**archive-once**：`archived_at` 已设 → no-op 200 `already_archived` |
| `POST /api/sessions/:executionId/close-runner` | `bridge/plugin.ts:1724` | `tokenAuthMiddleware(config.apiToken, …)` + `fcMw("close_runner")`（founder-consent 中间件，生产 DECISION_MODE 默认 off）+ **leadId 必填** + `matchesLead` scope。body `done:true` → `finalizeDone`（FLY-638：`FINALIZE_DONE_SOURCE_STATES = running/awaiting_review/approved_to_ship/design_done` 经 FSM 转 `completed`）→ close → **FLY-369 级联归档**（endpoint 已接 `archive` deps） |

### 1.2 现有 4 条归档触发路径与各自缺口（exploration §2 表，此处不重复）

补充核实：51 条 `chat_thread_archive_failed` 审计（`session_events` 表）全部 `reason=missing/status=404`（已删旧 thread），**零** token/unauthorized/exhausted 失败 → 35 个积压从未进入过归档流程。

### 1.3 数据模型

- `chat_threads(thread_id PK, channel_id, issue_id, lead_id, created_at, discord_missing_at, archived_at, …)`，`UNIQUE(issue_id, channel_id)`（`StateStore.ts`）。
- `issue_id` 现实形态混杂：identifier（`FLY-980`）**和** UUID（历史行，FLY-270 canonical-key 修复前）。审计事件里两种都出现过。
- **无**「枚举未归档 issue thread」的方法（只有 `getUnarchivedPhaseChatThreads` 针对 FLY-793 side-table）→ 交付 2 需新增。
- StateStore = sql.js：内存库 + `save()` 全量 export 落盘。**Bridge 运行时外部直写 DB 文件必被 clobber**（FLY-663 记录）→ 一切写操作走 Bridge 进程内。

### 1.4 Linear 查询能力

- `lookupLinearIssueByIdentifier(linearApiKey, id)`（`bridge/linear-query.ts:196`）：GraphQL `issue(id:)` 单查，10s timeout，not-found → null（不 throw）。**Linear 的 `issue(id:)` 同时接受 identifier 和 UUID** → 一个函数覆盖 chat_threads 两种 key 形态。返回 `stateType`（`"completed"` = Done 类，`"canceled"` = Canceled 类）。
- API key：全局 `config.linearApiKey = process.env.LINEAR_API_KEY`（`config.ts:155`），无 per-project key。GEO/FLY/LEARN 同一 workspace，单 key 覆盖。
- FLY-369 Codex R1 #1 教训已内化：**逐候选直查**（无截断），不用 `queryLinearIssues` bulk（limit 截断无 cursor）。这也正好满足本票「绝不用缓存 list」硬约束。

### 1.5 Liveness / husk 判定原语

- `getTmuxTargetFromCommDb(executionId, projectName)`（`bridge/tmux-lookup.ts`）：CommDB 无 target = tmux 已亡。
- `probeRunnerProcessLiveness(tmuxWindow)`（crash-reaper 在用，`plugin.ts:3821`）：pane 进程级存活探测。
- 判定链：active-status 行 → 无 target ⇒ 死 husk；有 target → probe ⇒ 活/死。**真活着的一律不碰**（FLY-117 红线 + Lead gate 确认②；runner lifecycle 是 Lead 权限，sweep 绝不杀活进程）。

### 1.6 Boot sweep / 周期任务挂载惯例

- Boot one-shot 惯例（`plugin.ts:3952` 起连续三个）：FLY-172 marker drain → FLY-892 `reconcileLegacyPhaseThreads` → FLY-324 done-but-running sweep。统一形态：`try { await … } catch { console.error(非致命) }`，不阻塞 boot，幂等（处理过的行自然掉出候选集）。
- 周期循环现状：GatePoller（3s tick + 20-tick piggyback 巡检）、HeartbeatService、RunnerIdleWatchdog（30s）、xiaohongshu-scheduler。低频（小时级）任务先例少 → 新 sweep 用独立 `setInterval`（小时级、成本可忽略）比挤 GatePoller tick 数学更直白。
- Env flag 注册惯例：`packages/config/src/feature-flags/registry.ts`（`envVar:` 条目，FLY-1091 动态 flag 控制台读它）。

### 1.7 close 级联的 husk 死锁细节（B 类根因）

`closeRunner` 关 completed 行时，级联 `maybeArchiveThreadOnClose` 检查「同 issue 无其它 active」——husk（awaiting_review/approved_to_ship，进程早死）**永远算 active** → 归档永久被拒，且不会重试（close 是一次性事件）。husk 还连带 FLY-560 标题误显「🔴受阻」（task #140）。FLY-742 的 stale-blocker guard 只在**下一次 run-start 409 碰撞**时才清 husk——从没有下一次 run 的 Done issue 永远清不到。⇒ sweep 的 husk-finalize（复用 `closeRunner({done:true})` 语义）是对 B 类的根治，非绕过。

## 2. 生产取证汇总（2026-07-10, read-only）

35 个未归档 `FLY-%` thread（channel `1516209714097291335`）分类见 exploration §3（A terminate-only ~8 / B husk-blocked ~7 / C never-closed ~9 / D blocked-preserve ~5 / E active 必须跳过 ~4）。四类泄漏没有共同触发点可修 → 结构性兜底 = reconcile sweep（Lead gate 确认③）。

FLY-980 特例：Tadashi 手动 Discord PATCH + 直写 `archived_at`（今晚）。直写可能被 Bridge export 冲回 NULL → 该行可能重新出现在候选集。幂等处理天然覆盖：fresh Linear = Done → endpoint 归档 → Discord 侧已 archived 的 PATCH 幂等成功 → 正确重写 `archived_at`。

## 3. 历史决策与红线（谁说的、在哪）

| 约束 | 来源 |
|------|------|
| 归档一律走 Bridge 内 sink，token 绝不出 Bridge 进程 | FLY-369 plan §0（Tadashi 安全硬约束）+ 本票 gate 确认① |
| 绝不归档 active issue 的 thread（藏活 = 事故） | FLY-117 家族 + Annie 在本票 issue 原文 + gate 确认② |
| 逐 issue fresh 查 Linear，绝不用缓存 list | 本票 issue 原文（Tadashi 亲测缓存污染 protect-set） |
| archive-once：`archived_at` 记过永不再扫（尊重 Annie 重开）；安全网 = Discord auto-unarchive | FLY-369 plan §2.1 + gate 确认④ |
| 「Done 即归档」，不加静默期（env 留可调，默认 0） | FLY-369 演进记录（Annie 拍板去掉 24h inactivity）+ gate 确认④ |
| auto-poll-on-Linear-Done 曾被否 → 本票 Annie 明确要求 sweep 兜底 = 政策更新 | FLY-369 plan 演进记录 (a)→(d) vs FLY-1165 issue 原文交付 2 |
| 交付 1 立刻跑（实现阶段先做），交付 2 停 ship gate 等 Annie，不 ship 不 merge | 本票 gate Lead 回复 |
| 多 PR 攒批重启；sweep 上线 = merge 后下次自然 Bridge 重启 | memory（batched Tier-3 restart 惯例） |

## 4. 设计要点结论（供 plan 直接引用）

1. **交付 1 = 操作脚本 + 报告**：sqlite `mode=ro` 枚举候选 → 逐 issue fresh Linear `issue(id:)` → Done/Canceled → `POST /api/chat-threads/archive`；Done issue 的死 husk → `POST close-runner {done:true}`（先 finalize 后归档，一并修标题误显）；active/查询失败 → 跳过 + 记录。间隔 ≥1s 防 429。
2. **交付 2 = `bridge/done-thread-reconcile.ts` 新模块**：boot 一次 + `setInterval`（默认 360min，`FLYWHEEL_DONE_THREAD_RECONCILE=0` 总开关、`…_INTERVAL_MIN` 调周期、`…_DRYRUN=1` 只记不归档），双票 gate（本地无活 runner + fresh Linear Done/Canceled），死 husk 经 `closeRunner({finalizeDone:true})` FSM-legal 收尾（**不带 archive deps，归档由 sweep 统一做一次**，避免双写竞争），每轮 cap（默认 25）+ 500ms 间隔。新 StateStore 方法 `getUnarchivedIssueChatThreads()`。
3. **不改** FLY-369 close 级联/post-ship/crash-reaper/FLY-742 guard 任何现有行为（即时路径原样保留；sweep 纯增量兜底）。`blocked/failed` 的 session 行不做状态流转（不属于 FINALIZE_DONE 源态，也不挡级联）——只归档其 thread。
4. **QA slot Bridge 注意**：test-slot Bridge 有独立 StateStore/bot token，但 sweep 会打真 Linear；529 Room 测试脚本应显式 `FLYWHEEL_DONE_THREAD_RECONCILE=0`（写进 plan 的测试节）。
