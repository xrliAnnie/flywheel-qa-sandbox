# FLY-2143 Epic 页面活化 — 实施说明
Issue: FLY-2143 (https://linear.app/geoforge3d/issue/FLY-2143/2108d-epic-页面活化事件扫描双路更新过期自报卡住上页可见)
日期: 2026-09-05
基于: plan.md

## 1. 实施边界

实现严格以已批准的 `plan.md`（design head `03b1e6f33`）为输入，没有改动批准计划，也没有增加 flag、配置键、Lead 事件类型、founder 消息、通用 publication 抽象或 Linear webhook。

最终结构保留三条入口但只有一条 attempt 实现：

- event：`EpicPageRefresher` 做 5 秒去抖、单飞行与一次尾随合并；
- scan：既有 patrol 扫描调用同一个 `runEpicPageAttempt`；
- manual：`POST /api/epic-page/generate` 通过同一个每项目 FIFO serializer 生成回执和账本，但不发布固定页。

event/scan 共享 `EpicPagePublisher`、`ReportCriticalSection`、稳定 token 与 `epic_page_refresh` 账本。固定页只在 event/scan 成功时覆盖同一 token；普通 `POST /api/reports/publish` 仍每次生成新 token。

## 2. 数据与 API

### 2.1 StateStore

- 新表只有 `epic_page_publication` 与 `epic_page_refresh`。前者一项目一 token，后者每次 attempt 一行并保留最近 200 行。
- `reserveEpicPageToken` 只创建预留态；`commitEpicPagePublication` 用 project+token CAS 前进成功版本。
- `getNextEpicPageVersion` 与 `insertEpicPageRenderReceipt(expectedVersion)` 在共享 serializer 内防止版本漂移。
- `getEpicPageFreshness` 分开读取 `last_generated`、`last_published`、全局 `last_failure`、发布窗口内 `last_publish_failure` 与失败计数。manual success 不清除发布失败。
- 旧回执迁移仅在迁移路径把缺失的 `generator.reasons` 归一为 `[trigger]`；新写入仍严格校验。
- `upsertSession` 和 `recordEnrolledTerminalSignal` 暴露 `statusChanged`，事件 hook 只在页面相关投影实际改变时触发。

### 2.2 信号

- `CommDB.listEpicPageSignals` 是唯一新增 CommDB 窄读 API：参数化 SQL、`created_at >=`、`LIMIT`、最多 500 个 execution id，先在 SQL 中按完整 execution id+kind 归并。
- DTO 不返回 `content`、checkpoint 或 row id。`runner_stopped` 只允许 `blocked|quota|context_full|error`；`done|awaiting_approval` 丢弃。
- teamlead 用 `CommDB.openReadonly`，在 `finally` 中关闭；缺库、busy、旧 schema 均 fail-soft 为 `commdb_error`。命中输出上界时整源标记 `commdb_truncated`，不把部分集合冒充健康。
- StateStore 只投影 `declared_blocked` 与 `run_held`。第二阶段按 `(execution_id8, kind)` 确定性归并。
- `waiting_founder` 与四类 Lead-owned stuck signal 分流；它可与同 execution 的普通 `question_pending` 并存，但不进入 `stuck_items`/tick stuck 计数。

### 2.3 新 HTTP/CLI 合同

- `GET /api/epic-page/status?projectName=<name>`：master-only，只读 StateStore，不读 Linear。返回 live `freshness`、publication URL（只有已发布 Blob 页才非 null）和 `next_scan_expected_at`。
- `flywheel-comm epic-page status [--project <name>] [--bridge-url <url>]`：原样输出 status JSON。
- 既有 generate 失败的 422/502 响应 additive 地带上 `last_generated` 与 `last_published`。
- 无子命令删除或改名，因此不触发 FLY-1914 CLI sweep。

## 3. §2.9 事件挂点审计

行号基于生产实现 head `a38e22621`；其后只新增测试与文档，生产代码行未再移动。

| reason | 生产挂点（文件:行） | 正向条件 | 负向/幂等守卫与测试 |
|---|---|---|---|
| `session_started` | `DirectEventSink.ts:312` | `upsertSession(...running).statusChanged` | 重放 started 为 false；`DirectEventSink.test.ts` |
| `session_started` | `event-route.ts:1503`, `event-route.ts:1536` | FSM 接受，或 legacy upsert 的 `statusChanged` | FSM 拒绝、重复 running 不挂；`event-route.test.ts` |
| `session_completed` | `DirectEventSink.ts:703`, `DirectEventSink.ts:1081` | generalized terminal result / ordinary upsert 的 `statusChanged` | phase early reject、terminal immunity、重复终态不挂；`DirectEventSink.test.ts`、`StateStore.fly1427-terminal-immunity.test.ts` |
| `session_completed` | `event-route.ts:1220`, `event-route.ts:1254`, `event-route.ts:2253`, `event-route.ts:2342` | canonical generalized non-replay、enrolled terminal statusChanged、FSM 接受、legacy upsert statusChanged | replay、rejected transition、terminal immunity、invalid/no-code early return 不挂；`event-route.test.ts` |
| `session_failed` | `DirectEventSink.ts:1399`, `DirectEventSink.ts:1438` | generalized / ordinary terminal statusChanged | terminal immunity、重复终态不挂；`DirectEventSink.test.ts` |
| `session_failed` | `event-route.ts:1300`, `event-route.ts:2577`, `event-route.ts:2594` | enrolled terminal statusChanged、FSM 接受、legacy upsert statusChanged | rejected transition、重复终态不挂；`event-route.test.ts` |
| `run_started` | `runs-route.ts:2745` | generalized selection 已 materialize 且 `replayed === false`，在其后的任何 launch response 前触发 | materialization 前的 400/409/429 与真正 replay 不挂；`runs-route.dag-entry.test.ts` 覆盖 fresh 200/202/409/429 与 replay |
| `run_started` | `runs-route.ts:3809` | legacy `waitForSession` 得到 durable session 后触发 | ghost start 500 不挂；延迟写 session 的 200 race 有 RED→GREEN；`runs-route.dag-entry.test.ts` |
| `run_resumed` | `runs-route.ts:500` | `resumeWorkflowHold` 成功且非同 request-id replay | 400/403/409 与 200 replay 不挂；`runs-route.run-management.test.ts` |
| `linear_done` | `DirectEventSink.ts:1298`, `event-route.ts:2432`, `event-route.ts:2859`, `merge-ship-gate.ts:575`, `external-merge-reconcile.ts:495`, `plugin.ts:6653` | `makeLinearDoneFinalizer` 只在真实 `updateIssue` 成功返回 `changed:true` 后调用 | already-completed、canceled、失败、`done:false` 不挂；`linear-issue-finalizer.test.ts` 与各 wiring 测试 |
| `dependency_changed` | `dependency-route.ts:1130`, `dependency-route.ts:1279` | add 返回实际 `added`；remove 返回实际 `removed` | replay、not-found/no-op、400/403/502 不挂；`dependency-route.test.ts` |

所有挂点都只调用无抛的 `requestRefresh` 外壳；刷新失败不能改变原事件/路由响应。`plugin.ts` 构造一次 serializer、critical section、publisher、refresher，再把同一个 refresher 注入 sink、event route、runs route、dependency route 与 Linear Done owners。

## 4. `runs-route` 202/200 分支归类

HTTP 状态不是触发判据；以下按对应持久化投影归类。

| 分支（文件:行） | 状态 | FLY-2143 分类 |
|---|---:|---|
| hold resume receipt replay `runs-route.ts:473` | 200 | 同 request-id replay；不挂 `run_resumed` |
| hold resume new result `runs-route.ts:498-502` | 200 | hold 已解除且非 replay 才挂一次 `run_resumed` |
| `/start` workflow-resume cached/recorded response `runs-route.ts:1785`, `:1795` | 200 | resume-admission completion receipt；此处没有解除 hold 或新建 run，不挂 |
| `/start` workflow-resume pending `runs-route.ts:1823`, `:1957` | 202 | admission 已持久化但不是 §2.9 的 hold-resume 投影，不挂 |
| generalized cached start response `runs-route.ts:2847` | 200 | materialization replay；`replayed === true`，不再挂 |
| generalized precommit outcome pending `runs-route.ts:3333` | 202 | 若本请求 fresh materialize，已在 `:2745` 挂一次；replay 不挂 |
| generalized unknown physical evidence `runs-route.ts:3354` | 202 | 同上，response 不改变已经发生的 materialization 事实 |
| generalized release race pending `runs-route.ts:3373` | 202 | 同上 |
| generalized delivery confirmation pending `runs-route.ts:3438` | 202 | 同上；后续同 key 收敛 200 不重复 |
| generalized committed response `runs-route.ts:3543` | 200 | fresh materialization 在 `:2745` 已挂；recovered/replayed 200 不重复 |
| legacy final response `runs-route.ts:3822-3844` | 200 | 只有 `waitForSession` 已证明 session durable 后在 `:3809` 挂；延迟 session 正例已钉 |
| run-management collect pending `runs-route.ts:677` | 202 | hold/terminate 运维响应，不在批准的事件矩阵；不挂 |
| holds/stage/diagnostic/active 的 200 | 200 | 纯读或确认 token，不改变页面相关投影；不挂 |

另外，generalized materialization 之后的 409/429（包括 `DOA_BACKOFF`）也仍由 `:2745` 触发一次；`runs-route.dag-entry.test.ts` 对 fresh 409、fresh 429 及 202→409→200 同 key 收敛分别断言 callback 次数。

## 5. `latest_hold_reason` 词表核实

核实结果：`latest_hold_reason` **不是闭集词表**。

- `WorkflowHoldRow.reason` 类型是自由 `string`（`StateStore.ts:348-353`）。
- `listWorkflowHolds` 在 `StateStore.ts:41182-41183` 取 payload 的自由 `reason`，缺失时才回退到 `HOLD_SHAPE_REGISTRY` 的 descriptor id。
- diagnostic 在 `StateStore.ts:45373` 读取该值，并只写到 closeout invariant / diagnostic 的 `latest_hold_reason`（`:45475`、`:45565`）。
- FLY-2143 页面不读取或渲染它。页面 `run_held` 只有闭集 kind、since、execution id8、provenance、observed_at；没有 `hold_reason` 字段。

因此没有把自由 hold 文本误投影进 JSON、Markdown、HTML 或 tick，也没有另造一套易漂移的 reason 枚举。页面只表达「run 被 hold」这个可核事实。

## 6. 迁移、重启、回滚

- 迁移是 `CREATE TABLE/INDEX IF NOT EXISTS`，可重复打开；新 Bridge 读旧库会建表，旧 Bridge 忽略残留表。
- 账本保留逻辑登记进 FLY-2006 production table fixture；重启后稳定 token、publication 与 refresh history 都来自 SQLite，不依赖进程内缓存。
- 扫描与 event 共享数据库真值；event 的 debounce 状态丢失最多由下一巡检周期补齐。
- PR 整体回滚后固定页停止刷新，残留两表没有旧版本读者且不需破坏性 rollback；Blob 依既有 14 天保留期过期。
- 生产启用前置仍是项目 `linear` binding。按批准计划，当前生产 `projects.json` 缺该 binding，因此本 PR 不改配置、不自动生成首个链接。

## 7. 已知 residue（按批准计划 §9 原样保留，不实现）

- Blob / registry / SQLite 之间不是原子切换；按相位记账并靠同 token 重试收敛。
- hold 创建不触发 event，最多等一个巡检周期。
- hostOverride 不支持 Epic 固定页，记 `skipped_hosting_unsupported`。
- Blob 缓存 60 秒，固定 URL 最多读到上一版字节；页面年龄以 `generated_at` 为准。
- 不做刷新失败横幅重传。
- `freshness.v1` 与 `signals.v1` 仍是未获 founder 裁定的默认规则。
