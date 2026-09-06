# FLY-2143 Epic 页面活化 — 调研
Issue: FLY-2143 (https://linear.app/geoforge3d/issue/FLY-2143/2108d-epic-页面活化事件扫描双路更新过期自报卡住上页可见)
日期: 2026-09-05
基于: exploration.md(同文件夹);Lead 对 Q1 `3608d499` / Q2 `4965e285` 的裁定(逐字引用见 §0)

> 成色:✅ = 亲核(文件:行);📖 = 引自上游文档;⬜ = 未核,进 plan 的 RED 用例;🔶 = 本单建议。所有行号基于分支头 `79f6fc39b`。

---

## 0. Lead 裁定(逐字,2026-09-05)

> **Q1 裁定**:走稳定地址,同意;founder 的习惯就是收藏一个页面当唯一真相,没有固定地址 event 路就没有读者。四条边界:① 每 project 一枚固定 32-hex token,存法用最小结构(一张 epic_page_publication 小表或等价一列即可),不要长成通用『publication』子系统;② report-registry 的『指定 token 重发』只对 Epic 页面开放(显式窄 API + 调用方校验),不要把 allowOverwrite 变成所有报告的通用能力——报告的不可变/不可猜语义(FLY-2283/FLY-2315 的教训)不能被顺手放宽;③ 刷新 = 就地更新 createdAt 与字节,保留期从最后一次刷新起算,且 Epic 仍 active 时不得被 count/bytes 上限淘汰(2315 那类『卡活着页面没了』不许再出现);④ 备选方案不做。研究/计划里把 ②③ 写成验收项。

> **Q2 裁定**:三类信号都做,含 CommDB;边界:① CommDB 只读、单条有界查询(时间窗 + LIMIT),失败 fail-soft 成 missing,永不阻塞页面生成;② 只投影 kind / 时间 / execution_id 前 8 位 / 枚举 reason,沿用 2140 泄漏哨兵,自由文本一律不进页;③ 『卡住』必须和『正当等 founder』分开显示——判据直接复用 FLY-2114 第一层已实测的谓词:该 exec 名下存在 relay_state='protected' 且 checkpoint<>'' 且无 response 子消息的 question ⇒ 显示为 waiting_founder,不算卡住(不加这条会把每张门口的卡都标成卡住);④ patrol_tick 加一行『卡住说了一声的 N 张』可以,⛔ 不发 founder、不建告警器。按此继续。

对裁定的核实:
- Q1③「count/bytes 上限」:registry 已是 **age-only** prune(`report-registry.ts` L423-435 ✅;FLY-2283 milestone ✅「count/bytes eviction 已删除」)。本单不得引入新的上限;验收项 A-③ 反向断言之。
- Q2③ 谓词:`relay_state='protected'` 由 `CommDB.markQuestionProtected(questionId, logicalEventId)` 写入(`db.ts` L2140-2150 ✅,只对 `type='question'` 且未终态的行);`checkpoint` 列在 `mailbox_message_projection` 上可查(`getPendingGatesByRunner` L3690-3703 ✅)。谓词可直接用一条 SQL 表达(§4.3)。
- 「FLY-2114 / FLY-2315」:仓内无同名 milestone 或 doc 文件夹(`ls engineering/doc | grep -E "2114|2315"` 空 ✅);本单按 Lead 原话执行,不转述其内容。

---

## 1. 代码地图(本单要碰的每一处)

| 区域 | 文件:行 | 今天 | 本单动作 |
|---|---|---|---|
| 内容模型 | `packages/teamlead/src/epic-page/model.ts` L104-166(`EpicItem.signals: []`,`EpicPage` 根键)、L383-396(根 exact-keys)、L419-421(`signals` 恒空断言) | 根键闭集;`signals` 必空 | 追加 `freshness`、`stuck_items` 根格;定义 `Signal`;放开 `signals` 为有界结构;新 provenance kind `commdb` |
| 生成 | `epic-page/generate.ts` L88-329 | 只读 Linear + StateStore 六格 | 追加 `signals` 输入(第七格读取)、`freshness` 输入(刷新账本读数) |
| 物化 | `epic-page/materialize.ts` L11-19(deps)、L33-65 | `fetchSnapshot → readItemFacts → generatePage → buildReceipt` | deps 追加 `readSignals`、`readFreshness`;不改顺序 |
| 回执 | `epic-page/receipt.ts` L14-20、L85-96、L139-164 | source provenance 只认 `linear`/`statestore` | 追加 `commdb`(与 `statestore` 同形:`table` + `key`) |
| 渲染 | `render-html.ts` L306-368(页头)、L209-250(卡);`render-markdown.ts` L250-299;`labels.ts` | 页头一行 `生成时间`;自带 CSP meta L342 | 页头 freshness 块;「卡住说了一声的」总览格;卡内「说了一声」行;去掉自带 CSP,改 `__CSP_NONCE__` 年龄脚本 |
| 路由 | `bridge/epic-page-route.ts` L113-186 | `POST /generate`,trigger 恒 manual,`generationTails` 串行 | 复用串行器;新增 `GET /api/epic-page/status`(读账本);失败响应附 `last_success` |
| 扫描路 | `bridge/epic-residual-scan.ts` L95-142;`bridge/patrol-tick.ts` L198-220、L376-445 | 成功写回执;失败 token | 成功后 `publishHosted`;失败/成功都记 `epic_page_refresh`;tick 追加一行 |
| tick 渲染 | `bridge/hook-payload.ts` L489-530 `renderEpicResidualSection` | 三行 | 第四行(仅 available 且 `stuckForLead>0` 时) |
| 残余事实 | `epic-page/residual.ts` L12-33 `EpicResidualAvailable` | 无卡住计数 | 追加 `stuckForLead: number` 与 `stuckForLeadItems`(≤5,identifier + kind + since) |
| 事件路(新) | 新文件 `bridge/epic-page-refresher.ts` | — | `requestRefresh(project, reason)`:单飞行 + 尾随合并 + 去抖;调用物化 + 回执 + 发布 + 账本 |
| 事件站点 | `DirectEventSink.ts` L212 `emitStarted` / L628 `emitCompleted` / L1299 `emitFailed`;`bridge/event-route.ts` L605 `router.post("/")` 尾 L3300;`bridge/runs-route.ts` L1118 `/start` 成功 202(L1805/L1939);`bridge/dependency-route.ts` L869 `/add`、L1123 `/remove`(成功 = `result.status` 2xx,L1116/L1258);`bridge/runs-route.ts` L425 `/:runId/resume` 成功 200(L459);`bridge/linear-issue-finalizer.ts`(经 `runPostShipFinalization`,调用点 `DirectEventSink.ts` L1233、`event-route.ts` L2362/L2776、`merge-ship-gate.ts`、`external-merge-reconcile.ts`) | 无 | 各调一次 `requestRefresh` |
| 托管 | `bridge/report-registry.ts` L396-470(`stagePublish` 随机 token;commit 三步);`bridge/report-blob-store.ts` L149-178(`allowOverwrite` 已是参数,`putMigratedReport` 用 true;`cacheControlMaxAge: 60`) | 每次新 token | 新窄方法 `stageEpicPageRepublish(project, html, token)`(只此一个调用方);blob 走 `allowOverwrite:true` 的**新**方法 `putEpicPage`(不改 `putReport`) |
| StateStore | `StateStore.ts` L5230-5296(`migrateEpicPage` 迁移样式)、L9532-9583(回执插入,保留 20 版) | `epic_page` 回执表 | 新表 `epic_page_publication`、`epic_page_refresh`;两个读方法 |
| Bridge 装配 | `bridge/plugin.ts` L4255-4262(epic-page 路由)、L9633-9670(`createEpicResidualScan` + `createLeadPatrolTickPass`,已注入 `openCommReadonly`)、L5813-5820(`hostedReportRegistry` + `reportBlobStore`) | — | 构造 refresher 并注入到 sink / 路由 / 扫描 |
| CLI | `packages/flywheel-comm/src/commands/epic-page.ts`;`index.ts` L177、L374 | `generate/show/render` | 追加 `status` |
| Lead 规则 | `packages/teamlead/lead-rules-base/runner-patrol-rules.md` §0.9(L880-901) | 三行怎么读 | 追加 §0.10:第四行、`status`、固定链接、卡住 = IC 声明 |
| 保留登记 | `scripts/lib/fly-2006-retention-registry.mjs` L38;`scripts/__tests__/fixtures/fly-2006-teamlead-production-tables.json` L22 | 列有 `epic_page` | 新增两表登记(否则 FLY-2006 测试红) |

---

## 2. 事件路(hybrid 的「某件事做完就触发」)

### 2.1 为什么不挂 StateStore、不挂审计事件表

- `upsertSession` 生产调用点 11 处(`DirectEventSink` 4、`event-route` 4、`merge-ship-gate`/`external-merge-reconcile`/`actions` 各 1 ✅),`UPDATE sessions` 语句 34 处 ✅ —— 状态写入没有单一漏斗;在 StateStore 里挂监听要么漏、要么把 StateStore 变成有副作用的层(sql.js 事务内不能做 I/O)。
- `insertEvent` 写 `session_events`(`StateStore.ts` L7360;`SessionEvent.event_type: string` 自由串 L671-683 ✅),来源含 runner 心跳等,与「页面会变」不等价。
- ⇒ 采纳 exploration §4.2 丙:**枚举站点**。漏一个由扫描路兜(这就是双路的分工),每个站点一条 RED 用例(§7)。

### 2.2 站点清单(`reason` 枚举 🔶,写进 `epic_page_refresh.reason`)

| `reason` | 站点 | 备注 |
|---|---|---|
| `session_started` | `DirectEventSink.emitStarted` 末;`event-route` 的 `session_started` 分支 | 「账面执行体」变 |
| `session_completed` | `DirectEventSink.emitCompleted` 末(含 `phase_design_complete` 早返回分支);`event-route` 尾 L3300 前(对 `session_completed`/`session_failed`,**两个入口都要**:DAG 入册分支在 L723-760 早返回 ✅,必须在 `return` 前各挂一次) | 最重要的「做完」 |
| `session_failed` | `DirectEventSink.emitFailed` 末;`event-route` 同上 | 卡住信号可能出现 |
| `run_started` | `runs-route` `/start` 202 成功后(L1805、L1939;另三处 L3312-3352 为 resume/其他形态,⬜ plan 核) | 派单 |
| `run_resumed` | `runs-route` `/:runId/resume` 200 后 | hold 解除 |
| `linear_done` | `runPostShipFinalization` 内 finalizer 成功后(一个挂点,五个调用者都经过它 ✅ `post-merge.ts` 头注释) | Linear Done ⇒ `ready.v1` 变 |
| `dependency_changed` | `dependency-route` `/add` `/remove` 2xx 后 | `blocked_by` 变 |
| `scan` / `manual` | 既有两路 | 记账时统一词表 |

⛔ 不挂:心跳、`session_events` 写入、`hold` 创建(hold 由 run 状态机内部产生,`workflow_run.status` 变 `held` 的写点分散 L2805/L2858/L21622 ✅;它在下一轮扫描或下一个 session 事件时被带出;plan 列为已知滞后,不是缺陷)。

### 2.3 `requestRefresh` 语义

```
requestRefresh(projectName, reason):
  if project 无 linear binding 或无 LINEAR_API_KEY → 记 epic_page_refresh(outcome="skipped: project_unbound"|"skipped: linear_not_configured") 一次/启动(不每次),返回
  pending[project] = union(reasons)          // 合并原因
  if inFlight[project] → 标 rerun=true,返回  // 尾随合并:飞行结束后再跑一次
  else 去抖 5 s(常量,⛔ 不是 flag)后执行:
    materialize(trigger="event") → 回执(不变) → epic_page_refresh(ok:vN, reasons)
    → publishHosted(page)(失败只记 outcome="publish_failed: <token>",不回滚回执)
  异常 → epic_page_refresh(outcome=<unavailable token>),⛔ 不抛到调用方
```

- 与路由的 `generationTails`(`epic-page-route.ts` L146-165)共用同一把每项目串行锁 🔶:把串行器抽成 `EpicPageSerializer`,路由与 refresher 都注入同一实例,保证 Linear 同项目查询串行。
- 调用方永远 `void refresher.requestRefresh(...)`,不 await、不影响 HTTP 响应时延。

### 2.4 扫描路的追加

`epic-residual-scan.ts` `materializeForScan` 成功分支(L129-141)后:`await publishHosted(page)`(fail-soft,记账);失败分支(L104-127)后:记 `epic_page_refresh(outcome=token, reason="scan")`。tick 第四行由 `summarizeForLead` 从 `page.items[].signals` 汇总(§4.4)。⛔ 不改相位(`scheduledAtOrBefore` L113-120)、空名册逻辑、`unavailable` token 集(只**追加** `transient: publish_failed`,不进 residual 的 allowlist —— 发布失败不影响残余事实)。

---

## 3. 过期自报

### 3.1 刷新账本 `epic_page_refresh`(新表,append-only)

```sql
CREATE TABLE IF NOT EXISTS epic_page_refresh (
  project_name TEXT NOT NULL,
  attempted_at TEXT NOT NULL,             -- RFC3339 UTC
  trigger      TEXT NOT NULL CHECK (trigger IN ('manual','event','scan')),
  reason       TEXT NOT NULL,             -- §2.2 枚举,逗号连接
  outcome      TEXT NOT NULL,             -- 'ok:<version>' | '<class>: <token>'
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX ... ON epic_page_refresh(project_name, attempted_at DESC);
-- 每项目保留最近 200 行(插入时 DELETE 超出部分,沿用 epic_page 的 20 版样式 L9570-9574)
```

`outcome` 词表 = `ok:<version>` ∪ residual 的 8 个 token ∪ `transient: publish_failed` ∪ `skipped: project_unbound` ∪ `skipped: linear_not_configured`。读法:`getEpicPageFreshness(project)` 返回 `{ last_success: {version, generated_at, trigger, reason} | null, last_attempt: {...}, failures_since_success: n, last_failure_token }`。

### 3.2 `freshness` 根格(派生,规则 `freshness.v1` 🔶 默认规则)

```ts
freshness: Cell<{
  trigger: "manual" | "event" | "scan";
  reasons: string[];                       // 本次刷新原因
  last_success: { version: number; generated_at: string; trigger: string } | null;
  failures_since_success: number;
  last_failure: { attempted_at: string; token: string } | null;
  oldest_source_observed_at: string;       // 全部 source Cell 的 min(observed_at)
  next_scan_expected_at: string | null;    // 按 patrol 相位预计;无 Lead 可算时 null
  hosted: { token8: string; last_published_at: string } | null;  // 只给读者定位,不含完整 token
}>
```
provenance:`{kind:"derived", rule:"freshness.v1", from:["/header/items", …所有 source Cell 指针]}`;`observed_at = generated_at`。`next_scan_expected_at` 的算法复用 `scheduledAtOrBefore`(`patrol-tick.ts` L113-120)+ `effectivePatrolIntervalMs`(`patrol-config.ts` L151-166),取该项目所有可派 Lead 的**最早**下一到点;写明是预计。

`RULE_IDS` 追加 `freshness.v1`、`signals.v1`(`model.ts` L13-21);`receipt.ts` 的 `COMPUTED_ORDER_FIELD`(L22-24)不匹配这两个名字 ✅(不含 batch/next/ready/order)。

### 3.3 读者层:托管 HTML 的年龄脚本

- `render-html.ts` L342 自带 CSP meta ⇒ registry `injectHeadMeta` 见到已有 CSP 就**不注入** nonce CSP(`report-registry.ts` L600-620 `if (!hasCsp) inject.push(cspMeta)` ✅)⇒ 今天托管后脚本必被拦。
- 改法:HTML **去掉**自带 CSP meta,加 `<script nonce="__CSP_NONCE__">`;registry 铸 nonce 并注入带 nonce 的 CSP(L556-578 ✅)。本地文件/CLI `render --out` 打开无 CSP,脚本照跑。
- 脚本只做:读 `<time data-generated-at>`,每 60 s 用 `textContent` 写「你打开时它已 N 分钟旧」;⛔ 不 fetch、不 innerHTML、零外部资源。静态文字「生成于 <generated_at>(相对生成时刻的年龄由服务端算)」保留在脚本之外。
- 验收带 `--self-check`:脚本被拦(模拟无 nonce)时页面仍显示 `generated_at`;脚本在时元素文本变化(`MEMORY` 隐藏态假绿教训 ✅)。
- blob `cacheControlMaxAge: 60`(`report-blob-store.ts` L162 ✅)⇒ 覆盖后最多 60 s 读到旧字节;gateway 读 blob `useCache:false`(`report-gateway-runtime.ts` L57 ✅)。**页面上的年龄由 `generated_at` 算,60 s 缓存只影响「拿到哪一版」,不影响「这一版说自己多旧」** —— 写进边界。

### 3.4 失败层:刷新失败时的托管页

Lead Q1 未点名此项;exploration §4.5 列为可裁掉的最后一块。研究结论 🔶:**v1 不重传横幅**。理由:registry 本地留有上次 HTML(commit ① L446-452 ✅),技术上可做;但「重传旧内容 + 横幅」等于制造一版 `generated_at` 不变、字节却变了的页面,与 Q1③「刷新 = 就地更新 createdAt 与字节」的语义相撞(它会把保留期续上,而内容并没有刷新)。失败事实由 `freshness` 格在**下一次成功**时带出(`failures_since_success`、`last_failure`),由 CLI `status` 随时可查。plan 把它写进「不做」并留作 founder 可能追加的返工点。

---

## 4. R6:卡住信号

### 4.1 `Signal` 结构(`items[].signals`,有界)

```ts
type SignalKind = "declared_blocked" | "runner_stopped" | "question_pending" | "run_held" | "waiting_founder";
interface Signal {
  kind: SignalKind;
  execution_id8: string;             // 前 8 位
  since: string;                     // 来源时间(RFC3339)
  reason?: "blocked" | "quota" | "context_full" | "error";   // 仅 runner_stopped
  route?: string;                    // 仅 declared_blocked:decision_route
  hold_reason?: string;              // 仅 run_held:latest_hold_reason token(⬜ plan 核其词表有界)
  question_id?: string;              // 仅 question_pending / waiting_founder
  provenance: Provenance;            // statestore | commdb
  observed_at: string;
}
```
⛔ 无 `summary` / `last_error` / `content` / `detail` 字段 —— 类型上就不存在,泄漏哨兵测试在 JSON 与 HTML 两侧断言。`assertEpicPage` 对 `signals` 做 exact-keys + 枚举 + 时间戳校验;`value` 内不许 `*_at` 键(沿用 L184-196 的规则,所以字段名用 `since` 而非 `since_at`)。

`waiting_founder` 是「不算卡住」的**分流**类别(Q2③):有它就不进 `stuck_items`,但仍显示在卡上(她能看到「在等她」)。

### 4.2 StateStore 侧读取(新方法 `getEpicPageSignalFacts(project, keys)`)

- `declared_blocked`:该 issue 最新 session(复用 `getEpicPageSessionFact` 的 alias 与排序 L9584-9617 ✅)`status='blocked'` 或 `decision_route='blocked'` ⇒ 一条,`since = COALESCE(last_activity_at, started_at)`。
- `run_held`:`workflow_run` 该 issue `status='held'`(复用 `getEpicPageRunFact` 的 alias 逻辑)⇒ 一条,`hold_reason` 取 `latest_hold_reason`(L45029 ⬜ plan 核该值是否稳定 token;若是自由文本则只出 `held`)。
- 读失败 ⇒ 整格 `missing: {reason: "statestore_error"}` 并进 `gaps`(face `signals`)。

### 4.3 CommDB 侧读取(只读、有界、fail-soft)

复用 patrol 已注入的 `openCommReadonly(projectName)`(`plugin.ts` L9666-9668 → `CommDB.openReadonly(commDbPathForProject(projectName))` ✅ L1189)。一条 SQL,按 exec 集合查:

```sql
SELECT id, from_agent, to_agent, kind, checkpoint, relay_state, created_at, content
  FROM mailbox_message_projection q
 WHERE q.type = 'question'
   AND q.from_agent IN (<该页全部 item 的 execution_id,≤ N>)
   AND q.relay_state != 'terminal_disposed'
   AND datetime(q.created_at) >= datetime('now', '-14 days')          -- 时间窗
   AND NOT EXISTS (SELECT 1 FROM mailbox_message_projection r
                    WHERE r.parent_id = q.id AND r.type = 'response')
 ORDER BY q.created_at DESC
 LIMIT 500;                                                             -- LIMIT
```
分类:
- `kind='report'` 且 `id ~ ^rstop-[0-9a-f]{32}$` 且 `content` 以 `RUNNER-STOPPED kind=runner_stopped ` 开头(`runner-stop-report.ts` L7-19 ✅)⇒ 解析 `reason=` 字段(grammar `runner-stopped.ts` L564-565 ✅:`reason=<r> issue=<id> exec=<execId> route=<route|-> detail=…`);`reason ∈ {blocked,quota,context_full,error}` ⇒ `runner_stopped`;`done`/`awaiting_approval` ⇒ 丢弃;⛔ `detail` 不读。
- `relay_state='protected'` 且 `checkpoint` 非空 ⇒ `waiting_founder`(Q2③)。
- 其余(未答问题,含未 protected 的 gate)⇒ `question_pending`,`question_id` = `id`。
- `content` 只用于前缀/字段识别,⛔ 不进页面。提取后立即丢弃。
- exec → issue 的映射:用 StateStore `sessions` 行(`from_agent = execution_id`,`ask.ts` L37 ✅ `fromAgent = args.execId`);`execution_id8` 取前 8 位。
- 任何异常(库不存在、schema 旧、busy)⇒ `missing: {reason: "commdb_error"}`(`MISSING_REASONS` 追加)+ `gaps` face `signals`;⛔ 不抛。
- 时间窗 14 天与 LIMIT 500 为常量,⛔ 非 flag。

### 4.4 页面与 tick 的落点

- 根格 `stuck_items`(派生 `signals.v1`):`items` 中 `signals` 含 `declared_blocked|runner_stopped|question_pending|run_held` 任一者,按 `since` 最早在前;`waiting_founder` 单独一列不计入。HTML 放在「现在可以开始的」之后、「依赖需要减法」之前,标题 🔶「卡住说了一声的」。
- 卡内一行「说了一声」:`kind · execution_id8 · 相对时间 · 枚举 reason`,无信号显示「无」。
- tick:`EpicResidualAvailable` 追加 `stuckForLead`(归本 Lead 的 stuck 子单数)与 `stuckForLeadItems`(≤5:identifier、kind、since);`renderEpicResidualSection` 在 `readyLine` 后追加一行 🔶「- 卡住说了一声的 N 张:FLY-x(declared_blocked,2h)…」,N=0 时**不出该行**(不制造噪音)。归属复用 `resolveOwner`(同三行)。
- ⛔ 不发 founder、不建告警器、不新增 Lead 事件类型(Q2④)。

---

## 5. 稳定托管地址

### 5.1 存储(Q1①最小结构)

```sql
CREATE TABLE IF NOT EXISTS epic_page_publication (
  project_name       TEXT PRIMARY KEY,
  token              TEXT NOT NULL UNIQUE CHECK (length(token) = 32),
  first_published_at TEXT NOT NULL,
  last_published_at  TEXT NOT NULL,
  last_version       INTEGER NOT NULL
);
```
token 首次发布时 `randomBytes(16).hex`(与 registry 同一 `REPORT_TOKEN_RE` L46 ✅),之后不变。⛔ 不存 URL(gateway host 由 registry/env 决定)、不存 HTML。

### 5.2 registry 窄 API(Q1②)

- 新方法 `stageEpicPageRepublish(projectName, html, token): StagedPublish`:与 `stagePublish` 同样 `injectHeadMeta` 硬化;**不**生成新 token;若 `reports` 里已有同 token entry ⇒ 就地更新 `createdAt`、`bytes`、`title`;否则新建 entry。commit 三步不变。
- `stagePublish`(通用)**不变**:仍随机 token、仍不覆盖。
- blob:新方法 `putEpicPage(token, html)` = `putReportObject(token, html, /*allowOverwrite*/ true)`;`putReport` 保持 `false`。调用方校验:token 必须来自 `epic_page_publication` 且属于该 project,否则拒绝(防止把任意报告 token 覆盖)。
- 验收 A-②:对一个普通报告 token 调 `stageEpicPageRepublish` ⇒ 拒绝(token 不在 publication 表);`POST /api/reports/publish` 两次 ⇒ 两个不同 token(通用语义未变)。
- 验收 A-③:重发后 entry `createdAt` 前进;`isReportExpired(now, createdAt)` 以新时间计;registry 无 count/bytes prune 路径(断言 `stagePublish` 源码不含 `maxCount`/`maxBytes` 这类分支 —— 用行为断言:插入 1000 条未过期 entry 后新发布不淘汰任何一条)。

### 5.3 发布函数 `publishHosted(page)`

```
if 无 blobStore 或 registry.hosting() 非 vercel-blob → outcome "skipped: hosting_not_configured"(启动时一行告警,之后静默)
html = renderEpicPageHtml(page)            // 含 nonce 占位脚本
if bytes > 512 KiB → outcome "structural: epic_html_too_large"(沿用 CLI 的上限 epic-page.ts L189 ✅)
token = publication.token ?? mint()
staged = registry.stageEpicPageRepublish(project, html, token)
await blob.putEpicPage(token, staged.html)  → staged.commit()  |  失败 staged.abort() + outcome "transient: publish_failed"
upsert epic_page_publication(last_published_at, last_version)
```
链接形状与既有报告一致:`https://<gateway>/r/<token>/`(`reports-route.ts` L6 ✅)。**首次**链接由 Lead 用既有 `founder-html-delivery` 规则发一次(一条消息);之后 ⛔ 不再发。

### 5.4 与 CLI 的关系

`epic-page render --out` + `publish-report` 的手工路径**保留**(Lead 想给 founder 一个「此刻快照」时仍可用;它会得到一个**新**随机 token,与固定页并存,14 天后自然过期)。`epic-page status` 打印固定链接 token 前 8 位、`last_published_at`、`freshness`。

---

## 6. 模型守卫与兼容

- `schema_version` 保持 `1`:消费者只有 `model.ts`/`receipt.ts` 两处断言 `=== 1`(✅ L397、L94);根键闭集在 `assertEpicPage` 内由本单同步扩;回执 `sources` 走 Cell 扫描,新 `commdb` provenance 只要在 `assertEpicPageRenderReceipt` 加分支即可。⇒ 不 bump。理由:没有外部持久化消费者回读页面 JSON(回执表不存值 ✅),bump 只会让 20 版旧回执与新版本对不上。
- `EPIC_PAGE_MAX_DOCUMENT_BYTES`(L11)不变;`signals` 每 item ≤ 🔶 10 条(超出截断并记 `signals_truncated: true` 于 freshness?—— ⛔ 不加;直接由 LIMIT 500 与「每 exec 最多一条同 kind」保证有界)。
- `MISSING_REASONS` 追加 `commdb_error`;`gaps.face` 追加 `signals`。
- 泄漏哨兵:fixture 在 `sessions.summary`/`last_error`、CommDB `content`(detail 段)放绝对路径 + `Bearer …` 串;断言 JSON、Markdown、HTML、tick 正文四处都不含。

---

## 7. 测试面(plan 的 RED 顺序依据)

| 面 | 文件(沿用既有夹具) | 关键用例 |
|---|---|---|
| 模型 | `epic-page/__tests__/model.test.ts` + `fixtures/epic-shape.ts` | signals 合法/非法形状;`freshness`/`stuck_items` 必须存在;`commdb` provenance;`schema_version` 仍 1 |
| 生成 | `generate.test.ts` | 五类信号各一;`waiting_founder` 不入 `stuck_items`;`done`/`awaiting_approval` 报告被丢弃;泄漏哨兵 |
| 渲染 | `render.test.ts` | 页头 freshness 块;nonce 脚本存在且无自带 CSP;卡内行;Markdown 同步 |
| 回执 | `receipt.test.ts` | `commdb` source 进回执;派生格不进 |
| 刷新器 | 新 `bridge/__tests__/epic-page-refresher.test.ts` | 单飞行 + 尾随合并(20 事件 ⇒ ≤2 次物化);去抖;每站点 reason;失败记账不抛;unbound 只记一次 |
| 站点 | `event-route-*.test.ts`、`DirectEventSink.test.ts`、`runs-route`、`dependency-route.test.ts`、`post-ship-finalization` | 每站点:mock refresher 被调且 reason 正确;**两个** session_completed 入口各一 |
| 扫描路 | `epic-residual-scan.test.ts`、`patrol-tick.test.ts`、`patrol-tick-render.test.ts` | 成功后发布;失败记账;第四行只在 N>0 出现;字节不变(N=0 时 tick 正文与 FLY-2141 golden 逐字节相同) |
| 托管 | `report-registry.test.ts`、`report-blob-store` 测试、新 `epic-page-publisher.test.ts` | A-②、A-③;同 token 两次发布一条 entry;普通 publish 语义不变;>512 KiB 拒绝 |
| StateStore | `statestore-epic-page.test.ts`、`fly-2006-database-retention-sweep.test.ts` | 两新表迁移幂等;账本 200 行上限;retention registry 登记 |
| CLI | `flywheel-comm` `epic-page.test.ts` | `status` 输出;失败响应带 `last_success` |
| 隔离 | 全部 | 不跑 `tmux-viewer.macos.test.ts`(`MEMORY` 红线 ✅);CommDB 用临时文件 |

---

## 8. 风险与边界

| 风险 | 处理 |
|---|---|
| 事件风暴打 Linear | 去抖 + 单飞行 + 尾随合并;每项目串行锁与路由共用;plan 写 20 事件 ≤2 次物化的可执行断言 |
| 生产六项目 `linear` 全 null(`MEMORY` ✅) | refresher/publisher 在 unbound 时字节不变、启动一行告警(沿用 FLY-2141 B18 合同);⛔ 不改 `projects.json` |
| 托管未配置(无 `BLOB_READ_WRITE_TOKEN`) | `skipped: hosting_not_configured`,页面与 tick 照常;固定链接格显示 `null` |
| CommDB schema 演进 | 只读 + 单条 SQL + try/catch ⇒ `commdb_error`;列名变化只让信号格 missing |
| 「hold 不触发事件」滞后 | 明写:≤ 1 巡检周期;不是缺陷 |
| 60 s blob 缓存 | 页面年龄以 `generated_at` 计;边界写进 founder HTML |
| 14 天不刷新链接死 | 只在 Bridge 停摆/项目 unbound 14 天时发生;`status` 能看出;不做额外续期器 |
| FLY-2144 在飞(plan 阶段 5/5) | 本单不动 `capacity` 相关行与 §3.5 采样点;tick 追加行放在 epic 三行之后,与 capacity 段无交叉 |

---

## 9. 不做(继承 + 新增)

不做多项目 quota、不做分层调频、不改 `ready.v1`/`scope.v1`/`subtraction.v1`、不改巡检相位、不新增 flag/配置键、不新增 Lead 事件类型、不发 founder、不建告警器、不从正文推断、不存页面值、不给通用 `stagePublish` 加覆盖能力、不做刷新失败横幅重传(§3.4)、不做 Linear webhook。
