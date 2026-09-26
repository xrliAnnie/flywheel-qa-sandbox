# FLY-202 QA 沙箱说明夹具 — 探索
Issue: FLY-202 (https://linear.app/geoforge3d/issue/FLY-202/qa-sandbox-fixture-slot-harness-real-runner-e2e-task-do-not-pick-up)
日期: 2026-09-26
基于: 无

## 一句话方向

把 `doc/qa/sandbox-notes.md` 作为可重复核验的稳定夹具：真实 Runner 在隔离的
`flywheel-qa-sandbox` 分支上从当前仓库重新取证，只在证据不一致时刷新文件，并复用现有
PR #196；这样既保留 slot harness 的真实多步链路，也不会为了制造 diff 而改动已经正确的内容。

## 问题与成功标准

FLY-202 不是产品功能，而是 test-slot harness 的真实任务入口。Harness（测试编排器，负责启动
隔离环境和 Runner）不能依赖不存在的 synthetic issue；它需要一个 Linear 中真实存在、
PreHydrator（启动前把 issue 内容装入 Runner 上下文的组件）可读取的任务。

本次 design re-dispatch 的 branch continuity 还带来一个额外约束：当前 branch 已包含上一轮设计、
实现和 implementation milestone。设计不能假装这些提交不存在，也不能在 design node 回滚或重做
实现。因此成功标准分成“最终状态”与“本节点交付”两层：

1. 最终状态中，`doc/qa/sandbox-notes.md` 仍有 2–3 段仓库用途、完整顶层目录表、约 10 条
   `packages/qa-framework/README.md` 摘要，以及真实命令 `ls -R doc/ | head -50` 的 fenced output；
2. 当前 open PR #196 继续以 `main` 为 base、以 `project-slot-1-FLY-202` 为 head，不另开 PR、不 merge；
3. 本 design node 只刷新探索、调研、实施计划和 founder HTML，取得有效 design-review approval；
4. 后续 implementation node 先核验现状，仅在 current evidence 证明内容过期时修改主交付文件；
5. 所有工作都留在 sandbox clone，不接触生产资源。

## 当前约束与已知状态

- 当前 branch `project-slot-1-FLY-202` 的 preserved baseline 为 `ab1d379b1`，PR #196 为 OPEN、
  MERGEABLE、非 draft，两个 exact-head CI checks 均为 SUCCESS。
- `doc/qa/sandbox-notes.md` 已由上一轮 implementation 刷新，并保留 inherited
  `FLY-2456 drill marker r2 B1`。本节点没有授权删除或重写该历史。
- 当前 repository root 有 17 个 tracked/project directories；tracked tree 与 live checkout 枚举一致。
- `packages/qa-framework/README.md` 仍是目录表之外最重要的内容 source of truth；目标摘要不得靠旧文档
  自证。
- 现有 research 中“远端 head 仍为 `87f4e319f`”和 plan 中“listing parser 应先失败”都已过期，必须
  按当前权威状态修订。
- 本节点是 DAG 的 design phase；不实现、不 dispatch successor、不 request ship approval、不 merge。

## 方案比较

### 方案 A（推荐）：审计优先的幂等复核 + 复用 PR #196

后续节点重新读取目录树、QA framework README、目标 Markdown 和 PR head。若所有断言成立，保留
目标文件字节不变并记录验证证据；若任一断言失败，只修正对应内容，再运行同一组检查。

- 优点：忠实反映 preserved branch；避免制造无意义 diff；仍完整验证真实 Git/GitHub/Runner 链路。
- 代价：若内容已经正确，implementation 可能没有新的 target-file commit；验证证据与 PR head 检查
  因而必须写得更明确。

### 方案 B：无条件重写同一个 Markdown

- 优点：每轮都能产生显眼的文件 diff。
- 否决原因：在 source facts 未变化时只会制造 churn；可能改变已审核措辞却没有提高正确性；违背
  evidence-first 的 re-dispatch 语义。

### 方案 C：重建 feature branch 或另开新 PR

- 优点：表面上能得到更“干净”的 FLY-202 history。
- 否决原因：直接违反 branch continuity 与禁止 force-push 的约束，也会丢失 harness 正在观察的真实
  carrier。

## 推荐设计

采用方案 A。实现节点把稳定文件视为 materialized view（由当前仓库事实生成的文档视图）：source
facts 是 root directories、QA README 和 live `doc/` listing，PR #196 是 carrier。验证器先读取这些
sources，再逐项比对目标；只有 mismatch 才触发最小编辑。这样同一任务既能首次创建，也能在重放时
安全收敛。

## 边界与负向守卫

- 不修改 `packages/`、运行时代码、生产配置、数据库、Discord 资源或 issue 本身。
- 不把 `.git` 或临时目录当作 repository 顶层目录；tracked 与 live 集合不一致时先记录差异。
- 不运行 full repository 或 full package test suite；本任务只有 Markdown，验证限定在具体文件。
- 不把 open PR 或绿色 CI 单独当作内容正确；文件结构、live command output、PR head 和 CI 要分别验证。
- 不为了获得新 commit 而无条件改写内容；若 no-op，明确记录“current evidence already satisfies contract”。
- 不 merge、不 request ship approval、不 dispatch successor。
- 不清理或改写 inherited FLY-2456 历史；若它影响最终 PR 语义，由 Lead 按当前授权处理。

## 设计批准方式

本 DAG 已把 founder-approved issue 作为需求输入，且规定以 cross-family `review_design` gate 审批
本节点设计。该 gate 是本轮设计批准链；不额外建立一条交互式审批链，也不以既有旧 review 代替
本轮基于新 baseline 的 review。
