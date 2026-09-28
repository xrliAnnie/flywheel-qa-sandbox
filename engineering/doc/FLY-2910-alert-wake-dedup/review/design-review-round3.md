# Design Review — plan.md (Round 3)
Date: 2026-09-25
Author: Codex (gpt-6-astra)
Status: CHANGES REQUESTED

## Summary

R2 的 canonical 工单关联、同秒复发识别，以及注记条件和包含当前信的计数口径已修正。仍有两项相邻合同未闭合：严重级别证据跨工单代次混用，会漏掉升级叫醒；`last_recorded_delivery_id` 不能保证多封信的冻结批次重投幂等。

本轮完整重读 plan，仅核验 R2 修正及相邻的入队、回执、冻结重投合同。Reviewed head：`d0d402459cc930e4a212ccf5c7cf975155b34a7b`；plan SHA-256：`c113d5cb8603a34e80526bb6d5a2e5fdf2f66d5e27d95198312e7def5abdad8c`。不重开已接受的架构、指纹规则或 plain 覆盖边界。

只读重跑两种 replay 模式，均与保存的结果一致：154 封信，已验证模式 152→134，假设同代模式 152→102；工程 Lead 均为 14→14。另用 §4 规则的最小 Python 模型执行下述两个反例，断言通过、退出 0。这是设计合同验证，不是生产实现测试；未运行 TypeScript 套件，未修改源码或生产数据库。

## What's Good (Keep)

- A 类在 upsert 返回处保留 canonical event_id，判定与回执读取同一份 delivery 映射，解决正常重复 fire 查不到 canonical 行的问题；缺失映射照投。B 类沿用 root 查询，未知照投。
- 用 canonical event_id 区分代次，去掉秒级 opened_at；保留真实入队路径正例和同秒复发测试。
- 注记条件改为类别累计 ≥2，并计入当前信和本批次先前叫醒信，覆盖 12→13、新 requestId 且 suppressed=0 的情况。
- 回放明确分开实际接口结果与假设同代估算，不设节省比例门槛；保留实施阶段逐封送达对应表。回执前后的 fence 边界也已写清。

## Issues & Recommendations

### 1. [P1] 更新工单代次时沿用旧代最高严重级别，会吞掉新代升级

**问题：** plan §4（128–136 行）将 `ticket_generation` 更新为本行代次，却继续对 `max_severity` 跨代取最大值。此时记录里的代次和严重级别不再来自同一代已送达告警。

**为什么：** 同一 Lead、同一 fingerprint、六小时内依次发生：G1 的 severe 已送达；G1 解决后，G2 的 warning 因代次变化叫醒并送达；随后 G2 升为 severe。第二次回执后状态是 `(ticket_generation=G2, max_severity=severe)`，所以第三封被 suppress，虽然 G2 实际只送达过 warning。这违反“级别升高仍叫醒”，也没有同代 severe 的送达证据。此输入符合现有格式：A 类 severity 单独放在被指纹排除的 context 行中（`infra-alert-mailbox.ts:5–15`），不要求标题或正文改变。按当前计划执行的最小模型已得到第三封 `suppress`。

**修正：** 更换代次时同时重建该代的严重级别证据，例如将 `max_severity` 设为本行级别；只有同代送达才取最大值。既定固定窗口和展示计数可继续保留。补一个 `G1 severe 已送达 → resolve → G2 warning 已送达 → G2 severe` 用例，最后一封必须叫醒。

### 2. [P2] last_recorded_delivery_id 只防连续重复，不能保证冻结批次幂等

**问题：** plan §4（134 行）和 §8.2c（282 行）只覆盖 `A → A`，实际回调可以是 `A → B → A → B`，其中 A、B 属于同一 fingerprint。

**为什么：** 新批次先逐封完成 revalidate，再统一交给 adapter（`lead-inbox-loop.ts:348–403`），因此没有旧送达证据时，同指纹的 A、B 都会叫醒。回执后逐封执行 `markAuditDelivered`，全部完成后才落 queue 账（`:524–535`）。若此间崩溃，冻结批次保留原成员重投（`mailbox-queue.ts:1465–1523`），再次执行 A、B 的钩子。首次执行后 last=B、occurrences=2；重放 A 不等于 B，重放 B 又不等于 A，最终 occurrences=4。已有批次默认上限为 10（`bridge/mailbox-queue-config.ts:15–16`），不能假定每批只有一封。该计数反例已执行复现。

**修正：** 用能识别已经记账的每个 delivery 的持久化标记实现幂等，并让标记与计数更新处于同一个 StateStore 事务；不能只保存最后一个 delivery ID。将 §8.2c 扩展为同指纹 `[A, B]` 批次在钩子执行后、queue 落账前崩溃并完整重投，最终出现次数仍为 2。无需改变冻结批次成员或 adapter 协议。

## Non-blocking advisories

无新增非阻塞建议。

## Verdict

CHANGES REQUESTED

修正跨代严重级别证据和多封信重投幂等后即可进入实施；其余本轮修正保留。
