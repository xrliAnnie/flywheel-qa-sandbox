# FLY-202 QA 沙箱说明夹具 — 设计评审建议附录
Issue: FLY-202 (https://linear.app/geoforge3d/issue/FLY-202/qa-sandbox-fixture-slot-harness-real-runner-e2e-task-do-not-pick-up)
日期: 2026-09-29
基于: plan.md

## 评审结论

- Reviewer: Codex `gpt-6-astra` / `xhigh`，thread `01a0edf5-7617-7760-ade8-bcc5aa528870`
- Round 1: **APPROVED**，阻塞问题 0，LOW 建议 2
- 已评审的 plan blob: `34c0f24db00d07f9eca4404e6e90e3f218b15f94`（request `af3ee977-d5d6-4ab4-8058-646beafe98b7`）

批准绑定在上述 blob 上，因此本轮没有再修改 `plan.md`。下面两条建议由 implementation node 在执行
对应步骤时一并遵守；它们只收紧执行顺序与报告口径，不改变 plan 的范围。

## 建议 1（LOW）— lint 结果按实际记录

适用步骤：plan Task 4 Step 3。

评审时 `pnpm lint` 实际 exit 1：1 个格式 error、14 个 warnings。唯一 error 来自
`.flywheel/runs/<exec-id>/codex/design-request.json`，该路径被 `.git/info/exclude` 排除且未被跟踪，
属于 harness 运行态文件，不是本 PR 的 committed delta。

实现节点遇到同类结果时：

- 记录命令、exit code 与 error 来源路径，并用 `git check-ignore -v` / `git ls-files` 证明它是否属于
  committed delta；
- 不得沿用历史记录写 “lint PASS”；
- 不为此修改 Biome 配置、不删除 harness 文件、不扩大到 full test suite。

只有 error 落在 tracked 文件上时才算本任务需要处理的问题。

## 建议 2（LOW）— milestone commit 先于最终 push

适用步骤：plan Task 5。

若修复路径需要更新 `engineering/doc/milestones/FLY-202.md`，顺序为：

1. target 修复 commit（如有）；
2. milestone commit（如有）；
3. final progress commit；
4. push；
5. 核对 local HEAD = remote branch = PR head。

若第 5 步之后又产生任何 commit，必须重做第 4、5 步再 report / complete。already-GREEN 的 no-op 路径
不触发这一顺序问题。
