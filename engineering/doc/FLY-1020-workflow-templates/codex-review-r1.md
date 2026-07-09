# Design Review — prd.md (Round 1)

Date: 2026-07-08
Author: Codex
Status: CHANGES REQUESTED

## Summary

方向可行：把现有 three-stage 从一套硬编码流程抽成默认可覆盖的模板层，符合当前架构的演进方向，也符合 default-off / canonical-root / fail-closed 的既有纪律。  
但当前 PRD 把「抽象现有 Design→Implement→QA」和「任意 per-category 动态 DAG 节点系统」合并成一个 MVP，低估了现有代码对 `design | implement | qa` 的持久化、展示、retry、turn-belt、post-ship finalization 和 QA ship-gate 绑定。按现 PRD 直接拆给 build 队列，容易漏掉生产生命周期面，结论是需要修改后再实现。

## What's Good (Keep)

- **default-off / byte-compat 方向正确。** `PipelineConfig` 当前明确 `three_stage` absent/false 都是 off，malformed pipeline load 要 fail loudly；这和 PRD 的上线纪律一致（`packages/config/src/types.ts:255`, `packages/config/src/types.ts:264`, `packages/config/src/ConfigLoader.ts:380`）。
- **canonical/mainline root 安全约束正确。** three-stage policy 明确要求 `pipelineConfig` 从 canonical root 读取，不能从实现 PR worktree 读取（`packages/teamlead/src/bridge/three-stage-policy.ts:21`）。auto-QA 也有同样约束（`packages/teamlead/src/bridge/auto-qa-policy.ts:17`）。
- **现状判断大体正确：今天没有 workflow template registry / taskCategory / skip / loop_when 这类通用模板机制。** 现有 `AgentDispatcher` 只是 label/default/shipped-generic 的 agent selection，不决定 workflow shape（`packages/edge-worker/src/AgentDispatcher.ts:3`, `packages/edge-worker/src/AgentDispatcher.ts:215`）。
- **把 FLY-939 QA fail fix-loop 抽成可声明 loop 是合理目标。** 现有 loop 已经有最大修复轮次、durable intent、head capture、wake-or-spawn、ghost guard、turn-belt 等成熟机制，可以作为模板 loop 的实现参考（`packages/teamlead/src/bridge/phase-orchestrator.ts:83`, `packages/teamlead/src/bridge/phase-orchestrator.ts:1087`）。
- **第三层 Markdown 技能不动是对的。** 这符合 founder 的红线：模板只管粗脚手架，不能把模型内部推理过程钉死。

## Issues & Recommendations

1. **MVP 声称支持任意节点类型，但当前系统不是泛型节点模型。**  
   现有 phase 类型、chat thread role、state queries、display、post-ship finalization 都硬编码到 `design | implement | qa`。`three-stage-phases.ts` 定义 `ThreeStagePhase = "design" | "implement" | "qa"` 和固定序列（`packages/config/src/three-stage-phases.ts:35`, `packages/config/src/three-stage-phases.ts:37`）；`StateStore` 的 `ChatThreadRole` 也是固定四值，phase query 只查 `IN ('design', 'implement', 'qa')`（`packages/teamlead/src/StateStore.ts:258`, `packages/teamlead/src/StateStore.ts:2576`）；issue display 直接从 `THREE_STAGE_PHASE_SEQUENCE` 渲染（`packages/teamlead/src/bridge/issue-display.ts:16`, `packages/teamlead/src/bridge/issue-display.ts:214`）；ship finalizer 只关闭 parked design/implement（`packages/teamlead/src/bridge/post-ship-finalization.ts:205`）。  
   **Suggested fix:** 二选一。更小的 MVP：只支持现有内建节点 `design/implement/qa` 的模板选择、skip、model override，把 `research/generate_video` 标为 post-MVP。若一定要支持任意节点类型，PRD 必须新增 schema/storage/display/finalizer/retry/worktree/thread-role 的泛化 build issue 和迁移策略。

2. **`three-stage-phases.ts` 的事实描述不完整。**  
   PRD 说它“今天只管 model/phase (`DEFAULT_PHASE_TIER`)”，但该文件还拥有 phase role 类型、固定序列、phase-role 判定、completion role preservation、next-phase 计算和 badge vocabulary（`packages/config/src/three-stage-phases.ts:35`, `packages/config/src/three-stage-phases.ts:48`, `packages/config/src/three-stage-phases.ts:77`, `packages/config/src/three-stage-phases.ts:107`, `packages/config/src/three-stage-phases.ts:113`）。这意味着“吸收为 registry 的 model 字段”不够，很多调用方依赖的不只是 model。  
   **Suggested fix:** PRD 要把 registry 范围改成：节点 id、顺序/edge、model、badge/display metadata、completion role preservation、phase-role discriminator、next-node resolver。否则只迁 `DEFAULT_PHASE_TIER` 会留下旧的 `THREE_STAGE_PHASE_SEQUENCE` 做事实上的真实编排。

3. **通用 loop 语义低估了 FLY-939 loop 的生产复杂度。**  
   现有 QA fail loop 不是一条简单 `qa -> implement` 边。它持久化 `three_stage_verdict` intent 以便 crash replay（`packages/teamlead/src/bridge/phase-orchestrator.ts:83`），有修复轮次上限（`packages/teamlead/src/bridge/phase-orchestrator.ts:993`, `packages/teamlead/src/bridge/phase-orchestrator.ts:1111`），必须先 capture QA head SHA（`packages/teamlead/src/bridge/phase-orchestrator.ts:1007`, `packages/teamlead/src/bridge/phase-orchestrator.ts:1122`），keep-alive 模式要 wake parked implement、校验 worktree readiness、grant TURN（`packages/teamlead/src/bridge/phase-orchestrator.ts:1140`, `packages/teamlead/src/bridge/phase-orchestrator.ts:1156`），还要 ghost-guard 防重复 writer（`packages/teamlead/src/bridge/phase-orchestrator.ts:1197`）。  
   **Suggested fix:** MVP loop spec 必须定义：条件来源、idempotency key、每条边 max iterations、round ledger、head capture/commit requirements、wake-vs-spawn 策略、TURN ownership、startup replay、failed wake 的 fail-closed 行为。更保守的实现是先只把现有 QA fail loop 配置化，不承诺 arbitrary loop edge。

4. **Auto-QA 收敛方案会破坏现有 ship-gate 语义，除非补完整迁移规则。**  
   当前 auto-QA 是 default-on opt-out，有 `FLYWHEEL_AUTO_QA=0`、`no-qa`、malformed off、`qa.auto:false`、`qa.skip_labels` 等优先级（`packages/teamlead/src/bridge/auto-qa-policy.ts:1`, `packages/teamlead/src/bridge/auto-qa-policy.ts:38`）。`onMainAwaitingReview` 在 policy off 时写 immutable `qa_required=0`，在 QA applies 时写 `qa_required=1`，ship gate 依赖这个快照（`packages/teamlead/src/bridge/auto-qa-coordinator.ts:390`, `packages/teamlead/src/bridge/auto-qa-coordinator.ts:424`）。它还 spawn 独立 QA issue，而 three-stage QA phase 是 parent issue shared branch 上的 writer，两者在 `event-route` 里靠 `chat_thread_role === 'qa'` 分流（`packages/teamlead/src/bridge/auto-qa-coordinator.ts:907`, `packages/teamlead/src/bridge/event-route.ts:535`）。  
   **Suggested fix:** PRD 要明确模板 QA 与独立 Auto-QA 的边界和 precedence：非模板单 session 是否仍走现有 auto-QA；templated internal QA 是否禁用独立 Auto-QA；product/no-QA 模板何时写 `qa_required=0`；`qa.auto`、`no-qa`、`skip_labels`、env kill-switch 如何与模板选择组合；startup backfill 如何识别模板免测（`packages/teamlead/src/bridge/auto-qa-coordinator.ts:1523`）。

5. **模板选择不能只“泛化 resolveThreeStageEntry / resolveThreeStagePolicy”；需要持久化 workflow snapshot。**  
   `resolveThreeStageEntry` 只处理 fresh `main` entry，explicit phase / auto-QA role 都 pass through（`packages/teamlead/src/bridge/three-stage-policy.ts:155`, `packages/teamlead/src/bridge/three-stage-policy.ts:166`），`runs-route` 也只在 fresh main 入口设置 `shareParentBranch` 和 phase model（`packages/teamlead/src/bridge/runs-route.ts:535`, `packages/teamlead/src/bridge/runs-route.ts:590`）。handoff 时又 live 读取 policy，disabled 会 fail closed（`packages/teamlead/src/bridge/phase-orchestrator.ts:739`）。retry path 则只看 durable `chat_thread_role`，重新 `resolvePhaseModel`，且明确尚未传播 `shareParentBranch`（`packages/teamlead/src/bridge/actions.ts:814`, `packages/teamlead/src/bridge/actions.ts:852`）。  
   **Suggested fix:** 入口选择模板后，应把 `workflow_template_id`、`workflow_template_version/hash`、当前 node id、node index/edge state 存到 session/issue 的 durable params。live kill-switch 可以继续阻止新的 dispatch，但图形状不要在中途根据 label/config drift 重新解析。handoff、retry、reconcile、finalization 都应读这个 snapshot。

6. **§12 拆分漏掉多个 production lifecycle sinks。**  
   `DirectEventSink` 和 HTTP `event-route` 是双入口，都会触发 auto-QA、phase handoff 和 turn-belt reconcile（`packages/teamlead/src/DirectEventSink.ts:748`, `packages/teamlead/src/DirectEventSink.ts:780`, `packages/teamlead/src/DirectEventSink.ts:916`, `packages/teamlead/src/bridge/event-route.ts:2035`, `packages/teamlead/src/bridge/event-route.ts:2052`）。FSM transition rejected 的 terminal path 也会专门跑 turn-belt recovery（`packages/teamlead/src/bridge/event-route.ts:1888`）。startup reconcile 还会重放 stranded design/implement 和 QA verdicts（`packages/teamlead/src/StateStore.ts:2413`, `packages/teamlead/src/StateStore.ts:2433`）。  
   **Suggested fix:** §12 增加一个 lifecycle workstream：DirectEventSink、event-route、startup reconcile、complete-marker drain、session_failed / transition-rejected path、TURN recovery、issue display refresh、post-ship finalization。否则只改 orchestrator 主路径会在 crash/retry/restart/dual-sink 时漏 dispatch 或重复 writer。

7. **Blueprint prompt/skills registry 的实现 seam 没说清楚。**  
   Blueprint 当前不是从“skills registry”生成行为，而是硬编码 `isDesignPhase` / `isImplementPhase` / `isQaPhase` 分支、land/PR block 排除、keep-alive park epilogue、QA PASS/FAIL command（`packages/edge-worker/src/Blueprint.ts:897`, `packages/edge-worker/src/Blueprint.ts:955`, `packages/edge-worker/src/Blueprint.ts:998`, `packages/edge-worker/src/Blueprint.ts:1041`, `packages/edge-worker/src/Blueprint.ts:1071`）。`AgentDispatcher` 只负责 label/default agent match，不负责按节点注入技能（`packages/edge-worker/src/AgentDispatcher.ts:215`）。  
   **Suggested fix:** 注册表字段不能只写 `{model, skills, prompt}`。至少还要定义节点 capability：是否 shared branch writer、是否创建 PR、是否可 ship、是否 approval gate holder、是否 needs review evidence、是否可 land、是否需要 mailbox transport、使用哪个 agent/skill injection path。否则 product/research/video 节点会拿错 legacy implement/land/approve gate 行为。

8. **配置 schema 和加载路径仍太模糊。**  
   `PipelineConfig` 当前只有 `three_stage` 和 `three_stage_channels`（`packages/config/src/types.ts:264`），`ConfigLoader` 只校验这个 shape（`packages/config/src/ConfigLoader.ts:380`）。PRD 说 YAML 模板和 node-type registry 从 canonical root 加载，但没定义文件路径、inline vs external refs、unknown key 策略、schema version、project-level override、malformed 时是 whole-bridge fail 还是 project fail-closed。另有一个既有文档漂移：`FlywheelConfig.qa` 注释仍写 absent off，但 `QaConfig` 和 policy 已经是 default-on（`packages/config/src/types.ts:616`, `packages/config/src/types.ts:228`）。  
   **Suggested fix:** 明确 schema，例如 `pipeline.workflow_templates.enabled`, `pipeline.workflow_templates.default`, `workflow_templates.files`, `node_type_registry.file`，并指定 canonical loader 的 tri-state behavior。顺手修正 `qa` 注释漂移，避免实现者照错默认值。

9. **§12 build issue 顺序需要调整。**  
   当前把 `node-type-registry.ts` 放第一步，但真正的先决条件是决定 MVP 范围和 durable shape。若不先处理 session role / chat thread role / display / retry / finalization 的泛化，registry 会变成一层新配置包着旧三段式硬编码。  
   **Suggested fix:** 建议顺序改为：  
   1. 明确 MVP scope：内建 phase-only 还是 arbitrary node；如 arbitrary，先做 schema/storage/display/finalizer/retry 泛化。  
   2. 模板/registry config schema + canonical loader + validation tests。  
   3. Entry 选择并持久化 workflow snapshot。  
   4. 将现有 phase table 迁入 registry，但保持 `design/implement/qa` byte-compat。  
   5. Orchestrator 按 snapshot 解释 sequence/skip，再迁现有 QA fail loop。  
   6. Auto-QA/ship-gate 与 internal QA phase 的边界迁移。  
   7. Blueprint prompt/capability registry。  
   8. shipped templates + reverse-compat sentinels。

10. **Scope/red-line 风险：现在的 PRD 容易把轻模板做成重 DSL。**  
    Founder 红线是 light/default/overridable，不约束更强模型。当前 YAML edges + registry prompts + skills + per-node model + skip + loop + future node types 已接近 workflow DSL，但 PRD 没明确哪些是 shipped defaults、哪些允许 project 自定义、哪些只由 Flywheel core 维护。  
    **Suggested fix:** MVP 限制为 core-shipped templates，project 只能选择/override/opt-out；不开放任意用户自定义节点；节点内部推理继续由 Markdown skill 和模型完成。把“创作视频”等新节点留作扩展样例，不作为本轮验收。

## Verdict

CHANGES REQUESTED — address items above before handing this PRD to Tadashi's build queue.
