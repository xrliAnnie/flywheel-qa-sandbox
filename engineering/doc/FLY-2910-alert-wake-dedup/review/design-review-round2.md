# Design Review — plan.md (Round 2)
Date: 2026-09-25
Author: Codex (gpt-6-astra)
Status: CHANGES REQUESTED

## Summary

v2 已关闭 R1 的投递前建证据、对象/动作集合交叉误认和窗口无限续期问题；plain 照投按本轮明确的范围边界接受，不再要求扩张覆盖。仍需修正两项：工单代次合同与实际账本不符，以及升级消息的累计计数。

完整重读 v2（含 §13）并核对相邻源码、现有测试及 strict 回放。Reviewed head：`73aa73c3dc1f089a3c97830db87227ac82124875`；plan SHA-256：`a90729cdae5bb39a16566ccd05149b105126a2fb8568035aeadc77f91829c05c`。

只读重跑 `replay_strict.py` 的冻结区间，复现 154 封信、152→102 批次，含 27 封 A 类合并、5 封 B 类合并和 18 封 info 摘要。另在隔离的内存 SQLite 中验证下面的账本 SQL 反例，命令均退出 0；未执行 TypeScript 测试套件，未修改源码或生产数据库。回放数字可复现，但 generation 的近似掩盖了第 1 项问题。

## What's Good (Keep)

- **R1 #1 关闭。** `markAuditDelivered` 位于匹配的 adapter receipt 和 owner 检查之后（`lead-inbox-loop.ts:494–526`）。按 fingerprint 隔离已交付证据，删除类别锚点，解决 A-fail/B-ok/A-dead/A-again 路径；保留该集成用例。
- **R1 #2、#4 的修正保留。** 原始标题、正文业务 ID/数字和 zombie 完整集合 sig 保留了上轮反例中的区别；对象与动作绑定，固定窗口不因升级续期。
- **R1 #5 按本轮边界关闭。** plain/未知形状照投有明确说明及负向测试；摘要覆盖因此限于可识别告警，不把“观测到 0 条”解释为以后不会出现。
- 冻结批次异常行为与源码一致，删除两次失败计数器是正确减法。保留 audit ACKED 的 fence、原始 Discord 信封、项目开关和现有固定页，不需要新 daemon。

## Issues & Recommendations

### 1. [P1] 工单代次既无法覆盖正常重复，也不能用 opened_at 唯一区分复发

**问题：** plan §3.4（98–100 行）假设每封 A 类信的 `source_ref` 都能查到其工单，并以 `(correlation_key, opened_at)` 作为唯一代次。这两个假设均不成立。

**为什么：**

- **正常重复就查不到，不只是历史被覆盖。** `StateStore.upsertAlertMailboxLedger` 的 `merged` 分支只给旧 canonical 行增加 `fire_count`，返回的 delivery 却使用新 eventId（`StateStore.ts:24760–24774`）；runtime 又把新 eventId 写入 `source_ref`（`lead-inbox-runtime.ts:832–839`）。现有测试已经明确断言：第二次 fire 后旧事件计数为 2，而 `getMailboxLedgerByEventId("evt-mailbox-2")` 为 undefined（`alert-threads-tickets.test.ts:430–453`，本轮核对源码，未执行该测试）。因此即使第一封已经送达、内容完全相同且工单一直未解决，第二封也必然走 `unprovable → wake`。相同 eventId 则已由原 mailbox identity 去重，不能用它制造两封独立信来通过 §8.1。strict 回放为每封信构造 correlation-key generation，会绕过这一真实失败；其“当时自己的工单行存在”的注释不正确。
- **opened_at 不是 generation ID。** 两种账本都用 SQLite `datetime('now')` 写 `opened_at`，精度为秒（`StateStore.ts:24781–24788, 25133–25161`）。同一秒内 resolve→新 event 重开，可以得到完全相同的 tuple；旧等价信的送达记录于是授权结算新待办。隔离 SQL 反例已执行：eventId 从 e1 变为 e3，opened_at 仍相同。

**修正：** 明确区分“本次 fire 的 eventId”和“所属工单的 canonical episode ID”。在现有入队/账本接线上保留能证明该关联的 canonical generation，消费端和回执钩子读取同一份关联；不要用来信 eventId 假定它就是 canonical 行，也不要仅按当前 correlation key 猜旧信所属代次。代次直接包含账本已有的 canonical `event_id`（B 类亦可用其唯一 root 身份），无需再发明时钟序列。缺少可靠关联仍照投。

补两个沿真实 `upsert → enqueue → receipt → revalidate` 路径的用例：不同 fire eventId、同一未解决工单的等价第二封必须能合并；同一秒内新工单原文复发必须叫醒。验收回放不能把生产接口返回的“未知代次”替换成“已知同代”后算作已验证节省；这部分可以单列估算，不设节省比例门槛。B 类也应保留真实新 episode/未知映射结果，不能直接把同 correlation key 的不同 root 算成同代。

### 2. [P2] 新对象/数量升级会漏掉注记，已显示的计数又尚未包含当前信

**问题：** plan §4（119–133 行）只在本类别有过合并，或 reason 为 `severity_up/new_ticket_generation` 时加注记；叫醒信的 `occurrences` 要到回执后才增加。

**为什么：** 同类别先送达标题含 12 的告警，再收到 13（或同执行的新 requestId）：新 fingerprint 的 reason 是 `no_delivered_equivalent`，此前 `suppressed=0`，所以完全没有累计次数。这直接不满足“升级叫醒时携带窗口内累计次数”，也与 §8.2 的测试要求相冲突。即使走 severity_up，渲染时 `sumAlertWakeCategory` 仍只有之前的记录，按现有规则会少算当前这一封。`markAuditDelivered` 还可因队列落账前崩溃而在冻结重投时再次执行（`lead-inbox-loop.ts:524–535`），不能把每次回调都当成一封新告警累加。

**修正：** 将“本类别已有告警、这次因不同内容/对象/数量再叫醒”纳入注记条件；明确定义展示计数包含当前信及本批次前面的告警，并按 delivery identity 防止重投重复累加。计数是展示状态，安全送达证据仍仅在回执后建立。至少补 `suppressed=0` 时 12→13、新 requestId 的注记断言，以及同一 delivery 重放不增加出现次数的用例。

## Non-blocking advisories

- §5.1 的行数上界说明应改正：原始 UUID/requestId 进入 fingerprint 后，只覆盖再次出现的同指纹；从不删除的一次性指纹会终身累积，不能声称受六小时约束。本轮不要求新清理任务，但应写明真实增长方式；需要清理时复用已有维护入口。
- `recordDelivered` 的“所有 fence 丢失都无记录”描述应限于回执钩子之前。回执及 owner 检查已经成功、钩子已写入后，后续 queue 落账仍可能失败；保留已取得的真实投递证据没有问题，不要因此引入跨库事务。
- 当前 strict JSON 只有按类别统计；逐封合并信与等价 delivery_id 的对应表仍是 §8 的实施验收任务。保留该任务和回放近似说明即可，不要求把设计脚本扩张成另一套生产判定器。

## Verdict

CHANGES REQUESTED

修正工单关联/代次和升级计数后再实施；无需重开已接受的消费端架构或扩大 plain 覆盖。
