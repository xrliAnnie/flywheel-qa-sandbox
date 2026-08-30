# FLY-2182 替换体 CommDB 路径 — 调研
Issue: FLY-2182 (https://linear.app/geoforge3d/issue/FLY-2182/引擎急-codex-tmux-替换体-spawn-必挂-引擎-reworkreplacement-派发不带-leadid)
日期: 2026-08-29
基于: exploration.md

## 1. 根因链的代码证据

### 1.1 replacement dispatch

`WorkflowEngineDispatcher.startIntent()` 在识别 `rework_replacement:<requestId>` 后，以 rework request 的 `base_revision` 作为 `startPoint`。这个分支不要求 predecessor session；随后：

- `projectName` 直接取 `run.project_name`，无条件放进 `startDispatcher.start()`；
- `leadId` 由 `predecessorExecutionId ? resolveLeadId(...) : undefined` 得到，并通过条件 spread 传递；
- replacement 因此可以同时满足“项目身份完整”和“Lead 身份缺失”。

这不是输入损坏，而是派发模型允许的形状。

### 1.2 RunDispatcher 与 Blueprint

`WorkflowEngineDispatcher` 已注入通用 `resolveRunAlertIdentity` 做告警，但它不适合作为 spawn identity：测试默认会返回 sentinel `unassigned`，生产 fallback 可能是另一个项目的 global default Lead。两者都是非空字符串，会穿过 Blueprint/adapter 的存在性守卫，却没有可达 mailbox/gate consumer。

FLY-2018 已提供更窄的 `resolveWorkflowReplacementLeadIntent`。它先找到 `run.project_name` 的项目，再只从该项目的 `leads` 里接受 `selected_by`；否则用 `resolveLeadForIssue` 从 labels 选项目内 Lead。项目不存在/无 Lead 时返回 `undefined`，从不产生 sentinel 或跨项目 fallback。

`RunDispatcher.start()` 用 `defaultGetCommDbPath(req.projectName)` 完成 pre-registration 和 pre-launch TURN grant，随后把 `projectName` 与可选 `leadId` 原样放进 `BlueprintContext`。

`Blueprint.runInner()` 的当前条件是：

```ts
ctx.leadId && ctx.projectName ? path.join(..., ctx.projectName, "comm.db") : undefined
```

路径本身只按 `projectName` 分区，但 `leadId` 还承担 prompt 通信目标与 CommDB row identity，不能只为拿到路径而绕开它。

### 1.3 Codex adapter

`CodexTmuxAdapter.execute()` 在 daemon spawn 前调用 `registerCommDbSession(ctx)`。当 `phaseKeepAlive` 存在且 `commDbPath` 缺失时，它抛出 `phase keep-alive requires CommDB registration`。这是必要的 fail-loud：phase lifecycle 依赖 CommDB 中的 session、TURN 和 doorbell 状态。

因此失败发生在真正 Codex 进程与可见窗口启动之前，和 sandbox/approval credential 配置无关。

## 2. 路径所有权与历史

- `packages/teamlead/src/bridge/commdb-path.ts`：`commDbPathForProject(projectName)` → `<root>/<projectName>/comm.db`。
- `packages/teamlead/src/bridge/session-capture.ts`：`defaultGetCommDbPath(projectName)` 使用同一规则。
- `git blame` 显示 Blueprint 条件来自 2026-03-22 的 GEO-206 初始 Lead↔Runner 通信实现；当时派发形状尚未覆盖当前 generalized rework replacement。
- FLY-887 的 `leadId` 信任讨论针对 three-stage channel allowlist，属于是否进入三段式的策略门；它不是 CommDB 路径键。不能把该策略语义外推为数据库定位要求。

结论：CommDB 是 per-project 数据库，但 resident replacement 同时必须有 Lead identity。当前修复应在派发边界补齐已有 run owner，而不是让 downstream 接受半身份 context。

## 3. 最小正确改动

给 dispatcher 增加一个注入式 `resolveReplacementLeadIntent(run, sourceExecutionId)` dependency；生产 wiring 复用 `resolveWorkflowReplacementLeadIntent`。labels 优先取 `getSessionByIssue(run.issue_id)`，但必须校验 session 的 `project_name` 与 run 一致；不匹配时才尝试同项目的 source execution，最后使用空数组。这个顺序复用 `session_started`/GatePoller 的 issue-label 数据源，并避免 `getSessionByIssue` 的 issue-only 查询误取同号跨项目 session。然后把 replacement 的 Lead 选择改为：

```ts
const predecessorLeadId = predecessorExecutionId
  ? resolveLeadId(predecessorExecutionId)
  : undefined;
const replacementLeadIntent =
  replacementContext && !predecessorLeadId
    ? resolveReplacementLeadIntent(run, predecessorExecutionId)
    : undefined;
const leadId =
  predecessorLeadId ??
  (replacementLeadIntent?.projectName === run.project_name &&
  replacementLeadIntent.leadId !== "unassigned" &&
  replacementLeadIntent.leadId.trim()
    ? replacementLeadIntent.leadId
    : undefined);
```

保持不变的边界：

- 非 replacement dispatch 的 `leadId` 行为完全不变。
- replacement 有 predecessor 且能解析 Lead 时继续优先沿用 predecessor Lead，不调用 fallback。
- replacement 无 predecessor，或能回溯 predecessor 但其 session/Lead 解析失败时，复用 project-member-validated replacement intent。
- resolver 返回 `undefined`、错误项目、空字符串或 `unassigned` 时不传 `leadId`，由 downstream 继续 fail-loud；绝不把哑身份伪装成成功。
- Blueprint、adapter 注册守卫、TURN、session lifecycle、数据库 schema 均不修改。

不新增 resolver 算法：只增加一条 dependency-injection seam，把 FLY-2018 既有 helper 接到 spawn path。

### 3.1 predecessor 形状核对

源码事件链证明两种 replacement 形状都存在：

- `materializeWorkflowReworkReplacement` 写 `execution_dead_rolled_back(newExecutionId=replacement, execution_id=dead)`；`startIntent` 会沿此事件回溯。
- implement dead-actor fixture 实测回溯得到 `predecessorExecutionId="design-1"`；founder qa fixture 实测得到 `"implement-1"`。即使 id 存在，生产 `resolveLeadId` 仍可能因 session 已清理而返回 `undefined`；fallback 必须挂在解析结果上，而不是只挂在 id 缺失上。
- founder design replacement fixture 实测无可追溯 predecessor，覆盖 id 缺失形状。

依赖安装并构建 teamlead 闭包后，两个未修改的 baseline replacement tests 均通过（2 passed / 89 skipped，2026-08-29）。RED 阶段会给现有 `resolveLeadId` seam 加 spy，实测钉住上述调用与 fallback 分支。

## 4. TDD 验证缝

最窄的可失败断言继续落在现有 `workflow-engine-dispatcher.test.ts` 的真实 generalized replacement fixtures：

1. implement dead-actor replacement：`resolveLeadId` spy 返回 `undefined`；断言它以 `design-1` 调用，replacement intent fallback 收到 run `flywheel/FLY-1307/run-1` 与同一 source id，且 `StartRequest.leadId` 为 `flywheel-eng-lead`。
2. founder design replacement：断言无 predecessor 时同一个 fallback 仍提供 Lead；founder qa replacement：断言以 `implement-1` 解析失败后 fallback 提供 Lead。
3. predecessor resolver 返回有效 Lead：断言 replacement fallback 不调用，原优先级不变。
4. fallback 返回错误项目/`unassigned`：断言 request 不携带该值，downstream fail-loud 契约不被绕过。

改实现前 dependency 不存在且 request 没有 fallback `leadId`（RED）；接入现有 replacement helper 后两种 replacement 形状都得到项目内 Lead（GREEN）。现有 `Blueprint.test.ts` 已证明 `leadId + projectName` 会产生正确 `commDbPath`，现有 Codex adapter tests 证明 phase keep-alive 用该路径注册；三条接口证据覆盖 production pre-spawn 链，而不伪称启动了真实 daemon。

同一 dispatcher test 已覆盖 replacement 合法铸出新 execution、使用 `base_revision`、失败时 release launch claim；新断言直接落在这条 generalized replacement 路径，不另造集成 harness。

## 5. 验收映射

| 要求 | 证据 |
|---|---|
| replacement 无 predecessor 或 predecessor Lead 解析失败时仍有项目内 Lead identity | dispatcher 两种 generalized replacement RED/GREEN 回归测试 |
| sentinel/跨项目 intent 不被当成 Lead | invalid-intent 负向断言；production helper 的项目成员过滤 |
| Blueprint 得到 Lead + project 后推导 CommDB 路径 | 既有 `Blueprint.test.ts` 正向断言 |
| phase keep-alive 注册守卫不被削弱 | `CodexTmuxAdapter` 零改动 + 既有 adapter tests |
| 普通 dispatch 不回归 | Blueprint/RunDispatcher 零改动 + teamlead/edge-worker package tests |
| FLY-2152 类 replacement 的 pre-spawn 缺口被关闭 | dispatcher request → 既有 Blueprint path → 既有 adapter registration 三段接口证据；真实进程/窗口由后续独立 QA 验收 |
| 不另造 ghost recovery | workflow launch release/unlaunched recovery 代码零改动；FLY-2072 继续承接通用问题 |
