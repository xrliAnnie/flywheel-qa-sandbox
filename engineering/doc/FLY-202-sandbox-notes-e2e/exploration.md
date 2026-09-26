# FLY-202 QA 沙箱说明夹具 — 探索
Issue: FLY-202 (https://linear.app/geoforge3d/issue/FLY-202/qa-sandbox-fixture-slot-harness-real-runner-e2e-task-do-not-pick-up)
日期: 2026-09-26
基于: 无

## 一句话方向

把 `doc/qa/sandbox-notes.md` 当作可重复刷新的稳定夹具：真实 Runner 在隔离的
`flywheel-qa-sandbox` 分支上核对当前仓库、更新说明、提交并复用已存在的 PR，从而给
slot harness 留出可观察的多步执行窗口，同时不碰任何生产资源。

## 问题与成功标准

FLY-202 不是产品功能，而是 test-slot harness 的真实任务入口。Harness（测试编排器，
负责启动隔离环境和 Runner）不能用不存在的 `FLY-SBX-1`，所以需要一个 Linear 中真实
存在、PreHydrator（启动前把 issue 内容装入 Runner 上下文的组件）可读取的 issue。

本次成功必须同时满足：

1. 只在当前 sandbox clone 与现有 `project-slot-1-FLY-202` 分支工作；
2. `doc/qa/sandbox-notes.md` 包含 2–3 段仓库用途、完整顶层目录表、约 10 条
   `packages/qa-framework/README.md` 摘要，以及真实命令
   `ls -R doc/ | head -50` 的 fenced output；
3. 使用现有 open PR #196 作为 branch carrier，base 保持 `main`，不重复开 PR、不 merge；
4. 设计阶段只产出探索、调研、计划和 founder HTML，不修改主交付文件；
5. 实现和 QA 都使用当前 checkout 的事实，不照抄历史 slot-2 文档。

## 当前约束与已知状态

- 当前 branch `project-slot-1-FLY-202` 已有 open PR #196，并继承一条
  `FLY-2456 drill marker r2 B1` 变更；动态任务明确要求 branch continuity，不能重锚、
  force-push 或创建平行分支。
- `doc/qa/sandbox-notes.md` 已存在，内容基本满足旧一轮 fixture。因此 issue 中“create”在
  重复执行语境下解释为“按当前快照原位刷新”，不是制造新的 run-stamped 文件。
- 当前仓库有 17 个 tracked 顶层目录（含 `.claude`、`.flywheel`、`.github`、`.lead`、
  `.serena` 五个隐藏目录）。实现时必须重新枚举；研究期计数只是基线。
- 本节点是 DAG 的 design phase，只交付设计并取得 design-review approval；implementation、
  PR 内容刷新、代码审查和 shipping 都属于后续节点。

## 方案比较

### 方案 A（推荐）：稳定文件原位刷新 + 复用 PR #196

实现节点重新读取仓库树和 QA framework README，重写同一份
`doc/qa/sandbox-notes.md`，保留分支既有历史，push 到现有 PR。

- 优点：与 fixture 的可重复执行目标一致；diff 可审；不会堆积文件；完全遵守 branch
  continuity。
- 代价：PR 继承早先 drill marker，最终审阅需要明确区分 inherited state 与本轮新增内容。

### 方案 B：每次运行新增带 slot/日期的 notes 文件

- 优点：每轮产物互不覆盖。
- 否决原因：issue 指定稳定路径；长期制造垃圾文件；后续 harness 无法用一个固定路径断言。

### 方案 C：给 harness 增加 synthetic fixture 或自动生成器

- 优点：减少对真实 Linear issue 与 GitHub PR 的依赖。
- 否决原因：直接绕过本 issue 要验证的真实 Runner、Git、gate 和 PR 链路；扩大为产品代码
  改动，也失去中途观察窗口。

## 推荐设计

采用方案 A。后续 implementation 先做只读快照，再按 issue 的四段结构更新 Markdown，
运行精确的文档结构验证和 `git diff --check`，最后 commit、push 并复用 PR #196。若当前
快照已经满足某个内容要求，也仍以源 README 与目录枚举为依据逐项复核，不以旧文档自证。

## 边界与负向守卫

- 不修改 `packages/`、运行时代码、生产配置、数据库或 Discord 资源。
- 不把 `.git` 当作顶层目录；只列 repository 中的 tracked/project directories。
- 不运行 full repository 或 full package test suite；本任务只有 Markdown，验证限定在具体文件。
- 不把 PR 的存在误当作内容正确；需要分别验证 branch/head、base、文件结构和命令输出。
- 不 merge、不 request ship approval、不 dispatch successor。
- 不清理或改写 inherited FLY-2456 历史；若它影响最终 PR 语义，由 Lead/后续节点按当前授权处理。

## 设计批准方式

本 DAG 已把 founder-approved issue 作为需求输入，设计批准通过指定的 cross-family
`review_design` gate 完成。交互式 brainstorm 的默认逐问确认在此节点不另开一条并行审批链。
