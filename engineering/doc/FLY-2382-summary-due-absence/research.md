# FLY-2382 summary 写侧触发 + 缺席检测 — 调研
Issue: FLY-2382 (https://linear.app/geoforge3d/issue/FLY-2382/raya回流-summary-写侧触发-缺席检测按-prd-1846-872-的固定节奏6h运行期可改由机制叫-lead)
日期: 2026-09-06
基于: exploration.md

本文把 exploration §3.1 方案 A 落到具体代码位点,每条都本机实核过(文件:行)。

## 1. 钟:节拍与 slot 数学

| 事实 | 位点 |
|---|---|
| GatePoller 主 tick 3s;`onSummaryAbsorptionTick` 每 `DEFAULT_PATROL_EVERY_N_TICKS = 20` tick 跑一次 ⇒ 60s 一次 pass;异常只 warn 不致命 | `bridge/gate-poller.ts:310, 690-704` |
| 现 rider:`slotStartMs = floor(now / cadence) * cadence`;roundId = `summary-absorption:<slotISO>`;单飞(in-flight 复用) | `bridge/summary-absorption-rider.ts:47-52, 83-97` |
| cadence 读取 call-time:`storeSummaryAbsorptionCadenceMs(flagStore)`,codec 保证 [60000, 2592000000] 整数;非法 seed 只 warn 回落默认(FLY-2131 整合返工) | `bridge/flag-store-runtime.ts:215-226`;`config/feature-flags/store-policy.ts:102-108` |
| 管理台改 flag:`POST /api/fleet/flag/stage` → apply,loopback + same-origin + confirmToken;只接受 `toggleable: "direct"`;本 flag 是 direct | `bridge/plugin.ts:2630-2660`;`config/feature-flags/registry.ts:277-298` |

结论:
- slot 对齐 epoch。6h 时边界 = 00/06/12/18 UTC = 17/23/05/11 PDT。运行期改 cadence 后 slot 重算,已发的 due 事件 id 含旧 slotISO,不会与新 slot 撞;第二拍按**当前** cadence 的 slot 算——文档写明,不做迁移。
- 第二拍偏移 `SUMMARY_DUE_GRACE_MS = 30 * 60_000` 常量。守卫:`grace < cadence` 恒成立(cadence 下限 60000 时 grace 会大于 cadence!)⇒ 实现取 `effectiveGrace = min(GRACE, floor(cadence / 2))`,并在测试里钉住 60s cadence 的退化行为(30s)。

## 2. 名单:谁是 producer

| 事实 | 位点 |
|---|---|
| `compileSummaryAssignmentRows(sourceRows, selection)` 是 hasSummaryDuty 的**唯一**算法:per-lead ⇒ `summaryRole === "producer"`;per-project ⇒ `leadId === project.summaryAggregatorLeadId`;`unselected` 抛 `summary_granularity_unselected` | `flywheel-comm/src/summary-assignment-core.ts:52-116` |
| `readSummaryGranularity({homeDir})` 读 `~/.flywheel/summary-config.json`;ENOENT ⇒ unselected;坏 JSON 抛 `SummaryConfigError` | `flywheel-comm/src/summary-config.ts:49-110` |
| 两者都是 flywheel-comm 的公开子路径 export(`./summary-assignment`、`./summary-config`);teamlead 已依赖 `flywheel-comm: workspace:*`,`ProjectConfig.ts:4-5` 已从 `flywheel-comm/lead-identity` 导入 | `flywheel-comm/package.json` exports;`teamlead/package.json:63` |
| `ProjectEntry.leads[].summaryRole: SummaryRole`、`ProjectEntry.summaryAggregatorLeadId?` 在 Bridge 内存里就有 | `teamlead/src/ProjectConfig.ts:15, 273` |
| 生产 granularity = per-lead(founder 2026-08-28 圈选);11 producer 名单见 exploration §1.3 | `~/.flywheel/summary-config.json` |

结论:Bridge 侧把 `ProjectEntry` 映射成 `SummaryAssignmentSourceRow[]` 喂给 `compileSummaryAssignmentRows`,**不复制 duty 规则**。granularity 每轮 call-time 读文件(与 flag 同样的「不缓存」纪律);`unselected` 或读错 ⇒ 本轮整体跳过 + 一行 warn(fail-loud,符合合同「no granularity ⇒ 工具必须响亮失败」),不让 Bridge 崩。

## 3. 投递:事件如何到 Lead

| 事实 | 位点 |
|---|---|
| `appendLeadEvent(leadId, eventId, type, payload, sessionKey)`:`(lead_id, event_id)` 唯一;冲突返回既有 seq(**分不清新旧**) | `StateStore.ts:15462-15528` |
| `tryClaimLeadEvent(...)`: boolean,true = 本次写入 | `StateStore.ts:15541-15560` |
| `registry.enqueueLeadEvent(envelope)`:无 runtime 注册 ⇒ **throw** `No runtime registered for lead`;内容 = `runtime.renderEnvelope(envelope)` | `bridge/runtime-registry.ts:96-108` |
| Claude Lead 渲染:`commdb-lead-runtime.ts formatEnvelope`——`patrol_tick` 专用 formatter;其余走通用分支:`Summary:` 截 300 码点、`Context:`(notification_context)不截 | `bridge/commdb-lead-runtime.ts:99-140, 175-240` |
| 专用 formatter 样板:`formatPatrolTick(env)` in `hook-payload.ts:945`;**两个** runtime 各有一份 `formatEnvelope` 分派(`mailbox-lead-runtime.ts:222`、`commdb-lead-runtime.ts:99`),生产 Claude Lead 走 `MailboxLeadRuntime`(`plugin.ts:1022`),Codex Lead 的渲染同样经 `registry.enqueueLeadEvent` 的 `runtime.renderEnvelope` ⇒ 新分支两处都要加,测试断言两处 parity | `bridge/mailbox-lead-runtime.ts:218-230`;`bridge/commdb-lead-runtime.ts:93-105` |
| 投递落地查询:`leadInboxRuntime.getLeadEventSettlement(project, deliveryId)` → `MailboxSettlement`:`absent_identity` / `torn_identity` / `live{state}` / `archived_*` | `bridge/lead-inbox-runtime.ts:612-619`;`flywheel-comm/src/mailbox-queue.ts:32-50` |
| patrol 的重投模式:上一条若 `absent_identity` 则重新 enqueue 同 envelope;deliveryId 由 `canonicalLeadEventDeliveryId(envelope)` 派生 | `bridge/patrol-tick.ts:301-316` |
| 生产 30 天:8/11 producer 的 lead_events 从未 delivered(只有 8-13 的 dead_letter 系统行);Codex Lead(mufasa)走 `lead-inbox.sock`,曾多次 `inbox_loop_stalled` | `~/.flywheel/teamlead.db`(只读查询,exploration §1.4) |

结论:
- 第一拍用 `tryClaimLeadEvent` 首次写入才 enqueue;之后每 60s pass 对同 slot 只做「settlement 若 `absent_identity` 则重投」(照抄 patrol),不重复 enqueue。
- `summary_due` 走**专用 formatter** `formatSummaryDue(env)`(放 `hook-payload.ts`,与 patrol 并列),避免 300 码点截断;Codex Lead 路径拿到的是同一渲染字符串(`renderEnvelope` 在 registry 层统一)。
- 第二拍逐 producer 读 `getLeadEventSettlement(project, dueDeliveryId)`:`live` 且 state 为已消费/已投 ⇒ `delivered`;`absent_identity`/`torn_identity`/仍 QUEUED ⇒ `undelivered`。具体 `MailboxState` 取值在 plan 里钉(`mailbox-queue.ts` 的 `MailboxState` 枚举)。

## 4. 交付史与缺席:gh 列 PR

| 事实 | 位点 |
|---|---|
| 分支命名 `summary/<project>/<author>/<sha256(project,author,period)[:16]>`;标题 `Summary: <project> · <period>` | `flywheel-comm/src/summary-delivery.ts:52-66, 336` |
| flywheel-comm 已有 `gh pr list --repo xrliAnnie/raya --state open --limit 1000 --json …` 的调用形态与 JSON 校验(`summary_github_invalid`) | `summary-delivery.ts:104-135` |
| `gh pr list --json` 支持 `number,state,createdAt,updatedAt,mergedAt,headRefName,url`(本机实测 PR #24 返回 updatedAt) | 实测 |
| Bridge 内 gh 调用样板:`execFile("gh", args, { cwd, timeout: 60_000, maxBuffer })`;凭证 `GH_TOKEN`/`GITHUB_TOKEN` 从 Bridge env 透传 | `bridge/branch-cleanup.ts:30-47`;`bridge/land-head-refresh-proof.ts:16-30` |
| Raya 仓 PR 总量目前 24;`--limit 200 --state all` 一次拉完;按 `headRefName.startsWith("summary/")` 过滤后按 `<project>/<lead>` 分桶 | 实测 |

结论:
- 一个只读模块 `summary-delivery-ledger.ts`(Bridge 侧):`listSummaryPulls(repo) → SummaryPull[]`,一次 gh 调用给两拍共用(第一拍算 `last_delivered`,第二拍算 `delivered`)。
- 「本轮已交」判据:该 Lead 存在 summary PR 且 `max(createdAt, updatedAt) ∈ [T − cadence, T + grace)`。用 `updatedAt` 是因为同 `{project, author, period}` 重跑会更新同一 PR(`summary.ts` 的 update 路径)。merged/closed 也算已交(是否被读是 Raya 的事)。
- gh 失败(超时/非零/JSON 坏)⇒ 第一拍 `last_delivered: { status: "unavailable", reason }` 照发;第二拍整轮 `producers` 标 `delivery_ledger: "unavailable"`,Raya 那行改为「本轮交付状态不可得(gh 不可用)」;都落 warn。不因 gh 挂掉而不叫人、不发轮。
- 注意 `--limit 200` 的上限:Raya 仓 PR 超过 200 后旧 PR 掉出窗口只影响 `last_delivered`(会显示更旧的一张或 none),不影响本轮判定(本轮窗口在最近);plan 里加 `--search "head:summary/"`? gh 的 `--search` 走 GitHub search 语法,`head:` 不被 PR search 支持 ⇒ 不用;改为 `--state all --limit 500` 并把「窗口截断」写进边界。

## 5. 时间:period 的渲染

| 事实 | 位点 |
|---|---|
| 合同 period = `<ISO start>/<ISO end>`,端点须 ISO 且可 `Date.parse`;路径日期 = `end.slice(0,10)` = **end 字符串前 10 位**(所以带本地 offset 的 ISO 会得到本地日期) | `flywheel-comm/src/summary-contract.ts:67-88, 91-110` |
| README:`<YYYY-MM-DD>` 是 period 末日 **founder-local** | raya `summaries/README.md` |
| founder 时区权威:`resolveFounderTimezone()`(host 时区 + `FLYWHEEL_FOUNDER_TZ` 覆盖)、`formatFounderLocal(date, tz)` 已在 `packages/config` | `config/src/founder-timezone.ts:88, 146` |
| 现有 `Intl.DateTimeFormat(...).formatToParts` 用法 ×4 可参考(取 offset 需 `timeZoneName: "longOffset"`) | `bridge/flag-retirement-scan.ts:50` 等 |

结论:Bridge 在 `summary_due` 里给 `period = <founderLocalIso(T − cadence)>/<founderLocalIso(T)>`,offset 用 `resolveFounderTimezone()` 当时的值(如 `2026-09-06T16:00:00-07:00`)。这样 Lead 直接抄 period,路径日期自动是 founder 本地日。**`founderLocalIso(date, tz)` 已存在**(`config/src/founder-timezone.ts:154`,输出形如 `2026-09-06T16:00:00-07:00`),不新增 helper;只补一条 DST 边界测试(11-01 PDT→PST)若既有测试没盖到。

## 6. 告警:due 送不到时怎么叫人

| 事实 | 位点 |
|---|---|
| alert sink:`leadPendingAlertHolder.current.alert({ leadId, projectName, eventId, eventType, title, body, severity, sessionKey? })`;patrol 用 `inbox_loop_stalled` | `bridge/plugin.ts:9861-9890` |
| kind 白名单:`kind-contract.ts` 的 `Record<AlertKind, KindContract>`(owner ∈ claude / cross_by_provider / founder_direct / owning_lead;arc ∈ auto / none_escalate / human_by_design);文案在 `alert-kind-copy.ts` 两个 switch(title / body) | `bridge/kind-contract.ts:45-60, 94`;`bridge/alert-kind-copy.ts:230, 510` |
| owner 归属有测试族 `ticket-owner-map.test.ts` 逐 kind 断言 | `bridge/__tests__/ticket-owner-map.test.ts:105` |

结论:**不新增 kind**。due 在 T+grace 仍 `undelivered` 本质就是「Lead inbox 通路没把 Bridge 事件送到」,复用 `inbox_loop_stalled`(patrol 也用它报投递停滞),eventId `summary_due_undelivered:<project>/<lead>:<slotISO>` 天然一 slot 一条;title/body 写清是 summary_due。少一处 kind 注册、少一组 owner 测试,语义仍准确。

## 7. Raya 侧:轮事件 payload 与文本

| 事实 | 位点 |
|---|---|
| 现 payload 字段:`event_type, execution_id(=roundId), issue_id: "FLY-2131", project_name, status, generated_at, summary(指令), notification_context` | `summary-absorption-rider.ts:57-72` |
| Raya 未激活:`resolveRaya` 返回 null ⇒ 直接 return;生产 0 行 | exploration §1.2 |
| FLY-2131 plan 的 #raya 汇报句式:「今天下午 6 点,我 review 了这 N 个 PR,吸收了 M 条(覆盖 K 个项目),X 处没看懂已去问 <Lead>」 | `engineering/doc/FLY-2131-raya-brain-absorb/plan.md:85` |
| 现有 rider 测试样板(harness 用 vi.fn 的 appendLeadEvent/getLeadEventBySeq/enqueueLeadEvent) | `bridge/__tests__/summary-absorption-rider.test.ts:1-70` |

结论:payload **加字段不改旧字段**:`producers: [{ project, lead, delivered: boolean, due_delivery: "delivered"|"undelivered"|"unknown", last_pr?: {number,url,state,updatedAt} }]`、`delivered_count`、`producer_count`、`absent: string[]`、`undelivered: string[]`、`delivery_ledger: "ok"|"unavailable"`。`summary` 指令文本追加一段固定格式(Raya 只转述,不重算):

```
本轮 N/M 份已交;未交:X、Y            ← 全交齐则整行省略
未送达(机制问题,归 infra):Z         ← 无则省略
本轮交付状态不可得(gh 不可用)         ← 仅 ledger unavailable 时
```

## 8. 规则文本:summary-inflow.md 要改哪句

| 事实 | 位点 |
|---|---|
| 「do not invent one, add reminders, or turn silence into a nag」现在读起来像 Lead 自己要记着节奏 | `lead-rules-base/summary-inflow.md:12-14` |
| bundle 测试只断言文件**在/不在**与顺序,不断言内容 hash | `teamlead/src/__tests__/lead-rules-bundle.test.ts:183-196` |

结论:在 `## Your obligation` 下加一小节 `## The due signal` 说明:节奏由 Bridge 以 `[summary_due]` 事件送达;收到即写 + 跑命令;period 直接抄事件里的;没有事实与判断可写时可以不交(§6.3),未交会以「未交」出现在 Raya 轮报里——这是可见性不是催促;`[summary_due]` 是唯一节奏来源,仍不许自建定时器。

## 9. 与「不做」的对照

- 不碰 `summary-contract.ts` / `summary-delivery.ts` / `summary-pr-merge.ts` / raya 仓 README ⇒ 合同不变。
- 不碰 `resolveRaya` 的匹配条件、不给 projects.json 加行 ⇒ Raya 激活仍归 FLY-2131 检查单。
- 不新 flag、不新 daemon、不新 alert kind。
- 唯一「新」持久化:`lead_events` 里多两类 `event_type`(`summary_due`;`summary_absorption_round` 已有)——同一张既有表,无 schema 迁移。
