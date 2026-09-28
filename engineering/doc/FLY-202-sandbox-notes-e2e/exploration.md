# FLY-202 QA 沙箱 fixture 说明刷新 — 探索
Issue: FLY-202 (https://linear.app/geoforge3d/issue/FLY-202/qa-sandbox-fixture-slot-harness-real-runner-e2e-task-do-not-pick-up)
日期: 2026-09-28
基于: 无

## 1. 任务目的

FLY-202 不是产品功能，而是 test-slot harness 的常驻 QA fixture（测试夹具，即为了稳定触发真实测试路径而保留的任务）。`scripts/inject-linear-issue.sh` 会把这个真实 Linear issue 注入 slot-local Bridge，再由 `/api/runs/start` 启动真实 Runner。任务刻意保持为低风险、多步骤文档工作，让 QA 能在 Runner 尚未完成时观察阶段、TURN、gate、commit、push 与 PR 行为。

本 design 节点只定义后续 implement 节点如何刷新 `doc/qa/sandbox-notes.md` 并开 PR；它不修改目标文件、不创建 PR、不请求 ship，也不接触生产资源。

## 2. 当前状态与约束

- 当前仓库是 `xrliAnnie/flywheel-qa-sandbox` 的 slot-6 clone，分支为 `project-slot-6-FLY-202`。
- 本轮开始时 HEAD 仅比 `origin/main` 多一笔 progress ledger commit，远端同名分支尚不存在；design artifacts 随后已正常发布到同名远端分支。后续节点只能 fast-forward push；若 main 前进则普通 merge，同样不存在 rebase 或 force-push 需求。
- `doc/qa/sandbox-notes.md` 已存在。因此 issue 中的 “Create” 在本轮解释为：对同一稳定路径做完整、可审查的原位刷新，而不是另建 run-stamped 文件。
- 目标文件只能描述当前 sandbox clone。生产仓库、生产 Discord、生产数据库与 merge 均不在范围内。
- 输出中的目录表和 `ls -R doc/ | head -50` 必须由 implement 节点现场读取，不能把本 design 阶段的快照当成最终内容。
- 本轮是 DAG 的 **re-dispatch**（同一 issue 的工作流被重新启动，design 节点在已保留的分支上再次执行）。分支 `project-slot-6-FLY-202` 已包含上一轮 design + implement 的全部产物，sandbox PR #267 处于 open 状态，且 `origin/main` 未前进。因此本轮 design 不能假装分支是空白的，也不能要求 implement 节点重做已完成并已验证的工作。

## 3. 可选方案

### 方案 A：稳定路径原位刷新（推荐）

重写 `doc/qa/sandbox-notes.md` 的四个内容区块：2–3 段用途说明、全部顶层目录表、约 10 条 README 摘要、真实命令输出。优点是路径与 PR 形状稳定、重复 E2E 不产生垃圾文件、差异直接暴露仓库结构变化；缺点是每轮可能覆盖上一轮措辞，但 Git 历史仍保留审计轨迹。

### 方案 B：只追加本轮内容

在现有文件尾部追加新表格、摘要和树快照。优点是写入简单；缺点是会保留过时目录、重复章节并让“当前仓库说明”失去单一事实源，因此拒绝。

### 方案 C：增加生成脚本

新增脚本自动生成表格和命令输出。优点是机械一致；缺点是把纯文档 fixture 扩成代码改动，增加测试与维护面，也违反本 issue 的低风险、docs-only 意图，因此拒绝。

## 4. 推荐方向

采用方案 A。文件路径 `doc/qa/sandbox-notes.md` 是稳定身份；标题与章节名只是显示标签，可以改善但不应改变下游引用路径。每轮从当前仓库读取事实并替换对应章节，避免复制旧轮次的 slot 号、目录计数或 `doc/` 树。

回滚边界是本 issue 的 docs commit：出现内容问题时可修正该文件并追加 commit；不得回滚或重写已发布分支历史。负向守卫包括：不修改 `packages/` 或脚本、不访问生产资源、不 merge PR、不使用 force-push、不把隐藏的顶层文件误当目录。

## 5. 成功证据

后续节点需要提供以下可检查证据：目标 Markdown 四部分齐全；目录表集合等于现场顶层目录集合；README 摘要数量约为 10 且覆盖主要能力；fenced block 与同一时点命令输出一致；Git diff 只含本 issue 文档；远端 PR 为 open、base=`main`、head=`project-slot-6-FLY-202`。

## 6. 本轮 re-dispatch 现状与处理原则

审计结果（2026-09-28，HEAD `8ab7e5fde`）：

- 远端 `origin/project-slot-6-FLY-202` 与本地 HEAD 相同；`origin/main` 仍为 `1855f7a1a`，本地 ahead 19、behind 0。
- PR #267（base=`main`、head=`project-slot-6-FLY-202`）open、`mergeable=MERGEABLE`、`mergeStateStatus=CLEAN`。
- `doc/qa/sandbox-notes.md` 在当前 HEAD 通过上一轮 plan 的四项定向验证：目录集合、10 条 bullet、tree block 逐字一致、`git diff --check`。
- 上一轮 founder HTML 因 `mmdc` 无法启动 Chromium 而使用了 `DIAGRAM PENDING LOCAL RENDER` 占位；本轮实测 `mmdc` 11.12.0 可正常渲染。

处理原则：

1. **继承而非重做。** design 文档在原文件上增量刷新，记录本轮事实；不新建第二套 doc folder，不改写已发布历史。
2. **implement 节点先对账再动手。** 计划新增"对账"任务：若四项验证在 exact head 仍通过且 `origin/main` 未前进，则不产生新的 notes commit，只重新确认 PR 证据；若 `origin/main` 前进或验证失败，才按原 Task 1–5 刷新并 push 到**同一个** PR，绝不开第二个 PR。
3. **founder HTML 补齐真实图。** 用本地 `mmdc` 渲染 Mermaid 源为 SVG 并内联，去掉占位说明；这是本轮 design 相对上一轮最实质的产物变化。
4. **边界不变。** 仍然只允许 docs 改动、fast-forward push、不 merge、不请求 ship、不接触生产资源。
