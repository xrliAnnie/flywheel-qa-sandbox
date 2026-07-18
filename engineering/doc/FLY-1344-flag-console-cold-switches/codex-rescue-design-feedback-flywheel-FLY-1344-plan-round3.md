# Design Review — plan.md (Round 3)

Date: 2026-07-17
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 2 的四项主体修订已经成立：start-scoped latch、常驻 capability、失败即停命令、异常初态 repair、claims-read 双模登记口径和 file-unavailable 全函数都具备可实施形态。当前仍有 3 个阻塞性准确性问题和 1 个文案/测试残留：其中两个来自相邻源码合同（generalized launch commit path、ship-reader fail-closed 第三态），另一个是 S3 同节内互相矛盾的 readSite 指令；修正后即可进入实现。

## What's Good (Keep)

- `WorkflowShadowRuntime.beginStartScope()` 现在有明确线性化语义：scope 内不再读全局 flag，delayed failure callback 复用同一 scope；capability/closure 始终在 Bridge assembly 构造，OFF 只表示不调用。Round 2 的 S2 撕裂与反 boot-gate 问题主体已关闭。
- re-QA 的常驻能力与 stage/apply 双 USE-time recheck 保持完整，没有被 start scope 设计混入错误生命周期。
- 第一阶段改成单条 `&&` 链、phase 2 独立确认、异常初态 template-off repair-first、逐位置 failure injection，已经覆盖普通 shell 在中条失败后继续执行的风险；Round 2 命令安全 finding 已关闭。
- `claims_read` 已补 Bridge call-time 模式，proof 改为“每个实际 consumer”，exact sentinel 与 PR proof table 共用一套枚举，方向正确。
- `{status, raw}` 把 readable key-absent 与 file-unavailable 分开，`displayEffective` 成为全函数且 unavailable 时禁用方向控制；Round 2 的双源状态 finding 主体已关闭。
- 双 console、direct shared policy、权限重分类、提交依赖门与真治理门 sentinel 均未发现新的阻塞问题。

## Issues & Recommendations

1. **[阻塞] `beginStartScope() === undefined` 只能关闭 shadow-added 的 normal fresh-launch 路径，不能抹掉 `generalizedExecution` 自己的 commit path；plan:72/79 目前写成了无条件“无 launchCommitPath”。** 当前 `RunDispatcher.start` 明确让 generalized execution 即使没有 workflow shadow seam 也获得 commit path：`shadowContext` 对 `req.generalizedExecution` 为 undefined，但 `shadowCommitDir` 使用 `req.generalizedExecution || this.workflowShadow`（`packages/teamlead/src/bridge/run-dispatcher.ts:1152-1158,1196-1205`）。这是 generalized engine launch 的既有 commit-gate 合同；`WorkflowEngineDispatcher` 传入 launch token/commit callback 后调用 start（`workflow-engine-dispatcher.ts:448-492`），而 flag 可能在上游 predicate 与实际 start 之间的 async 工作中翻转。若按 plan:72 的“scope OFF → launchCommitPath 全部不发生”实现，会把 claims-write shadow 开关错误地覆盖到独立的 generalized launch durability 路径，违反 §4“不改 dispatch/claims 语义”和 reverse compatibility。

   建议把公式写死为：`shadowContext = startScope && !req.generalizedExecution ? ... : undefined`；`shadowCommitDir = req.generalizedExecution ? launchCommitPath(executionId) : startScope ? launchCommitPath(executionId) : undefined`。OFF sentinel 限定为 **non-generalized normal fresh start**；另加 `generalizedExecution + beginStartScope() undefined` 仍保留 launchCommitPath/commit gate 的 sentinel。不要用 claims-write scope 决定 generalizedExecution 自身的 launch credential/commit lifecycle。

2. **[阻塞] S3 仍保留一条与紧接着的新规则正面冲突的旧 readSite 指令。** plan:86 仍写 `workflow_force_legacy = ship-eligibility dotenv_live + merge-ship-gate call_time`，但 plan:88 又正确规定 force_legacy 的两种 read mode 都必须登记在真正解析 key 的 `ship-eligibility.ts`，并明确 `merge-ship-gate.ts` 不能冒充 key reader。实现者无法同时遵守两条，且前一条正是 Round 2 要删除的错误口径。请把 plan:86 改成 `ship-eligibility.ts` 内 Bridge argsEnv-wins call_time + CLI/no-key dotenv_live 两行；`merge-ship-gate.ts` 只留在 caller note/proof table。exact-readSite sentinel 应逐字断言它不在 registry readSites，避免旧行再次回流。

3. **[阻塞] `shipReader` 仍缺少 force OFF + claims_read OFF 的 fail-closed/no-reader 状态。** plan:15/105 只给 `claims | forced-legacy`，但真实 durable-QA 逻辑是：force ON → legacy；force OFF 且 claims_read ON → claims；force OFF 且 claims_read OFF → 直接返回 `qa_claim_gate_unenrolled_failclosed`，根本没有 reader（`packages/flywheel-comm/src/ship-eligibility.ts:313-327`；现有测试 `ship-eligibility.test.ts:243-257` 已锁定）。把这一组合压成 generic `off` 或二选一会再次向 founder 误报系统正在读哪套权威数据。

   建议把该事实定义为 `shipReader: "forced_legacy" | "claims" | "blocked_fail_closed" | "degraded"`，其中 `!force_legacy && !claims_read` 明确显示“无可用 reader / enrolled QA 禁止 ship”。补 2² 真值表 + 每杆 divergence/source_unavailable 注入；phase-2 `force_legacy off` 的可执行条件也直接断言目标状态必须是 `claims`，而非只看四杆视觉上“就绪”。

4. **[重要] S4 仍按旧的三类 divergence 写渲染与快照，未把新增 `source_unavailable` 作为第四个 UI 分支列全。** S0 已把 union 扩成四类并定义 unavailable 语义（plan:51-58），但 S4 只列 staged_restart/split_brain/bridge_stale 三条文案，测试仍写“三类分歧 × 有/无文件”（plan:94-98）。请增加明确的 source-unavailable 文案（例如“.env 不可读，无法确认或操作；Bridge 值仅供观测”），并把两套 renderer snapshot/DTO secret-free 测试改为四类 exhaustive assertion；否则类型虽新增，显示层仍可能落入空白/default 分支。

## Verdict

CHANGES REQUESTED — address items above
