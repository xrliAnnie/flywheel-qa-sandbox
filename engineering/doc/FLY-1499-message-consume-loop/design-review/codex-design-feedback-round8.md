# Design Review — FLY-1499 plan.md (Round 8)

Date: 2026-07-27
Author: Codex
Status: APPROVED

## Summary

Round 8 已完整关闭 Round 7 的三个生命周期问题：durable current registry 现在能裁决合法 successor 接管，Lead/runner 启动恢复已拆成可执行的两条路径，foreign running attempt 也会在任何 driver-map 副作用前 fail-closed。结合对 `84d62a3f` 全文、R7→R8 精确差异及当前 v2-kernel schema/事务合同的复核，本计划已具备实现所需的安全边界、测试闭环与跨批次责任划分。

## What's Good (Keep)

- §4.1 的 coordinator-map 仲裁不再把“不同 identity”一概视为 stale：incoming 必须先等于 durable current registry；map 中若是旧 identity，则 stop 旧 coordinator、清空其 timers 并由 current identity 接管。T1 同时覆盖 successor 正向接管、迟到旧 attach 反向拒绝、同 identity 幂等和并发 attach 收敛，并要求 stop/timer/map/pull 的变异验证。
- 同 agent 的 attach/map mutation 已要求 driver 内串行化，直接覆盖 Round 7 指出的“旧 attach 校验后暂停、new attach 安装、旧 attach 回来覆盖”竞态；这与每次外部 `shim.deliver` 前再次执行 durable authority gate 形成互补，而不是依赖内存 map 充当 authority。
- 启动恢复合同已按真实 API 分叉：runner 通过 `attachRunner` 重挂且不写 registry；Lead 进程死亡后凭 `DeathEvidence` 走 `registerLead`，生成 gen+1 的新 cutover，并明确由 `T_switch` 支付。§4.1、§9-7、T1 与 E35 表述一致，旧的“registerLead 重挂但不 cutover”矛盾已清除。
- `attachRunner` 的前置事务现在除 subject、current registry、activation active/generation 外，还检查该 agent 的所有 running attempts 的 owner 三元组；foreign row 会在 coordinator map、timer、pull 或 shim 调用之前 fail-loud。该谓词可由现有 `processing_attempts(instance_id,generation,activation_id,outcome)` 与 `mailbox(to_agent,message_uid)` 直接实现。
- 真实 schema 支撑新增合同：`activations` 具有 `session_ref`、`generation`、`state`；`processing_attempts` 具有完整 owner 三元组并由 `pa_one_running` 约束每消息至多一个 running attempt；registry identity 的 `identitiesEqual` 已逐字段比较 runner 的 activationId。
- 事务分层仍符合当前 Kernel：数据库 authority 校验走同步 `Kernel.write`/`WriteTx`，没有在 callback 内启动 async、嵌套 write 或执行外部 shim；map、ring、timer 均留在最外层 commit 返回之后。默认 1000ms 预算仍有 T4 的明确验收。
- R1–R6 已闭合的 AttemptHandle 绑定、统一 active-consumer gate、marker/timeout 线性化、disposal authority、INDEXED BY 统计矩阵、公平性算法与 v11 SLA 公式均未因本轮修改回退。
- 评审对象已精确冻结：当前 worktree 的 `plan.md` blob 与 `84d62a3f` 相同；其后的 HEAD 仅修改 `progress.md`。`84d62a3f` 的 plan diff 仅含本轮 3 项修复及版本/测试/决策记录同步，`git diff --check` 通过。

## Issues & Recommendations

1. 未发现需要修改计划的阻塞或非阻塞设计问题。实现时应把 §4.1 所称的 per-agent 串行化覆盖整个 attach 仲裁区间——数据库校验、停止旧 coordinator、清 timer、替换 map、必拉与 timer 安装——并在 `attachRunner` 入口显式收窄或拒绝非 runner identity；这两点是对现有合同的实现注意事项，不要求新增机制或扩大本批范围。

## Verdict

APPROVED — ready to implement
