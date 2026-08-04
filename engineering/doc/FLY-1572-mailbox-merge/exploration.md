# FLY-1572 合表 + 迁移:两张信箱表并成一张 mailbox — 探索

Issue: FLY-1572 (https://linear.app/geoforge3d/issue/FLY-1572/消息层重构-c-批次1-合表-迁移两张信箱表并成一张-mailbox)
日期: 2026-08-04
基于: 无(上游为总纲 `doc/messaging-rework/design.md`,FLY-1569)

> 本文是设计节点的第一份文档:摸清现状、确认约束、列出设计要回答的问题。
> 权威设计 = `doc/messaging-rework/design.md`(FLY-1569 定稿)。本单是实施单 C(批次 1,依赖 A=FLY-1570 已 merge)。

## 1. 任务一句话

把 `lead_inbox`(37 列、只进不出、44k+ 死历史)和 `messages`(22 列、72h 自动删、留不住证据)合成**一张 `mailbox` 表**(`to_agent` 区分收件人)+ **一张 append-only 日志表**(历史永不删),投递循环从 per-Lead 扩到所有收件人,最后一公里适配器一行不改,迁移可回滚。

## 2. 上游约束(总纲 design.md 摘录,实施不得偏离)

- **两条铁律**:①队列只答「送到没送到」,永不 track「办没办」;②永不替 agent 建一张它看不见、关不掉的账。
- **状态机(批级,本单只建对,D 单让它转起来)**:`QUEUED → LEASED → ACKED / DEAD`。
- **重投 = 同一行重新可见**(SQS visibility timeout 语义),绝不复制新行 —— 这是治「表膨胀自激循环」的根。
- **三条防 watchdog 红线**:投递循环永不主动发消息;欠账数只是门铃里一行字;永远给 agent 合法出口。
- **本单不做**:租约到期重投/合批/死信(D 单)、Discord 直推收编(E 单)、task 表(F 单)、feature flag(明令禁止)。

## 3. 现状实测(生产 `~/.flywheel/comm/flywheel/comm.db`,2026-08-04 复测)

| 指标 | 2026-07-31(总纲快照) | 2026-08-04(本单复测) | 说明 |
| -- | -- | -- | -- |
| `lead_inbox` 总行数 | 44,567 | **49,531** | 继续膨胀中(FLY-1570 已于 08-04 merge) |
| 未消费(consumed_at IS NULL) | 176(issue 口径) | **9** | watchdog 拆除后重发风暴已停,活行数骤降 |
| `messages` 行数 | — | 687 | 72h 滚动窗口内 |
| `runner_phase_wakes` | — | 2,184(finished 1,863 / started 300 / pending 21) | pending 21 = FLY-1571 QA 抓到的结构性漏 |
| 库文件大小 | 145MB | 145MB | |

⚠️ 设计含义:验收标准 5「迁移后活行数 ≈ 迁移前未消费行数」必须**以迁移时刻的实测数为准**(现在是个位数,不是 176)。

## 4. 已亲自确认的关键证据

### 4.1 `lead_inbox` 37 列(lead-inbox-queue.ts:171 `LEAD_INBOX_SCHEMA`)

CREATE TABLE 本体 21 列 + `RECEIPT_LEAD_COLUMNS` migration 追加 16 列 = 37。同 schema 块里还有 `receipt_alert_outbox` / `loop_owner` / `loop_heartbeat` 三张辅助表(不在合表范围,但同文件同 exec)。

### 4.2 `messages` 表实际 ≈22 列(db.ts:38 + migrations)

CREATE TABLE 21 列;migration 另加 `delivered_at`(getPendingPushInstructions/markInstructionDelivered 在用,db.ts:5868-5890)。6 个发送方身份列:`sender_lease_key` `sender_generation` `sender_holder_pid` `sender_holder_start` `writer_pid` `writer_start` —— 压缩成 `sender_ref` 前必须读 writer_gap 历史(见 research.md)。

### 4.3 consumeGateResponse 语义缺口(db.ts:5897-5936,FLY-1571 QA 现场证据)

亲读代码确认:consume 的 UPDATE WHERE 是
```sql
WHERE execution_id = ? AND message_id = <response uuid>
  AND purpose = 'gate_response' AND state IN ('pending','started')
```
而 park_wake 行长这样:`purpose='park_wake'`, `message_id='gate-answer:<qid>'` —— **两个字段双双不匹配,`flywheel-comm check` 永远消费不掉**,行永停 pending(生产 pending=21 佐证)。这是「同一个义务在两套词汇表里各记一笔账」的病 —— 合表设计必须给出统一的消息身份(id)贯穿投递账本,不允许同一义务有两个 id 词汇表。重投/死信侧的修复归 D 单(FLY-1573),本单负责把**身份模型**建对。

### 4.4 依赖 A 已落地

FLY-1570(#771,e8f99d0e)删除 ~35,000 行追人 watchdog(runner-receipt-patrol / stuck-* / detection-* / park-watch / watchdog-judge 全家)。17 个「投递轨迹遥测 + 追人账本 + 路由实验残留」字段的活读者随之消失(逐字段核对见 research.md)。

## 5. 设计要回答的问题(带着去 research)

1. **两张表的全部读写方清单** —— 四条流各自从哪进、从哪出,rg 到函数级。
2. **17 个删除字段逐个核对**:FLY-1570 之后是否真的零活读者(不含测试)。
3. **writer_gap 历史**:6 个 sender 身份列当年防的是什么串写事故,压成 `sender_ref` 的安全条件。
4. **`mailbox` 命名冲突**:FLY-1497 的 flywheel-v2-kernel(flywheel-v2.db)已有 `mailbox` 表(17 表 schema 之一);teamlead/bridge 里也已有 `mailbox-lead-runtime.ts`。同名不同库 —— 设计文档必须明确「本单的 mailbox 建在 v1 comm.db」并写清与 v2 kernel 的关系,避免实施 runner/后人混淆。
5. **投递循环扩容的边界**:lead-inbox-loop.ts 怎么发现收件人、Runner 收件人怎么接入(今天 Lead→Runner 是发送时同步直写 inbox.json,不经循环)——扩容后触发面怎么变、适配器如何保证一行不改。
6. **迁移机制**:v2-cutover 包已有一套 backup/rollback/幂等迁移模式,可否复用其骨架。
7. **append-only 日志表**的写入时机(双写?ACKED 时搬?)与查询职责边界。
8. **`runner_phase_wakes` 与 mailbox 的关系**:wake 推送账本是否保留、其 message_id 词汇表如何与 mailbox id 对齐。

## 6. 风险与坑(先挂出来)

- **writer_gap**:sender 身份列压缩是唯一被 issue 明文警告的坑。
- **145MB 表的迁移窗口**:迁移期间 Bridge 必须停写(单写者),备份 + 回滚要实测。
- **同名冲突**(v1 mailbox vs v2 kernel mailbox)。
- **`no feature flag` 铁律** ⇒ 迁移是单向 cutover + 备份回滚,不是双轨并行。
- **`messages` 的 72h 自动删** vs 日志表「永不删」——迁移后过期删除逻辑必须只作用于 mailbox 活表语义(改为 D 单的死信/保留策略之前,本单要定义清楚谁删什么)。
