# FLY-1307 子单D：注册表迁移 + orchestrator 按 snapshot 解释 + 模板派发启用 — 探索

Issue: FLY-1307 (https://linear.app/geoforge3d/issue/FLY-1307/build-dag-模板引擎-子单d原-收尾注册表迁移-orchestrator-按-snapshot-解释-模板派发启用)
日期: 2026-07-16
基于: 无（上游 spec = engineering/doc/FLY-1135-layer1-dag-templates/plan.md v1.35，Codex APPROVED，权威不重开）

## 1. 任务定位

FLY-1135 伞单（Layer-1 per-task-category DAG 模板）链条最后一片 = 伞单 plan §3.2 的 **PR-7 + PR-8**。
本 design 段按 issue 工程约束 3 执行**轻量模式**：伞单 plan 已 4 轮 Codex design review 过审，
本段只做「增量核对（A/B/C 实际落地 vs plan 假设）+ 切片确认（PR 怎么切、验收怎么映射）」，
**不重写、不重开任何伞单已定设计**。

## 2. 前置交付（增量核对结论 — 全部已在 main，只消费不重造）

| 子单 | 原切片 | PR | 落地要点 |
|---|---|---|---|
| A = FLY-1232 | PR-1+2 | #578 | claims 账本 substrate（workflow_claims / decision_capability / run / run_node / run_event / claim_revocation + execution_binding）、单事务提交、shadow writer 并写生产者、派发 outbox（launch-claims 对账）、typed cutover 标记 |
| B = FLY-1244 | PR-3+4+5 | #593 | founder guard 收口、claims 读切换（红测变绿；claims_read flag + workflow_run.claims_read_enrolled 显式 enrollment 列）、CommDB source outbox（workflow_source_event + turn_source_history，StateStore 侧 workflow_source_receipt/deadletter/cursor projector）、模板 schema v1 + 发布契约（template/revision/publication/category_binding/audit 五表）+ eng 三档种子 |
| C = FLY-1281 | PR-6 | #613 | manifest schema v2（generic/review、node_done/review_pass、review_fail loop）、node-type-registry（6 条目 + capability 闭集）、node-id 生命周期 8 面、统一泛化 admission（admitGeneralizedWorkflowExecution）、output/completion 终局权威（workflow_node_outputs/output_current/output_credential/node_completion）、start reservation/re-drive 状态机（start_reservation/start_stage/start_response/launch_owner fence）、选择解析接线 /api/runs/start（GeneralizedExecutionContext 内部传递）、3 份 v2 种子、Blueprint capability 门控 |

C 的 QA 曾报 1 HIGH（generalized 节点仍收 legacy ship tail 指令）——已修在 main
（Blueprint.ts 全量 isGeneralizedExecution 门控），随 #613 合入。核对完毕，无未落承诺。

## 3. D 的边界（C→D 交接点，来自 FLY-1281 plan §1 显式「不做」清单）

C 留给 D 的显式接口点（代码里都是 fail-closed 拒绝口，D 来打开）：

1. **注册表全职责迁移** —— node-type-registry 与 three-stage-phases.ts 双真相源窗口收口
   （1281 风险#3 点名「D 收口」；今天 legacy 路径不消费 registry，只有 reverse-compat sentinel 断言两边一致）。
2. **orchestrator 边解释 / 后继派发** —— C 的 admission「拒绝任何后继节点」「不派发后继」，
   completion 收据落库但引擎不走边；D 让 Bridge 按钉住的 snapshot 选合法出边、派发后继。
3. **review 执行语义** —— C 里 review 节点 admission 显式拒（报「execution 属 D」）；
   decision 凭证在 generalized binding 上出现 = 不变量违例（1281 R7#2）；D 解锁。
4. **docs materializer** —— 1281 brainstorm gate 已裁「materializer 归 D」（权威，不重开）。
5. **启动对账升级** —— C 的 stranded collector 只「识别 + 大声 hold」；D 接后继派发后语义完整。

## 4. Brainstorm gate 结论（Tadashi 批，本次会话）

理解全部确认正确，外加裁定与纪律：

- **裁定：materializer 独立成 PR-7.5**（不并入 PR-7）。理由：① PR-7 本身已是最重一片，保持可审；
  ② materializer 是独立关注面（受信 Bridge 物化 + 服务端捕获 head 作 claim subject，带
  provenance/安全语义），独立 review 面更干净；③ 小 PR 落得快、始终可 ship。
- **纪律 a**：D 的关单标准 = **PR-7 + PR-7.5 + PR-8 全部落地**，不许只落一半报完成。
- **纪律 b**：回头边语义**逐字按伞单 plan v1.35**（四要素 loop + max_iterations + on_limit
  escalate），不扩不减。
- **纪律 c**：enable 决策呈 ship gate 给 Annie（带她 default-enable 偏好一起呈）；
  claims_read 在 peer-credential broker + fresh-spawn E2E 闭合前**保持 off**。

## 5. 关键理解（写给 implement 段的定调）

1. **「模板派发必须走 FLY-1224 resolver，不许旁路」的精确含义**：三段式默认 dispatch 三元组的
   唯一真相 = three-stage-phases.ts 的 resolvePhaseDispatch（{vendor, model, effort}，含双向
   kill-switch）；enrolled run 的 dispatch 三元组在物化时钉进 snapshot（1281 已实现
   dispatch:{vendor,model,effort} 钉住 + run-dispatcher 消费 req.generalizedExecution.dispatch），
   vendor→executor 走既有 VENDOR_TO_EXECUTOR 别名路径。D 不新写任何 vendor/model 映射。
2. **「按 snapshot 解释」不等于重写 phase-orchestrator**：legacy（非 enrolled）路径字节不变；
   enrolled run 在完成/verdict 边界走新的 snapshot 边解释分支，行为与今天的
   design→implement→qa belt「编排行为逐字等价」（交接/回环/门），厂商阵容差异 = FLY-1224
   已拍板的有意验收差异。
3. **PR-8 的「启用」= 派发接线 + default-off 收尾**，不是生产翻 flag。生产 enable 被
   claims_read 的硬前置传递性挡住（enrolled run 的 ship gate 依赖 claims 读），这是**有意的**：
   PR-8 交付「一根显式命名的杆」，什么时候拉呈 Annie 决策。
4. **PR-8 验收硬 gate 在 source outbox 上**：ship 路径的 TURN/founder-approval 权威写必须走
   CommDB workflow_source_event/turn_source_history + projector（B 已落基建），验收测试直接
   断言 source 侧，不许拿 StateStore 投影降级冒充。

## 6. 显式不做（scope 纪律）

- 与 FLY-1306（检测风暴根治）零耦合，不顺手扩 scope。
- 伞单 §3.3 全部照旧不做：高层编排（FLY-1043）· 花名册（FLY-1141）· 动态清单生成 ·
  node-inject/fork · 任意具名节点类型 · UI（FLY-1038）。
- 不翻任何生产 flag；claims_read 硬前置（peer-credential broker/独立 principal + fresh-spawn
  E2E）不在本单解决。
- 不动 B 的 legacy ship-eligibility 读路径语义（force_legacy 应急旁路保留原样）。

## 7. 下一步

research.md：把 D 必须触碰的代码面逐个钉到符号级（模块 → 函数 → 表 → flag），
并核对伞单 plan 假设与落地现实的 drift 清单。
