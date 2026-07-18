# Design Review — plan.md (Round 4)

Date: 2026-07-17
Author: Codex
Status: APPROVED

## Summary

Round 3 的 3 个阻塞项和 1 个重要项均已按真实运行时合同完整关闭，修订后的 S2、S3、S4、S5 彼此一致且可由当前架构实现。未发现新的阻塞性设计缺口；计划现已具备进入 TDD 实现阶段所需的边界、顺序门和回归证明。

## What's Good (Keep)

- S2 把 generalized execution 的 launch commit path 明确列为独立 durability contract，并写死 `shadowContext` / `shadowCommitDir` 两条选择公式；这与 `run-dispatcher.ts:1152-1158,1196-1205` 及 `workflow-engine-dispatcher.ts:448-492` 的现行语义一致。OFF sentinel 已限定到 non-generalized normal fresh start，同时新增 generalized + scope-OFF 保全测试，关闭了 claims-write 开关误伤 generalized commit gate 的风险。
- `beginStartScope()` 的线性化、scope 内禁止重读全局 flag、能力常驻构造以及 delayed failure path 复用同一 scope 仍保持完整；re-QA 的 stage/apply 双 USE-time fail-closed 合同也未被本轮改动削弱。
- S3 已消除互相冲突的 readSite 指令：`workflow_force_legacy` 的 call-time 与 dotenv-live 两种模式都登记在真正解析 key 的 `ship-eligibility.ts`；`merge-ship-gate.ts` 仅作为 caller 证据，并有 exact sentinel 防止被误登记回去。这符合当前 resolver 的 argsEnv-present 优先、否则现读 `.env` 的实际路径。
- `shipReader` 现为 `forced_legacy | claims | blocked_fail_closed | degraded` 四态，准确覆盖 `ship-eligibility.ts:313-327` 的 durable-QA fail-closed 分支；phase 2 仅在刷新后的目标状态为 `claims` 时放行，避免 force OFF 后落入无 reader 状态。
- S4 已为 `source_unavailable` 增加明确、不可操作的 UI 文案，并要求两套 renderer 做四类 exhaustive assertion 与 DTO secret-free 检查，不再存在 default/空白分支。
- 双 console 投影、状态感知 `&&` 命令链、异常初态 repair-first、direct 权限边界、逐 consumer proof table 和单 PR 依赖门仍互相对齐；硬重启窗前合并的实施顺序是可执行的。

## Issues & Recommendations

1. 无阻塞问题。实现时应把计划中列出的公式、四态 truth table、exact readSite sentinel 和两套 renderer exhaustive tests 视为合并硬门；若实现为了类型或依赖关系改变 seam 形状，应保持这些外部行为合同不变。

## Verdict

APPROVED — ready to implement
