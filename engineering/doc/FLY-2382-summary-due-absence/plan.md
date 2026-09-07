# FLY-2382 summary 写侧触发 + 缺席检测 — 实施计划
Issue: FLY-2382 (https://linear.app/geoforge3d/issue/FLY-2382/raya回流-summary-写侧触发-缺席检测按-prd-1846-872-的固定节奏6h运行期可改由机制叫-lead)
日期: 2026-09-06
基于: research.md

**Status**: draft · v2(R3 后按 Lead 指令做减法重写;R1–R3 记录见 §7)
**方案**: exploration §3.1 方案 A · 同一口钟两拍,全部挂在既有 GatePoller summary rider 上

## 0. 最小交付与验收

本单只交两件事,其余一律不做或列为已知限制(§5):

1. **叫**:到节奏点,每个 producer Lead 的 inbox 收到一条 `summary_due`(含 period 与上次交付)。
2. **看**:节奏点 + 30 分钟,机器算出「谁交了 / 谁没交 / 谁没收到」,以固定一行交给 Raya 在 #raya 转述;Raya 未激活时这一行只落 lead_events 与 bridge.log。

| # | issue 验收 | 落点 | 状态口径 |
|---|---|---|---|
| A1 | 每个 producer Lead inbox 在节奏点收到 `summary_due`,含 period 与上次交付 | §2.2 | 本单可关 |
| A2 | Raya #raya 汇报出现「本轮 N/M 份已交;未交:X、Y」,交齐不列 | §2.3 | **rollout prerequisite**:生产 Raya 未注册(exploration §1.2),本单可合入但不得宣称 A2 完成;A2 在 FLY-2131 激活后的第一个真实轮验收 |
| A3 | 节奏经管理台/flag 可改,无需重启;无新 launchd/crontab | 复用 `summary_absorption_cadence_ms`;零新 flag、零新 daemon、零新表 | 本单可关 |
| A4 | 真机一轮至少一个 Lead 由机制触发交付 | §6 | 本单可关(选已证可达的 Lead) |

**不做**(exploration §4):不改 summary 合同 / `flywheel-comm summary` 命令 / Raya 读侧 merge 逻辑;不激活 Raya、不改 projects.json;不给 Lead 装定时器;不口头通知。

## 1. 架构

```mermaid
sequenceDiagram
  participant GP as GatePoller 每 60s 一次 pass
  participant R as summary-absorption-rider
  participant L as summary-delivery-ledger gh
  participant S as StateStore lead_events
  participant Q as registry.enqueueLeadEvent
  participant P as producer Lead ×11
  participant Y as Raya

  GP->>R: onSummaryAbsorptionTick
  R->>R: cadence=flag(); grace=min(30min, cadence/2); T=floor(now/cadence)*cadence
  loop 第一拍 · slot T(仅当 now < T+grace)
    R->>S: 已有 summary_due 行 ⇒ 跳过写入;否则 快照① → 一个事务 appendLeadEvent(summary_due ×N)
    R->>S: 每个 producer:查队列身份 settlement
    R->>Q: absent_identity ⇒ enqueue(首投=补投)
    Q->>P: [summary_due] period · last_delivered · 指令
  end
  loop 第二拍 · S ∈ {T, T−cadence} 且 now ≥ S+grace
    R->>S: 读 S 的 summary_due 行(名单就是它们)
    alt 无冻结结果 summary_slot_settled:S
      R->>L: 快照② listSummaryPulls(pass 级 memo)
      R->>S: 逐 producer 读 due settlement → classifyRound
      R->>S: tryClaimLeadEvent(summary-clock, summary_slot_settled:S, result)(write-ahead 冻结)
    end
    R->>S: 读冻结结果
    alt 有 Raya
      R->>S: appendLeadEvent(raya, summary-absorption:S, payload 含 report_line)
      R->>Q: enqueue(既有 FLY-2131 write-ahead 语义,不变)
      Q->>Y: 无论有无活动都在 #raya 发,逐字含「本轮 N/M 份已交;未交:…」
    else 无 Raya
      R->>R: warn 一行(in-memory 去重,best-effort)
    end
    R->>R: undelivered 非空 ⇒ 一条聚合 alert(eventId 含 slotISO,幂等)
  end
```

没有新表、没有状态机:两拍的全部持久状态都是 `lead_events` 里带确定性 event_id 的行,副作用全部按稳定 id 幂等,每 pass 在窗口内重放一遍。

## 2. 设计细节

### 2.1 钟与窗口

- `cadence = storeSummaryAbsorptionCadenceMs(flagStore)`(call-time);`grace = min(30min, floor(cadence/2))`;`T = floor(now/cadence)*cadence`。
- **第一拍只对当前 slot T,且只在 `now < T + grace` 时开**(过了 grace 才第一次看见 T ⇒ 不叫、不判,warn 一行;in-memory 记住 `lastMissedLoggedSlot` 避免每 60s 重复)。对已过去的 period 叫人是噪音,判缺席是冤枉。
- **第二拍窗口固定为 `{T, T − cadence}`**:对其中 `now ≥ S + grace` 的 S 结算并重放副作用。60s cadence + 60s pass 同相时,S = T−cadence 满足 `now ≥ S + 60s > S + 30s`,不会饿死。
- 窗口外的 slot 不再处理。⇒ **已知限制 L1**:Bridge 停机 > 1 个 cadence,期间 slot 既不叫也不判;**L2**:运行期改 cadence 时,正在进行的旧 slot 若落在新窗口外则不结算(其 due 行与可能已写的冻结结果留在 lead_events 供审计),下一 slot 起正常。

### 2.2 第一拍 · `summary_due`

**身份**:event_type `summary_due`;event_id `summary_due:<project>/<lead>:<slotISO>`;session_key `summary-due`;payload `execution_id` = event_id,`issue_id` = `FLY-2382`。`(lead_id, event_id)` 唯一索引即幂等键。

**名单**(一处真相):`resolveSummaryProducers(projects, readSummaryGranularity())` = `compileSummaryAssignmentRows(ProjectEntry → SummaryAssignmentSourceRow[], selection).leads.filter(hasSummaryDuty)`。granularity `unselected` / `SummaryConfigError` / `summary_aggregator_invalid` ⇒ 本 pass 不写 due,warn 一行(每 pass 一行,配置坏了就该持续可见);下个 pass 重试;拖过 grace 即错过本 slot。

**写入**:若 `listSummaryDueRows(slotISO)` 为空 ⇒ 取快照①(`listSummaryPulls`,失败则每人 `last_delivered.unavailable`),在 **StateStore 方法内部一个事务**里 `appendLeadEvent` 全部 N 行(`appendSummaryDueRows(rows)`;崩溃要么全有要么全无)。已有行 ⇒ 不再写(名单以首次写入为准;slot 内 roster 变化不追)。

**投递(单一路径,首投=补投)**:每 pass 对 slot T 的每一行:`settlement = inspectDeliveryState(project, canonicalLeadEventDeliveryId(envelope(row)))`;`absent_identity` ⇒ `enqueueLeadEvent(envelope(row))`。崩在写行与 enqueue 之间 ⇒ 下一 pass 队列无此身份 ⇒ 补投。`enqueueLeadEvent` 抛(`No runtime registered` / renderer 抛)⇒ 该 Lead warn,其他继续,下一 pass 重试。**补投只在 slot T 的 grace 内进行**(第二拍结算时若仍 absent 就如实记 undelivered)。

**payload**(`HookPayload.summary_due?`,可选字段;不改既有字段):

```ts
summary_due: {
  slot_start: iso(T), cadence_ms, period: `${founderLocalIso(T − cadence)}/${founderLocalIso(T)}`,
  last_delivered: { status: "found", pr, url, state: "OPEN"|"MERGED"|"CLOSED", created_at }
                | { status: "none" } | { status: "unavailable", reason },   // reason 来自固定短语表
  command_hint: `flywheel-comm summary --file <your-summary.md> --project ${project} --period ${period}`,
}
```

`last_delivered` = 快照①中前缀 `summary/<project>/<lead>/` 下 `createdAt` 最大的一张。

**渲染**:`formatSummaryDue(env)`(`hook-payload.ts`,与 `formatPatrolTick` 并列);`mailbox-lead-runtime.ts`、`commdb-lead-runtime.ts` 的 `formatEnvelope` 各加一条分派,测试逐字 parity。插值(project/lead/period/url)先过白名单 `[A-Za-z0-9._:/+-]`,url 另经 `new URL()` 校验 `https:` + host `github.com`;不合规替换为 `?`。文本:

```
[Event #<seq>] summary_due
ID: summary_due:<project>/<lead>:<slotISO> | Issue: FLY-2382
[summary_due] 到 summary 节奏点(每 <cadence 人读>;founder 可在管理台改)。
Period: <period>
上次交付: PR #<n> (<state>, <created_at>) | 从未交过 | 不可得(<reason>)
---
1. 写本 period 的 summary(Facts + Judgment;合同见 Raya 仓 summaries/README.md)。
2. 运行:flywheel-comm summary --file <your-summary.md> --project <project> --period <period>
   （请原样使用上面的 period;机制只按它识别「本轮已交」。）
3. 没有新事实与判断可写时可以不交(PRD §6.3)。未交会在 Raya 的轮报里以「未交」出现——那是可见性,不是催促。
4. 这是唯一的节奏来源;不要自建定时器(R4)。
Timestamp: <ts> | Session Key: summary-due
```

### 2.3 第二拍 · 结算与 Raya 轮事件

对窗口内每个 `now ≥ S + grace` 的 S:

**名单** = `listSummaryDueRows(slotISO(S))`(该 slot 实际叫过的人;为空 ⇒ 本 slot 没叫过,不结算)。

**冻结结果**(write-ahead;R2-2 的精神,用一行代替一张表):`tryClaimLeadEvent("summary-clock", "summary_slot_settled:<slotISO>", "summary_slot_settled", resultJson, "summary-due")`。claim 成功前先算:快照②(`listSummaryPulls`,pass 级 memo;`unavailable` 也是结果)+ 每人 due settlement + `classifyRound`。claim 失败(已存在)⇒ `getLeadEventByLeadAndId` 读回冻结结果,不重算。`summary-clock` 是合成 lead id,无 runtime、永不 enqueue(既有精神同 `bridge`/`swap` 行);实现前核一遍投递/死信扫描只看 roster lead,不碰它(G12)。

**已交判据**(纯函数 `classifyRound(dueRows, pulls, settlements)`):

- `expectedBranch = summaryDeliveryBranch({ project, author: lead, period })`,算法即 `summary-delivery.ts` 的 `branchFor`;本单把它提到 `flywheel-comm/src/summary-contract.ts` 导出并让 `summary-delivery.ts` 调用(行为不变;用今晚真实 PR 锁定:`{growth, reflection-lead, "2026-09-06/2026-09-06"} → summary/growth/reflection-lead/269dc60b2dd3fb93`,已本机复现)。
- `delivered = true` ⇔ 存在 PR `headRefName === expectedBranch`(任何 state、任何时间)。**只有精确匹配算已交**;Lead 用别的 period 交了 ⇒ 记未交(⇒ **已知限制 L3**;due 已给出精确 period,规则文本要求原样使用;Raya 仍会在 open PR 里看到那张)。
- 账本 `unavailable` ⇒ `delivered = unknown`。

**due 投递真值表**(穷尽 `MailboxSettlement`):

| settlement | due_delivery |
|---|---|
| `absent_identity`、`torn_identity` | `undelivered` |
| `live` / `archived_nonterminal`,state `QUEUED` 或 `LEASED` 且 `deliveredAt == null` | `undelivered` |
| `live` / `archived_nonterminal`,state `LEASED` 且 `deliveredAt != null` | `delivered` |
| `live` / `archived_terminal`,state `ACKED` | `delivered` |
| `live` / `archived_terminal`,state `DEAD` | `undelivered` |
| `inspectDeliveryState` 抛 | `unknown` |

补投是异步 loop,越过 grace 时仍是 `QUEUED` 就如实记 `undelivered`——不用竞态、不伪造同步送达(R3-2)。

**分类(fail-closed;两轴正交,只有已交有覆盖权)**:

```
delivered = true                               → delivered[]        (计入 N;不再记投递诊断)
delivered = false ∧ due = delivered            → absent[]
delivered = false ∧ due = undelivered          → undelivered[]
delivered = false ∧ due = unknown              → delivery_unknown[] (绝不进 absent)
delivered = unknown(账本不可得)               → 交付轴不分类,无 N/M、无 absent;投递轴照常产出 undelivered[]/delivery_unknown[]
```

**冻结结果 / Raya payload 增量**(旧字段一个不动,新字段可选):

```ts
round_ledger: "ok" | "unavailable",
producer_count?: M, delivered_count?: N,
producers?: Array<{ project, lead, delivered: boolean | "unknown", due_delivery: "delivered"|"undelivered"|"unknown",
                    delivered_pr?: { number, url, state } }>,
absent?: string[], undelivered?: string[], delivery_unknown?: string[],
report_line: string,        // 下表拼好的对账行(逐字),Raya 直接转述
```

**report_line**(纯函数;短名 = leadId,同 slot 跨项目重名则 `project/lead`):

| 情况 | 行 |
|---|---|
| 账本 ok,absent 非空 | `本轮 ${N}/${M} 份已交;未交:${absent…}` |
| 账本 ok,absent 空,N === M | `本轮 ${M}/${M} 份已交。` |
| 账本 ok,absent 空,N < M | `本轮 ${N}/${M} 份已交;无人「未交」——差额见下。` |
| undelivered 非空 | `未送达(机制问题,已告警):${…}` |
| delivery_unknown 非空 | `送达状态不可得(不计未交):${…}` |
| 账本 unavailable | `本轮交付状态不可得(${reason}),只报吸收不报缺席。`(无 N/M、无 absent;投递轴两行照常) |

进入 report_line 的外部文本只有 project/lead(白名单过滤)与 `reason`(本单固定短语表:`truncated at gh --limit 500` / `gh exit <code>` / `malformed gh output: <field>` / `timeout`,不透传 stderr)。生成后单行化、剔除控制字符。

**Raya 指令文本**:在既有 `summary` 末尾追加固定措辞(测试逐字锁定;R2-5 —— 既有指令允许无活动时不发,而无活动恰是缺席最需要被看见的时候):

```
【本轮对账(FLY-2382)】无论本轮有没有 review/吸收/追问活动,都要在 #raya 发一条汇报,
并逐字包含下面这几行(不要改写、不要省略):
<report_line 各行>
```

**副作用(全部幂等,每 pass 在窗口内重放)**:
- 有 Raya:`appendLeadEvent(raya, "summary-absorption:<slotISO>", …payload)` + `enqueueLeadEvent` —— 与现 rider 完全相同的 write-ahead 语义与既有崩溃测试;roundId 不变。
- 无 Raya(`resolveRaya` null):跳过;warn 一行 `[summary-due] slot <S> settled without Raya recipient: <report_line>`(in-memory 按 slot 去重,best-effort;这是 Raya 激活前唯一可见痕迹)。
- undelivered 非空 ⇒ **一条**聚合 alert:kind 复用 `inbox_loop_stalled`(owner `founder_direct`,`kind-contract.ts:94`;语义就是 Bridge→Lead inbox 没送到),`eventId = summary_due_undelivered:<slotISO>`(sink 按 eventId 去重),`leadId: "patrol-roster:summary-due"`、`projectName: FLEET_ALERT_PROJECT`(沿用 patrol fleet-scoped 写法),`severity: "warning"`(无 DM),title `summary_due not delivered to N Lead inbox(es)`,body 逐行 `project/lead: <settlement kind/state>`。**明确后果**:这是 founder-facing 告警;8/11 producer 通路未证明可达(exploration §1.4),首个生产 slot 很可能列出多名 Lead——这正是要暴露的静音失败。alert sink 缺失 ⇒ warn。

### 2.4 gh 账本(`bridge/summary-delivery-ledger.ts`,新)

```ts
export type SummaryLedgerResult =
  | { status: "ok"; pulls: SummaryPull[] }
  | { status: "unavailable"; reason: "truncated at gh --limit 500" | `gh exit ${number}` | `malformed gh output: ${string}` | "timeout" };
export interface SummaryPull { number; url; state: "OPEN"|"MERGED"|"CLOSED"; project; lead; headRefName; createdAt: number }
export type ExecFileAsync = (file: string, args: string[], opts: { timeout: number; maxBuffer: number }) => Promise<{ stdout: string; stderr: string }>;
export async function listSummaryPulls(exec: ExecFileAsync, repo = "xrliAnnie/raya"): Promise<SummaryLedgerResult>
```

- `gh pr list --repo <repo> --state all --limit 500 --json number,url,state,createdAt,headRefName`;`timeout 30_000`、`maxBuffer 16MB`;注入 `plugin.ts:900` 的 `execFileP`。
- 恰 500 行 ⇒ `unavailable("truncated…")`(有界窗口不冒充完整账本;Raya 仓现 24 张,到时分页是一行改动)。
- 严格校验:顶层数组;每项对象;`number` 正整数;`state` 枚举;`url` https + host `github.com` + 路径 `/<repo>/pull/<number>` 与 number 一致;`headRefName` 字符串 ≤ 512;`createdAt` 可 `Date.parse`。任一失败 ⇒ 整体 `unavailable("malformed gh output: <field>")`。
- 只保留 `headRefName` 匹配 `^summary/([A-Za-z0-9][A-Za-z0-9._-]*)/([A-Za-z0-9][A-Za-z0-9._-]*)/[0-9a-f]{16}$` 的行;其余静默跳过。
- 每 pass ≤ 2 次调用:快照①(仅写 due 时)+ 快照②(pass 级 memo,窗口内多 slot 共用)。

### 2.5 规则文本(`lead-rules-base/summary-inflow.md`)

在 `## Your obligation` 后加 `## The due signal (FLY-2382)`:节奏以 Bridge 事件 `[summary_due]` 送达;收到即写并**原样使用事件里的 `--period`**(机制只按它识别已交);没有事实与判断可写时可以不交(§6.3),未交会以「未交」出现在 Raya 轮报里——可见性不是催促;`[summary_due]` 是唯一节奏来源,仍禁止本地 timer/cron/launchd(R4)。并把「do not invent one, add reminders」改写为「the cadence is delivered to you by `[summary_due]`; do not invent one or add your own reminders」。bundle 测试只断文件在/不在,不需改。

### 2.6 接线(`bridge/plugin.ts:9892`)

```ts
const summaryAbsorptionPass = createSummaryAbsorptionPass({
  projects, store,      // Pick 扩:appendSummaryDueRows、listSummaryDueRows、getLeadEventByLeadAndId、tryClaimLeadEvent
  enqueueLeadEvent: (envelope) => registry.enqueueLeadEvent(envelope),
  cadenceMs: () => storeSummaryAbsorptionCadenceMs(flagStore),
  readGranularity: () => readSummaryGranularity(),                                   // flywheel-comm/summary-config
  inspectDeliveryState: (project, id) => leadInboxRuntime.getLeadEventSettlement(project, id),
  listSummaryPulls: () => listSummaryPulls(execFileP),
  founderLocalIso: (ms) => founderLocalIso(new Date(ms)),                            // packages/config
  alert: async (payload) => { const sink = leadPendingAlertHolder.current; if (!sink) { console.warn(...); return; } await sink.alert(payload); },
  log: (m) => console.warn(m),
});
```

**StateStore 新增(3 个,均只碰 `lead_events`)**:`appendSummaryDueRows(rows[])`(内部 `this.db.transaction`,逐行 `appendLeadEvent`)、`listSummaryDueRows(slotISO)`(`event_type='summary_due' AND event_id LIKE 'summary\_due:%:<slotISO>' ESCAPE '\'`)、`getLeadEventByLeadAndId(leadId, eventId)`。`tryClaimLeadEvent` 既有。

### 2.7 迁移 / 回滚 / 兼容

- **无 schema 变更**:只在 `lead_events` 写三类 event_type(`summary_due`、`summary_slot_settled`、既有 `summary_absorption_round`)。revert 后已写行留在库里无害。
- **无新 flag / env / plist / alert kind / 表**。
- **flywheel-comm**:`summary-contract.ts` 新增导出 `summaryDeliveryBranch()`,`summary-delivery.ts` 改为调用——行为零变化(真实 PR 分支名锁定);不改 CLI 子命令(FLY-1914 sweep 不触发)。
- **Raya 读侧兼容**:`summary_absorption_round` 旧字段与 roundId 语义不变、write-ahead 恢复测试原样保留;新字段可选;`summary` 文本只追加。
- **Lead 侧兼容**:未升级 rules bundle 的 Lead 收到 `[summary_due]` 也能按自足文本行动。

### 2.8 负向守卫(实现必带的测试)

| 守卫 | 断言 |
|---|---|
| G1 granularity unselected / 非法 | 不写 due;每 pass 一行 warn;过 grace 后该 slot 不叫不判 |
| G2 同 slot 重跑 pass | 首投经 absent_identity 恰一次;`LEASED+deliveredAt` / `ACKED` 不重投;身份再次 absent ⇒ 再投一次;`appendSummaryDueRows` 不重复写 |
| G3 崩溃格 | 写行事务中断 ⇒ 零行;写行后 enqueue 前 ⇒ 下一 pass 补投;冻结后 Raya append 前 / append 后 enqueue 前 / enqueue 后 alert 前 ⇒ 重放只读冻结结果,Raya 行 payload 与冻结结果一致;Raya round 既有崩溃测试原样保留 |
| G4 cadence 热切换 | 6h→1h、1h→6h:新 slot 用新值;窗口外旧 slot 不结算(L2 被测试**钉住为已知行为**,不是偶然);60s cadence + 60s pass 同相:S=T−cadence 在下一 pass 结算 |
| G5 冷启动 | `now ≥ T+grace` ⇒ 零 due、零冻结、warn 一行且不重复;`now < T+grace` ⇒ 正常 |
| G6 gh 失败 / 畸形 / 截断 | 快照①失败 ⇒ due 照发 `unavailable`;快照②失败 ⇒ `round_ledger=unavailable`,无 N/M、无 absent,投递轴仍产出;恰 500 行 ⇒ unavailable;畸形字段 ⇒ unavailable;非 summary 分支跳过 |
| G7 两拍快照分离 | `(T, T+grace)` 内新开的精确分支 PR 只在快照②可见并计已交 |
| G8 判据 | 精确分支 ⇒ 已交;同 Lead 其他 period 的 PR(即使在窗口内新建)⇒ 未交(L3 钉住);旧 PR 被 merge/comment 不影响 |
| G9 真值表穷尽 + 两轴 | 上表每行一格;inspect 抛 ⇒ unknown 不进 absent;已交 ∧ DEAD ⇒ 无诊断;账本 unavailable ∧ DEAD ⇒ 仍 undelivered + 告警 |
| G10 Raya 未注册 | due 照发;冻结结果写入;warn 一行(同 slot 不重复);不 alert Raya |
| G11 No runtime / renderer 抛 | 只影响该 Lead;grace 内重试;结算时仍 absent ⇒ undelivered |
| G12 合成 lead id | `summary-clock` 行永不被 enqueue;实现前 grep 投递循环 / 死信扫描 / patrol 的 lead 来源均为 roster,附证据到 PR |
| G13 文本注入 | 非白名单字符替换;非 github.com url 不渲染;report_line 单行无控制字符;payload 原值不变 |
| G14 formatter parity | mailbox 与 commdb 输出逐字相等 |
| G15 无条件汇报 | Raya 指令逐字含「无论本轮有没有 review/吸收/追问活动…」与 report_line;零 PR 活动的轮同样生成 |
| G16 alert 聚合 | 3 个 undelivered ⇒ 恰 1 条 alert,severity warning,eventId 含 slotISO;delivery_unknown 不告警;重放 pass 再调 alert 时 eventId 相同 |
| G17 分支提取重构 | `summaryDeliveryBranch` 对今晚 10 张 PR 的 `{project, lead, titlePeriod}` 全部复现其 headRefName;`summary-delivery` 既有测试不变 |
| G18 DST | `founderLocalIso` 在 2026-11-01 PDT→PST 两侧 offset 正确(若既有测试已盖则引用) |

## 3. 文件清单

| 动作 | 文件 |
|---|---|
| 改 | `packages/teamlead/src/bridge/summary-absorption-rider.ts`(两拍;deps 扩展) |
| 新 | `packages/teamlead/src/bridge/summary-producer-roster.ts` |
| 新 | `packages/teamlead/src/bridge/summary-delivery-ledger.ts` |
| 新 | `packages/teamlead/src/bridge/summary-round-classify.ts`(`classifyRound` + report_line) |
| 改 | `packages/teamlead/src/StateStore.ts`(3 个只碰 `lead_events` 的方法) |
| 改 | `packages/teamlead/src/bridge/hook-payload.ts`(可选字段;`formatSummaryDue`) |
| 改 | `packages/teamlead/src/bridge/mailbox-lead-runtime.ts`、`commdb-lead-runtime.ts`(分派一行) |
| 改 | `packages/teamlead/src/bridge/plugin.ts`(接线 §2.6) |
| 改 | `packages/flywheel-comm/src/summary-contract.ts`(导出 `summaryDeliveryBranch`)、`summary-delivery.ts`(调用它) |
| 改 | `packages/teamlead/lead-rules-base/summary-inflow.md` |
| 测试 | `bridge/__tests__/summary-absorption-rider.test.ts`(扩,保留既有)、`summary-producer-roster.test.ts`、`summary-delivery-ledger.test.ts`、`summary-round-classify.test.ts`、StateStore 三方法测试、formatter parity 测试、`flywheel-comm/src/__tests__/summary-contract.test.ts`(G17) |
| 新 | `engineering/doc/milestones/FLY-2382.md`(ship 时) |

不碰:`commands/summary.ts`、raya 仓、`projects.json`、feature-flag registry、kind-contract、`summary-pr-merge.ts`、StateStore schema。

## 4. 实施顺序(TDD;每块 `pnpm lint` + `pnpm -r build` + 聚焦 vitest 全绿;**排除 `**/tmux-viewer.macos.test.ts`**)

| # | 块 | 主要测试 |
|---|---|---|
| 1 | `summaryDeliveryBranch` 提取(flywheel-comm) | G17 |
| 2 | StateStore 三方法 | 事务原子性(中途抛 ⇒ 零行);LIKE 转义;exact getter |
| 3 | roster | 11 人 fixture;per-project;exempt/aggregator/recipient 不在 |
| 4 | ledger | 录制 gh JSON(含今晚 #15–#24 与非 summary 分支);G6 |
| 5 | classify + report_line | G8、G9、report_line 全分支、短名重名、G13 |
| 6 | formatter + 两 runtime 分派 | G13、G14、三种 last_delivered |
| 7 | rider 两拍 | 时间推进 harness:G1–G5、G7、G10、G11、G15、G16;既有 FLY-2131 测试原样通过 |
| 8 | 接线 + 规则 + G12 证据 | 编译;bundle 测试绿;`pnpm test:packages:run`(排除 macos 视图用例) |
| 9 | 文档 | milestone、progress |

## 5. 已知限制(本版有意不做)与风险

| 编号 | 内容 | 为什么本版不做 |
|---|---|---|
| L1 | Bridge 停机 > 1 个 cadence:期间 slot 不叫、不判 | 补叫是对过去 period 的噪音;补判需要 backlog 调度——不是「叫 / 看」的必要条件 |
| L2 | 运行期改 cadence:正在进行的旧 slot 若落到新窗口外则不结算 | 同上;下一 slot 起正常;audit 行仍在 lead_events |
| L3 | Lead 用非事件给定的 period 交付 ⇒ 记「未交」 | due 已给精确 period;放宽判据需要第二套「本轮」定义(R2-4 已否);Raya 仍在 open PR 里看到那张 |
| L4 | 副作用只在窗口内重放;窗口外未完成的 Raya round / alert 不再补 | 与 L1/L2 同源 |
| L5 | 补投只在 grace 内;结算后不再补投当轮 due | 越过 grace 的 due 已无意义;下一轮会再叫 |
| L6 | 没有 per-Lead 「本轮无更新」回执通路 | 沉默是一等信号(§10.5);要留痕就交一份两行的极短 summary(既有命令、既有合同) |

| 风险 | 应对 |
|---|---|
| 8/11 producer inbox 通路生产未证明 | undelivered 单列 + 一 slot 一条 warning 告警;A4 选已证可达的 Lead;其余作为本单**发现**移交 infra |
| Raya 未激活 ⇒ A2 真机不可验 | §0 rollout prerequisite;本单只钉单测与 no-Raya warn |
| founder-facing 告警首个 slot 可能列多名 Lead | 有意为之;warning、聚合一条、无 DM |
| gh 抖动 | 快照①失败不阻断叫人;快照②失败是该轮的冻结结果(不可得),下一 slot 自愈 |
| epoch 对齐的 6h 边界(17/23/05/11 PDT) | 不归本单;founder 改 cadence 即改相位 |

## 6. 验收剧本(A1/A3/A4 真机;A2 见 §0)

529 房(或生产首个节奏点,由 Lead 定;不投紧急重启票,走班车):
1. 等下一个 slot 边界(529 房可把 cadence 改到 600000 = 10min)。
2. A1:`sqlite3 -readonly teamlead.db "select lead_id, delivered_at from lead_events where event_type='summary_due' and event_id like '%:<slotISO>'"` ⇒ 11 行。
3. A4:已证可达 Lead(flywheel-eng-lead / flywheel-product-lead / belle-lead)inbox 出现 `[summary_due]`;Lead 据此跑命令开出 PR(链接);分支名 = `summaryDeliveryBranch` 预期值。
4. T+grace:`lead_events` 出现 `summary_slot_settled:<slotISO>` 行,payload 含该 Lead `delivered:true` 与 report_line;bridge.log 一行 no-Raya warn(Raya 未注册)或 `summary_absorption_round` 行 `summary` 含「【本轮对账(FLY-2382)】」段。
5. A3:管理台改 cadence,下一个新 slot 边界随之变化,无重启。

## 7. Codex design review 处理记录

**R1(2026-09-06,plan blob @ ba2457fde)= CHANGES REQUESTED,5 阻塞 + 1 中等,全部采纳**:slot 只按当前 floor 计算会漏轮 → 持久化 slot;Raya round claim-only 破坏 write-ahead → 撤回;`max(createdAt,updatedAt)` 不能证明本 period → 精确分支绑定 + 两拍快照分离;truth model 不 fail-closed → 穷尽真值表、unknown 不进 absent;A2 用 log 代替 #raya → 改为 rollout prerequisite;TS 类型/`execFileP`/severity/alert owner/gh 校验 → 逐项补齐。

**R2(plan blob @ cf83dcaf6)= CHANGES REQUESTED,5 阻塞 + 2 高,全部采纳**:append 后 tryClaim 必为 false → 单一 absent_identity 路径;跨崩溃提交点 → 事务写行 + 先冻结再副作用;结算先于补投、工作量无上界 → 顺序钉死 + 有界;`other_period` 计 N → 不计;无条件汇报指令;missed 行 schema;`--limit 500` 截断 → unavailable。

**R3(plan blob @ 8d9d3e035)= CHANGES REQUESTED,4 阻塞 + 3 高 + 1 中,全部采纳**:oldest-first 饿死当前 slot → 公平调度;补投后 QUEUED 当 delivered → 如实 undelivered;mismatch 遮蔽 inbox 故障 → 两轴正交;CHECK 未互斥 → 四态 OR;`transaction` 不在 StateStore 公共面 → 封装;unavailable 终态矛盾 → 冻结结算;titlePeriod 未清洗 → 语法校验;规范文本同步。

**R3 后 Lead 裁定(ask `831b6c16`,2026-09-06)**:「6→7→8 不是收敛,是设计在长。先做减法再交:最小交付只有①到点叫 ②谁没交可见;为调度公平/补投/四态互斥长出来的机制,不是必要条件的删掉或列为已知限制。R4 后无论结果都停,报剩余项 + 删掉了什么。」

**v2 减法清单(本版相对 R3 稿删掉的)**:
- 删 `summary_due_slots` 新表、`open→prepared→settled|missed` 状态机、四态 CHECK、`next_attempt_at`/指数退避/`LIMIT 8` 公平调度、`deferSummaryDueSlot` 等 7 个 StateStore 方法 → 换成 `lead_events` 上两类确定性 id 行(`summary_due`、`summary_slot_settled`)+ 3 个只读/追加方法;窗口固定 `{T, T−cadence}`(L1/L2/L4)。
- 删 `period_mismatch` 第三态与 `titlePeriod` 解析/清洗 → 只有精确分支算已交(L3);账本不再请求 `title`/`updatedAt`。
- 删 missed 标记行与「恰一次 warn」承诺 → in-memory 去重的 best-effort warn。
- 删结算后的持续补投 → 只在 grace 内补投(L5)。
- **保留**(是①②的必要条件或 R1–R3 指出的正确性):精确分支判据与 `summaryDeliveryBranch` 提取;两拍快照分离;穷尽真值表 + 两轴正交 + unknown 不进 absent;write-ahead 冻结结果;Raya round 既有 write-ahead 语义;无条件汇报指令;gh 严格校验 + 截断守卫;聚合 warning 告警;formatter parity;规则文本。
