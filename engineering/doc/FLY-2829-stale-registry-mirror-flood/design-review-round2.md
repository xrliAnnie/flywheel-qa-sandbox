# Design Review — plan.md (Round 2)

Date: 2026-09-24
Author: Codex
Status: CHANGES REQUESTED

## Summary

v2 对 Round 1 的八项反馈都作了实质性响应：mutation-time live 复核、预创建 reservation、三个创建 chokepoint、公平配额、双端 summary cap、完整旧树阴性对照和 fail-closed watchdog 的方向都正确。但仍有四类会使安全或验收合同失真的阻塞问题：C4 指定的 node 回执恢复者实际不存在，C6 的“每轮/绝对上限”并非所述语义，C8 默认阴性对照会把真实复现判成失败，C9 的样本数公式量纲错误；当前版本尚不宜进入实现。

## What's Good (Keep)

- C1–C3 与 C5 保持了 Round 1 已认可的简单主修复：非法 title 在任何 cmux 调用前被拒、非 live 循环零创建、live admitted 行才补铸 authority title、每行都重新检查维护 latch。
- C4 新增的 fresh Bridge live 查询同时覆盖 direct delete 与 guarded close，读取失败 preserve，并用 200 行批次限制破坏面；这正确关闭了“旧内存名册”竞态（`engineering/doc/FLY-2829-stale-registry-mirror-flood/plan.md:101-126`）。
- C6 把 reservation 放到 `new-workspace` 之前，只有 guard 明确证明 cmux 未调用时才取消；post-read、diff、receipt 写入失败和进程崩溃都会保留额度。这是正确的 fail-closed 方向（`engineering/doc/FLY-2829-stale-registry-mirror-flood/plan.md:171-174`）。
- 三个真实创建入口都已纳入设计，进程初态未初始化即拒绝；node/view 配额也首次有了明确公平目标，而不是依赖当前遍历顺序。
- summary cap 在轮首与轮末都执行，解决了本轮新转 summary 可瞬时超过 30 的遗漏（`engineering/doc/FLY-2829-stale-registry-mirror-flood/plan.md:97-100`）。
- C8 已改为物化完整旧 `scripts/` 树，并为正式、smoke、阴性模式定义 watcher 存活、退出码与样本数前提；C9 也把持续失明和 marker 写失败改成非 PASS。这些验收原则应保留。

## Issues & Recommendations

1. **[BLOCKER] C4 的关键 crash recovery 与 prepared-stall 恢复者在现有代码中并不存在。** 计划称 close 成功但 `_node_ledger_remove` 前崩溃后，现有 `reconcile_node_ledger` 会因 ref 缺失清理 committed 回执（`plan.md:112-118`）；实际函数只清理“旧 generation 且 ref 缺失”的行，当前 generation 的 committed 行在 `[[ "$state" == prepared ]] || continue` 处直接跳过（`scripts/flywheel-cmux-sync.sh:2040-2065`）。同样，`node-absent`/`node-drift` 目前只出现在 prepared-stall kind 的校验 allowlist（`scripts/flywheel-cmux-sync.sh:8905-8930`, `scripts/flywheel-cmux-sync.sh:9023-9052`），没有任何 observe/GC producer；现有 orphan sweep 读取的是 `VIEW_LEDGER`，且只处理 view 的 `absent|drift|authority|migration`（`scripts/flywheel-cmux-sync.sh:8969-9007`）。因此 v2 的“任何 node ledger 行都阻止直删”会让 current committed-absent 和 current prepared-absent 行永久 deferred。请在本单明确实现 node ledger 的 absent/drift 收敛（或另一套等价、幂等的恢复事务），并把 crash seam 放在成功 close 与 `_node_ledger_remove` 之间；当前 `after-close` seam 位于整个 `close_node_workspace` 返回之后，无法覆盖表中的 a' 窗口。测试至少要覆盖 current committed absent、current prepared absent/drift、旧 generation ref absent，以及真正的 close→ledger-remove kill/restart。

2. **[BLOCKER] C6 的预算会按 15 秒 pass 重置，且 workspace ceiling 只在 pass 开头取快照，所以“每轮 20”和“上限是真上限”都尚未成立。** `workspace_create_gate_begin` 每个 `WATCHER_PASS_SEQ` 重新赋满预算（`plan.md:163-170`），而 watcher 每 15 秒调用 `watcher_begin_pass`，resync tick 甚至会先为 bootstrap 开一遍 pass、随后同一 tick 再开一遍普通 pass（`scripts/flywheel-cmux-sync.sh:13037-13115`）。因此同一个 additive round 可先花 20、立即在下一 pass 再花 20；pass/restart 也不从 durable ledger 计算本轮已用额度。另一方面，`CEILING - workspace_count` 只基于 pass 开头的 JSON，若 founder 或其他 cmux 客户端在后续 mutation 前新增 workspace，脚本仍可越过 ceiling。建议把“每 pass 重验 gate”与“预算 epoch”分开：reservation/created 行按实际 `CMUX_ADDITIVE_ROUND_ID`（或明确定义的 durable 时间桶）计算已用预算，event drain 与同一 additive round 共用余额；并在每次 reservation 后、cmux mutation 的 guard 边界重新读取 workspace count，达到 ceiling 就安全取消 reservation。增加“bootstrap 后同 tick event drain 总计仍 ≤20”“同一预算 epoch 重启不重置”“149→mutation 前外部变 150 时零创建”的测试。若产品真正接受的是 per-pass 而非 per-round 限额，则必须重命名旋钮并把 60/45 秒的实际 burst envelope 写进风险与验收，不能继续称其为每轮 20。

3. **[HIGH] C6 的状态格式、公平算式和源码守卫仍自相矛盾，实施者无法得到唯一合同。** 常量表仍把 create ledger 定义成 5 列（`plan.md:150-159`），而机制与 §4 定义成 6 列含 `status`（`plan.md:171-174`, `plan.md:235-240`）。`NODE_RESERVE=max(2, CREATE_BUDGET_LEFT/4)` 在计划自己的 59/149 边界（总预算 1）会得到 reserve=2 和负的 view 容量；应写成 `min(CREATE_BUDGET_LEFT, max(2, ...))`，view 容量再夹到 ≥0。源码守卫也不能按 `grep -c 'new-workspace'` 实现：当前文件已有 5 个文本命中（3 个调用、1 个注释、1 条日志；`scripts/flywheel-cmux-sync.sh:2109`, `:3478`, `:5387`, `:10407`, `:10409`），所以 `plan.md:190` 的测试在改代码前就失败。请统一为一个 6 列 schema，夹取配额，并让静态测试匹配真实 mutation command（或把三个调用集中到唯一的 reserved-create wrapper），不要计数任意字符串。

4. **[HIGH] “`: >` 截断 create ledger 后立即恢复”的操作员步骤会与仍在运行的 watcher 的 mktemp+mv 事务竞争。** latch 只阻止创建，不会让 watcher 停止读、裁剪或原子替换 ledger；外部原地 truncate 可能被下一次 `mv` 覆盖，也可能抹掉刚落盘的 reservation，从而重新打开事故窗口（`plan.md:165-176`）。请把恢复 runbook 定成有序事务：先写 maintenance marker，确认 watcher 已 yield mutator lease，再用 owner-only 临时文件 + rename 清理 ledger，最后按顺序清 latch/marker；告警文案只引用这条安全流程。补一个“ledger 清理与 gate pass 交错不会丢 reservation”的测试，或明确禁止在 watcher 活跃时清理。

5. **[BLOCKER] C8 的阴性对照在默认 fixture 下会把真实事故复现判成 FAIL。** 计划默认提供 3 个 running、无窗的 live exec（`plan.md:207-210`），却要求所有新增 workspace 的最终 title 都匹配 `^Terminal [0-9]+$`（`plan.md:213-218`）。旧脚本会为这些 live exec 分配 `node:*` authority title（`scripts/flywheel-cmux-sync.sh:2230-2239`），两轮无窗后调用 `ensure_node_workspace`（`scripts/flywheel-cmux-sync.sh:2249-2265`），并最终把新 workspace rename/commit 为 `node:*`（`scripts/flywheel-cmux-sync.sh:2013-2037`）；这些是合法新增，与此同时陈旧 `-` 行仍会产生大量 `Terminal N`。建议阴性模式要么强制 empty live fixture，要么按起始 ref 做 delta 分类：要求 5 分钟内至少 20 个新增、无 node receipt 的 `Terminal N`，同时允许最多 `live fixture count` 个合法 `node:*`。后者更接近生产输入，也不会把真正抓到病的 harness 判无效。

6. **[BLOCKER] C9 的最小样本数公式把分钟直接除以秒，重新打开了 R1-8 的 vacuous PASS。** `samples ≥ minutes / interval − 2`（`plan.md:224-230`）在默认 `--minutes 40 --interval 60` 下按 shell 整数运算得到 `40/60-2 = -2`，所以只有 3 个有效样本也能满足 coverage 条件。应定义 `expected = floor(minutes * 60 / interval) + 1`（是否含 t=0 样本需写死），再要求 `valid >= expected - 2`；新增测试必须证明 40 分钟/60 秒只有 3 个有效样本时为 `INVALID reason=coverage`，而足量样本、无 blindness/trigger 时才能 PASS。

## Verdict

CHANGES REQUESTED — address items above
