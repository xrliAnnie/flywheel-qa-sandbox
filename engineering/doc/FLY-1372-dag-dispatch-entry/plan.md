# FLY-1372 DAG 派单入口接线 — 实施计划

Issue: FLY-1372 (https://linear.app/geoforge3d/issue/FLY-1372/dag-接线派单入口-dag-引擎runsstart-加-dag-路由分支新单送进-workflowenginedispatcher)
日期: 2026-07-18
基于: research.md
版本: v4(吸收 Codex design review R1 ×6 + R2 ×5 + R3 ×4;R2-5a pushback 被 Codex 接受)

## 0. 一句话

在 `/api/runs/start` 路由决策最前面加「问题⓪」分支:DAG flags ON(复用
`workflowTemplateDispatchBlockReason` fail-closed 谓词)+ 项目在 DAG 名单
(新 config 键 `pipeline.dag: true`)→ 新单走已有 generalized/engine-owned 路径进
DAG 引擎,不再进三段式/单段;flags OFF 或项目不在名单时现有路由字节不变。

Brainstorm gate:**GO**(Tadashi,A1/A2/A6 三存疑点全批)。
Codex design review:R1 ×6 + R2 ×5 → 逐项吸收(§7/§8 对照表)。
**Pilot 范围钉死:`pipeline.dag` 入口只接 schema-v1 候选**(生产 binding 全 v1);
schema-v2 保持今天的显式路径不动,v2 接入另立单(FLY-1020 epic 内)。

## 1. 目标 / 非目标

**目标**
1. flywheel 项目 fresh main 派单真正进 DAG:`workflow_run` engine_owned=1、
   起始节点按模板 spawn、后续节点由 `WorkflowEngineDispatcher` 推进、QA/review
   节点提交决策后 `workflow_claims` 出行(claims 在决策时写,非入口时写)。
2. 静默降级根治:DAG 名单选中 + flags ON 时任何"选不出/物化不了"都 409 机器可读,
   绝不无声回 legacy。
3. 可恢复:入口任一点崩溃/超时后,同一 issue 的重试收敛到同一 run/execution,
   最多 spawn 一次(reservation 恢复 + replay,见 §2.4)。
4. 回退面(修正后的可执行契约,§4):关 `workflow_template_dispatch`(canonical)
   或删 `pipeline.dag` 键即整体退回;claims_write/read 关闭同样阻断(谓词);
   `workflow_generalized_templates` 只管 schema v2,对 v1 模板不是回退杆。

**非目标**
- 不删/不改三段式与单段 legacy 路径(退休另立清理单)。
- 不动 ship gate / founder-only-authority / approve_to_ship 铁规。
- 不动 gemini-agent(scoped auth)与 qa-framework 派单路径。
- 不新建 per-issue DAG label(复用 `no-three-stage` 既有语义豁免)。
- 不把 Lead 的 `model` 参数映射进 per-category 模板选择(v2 再议;本 PR 按
  三段式 shipped 先例:模板/phase 表权威覆盖,见 §2.5)。

## 2. 设计(核心分支)

### 2.0 Entry provenance 标记(修 R3-1,P0)

`engine_owned` **不是**本入口的 provenance:StateStore 把它写成
`input.startReservation ? 1 : 0`,现网既有 schema-v2 显式派单与显式-key schema-v1
run 同样是 engine_owned=1 —— 用它当"第一问"会截获并改写这些既有 run 的 replay
行为(非 enroll 项目上直接 409 HELD,违反"不动 v2"承诺)。修法:

- `workflow_run` 加列 `entry_kind TEXT`(幂等 `ALTER TABLE ... ADD COLUMN` 迁移,
  沿用仓内既有 ADD COLUMN 模式);`materializeWorkflowRun` 接可选 `entryKind`,
  在**物化事务内**原子落 `entry_kind='pipeline_dag_v1'`。
- 只有 `pipeline.dag` fresh 入口传该值;既有 v2 / 显式 v1 路径不传 → 列为 NULL。
- §2.1 的"第一问"只认 `entry_kind='pipeline_dag_v1'` 的 active run;无标记的
  run(含部署前存量)完全落回今天的 replay/selection 路径。

### 2.1 权威控制顺序(单一无环,修 R2-1/R2-2/R3-1/R3-2)

**位置:`normalizedIssueLabels` 之后、`resolveWorkflowTemplateCandidateSchema`
(candidate preflight)之前**(修 R3-2:candidate resolver 在 current 模板损坏时
会 throw,恢复域必须先于它短路,pinned run 的恢复不受 current 模板状态影响)。
main + master 之外的请求整段跳过,零行为变化:

```
if (role !== "main" || requestAuthKind !== "master") → 跳过问题⓪(照旧)

mainPipelineConfig = loadPipelineConfigByProject(proj)      // 一次加载,与三段式块共用

// ── 第一问:这张 issue 有没有未完结的、entry_kind='pipeline_dag_v1' 的 DAG run?
dagRun = getActiveWorkflowRunForIssue(issueId) 且 entry_kind === 'pipeline_dag_v1'

if (dagRun):
    // 恢复/挂起领域 —— 绝不 legacy、绝不 fresh selection(修 R2-2 partial-run 撞车)
    reservation = getWorkflowStartReservationForRun(dagRun.run_id)   // 新只读 accessor
    if (!reservation) → 409 DAG_RUN_STATE_CORRUPT(active run 无 reservation,响亮)
    validateDagRequestParameters(req)                                 // 修 R3-4:共享校验
        // 显式 designBackend → 400(恢复域同样不许静默忽略,cache 之前);
        // agentName 无效 → 400 INVALID_AGENT_NAME(接受即校验,cache 之前)
    runSchema = parseWorkflowRunSnapshot(dagRun.snapshot).schema_version
    if (workflowTemplateDispatchBlockReason(runSchema, env) !== undefined
        || mainPipelineConfig?.dag !== true)
        → 409 ACTIVE_DAG_RUN_RECOVERY_HELD(回退窗口:不绕 kill switch 续跑,
          也不放 legacy 在残留 run 旁启动;运维先恢复配置或显式 finalize 该 run)
    if (requestedStartKey 且 ≠ reservation.idempotency_key)
        → 走普通 selection(既有 payload-mismatch/hold 语义,响亮)
    // keyless 或 key 相符 → 恢复重放:不重新解析当前 binding/revision(修 R2-2a)
    activePhase 防撞:activePhase && activePhase.execution_id !== reservation.execution_id
        → 409 already-active(successor 在跑);相等 → 放行(重放豁免,修 R1-2)
    dagSelection = recoverWorkflowStartSelection(store, {issueId, projectName, authKind})
        // 新函数(workflow-template-selection.ts 内):由 run + reservation + pinned
        // snapshot 直接构造 replayed selection;校验 run.project_name 与请求一致、
        // master auth、run active、start node 存在。绝不看当前 binding/candidate。
    → 进入既有 generalized 分支(priorResponse 缓存 / admission idempotentReplay /
      launch recoverOrAcquire(acquired|committed|busy|repair)/ delivery 等待 / 记录响应)

// ── 无标记 run(含既有 v2 / 显式 v1 / 部署前存量)→ 从这里起与今天逐字节一致,
//    仅当 fresh 政策命中才分叉:
else if (mainPipelineConfig?.dag === true
         && !normalizedIssueLabels.includes(NO_THREE_STAGE_LABEL)):
    // fresh 领域:仅置 dagPolicySelected=true;candidate 解析仍用既有唯一调用位置
    // (紧随本块之后的 resolveWorkflowTemplateCandidateSchema,不动、不重复调用),
    // fresh 域检查读取其结果。resolver 对损坏 current 模板 throw → 既有 409
    // GENERALIZED_WORKFLOW_REJECTED(fresh 域可接受,恢复域已在其之前短路,修 R3-2)
    dagBlock = workflowTemplateDispatchBlockReason(candidateSchemaAtEntry ?? 1, env)
    if (dagBlock) → legacy(flags OFF = 授权回退杆,字节兼容)
    elif (candidateSchemaAtEntry === null)
        → 409 DAG_TEMPLATE_CANDIDATE_MISSING(binding/模板被删=配置损坏,绝不静默)
    elif (candidateSchemaAtEntry !== 1)
        → 照旧落到既有 selection 路径(v2 显式派单语义不变;pilot 范围 v1-only)
    else:
        validateDagRequestParameters(req)      // 同一共享校验(修 R3-4)
        activePhase 非空(此时必为旧 parked legacy phase)→ 409(A7)
        effectiveStartKey = requestedStartKey ?? `dag-auto-${randomUUID()}`
        dagEntry = true → selection(allowSchemaV1Dispatch=true, entryKind='pipeline_dag_v1')
                        → generalized 分支
```

要点:
- **恢复与 fresh 是互斥的两条权威路径**:恢复只信 pinned snapshot + reservation,
  binding 删除/rebind/revision 前移/auto-resolve Lead 变化、乃至 current binding
  指向缺失/未发布/损坏模板,都不影响收敛(修 R2-2a/R3-2);fresh 才解析当前
  candidate 并承担 candidate-missing 409。
- **回退窗口防撞**:标记 run 存在而 flags/config 已关 → 409 HELD,legacy 永不在
  残留 run 旁启动(修 R2-2b);无标记 run 的项目/existing v2 行为零变化(修 R3-1)。
- `validateDagRequestParameters`(无状态,修 R3-4):fresh 与恢复两域、在任何
  cache/selection 之前统一执行 —— designBackend → 400 `dag_dispatch`;
  agentName 无效 → 400 `INVALID_AGENT_NAME`(legacy 路径的校验位置不动)。
- 早段通用 `alreadyActive` guard(role=main 会话)对 v1 DAG 无影响(v1 模板节点
  role 均为 design/implement/qa,不产生 main 会话);v2 交互由 v1-only 范围排除。

### 2.2 三段式块守卫

`!dagEntry && role === "main" && candidateSchemaAtEntry !== 2`(dagEntry / 恢复
路径直接短路,不进三段式块,不改写 role/shareParentBranch/dispatch 三元组)。

### 2.4 launch lease 与恢复 SLO(修 R2-3)

`recoverOrAcquireWorkflowLaunch` 对未过期的他人 lease 返回 `busy` → route 回
`GENERALIZED_LAUNCH_HELD` 409(既有行为)。崩溃恢复的诚实时序:

- **lease 内**(≤60min):keyless 重试收敛到同一 execution 的 **typed 409**
  (`GENERALIZED_LAUNCH_HELD`),不是 200 —— 这是既有 generalized 启动协议的
  设计属性,本 PR 不新造 owner-death takeover(那是 launch-owner 协议自身的
  follow-up,与入口无关)。
- **lease 过期后**:重试经 recover 路径拿新 generation → 收敛 200。
- 崩溃矩阵按此写**两条**断言:in-lease → typed 409;推进 store 时钟越过 lease →
  同一 execution 收敛。runbook §5 加运维注:pre-commit 崩溃的恢复窗 ≤ 60min,
  可等或显式 finalize。

### 2.5 请求参数契约:模板权威 + 显式回显 + 持久化(修 R1-3,P0)

Lead 共享规则要求每次派单显式传 `model`(难度分拣)与 `agentName`(executor 路由)
→ DAG 分支 400 拒这两个参数会系统性打断 flywheel 全部派单(在跑 Lead 不重启不重读
规则)。而 **shipped 先例已存在**:三段式 entry 的 `dispatchModel` 今天就"无条件
覆盖 difficulty-sorter pin"(three-stage-policy.ts resolveThreeStageEntry 文档原文,
phase-model sovereignty)。DAG = 同一语义的模板化延续。故:

- `model` / `agentName`:**接受、校验、持久化(审计)、模板权威覆盖、响应显式回显**
  —— 不 400、不静默。响应(200 与 202 一致,修 R2-5)加
  `templateAuthority: { overrode: ["model","agentName"] }`(按实际传入构建);
  Bridge log 一行。`designBackend` 维持 400(brainstorm gate 已批的 A6;它是
  three-stage-entry 专属参数,规则并不要求常传)。
- `ponytail`:**不是模板权威覆盖对象**(schema-v1 manifest 节点只有
  vendor/model/effort/handoff,不存在可"钉"的 ponytail 值,R2-5b 属实)——
  处置 = 与 legacy 完全同构:入口把 `ponytailInput`(run-param + labels +
  labelStatus,同一构建逻辑抽 helper)传进 generalized start,Blueprint 按既有
  阶梯解析,ponytail 相关字段经既有 emitStarted seam 持久化;不进 `overrode`
  列表;invalid 值同 legacy(视为无 override)。引擎 successor 不传
  run-param(与三段式 handoff 现状一致)。
- **回显/审计的 replay 语义**(修 R2-5a,部分采纳):`templateAuthority` 是
  **request-scoped advisory**,durable authority 是 pinned run snapshot 本身
  (template/revision/node dispatch,已持久化)。replay/缓存响应按既有语义返回
  **原请求**的缓存 payload(与 executionId 等字段同一待遇);审计字段
  (dispatch_model/agent_name)只在 fresh(`replayed === false`)路径写入,
  重试参数不覆盖原值。不为此新建 request-snapshot 存储 —— 影响执行的参数要么被
  模板权威覆盖(model/agentName)要么走既有持久化(ponytail/docTier),
  reservation digest 已绑定选择语义;新增快照表属超范围,明示推回。
- `agentName`:沿用入口边界的同步校验(unknown → 400 INVALID_AGENT_NAME,
  DAG 路径在 selection 前做同一校验,legacy 路径校验位置不动保字节序);值记入
  session 元数据(`agent_match_method` 的取值实现期 grep 消费方后定,倾向新值
  `dag_template` 以免谎报 `override`)。
- 同 PR 更新 `lead-rules-base/model-routing.md` + `executor-routing.md` 各加一小段:
  DAG-enrolled 项目下模板钉 per-node vendor/model/agent,`model`/`agentName` 会被
  显式回显覆盖(未来 Lead 会话生效;在跑 Lead 不需要变更行为——参数照传,无害)。

**会话元数据补账(P0 的另一半;R2-4 修订为 durable seam,不再用 post-start patch)**:
generalized early-return 目前跳过 legacy 分支的 `patchSessionMetadata`,
`codex_skip / founder_facing_ux / doc_tier / issue_url / dispatch_model` 全不落库,
引擎后继节点又靠"从 predecessor session 复制"传播 → design 之后全丢、founder-UX
gate 误读。v2 的"start+delivery 后 patch"不是崩溃收敛的(引擎 consume 的
session-exists / node-done 快路径在 patch 点之前就 markStarted 返回)→ 改走
**session 创建时的 durable seam**(Codex R2-4 方案 i):

1. **字段分级**:
   - **行为字段**(doc_tier / issue_url / codex_skip / founder_facing_ux)——
     随 `StartRequest → BlueprintContext → EventEnvelope → emitStarted upsert`
     在 session 行创建的同一时刻落库(行存在 ⟺ 字段存在,崩溃收敛 by construction;
     快路径无需 backfill —— 快路径看到的 session 本来就是带字段创建的)。
     `StartRequest`/envelope/sink 各加可选 `founderFacingUx`;sink 只在字段
     defined 时写列(undefined 不touch → 其它调用方字节兼容)。
   - **审计字段**(dispatch_model / agent_name)—— 入口 route 在 fresh(非 replay)
     路径 best-effort patch;崩溃窗口只丢审计回显不丢行为,明示接受。
   - **信任边界(修 R3-3,P1)**:这些是 **Bridge 服务端计算的行为字段**,seam
     定义为 **Bridge-trusted、direct-only**:仅 `generalizedExecution.engineOwned`
     的启动路径把它们放进 envelope/context,且只有 Bridge-local `DirectEventSink`
     持久化;`TeamLeadClient.emitStarted`(HTTP)**不发送**这些字段,`/events`
     ingest 对同名 runner payload 字段**一律忽略**(runner ingest token 不能承载
     Bridge authority —— 与 ExecutionEventEmitter 既有注释同一红线,注释锁定)。
     HTTP generalized start 若未来出现,须另设 server-bound 可信通道,不在本单。
     spoof 测试:HTTP /events 带 `founderFacingUx:false` 不得清除/改写服务端值。
   - **flags-OFF 时序守护(修 R3-3b)**:envelope 字段注入条件挂在
     `generalizedExecutionContext` 存在上 —— legacy(flags OFF / 未 enroll)
     session 的字段仍由既有 route patch 在既有时点写入,持久化时序逐字节不变;
     时序回归测试固定之。
   - **StateStore 写方收口(修 R4-1,P0)**:`DirectEventSink.emitStarted` 经
     `StateStore.upsertSession()` 写行,但该方法的固定 INSERT/UPSERT 列清单
     只含 `doc_tier`/`issue_url`,**漏 `codex_skip` 与 `founder_facing_ux`**
     (两者虽在 `SessionUpsert` 类型上,却被 SQL 静默丢弃)—— 只改 envelope/sink
     对象等于没改。M1 必须扩 `upsertSession()` 在**同一事务**内持久化全部四个
     行为字段,禁止任何 post-upsert 补写。冲突语义(两列 `NOT NULL DEFAULT 0`):
     - 入参 `undefined` → **不触碰**既有列值(UPSERT 的 SET 子句按需构建或
       COALESCE 保旧值,绝不用 DEFAULT 覆盖);
     - 显式 `false`/`0` → 可表达、可写入(与 undefined 区分);
     - Runner 自declare 抬高的 `founder_facing_ux=1` **绝不被重复 emitStarted
       upsert 降级**(重复 started 事件的入参对该列取 max/保高语义)。
     测试:fresh insert 落全四列;对既有行的冲突 upsert 不覆盖已有值;founder
     自declare 后重复 emitStarted 不降级;构造上不存在"行已建、字段另写"的
     崩溃切面(单事务)。
2. 调用方传显式 effective 值:DAG 入口 start 调用传 `docTier: docTier ?? "full"`
   + `founderFacingUx`(computed helper 与 legacy 共用,legacy 调用位置不动);
   引擎 successor start 已传 predecessor 的 doc_tier/issue_url/codex_skip,
   补传 founder_facing_ux —— 全部经同一 seam 持久化,hop-2(qa)不再丢。
3. legacy 分支的既有 route patch 原样保留(与 seam 写入值相同,幂等覆盖,字节兼容)。
4. 崩溃切面测试:entry emitStarted 后立即断言行为字段在行上(无需等 route patch);
   successor session 创建后同断言;重启 reconcile(快路径)后三跳字段仍完整。
   注:部署前由旧代码创建的存量 session 行无这些列值,pilot 全新单起步,明示接受。

### 2.6 selection 传参与 fail-closed 断言

- `allowSchemaV1Dispatch: dagEntry || (role === "design" && shareParentBranch === true)`
- `idempotencyKey: effectiveStartKey`(§2.1 fresh 路径;恢复路径不走普通 selection,
  由 `recoverWorkflowStartSelection` 直接给出 replayed selection)
- selection 之后:`if (dagEntry && !generalizedSelection)` → 409
  `DAG_ENTRY_NOT_MATERIALIZED`(可达:flags `toggleable:"direct"`,schema 判定与
  selection 之间被 flag console 翻掉;绝不静默 legacy)。
- generalized 分支主体与 legacy 分支不动(除 §2.5 的审计 patch、响应回显字段与
  `ponytailInput`/`founderFacingUx`/effective `docTier` 的 start 传参)。

## 3. 测试计划(TDD:先红后绿)

新文件 `packages/teamlead/src/bridge/__tests__/runs-route.dag-entry.test.ts`
(harness 沿用 stale-blocker 惯例:express + listen(0) + fetch;`vi.mock("@linear/sdk")`;
fake admission 放行)。**fake startDispatcher 必须模拟真实收敛面**:创建 session 行 +
调用 `generalizedExecution.commitWorkflowLaunch`(否则 route 等 delivery 只会回
202/500,测不到 200 主路径);另单独覆盖不 commit 的 202 accepted-pending 分支。

### 3.1 路由矩阵

| # | 场景 | 期望 |
|---|------|------|
| 1 | flags ON + dag:true + main + master | generalized 200:start 收到 engineOwned generalizedExecution;三段式 entry 不触发 |
| 2 | 3 个 v1 flag 逐个 OFF | legacy 现状路径(startDispatcher.start 参数形态与 main 一致) |
| 2b | `workflow_generalized_templates` OFF(其余 ON) | v1 模板照进 DAG(契约显式化:该 flag 不是 v1 回退杆) |
| 3 | 无 `pipeline.dag` 键 | 同 2(byte-compat) |
| 4 | dag:true + `no-three-stage` label | legacy 单段 |
| 5 | scoped auth | legacy,无 master-auth throw |
| 6 | role=qa | legacy(auto-QA 不受影响) |
| 7 | dagEntry + 显式 designBackend | 400 reason=dag_dispatch |
| 8 | dagEntry + active **legacy** phase(无 engine run) | 409,零物化 |
| 8b | dagEntry + 起始节点 session 已落库 + 恢复 key 重试 | 放行 → replay → 同一响应,无 second run |
| 8c | dagEntry + run 进行中(successor phase active) | 409 already-active |
| 9 | dagEntry + selection null(注入 flag 翻转) | 409 DAG_ENTRY_NOT_MATERIALIZED,start 零调用 |
| 9b | dagPolicySelected + flags ON + binding 缺失 | 409 DAG_TEMPLATE_CANDIDATE_MISSING(初次解析即缺,非仅两次解析间变化) |
| 9c | dagPolicySelected + flags OFF + binding 缺失 | legacy(候选缺失 409 不得越过 flag 回退杆) |
| 10 | 显式 model/agentName + dagEntry | 200 + `templateAuthority.overrode` 回显;审计元数据落 dispatch_model/agent_name(fresh-only) |
| 10b | 202 accepted-pending 路径 | 202 同样带 `templateAuthority` 回显 |
| 10c | keyless 重试改参(model 变)命中 replay | 返回原缓存响应;审计元数据不被重试覆盖 |
| 10d | ponytail run-param + dagEntry | `ponytailInput` 传入 start(与 legacy 同构),不在 overrode;invalid 值同 legacy 忽略 |
| 11 | ConfigLoader `dag` true/false/absent/"yes" | 前三过、串 throw(config 包测试) |
| 12 | 标记 run(entry_kind=pipeline_dag_v1)+ flags/config 已关(keyless 与显式 key 各一) | 409 ACTIVE_DAG_RUN_RECOVERY_HELD,零 legacy start、零物化 |
| 12b | 标记 run + binding 删除 / 同 schema rebind / revision 前移 / auto-resolve Lead 变化 | keyless 恢复照常收敛(恢复不看当前 candidate) |
| 12c | 标记 run + reservation 缺失(构造损坏) | 409 DAG_RUN_STATE_CORRUPT |
| 12d | 非 engine_owned 的 active run(claims-enrolled 三段式) | 不触发恢复路径,现状行为 |
| 12e | 标记 run + current binding 指向缺失模板 / 无 published revision / 损坏 schema | keyless 恢复从 pinned snapshot 收敛,current candidate 完全不被读(修 R3-2) |
| 12f | 恢复域 + 显式 designBackend | 400 dag_dispatch(恢复域不静默忽略,cache 之前;修 R3-4) |
| 12g | 恢复域 + 无效 agentName | 400 INVALID_AGENT_NAME(cache 之前;修 R3-4) |
| 13 | v2 候选 + dag:true | 落既有 selection 路径(v1-only 范围),行为与今天一致 |
| 14 | **无标记** active v2 run(engine_owned=1)+ dag absent / dag:true,显式 key replay | 与今天逐字节一致,绝不被恢复域截获(修 R3-1) |
| 14b | 部署前存量 v1 engine-owned run(无标记)+ dag absent | 不被新 domain 截获,现状行为(修 R3-1) |
| 14c | HTTP /events spoof:runner payload 带 founderFacingUx:false | 服务端值不被清除/改写(修 R3-3) |
| 14d | flags-OFF legacy start 持久化时序 | session 行创建时无 seam 字段,route patch 在既有时点写入(时序回归,修 R3-3b) |
| 15 | upsertSession fresh insert(四行为字段各 defined/undefined/false 组合) | 同一事务落列;undefined 不落 DEFAULT 覆盖语义(修 R4-1) |
| 15b | upsertSession 冲突(行已存在,入参 undefined) | 既有列值不被触碰 |
| 15c | founder self-declare(founder_facing_ux=1)后重复 emitStarted | 不降级(保高语义) |

**崩溃收敛矩阵(§2.1/§2.4)**:真 `StateStore.create(":memory:")`,在物化后 /
admission 后 / launch commit 前 / commit 后 / response 前各注入一次"断"(fake
dispatcher 抛错或跳过 commit),随后无 key 重试:
- commit 前之外的切面 → 收敛同一 run/execution、session 至多一个、最终响应一致;
- **launch commit 前切面**(修 R2-3):lease 内重试 → typed 409
  `GENERALIZED_LAUNCH_HELD`(同一 execution);推进 store 时钟越过 60min lease →
  新 generation 收敛 200。busy/hold 不从状态图省略。

**元数据连续性(durable seam,修 R2-4)**:entry emitStarted 落行即断言行为字段
(codex_skip/founder_facing_ux/doc_tier/issue_url)在 session 行上(不依赖后置
patch);successor session 创建即同断言(design→implement→qa 三跳);重启
reconcile 走 session-exists 快路径后字段仍完整;审计字段(dispatch_model/
agent_name)fresh 路径落、replay 不覆盖。

**突变验证**(负向断言铁律):#2/#3 的"与现状一致"断言,以临时硬置 dagEntry=true
的突变必须变红为证(实现期做一次,记录在 PR test plan,不留突变代码)。

**集成冒烟**(真 StateStore + bundled seed + 4 flag env ON → POST /start)断言
**入口时刻真实 durable facts**(修 R1-5,不再断言入口即有 claims/side-effect):
- `workflow_run` 行 active、engine_owned=1、claims_read_enrolled=1;
- `workflow_start_reservation` + start stage 行;
- execution binding/runtime 行(admission 产物);
- launch owner committed(delivery 达成);
- session 行 + 响应 `generalized: true` + workflowRunId/NodeId。
claims 行断言放在决策提交后(QA/review 节点 decision);successor dispatch intent
断言放在 design transition 后 —— 两者属真机 pilot / 引擎既有测试面,不属入口冒烟。

**回归**:`pnpm --filter flywheel-teamlead test` + `pnpm --filter flywheel-config test`
(目标包单独跑,不以 `pnpm -r` 退出码作证据)+ 全仓 `pnpm lint`。

## 4. 部署 / 回退(修 R1-6:可执行契约)

- 生效 = merge → 生产 canonical root `git pull` + **一次 Bridge 重启**。config.yaml
  每请求现读,键先落地无害(老代码忽略未知键,已验证)。
- **回退杆(实现期实测后再修正一版——按 shipped 真值表陈述)**:
  1. canonical:`flywheel-comm feature-flags apply --name workflow_template_dispatch --to off`
     (直接生效,不用重启)→ **字节回退 legacy**;
  2. 或删 `.flywheel/config.yaml` 的 `pipeline.dag` 键(下一请求生效)→ 同上;
  3. `workflow_claims_write` / `workflow_claims_read` 单独关(dispatch 仍开)=
     FLY-1307 既有 fail-closed 真值表:**候选项目的派单 409,不是回落 legacy**
     (实现期测试 #2 实证;这是"停世界"急停杆,不是灰度回退杆——本 PR 不改该
     既有语义,回退用 1/2);
  4. **`workflow_generalized_templates` 不是 v1 回退杆**(只 gate schema v2)——
     运行手册、flag console 备注与测试 #2b 三处一致陈述,不再写"任一 4 flag"。

## 5. 真机验收 runbook(merge + 重启后,独立 QA / Lead)

1. 前置:`flywheel-comm feature-flags` 确认 `workflow_template_dispatch` +
   `workflow_claims_write` + `workflow_claims_read` ON;Bridge 从含本 PR 的 main 跑;
   `.flywheel/config.yaml` 含 `pipeline.dag: true`。
2. 派一张干净 flywheel 单(无 no-three-stage label、无活跃会话/workflow run)。
3. **入口断言**(ground-truth,不信自报):
   - `sqlite3 ~/.flywheel/teamlead.db "SELECT engine_owned,status,claims_read_enrolled FROM workflow_run WHERE issue_id='<id>'"` → `1|active|1`;
   - `workflow_start_reservation` 有该 run 行;session 行存在且带 generalized 绑定;
   - Bridge log 无 enteredThreeStage、有 generalized 派发行。
4. **过程断言**(pilot 跑到位):design 节点完成 → successor dispatch intent 出现、
   implement 节点 spawn(引擎驱动);QA/review 决策提交后 `workflow_claims` 出行
   (Annie 验收句"workflow_claims 出现行"在此兑现——决策时写,非入口时写);
   founder 在 [FLY-XX] thread 看到进展。
5. 对照:GeoForge3D 派一张单走现状路径(零变化)。
6. 回退演练(可选):flag OFF 再派一张 → 走 legacy,现状不变。
7. 运维注(修 R2-3):入口若在 launch commit 前崩溃,重试在 60min lease 窗口内
   会得到 typed 409 `GENERALIZED_LAUNCH_HELD`(不是故障,是单写者闸)——可等
   lease 过期自动收敛,或显式 finalize 该 run。回退窗口若见
   `ACTIVE_DAG_RUN_RECOVERY_HELD`:先恢复 flag/config 让 run 收敛,或显式
   finalize/terminate 该 run 再走 legacy。

## 6. 里程碑

1. M1:C1-C3(config 层 + 常量导出)+ StateStore accessor
   (`getWorkflowStartReservationForRun`)+ `entry_kind` 幂等迁移与物化写入
   + `upsertSession()` 四行为字段单事务收口(R4-1 冲突语义)+ 测试 #11/#15-15c
   —— 红→绿。
2. M2:C4 路由分支(§2.0/2.1/2.2/2.6)+ `recoverWorkflowStartSelection` +
   `validateDagRequestParameters` + 矩阵 #1-#14d + 崩溃收敛矩阵 —— 红→绿 + 突变验证。
3. M3:durable seam(StartRequest/envelope/sink 行为字段)+ 引擎 successor
   founder_facing_ux 补传 + 元数据连续性测试 + 集成冒烟 + C5 config.yaml +
   Lead-rules 两处小段 + 全仓 lint/test。
4. M4:PR + Codex code review(xhigh)→ 独立 QA(Tadashi 手动派)→ approve gate。

## 7. Codex R1 吸收对照

| R1 项 | 处置 |
|-------|------|
| 1 P0 随机键不可恢复 | 采纳方案 A:reservation 恢复 + replay 收敛(§2.1 恢复域)+ 新只读 accessor + 崩溃切面矩阵 |
| 2 P0 active-phase 409 破坏重放 | 采纳:replay 豁免镜像 exactSchemaV1Replay(§2.1 恢复域防撞行),8b/8c 入测试 |
| 3 P0 参数/元数据契约丢失 | 采纳(方向按 shipped 三段式先例调整):模板权威 + 回显 + 持久化 + helper 复用 + 引擎 successor 传播(§2.5);designBackend 维持 400(gate 已批 A6) |
| 4 P1 候选缺失静默 legacy | 采纳:两段式判定,DAG_TEMPLATE_CANDIDATE_MISSING 409,flags OFF 优先保字节兼容(§2.1,#9b/#9c) |
| 5 P1 断言与事实不符 | 采纳:入口冒烟改断真实 durable facts;claims/side-effect 断言移到决策/transition 时点;fake dispatcher 模拟 commit + session;202 单测(§3、§5) |
| 6 P1 回退文案错误 | 采纳:回退契约改为 canonical flag / config 键;generalized 非 v1 回退杆,#2b 显式化(§4) |

## 8. Codex R2 吸收对照

| R2 项 | 处置 |
|-------|------|
| 1 P0 控制顺序成环 + keyless-v2 与 alreadyActive 冲突 | 采纳:§2.1 重写为单一无环权威顺序(activeEngineRun 分类 → 恢复/挂起 vs fresh);pilot 钉死 v1-only,v2 保持既有显式路径,消除 alreadyActive 交互(#13) |
| 2 P0 恢复重信当前 candidate + 回退窗口 legacy 撞残留 run | 采纳:新 `recoverWorkflowStartSelection` 由 run+reservation+pinned snapshot 直接构造 replay,不看当前 binding(#12b);flags/config 关 + active run → 409 `ACTIVE_DAG_RUN_RECOVERY_HELD`,零 legacy start(#12);reservation 缺失 → `DAG_RUN_STATE_CORRUPT`(#12c) |
| 3 P1 launch lease 60min 窗口 | 采纳(文档化+测试,不新造 takeover):崩溃矩阵拆 in-lease typed 409 / lease 过期收敛两断言;runbook 运维注(§2.4、§3、§5) |
| 4 P0 post-start patch 非崩溃收敛 | 采纳方案 i:行为字段走 emitStarted durable seam(行存在⟺字段存在,快路径免 backfill);审计字段 best-effort 明示分级;崩溃切面 + 快路径测试(§2.5、§3) |
| 5 P1 参数未绑 reservation + ponytail 无模板权威 | 部分采纳:ponytail 改为与 legacy 同构传 `ponytailInput`(不称模板权威,#10d);202 回显对齐(#10b);审计 fresh-only + replay 返原缓存(#10c);**推回**新建 request-snapshot 存储 —— durable authority = pinned run snapshot,回显定位为 request-scoped advisory(§2.5)。**R3 裁定:pushback 被 Codex 明确接受,不扩范围** |

## 9. Codex R3 吸收对照

| R3 项 | 处置 |
|-------|------|
| 1 P0 engine_owned 非 provenance,截获既有 v2/显式 v1 replay | 采纳:新 `workflow_run.entry_kind='pipeline_dag_v1'` 列(幂等 ADD COLUMN,物化事务内原子落),恢复域只认标记 run;无标记(含部署前存量)零变化(§2.0,#14/#14b/#12) |
| 2 P0 恢复域被 current-candidate preflight 的 throw 挡住 | 采纳:恢复域移到 `resolveWorkflowTemplateCandidateSchema` **之前**短路;只有 fresh 域消费 candidate 解析(位置不动不重复);current 模板损坏三态入测(§2.1,#12e) |
| 3 P1 seam 信任边界 + flags-OFF 时序 | 采纳:seam 定义为 Bridge-trusted direct-only(仅 engineOwned 路径入 envelope、仅 DirectEventSink 持久化、TeamLeadClient 不发送、/events 忽略同名 runner 字段+注释锁线);spoof 测试 #14c;flags-OFF 持久化时序回归 #14d(§2.5) |
| 4 P1 恢复域参数校验缺失 + 过期交叉引用 | 采纳:无状态 `validateDagRequestParameters` fresh/恢复两域 cache 前共调(designBackend 400 / 无效 agentName 400,#12f/#12g);§7 过期引用已修 |
