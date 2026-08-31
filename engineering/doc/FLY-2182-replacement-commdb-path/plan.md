# FLY-2182 替换体 CommDB 路径 — 实施计划
Issue: FLY-2182 (https://linear.app/geoforge3d/issue/FLY-2182/引擎急-codex-tmux-替换体-spawn-必挂-引擎-reworkreplacement-派发不带-leadid)
日期: 2026-08-29
基于: research.md

## 1. 目标

让 generalized rework replacement 在“无 predecessor”或“能回溯 predecessor、但其 Lead 解析失败”两种形状下，复用 FLY-2018 已有的 project-member-validated replacement Lead intent，携带完整 `leadId` 进入 `RunDispatcher`/`Blueprint`。

## 2. 范围与假设

### 范围内

- 在 workflow dispatcher 的两种真实 generalized replacement fixture 增加 Lead identity 回归断言。
- 给 dispatcher 注入既有 `resolveWorkflowReplacementLeadIntent` 的生产 adapter；predecessor Lead 解析结果为 `undefined` 时才 fallback。
- 运行 targeted tests、package build/test 与仓库规定的 full gates。

### 范围外

- 不新增或改变 workflow engine 的 Lead owner 算法；只复用 FLY-2018 现有 resolver。
- 不改变 Blueprint 的 `commDbPath` 条件，因此非 replacement 的“有 projectName、无 leadId”行为不变。
- 不放宽 Codex phase keep-alive 的 CommDB fail-loud 守卫。
- 不新增 ghost-node 状态机、补偿表或 replacement rollback 机制；通用半铸问题继续由 FLY-2072 跟踪。
- 不部署、不重启 Bridge、不直接触发 FLY-2152 生产 replacement。

### 假设

- `resolveWorkflowReplacementLeadIntent` 是 replacement Lead intent 的既有入口；它只返回 run 项目配置内的 Lead，项目未知/无 Lead 时返回 `undefined`。
- replacement 继续使用 `workflow_run.project_name` 与既有 `$HOME/.flywheel/comm/<projectName>/comm.db` 路径规则。
- FLY-2018 的 precedence 保持：合法 `selected_by` 优先；否则 fallback 用 `resolveLeadForIssue(labels)`。后者与 GatePoller 的 label scope 一致；前者是既有 run-owner 合同，若配置令 selected_by 与 labels 分歧，属于现有跨系统配置不变量，本单不另造第二套裁决。

## 3. TDD 步骤

### RED

修改 `packages/teamlead/src/__tests__/workflow-engine-dispatcher.test.ts` 的现有 replacement 用例：

- implement dead-actor fixture：实测回溯到 `design-1`；令 `resolveLeadId("design-1")` 返回 `undefined`，replacement intent spy 返回项目内 Lead；断言 fallback 被调用且 request 带该 Lead。这钉住“predecessor id 存在但解析失败”的 FLY-2152 形状。
- founder design fixture：实测无 predecessor；断言同一 fallback 仍生效。
- founder qa fixture：实测回溯到 `implement-1`；断言 predecessor Lead 解析失败后同一 fallback 生效。
- predecessor resolver 返回有效 Lead：断言 fallback 不调用，原优先级不变。
- fallback 返回错误项目/空/`unassigned`：断言这些值不进入 request。

baseline（未改测试）已在依赖构建后通过：目标两条 2 passed / 89 skipped。加断言后，旧实现因没有 replacement intent seam、request 无 fallback `leadId` 而 RED。

### GREEN

1. 在 `WorkflowEngineDispatcherOptions` 增加 `resolveReplacementLeadIntent(run, sourceExecutionId)`，默认返回 `undefined`（缺 wiring 继续 fail-loud，不使用 sentinel）。
2. 在 `plugin.ts` 用现有 `resolveWorkflowReplacementLeadIntent` 实现该 dependency；labels 优先取 `getSessionByIssue(run.issue_id)` 的最新 session，并要求其 `project_name === run.project_name`；仅当该记录不匹配时尝试同项目的 source execution，最后才用 `[]`。这与 `session_started`/GatePoller 的 issue-label 数据源保持一致，也不让同号跨项目 session 污染路由。
3. 在 `startIntent` 计算：

```ts
predecessorLeadId ?? validatedReplacementLeadId
```

其中 fallback 仅在 `replacementContext` 且 predecessor Lead 缺失时调用；返回 intent 必须 project 一致、非空且不是 `unassigned`。不改变 Blueprint/adapter。重跑 RED 测试至通过。

### REFACTOR

检查注释与 diff；确认 resolver 仅在 replacement 且 predecessor Lead 解析失败时调用，普通 dispatch 与 predecessor Lead 优先级不变。没有新增算法/dependency/dead code。

## 4. 验证

### Targeted

1. `pnpm --filter flywheel-teamlead exec vitest run src/__tests__/workflow-engine-dispatcher.test.ts`
2. `pnpm --filter flywheel-teamlead exec vitest run src/__tests__/StateStore.fly1385-dead-exec.test.ts`
3. `pnpm --filter flywheel-teamlead build`
4. `pnpm --filter flywheel-teamlead test`
5. `pnpm --filter flywheel-edge-worker exec vitest run src/__tests__/Blueprint.test.ts`
6. `pnpm --filter flywheel-claude-runner exec vitest run test/CodexTmuxAdapter.test.ts`

### Full repo

1. `pnpm lint`
2. `pnpm -r build`
3. `pnpm test:packages:run`
4. 若 `scripts/__tests__/` 有与本路径直接相关的 shell gate，再运行对应 harness；本单不新增 shell 文件。

## 5. 评审与交付

1. 计划提交后注册 design review；仅在 `reviewVerdict=APPROVED` 后开始 RED。
2. 实现、targeted/full gates 后注册 code review；`CHANGES_REQUESTED` 则修复并新开一轮。
3. 提交并 push feature branch，创建 base=`main` 的 PR。
4. 作为 PR 最后一个 commit，新建 `engineering/doc/milestones/FLY-2182.md`，不修改 `CLAUDE.md`。
5. inbox 终检后运行 `complete --route needs_review --pr <NUMBER>`；不申请 ship approval、不 merge、不部署。

## 6. 完成判据

- generalized replacement 回归测试在旧实现下 RED、在最小改动后 GREEN。
- design 无 predecessor、qa/implement 有 predecessor 但 Lead 解析失败的 replacement 都通过 FLY-2018 resolver 携带项目内 Lead；有效 predecessor Lead 仍优先。
- `unassigned`、空或错误项目 intent 不进入 StartRequest，失败保持可见。
- 非 replacement dispatch、Blueprint 路径条件和全部 adapter 行为不变。
- Codex phase keep-alive 注册守卫保持原样。
- targeted 与 full repo gates 全绿，design/code review 均通过。
- pre-spawn 证据只声明关闭 Lead/CommDB identity 缺口；真实进程、窗口、开工由独立 QA 验收，不以单元测试冒充。
- PR 包含 full-tier docs、实现、验证说明与独立里程碑文件。
