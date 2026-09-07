# FLY-2382 summary 写侧触发 + 缺席检测 — 实施计划
Issue: FLY-2382 (https://linear.app/geoforge3d/issue/FLY-2382/raya回流-summary-写侧触发-缺席检测按-prd-1846-872-的固定节奏6h运行期可改由机制叫-lead)
日期: 2026-09-06
基于: research.md

**Status**: draft(Codex design review R1–R3 均 CHANGES REQUESTED,21 项全部采纳;见 §7)
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
  participant GP as GatePoller 每 60s 一次 pass
  participant R as summary-absorption-rider
  participant SL as StateStore summary_due_slots
  participant L as summary-delivery-ledger gh
  participant S as StateStore lead_events
  participant Q as registry.enqueueLeadEvent
  participant P as producer Lead ×11
  participant Y as Raya

  GP->>R: onSummaryAbsorptionTick
  R->>R: cadence=flag(); grace=min(30min, cadence/2); T=floor(now/cadence)*cadence
  alt 步骤 2 · 无 slot 行 T 且 now < T+grace
    R->>L: 快照① listSummaryPulls(仅供 last_delivered)
    R->>SL: 一个事务:insert slot T(open)+ appendLeadEvent(summary_due ×N)
  else 无 slot 行 T 且 now ≥ T+grace
    R->>SL: insert slot T(missed),warn 一行,不叫不判
  end
  loop 步骤 3 · 当前 slot T 每个 producer(专门预算)+ 步骤 4a · 到期 backlog(≤8,按 next_attempt_at)
    R->>S: 读 due 行,查队列身份 settlement
    R->>Q: absent_identity ⇒ enqueue(首投=补投)
    Q->>P: [summary_due] period · last_delivered · 指令
  end
  loop 步骤 4b · backlog 中 now ≥ slot_start+grace 的 slot
    alt status=open
      R->>L: 快照② listSummaryPulls(pass 级 memo)
      R->>S: 逐 producer 读 due settlement
      R->>R: classifyRound ⇒ exact / period_mismatch / absent / undelivered / unknown
      R->>SL: prepare(CAS open→prepared,冻结 settle_result_json)
    end
    R->>SL: 读冻结结果(prepared 重放也从这里开始)
    alt 有 Raya
      R->>S: appendLeadEvent(raya, summary-absorption:<T>, payload 含 report_line)
      R->>Q: enqueue(既有 write-ahead 语义不变)
      Q->>Y: 指令:无论有无活动都在 #raya 发,逐字含「本轮 N/M 份已交;未交:…」
    else 无 Raya
      R->>R: warn 一行(best-effort,at-most-once-per-pass)
    end
    R->>R: undelivered 非空 ⇒ 一条聚合 alert(eventId 含 slotISO)
    R->>SL: settle(CAS prepared→settled);任一步抛 ⇒ defer 退避,下个到期 pass 重放
  end
```

## 2. 设计细节

### 2.1 slot 生命周期(R1-1)—— 持久化在新表 `summary_due_slots`

一个 slot 一旦开始就是一件**有身份、要结算的事**,不能只靠「当前 `floor(now/cadence)`」重算:cadence 下限 60s 与 pass 间隔 60s 同相时当前 slot 永远「太新」,第二拍永不发生;热切换 cadence 会遗弃已 fan-out 未结算的旧 slot;冷启动会在同一 pass 对很早的 T 先叫再判缺席。

**表**(`StateStore` 启动 `CREATE TABLE IF NOT EXISTS`,与既有表同一迁移方式;无数据迁移):

```sql
CREATE TABLE IF NOT EXISTS summary_due_slots (
  slot_start_ms      INTEGER PRIMARY KEY,
  status             TEXT    NOT NULL,
  first_seen_at      TEXT    NOT NULL,          -- 第一次看见该 slot 的时刻(四态都有)
  cadence_ms         INTEGER NOT NULL CHECK (cadence_ms > 0),
  grace_ms           INTEGER NOT NULL CHECK (grace_ms >= 0),
  period             TEXT,                      -- founderLocalIso(T-cadence)/founderLocalIso(T)
  granularity        TEXT CHECK (granularity IS NULL OR granularity IN ('per-lead','per-project')),
  producers_json     TEXT,                      -- [{project, lead, last_delivered}] 名单 + 快照① per-producer 上下文
  prepared_at        TEXT,
  settle_result_json TEXT,                      -- classifyRound 冻结结果(快照② + 分类)
  settled_at         TEXT,
  next_attempt_at    TEXT,                      -- R3-1 公平调度:下次允许尝试(补投/结算)的时刻;open/prepared 非空
  attempts           INTEGER NOT NULL DEFAULT 0,
  -- R3-4:四个互斥且完整的 shape,用 OR 写死
  CHECK (
    (status = 'open'     AND period IS NOT NULL AND granularity IS NOT NULL AND producers_json IS NOT NULL
                          AND prepared_at IS NULL     AND settle_result_json IS NULL     AND settled_at IS NULL
                          AND next_attempt_at IS NOT NULL)
 OR (status = 'prepared' AND period IS NOT NULL AND granularity IS NOT NULL AND producers_json IS NOT NULL
                          AND prepared_at IS NOT NULL AND settle_result_json IS NOT NULL AND settled_at IS NULL
                          AND next_attempt_at IS NOT NULL)
 OR (status = 'settled'  AND period IS NOT NULL AND granularity IS NOT NULL AND producers_json IS NOT NULL
                          AND prepared_at IS NOT NULL AND settle_result_json IS NOT NULL AND settled_at IS NOT NULL
                          AND next_attempt_at IS NULL)
 OR (status = 'missed'   AND period IS NULL     AND granularity IS NULL     AND producers_json IS NULL
                          AND prepared_at IS NULL     AND settle_result_json IS NULL     AND settled_at IS NULL
                          AND next_attempt_at IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_summary_due_slots_due ON summary_due_slots(status, next_attempt_at);
```

状态机:`open → prepared → settled`,或 `missed`(终态)。R2-6/R3-4:missed 行不伪造名单/granularity;open 不得带任何 lifecycle 字段;prepared 不得带 settled_at——G8d 对**最终 DDL 真跑**插入并断言 CHECK 失败。

**StateStore API(共 8 个,均带单测;事务在方法内部用 `this.db.transaction(...)` 封装——R3-5:`transaction` 是 `CompatDb` 内部能力,不暴露给调用方)**:
- `getSummaryDueSlot(slotStartMs)`
- `openSummaryDueSlotWithDues(slotRow, dueRows[])`:方法内部一个事务:INSERT slot(status open,`next_attempt_at = first_seen_at`)+ 对每个 producer `appendLeadEvent(summary_due …)`。slot 已存在 ⇒ 不做、返回 false。R2-2(a):崩溃要么全有要么全无。
- `markSummaryDueSlotMissed(slotStartMs, cadence, grace, firstSeenAt)`
- `listDueSummarySlots(nowIso, limit)`:`status IN ('open','prepared') AND next_attempt_at <= ? ORDER BY next_attempt_at ASC, slot_start_ms ASC LIMIT ?`(按到期顺序,不是永远 oldest-first)。
- `deferSummaryDueSlot(slotStartMs, nextAttemptAt)`:失败后回写 `next_attempt_at = now + min(5min × 2^attempts, 1h)`、`attempts += 1`(仅 open/prepared)。
- `prepareSummaryDueSlotSettlement(slotStartMs, preparedAt, resultJson)`:CAS,仅 `status='open'` 可转 `prepared`;返回是否本次转换。R2-2(b)。
- `settleSummaryDueSlot(slotStartMs, settledAt)`:仅 `status='prepared'` 可转 settled(同时 `next_attempt_at = NULL`)。
- `getLeadEventByLeadAndId(leadId, eventId): LeadEventRow | null`(**新增**,exact `(lead_id, event_id)` 只读 getter;现仓只有 `getLeadEventBySeq`)。

**每 pass 的算法(顺序即合同;R2-3)**:

1. `cadence = flag()`;`grace = min(SUMMARY_DUE_GRACE_MS = 30min, floor(cadence/2))`;`T = floor(now/cadence)*cadence`。
2. **开 slot**(最多一次快照① gh 调用):若 `getSummaryDueSlot(T)` 为空:
   - `now < T + grace` ⇒ 读 granularity/名单(失败 ⇒ 本 pass 不开 slot,warn 一行;下个 pass 重试;拖到 `T+grace` 则走 missed);取快照①算每人 `last_delivered`;`openSummaryDueSlotWithDues(slot, dues)` 一个事务落地 slot + 全部 due journal 行。
   - `now ≥ T + grace` ⇒ `markSummaryDueSlotMissed(T, …)` + warn `[summary-due] slot <T> missed (first seen after grace); no due sent, no absence judged`。**不补叫、不补判**——对已过去的 period 叫人是噪音,判缺席是冤枉。
3. **当前 slot 的 due 对账(专门预算,不受 backlog 挤占;R3-1)**:对 `getSummaryDueSlot(T)`(若为 open)每个 producer:`row = getLeadEventByLeadAndId(lead, dueEventId)`(事务保证必在;缺失 ⇒ 该 producer 记 unknown 并 warn);`settlement = inspectDeliveryState(project, canonicalLeadEventDeliveryId(envelope(row)))`;`absent_identity` ⇒ `enqueueLeadEvent(envelope(row))`。首投与崩溃补投是同一条路径(R2-1)。
4. **backlog(公平、有界)**:`batch = listDueSummarySlots(now, limit = 8)`(按 `next_attempt_at` 到期顺序;当前 slot 若也在其中不重复处理步骤 3)。对 batch 中每个 slot:
   a. 先做同步骤 3 的 due 对账;
   b. 若 `now ≥ slot_start + grace_ms` ⇒ 按 §2.3 执行 prepare → side effects → settle;
   c. 任一步抛 ⇒ `deferSummaryDueSlot(slot, now + min(5min × 2^attempts, 1h))`,继续下一个 slot。成功 settle 的行 `next_attempt_at = NULL`。
   ⇒ 持续失败的 slot 被推到队尾(指数退避,上限 1h),不会永久占满批次;每个历史 slot 最终都能得到尝试。
5. gh 调用上界:快照① 仅在开 slot 时(≤1 次/pass);快照② pass 级 memo、多 slot 共用(≤1 次/pass)。

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

**写入与投递(R1-2 / R2-1:write-ahead 行 + 队列身份对账,单一路径)**

```
// 开 slot 事务内(§2.1 步骤 2):appendLeadEvent(lead, eventId, "summary_due", payload, "summary-due") ×N
// 每 pass 步骤 3(所有 open/prepared slot):
row = store.getLeadEventByLeadAndId(lead, eventId)              // 事务保证存在;缺失 ⇒ 该 producer 记 unknown 并 warn(不该发生)
settlement = inspectDeliveryState(project, canonicalLeadEventDeliveryId(envelope(row)))
if settlement.kind === "absent_identity" → enqueueLeadEvent(envelope(row))   // 首投 = 补投 = 同一条路径
```

- 崩在事务提交后、enqueue 前:下一 pass 队列里没有该身份 ⇒ `absent_identity` ⇒ 投。**没有「已写行、永不入队」的状态**。
- `enqueueLeadEvent` 抛(`No runtime registered` / renderer 抛)⇒ 该 Lead log 一行,其他 Lead 继续;下一 pass 同路径重试。
- 对账在**每个 open/prepared slot** 上做,直到 slot settled;并且**先于**结算(§2.1 顺序),避免重启越过 grace 时把「还没投」记成 undelivered。

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

`last_delivered` 来自开 slot 时的快照①:该 Lead 前缀 `summary/<project>/<lead>/` 下 `createdAt` 最大的一张;其 `period` 从标题 `Summary: <project> · <period>` 解析(解析失败为 null)。该值同时写进 due 行 payload 与 slot 的 `producers_json`,崩溃后不需要也不会重新生成(R2-2a)。

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

**触发**:对 batch 中每个 `status ∈ {open, prepared}` 且 `now ≥ slot_start + grace_ms` 的 slot 行(prepared 是崩溃后必须重放的状态,R3-8)。

**快照②(R1-3 / R3-6)**:open 行结算时**重新**调用 `listSummaryPulls()`(pass 级 memo);结果——**包括 `unavailable`**——冻结进 `settle_result_json`。unavailable 是本轮 fail-closed 的终态结果:仍 prepare → 「不可得」轮报 → settle,下一 slot 再试;**不**让 slot 停在 open 等 gh 恢复(确定性的 500 行截断永远不会自愈,会变成永久 wedge)。快照①只服务 `last_delivered`,两拍**不**共用。

**已交判据(R1-3:绑定 period 的权威身份)**——纯函数 `classifyRound(slot, pulls, settlements)`:

- 期望分支 `expectedBranch = summaryDeliveryBranch({ project, author: lead, period: slot.period })`,算法即 `summary-delivery.ts` 的 `branchFor`(`summary/<project>/<lead>/<sha256(JSON{project,author,period})[:16]>`)。**本单把该纯函数提到 `flywheel-comm/src/summary-contract.ts` 导出并让 `summary-delivery.ts` 调用它**(行为不变;测试用今晚真实 PR 钉死:`{growth, reflection-lead, "2026-09-06/2026-09-06"} → summary/growth/reflection-lead/269dc60b2dd3fb93`,已本机复现)。
- `delivered = "exact"` ⇔ 存在 PR `headRefName === expectedBranch`(任何 state、任何时间——Lead 提前交也算;账本完整性由 §2.4 的截断守卫保证)。**只有 exact 计入 N**(R2-4)。
- `delivered = "period_mismatch"` ⇔ 无 exact,但存在 PR 前缀 `summary/<project>/<lead>/` 且 **`createdAt` ∈ [T − cadence, T + grace)**(用 createdAt 不用 updatedAt:旧 period PR 被 comment/merge 不会误判)。**不计入 N,留在 M−N 差额里**,单列姓名与 title period 作诊断证据——Lead 交了别的 period,本轮仍是未按约交。
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

两条正交的轴(R3-3):**交付轴** `delivered ∈ {exact, period_mismatch, none, unknown}` 与 **投递健康轴** `due_delivery ∈ {delivered, undelivered, unknown}`。只有 `exact` 有「结果优先」的覆盖权。

```
delivered = exact                               → delivered[]       (唯一计入 N;due_delivery 不再记录任何诊断)
delivered = period_mismatch                     → period_mismatch[] (不计 N;不进 absent)
                                                  ∧ due_delivery = undelivered → 同时进 undelivered[](触发告警)
                                                  ∧ due_delivery = unknown     → 同时进 delivery_unknown[]
delivered = none ∧ due_delivery = delivered     → absent[]
delivered = none ∧ due_delivery = undelivered   → undelivered[]
delivered = none ∧ due_delivery = unknown       → delivery_unknown[] (绝不进 absent)
delivered = unknown(ledger 不可得)             → 交付轴不分类、counts 省略、absent/period_mismatch 不产出;
                                                  投递健康轴照常:undelivered[]/delivery_unknown[] 仍产出并告警
```

**补投后立即结算的口径(R3-2)**:`enqueueLeadEvent` 只返回 durable queue receipt,投递是异步 loop;若步骤 3 刚补投、步骤 4 就结算,该 producer 的 settlement 通常是 `live.QUEUED, deliveredAt=null` ⇒ **如实记 `undelivered` 并告警**——越过 grace 还没有送达证据就是机制没在 grace 内把话送到,不用竞态、不伪造同步投递。

**payload 增量**(旧字段一个不动,新字段全可选):

```ts
round_ledger: "ok" | "unavailable",
producer_count?: M,                 // ledger ok 时才有
delivered_count?: N,
producers?: Array<{ project, lead,
  delivered: "exact"|"period_mismatch"|"none"|"unknown",
  delivered_pr?: { number, url, state, title_period: string|null },
  due_delivery: "delivered"|"undelivered"|"unknown" }>,
absent?: string[], undelivered?: string[], delivery_unknown?: string[], period_mismatch?: string[],
report_line?: string,        // 下表拼好的对账行(逐字),Raya 直接转述
```

**指令文本追加**(接在既有 `summary` 之后;R2-5:**无条件汇报**):

既有 FLY-2131 指令写「有 review/吸收/追问活动时在 #raya 发可见汇报」——本轮没有 PR 活动恰是缺席最需要被看见的时候。本单在 `summary` 末尾追加一段,措辞固定、测试逐字锁定:

```
【本轮对账(FLY-2382)】无论本轮有没有 review/吸收/追问活动,都要在 #raya 发一条汇报,
并逐字包含下面这几行(不要改写、不要省略):
<report_line 各行>
```

`report_line` 生成规则(纯函数,逐行):

| 情况 | 行 |
|---|---|
| ledger ok,absent 非空 | `本轮 ${N}/${M} 份已交;未交:${absent 短名…}` |
| ledger ok,absent 空,N === M | `本轮 ${M}/${M} 份已交。` |
| ledger ok,absent 空,N < M(差额全是 period_mismatch / undelivered / unknown) | `本轮 ${N}/${M} 份已交;无人「未交」——差额见下。` |
| period_mismatch 非空 | `按其他 period 交付(不计本轮):${lead}(${title_period ?? "period 不可读"})…` |
| undelivered 非空 | `未送达(机制问题,已告警):${…}` |
| delivery_unknown 非空 | `送达状态不可得(不计未交):${…}` |
| ledger unavailable | `本轮交付状态不可得(${reason 短语}),只报吸收不报缺席。`(无 N/M,无交付轴名单;投递轴两行照常) |

短名 = leadId;若同 slot 内 leadId 跨项目重名则显示 `project/lead`。

**report_line 安全化(R3-7)**:所有进入 report_line 的外部文本只有两类——`title_period` 与 `reason`。`title_period` 仅在通过 summary-contract 的 period 语法(`<ISO>/<ISO>` 两端可 `Date.parse`,复用 `summary-contract.ts` 的 `parsePeriod` 校验函数,导出即可)时保留原文,否则置 null;`reason` 取自本单自己生成的固定短语表(`truncated at gh --limit 500` / `gh exit <code>` / `malformed gh output: <field>` / `timeout`),不透传 stderr。生成后再对整段做:单行化(`\r\n\t` → 空格)、剔除 C0/C1 控制字符与零宽字符、把 `@` 替换为 `@\u200b`(不触发 mention)。Raya 端拿到的是这段清洗后的字面量;测试含伪指令、@everyone、控制字符、非法 period 四种注入格。

**Raya 轮事件写入(R1-2:不改 FLY-2131 语义)**:保持现有 `appendLeadEvent` + `enqueueLeadEvent(envelope)` 的 write-ahead 流程与既有测试(append 成功、enqueue 崩溃、下一 pass 重放)。差别只有两点:(a) 触发条件从「当前 slot」改为「open slot 且过 grace」;(b) payload 加字段。roundId 仍 `summary-absorption:<slotISO>`。

**结算落账(R2-2b/c:先冻结,再副作用,最后 settled)**:

```
1. status=open ⇒ 取快照②(pass 级 memo;可能是 unavailable)、读各 due settlement、classifyRound ⇒ resultJson
   prepareSummaryDueSlotSettlement(T, now, resultJson)   // CAS open→prepared;失败(已 prepared)则读回冻结结果
2. status=prepared ⇒ 只读 settle_result_json,不再分类(重试看到的永远是同一份 A)
   a. 有 Raya:appendLeadEvent(raya, roundId, payload(含 result)) + enqueueLeadEvent   // 既有 write-ahead 语义
      无 Raya:跳过 a;warn 一行(best-effort,at-most-once-per-pass:重放的 pass 可能再打一行)
   b. undelivered 非空:alert(eventId 稳定,一 slot 一条)
3. a(若有 Raya)与 b 都被 durable 接受 ⇒ settleSummaryDueSlot(T, now)   // prepared→settled,next_attempt_at=NULL
```

任一步抛 ⇒ slot 停在 prepared,`deferSummaryDueSlot` 退避,之后从步骤 2 重放;Raya 侧 `appendLeadEvent` 冲突返回旧 row,其 payload 与冻结结果一致(同一份 A)。

**undelivered 告警(R1-6:明确 owner / severity / 扇出)**:
- kind 复用 `inbox_loop_stalled`(owner `founder_direct`,arc `none_escalate`,`kind-contract.ts:94`)——语义就是「Bridge→Lead inbox 通路没送到」。**明确后果**:这是 founder-facing 告警;在 8/11 producer 通路未证明可达的现状下,首个生产 slot 很可能列出多名 Lead。这正是本单要暴露的静音失败,不做隐藏。
- **聚合**:一 slot 一条,`eventId = summary_due_undelivered:<slotISO>`,`leadId: "patrol-roster:summary-due"`(沿用 patrol 的 fleet-scoped 写法),`projectName: FLEET_ALERT_PROJECT`,`severity: "warning"`(不触发 DM),title `summary_due not delivered to N Lead inbox(es)`,body 逐行 `project/lead: <settlement kind/state>`(取自冻结结果)。`delivery_unknown` 不告警(只在轮报里可见)。alert 在 prepared 阶段发、eventId 稳定,重放最多重复投递同 id(sink 侧按 eventId 去重是既有合同)。
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
- **截断守卫(R2-7)**:返回条数 `=== 500` ⇒ 整体 `unavailable("truncated at gh --limit 500")`——有界窗口不冒充完整账本;本轮不判缺席,轮报走「不可得」行,并 warn 提示需要分页/提高上限(Raya 仓当前 24 张 PR,离上限尚远,到时再做分页是一行改动)。
- **严格校验**:顶层必须是数组;每项对象;`number` 正整数;`state ∈ {OPEN,MERGED,CLOSED}`;`url` 经 `new URL()` 且 `protocol === "https:"`、host `github.com`、路径恰为 `/<repo>/pull/<number>`(与 `number` 一致);`headRefName`、`title` 为字符串且 ≤ 512;`createdAt/updatedAt` 可 `Date.parse`。任一项校验失败 ⇒ 整体 `unavailable("malformed gh output: <field>")`(宁可本轮不判,不判错)。
- 只保留 `headRefName` 匹配 `^summary/([A-Za-z0-9][A-Za-z0-9._-]*)/([A-Za-z0-9][A-Za-z0-9._-]*)/[0-9a-f]{16}$` 的行;不匹配的(如 `fly-2249-bargein-v2`)静默跳过。
- `titlePeriod` = 标题匹配 `^Summary: <project> · (.+)$` 的捕获,否则 null。
- 失败 `reason` 规范化:去掉 ANSI/换行、截 200 码点;stderr 不得原样进 Lead prompt。
- 边界:`--limit 500` 是窗口;命中窗口即 unavailable(上一条),不做「最近的总在窗口内」的假设。

### 2.5 规则文本(`lead-rules-base/summary-inflow.md`)

在 `## Your obligation` 后加 `## The due signal (FLY-2382)`:节奏以 Bridge 事件 `[summary_due]` 送达;收到即写并**原样使用事件里的 `--period`**(机制据此识别已交);没有事实与判断可写时可以不交(§6.3),未交会以「未交」出现在 Raya 轮报里——可见性不是催促;`[summary_due]` 是唯一节奏来源,仍禁止本地 timer/cron/launchd(R4)。并把「do not invent one, add reminders」改写为「the cadence is delivered to you by `[summary_due]`; do not invent one or add your own reminders」。bundle 测试只断文件在/不在,不需改。

### 2.6 接线(`bridge/plugin.ts:9892`)

```ts
const summaryAbsorptionPass = createSummaryAbsorptionPass({
  projects, store,                                   // store Pick 扩:getLeadEventByLeadAndId + summary_due_slots 七个方法(事务在 StateStore 内部)
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

- **schema**:新表 `summary_due_slots`(`CREATE TABLE IF NOT EXISTS`,与仓内其他表同一套启动迁移;无回填;状态相关 CHECK 见 §2.1)。回滚(revert PR)后表留在库里无害;再前滚时 `IF NOT EXISTS` 幂等。`lead_events` 无 schema 变化。
- **无新 flag / env / plist / alert kind**。
- **flywheel-comm**:`summary-contract.ts` 新增导出 `summaryDeliveryBranch()`,`summary-delivery.ts` 改为调用它——行为零变化(用真实 PR 分支名锁定),不改 CLI 子命令(FLY-1914 消费者 sweep 不触发)。
- **Raya 读侧兼容**:`summary_absorption_round` 旧字段与 roundId 语义不变;新字段可选;write-ahead 恢复测试原样保留。
- **Lead 侧兼容**:未升级 rules bundle 的 Lead 收到 `[summary_due]` 也能按自足文本行动。

### 2.8 负向守卫(实现必带的测试)

| 守卫 | 断言 |
|---|---|
| G1 granularity unselected / 配置非法 | 不开 slot、不结算;每 pass 一行 warn;到 `T+grace` 转 missed |
| G2 同 slot 重跑 pass | 首投经 absent_identity 恰一次;settlement `live.LEASED+deliveredAt`/`ACKED` 不重投;队列身份再次 absent ⇒ 再投一次 |
| G3 崩溃格(逐格) | 开 slot 事务中断 ⇒ slot 与 due 行全无;事务后 enqueue 前 ⇒ 下一 pass 补投;prepare 后 Raya append 前 / append 后 enqueue 前 / enqueue 后 alert 前 / alert 后 settle 前 ⇒ 重放只读冻结结果,Raya 行 payload 与 slot 结果一致;Raya round 既有崩溃测试原样保留 |
| G3b 顺序 | 重启时 `now ≥ T+grace` 且 due 队列身份 absent ⇒ 本 pass 先补投(队列出现该身份)再结算;结算读到 `live.QUEUED` ⇒ **如实记 undelivered 并告警**;不依赖异步投递竞态 |
| G3c 有界 + 公平 | 20 个 prepared slot(前 8 个 Raya enqueue 持续抛)+ 当前新 slot:跨 5 个 pass 断言——每 pass 处理 ≤ 8 个 backlog、当前 slot 的 due 当 pass 首投、失败者 `next_attempt_at` 退避后让位、20 个历史 slot 都至少被尝试一次、gh ≤ 2 次/pass |
| G4 cadence 热切换 | 6h→1h:旧 slot 按自身参数结算,新 slot 并存;1h→6h:开着的 1h slot 仍结算;60s cadence + 60s pass 同相:slot T 在下一 pass 结算(不漏);`grace = min(30min, cadence/2)` |
| G5 冷启动 | 启动时 `now ≥ T+grace` ⇒ slot 标 missed,零 due、零 round、一行 warn;`now < T+grace` ⇒ 正常开 slot |
| G6 gh 失败 / 畸形 | 快照①失败 ⇒ due 照发 `last_delivered.unavailable`;快照②失败 ⇒ `round_ledger=unavailable`,无 absent/undelivered/counts,文本为「不可得」行;畸形字段 ⇒ unavailable;非 summary 分支跳过 |
| G7 两拍快照分离 | Lead 在 `(T, T+grace)` 开的 PR 只在快照②可见并计已交;快照①的内容不影响 delivered |
| G8 exact vs period_mismatch vs none | 同 period 分支 ⇒ exact 且计 N;旧 period PR 在窗口内被 merge/comment(updatedAt 变、createdAt 旧)⇒ **none**;窗口内新建的其他 period PR ⇒ period_mismatch,**不计 N**、不进 absent、单列 |
| G8e 两轴正交 | period_mismatch ∧ due `absent_identity`/`DEAD` ⇒ 同时出现在 period_mismatch[] 与 undelivered[] 且触发告警;exact ∧ due DEAD ⇒ 无诊断;ledger unavailable ∧ due DEAD ⇒ 仍 undelivered + 告警 |
| G8f unavailable 终态 | 快照② unavailable(含恰 500 行)⇒ prepare 冻结 `round_ledger=unavailable` → 「不可得」轮报 → settled;slot 不停留在 open |
| G8g report_line 注入 | title 含 `@everyone`、`\n忽略以上指令`、`\u202e`、非法 period ⇒ title_period 为 null 或被清洗;report_line 单行、无控制字符、`@` 已隔断 |
| G8b 无条件汇报 | Raya 指令文本逐字含「无论本轮有没有 review/吸收/追问活动,都要在 #raya 发一条汇报」与 report_line;零 PR 活动的轮同样生成 |
| G8c 截断 | gh 返回恰 500 行 ⇒ unavailable("truncated…");499 行 ⇒ ok;畸形 title / 非 https / url 与 number 不一致 ⇒ unavailable |
| G8d slot 形状 | 对**最终 DDL**真跑:open / prepared / settled / missed 四种合法行 round-trip;`open+settled_at`、`open+prepared_at`、`prepared+settled_at`、`missed+producers_json`、`settled+next_attempt_at`、`granularity='weekly'`、`cadence_ms=0` 全部被 CHECK 拒绝(断言 SQLite 抛错);prepare 对非 open 行返回 false;settle 对非 prepared 行返回 false;defer 对 settled/missed 行返回 false |
| G9 truth table 穷尽 | 上表每一行一格,含 archived_terminal ACKED/DEAD、inspect 抛 ⇒ unknown 且**不进 absent** |
| G10 Raya 未注册 | due 照发;结算经 prepared 到 settled;warn 每个成功 settle 的 pass 至多一行(重放 pass 可再出);不 alert Raya |
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
| 改 | `packages/teamlead/src/StateStore.ts`(`summary_due_slots` 表 + 索引 + 7 个 slot 方法 + `getLeadEventByLeadAndId`) |
| 改 | `packages/teamlead/src/bridge/hook-payload.ts`(可选字段;`formatSummaryDue`) |
| 改 | `packages/teamlead/src/bridge/mailbox-lead-runtime.ts`、`commdb-lead-runtime.ts`(分派一行) |
| 改 | `packages/teamlead/src/bridge/plugin.ts`(接线 §2.6) |
| 改 | `packages/flywheel-comm/src/summary-contract.ts`(导出 `summaryDeliveryBranch`、导出既有 `parsePeriod` 校验)、`summary-delivery.ts`(调用 `summaryDeliveryBranch`) |
| 改 | `packages/teamlead/lead-rules-base/summary-inflow.md` |
| 测试 | `bridge/__tests__/summary-absorption-rider.test.ts`(扩,保留既有)、`summary-producer-roster.test.ts`、`summary-delivery-ledger.test.ts`、`summary-round-classify.test.ts`、`state-store-summary-due-slots.test.ts`、formatter parity 测试、`flywheel-comm/src/__tests__/summary-contract.test.ts`(G17) |
| 新 | `engineering/doc/milestones/FLY-2382.md`(ship 时) |

不碰:`commands/summary.ts`、raya 仓、`projects.json`、feature-flag registry、kind-contract、`summary-pr-merge.ts`。

## 4. 实施顺序(TDD;每块 `pnpm lint` + `pnpm -r build` + 聚焦 vitest 全绿;**排除 `**/tmux-viewer.macos.test.ts`**)

| # | 块 | 主要测试 |
|---|---|---|
| 1 | `summaryDeliveryBranch` 提取(flywheel-comm) | G17;`summary-delivery` 既有测试不变 |
| 2 | `summary_due_slots` 表 + 8 个 StateStore 方法(含 `getLeadEventByLeadAndId`) | G8d;`openSummaryDueSlotWithDues` 事务原子性(中途抛 ⇒ 零行);defer 退避计算 |
| 3 | roster | 11 人 fixture;per-project;G12 |
| 4 | ledger | 录制 gh JSON(含今晚 #15–#24 与非 summary 分支);G6 校验矩阵 |
| 5 | classify | G8、G9 真值表、文本行全部分支、短名重名 |
| 6 | formatter + 两 runtime 分派 | G13、G14、三种 last_delivered |
| 7 | rider 两拍(slot 驱动) | 时间推进 harness:G1–G5、G3b、G3c、G7、G8b、G8e、G8f、G10、G11、G16;既有 FLY-2131 测试原样通过 |
| 5b | report_line 清洗 | G8g |
| 8 | 接线 + 规则 | 编译;bundle 测试绿;`pnpm test:packages:run`(排除 macos 视图用例) |
| 9 | 文档 | milestone、progress |

## 5. 风险与应对

| 风险 | 应对 |
|---|---|
| 8/11 producer inbox 通路生产未证明 | undelivered 单列 + 一 slot 一条 warning 告警;A4 选已证可达的 Lead;其余作为本单**发现**移交 infra,不冒充验证 |
| Raya 未激活 ⇒ A2 真机不可验 | §0 明确 rollout prerequisite;本单只钉单测与 settled 日志;A2 在 FLY-2131 激活后的第一个真实轮验收 |
| founder-facing 告警在首个 slot 可能列多名 Lead | 有意为之(暴露静音失败);severity warning、聚合一条、无 DM |
| Lead 不用事件给的 period | 记为 period_mismatch,**不计已交**,轮报单列并点名 title period;规则文本要求原样使用 |
| gh 抖动 | 快照①失败不阻断叫人;快照②失败是本轮的冻结结果(「不可得」轮报,仍 settled),下一 slot 再试;不区分 transient/truncated——两者都不该让 slot 无限 open;每 pass 最多两次 gh(开 slot 一次 + 结算一次) |
| epoch 对齐的 6h 边界(17/23/05/11 PDT) | 不归本单;founder 改 cadence 即改相位 |

## 6. 验收剧本(A1/A3/A4 真机;A2 见 §0 口径)

529 房(或生产首个节奏点,由 Lead 定;不投紧急重启票,走班车):
1. 等下一个 slot 边界(529 房可把 cadence 改到 600000 = 10min)。
2. A1:`sqlite3 -readonly teamlead.db "select lead_id, delivered_at from lead_events where event_type='summary_due' and event_id like '%:<slotISO>'"` ⇒ 11 行;`select * from summary_due_slots` ⇒ slot 行 status=open。
3. A4:已证可达 Lead(flywheel-eng-lead / flywheel-product-lead / belle-lead)inbox 出现 `[summary_due]`,Lead 据此跑命令开出 PR(链接);其分支名 = `summaryDeliveryBranch` 预期值。
4. T+grace:`summary_due_slots.status` 经 prepared 到 `settled`,`settle_result_json` 含该 Lead `delivered:"exact"`;bridge.log 一行 no-Raya warn(Raya 未注册)或 `summary_absorption_round` 行 payload.producers 长度 11 且 `summary` 含「【本轮对账(FLY-2382)】」段。
5. A3:管理台改 cadence,下一个新 slot 边界随之变化,无重启;旧 slot 正常结算。

## 7. Codex design review 处理记录

**R1(2026-09-06,plan blob @ ba2457fde,反馈 `/tmp/codex-rescue-design-feedback-flywheel-FLY-2382-plan-round1.md`)= CHANGES REQUESTED,5 阻塞 + 1 中等,全部采纳:**

1. slot 只按当前 `floor(now/cadence)` 计算 ⇒ 60s cadence 同相永不结算、热切换遗弃旧 slot、冷启动先叫再判 → **§2.1 新表 `summary_due_slots`**,第二拍从 open slot 驱动,missed 策略明确,G4/G5 补四组时间推进测试。
2. Raya round 改 claim-only 破坏 FLY-2131 write-ahead 恢复 → **撤回**;Raya round 保持 append+幂等 enqueue,due 走 patrol 的 append→claim 判新→absent_identity 补投(§2.2),既有崩溃测试保留(G3)。
3. `max(createdAt,updatedAt)` 不能证明本 period 已交;两拍共用快照漏 grace 内新 PR → **exact branch 绑定**(`summaryDeliveryBranch` 提到 summary-contract 并用真实 PR 锁定,G17)+ `other_period` 用 createdAt;快照①/② 分离(§2.3,G7、G8)。
4. unknown 进 absent、ledger unavailable 仍产 counts、settlement 状态不穷尽 → **fail-closed 真值表**(§2.3),`delivery_unknown` 单列,unavailable 不产 absent/counts(G9)。
5. Raya 未激活时用 log 代替 #raya 不能通过 A2;warn 非一行 → **§0 A2 改为 rollout prerequisite**,本单不宣称 A2 完成;warn 随 slot settled 只出一次(§2.3,G10)。
6. `interface = …` 非法 TS、`execFileRunner` 不存在、severity 必填、`inbox_loop_stalled` 是 founder_direct、gh JSON 校验不足 → §2.4 `type` + 注入 `execFileP` 的 `ExecFileAsync` 签名;§2.3 alert 聚合一 slot 一条、severity warning、owner 后果写明;gh 严格校验 + reason 规范化(G6、G16)。

**R2(2026-09-06,plan blob @ cf83dcaf6,反馈 `/tmp/codex-rescue-design-feedback-flywheel-FLY-2382-plan-round2.md`)= CHANGES REQUESTED,5 阻塞 + 2 高,全部采纳:**

1. `append` 后再 `tryClaimLeadEvent` 判新行必为 false → **改为单一路径**:开 slot 事务内 append;每 pass 读行 → 查队列身份 → `absent_identity` 才 enqueue(首投=补投,§2.1 步骤 3、§2.2)。
2. slot 表无跨崩溃一致的提交点 → (a) `openSummaryDueSlotWithDues` 一个事务写 slot + 全部 due 行,快照① per-producer 上下文同时进 `producers_json` 与 due payload;(b) `prepareSummaryDueSlotSettlement` CAS 先冻结分类结果再做副作用;(c) Raya enqueue 与 alert 都 durable 接受后才 settled;no-Raya warn 口径降为 at-most-once-per-pass(§2.1、§2.3,G3 逐格)。
3. 结算先于补投、open slot 无上界、gh 次数矛盾 → pass 顺序钉为「开 slot → 对账/补投所有 open slot → 结算」;`listOpenSummaryDueSlots(limit 8)` oldest-first;快照② pass 级 memo,每 pass ≤ 2 次 gh(§2.1,G3b、G3c)。
4. `other_period` 计入 N 违背本轮权威身份 → 改名 `period_mismatch`,**不计 N**、不进 absent、单列并点名 title period(§2.3,G8)。
5. 旧指令允许无活动时不发汇报 → `summary` 末尾追加固定措辞「无论本轮有没有 review/吸收/追问活动,都要在 #raya 发一条汇报,并逐字包含 report_line」,formatter 测试逐字锁定(§2.3,G8b);真机 A2 仍按 §0 前置执行。
6. missed 行与 NOT NULL schema 冲突 → `first_seen_at` 统一、slot 专属列可空、状态相关 CHECK 约束,四种形状 round-trip + 交叉形状被拒(§2.1,G8d)。
7. `--limit 500` 在「exact 任何时间均算」下不 fail-closed;title 未校验 → 恰 500 行 ⇒ unavailable(truncated);title 长度、https、url 与 repo/number 一致性校验(§2.4,G8c)。

**R3(2026-09-06,plan blob @ 8d9d3e035,反馈 `/tmp/codex-rescue-design-feedback-flywheel-FLY-2382-plan-round3.md`)= CHANGES REQUESTED,4 阻塞 + 3 高 + 1 中,全部采纳(三轮未过已按规则报备 Lead,ask `831b6c16`):**

1. `LIMIT 8 ORDER BY slot_start` 饿死当前 slot 与后续 slot → 当前 slot 的 due 对账设为专门预算(步骤 3);backlog 改为 `next_attempt_at` 到期顺序 + 指数退避(5min×2^n,上限 1h)的 durable 公平调度(§2.1,G3c 跨 pass 断言)。
2. G3b 把补投后 `live.QUEUED` 当 delivered → 撤回;越过 grace 无 `deliveredAt/ACKED` 证据即如实 `undelivered` 并告警(§2.3,G3b)。
3. `period_mismatch` 遮蔽 inbox 故障 → 交付轴与投递健康轴正交,只有 exact 有覆盖权;mismatch ∧ undelivered 同时进两条诊断并告警;ledger unavailable 时投递轴照常(§2.3,G8e)。
4. CHECK 未实现四态互斥 → DDL 改为四个互斥完整 shape 的 OR,加 granularity 枚举、cadence>0、grace≥0;G8d 对最终 DDL 真跑失败断言(§2.1)。
5. `transaction` 是 `CompatDb` 内部能力、`getLeadEventByLeadAndId` 不存在 → 事务封装进 `openSummaryDueSlotWithDues` 内部,不进 Pick;正式新增并测试 exact getter;方法计数改为 8(§2.1、§2.6、§3)。
6. 快照② unavailable 终态自相矛盾 → 选定「unavailable 冻结结算」:prepare → 不可得轮报 → settled,下一 slot 再试;§5 风险表同步(§2.3,G8f)。
7. `titlePeriod` 未清洗即让 Raya 逐字转述 → 仅通过 summary period 语法者保留(复用 `parsePeriod`),reason 用固定短语表;report_line 单行化 / 去控制字符 / 隔断 `@`;注入测试四格(§2.3,G8g)。
8. 规范文本未同步 → 触发条件含 prepared;时序图 no-Raya 分支与 settle 顺序修正;G10 口径改为 at-most-once-per-pass;文件清单计数修正。
