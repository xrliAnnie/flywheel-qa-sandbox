# Design Review — plan.md (Round 2)
Date: 2026-09-28
Author: Codex
Status: CHANGES REQUESTED

## Summary

本轮只复查 Round 1 四项问题的修订及直接契约，不扩大探针范围。PR 范围、账本与最终 push 的顺序、同步失败处理、DAG 交卷行为均已实质修正。还剩 1 项 P2：换体恢复时以“最近触碰 README 的提交”恢复 README_SHA，在计划允许的并发 README 合并场景中会选中 merge commit，导致证据与回滚目标错误。

提交号说明：请求中的 `75b297b030` 在本地不存在；当前分支 HEAD 实际为 `75297b030b5533a2f3b00b3d4e59b8470953e625`，提交说明为 plan v2 after Codex design review R1，内容与本次描述一致。本审查固定在该实际提交，plan blob 为 `18184673f1d3e6594dc7b59f3a412d30f0ac452d`，对比 Round 1 的 `37026c0ef3e472342d99da9bc1894add4649d08d`。工作区 plan 与该提交一致。

以下 `plan.md` 均指 `engineering/doc/FLY-3029-nton-claude-body/plan.md`。

| Round 1 项目 | Round 2 结论 |
|---|---|
| #1 PR 范围 | 已关闭。plan.md:24–38 分开定义 README +1/−0 和精确过程文档允许集合；当前 5 个分支变更文件均在集合内。research/exploration 的历史先例与 README 空格纠正已核对。 |
| #2 账本 / HEAD 顺序 | 原先的未推送账本问题已关闭。首次账本在同步后，最后账本在 push 前，Step 5b 核对本地与 PR head，交卷后不再提交。新增的 README_SHA 恢复分支仍有下述 1 项问题。 |
| #3 换体同步 | 已关闭。显式检查远端同名分支，缺 upstream 也续接；fetch 与 ff merge 错误停止。Step 0 在同步前不提交，PR 查询错误不再当成空结果。分叉停止上报符合本任务边界，不要求新恢复机制。 |
| #4 交卷契约 | 已关闭。plan.md:164–171 以节点注入能力与完成指令为准，legacy question-id 有条件使用，收尾跟随 completionDisposition，不再硬编码 awaiting_review。 |

本轮重新核对了指定 QA room 源码树中的 `progress.js:84–105`（自动提交账本）、`primary-pr-admission.ts:212–223`（PR head 必须等于完成 HEAD）、`complete.js:339–355,395–413`（question-id 与完成回执）及 `Blueprint.ts:1987–1995,2037–2042`（generalized 节点的 ship 能力与交卷指令）。这些契约支持上述关闭结论。

## What's Good (Keep)

- 保留现有 doc-flow，单独验 README 业务差异，无需删设计文档或重写历史。
- 同步前不产生新账本提交，失败停止；缺 upstream 的换体路径已补齐。
- 最终 push、PR head 核对、complete 的顺序清楚；不再让 progress 破坏交卷时的 HEAD 一致性。
- 交卷继续使用既有 needs_review 路由，按实际 DAG 能力决定 gate 与 park，不新增 N-to-N 机制。

## Issues & Recommendations

1. **[P2] 恢复 README_SHA 时可能选中同步 main 的 merge commit，而非原探针提交。**

   **位置：** `plan.md:115–118`；受影响的回滚与证据要求见 `plan.md:180,193`。

   **复现场景：** 旧体已提交探针；另一个 QA 在 main 末尾追加自己的行；按 Step 1 的既定冲突处理，将 main 合入本分支并保留双方行。随后新体接手，Step 2 因探针已存在而跳过追加，Step 3 无新 README 变更，执行：

   ```bash
   README_SHA=$(git log --format=%H -1 -- README.md)
   ```

   该命令选中刚才解决 README 冲突的 merge commit。隔离实测中原探针提交为 `cd2fb12`，命令却选中双亲提交 `333496f`。此时 `git diff main...HEAD --numstat -- README.md` 仍正确为 `1 0 README.md`，而 `git show --stat 333496f` 也显示“1 file changed, 1 insertion”，所以现有数值验证不能发现错选。对该 merge 的第一父提交查看实际 diff，新增的却是 `other QA probe`，不是本任务探针。

   **为什么重要：** D2 / DONE 会把 merge 错报为 README 单行提交；§6 的 revert 目标也随之错误。普通 `git revert <merge-SHA>` 会要求指定 mainline；若机械使用第一父提交，则撤销的是并发 QA 行，而非目标探针。该场景直接来自计划已有的并发 README 处理路径，不需要引入额外故障假设。

   **建议：** 新提交时立即记录 SHA 的分支保留；恢复时从已验证的原提交记录读取，或在分支历史中按精确 probe 行/提交标题寻找非 merge 候选，并核对其实际 patch 只向 README 追加该行后再确定 README_SHA。不能只用“最近触碰 README”或 +1 的统计来确认身份。证据与回滚均引用这个经过核对的原提交，无需新增机制。

执行验证全部位于 `/tmp/fly3029-r2-review-lf96evhy`：首体无远端分支、缺 upstream 但远端已有旧体提交、重复追加、跨账本提交恢复原 README SHA、分叉失败停止、fetch 失败停止均已验证；并发 README 冲突合并后错选 SHA 已复现。未运行项目测试套件或真实 comm/PR 操作，未修改任何仓库文件。

## Verdict

CHANGES REQUESTED — address items above
