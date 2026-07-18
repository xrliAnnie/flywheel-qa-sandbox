# Design Review — plan.md (Round 2)

Date: 2026-07-17
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 1 的 7 条意见都已按正确方向进入计划，尤其是双 console 投影、三事实 DAG 模型、re-QA USE-time gate、双源字段合同和 direct 暴露顺序，主体架构已经接近可实施。当前仍有 3 个阻塞性合同矛盾和 1 个状态模型缺口：若不先写清，S2 仍可能在热翻转边界撕裂，命令组仍可能在单条失败后进入缺杆状态，readSites/proof 也还不能如实覆盖 Bridge 的 claims-read 路径。

## What's Good (Keep)

- R1#1 对“presence 本身是行为”的定性已经写回计划；真实 `setupRunInfrastructure` + `RunDispatcher` 的 OFF→ON→OFF 与原 sentinel 复跑是正确的验收层级。
- R1#2 的第二个 boot capture 已被纳入：re-QA 基础能力常驻、stage/apply 双 USE-time recheck、OFF 零 token/零 respawn、stage 后翻 OFF fail-closed，方向正确。
- R1#3 的核心语义已经修正：force_legacy 不再被描述为压制 dispatch，v1/v2 readiness 分开，template_dispatch 被放到 enable prerequisites 之后。
- R1#4/#5 的主要闭环成立：三值合同、分歧禁用方向性控制、共享 DAG view model、`ConsoleSnapshot`/`ManagementSnapshotV1` 双投影、localhost 与 phone 两条真实验收路径均已具名。
- R1#7 已关闭：单 PR 内的依赖门明确要求先完成 S0/S2 proofs，再开放 feature/direct；readSites proof table 也不再由全套测试绿灯代替。
- 四根杆重分类为 mechanism feature 的授权边界没有发现新的 category load-bearing 风险；真治理门 readonly sentinel 继续保留即可。

## Issues & Recommendations

1. **[阻塞] S2 同时要求“start 锁存值统一驱动”与“每个 hook 按当前 env 二次短路”，两者在真实 async 边界上会互相破坏；admission 的装配时机也仍写反。** `setupRunInfrastructure` 只在 Bridge 装配时调用一次并返回一个长期存活的 `RunDispatcher`（`packages/teamlead/src/bridge/plugin.ts:4902-5003`；`run-infra.ts:602-608,994-1038`），所以 plan:71 的“OFF 时不构造 admission”若按现架构实现，Bridge 以 OFF 启动后热翻 ON 仍拿不到 admission，等价于重新引入 boot gate。这里必须是“能力/closure 常驻构造，latched OFF 时不调用”，或者明确把接口改成由 `RunDispatcher.start` 在锁存后调用的 admission factory。

   同时，`start()` 在 shadow seam 前会 `await admitLifecycle`（`run-dispatcher.ts:1060-1113`），而 `onDispatchFailed` 在 Blueprint promise 的异步完成路径才调用（`:1385-1443`）。如果入口锁存 ON、等待期间或 runner 执行期间 flag 翻 OFF，plan:71 要求 onSpawn/admission/commit path/failure hook 继续按 ON scope 保持一致，但 plan:73 的当前值 fail-safe 会让 onSpawn 或 delayed failure hook no-op，留下“有 admission/commit path、无对应 shadow transition”的撕裂。建议把合同改成 `runtime.beginStartScope()`：在明确的线性化点返回 `undefined` 或一个 **绑定该锁存值** 的 start-scoped seam，`RunDispatcher` 捕获并在 onSpawn/admission/launchCommitPath/delayed failure callback 全程复用；该 scope 内不再读取全局 flag。orchestrator/finalization 等非 start-scoped hook 才按各自 USE-time current value 检查。新增 ON-at-entry→await 中 OFF、OFF-at-entry→await 中 ON、ON start→Blueprint 失败前 OFF，以及 Bridge boot OFF→热 ON 的 shared-branch QA admission 测试。

2. **[阻塞] “安全序列”的证明只覆盖成功命令的前缀，没有覆盖中间命令失败后 shell 继续执行，也没有定义异常初态。** 当前 phone copy surface 把命令以普通换行拼接（`packages/teamlead/src/bridge/feature-flag-report-html.ts:93-100,134`）；单条 `flywheel-comm feature-flags apply` 失败只返回非零（`packages/flywheel-comm/src/commands/feature-flags.ts:114-144`），粘贴到普通 shell 后下一行仍会继续。于是 `claims_write on` 若失败，后续 claims_read/generalized/template_dispatch 仍可能成功，正好制造 template ON + prerequisite 缺失的 fail-closed 状态；关闭序列中 template off 失败而后续 prerequisites 被关也有同类问题。建议第一阶段命令必须具备可验证的 stop-on-first-failure 合同（例如生成 `cmd1 && cmd2 && ...`，或一个带 `set -e` 的明确脚本块）；`force_legacy off` 继续保持刷新确认后的独立第二阶段。测试应对每个位置注入 apply 失败，证明后续命令未执行，而不只枚举“人为中断的成功前缀”。

   另外，plan:108 的前缀不变量只在初态 `template_dispatch=off`（或所有 prerequisites 已齐）时成立。如果面板已处于 template ON + 缺杆的 partial 状态，现“开”序列先 force on、再补杆，但 force 不进 dispatch predicate，直到补齐前仍持续 fail-closed。请明确 preset 前置条件：要么在该异常初态禁用“开”并先给出 repair/stop 阶段，要么安全序列先把 template_dispatch 拉 OFF、刷新确认后再进入 enable phase；测试矩阵要覆盖所有允许点击 preset 的初态。

3. **[阻塞] S3 仍漏掉 `claims_read` 在 Bridge ship path 的条件性 call-time reader，且 direct proof 的措辞要求了不存在的 CLI consumer。** plan:85 只登记 `workflow-claims` call_time + `ship-eligibility` dotenv_live + `verify-approval` dotenv_live；但 Bridge `computeShipDecision` 总是把 `process.env` 传给 `evaluateShipEligibility`（`packages/teamlead/src/bridge/merge-ship-gate.ts:48-68`），后者把同一 `args.env` 传入 `evaluateQaShipGate`/`resolveWorkflowClaimsReadEnabled`（`ship-eligibility.ts:105-114,315-320,405-443`）。`resolveDefaultOffGate` 在该 env **含 key** 时走 process-env call_time，只有无显式 key 时才走 dotenv file（`:83-101`）。因此 claims_read 与 force_legacy 一样，ship-eligibility 必须登记/证明 Bridge call_time + dotenv_live 两种生产模式；否则“逐 consumer 无 stale reader”结论不成立。

   建议把 registry 的真实 readSite 放在实际解析 key 的 `ship-eligibility.ts`，用不同 symbol/模式描述 Bridge caller 与 CLI caller；`merge-ship-gate.ts` 可在 note/proof table 中作为 caller，但它只传 env、文件内没有这些 envVar literal，不应冒充实际 key reader。plan:87 的“每 direct 杆 Bridge 与 CLI 都观察”也应改为“每个实际登记 consumer 都观察”：template_dispatch/generalized/claims_write 没有对应 CLI consumer，只有 mixed-source 的 claims_read/force_legacy 需要同一次 apply 后同时证明 Bridge 与 CLI。exact readSite sentinel 与 PR proof table 使用同一枚举，避免两套口径再次漂移。

4. **[重要] S0 的 `displayEffective` 选择规则对“文件不可读”仍不是全函数，并需区分“key 缺席”与“文件缺席”。** plan:53 允许 `fileEffective` 因文件不可读而缺席，但 plan:54 只定义“双源一致”与“双源分歧”两支；没有规定单源不可用时 badge、DAG aggregate 和 controls 的状态。共享 parser 返回 `undefined` 还同时可能表示“可读文件里没有该 key”，后者对 opt-in/default-on 应计算各自默认 effective，不能被误判为 file unavailable。建议 resolver 输入/结果显式携带 file-read status（例如 `readable | unavailable`），可读且 key absent 时照 polarity 算出确定的 `fileEffective`；不可读时进入 `source_unavailable/degraded`，Bridge 值仅作带注释的观测，所有方向性 preset/control 禁用。把这一分支加入 S0 五组 consumer 测试和 S4 的“有/无文件”快照预期。

## Verdict

CHANGES REQUESTED — address items above
