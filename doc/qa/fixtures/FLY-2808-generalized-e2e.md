# FLY-2808 generalized e2e fixture

- attempt 1: run=8e551190-44be-4073-bedf-728d3e7ab934 execution=76214bfa-989a-4547-8653-f97b8bc42ced
- attempt 2: run=8e551190-44be-4073-bedf-728d3e7ab934 execution=76214bfa-989a-4547-8653-f97b8bc42ced（同一实现体经原会话拉起）

## implement@1 核对记录（529 混合房，真 Claude 载体实现节点）

Issue: FLY-2808 (https://linear.app/geoforge3d/issue/FLY-2808)
日期: 2026-09-24
基于: doc/FLY-2808-generalized-e2e/design.html

issue 末段「▶ qa@1 返工要求（头 29d3afe85，claim 1508）」A–E 是给真仓 PR #1299 实现体的指令，
已由真实现体完成；本节点在 QA 沙箱内，不改真仓、不推真仓提交，只读核对后在此留痕。

| 核对项 | 期望 | 观测 | 结论 |
|---|---|---|---|
| 真仓 PR `xrliAnnie/flywheel#1299` 远端头 | 已越过 29d3afe85（claim 1508 返工已落） | `e16cebcf736f76a5f9a45f58bb8b760bdb6f1ffd`（OPEN，非 draft，head `flywheel-FLY-2808`） | 通过 |
| claim 1508 返工提交 | A/B/D/E 各有提交 | `07588f5a0`（A：Claude SessionStart 身份改 POST）、`8cd3b1242`（B：用冻结的 Lead/node 拉起 standby 体）、`077da2e65`（D：退役窗口销毁 runner session 后继任可活）、`2137d4132`（E：拉起中保持 parked 并记失败真因）、`e9bd824bd`/`e16cebcf7`（处置记录 + milestone） | 通过 |
| 精确头检查汇总 | 无失败 | statusCheckRollup：20 SUCCESS、8 SKIPPED、0 FAILURE | 通过 |
| PR 可合并性 | MERGEABLE | `mergeable=MERGEABLE`，`mergeStateStatus=CLEAN` | 通过 |
| 真仓工作区 | 干净 | `flywheel-FLY-2808` worktree HEAD=`e16cebcf7`，`git status --short` 为空 | 通过 |

边界说明：本沙箱仓（`flywheel-qa-sandbox`）没有 #1299；本文件与所在 PR 只是 529 房 generalized DAG
演练的实现节点载体（do not merge），真实交付仍是真仓 PR #1299。

## implement@2 返工记录（qa@1 FAIL → 原会话拉起）

日期: 2026-09-24
基于: 上节 implement@1 核对记录；返工基线 `aeb1a281d`（沙箱 PR #243 头）
返工来源: qa_fail（qa attempt 1，execution `6e7cac3c`，edge `qa_retry`，确定性替身打回，无文字反馈）

本节点是 implement attempt 2（activation `activation:rework:405c5358…`，TURN epoch 16 为 `yours`），
由**同一实现体 execution `76214bfa` 的原会话拉起**，不是换新替身。拉起留痕（slot StateStore
`workflow_execution_resume_attempt` id=3，只读查询）：

| 字段 | 期望 | 观测 | 结论 |
|---|---|---|---|
| kind / state | original_session / succeeded | `original_session` / `succeeded`，reason_code 空 | 通过 |
| 会话 id | 与首轮一致 | expected = observed = `598f305e-fd8e-425c-8ec7-102f0e18692e` | 通过 |
| 模型 | 与首轮一致 | expected = observed = `claude-opus-5-5` | 通过 |
| 工作目录 | 原 worktree | expected = observed = `/private/tmp/flywheel-test-slot-3/project-slot-3-FLY-2808` | 通过 |
| 拉起耗时 | 有记录 | requested 05:56:09.870Z → finished 05:56:29.108Z，startup/total 19194 ms | 通过 |

返工内容：补上 attempt 1 的 Lead 演练指令（`lead-instruction 5698b9ae`）要求的
`doc/qa/fly2808-callback-drill.md`（单行 `attempt 1`）。该指令在 attempt 1 交卷、TURN 移交 QA 之后才送达，
当时按 TURN 规则未写共享 worktree；本轮在原会话中补做。演练口令按指令未写入任何文件。

边界说明同上：真实交付仍是真仓 PR #1299；本沙箱 PR 只承载 529 房 generalized DAG 演练，do not merge。
