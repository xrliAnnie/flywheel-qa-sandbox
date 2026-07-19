# FLY-1372 DAG 派单入口接线 — 调研

Issue: FLY-1372 (https://linear.app/geoforge3d/issue/FLY-1372/dag-接线派单入口-dag-引擎runsstart-加-dag-路由分支新单送进-workflowenginedispatcher)
日期: 2026-07-18
基于: exploration.md

## 1. 改动面盘点(逐文件、逐位点)

### 1.1 `packages/config/src/types.ts` — PipelineConfig 加键

`PipelineConfig`(286 行起)加:

```ts
/** FLY-1372: 项目级 DAG 派单灰度开关。absent → OFF(字节兼容)。 */
dag?: boolean;
```

### 1.2 `packages/config/src/ConfigLoader.ts` — pipeline 块校验

pipeline 块校验(407-446 行)镜像 `three_stage` 加:

```ts
if (pipeline.dag != null && typeof pipeline.dag !== "boolean") {
    throw new Error("pipeline.dag must be a boolean");
}
```

已验证:该校验器对未知键**只忽略不拒绝** → 老 Bridge 代码读到带 `dag: true` 的
config.yaml 不会炸(部署窗口安全)。

### 1.3 `packages/teamlead/src/bridge/three-stage-policy.ts` — 导出 label 常量

`NO_THREE_STAGE_LABEL`(72 行)目前是模块私有 const → 加 `export`,DAG 分支复用同一
字面量(不重复声明字符串)。

### 1.4 `packages/teamlead/src/bridge/runs-route.ts` — 问题⓪分支(核心)

现状路由骨架(行号为当前 main):

| 行 | 内容 |
|----|------|
| 694-700 | `normalizedIssueLabels` + `owningDept` |
| 702-726 | `templateCandidateInput` + `candidateSchemaAtEntry`(throw → 409 GENERALIZED_WORKFLOW_REJECTED) |
| 732-792 | 三段式 entry 块:`role === "main" && candidateSchemaAtEntry !== 2` → loadPipelineConfigByProject → resolveThreeStageEntry → entered 时 role=design/shareParentBranch=true/dispatch 三元组 + activePhase 409 |
| 794-824 | `resolveWorkflowTemplateSelection`(`allowSchemaV1Dispatch: role === "design" && shareParentBranch === true`, `idempotencyKey: requestedStartKey`) |
| 826-1132 | generalized 分支(engine-owned 物化 + launch 闸 + inline 派起始节点) |
| 1134 起 | legacy 分支(单段/三段式 design phase startDispatcher.start) |

**插入设计**(diff 语义,非最终代码):

a) 在三段式块**之前**(~730 行)计算 DAG 入口:

```ts
// FLY-1372: 问题⓪ — DAG dispatch entry.
let dagEntry = false;
if (
    role === "main" &&
    requestAuthKind === "master" &&
    candidateSchemaAtEntry !== null
) {
    const proj = projects.find((p) => p.projectName === projectName);
    const pipelineConfig = proj
        ? (await loadPipelineConfigByProject([proj])).get(projectName)
        : undefined;
    const dagBlock = workflowTemplateDispatchBlockReason(
        candidateSchemaAtEntry,
        process.env,
    );
    if (
        pipelineConfig?.dag === true &&
        dagBlock === undefined &&
        !normalizedIssueLabels.includes(NO_THREE_STAGE_LABEL)
    ) {
        if (requestedDesignBackend) → 400 DESIGN_BACKEND_NOT_APPLICABLE reason "dag_dispatch"
        const activePhase = store.getActivePhaseSessionForIssue(issueId);
        if (activePhase) → 409(复用三段式 activePhase 消息形态)
        dagEntry = true;
    }
}
```

pipelineConfig 加载会与三段式块重复一次 → 提升为共享变量(`mainPipelineConfig`),
两个块共用一次加载;非 main role 不加载(现状如此,保持)。

b) 三段式块守卫改为 `!dagEntry && role === "main" && candidateSchemaAtEntry !== 2`
(dagEntry 时整块跳过 → 不改写 role/shareParentBranch/dispatch 三元组)。

c) selection 调用(801-816 行)两处参数:

```ts
allowSchemaV1Dispatch: dagEntry || (role === "design" && shareParentBranch === true),
idempotencyKey: effectiveStartKey,   // = requestedStartKey ?? (dagEntry ? `dag-auto-${randomUUID()}` : undefined)
```

d) selection 之后 fail-closed 断言:

```ts
if (dagEntry && !generalizedSelection) → 409 { code: "DAG_ENTRY_NOT_MATERIALIZED", reason: "..." }
```

可达场景:candidateSchemaAtEntry 与 selection 之间 flag 被 flag console 动态翻
(flags 是 `toggleable: "direct"`,process.env 运行时可变)→ v1 门槛
`isWorkflowTemplateDispatchEnabled` 变 false → selection 返回 null。绝不静默回 legacy。

e) generalized 分支与 legacy 分支**零改动**。

### 1.5 `.flywheel/config.yaml` — flywheel 灰度落地

`pipeline:` 块加 `dag: true`(同 PR;GeoForge3D 等其它项目不动)。
`loadPipelineConfigByProject` 每请求从 canonical root 现读 → config 生效不需要重启,
代码生效需要一次 Bridge 重启(Annie 计划内)。

## 2. 关键机制核验(已做的事实检查)

| 事实 | 核验方式 |
|------|----------|
| 生产 binding 已齐:6 项目 `*` → tpl_eng_heavy | `~/.flywheel/teamlead.db` 只读查询 |
| tpl_eng_heavy rev1 schema v1,节点 design(claude/fable)→implement(codex/gpt-5.6-sol/xhigh)→qa(claude/opus) | `workflow_template_revision.manifest` |
| v1 静默降级两道闸 = allowSchemaV1Dispatch + idempotencyKey | `workflow-template-selection.ts:131-134` |
| `workflowTemplateDispatchBlockReason(1)` 查 dispatch+claims_write+claims_read;schema 2 多查 generalized | `workflow-template-dispatch.ts:24-37` |
| Lead 派单 = master `apiToken`(`tokenAuthMiddleware(apiToken, geminiAgentToken)`);gemini-agent = scoped | `plugin.ts:3447-3468` |
| generalized 分支不依赖外层 role/shareParentBranch(用 `node.type` 自算 workflowRole/shareParentBranch) | `runs-route.ts:1029-1041` |
| 入口 inline 派发与引擎 1s reconcile 由 launch-owner 闸单写者仲裁,无双跑 | `recoverOrAcquireWorkflowLaunch` 两处调用 |
| `getActiveWorkflowRunForIssue` hold:同 issue 二次 fresh 派单 → throw → 409 | `workflow-template-selection.ts:188-193` |
| 确定性 idempotencyKey 会撞 `getWorkflowStartResponse` 缓存(同 issue 二次派单永远吃到旧响应)→ 必须随机 | `runs-route.ts:827-833` |
| ConfigLoader pipeline 块忽略未知键 | `ConfigLoader.ts:407-446` 通读 |
| `getActivePhaseSessionForIssue` 覆盖 design/implement/qa × running/awaiting_review/approved_to_ship/design_done + pending-with-worktree | `StateStore.ts:3902-3919` |
| flags `toggleable: "direct"` → process.env 运行时可变,selection 需二次判定 → fail-closed 409 兜底 | `feature-flags/registry.ts:2717-2872` |

## 3. 测试面

### 3.1 现有 harness 惯例

`runs-route.stale-blocker.test.ts`:express + `createServer` + `listen(0)` + fetch,
fake store/dispatcher/admission(网络自由,Linear 预检前的分支可测)。DAG 入口分支在
Linear 预检**之后**(需要 labels),所以路由级测试需要 stub Linear —— 检查
`runs-route.founder-ux-exempt.test.ts` 如何处理(同样在预检后):它 mock `@linear/sdk`
(vitest `vi.mock`)。沿用。

### 3.2 单测矩阵(路由分支)

| # | 场景 | 期望 |
|---|------|------|
| 1 | flags ON + `pipeline.dag: true` + main + master | generalized 路径:selection 被调(allowSchemaV1Dispatch=true、synthesized key),startDispatcher.start 收到 `generalizedExecution.engineOwned=true`,三段式 entry 未触发 |
| 2 | 任一 DAG flag OFF | 三段式/单段现状路径,startDispatcher.start 参数形态与今天逐字节一致 |
| 3 | 项目无 `pipeline.dag` 键 | 同 2(byte-compat) |
| 4 | `pipeline.dag: true` 但 `no-three-stage` label | legacy 单段(label 也豁免三段式,现状行为) |
| 5 | scoped auth(geminiAgentToken) | legacy,不 throw master-auth 错 |
| 6 | `sessionRole: "qa"` | legacy(auto-QA 不受影响) |
| 7 | dagEntry + 显式 designBackend | 400 DESIGN_BACKEND_NOT_APPLICABLE reason=dag_dispatch |
| 8 | dagEntry + active phase session | 409,不物化 run |
| 9 | dagEntry + selection 返回 null(flag 翻转竞态,mock) | 409 DAG_ENTRY_NOT_MATERIALIZED,绝不落 legacy startDispatcher.start |
| 10 | ConfigLoader:`dag: true/false/absent/"yes"` | 前三者 load 通过(语义 on/off/off),字符串 throw |

字节兼容突变验证(记忆铁律:负向断言必须突变):#2/#3 断言用「与 main 现状同 fixture 的
期望快照」;临时把 dagEntry 谓词硬置 true 应使 #2/#3 变红(验尺子)。

### 3.3 集成冒烟(PR 内,vitest,真 StateStore)

真 `StateStore.create(":memory:")` + 种子模板/binding(复用 workflow-template.ts 的
bundled seed 函数)+ 4 flag env ON + fake startDispatcher(记录 generalizedExecution
并手动 `emitStarted` 等价写 session 行)→ POST /start → 断言:
- `workflow_run` 行 engine_owned=1、claims_read_enrolled=1;
- `workflow_claims` 出现行(claims_write 影子批);
- start reservation + side-effect(dispatch intent)行存在;
- 响应 `generalized: true` + workflowRunId/NodeId。

### 3.4 真机验收(merge + 重启后,Lead/独立 QA 侧)

issue 验收原文:派一张干净单 → `workflow_claims` 出行 + DAG 节点真跑 + founder thread
可见进展。Tadashi 已确认 PR 后手动派独立 QA(auto-spawn 关)。运行手册放 plan.md §5。

## 4. 明确不做

- 不删/不改三段式与单段 legacy 代码路径(退休另立清理单)。
- 不动 ship gate / founder-only-authority / approve_to_ship。
- 不改 `resolveWorkflowTemplateSelection` 的职责边界(仅路由层传参变化)。
- 不做 per-issue DAG opt-in label(项目级名单 + 4 flag 已是回退面;`no-three-stage`
  的豁免是复用既有语义,不是新 label)。
- 不动 gemini-agent / qa-framework 的 scoped 派单路径。
