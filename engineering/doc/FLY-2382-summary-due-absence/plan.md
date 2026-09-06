# FLY-2382 summary 写侧触发 + 缺席检测 — 实施计划
Issue: FLY-2382 (https://linear.app/geoforge3d/issue/FLY-2382/raya回流-summary-写侧触发-缺席检测按-prd-1846-872-的固定节奏6h运行期可改由机制叫-lead)
日期: 2026-09-06
基于: research.md

**Status**: draft(Codex design review R1 = CHANGES REQUESTED,6 项全部采纳;见 §7)
**方案**: exploration §3.1 方案 A · 同一口钟两拍,全部挂在既有 GatePoller summary rider 上

## 0. 目标与验收(与 issue 逐条对应)

| # | issue 验收 | 本 plan 的落点 | 证据 | 状态口径 |
|---|---|---|---|---|
| A1 | 每个 producer Lead inbox 在节奏点收到 `summary_due`,含 period 与上次交付,无需任何人 ping | §2.2 第一拍 | 单测 + 真机一轮(§6) | 本单可关 |
| A2 | Raya #raya 汇报出现「本轮 N/M 份已交;未交:X、Y」,交齐不列 | §2.3 第二拍 payload + 指令文本 | 单测钉文本;**真机 #raya 出现依赖 FLY-2131 activation(生产 Raya 未注册,exploration §1.2)** | **rollout prerequisite**:本单可合入,但 A2 只能在 Raya 激活后的第一个真实轮验收;本单不得宣称 A2 已完成 |
| A3 | 节奏改动经管理台/flag 生效,无需重启;无新 launchd/crontab | 复用 `summary_absorption_cadence_ms`,零新 flag、零新 daemon | 既有 flag-store-runtime 测试 + 本单热切换测试(G4) | 本单可关 |
| A4 | 529 房或生产首个节奏点真机一轮:至少一个 Lead 由机制触发交付 | §6 验收剧本 | teamlead.db 行 + inbox 文本 + PR 链接 | 本单可关(选已证可达的 Lead) |

**不做**(exploration §4):不改 summary 合同 / `flywheel-comm summary` 命令 / Raya 读侧 merge 逻辑;不激活 Raya、不改 projects.json;不给 Lead 装定时器;不口头通知。

## 1. 架构

```mermaid
sequenceDiagram
  participant GP as GatePoller(每 60s pass)
  participant R as summary-absorption-rider
  participant SL as StateStore.summary_due_slots
  participant L as summary-delivery-ledger(gh)
  participant S as StateStore.lead_events
  participant Q as registry.enqueueLeadEvent
  participant P as producer Lead ×11
  participant Y as Raya

  GP->>R: onSummaryAbsorptionTick
  R->>R: cadence=flag(); T=floor(now/cadence)*cadence
  alt 无 slot 行 T 且 now < T+grace(第一拍:开 slot)
    R->>L: 快照① listSummaryPulls(仅供 last_delivered)
    R->>SL: insert slot T {cadence,grace,period,producers[],opened_at}
    loop 每个 producer
      R->>S: appendLeadEvent(lead, summary_due:…:<T>)
      R->>Q: 新行 ⇒ enqueue;旧行且 settlement=absent_identity ⇒ 重投
      Q->>P: [summary_due] period · last_delivered · 指令
    end
  else 无 slot 行 T 且 now ≥ T+grace
    R->>SL: insert slot T {status: missed}(一次,只 log)
  end
  loop 每个 status=open 且 now ≥ slot_start+grace 的 slot(第二拍:结算)
    R->>L: 快照② listSummaryPulls(新鲜,随后冻结进 settle_result)
    R->>S: 逐 producer 读 due 的 settlement
    R->>R: classifyRound → delivered/absent/undelivered/unknown
    R->>S: appendLeadEvent(raya, summary-absorption:<slot>)+enqueue(既有 write-ahead 语义不变)
    Q->>Y: 指令文本含「本轮 N/M 份已交;未交:…」
    R->>SL: update slot status=settled, settle_result_json
    R->>R: 无 Raya ⇒ 一行 warn(随 settled 只出一次)
    R->>R: undelivered 非空 ⇒ 一条聚合 alert(一 slot 一条)
  end
```

## 2. 设计细节

### 2.1 slot 生命周期(R1-1)—— 持久化在新表 `summary_due_slots`

一个 slot 一旦开始就是一件**有身份、要结算的事**,不能只靠「当前 `floor(now/cadence)`」重算:cadence 下限 60s 与 pass 间隔 60s 同相时当前 slot 永远「太新」,第二拍永不发生;热切换 cadence 会遗弃已 fan-out 未结算的旧 slot;冷启动会在同一 pass 对很早的 T 先叫再判缺席。

**表**(`StateStore` 启动 `CREATE TABLE IF NOT EXISTS`,与既有表同一迁移方式;无数据迁移):

```sql
CREATE TABLE IF NOT EXISTS summary_due_slots (
  slot_start_ms     INTEGER PRIMARY KEY,
  cadence_ms        INTEGER NOT NULL,
  grace_ms          INTEGER NOT NULL,
  period            TEXT    NOT NULL,   -- founderLocalIso(T-cadence)/founderLocalIso(T)
  granularity       TEXT    NOT NULL,   -- per-lead | per-project
  producers_json    TEXT    NOT NULL,   -- [{project, lead}] 开 slot 时的名单快照
  status            TEXT    NOT NULL CHECK(status IN ('open','settled','missed')),
  opened_at         TEXT    NOT NULL,
  settled_at        TEXT,
  settle_result_json TEXT               -- classifyRound 的冻结结果(含快照②的 PR 列表摘要)
);
```

**StateStore API**(只读/单写,均带单测):`getSummaryDueSlot(slotStartMs)`、`openSummaryDueSlot(row)`(INSERT OR IGNORE 语义,返回是否新建)、`markSummaryDueSlotMissed(slotStartMs, ...)`、`listOpenSummaryDueSlots()`、`settleSummaryDueSlot(slotStartMs, settledAt, resultJson)`(仅 `status='open'` 行可转 settled)。

**每 pass 的算法**:

1. `cadence = flag()`;`grace = min(SUMMARY_DUE_GRACE_MS = 30min, floor(cadence/2))`;`T = floor(now/cadence)*cadence`。
2. **开 slot**:若 `getSummaryDueSlot(T)` 为空:
   - `now < T + grace` ⇒ 读 granularity/名单(失败 ⇒ 本 pass 不开 slot、不结算,warn 一行;下个 pass 重试;若一直失败直到 `T+grace` 则走 missed),`openSummaryDueSlot({...status:'open'})`,然后第一拍 fan-out(§2.2)。
   - `now ≥ T + grace` ⇒ `markSummaryDueSlotMissed(T)` + warn `[summary-due] slot <T> missed (bridge started/ resumed after grace); no due sent, no absence judged`。**不补叫、不补判**——对一个已经过去的 period 叫人是噪音,判缺席是冤枉。
3. **结算**:对 `listOpenSummaryDueSlots()` 中每个 `now ≥ slot_start + grace` 的 slot 执行第二拍(§2.3),用该行**自己记录的** cadence/grace/period/producers,与当前 flag 无关。
4. 第一拍的重投检查(§2.2 末)对**所有 open slot** 做,不只当前 T。

**热切换语义**(写进 G4 测试):改 cadence 只影响**新** slot 的开启;已开 slot 按自己的参数结算;新旧 slot 可能重叠(6h→1h 时旧 6h slot 与多个 1h slot 并存),各自独立结算,各自独立 roundId。改小到 60s 时 grace=30s,pass 间隔 60s:slot T 在下一 pass(now≥T+60s>T+30s)结算——不会永久漏。

### 2.2 第一拍 · `summary_due` fan-out

**稳定身份**

| 名字 | 值 | 说明 |
|---|---|---|
| event_type | `summary_due` | 新事件类型;`lead_events.event_type` 自由字符串 |
| event_id | `summary_due:<project>/<lead>:<slotISO>` | `slotISO = new Date(T).toISOString()`;与 `(lead_id, event_id)` 唯一索引构成幂等键 |
| session_key | `summary-due` | 常量 `SUMMARY_DUE_SESSION_KEY` |
| execution_id(payload) | 同 event_id | 与 patrol 惯例一致 |
| issue_id(payload) | `FLY-2382` | |

**producer 名单**(一处真相,开 slot 时快照进 `producers_json`):

```ts
// bridge/summary-producer-roster.ts(新,纯函数)
export function resolveSummaryProducers(
  projects: readonly ProjectEntry[],
  selection: SummaryGranularitySelection,
): Array<{ projectName: string; leadId: string }>
// = compileSummaryAssignmentRows(projects → SummaryAssignmentSourceRow[], selection)
//     .leads.filter(r => r.hasSummaryDuty)
```

- `readSummaryGranularity()` 每次开 slot 时 call-time 读;`unselected`/`SummaryConfigError`/`summary_aggregator_invalid` ⇒ 本 pass 不开 slot,warn 一行(含 slotISO 与错误码),不崩。同一 slot 反复失败会每 60s 重复 warn 直到 missed——这是「配置坏了」应该持续可见的情形,接受;写进 G1。

**写入与投递(R1-2:保留 write-ahead + 幂等 enqueue,照抄 patrol)**

```
seq = store.appendLeadEvent(lead, eventId, "summary_due", payload, "summary-due")   // 冲突返回旧 seq
row = store.getLeadEventBySeq(seq)
if (row.created_at 是本次新写入 —— 用 tryClaimLeadEvent 判定"新行") → enqueueLeadEvent(envelope(row))
else settlement = inspectDeliveryState(project, canonicalLeadEventDeliveryId(envelope(row)))
     if settlement.kind === "absent_identity" → enqueueLeadEvent(envelope(row))     // 队列丢身份 ⇒ 补投
```

- 崩在 append 与 enqueue 之间:下一 pass claim=false,settlement=`absent_identity`(队列里没有),补投。**不存在「已 claim 未入队且永不补投」的状态**。
- `enqueueLeadEvent` 抛(`No runtime registered` / renderer 抛)⇒ 该 Lead log 一行,其他 Lead 继续;下一 pass 同样经 absent_identity 路径重试。
- 重投检查在**每个 open slot** 上做(不只当前 T),直到 slot 结算。

**payload**(`HookPayload` 加可选字段 `summary_due?`,不改既有字段):

```ts
summary_due: {
  slot_start: iso(T), cadence_ms, period,
  last_delivered:
    | { status: "found", pr: number, url, state: "OPEN"|"MERGED"|"CLOSED", period: string|null, updated_at }
    | { status: "none" }
    | { status: "unavailable", reason: string /* 已规范化+截 200 码点 */ },
  command_hint: `flywheel-comm summary --file <your-summary.md> --project ${project} --period ${period}`,
}
```

`last_delivered` 来自开 slot 时的快照①:该 Lead 前缀 `summary/<project>/<lead>/` 下 `createdAt` 最大的一张;其 `period` 从标题 `Summary: <project> · <period>` 解析(解析失败为 null)。

**渲染**:`formatSummaryDue(env)`(`hook-payload.ts`,与 `formatPatrolTick` 并列);`mailbox-lead-runtime.ts` 与 `commdb-lead-runtime.ts` 的 `formatEnvelope` 各加一条分派;测试断言两处逐字相等。所有插值(project/lead/period/reason/url)先过白名单 `[A-Za-z0-9._:/+-]`(url 另用 `new URL()` 校验 host === `github.com`),不合规则替换为 `?`;payload 原值不动。文本:

```
[Event #<seq>] summary_due
ID: summary_due:<project>/<lead>:<slotISO> | Issue: FLY-2382
[summary_due] 到 summary 节奏点(每 <cadence 人读>;founder 可在管理台改)。
Period: <period>
上次交付: PR #<n> (<state>, period <p>, <updated_at>) | 从未交过 | 不可得(<reason>)
---
1. 写本 period 的 summary(Facts + Judgment;合同见 Raya 仓 summaries/README.md)。
2. 运行:flywheel-comm summary --file <your-summary.md> --project <project> --period <period>
   （请原样使用上面的 period;机制按它识别「本轮已交」。）
3. 没有新事实与判断可写时可以不交(PRD §6.3)。未交会在 Raya 的轮报里以「未交」出现——那是可见性,不是催促。
4. 这是唯一的节奏来源;不要自建定时器(R4)。
Timestamp: <ts> | Session Key: summary-due
```

### 2.3 第二拍 · 结算与 Raya 轮事件

**触发**:对每个 `status='open'` 且 `now ≥ slot_start + grace_ms` 的 slot 行。

**快照②(R1-3)**:结算时**重新**调用 `listSummaryPulls()`;结果冻结进 `settle_result_json`。快照①只服务 `last_delivered`,两拍**不**共用。

**已交判据(R1-3:绑定 period 的权威身份)**——纯函数 `classifyRound(slot, pulls, settlements)`:

- 期望分支 `expectedBranch = summaryDeliveryBranch({ project, author: lead, period: slot.period })`,算法即 `summary-delivery.ts` 的 `branchFor`(`summary/<project>/<lead>/<sha256(JSON{project,author,period})[:16]>`)。**本单把该纯函数提到 `flywheel-comm/src/summary-contract.ts` 导出并让 `summary-delivery.ts` 调用它**(行为不变;测试用今晚真实 PR 钉死:`{growth, reflection-lead, "2026-09-06/2026-09-06"} → summary/growth/reflection-lead/269dc60b2dd3fb93`,已本机复现)。
- `delivered = "exact"` ⇔ 存在 PR `headRefName === expectedBranch`(任何 state、任何时间——Lead 提前交也算)。
- `delivered = "other_period"` ⇔ 无 exact,但存在 PR 前缀 `summary/<project>/<lead>/` 且 **`createdAt` ∈ [T − cadence, T + grace)**(用 createdAt 不用 updatedAt:旧 period PR 被 comment/merge 不会误判)。计已交,但 payload 标 `period_match: "other"` 并把该 PR 的标题 period 带给 Raya。
- 否则 `delivered = "none"`。
- ledger `unavailable` ⇒ 每人 `delivered = "unknown"`。

**due 投递真值表(R1-4:穷尽 `MailboxSettlement`)**:

| settlement | due_delivery |
|---|---|
| `absent_identity`、`torn_identity` | `undelivered` |
| `live` / `archived_nonterminal`,state `QUEUED` 或 `LEASED` 且 `deliveredAt == null` | `undelivered` |
| `live` / `archived_nonterminal`,state `LEASED` 且 `deliveredAt != null`(已写进 Lead 收件箱,待 ACK) | `delivered` |
| `live` / `archived_terminal`,state `ACKED` | `delivered` |
| `live` / `archived_terminal`,state `DEAD` | `undelivered` |
| `inspectDeliveryState` 抛 / lead_events 无该行 | `unknown` |

**分类(fail-closed)**:

```
delivered ∈ {exact, other_period}      → delivered[]      (不看 due_delivery;结果优先)
delivered = none ∧ due_delivery = delivered   → absent[]
delivered = none ∧ due_delivery = undelivered → undelivered[]
delivered = none ∧ due_delivery = unknown     → delivery_unknown[]   (绝不进 absent)
delivered = unknown(ledger 不可得)           → 不分类;counts 省略;absent/undelivered 不产出
```

**payload 增量**(旧字段一个不动,新字段全可选):

```ts
round_ledger: "ok" | "unavailable",
producer_count?: M,                 // ledger ok 时才有
delivered_count?: N,
producers?: Array<{ project, lead,
  delivered: "exact"|"other_period"|"none"|"unknown",
  period_match?: "exact"|"other", delivered_pr?: { number, url, state, title_period: string|null },
  due_delivery: "delivered"|"undelivered"|"unknown" }>,
absent?: string[], undelivered?: string[], delivery_unknown?: string[],
```

**指令文本追加**(接在既有 `summary` 之后;Raya 只转述):

| 情况 | 追加行 |
|---|---|
| ledger ok,absent 非空 | `本轮 ${N}/${M} 份已交;未交:${absent 短名…}` |
| ledger ok,absent 空,N === M | `本轮 ${M}/${M} 份已交。` |
| ledger ok,absent 空,N < M(全是 undelivered/unknown) | `本轮 ${N}/${M} 份已交;无人「未交」——差额见下。` |
| undelivered 非空 | `未送达(机制问题,已告警):${…}` |
| delivery_unknown 非空 | `送达状态不可得(不计未交):${…}` |
| ledger unavailable | `本轮交付状态不可得(gh 不可用),只报吸收不报缺席。`(无 N/M) |
| 有 other_period | `按其他 period 交付:${lead}(${title_period})` |

短名 = leadId;若同 slot 内 leadId 跨项目重名则显示 `project/lead`。

**Raya 轮事件写入(R1-2:不改 FLY-2131 语义)**:保持现有 `appendLeadEvent` + `enqueueLeadEvent(envelope)` 的 write-ahead 流程与既有测试(append 成功、enqueue 崩溃、下一 pass 重放)。差别只有两点:(a) 触发条件从「当前 slot」改为「open slot 且过 grace」;(b) payload 加字段。roundId 仍 `summary-absorption:<slotISO>`。

**结算落账**:`settleSummaryDueSlot(T, now, resultJson)` 在 enqueue 成功后执行;若 enqueue 抛,slot 保持 open,下一 pass 重放(与 Raya 轮的既有恢复语义一致)。Raya 未注册(`resolveRaya` null):跳过 append/enqueue,**直接 settle** 并 warn 一行 `[summary-due] slot <T> settled without Raya recipient: N/M delivered; absent=[…]; undelivered=[…]; unknown=[…] (FLY-2131 activation pending)`——因为 settled 只发生一次,这行也只出一次(R1-5)。

**undelivered 告警(R1-6:明确 owner / severity / 扇出)**:
- kind 复用 `inbox_loop_stalled`(owner `founder_direct`,arc `none_escalate`,`kind-contract.ts:94`)——语义就是「Bridge→Lead inbox 通路没送到」。**明确后果**:这是 founder-facing 告警;在 8/11 producer 通路未证明可达的现状下,首个生产 slot 很可能列出多名 Lead。这正是本单要暴露的静音失败,不做隐藏。
- **聚合**:一 slot 一条,`eventId = summary_due_undelivered:<slotISO>`,`leadId: "patrol-roster:summary-due"`(沿用 patrol 的 fleet-scoped 写法),`projectName: FLEET_ALERT_PROJECT`,`severity: "warning"`(不触发 DM),title `summary_due not delivered to N Lead inbox(es)`,body 逐行 `project/lead: <settlement kind/state>`。`delivery_unknown` 不告警(只在轮报里可见)。
- alert sink 缺失 ⇒ warn(与 patrol 同)。

### 2.4 gh ledger(`bridge/summary-delivery-ledger.ts`,新)

```ts
export type SummaryLedgerResult =
  | { status: "ok"; pulls: SummaryPull[]; fetchedAt: string }
  | { status: "unavailable"; reason: string };
export interface SummaryPull { number: number; url: string; state: "OPEN"|"MERGED"|"CLOSED";
  project: string; lead: string; headRefName: string; titlePeriod: string|null;
  createdAt: number; updatedAt: number }   // epoch ms

export type ExecFileAsync = (file: string, args: string[],
  opts: { timeout: number; maxBuffer: number; cwd?: string }) => Promise<{ stdout: string; stderr: string }>;
export async function listSummaryPulls(exec: ExecFileAsync, repo = "xrliAnnie/raya"): Promise<SummaryLedgerResult>
```

- 命令:`gh pr list --repo <repo> --state all --limit 500 --json number,url,state,title,createdAt,updatedAt,headRefName`;`timeout 30_000`、`maxBuffer 16MB`;注入 `plugin.ts:900` 的 `execFileP`。
- **严格校验**:顶层必须是数组;每项对象;`number` 正整数;`state ∈ {OPEN,MERGED,CLOSED}`;`url` 经 `new URL()` 且 host `github.com`;`headRefName` 字符串 ≤ 256;`createdAt/updatedAt` 可 `Date.parse`。任一项校验失败 ⇒ 整体 `unavailable("malformed gh output: <field>")`(宁可本轮不判,不判错)。
- 只保留 `headRefName` 匹配 `^summary/([A-Za-z0-9][A-Za-z0-9._-]*)/([A-Za-z0-9][A-Za-z0-9._-]*)/[0-9a-f]{16}$` 的行;不匹配的(如 `fly-2249-bargein-v2`)静默跳过。
- `titlePeriod` = 标题匹配 `^Summary: <project> · (.+)$` 的捕获,否则 null。
- 失败 `reason` 规范化:去掉 ANSI/换行、截 200 码点;stderr 不得原样进 Lead prompt。
- 边界:`--limit 500` 是窗口;超过后只影响 `last_delivered` 的「最近一张」,本轮判定用 exact branch 不受影响(该 PR 若存在必在最近)。

### 2.5 规则文本(`lead-rules-base/summary-inflow.md`)

在 `## Your obligation` 后加 `## The due signal (FLY-2382)`:节奏以 Bridge 事件 `[summary_due]` 送达;收到即写并**原样使用事件里的 `--period`**(机制据此识别已交);没有事实与判断可写时可以不交(§6.3),未交会以「未交」出现在 Raya 轮报里——可见性不是催促;`[summary_due]` 是唯一节奏来源,仍禁止本地 timer/cron/launchd(R4)。并把「do not invent one, add reminders」改写为「the cadence is delivered to you by `[summary_due]`; do not invent one or add your own reminders」。bundle 测试只断文件在/不在,不需改。

### 2.6 接线(`bridge/plugin.ts:9892`)

```ts
const summaryAbsorptionPass = createSummaryAbsorptionPass({
  projects, store,                                   // store Pick 扩:tryClaimLeadEvent、summary_due_slots 五个方法
  enqueueLeadEvent: (envelope) => registry.enqueueLeadEvent(envelope),
  cadenceMs: () => storeSummaryAbsorptionCadenceMs(flagStore),
  readGranularity: () => readSummaryGranularity(),                      // flywheel-comm/summary-config
  inspectDeliveryState: (project, id) => leadInboxRuntime.getLeadEventSettlement(project, id),
  listSummaryPulls: () => listSummaryPulls(execFileP),
  founderLocalIso: (ms) => founderLocalIso(new Date(ms)),               // packages/config
  alert: async (payload) => { const sink = leadPendingAlertHolder.current; if (!sink) { console.warn(...); return; } await sink.alert(payload); },
  log: (m) => console.warn(m),
});
```

### 2.7 迁移 / 回滚 / 兼容

- **schema**:新表 `summary_due_slots`(`CREATE TABLE IF NOT EXISTS`,与仓内其他表同一套启动迁移;无回填)。回滚(revert PR)后表留在库里无害;再前滚时 `IF NOT EXISTS` 幂等。
- **无新 flag / env / plist / alert kind**。
- **flywheel-comm**:`summary-contract.ts` 新增导出 `summaryDeliveryBranch()`,`summary-delivery.ts` 改为调用它——行为零变化(用真实 PR 分支名锁定),不改 CLI 子命令(FLY-1914 消费者 sweep 不触发)。
- **Raya 读侧兼容**:`summary_absorption_round` 旧字段与 roundId 语义不变;新字段可选;write-ahead 恢复测试原样保留。
- **Lead 侧兼容**:未升级 rules bundle 的 Lead 收到 `[summary_due]` 也能按自足文本行动。

### 2.8 负向守卫(实现必带的测试)

| 守卫 | 断言 |
|---|---|
| G1 granularity unselected / 配置非法 | 不开 slot、不结算;每 pass 一行 warn;到 `T+grace` 转 missed |
| G2 同 slot 重跑 pass | 每 producer enqueue 恰一次;settlement `live.LEASED+deliveredAt`/`ACKED` 不重投;`absent_identity` 重投一次 |
| G3 崩在 append 与 enqueue 之间 / enqueue 抛 | 下一 pass 经 absent_identity 补投(due 与 Raya round 各一格);Raya round 既有崩溃测试保留 |
| G4 cadence 热切换 | 6h→1h:旧 slot 按自身参数结算,新 slot 并存;1h→6h:开着的 1h slot 仍结算;60s cadence + 60s pass 同相:slot T 在下一 pass 结算(不漏);`grace = min(30min, cadence/2)` |
| G5 冷启动 | 启动时 `now ≥ T+grace` ⇒ slot 标 missed,零 due、零 round、一行 warn;`now < T+grace` ⇒ 正常开 slot |
| G6 gh 失败 / 畸形 | 快照①失败 ⇒ due 照发 `last_delivered.unavailable`;快照②失败 ⇒ `round_ledger=unavailable`,无 absent/undelivered/counts,文本为「不可得」行;畸形字段 ⇒ unavailable;非 summary 分支跳过 |
| G7 两拍快照分离 | Lead 在 `(T, T+grace)` 开的 PR 只在快照②可见并计已交;快照①的内容不影响 delivered |
| G8 exact vs other_period vs none | 同 period 分支 ⇒ exact;旧 period PR 在窗口内被 merge/comment(updatedAt 变、createdAt 旧)⇒ **none**;窗口内新建的其他 period PR ⇒ other_period |
| G9 truth table 穷尽 | 上表每一行一格,含 archived_terminal ACKED/DEAD、inspect 抛 ⇒ unknown 且**不进 absent** |
| G10 Raya 未注册 | due 照发;结算写 settled,warn 恰一行;不 alert Raya |
| G11 No runtime / renderer 抛 | 只影响该 Lead;其后 pass 重试;结算时若仍 absent_identity ⇒ undelivered |
| G12 exempt / aggregator / recipient / per-project | 不在名单;per-project 只 aggregator 在 |
| G13 文本注入 | 非白名单字符替换;url 非 github.com 不渲染;payload 原值不变 |
| G14 formatter parity | mailbox 与 commdb 输出逐字相等 |
| G15 DST | `founderLocalIso` 在 2026-11-01 PDT→PST 两侧 offset 正确(若既有测试已盖则引用) |
| G16 alert 聚合 | 3 个 undelivered ⇒ 恰 1 条 alert,severity warning,eventId 含 slotISO;delivery_unknown 不告警 |
| G17 branch 提取重构 | `summaryDeliveryBranch` 对今晚 10 张 PR 的 `{project,lead,titlePeriod}` 全部复现其 headRefName |

## 3. 文件清单

| 动作 | 文件 |
|---|---|
| 改 | `packages/teamlead/src/bridge/summary-absorption-rider.ts`(slot 驱动的两拍;deps 扩展) |
| 新 | `packages/teamlead/src/bridge/summary-producer-roster.ts` |
| 新 | `packages/teamlead/src/bridge/summary-delivery-ledger.ts` |
| 新 | `packages/teamlead/src/bridge/summary-round-classify.ts`(`classifyRound` + 文本行) |
| 改 | `packages/teamlead/src/StateStore.ts`(`summary_due_slots` 表 + 5 个方法) |
| 改 | `packages/teamlead/src/bridge/hook-payload.ts`(可选字段;`formatSummaryDue`) |
| 改 | `packages/teamlead/src/bridge/mailbox-lead-runtime.ts`、`commdb-lead-runtime.ts`(分派一行) |
| 改 | `packages/teamlead/src/bridge/plugin.ts`(接线 §2.6) |
| 改 | `packages/flywheel-comm/src/summary-contract.ts`(导出 `summaryDeliveryBranch`)、`summary-delivery.ts`(调用它) |
| 改 | `packages/teamlead/lead-rules-base/summary-inflow.md` |
| 测试 | `bridge/__tests__/summary-absorption-rider.test.ts`(扩,保留既有)、`summary-producer-roster.test.ts`、`summary-delivery-ledger.test.ts`、`summary-round-classify.test.ts`、`state-store-summary-due-slots.test.ts`、formatter parity 测试、`flywheel-comm/src/__tests__/summary-contract.test.ts`(G17) |
| 新 | `engineering/doc/milestones/FLY-2382.md`(ship 时) |

不碰:`commands/summary.ts`、raya 仓、`projects.json`、feature-flag registry、kind-contract、`summary-pr-merge.ts`。

## 4. 实施顺序(TDD;每块 `pnpm lint` + `pnpm -r build` + 聚焦 vitest 全绿;**排除 `**/tmux-viewer.macos.test.ts`**)

| # | 块 | 主要测试 |
|---|---|---|
| 1 | `summaryDeliveryBranch` 提取(flywheel-comm) | G17;`summary-delivery` 既有测试不变 |
| 2 | `summary_due_slots` 表 + StateStore 方法 | open 幂等、settle 只对 open、missed 一次 |
| 3 | roster | 11 人 fixture;per-project;G12 |
| 4 | ledger | 录制 gh JSON(含今晚 #15–#24 与非 summary 分支);G6 校验矩阵 |
| 5 | classify | G8、G9 真值表、文本行全部分支、短名重名 |
| 6 | formatter + 两 runtime 分派 | G13、G14、三种 last_delivered |
| 7 | rider 两拍(slot 驱动) | 时间推进 harness:G1–G5、G7、G10、G11、G16;既有 FLY-2131 测试原样通过 |
| 8 | 接线 + 规则 | 编译;bundle 测试绿;`pnpm test:packages:run`(排除 macos 视图用例) |
| 9 | 文档 | milestone、progress |

## 5. 风险与应对

| 风险 | 应对 |
|---|---|
| 8/11 producer inbox 通路生产未证明 | undelivered 单列 + 一 slot 一条 warning 告警;A4 选已证可达的 Lead;其余作为本单**发现**移交 infra,不冒充验证 |
| Raya 未激活 ⇒ A2 真机不可验 | §0 明确 rollout prerequisite;本单只钉单测与 settled 日志;A2 在 FLY-2131 激活后的第一个真实轮验收 |
| founder-facing 告警在首个 slot 可能列多名 Lead | 有意为之(暴露静音失败);severity warning、聚合一条、无 DM |
| Lead 不用事件给的 period | 记为 other_period 仍算已交,轮报点名 period;规则文本要求原样使用 |
| gh 抖动 | 快照①失败不阻断叫人;快照②失败本轮不判缺席、下一 slot 自愈;不做重试风暴(每 pass 最多两次 gh) |
| epoch 对齐的 6h 边界(17/23/05/11 PDT) | 不归本单;founder 改 cadence 即改相位 |

## 6. 验收剧本(A1/A3/A4 真机;A2 见 §0 口径)

529 房(或生产首个节奏点,由 Lead 定;不投紧急重启票,走班车):
1. 等下一个 slot 边界(529 房可把 cadence 改到 600000 = 10min)。
2. A1:`sqlite3 -readonly teamlead.db "select lead_id, delivered_at from lead_events where event_type='summary_due' and event_id like '%:<slotISO>'"` ⇒ 11 行;`select * from summary_due_slots` ⇒ slot 行 status=open。
3. A4:已证可达 Lead(flywheel-eng-lead / flywheel-product-lead / belle-lead)inbox 出现 `[summary_due]`,Lead 据此跑命令开出 PR(链接);其分支名 = `summaryDeliveryBranch` 预期值。
4. T+grace:`summary_due_slots.status='settled'`,`settle_result_json` 含该 Lead `delivered:"exact"`;bridge.log 一行 settled warn(Raya 未注册)或 `summary_absorption_round` 行 payload.producers 长度 11。
5. A3:管理台改 cadence,下一个新 slot 边界随之变化,无重启;旧 slot 正常结算。

## 7. Codex design review 处理记录

**R1(2026-09-06,plan blob @ ba2457fde,反馈 `/tmp/codex-rescue-design-feedback-flywheel-FLY-2382-plan-round1.md`)= CHANGES REQUESTED,5 阻塞 + 1 中等,全部采纳:**

1. slot 只按当前 `floor(now/cadence)` 计算 ⇒ 60s cadence 同相永不结算、热切换遗弃旧 slot、冷启动先叫再判 → **§2.1 新表 `summary_due_slots`**,第二拍从 open slot 驱动,missed 策略明确,G4/G5 补四组时间推进测试。
2. Raya round 改 claim-only 破坏 FLY-2131 write-ahead 恢复 → **撤回**;Raya round 保持 append+幂等 enqueue,due 走 patrol 的 append→claim 判新→absent_identity 补投(§2.2),既有崩溃测试保留(G3)。
3. `max(createdAt,updatedAt)` 不能证明本 period 已交;两拍共用快照漏 grace 内新 PR → **exact branch 绑定**(`summaryDeliveryBranch` 提到 summary-contract 并用真实 PR 锁定,G17)+ `other_period` 用 createdAt;快照①/② 分离(§2.3,G7、G8)。
4. unknown 进 absent、ledger unavailable 仍产 counts、settlement 状态不穷尽 → **fail-closed 真值表**(§2.3),`delivery_unknown` 单列,unavailable 不产 absent/counts(G9)。
5. Raya 未激活时用 log 代替 #raya 不能通过 A2;warn 非一行 → **§0 A2 改为 rollout prerequisite**,本单不宣称 A2 完成;warn 随 slot settled 只出一次(§2.3,G10)。
6. `interface = …` 非法 TS、`execFileRunner` 不存在、severity 必填、`inbox_loop_stalled` 是 founder_direct、gh JSON 校验不足 → §2.4 `type` + 注入 `execFileP` 的 `ExecFileAsync` 签名;§2.3 alert 聚合一 slot 一条、severity warning、owner 后果写明;gh 严格校验 + reason 规范化(G6、G16)。
