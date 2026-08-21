# FLY-1795 精确签收与零主动告警 — 设计修正

> **[SUPERSEDED 2026-08-20]** 本修正连同 v1 复杂版 plan 已被 founder 整层打回覆盖;现行方案见 plan.md(v2 极简版)。保留本文件仅作历史记录。

Issue: FLY-1795 (https://linear.app/geoforge3d/issue/FLY-1795/消息层bug-某个-runner-lane-的收件永不-ack-3-个-in-flight-槽被占死后续指令按租约每-10)
日期: 2026-08-19
基于: plan.md

## 修正效力

本文件记录实施中收到的 founder 设计反馈，并覆盖 `plan.md`、`research.md`、`exploration.md` 中与之冲突的部分。分支不回滚；已经完成且不冲突的器官保留，冲突概念以增量删除和负回归收口。

## Founder 逐字反馈

> 1. 系统自动触发收尾钩子(hook)的问题:Runner 每结束一轮工作,系统会自动触发收尾钩子,但前提是它要自己正确地去 Ack。如果是系统自动触发,一旦它 Ack 错了 message 怎么办?
>
> 2. 自动发告警的问题:对于「list 停留超过 10 分钟自动给 lead 发告警」的设计,我非常不建议做。有的时候比如 lead 比较忙,你发一堆告警,最后这些告警就会把他的 message queue 给填满。这种事情已经发生过很多次了,我们之前把整个 watchdog 全部拆掉,就是因为发现了这些问题。我不希望再加同样的东西进来。现在没有 Ack 可能只是个小问题,但如果因为告警把我们系统拖到完全不能用的境地,那就是大问题了。所以完全不可以再加一些新的告警进来,特别是这里——倒不是说完全不能加告警,而是我觉得在这里加这个东西对于解决问题没有必要说实话,整个这一段给我的感觉都是在做一些 overcomplicating、但实际上弊大于利的事情。

## 废除概念

1. **废除 LEASED dwell 主动告警**：不扫描“超过 10 分钟”的 lane，不创建 episode，不向 Lead、Discord 或任何其他 sink 推送消息。
2. **废除 mailbox 专用 alert outbox / StateStore intent / notifier event kind**：不引入第二条可重试告警管道，也不让故障 lane 反向制造更多 mailbox 压力。
3. **废除 inhibition DEAD 主动告警**：安全禁令的 `inhibition`、`dead_reason` 和状态迁移仍必须可查，但本 issue 不新增主动消息。
4. **废除 dwell 阈值配置**：移除 `FLYWHEEL_MAILBOX_DWELL_ALERT_MS` 与所有运行时接线；“零新告警”没有可误开的开关。

## 保留器官

1. **0a runner ACK 面**：成功的 Claude Stop 仍触发机械签收，但改为精确 ID 绑定；StopFailure、Codex notify、证据缺失或证据冲突均不签。
2. **0b ACK 正确性热修**：已投递的 QUEUED 行可接受对应旧 attempt 的 late ACK；从未投递的 QUEUED 行拒绝 ACK；旧 attempt 不能签当前新 attempt。
3. **内容耐久**：ACK 只改变结算状态，不销毁正文；`first_delivered_at` 和 attempt 证据不因重排而丢失。
4. **被动可查的账**：`mailbox_transitions` 继续在同一 SQLite 事务内记录状态迁移、投递与拒签；保留有界、只读、身份绑定的 `inbox --replay`，并强制展示 `DEAD.dead_reason`。

## 0a 精确 ID 绑定契约

机械 ACK 的凭据不是“这个 exec 目前有哪些 LEASED 行”，也不是时间窗、最新行或相邻行扫描，而是**本轮真实注入 Claude 上下文的那一个 mailbox 投递事件**：

1. runner lane 的模型投递批次固定为单成员；信封携带唯一 `batch_id` 和唯一 `[lead-instruction <message_id>]`。
2. Stop hook 只读取本轮 transcript 最后一个真实 user row；仅当它严格呈现一个单成员 mailbox 信封时，提取该 `batch_id + message_id`。
3. 数据库用 `exec_id + recipient_kind=runner + type=instruction + carrier=inbox + batch/attempt + message_id + delivered evidence` 做原子匹配，只更新该一行。禁止按 exec、时间范围、`latest` 或邻接关系扩展选择集。
4. 若信封缺失、含多个 batch / message、ID 不合法、归属不符、attempt 已被新 attempt 取代，或行从未投递，则写被动拒签证据并保持原状态，交给租约重投。原则是：**宁漏签，不错签**。
5. Stop report 与精确 ACK 仍是两个 sibling effects：任一失败不吞掉另一边；但共享身份 preflight 失败时两边都 fail-closed。

## 修正后的验收

1. 成功 Claude Stop：上下文含一个真实投递信封时，只 ACK 该信封绑定的一行；同 exec 的相邻 LEASED / QUEUED 行保持不变。
2. 阴性：伪造 ID、batch 不匹配、多消息信封、普通 user turn、StopFailure、Codex turn、从未投递行均不 ACK。
3. 重投：同一旧 attempt 在 QUEUED 窗口内可由精确凭据结算；已经进入新 attempt 时旧凭据拒绝。
4. 观测：状态迁移和拒签原因可查询，正文可 replay；不创建 mailbox alert 表、intent、event kind，不主动发送任何 dwell / inhibition 告警。
5. 健康 lane 行为不变：投递后的下一次对应 Claude Stop 在 60 秒内完成精确 ACK；Lead lane 既有 ACK 路径不受影响。
