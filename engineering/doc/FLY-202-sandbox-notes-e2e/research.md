# FLY-202 QA 沙箱说明夹具 — 调研
Issue: FLY-202 (https://linear.app/geoforge3d/issue/FLY-202/qa-sandbox-fixture-slot-harness-real-runner-e2e-task-do-not-pick-up)
日期: 2026-09-26
基于: exploration.md

## 1. 仓库与分支事实

| 项目 | 当前事实 | 实现含义 |
| --- | --- | --- |
| 仓库 | `xrliAnnie/flywheel-qa-sandbox` | 所有写操作都留在 sandbox clone |
| 分支 | `project-slot-1-FLY-202` | 动态任务要求原分支连续，不另建分支 |
| main merge-base | `1855f7a1a` | 当前 branch 在最新 fetched `origin/main` 之上，behind=0 |
| open PR | #196，base=`main`，head=`project-slot-1-FLY-202` | 实现阶段复用，不创建重复 PR |
| inherited PR 内容 | `FLY-2456 drill marker r2 B1` | 属于既有历史；本轮不重写或删除 |
| doc-flow | enabled，department=`engineering` | 过程文档复用本文件夹 |

设计开始时 `git status` 无未提交用户改动。进度命令已产生本轮 path-limited progress
commits；exploration/research/plan/HTML 会由 design node 独立 commit 后 fast-forward push。

## 2. 目标文件现状

`doc/qa/sandbox-notes.md` 已存在，不是空白新文件。它当前有：

- 3 段仓库用途说明；
- 17 行顶层目录表；
- 10 条 QA framework 摘要；
- 标注命令 `ls -R doc/ | head -50` 的 fenced `text` block；
- fenced block 后的 inherited FLY-2456 marker。

因此实现任务不是“证明旧文件看起来差不多”，而是从当前源重新取证后刷新稳定文件。
这保证 README 或目录树发生变化时仍产生正确结果，也给 harness 保留多个可观察步骤。

## 3. 顶层目录模型

下列两个只读命令在本 checkout 都得到相同的 17 个 project directories：

```bash
git ls-tree -d --name-only HEAD | LC_ALL=C sort
find . -mindepth 1 -maxdepth 1 -type d -not -name .git -exec basename {} \\; | LC_ALL=C sort
```

当前集合：

```text
.claude
.flywheel
.github
.lead
.serena
agents
doc
docs
engineering
fleet
packages
patches
product
qa-fly294
qa-fly310
scripts
supabase
```

实现时要重新运行两个命令。若 working tree 出现未 tracked 的顶层目录，issue 的“repo 中每个
顶层目录”语义要求先判断它是不是 harness 临时产物；不能静默把临时目录写进长期文档。

## 4. QA framework README 事实

`packages/qa-framework/README.md` 当前 316 行，主要内容按源文件顺序为：

1. 可复用、plan-aware 的 QA Agent Framework；
2. framework 与 project config 的两层架构；
3. Quick Start；
4. Onboard → Analyze + Plan → Research → Write + Execute → Finalize 五步协议；
5. config schema 与示例；
6. FLY-115 real-Runner test slots，包括 deploy/inject/teardown 三个脚本、前置条件和
   `FLYWHEEL_RUNNER_START_POINT`；
7. FLY-60 hard-gate manual suite；
8. FLY-153 shared-channel Mirror Mode；
9. FLY-529 Roundtable Mirror 与 Alert Mirror；
10. plan-source 与 skill-interface contracts。

“约 10 条”最好收敛为恰好 10 条，每条对应一个稳定概念，避免把 README 大段复制进目标文件。

## 5. 命令输出取证

Issue 明确要求执行：

```bash
ls -R doc/ | head -50
```

这段输出依赖执行时的 `doc/` 内容。当前前 50 行包含历史 FLY-145 与 FLY-202 报告文件夹，
但 design node 新建在 `engineering/doc/` 的文件不会改变它。实现节点仍必须现场执行，
原样写入 fenced block；不能复用 research 中的观察值。

## 6. PR 与外部状态

PR #196 当前状态为 OPEN、MERGEABLE、非 draft；远端 head 仍指向本轮设计开始前的
`87f4e319f`，因为本轮 design commits 尚未 push。动态任务明确要求继续这个 PR，因此：

- design node 只 push 设计产物，不修改 PR title/body；
- implementation node push 主交付物后再次读取 PR，确认 base/head 与 local HEAD；
- 是否改 PR 元数据应服从后续节点授权，不把“标题仍是 FLY-2456”误判为需要开第二个 PR；
- 任何 merge、ship approval 或 force-push 都明确禁止。

## 7. 验证策略

本次主交付物是 Markdown，没有 TypeScript 或运行时代码变更。适用的本地证据是：

1. `git diff --check`：空输出、exit 0；
2. 针对 `doc/qa/sandbox-notes.md` 的小型只读解析检查：2–3 段、17 个目录逐一出现、
   8–12 个摘要 bullet、fenced output 为 50 行；
3. 重新执行 `ls -R doc/ | head -50`，与 fenced block 字节一致；
4. `gh pr view 196`：state OPEN、base `main`、head 为当前 branch，且远端 head 与
   push 后 local HEAD 一致；
5. `git diff --name-status origin/main...HEAD`：除 inherited marker 与本 issue design/docs
   外无产品代码变更。

不会运行 bare Vitest、package suite 或 repository suite；它们既不覆盖 Markdown 合同，也违反
本任务的 local-test-policy。

## 8. 风险与回滚边界

| 风险 | 设计对策 | 回滚边界 |
| --- | --- | --- |
| 旧 notes 自证导致遗漏 | 总是从目录树与 README 重新取证 | 只回滚本轮 notes commit |
| 顶层目录数在 implement 前变化 | 实现时重新枚举并解释差异 | 不回滚其他人的目录变更 |
| 已有 PR 元数据与 FLY-202 不一致 | 复用 PR，报告事实，不自行开新 PR | 不改写 published branch |
| inherited marker 混入结果 | 在计划与交接中显式标记为 inherited | 不删除既有 FLY-2456 变更 |
| fenced output 漂移 | 写入后立刻重跑并做字节对比 | 仅刷新 fenced block |
| 生产资源误触 | 限定当前 clone、禁 merge/ship/deploy | 设计阶段无生产副作用 |
