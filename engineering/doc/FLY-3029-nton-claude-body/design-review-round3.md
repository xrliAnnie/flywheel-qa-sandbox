# Design Review — plan.md (Round 3)
Date: 2026-09-28
Author: Codex
Status: APPROVED

## Summary

Round 2 的唯一 P2 已关闭。本轮固定审查 `ccfc0d8a62a82204b365ba37ae1b68be00974cb1`，plan blob 为 `7ba6ffc1a1a54f80f98e9df760f04748e634c57d`；工作区文件与该提交一致。已重读完整计划，重点复查相对 `75297b030b5533a2f3b00b3d4e59b8470953e625` 的 README_SHA 恢复逻辑和回滚说明，保留前两轮已关闭结论。

`engineering/doc/FLY-3029-nton-claude-body/plan.md:117–128` 现在排除 merge 候选，要求整个提交的 numstat 精确为 README +1/−0，并验证新增行等于探针；找不到合格提交时退出 1，另有单亲检查。该组合能识别原探针提交，不会再被最近修改 README 的合并提交误导。`:189` 的回滚说明与单亲约束一致。

## What's Good (Keep)

- 同时核验提交范围与实际新增文本，避免仅靠提交标题或 +1 统计认定身份。
- 新提交立即记录 SHA；换体恢复重新核验候选；找不到时明确停止，不猜测目标。
- 保留前两轮修正的 PR 允许范围、最终 push/HEAD 核对顺序和按节点能力交卷的流程。
- 修正仅涉及计划中的恢复命令，没有增加 N-to-N 机制或扩大探针负载。

## Issues & Recommendations

无待修改项，0 findings。

在 `/tmp/fly3029-r3-review-5sns2tzd` 的独立 Git 仓库中，提取当前计划的 Step 3 原样执行并验证：

| 场景 | 结果 |
|---|---|
| 首次追加后执行 Step 3 | 正确记录新提交 SHA，单亲检查通过。 |
| 并发 main 追加、冲突合并、后续账本提交后恢复 | Bash、Zsh 均选中原探针 SHA，排除 merge commit。 |
| 混入同标题但新增文本错误的候选 | 两种 shell 均跳过错误候选。 |
| 混入同标题、含探针但同时改其他文件的候选 | 两种 shell 均跳过多文件候选。 |
| 没有合格候选 | 两种 shell 均 exit 1，输出停止并询问 Lead。 |
| 回滚恢复出的原提交 | 无需 mainline 参数；并发末尾追加导致普通内容冲突，显式保留另一 QA 行后继续 revert，最终 README 与 main 一致。未将此计为无冲突回滚。 |

本轮未运行项目测试套件或真实 comm、push、PR 操作；实际仓库的 HEAD、README 与其他文件未修改。上述执行证据仅验证计划命令，不代表真实交卷或 N-to-N 生命周期 QA 已完成。

## Verdict

APPROVED — ready to implement
