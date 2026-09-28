# FLY-2984 runner 生命周期说明文件 — 调研
Issue: FLY-2984 (https://linear.app/geoforge3d/issue/FLY-2984/qa-sbx-fly-2925-n-to-n-synthetic-runner-lifecycle-task)
日期: 2026-09-27
基于: exploration.md

## 1. 三段内容的事实来源

段落要描述真实机制，所以先核对本仓/本 runner 的实际合同：

| 段落主题 | 事实 | 来源 |
|---|---|---|
| runner 做什么 | 一个 runner = Flywheel 为 workflow 某一节点启动的一次 Claude Code / Codex 会话；只在持有 TURN 时写共享 worktree；用 `flywheel-comm stage` 报阶段、`ask` 问 Lead | runner 注入的 preamble、`flywheel-comm --help`（`turn`、`stage`、`ask` 条目） |
| 重启时发生什么 | 每步后 `flywheel-comm progress` 把 `progress.md` 游标路径限定提交到分支；resume 派发用 `$FLYWHEEL_PROGRESS_PATH` 指回同一账本，从游标续跑而非从头；FLY-2925 的目标是重启只按原会话续接 | preamble「PROGRESS LEDGER」、`engineering/doc/FLY-2925-engine-owned-lifecycle/plan.md` §1.2 |
| 如何交卷 | commit + push 到 issue 分支 → 用 `flywheel-comm ask --report` 结构化回执报告 Lead → `flywheel-comm complete --route <节点 route>`；runner 不 merge、不部署、不派发后继 | preamble「LEAD REPORT-BACK」、`complete` 条目、节点边界 |

## 2. 幂等判定方法（续跑安全）

候选判定「当前已完成到第几步」的方式：

| 方式 | 结论 |
|---|---|
| 数文件中的段落数 | **选**。文件结构固定（1 个 H1 + N 段），`grep -c` 可精确判断；与远端无关，离线可跑 |
| 读 progress.md 游标 | 辅助。账本可能落后于实际 commit（写文件后、记账前被杀），不能单独作权威 |
| 比 commit message | 辅助。可被 amend/重写，且 progress commit 会夹在中间 |

最终规则：**以文件内容为权威**，再核对 `git status` 是否有未提交改动、`HEAD` 是否已推到远端，三者组合决定下一动作（见 plan §3）。

## 3. push 细节

- 远端分支由设计节点首次 push 创建；implement 用普通 `git push origin project-slot-2-FLY-2984`（fast-forward）。
- push 走 worktree 的 push-guard hooks（`core.hooksPath` 已配置），禁止 `--no-verify` / 改 hooksPath / force push。
- 若 push 非 fast-forward（远端被他人推进），不 force，走 `ask` 报 Lead。

## 4. 风险

| 风险 | 缓解 |
|---|---|
| 重启后重复追加段落 | 写前按段落数判定，已存在则跳过 |
| 写完文件未 commit 就被杀 | 续跑时 `git status` 见未提交改动 → 校验内容与本步期望一致后直接 commit |
| commit 了但未 push | 续跑时 `git rev-parse HEAD` ≠ 远端头 → 只 push，不再改文件 |
| 误改其他文件 | 每步 commit 前断言 `git diff --cached --name-only` 恰为 `qa-sandbox/fly2925-n2n.md` |
