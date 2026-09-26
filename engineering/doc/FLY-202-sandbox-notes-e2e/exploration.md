# FLY-202 QA 沙箱 fixture 说明刷新 — 探索
Issue: FLY-202 (https://linear.app/geoforge3d/issue/FLY-202/qa-sandbox-fixture-slot-harness-real-runner-e2e-task-do-not-pick-up)
日期: 2026-09-26
基于: 无

## 1. 任务目的

FLY-202 不是产品功能，而是 test-slot harness 的常驻 QA fixture（测试夹具，即为了稳定触发真实测试路径而保留的任务）。`scripts/inject-linear-issue.sh` 会把这个真实 Linear issue 注入 slot-local Bridge，再由 `/api/runs/start` 启动真实 Runner。任务刻意保持为低风险、多步骤文档工作，让 QA 能在 Runner 尚未完成时观察阶段、TURN、gate、commit、push 与 PR 行为。

本 design 节点只定义后续 implement 节点如何刷新 `doc/qa/sandbox-notes.md` 并开 PR；它不修改目标文件、不创建 PR、不请求 ship，也不接触生产资源。

## 2. 当前状态与约束

- 当前仓库是 `xrliAnnie/flywheel-qa-sandbox` 的 slot-6 clone，分支为 `project-slot-6-FLY-202`。
- 当前 HEAD 仅比 `origin/main` 多一笔本轮 progress ledger commit，且远端同名分支尚不存在；不存在历史重写或 force-push 需求。
- `doc/qa/sandbox-notes.md` 已存在。因此 issue 中的 “Create” 在本轮解释为：对同一稳定路径做完整、可审查的原位刷新，而不是另建 run-stamped 文件。
- 目标文件只能描述当前 sandbox clone。生产仓库、生产 Discord、生产数据库与 merge 均不在范围内。
- 输出中的目录表和 `ls -R doc/ | head -50` 必须由 implement 节点现场读取，不能把本 design 阶段的快照当成最终内容。

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
