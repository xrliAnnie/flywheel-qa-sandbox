# FLY-2382 summary 写侧触发 + 缺席检测 — 实施计划
Issue: FLY-2382 (https://linear.app/geoforge3d/issue/FLY-2382/raya回流-summary-写侧触发-缺席检测按-prd-1846-872-的固定节奏6h运行期可改由机制叫-lead)
日期: 2026-09-06
基于: research.md

**Status**: draft(待 Codex design review)
**方案**: exploration §3.1 方案 A · 同一口钟两拍,全部挂在既有 GatePoller summary rider 上

## 0. 目标与验收(与 issue 逐条对应)

| # | issue 验收 | 本 plan 的落点 | 证据 |
|---|---|---|---|
| A1 | 每个 producer Lead inbox 在节奏点收到 `summary_due`,含 period 与上次交付,无需任何人 ping | §2.1 第一拍 | 单测 + 529 房一轮(§6) |
| A2 | Raya #raya 汇报出现「本轮 N/M 份已交;未交:X、Y」,交齐不列 | §2.2 第二拍 payload + 指令文本 | 单测断言文本;真机在 Raya 激活后 |
| A3 | 节奏改动经管理台/flag 生效,无需重启;无新 launchd/crontab | 复用 `summary_absorption_cadence_ms`,零新 flag、零新 daemon | 既有 flag-store-runtime 测试 + 本单 cadence 切换测试 |
| A4 | 529 房或生产首个节奏点真机一轮:至少一个 Lead 由机制触发交付 | §6 验收剧本 | bridge.log + lead_events 行 + PR 链接 |

**不做**(exploration §4):不改 summary 合同 / 命令 / Raya 读侧 merge 逻辑;不激活 Raya、不改 projects.json;不给 Lead 装定时器;不口头通知。

## 1. 架构

```mermaid
sequenceDiagram
  participant GP as GatePoller(每 60s pass)
  participant R as summary-absorption-rider
  participant L as summary-delivery-ledger(gh)
  participant S as StateStore.lead_events
  participant Q as registry.enqueueLeadEvent
  participant P as producer Lead ×11
  participant Y as Raya

  GP->>R: onSummaryAbsorptionTick
  R->>R: cadence=flag(); T=floor(now/cadence)*cadence
  alt now ≥ T(第一拍)
    R->>L: listSummaryPulls(xrliAnnie/raya)(一次)
    loop 每个 producer(projects ∩ hasSummaryDuty)
      R->>S: tryClaimLeadEvent(lead, summary_due:<project>/<lead>:<T>)
      S-->>R: true=新写入 / false=已存在
      R->>Q: 新写入才 enqueue;已存在且 settlement=absent_identity 才重投
      Q->>P: [summary_due] period · last_delivered · 指令
    end
  end
  alt now ≥ T + grace(第二拍)
    R->>L: (复用同一次 gh 结果)
    R->>S: 逐 producer 读 due 的 settlement
    R->>S: tryClaimLeadEvent(raya, summary-absorption:<T>)(roundId 不变)
    R->>Q: summary_absorption_round + producers/absent/undelivered
    Q->>Y: 指令文本含「本轮 N/M 份已交;未交:…」
    R->>R: 无 Raya ⇒ warn 一行,跳过投递
    R->>R: 有 undelivered ⇒ alert inbox_loop_stalled(一 slot 一条)
  end
```

## 2. 设计细节

### 2.1 第一拍 · `summary_due` fan-out

**稳定身份**

| 名字 | 值 | 说明 |
|---|---|---|
| event_type | `summary_due` | 新事件类型;`lead_events.event_type` 自由字符串,无 schema 迁移 |
| event_id | `summary_due:<project>/<lead>:<slotISO>` | `slotISO = new Date(T).toISOString()`;与 `(lead_id, event_id)` 唯一索引一起构成幂等键 |
| session_key | `summary-due` | 常量 `SUMMARY_DUE_SESSION_KEY`;与 `summary-absorption` 并列 |
| execution_id(payload) | 同 event_id | 与 patrol 的「execution_id = sessionKey 类稳定串」惯例一致 |
| issue_id(payload) | `FLY-2382` | 与 rider 现有 `FLY-2131` 同位 |

**producer 名单**(一处真相):

```ts
// summary-producer-roster.ts(新,纯函数)
export function resolveSummaryProducers(
  projects: readonly ProjectEntry[],
  selection: SummaryGranularitySelection,   // readSummaryGranularity() 每轮 call-time
): Array<{ projectName: string; leadId: string }>
// = compileSummaryAssignmentRows(projects→SummaryAssignmentSourceRow[], selection)
//     .leads.filter(r => r.hasSummaryDuty).map(...)
```

- `selection.state === "unselected"` 或 `readSummaryGranularity` 抛错 ⇒ **整轮跳过**(第一、二拍都不发),`log("[summary-due] granularity unselected/invalid: <msg>; skipping slot <T>")`。不吞、不崩。
- `compileSummaryAssignmentRows` 抛 `summary_aggregator_invalid` ⇒ 同上处理(per-project 配置错是 registry 问题)。
- 与 `lead-identity` 投影的一致性:同一算法同一输入 ⇒ 名单 = 各 Lead 启动 env 里的 `FLYWHEEL_LEAD_HAS_SUMMARY_DUTY=1` 集合。测试用生产 projects.json 形状的 fixture 断言 11 人。

**payload**(`HookPayload` 加可选字段,不改既有字段):

```ts
{
  event_type: "summary_due",
  execution_id: eventId,
  issue_id: "FLY-2382",
  project_name: project,
  generated_at: iso(now),
  scheduled_at: iso(T),
  summary_due: {
    slot_start: iso(T),                          // 机器可对的轮边界(UTC)
    period: `${founderLocalIso(T - cadence)}/${founderLocalIso(T)}`,
    cadence_ms: cadence,
    last_delivered:                              // 来自 gh ledger
      | { status: "found", pr: number, url, state: "OPEN"|"MERGED"|"CLOSED", updated_at }
      | { status: "none" }                       // 该 Lead 从未交过
      | { status: "unavailable", reason },       // gh 失败;照发
    command_hint: `flywheel-comm summary --file <your-summary.md> --project ${project} --period ${period}`,
  },
}
```

**渲染**:新 `formatSummaryDue(env)`(`hook-payload.ts`,与 `formatPatrolTick` 并列),`mailbox-lead-runtime.ts` 与 `commdb-lead-runtime.ts` 的 `formatEnvelope` **各加一条**分派;测试断言两处输出逐字相等。文本(中文,固定骨架,项目/Lead 名经 `canonicalPatrolToken` 同款白名单 `[A-Za-z0-9._-]` 过滤后插入):

```
[Event #<seq>] summary_due
ID: summary_due:<project>/<lead>:<slotISO> | Issue: FLY-2382
[summary_due] 到 summary 节奏点(每 <cadence 人读>;founder 可在管理台改)。
Period: <period>
上次交付: PR #<n> (<state>, <updated_at>) | 从未交过 | 不可得(<reason>)
---
1. 写本 period 的 summary(Facts + Judgment;合同见 Raya 仓 summaries/README.md)。
2. 运行:flywheel-comm summary --file <your-summary.md> --project <project> --period <period>
3. 没有新事实与判断可写时可以不交(PRD §6.3)。未交会在 Raya 的轮报里以「未交」出现——那是可见性,不是催促。
4. 这是唯一的节奏来源;不要自建定时器(R4)。
Timestamp: <ts> | Session Key: summary-due
```

**幂等与重投**(照抄 patrol):
- `store.tryClaimLeadEvent(lead, eventId, "summary_due", payload, "summary-due")` 为 true ⇒ `enqueueLeadEvent(envelopeFromJournalRow)`。
- false ⇒ 读既有行,`inspectDeliveryState(project, canonicalLeadEventDeliveryId(envelope))`;仅 `absent_identity` 时重投(队列丢了身份);其他状态不动。
- `enqueueLeadEvent` 抛 `No runtime registered` ⇒ 该 Lead 记 `log` + 计入本轮 `undelivered`(第二拍读到 `absent_identity` 也会归入),不影响其他 Lead。

### 2.2 第二拍 · 缺席计算与 Raya 轮事件

**触发**:`now ≥ T + grace`,`grace = min(SUMMARY_DUE_GRACE_MS(30min), floor(cadence / 2))`。roundId **不变** = `summary-absorption:<slotISO(T)>`;`tryClaimLeadEvent` 为 true 才 enqueue(现 rider 每 60s `appendLeadEvent`+enqueue 同 id,靶向队列去重——本单顺手改为 claim 语义,行为等价但少一次无效 enqueue;测试钉「同 slot 只 enqueue 一次」)。

**已交判据**(纯函数 `classifyRound(producers, pulls, T, cadence, grace)`):
- `delivered = pulls.some(p => p.project===project && p.lead===lead && max(createdAt, updatedAt) ∈ [T − cadence, T + grace))`。OPEN/MERGED/CLOSED 都算交过;读没读是 Raya 的账。
- `due_delivery`:读该 Lead 本 slot `summary_due` 行的 settlement:`live` 且 `state ∈ {ACKED}` 或 `deliveredAt != null` ⇒ `delivered`;`absent_identity | torn_identity | live.QUEUED/LEASED/DEAD | archived_nonterminal` ⇒ `undelivered`;查询抛错 ⇒ `unknown`。**已交的 Lead 不再报 undelivered**(结果已经证明他知道了)。

**payload 增量**(旧字段一个不动):

```ts
producers: Array<{ project, lead, delivered: boolean,
                   due_delivery: "delivered"|"undelivered"|"unknown",
                   last_pr?: { number, url, state, updated_at } }>,
producer_count: M, delivered_count: N,
absent: string[],        // `${project}/${lead}`,delivered=false 且 due_delivery≠undelivered
undelivered: string[],   // delivered=false 且 due_delivery=undelivered
delivery_ledger: "ok" | "unavailable",
```

**指令文本追加**(接在现有 `summary` 之后;Raya 只转述):

| 情况 | 追加行 |
|---|---|
| N < M 且 absent 非空 | `本轮 ${N}/${M} 份已交;未交:${absent.map(短名).join("、")}` |
| N === M | 追加 `本轮 ${M}/${M} 份已交。`(不列名) |
| undelivered 非空 | `未送达(机制问题,归 infra):${undelivered…}` |
| ledger unavailable | `本轮交付状态不可得(gh 不可用),只报吸收不报缺席。`(不写 N/M) |

短名 = leadId(同项目内唯一,跨项目无重名;若将来重名则显示 `project/lead`——函数里按重名检测切换)。

**Raya 缺席**:`resolveRaya` 为 null ⇒ `log("[summary-due] slot <T>: ${N}/${M} delivered; absent=[…]; undelivered=[…]; no Raya recipient registered (FLY-2131 activation pending)")`,不投、不 alert。这行是 Raya 激活前唯一的可见痕迹,写进边界。

**undelivered 告警**:每个 undelivered 的 Lead 一条,复用 `inbox_loop_stalled`:`eventId = summary_due_undelivered:<project>/<lead>:<slotISO>`,title `summary_due not delivered to Lead inbox`,body 含 settlement kind/state;`sessionKey: "summary-due"`。alert sink 不可用 ⇒ warn(与 patrol 同)。**一 slot 一条**由 eventId 保证。

### 2.3 gh ledger(`bridge/summary-delivery-ledger.ts`,新)

```ts
export interface SummaryPull { number; url; state; project; lead; createdAt; updatedAt }
export interface SummaryLedgerResult = { status: "ok", pulls: SummaryPull[] } | { status: "unavailable", reason }
export async function listSummaryPulls(run: CommandRunner, repo = "xrliAnnie/raya"): Promise<SummaryLedgerResult>
```

- `gh pr list --repo <repo> --state all --limit 500 --json number,url,state,createdAt,updatedAt,headRefName`;`execFile` `timeout: 30_000`,`maxBuffer 16MB`;`cwd` = Bridge 进程 cwd(不需要仓)。
- 解析:`headRefName` 必须匹配 `^summary/([A-Za-z0-9][A-Za-z0-9._-]*)/([A-Za-z0-9][A-Za-z0-9._-]*)/[0-9a-f]{16}$`,不匹配跳过(不抛);任一时间戳 `Date.parse` 失败 ⇒ 整体 `unavailable`("malformed gh output")——宁可本轮不报缺席,不报错的缺席。
- 每轮一次调用,两拍共用(pass 内 memo)。
- 边界:`--limit 500` 是窗口;Raya 仓 PR > 500 后 `last_delivered` 可能显示更旧的一张,本轮判定不受影响(最近的总在窗口内)。

### 2.4 规则文本(`lead-rules-base/summary-inflow.md`)

在 `## Your obligation` 后加:

```
## The due signal (FLY-2382)

The cadence reaches you as a Bridge event `[summary_due]` in your inbox — that
event is the founder-configured cadence arriving, not a reminder someone typed.
On receipt: write the summary for the period the event names, then run the
shared command with that exact `--period`. If there is nothing factual and no
judgment to add for that period you may not deliver (PRD §6.3); Raya's round
report will list you under 「未交」, which is visibility for the founder, not a
nag at you. `[summary_due]` is the only cadence source: still no local timers,
cron, or launchd (founder-only-authority R4).
```

并把第 12–14 行的「do not invent one, add reminders」改写为「the cadence is delivered to you by `[summary_due]`; do not invent one or add your own reminders」。bundle 测试只断文件在/不在,不需改。

### 2.5 接线(`bridge/plugin.ts:9892`)

```ts
const summaryAbsorptionPass = createSummaryAbsorptionPass({
  projects, store,
  enqueueLeadEvent: (envelope) => registry.enqueueLeadEvent(envelope),
  cadenceMs: () => storeSummaryAbsorptionCadenceMs(flagStore),
  // 新增
  readGranularity: () => readSummaryGranularity(),
  inspectDeliveryState: (project, deliveryId) => leadInboxRuntime.getLeadEventSettlement(project, deliveryId),
  listSummaryPulls: () => listSummaryPulls(execFileRunner),
  founderLocalIso: (ms) => founderLocalIso(new Date(ms)),
  alert: async (input) => leadPendingAlertHolder.current?.alert(input) ?? console.warn(...),
  log: (m) => console.warn(m),
});
```

`store` 的 Pick 扩为 `appendLeadEvent | getLeadEventBySeq | tryClaimLeadEvent | getLeadEventByLeadAndId`(后者若无则新增一条 `SELECT * … WHERE lead_id=? AND event_id=?`,只读)。

### 2.6 迁移 / 回滚 / 兼容

- **无 schema 迁移**:只在既有 `lead_events` 写两类 event_type。
- **无新 flag / env / plist**。
- **Raya 读侧兼容**:`summary_absorption_round` 旧字段与 roundId 语义不变;新字段可选。Raya 的 FLY-2131 身份合同不需改(转述一行文本即可);如 Raya 侧想机器读 `absent[]`,字段已在。
- **回滚边界**:revert 本 PR ⇒ 回到「读侧钟、写侧无」;已写入的 `summary_due` 行留在 lead_events 无害(与其他历史 event_type 同)。
- **Lead 侧兼容**:未升级 rules bundle 的 Lead 收到 `[summary_due]` 也能按文本行动(文本自足);升级后 rules 只是解释同一事件。

### 2.7 负向守卫(实现必带的测试)

| 守卫 | 断言 |
|---|---|
| G1 granularity unselected | 两拍都不发;一行 warn;`appendLeadEvent`/`tryClaimLeadEvent` 零调用 |
| G2 同 slot 重跑 pass(60s×N) | 每个 producer `enqueueLeadEvent` 恰一次;settlement `live.ACKED` 时不重投;`absent_identity` 时重投一次 |
| G3 Bridge 重启跨 slot 中段 | 重启后同 slot:claim=false ⇒ 不重复;新 slot ⇒ 新 id |
| G4 cadence 运行期改小/改大 | 下一 pass 用新 cadence 算 slot;旧 slot id 不再被引用;`grace = min(30min, cadence/2)`(60s cadence ⇒ 30s) |
| G5 gh 失败 | 第一拍照发,`last_delivered.status="unavailable"`;第二拍 `delivery_ledger="unavailable"`,文本为「不可得」行,**不出现** N/M |
| G6 gh 返回非 summary 分支 / 畸形 headRefName | 跳过不抛;时间戳畸形 ⇒ 整体 unavailable |
| G7 Raya 未注册 | 第一拍照发;第二拍 warn 一行,不投、不 alert |
| G8 `enqueueLeadEvent` 抛 No runtime | 只影响该 Lead;第二拍该 Lead 归 undelivered;其他 Lead 正常 |
| G9 已交但 due 未送达 | 不进 undelivered、不 alert(结果优先) |
| G10 exempt / aggregator(per-lead 模式)/ recipient | 不在 producer 名单;per-project 模式下只有 aggregator 在名单 |
| G11 文本注入 | project/lead 含非白名单字符 ⇒ 过滤后渲染;payload 原值不变 |
| G12 formatter parity | mailbox 与 commdb 两条分派输出逐字相等 |
| G13 DST 边界 | `founderLocalIso` 在 2026-11-01 PDT→PST 前后给出正确 offset(若既有测试已盖到则引用之) |

## 3. 文件清单

| 动作 | 文件 |
|---|---|
| 改 | `packages/teamlead/src/bridge/summary-absorption-rider.ts`(两拍逻辑;deps 扩展;claim 语义) |
| 新 | `packages/teamlead/src/bridge/summary-producer-roster.ts`(名单纯函数) |
| 新 | `packages/teamlead/src/bridge/summary-delivery-ledger.ts`(gh 列 PR 只读) |
| 新 | `packages/teamlead/src/bridge/summary-round-classify.ts`(`classifyRound` 纯函数 + 文本行生成) |
| 改 | `packages/teamlead/src/bridge/hook-payload.ts`(`HookPayload.summary_due?`、`producers?` 等可选字段;`formatSummaryDue`) |
| 改 | `packages/teamlead/src/bridge/mailbox-lead-runtime.ts`、`commdb-lead-runtime.ts`(分派一行) |
| 改 | `packages/teamlead/src/StateStore.ts`(若无:`getLeadEventByLeadAndId` 只读查询) |
| 改 | `packages/teamlead/src/bridge/plugin.ts`(接线 §2.5) |
| 改 | `packages/teamlead/lead-rules-base/summary-inflow.md`(§2.4) |
| 新/改 测试 | `bridge/__tests__/summary-absorption-rider.test.ts`(扩)、`summary-producer-roster.test.ts`、`summary-delivery-ledger.test.ts`、`summary-round-classify.test.ts`、`hook-payload` formatter parity 测试 |
| 新 | `engineering/doc/milestones/FLY-2382.md`(ship 时) |

不碰:`flywheel-comm/src/summary-*.ts`、`commands/summary.ts`、raya 仓、`projects.json`、feature-flag registry、kind-contract。

## 4. 实施顺序(TDD,每块 RED→GREEN→REFACTOR;`pnpm lint` + `pnpm -r build` + 聚焦 vitest 全绿才进下一块;**排除 `**/tmux-viewer.macos.test.ts`**)

| # | 块 | 产出 | 主要测试 |
|---|---|---|---|
| 1 | roster | `resolveSummaryProducers` | 生产形状 fixture ⇒ 11 人;per-project ⇒ aggregator;unselected 抛出被上层接住(G1、G10) |
| 2 | ledger | `listSummaryPulls` | 用录制的 gh JSON(含今晚 #15–#24 形状)⇒ 分桶;畸形分支跳过;畸形时间 ⇒ unavailable;非零退出 ⇒ unavailable(G5、G6) |
| 3 | classify | `classifyRound` + 文本行 | 10/11 today ⇒ `absent=[growth/mufasa-lead]`,文本「本轮 10/11 份已交;未交:mufasa-lead」;交齐 ⇒ 无名单;unavailable ⇒ 「不可得」行;G9 |
| 4 | formatter | `formatSummaryDue` + 两 runtime 分派 | 逐字 parity(G12);白名单过滤(G11);三种 last_delivered 渲染 |
| 5 | rider 两拍 | rider 改造 | 时间推进 harness:T−1 无;T 发 11 条一次;T+grace−1 无轮;T+grace 发轮 + payload;G2/G3/G4/G7/G8;alert 一 slot 一条 |
| 6 | 接线 + 规则 | plugin.ts、summary-inflow.md | 编译;bundle 测试仍绿;`pnpm test:packages:run`(排除 macos 视图用例) |
| 7 | 文档 | milestone 文件、progress | — |

## 5. 风险与应对

| 风险 | 应对 |
|---|---|
| 8/11 producer 的 inbox 通路在生产从未证明可用(exploration §1.4) | 第二拍把 undelivered 单列 + alert;真机验收(§6)选一个**已证可达**的 Lead(flywheel-eng-lead / flywheel-product-lead / belle-lead)做 A4,其余 Lead 的可达性作为本单**发现**交给 infra,不冒充已验证 |
| Raya 未激活,A2 真机无法在 #raya 出现 | 单测钉文本;真机以 bridge.log 的 `[summary-due] slot … absent=[…]` 行 + Raya 轮事件 payload(若已注册)为证;#raya 出现归 FLY-2131 激活后的一轮,边界写明 |
| gh 速率/网络抖动 | 每 60s pass 只在 slot 首次进入与 T+grace 各调一次(pass 内 memo + slot 级缓存:同 slot 已成功列过就不再列;失败下个 pass 重试直到拿到或 slot 结束) |
| epoch 对齐的 6h 边界落在 founder 睡眠时段(05:00 PDT) | 不归本单;founder 若要改相位可先改 cadence(§8.7.2 只定周期);记进边界 |
| Codex Lead(mufasa)socket 投递曾多次 stalled | 同上:undelivered 可见 + alert;不在本单修 socket |

## 6. 验收剧本(A4:真机一轮)

529 房(或生产首个节奏点,由 Lead 定;不投紧急重启票,走班车部署):
1. 部署后等待下一个 slot 边界(或在 529 房把 cadence 调到 10 分钟)。
2. 证据①:`sqlite3 -readonly teamlead.db "select lead_id, delivered_at from lead_events where event_type='summary_due' and event_id like '%:<slotISO>'"` ⇒ 11 行,已证可达 Lead 的 `delivered_at` 非空。
3. 证据②:该 Lead 的 inbox 出现 `[summary_due]` 文本;Lead 据此运行命令开出 PR(链接)。
4. 证据③:T+grace 后 bridge.log 出现 `[summary-due] slot <T>: N/M delivered; absent=[…]`(Raya 未注册时)或 lead_events 出现 `summary_absorption_round` 行且 payload.producers 长度 11。
5. 证据④(管理台):把 cadence 改为另一个值,下一 pass 的日志 slot 边界随之变化,无重启。

## 7. Codex design review 处理记录

(待填)
