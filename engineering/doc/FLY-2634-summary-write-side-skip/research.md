# FLY-2634 summary 写侧省量 — 调研
Issue: FLY-2634 (https://linear.app/geoforge3d/issue/FLY-2634/summary写侧省量-无实质变化不生成周期摘要避免唤醒-lead-只为交空报告)
日期: 2026-09-16
基于: exploration.md

本文回答「方案 A 落在哪些代码接缝上、每个接缝的现状事实、以及 Codex 评审会咬的边界」。全部行号以当前 checkout（`b2f0c3e61`）为准。

## 1. 第一拍的接缝：`summary-absorption-rider.ts`

| 位置 | 现状 | 本单改动点 |
|---|---|---|
| `runSummaryDueFirstBeat` 第一段 `rows.length === 0` | 只看 `summary_due` 行 | 幂等判据改为「本 slot 既无 `summary_due` 行也无 `summary_due_skipped` 行」 |
| `producers.map(...)` 构造 payload | 每人一行 due | 先对每个 producer 跑探针；`quiet` ⇒ skipped 行，`active/unknown` ⇒ due 行，**两组行同一事务写入** |
| `deps.listSummaryPulls()` 快照① | 无条件调 gh | v4 最终口径：flag 开时每 slot 在事务前恰调一次（due 行的 `last_delivered` 在事务内需要它）；flag 关时与今天相同（plan §2.3 / G13） |
| enqueue 循环 | 对每一 due 行 | 不变；skipped 行永不 enqueue |
| `settleSummarySlot` `dueJournalRows.length === 0 ⇒ return null` | 无 due 行就不结算 | 改为「due 行与 skipped 行都为空才 return null」；有 skipped 行也要冻结 `summary_slot_settled` |
| `buildRayaRound` 无条件 | 每 slot 一轮 | 增加「本轮无可吸收内容且无机制故障 ⇒ 不建轮」判据（见 §5） |
| `SummaryAbsorptionPassDeps` | 无探针依赖 | 增加 `probeActivity(producer, window)` 与 `activityGateEnabled()`（call-time flag 读取，与 `cadenceMs()` 同款） |

`createSummaryAbsorptionPass` 的单飞、grace（`min(30min, cadence)`）、两个候选 slot 结算、`missedSlots/degradedSlots` 全部不动。

## 2. 活动探针：三源与「未知」

### 2.1 来源 A · StateStore `lead_events`

- 表结构 `StateStore.ts:6774`：`lead_id, event_id, event_type, payload, session_key, delivered_at, …, created_at`。`created_at` 由 SQLite `datetime('now')` 写入，格式 `YYYY-MM-DD HH:MM:SS`（UTC，无 `Z`），已用 `summary_due` 行的 `2026-09-16 12:00:07` 对照 mailbox 的 `2026-09-16T12:00:07.000Z` 证实同一瞬间。
- 已有 `countLeadEvents(leadId, eventType)`（`StateStore.ts:21074`），没有按时间窗的计数。需新增 `countLeadEventActivity(leadId, fromMs, toMs, decisionSeq, contiguous)`（plan §2.2），只在 `appendSummaryDecisionRows` 的事务回调内调用：StateStore 是 Bridge 进程内唯一写连接，`db.transaction` 同步执行，计数与本轮判定行插入之间不可能有其它 `lead_events` 插入，所以 A 源游标就是上一判定行自身的 seq（`summary_due` / `summary_due_skipped` 不在归档白名单，永远可找到），不需要锚（Codex R3 #1）。`created_at` 可能出现 19 / 23 / 24 位三种写法（`sessions` 已证实混用，`lead_events` 目前 79512 行为 19 位、6 行为 24 位），归一表达式 `CAST(strftime('%s', col) AS INTEGER)*1000 + CAST(substr(strftime('%f', col),4,3) AS INTEGER)` 已在 sqlite3 上对三种格式与 `.500` 边界实测正确（v2 订正：不再截到 19 位）。参数化，`excludedTypes` 用占位符展开。
- **观测水位**：`seq INTEGER PRIMARY KEY AUTOINCREMENT`；唯一的 `INSERT INTO lead_events`（`StateStore.ts:20798`）不传 `created_at`，由 `DEFAULT (datetime('now'))` 写入；`idx_lead_events_dedup ON (lead_id, event_id)` 唯一索引。归档：`terminal-row-archive.ts` 把 `LEAD_EVENT_TYPES`（session_* / detection_* / runner_* / zombie / rate_limit / park 等 19 种）与 `audit_only` 行在 7 天后移入 `workflow_terminal_archive`，其它类型（含全部 summary 行）不归档。
- **生产事件类型全集（2026-09-16 只读快照，30 天）**：runner_question 13639、stage_changed 7367、gate_question 2737、workflow_engine_escalation 2246、founder_reply 2043、patrol_tick 1306、session_started 516、summary_due 396、workflow_claim_recorded 394、mailbox_dead_letter 362、session_monitoring_reestablished 287、workflow_replacement_eligibility 249、inbox_loop_stalled 244、action_executed 131、session_zombie_detected 110、quota_switch_confirmation 63、session_monitoring_lost 45、summary_slot_settled 36、delivery_dead_letter 19、epic_intake 16、session_failed 10、review_job_failed 8、summary_absorption_round 5、session_stale_completed 3、usage_limit 1、flag_scan_no_clock 1。静默 Lead 里只有 belle-lead 有少量业务事件（09-15 前 founder 对话所致），mufasa-lead 的 234 条 `inbox_loop_stalled` + 19 条 `delivery_dead_letter` 全是投递机制噪音。
- **分类表（显式常量，测试钉死；v4 两分：噪音 / 业务，逐条见 plan §2.1）**：噪音 = 摘要机制、钟、配额、投递与监控周期状态、按类型就是周期提醒 / 汇总的 `checkpoint_park_nudge` 与 `zombie_session_backlog`；业务 = 其余已知类型，**阻塞类事件逐条算**（v3 曾设 episode 去重，Codex R3 #2 指出 `session_key` = `buildSessionKey()` = `flywheel:<issue>` 是 issue 级键、且首条会随 7 天归档消失，任何去重都不可证明 ⇒ 取消）；**表外类型默认算活动**（未知 ⇒ 唤醒）。`session_key` 在这些类型上全部非空（30 天快照：runner_question 13639/1193 个 key、session_zombie_detected 110/71、session_started 516/107，NULL 为 0），机制噪音类（`mailbox_dead_letter`、`inbox_loop_stalled`、`delivery_dead_letter`）session_key 全为 NULL。
- 上一 slot 的 `summary_due` 行创建于 `prevSlot + ε`，落在本窗口内，所以钟事件必须在噪音清单里，否则每个 Lead 永远 active。

### 2.2 来源 B · StateStore `sessions` —— v3 已放弃

- 列：`project_name, status, started_at, last_activity_at, terminal_at, heartbeat_at …`。写入方式不统一：`terminal_at = datetime('now')`（19 位）、`last_activity_at = datetime(?/1000,'unixepoch')`（19 位）、`last_activity_at = ?`（ISO `Z`，24 位）、`started_at` 多为 23 位。
- 现有窗口查询 `listCompletedSessionsWithPrSince(projectName, sinceTs)`（`StateStore.ts:15240`）用字符串 `>=` 比较混合格式，不复用。
- **v2 订正（Codex R1 #2）**：`last_activity_at` 被十余处 `UPDATE` 覆盖；`terminal_at` 可被置 NULL 再重设（`StateStore.ts:11592`）。
- **v3 放弃（Codex R2 #2）**：两条 UPSERT 都是 `started_at = COALESCE(excluded.started_at, started_at)`（`StateStore.ts:11396` / `13195`）—— 调用方给新值时新值优先，不是存储层 set-once；表主键是 `execution_id TEXT`，隐式 `rowid` 会被 `VACUUM` 重编号，不是持久游标。Runner 派出 / 完成 / 失败改由 lead_events 的 `session_started`（30 天 516 条，`session_events` 同期 591 条，差额是无 Lead 的项目与测试槽）、`session_failed`、`stage_changed` 感知。
- 备选 `session_events` 表已排除：它是 Bridge 全项目的机制日志（30 天 191 万行 `codex_app_server_orphan_identity_mismatch`、3 万行 `lifecycle_sweep_worktree_skip`，静默项目每天也有几十行），噪音远大于信号。

### 2.3 来源 C · 每项目 CommDB `mailbox`

- 路径 `commDbPathForProject(projectName)`（`bridge/commdb-path.ts`），只读打开 `CommDB.openReadonly(path)`（`db.ts:1255`，跳过 schema 创建、`busy_timeout=5000`、校验 mailbox generation）。patrol orphan sweeper 已按此模式逐项目只读打开（`plugin.ts` `readActiveTargets`）。
- 作者身份就在列上：`discord-chat-ingest.ts:177` `fromAgent: founder ? "founder" : \`discord:${authorId}\``；`to_agent = leadId`，`recipient_kind='lead'`，`type='discord_chat'`，`created_at` 为 Discord 消息 `ts`（ISO `Z`）。
- 判据（v3）：`to_agent = ? AND recipient_kind='lead' AND type='discord_chat' AND (from_agent = 'founder' OR (from_agent LIKE 'discord:%' AND from_agent <> 'discord:<recipientBot>' AND instr(content, '<@<leadBot>>') > 0))` 加游标谓词。`bridge`、runner UUID 的 `question`、`ack_batch`、未 @该 Lead 的 bot 闲聊、Raya 的任何消息 **都不计**。
- 归档（**v2 订正，Codex R1 #3**）：`MAILBOX_RETENTION_MS = 72h`（`mailbox-queue.ts:261`）；终态行在 `terminal_at` 72h 后移入 **`mailbox_terminal_archive`**（`mailbox-schema.ts:79`：`id, delivery_id, terminal_at, archived_at, mailbox_json`（可为 NULL）、`logs_json`、`payload_sha256`），不是同列副本，不能 UNION。七个项目库实测都有 `mailbox_terminal_archive`；legacy `mailbox_archive` 只在 flywheel 库残留。本单**不读任何归档表**：由于 `terminal_at ≥ created_at`，`created_at ≥ now − 72h` 的行一定还在热表；plan §2.1 要求窗口与上一水位都落在 72h − 2h 内，否则该源 `unavailable`。
- **观测水位**：`mailbox.seq INTEGER PRIMARY KEY AUTOINCREMENT`（`mailbox-schema.ts:194`）。`created_at` 是 Discord 消息原始 `ts`（`discord-chat-ingest.ts:186`；`founder-reply-deliverer.ts:561` 同样用 `msg.timestamp`），所以 Bridge 停机后补 ingest 的旧消息会带旧时间戳晚到 —— 由 `seq > 水位` 子句兜住。
- 新增 `CommDB.readMailboxActivity({ leadId, leadBotUserId, recipientBotUserId, senderBotUserIds, fromIso, toIso, allocatedSeq, contiguous })`：单条语句同时返回 count / `sqlite_sequence` 分配序号 / `mailbox_migration_meta.(schema_generation, completed_at)` 实例标识（Codex R2 #5：两条 SELECT 之间项目自己的 Bridge 可能插入；R3 #1：热行 72h 后被 `archiveFamily` 删除，`max(seq)` 会回退到 0 而 `sqlite_sequence` 不会——sqlite3 实测；`mailbox_migration_meta` 由 `MAILBOX_CORE_SCHEMA` 在建库时 `INSERT … ON CONFLICT DO NOTHING` 写入一次，`completed_at` 就是该库文件的出生时间戳）。`openReadonly` 抛错（文件缺失、generation 不符、`no such table: mailbox`）⇒ 该源 `unavailable`。
- **@派活消息（Lead 裁定 ca00b87c）**：`content` = `[discord-chat-delivery v1] {json}\n<author>: <text>`，Discord 原文中的 `<@botUserId>` 原样保留（geoforge3d 库近 7 天 89 条 bot 消息里 40 条含 `<@`；growth 19/6；joycon 11/3）。信封没有独立的 mentions 字段，所以用 `instr(content, '<@' || leadBotUserId || '>')`。每个 Lead 的 `botUserId` 与 summary 收件人（`summaryRole === "recipient"`，Raya = `1542068543645024257`）都在 `projects.json` 的 `leads[]` 上。`assertMailboxGeneration` 只校验常量 `schema_generation`，识别不了同版本库被替换 —— 所以游标带 `completed_at` 实例标识，并检查分配序号回退。`LeadConfig.botUserId` 在 `ProjectConfig.ts:46` 是可选字段；`discord-chat-ingest` 把所有非 founder 作者（含普通用户、非 Lead bot）都写成 `discord:<authorId>`，所以发信人要按已配置 Lead bot 白名单限定，缺 id 时该源 unavailable（Codex R3 #4）。

### 2.4 来源 D · Linear（Lead 裁定 ca00b87c 加入）

- 绑定：`ProjectEntry.linear = { team, project?, label? }`。本机 `projects.json` 只有 flywheel 绑定（`FLY / Flywheel / Flywheel`）；geoforge3d、joycon-typeless、personal-assistant、growth、tidal-echo、raya 都是 `None`。
- 既有扫描：`scanEpicIntakes`（`epic-intake.ts`）→ `collectEpicScope`（`linear-epic-query.ts:318`）过滤 `parent: { null: true }` 且 `updatedAt ≥ lastSuccessfulScanStartedAt − 120s`，只拉 epic 根；`fetchLinearActiveScopeSnapshot` 再按根拉子树，按需（intake / dependency / lead-note / residual）触发，不是每 tick 全项目。它们看不到「founder 改一张非 epic 子 issue 的 state」。
- `linear_state_observations` 是 (project, issue_uuid) 的 upsert 投影，只由 `done-thread-reconcile.ts` 对有 done thread 的 issue 写，非 append-only、覆盖不全。
- 所以 D 用一次 team 范围内的 `issues(filter: {team, updatedAt: {gte: from}}, first: 50, includeArchived: true)` + 每张 `history(first: 25)`，判 `createdAt ∈ [from,to)`（新建）或 history 里 state / parent / priority 的变化（外层不加上界、不按 project/label 收窄，Codex R3 #3）；复用 `linear-epic-query.ts` 导出后的 `createLinearRequest`（原 file-local `createEpicRequest`，deadline 20s、zod）。零命中不是证据（删除 / 移出 team / 延迟可见性无审计流）⇒ `unavailable: linear_zero_unprovable`，绑定项目本版永不 quiet（Codex R4 #1）。字段名以实施时一次 `__type(name:"IssueHistory")` 内省为准；Context7 的 Linear API 文档确认 `issues(filter: IssueFilter, first, after, includeArchived)` 与 `IssueFilter.updatedAt` 比较器，未直接给出 `IssueHistory` 字段清单。

### 2.5 探针合成规则

```
每源结果: { status: "ok", count } | { status: "unavailable", reason }
active  := 任一源 ok 且 count > 0
quiet   := lead_events 与 mailbox 皆 ok 且 0，且 linear 为 ok/0 或 not_bound（v4；lead_events 的计数在写判定行的同一事务内完成）
unknown := 非 active 且任一源 unavailable
```

只有 `quiet` 跳过。探针结果（每源 status/count/reason、窗口、噪音清单版本号）原样写进 skipped 行或 due 行的 payload，供结算与 QA 回放。探针异常整体捕获 ⇒ `unknown`，并 `log` 一行。

窗口 = `[slotStartMs − cadenceMs, slotStartMs)`，以 epoch 毫秒计算，与 `period`（founder 本地时区渲染，`config/founder-timezone.ts`，默认 `America/Los_Angeles`）是同一对瞬间。

## 3. 日志与结算：StateStore 与 `classifyRound`

### 3.1 新行 `summary_due_skipped`

- `lead_id = <lead>`，`event_id = summary_due_skipped:<project>/<lead>:<slotISO>`，`event_type = summary_due_skipped`，`session_key = summary-due`，`delivered_at` 永远 NULL（与 `summary-clock` 行同类）。
- `appendSummaryDueRows` 扩为接受 `{ leadId, eventId, payload, eventType }`，事务语义不变（`StateStore.ts:20833` 现已是 `db.transaction`）。
- `listSummaryDueRows(slot)` 的 LIKE 前缀 `summary\_due:%` 不会匹配 `summary_due_skipped:…`（`due` 后紧跟 `:`），且 `event_type` 过滤已隔离；新增 `listSummaryDueSkippedRows(slot)` 同款实现。
- 归档白名单（`terminal-row-archive.ts:43` `LEAD_EVENT_TYPES`）不含任何 summary 行，新行同样不被收走。体量 ≤11 行/slot，与 FLY-2382 L7 同一量级，本版不扩白名单。
- `listUndeliveredLeadEvents` 在 StateStore 外无生产消费者（grep 证实），`delivered_at` 永空的新行不会被任何 redrive 捡起。

### 3.2 `classifyRound`

- 输入增加 `skippedRows: SummaryDueRoundRow[]`；输出 `SummaryRoundResult` 增加 `skipped: string[]`、`producers[].disposition: "due" | "skipped_no_activity" | "skipped_but_delivered"`、`producers[].period`、`skipped_count`、`skipped_delivered_count`、`open_unread_count`、`roster_count`（plan §2.4 组合表）。
- skipped 的 producer：不进 `absent / undelivered / delivery_unknown`，不参与 `delivered_count / producer_count` 的分母（`producer_count` 仍 = due 行数，保持旧语义；另加 `roster_count`）。
- `report_line` 末尾追加 `无变化跳过:<names>`。它是内部诊断；FLY-2619 的 `assertSummaryPresentationVisibleText` 只拦 founder 可见正文，不影响。
- 若某 Lead 在 skipped 名单里却在 gh 账本中出现本 period 的 PR（Lead 自己算出 period 主动交了）：`disposition` 记 `skipped_but_delivered`，只增 `skipped_delivered_count`（**不动** `producer_count` / `delivered_count`，v2/v3 订正），不报错、不告警 —— 主动交付永远受欢迎。

### 3.3 `settleSummarySlot`

- 冻结行 `summary_slot_settled` payload 多带 `skipped / skipped_count / raya_round: "issued" | "not_issued"` 与 `not_issued_reason`。
- `frozenRoundFromRow` 校验扩到新字段；**旧冻结行缺新字段视为 `skipped: []`**（部署前的 slot 仍可重放）。

## 4. Lead 侧呈现：`hook-payload.ts`

- `HookPayload.summary_due` 增加可选 `activity?: ActivityProbeResult`（plan §2.1：`verdict`、`window`、`probe_version`、`previous_decision_at`、`sources.{lead_events, mailbox, linear}`、`cursors.mailbox`）。
- `formatSummaryDue` 在 `上次交付:` 之后加一行 `本窗口观测: 业务事件 N · founder/派活消息 N · Linear 变动 N`（unavailable 渲染 `不可得`、not_bound 渲染 `未绑定`）；数值经 `Number.isSafeInteger` 白名单，reason 经 `summaryDueReason` 同款清洗。
- 第 3 条文案改为 plan §2.5 的版本。
- `mailbox-lead-runtime.ts:231` / `commdb-lead-runtime.ts:106` 只是分派，不改；`summary-due-render.test.ts` 的 parity 用例要覆盖新行。

## 5. Raya 侧：何时不建轮

`buildRayaRound` 现在对每个成熟 slot 无条件出轮。新判据（在冻结结果上、纯函数、可单测）：

```
issueRayaRound(result) :=
     result.round_ledger === "unavailable"
  || result.delivered_count > 0
  || result.skipped_delivered_count > 0      // v2：skipped 后主动交付
  || result.open_unread_count > 0            // v3：账本里任何 OPEN 的 summary PR = Raya 未读
  || result.undelivered.length > 0
  || result.delivery_unknown.length > 0
```

即：有 PR 可吸收（含主动交付与晚交补收）、或账本不可得、或有投递故障/未知 ⇒ 照旧出轮；**只有「0 张可吸收、账本正常、无投递问题」才不出轮**（此时 `absent` 可能非空 —— 被叫醒但沉默的 Lead —— 这是 §6.3 允许的沉默，Raya 无事可做）。

**晚交与 Raya 消费链事实（v3，Codex R2 #4 / #6）**：`flywheel-comm summary`（`commands/summary.ts` `runSummaryCommand`）只创建 / 更新 GitHub PR，不向 StateStore 写任何交付事件；分支名 `summary/<project>/<author>/<sha256(project,author,period)[0:16]>`（`summary-contract.ts:45`）。`listSummaryPulls` 是 `gh pr list --state all --limit 500`，只保留匹配 `SUMMARY_BRANCH` 的分支，含 OPEN / MERGED / CLOSED。Raya 侧：`formatSummaryAbsorptionRound`（`hook-payload.ts:373`）刻意不渲染任何 producer / PR，`summary_presentation begin` 返回的 members 也不带 PR；Raya 的未读队列是她自己轮首的 `gh pr list`（FLY-2131 plan §2.4「gh pr list = 未读队列」；`summary-inflow.md` 首段「open PR = unread, merge = read receipt」）。因此「账本里有 OPEN 的 summary PR」就是「Raya 有未读」的精确等价，建轮判据用它即可，不需要收养回执。`appendLeadEvent` 对重复 `event_id` 返回既有 seq（`StateStore.ts:20826`），`admitRound` 是 `ON CONFLICT DO NOTHING`，所以每 pass 重放 pendingRounds 是幂等的。

- 不出轮 ⇒ 不写 `summary_absorption_round`、不 `admitRound`；`summary_presentation_rounds` 没有该 slot 的行。FLY-2619 的 stale 判定（`summary-presentation-store.ts:943`）只看 group 的 `last_progress_at_ms` 与 migration，不要求 slot 连续，不会因此告警。
- `undelivered` 告警（`formatSummaryVisibleFailureAlert`）仍在 `settleSummarySlot` 里独立触发，与出轮与否无关。
- `degradedSlots`（无 Raya）逻辑不变。

## 6. Kill-switch flag

- 注册表 `packages/config/src/feature-flags/registry.ts`：`name: "summary_due_activity_gate"`，`category: "kill_switch"`，`source: "env"`，`scope: "bridge_global"`，`envVar: "FLYWHEEL_SUMMARY_DUE_ACTIVITY_GATE"`，`polarity: "default_on"`，`valueKind: "bool"`，`onMeans: "enables"`，`default: true`，`readSites: [flagStoreSite("packages/teamlead/src/bridge/plugin.ts","startBridge","storeSummaryDueActivityGateEnabled")]`，`toggleable: "direct"`，`directToggleProof` 指向 `flag-store-runtime.test.ts` 的新用例。`whenOn` 与 `description` 是 founder 可读中文（FLY-2368 审过的文案守卫）。
- `store-policy.ts:157` 的 `defaultOnCodec` 名单加入该 name；`flag-store-runtime.ts` 加 `storeSummaryDueActivityGateEnabled(runtime) = readBoolean(runtime, "summary_due_activity_gate")`。
- 现有 registry 测试要求：名字唯一、env flag 有 envVar、bridge_global、至少一个 readSite 且 timing hot、direct toggle 有 proof、on-means 显式、founder 文案非空；drift-scan 要求 `FLYWHEEL_SUMMARY_DUE_ACTIVITY_GATE` 的读取只经 flag store。
- 关掉 ⇒ 探针不跑、不写 skipped 行、行为与今天逐字节相同；打开是默认。行缺失时按 env/registry 默认播种（`flag-store-runtime.ts:53` 同款）。

## 7. 规则文本：`lead-rules-base/summary-inflow.md`

"The due signal (FLY-2382)" 段追加一小节（`lead-rules-bundle.test.ts:220` 的字面断言保持不变，另加新断言）；最终文案以 plan §2.7 为准：

- Bridge 只在本 period 观测到 founder 消息、@你的派活消息、业务事件或 Linear 变动时才发 `[summary_due]`；没收到不是投递故障，也不是职责被取消。
- 收到时只写增量：没变的暂停/阻塞不复述；摘要 PR 本身、Raya 对摘要的审阅提问、本机制的对账不算本 period 的事实；「有 Runner 跑过」「有 commit」本身也不是增量。
- 一次性请求（例如项目全景基线）仍由发起方的消息触发，与节奏无关，也不产生周期义务。

## 8. 测试基座事实

- rider 测试 `bridge/__tests__/summary-absorption-rider.test.ts`：deps 全 `vi.fn`，`cadenceMs` 用数组 shift 模拟热切；新增探针 dep 可同样 mock。现有 16 个 `it` 必须全绿（其中 "materializes and enqueues the producer roster during the first beat even without Raya" 要在 `probeActivity` 默认返回 `active` 下继续成立）。
- `summary-round-classify.test.ts`：纯函数用例，加 skipped 输入。
- `StateStore.summary-due.test.ts`：事务原子性、LIKE 前缀隔离；加 skipped 行 + 三种时间戳格式的窗口计数正例/反例。
- `summary-due-render.test.ts`：Mailbox/CommDB 两 runtime 逐字 parity。
- CommDB 新方法：`flywheel-comm` 的 db 测试用真实 better-sqlite3 建表；补「founder vs discord:<id>」正反例、「旧时间戳晚 ingest 经 seq 水位计入」、「`mailbox_terminal_archive` 里 `mailbox_json` 为 NULL 的行不影响」。
- 529 房各 slot Lead 写死 `summaryRole=exempt`，开箱测不到 summary duty（runner memory 已记）；真机证据只能在部署后用只读快照读 `lead_events`。

## 9. 证据口径（写进验收，供 QA 逐字复用）

只读快照：`sqlite3 ~/.flywheel/teamlead.db "VACUUM INTO '<tmp>'"`（活库不可逐字比对）。

```sql
-- 每 slot：叫醒数 / 跳过数 / 交付数 / Raya 轮数
SELECT substr(event_id, instr(event_id, ':20') + 1) AS slot,
       sum(event_type = 'summary_due' AND delivered_at IS NOT NULL) AS lead_wakes,
       sum(event_type = 'summary_due_skipped')                        AS skipped
FROM lead_events
WHERE event_type IN ('summary_due', 'summary_due_skipped')
GROUP BY slot ORDER BY slot DESC LIMIT 8;

SELECT event_id, json_extract(payload, '$.delivered_count'), json_extract(payload, '$.skipped_count'),
       json_extract(payload, '$.raya_round')
FROM lead_events WHERE event_type = 'summary_slot_settled' ORDER BY seq DESC LIMIT 8;

SELECT count(*) FROM lead_events WHERE event_type = 'summary_absorption_round'
  AND created_at >= '<deploy-time>';
```

基线（2026-09-09 → 09-16，27 slot）：`lead_wakes` 10–11/slot、`skipped` 0、交付 3–5/slot。Raya 轮（**v2 订正**）：`summary_absorption_round` 自 2026-09-15 Raya 激活起才出现，之后每个已结算 slot 一轮（09-15 3 settled / 2 rounds，09-16 3 / 3）；09-15 前 `resolveRaya` 为空、走 `degradedSlots`。目标：静默项目 `lead_wakes` 归零、`skipped` 7–8/slot、活跃 Lead 逐 slot 交付样本不变、无可吸收内容的 slot 的 Raya 轮为 0。逐验收格的查询与预期基数见 plan §6 / `evidence.sql`；本节三条 SQL 只是总览。token 数本身在 Bridge 里不可得（Claude TUI Lead 无用量账本）；唤醒次数是 token 的直接驱动量，QA 以它为准，并可抽样一个静默 Lead 的会话观察其 6h 内无新 turn。

## 10. Codex 评审预判（v1 直接写进 plan 的点）

1. 未知 ⇒ 唤醒，每源逐一有 unavailable 语义；整体异常兜底。
2. 噪音清单是常量 + 测试；默认方向是「未知类型 = 活动」。
3. 三种时间戳格式的归一在 SQL 里做，正例反例各钉一条；不复用字符串比较的旧查询。
4. 跳过行与 due 行同一事务；幂等判据同时看两类行；崩溃窗口：探针→事务→enqueue，各自可重放。
5. 结算四态；skipped 不进任何告警；主动交付的 skipped Lead 记 `skipped_but_delivered`。
6. Raya 不出轮的判据是纯函数且保守（任何机制异常都照旧出轮）。
7. 旧冻结行缺新字段可读；flag 关闭 = 逐字节旧行为。
8. 规则文本与渲染文案同步，bundle 测试字面断言不破。
9. 明确不做：git 探针、Lead 侧无更新回执、cadence 改动、历史回填、`sessions` 表来源、episode 去重、晚交收养回执（Linear 探针按 Lead 裁定已加入）。
