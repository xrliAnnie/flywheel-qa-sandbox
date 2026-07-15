# FLY-1232 子单 A：身份+事务 substrate + 并行写入 — 实施计划

Issue: FLY-1232 (https://linear.app/geoforge3d/issue/FLY-1232/build-dag-模板引擎-pr-1身份事务-substrateclaims-账本-6-表-一次性-decision-capability)
日期: 2026-07-13
基于: research.md
Status: **Codex design APPROVED**（5 轮：R1 7 项 → R2 5 项 → R3 5 项 → R4 2 项 → R5 APPROVED，
全采纳零 reject；轮次反馈归档于本文件夹 codex-design-round*.md）→ implement

> 三段式 pipeline：本文档由 design 阶段产出，**implement 阶段在同一分支照此执行**；QA 阶段独立复验。
> 上游 spec = flywheel-FLY-1135 分支 plan.md（Codex 4 轮 APPROVED）§2.1/§2.2/§2.4b/§3.1b/§3.2。
> scope 权威 = Lead 覆盖令 b64cea04（子单 A = 伞单段①+②，全局 4 单：A=①②/B=③④⑤/C=⑥/D=⑦⑧）
> + ask a530fe31 裁定（②b 在 A 内）+ ask c33d61d2 裁定（claim 并行写归 B）。brainstorm gate
> 三个关键决策（携带伞单文档 / E6 family 契约 / 拓扑留位）Tadashi 已批准（2026-07-13）。
> Codex design R1（7 项）+ R2（5 项）+ R3（5 项）+ R4（2 项）全采纳折入本版：派发证据真值表（started =
> marker ∧ 非 pending 行双证据）/ applyWorkflowShadowBatch 唯一事务面 + 派发器 pre-launch
> 唯一 owner + writer 事务内分配 ordinal / uid 命名空间 + T3b 含边事件 / 规范转移表（持久源
> 列 + 诚实部分缺口）/ run-infra 组装面 / 段① 硬化 / commit 顺序。

## 0. 交付物与红线

**交付物**（全部 default-off、字节兼容）：

**模块① — claims substrate**（零生产接线）：

1. teamlead.db 新表族 6 张：workflow_run（含 typed enrollment 列）/ workflow_run_node /
   workflow_run_event / workflow_decision_capability（仅存 token sha256）/ workflow_claims /
   workflow_claim_revocation，其中三张账本表（claims / revocation / run_event）挂
   BEFORE UPDATE/DELETE RAISE(ABORT) triggers。
2. 单事务 submit 原语 submitWorkflowDecisionClaim（验票→写 claim→核销→追加 run_event；
   E3 同 payload 幂等重放，其余分支全 fail-closed、拒绝路径零残留）。
3. §2.1 解析算法 resolveWorkflowDecisionClaim（最高 attempt + server_seq 选候选，再验
   吊销/过期/冲突/pass，**绝不回落旧 attempt**）。
4. E6 跨厂商 claim 层门 + 系统 claim allowlist 路径分离。
5. typed enrollment 标记 + 3 个 default-off flag（FLYWHEEL_WORKFLOW_CLAIMS_WRITE /
   …_CLAIMS_READ / …_FORCE_LEGACY）+ doc sentinel 测试。
6. **substrate 硬化**（research §B.6，R1#6）：非法/非有限时间戳 API 边界拒（NaN fail-closed）；
   签发强制 expires_at ≤ absolute_deadline_at；consumed/revoked 续期拒绝补测试；
   appendWorkflowSystemClaim 的 issue 身份从 run 行派生（或校验一致，不符拒）。
7. **伞单设计文档收带**：engineering/doc/FLY-1135-layer1-dag-templates/ **钉 9ed7ea69e**，
   且文档 commit 先于代码 commit（每个中间 commit 可构建、可 bisect —— R1#7）。

**模块②a — orchestrator 生命周期影子双写**（WRITE flag 门控）：

8. **复合事务 StateStore API（R1#2 + R2#1，不走顺序调原语）**：
   - applyWorkflowShadowBatch（**唯一规范事务面**，R3#5）：**单事务**内 getOrCreate 影子 run +
     event_uid 去重 + per-run seq 分配 + run/node 投影更新 + 事件追加 + **（可选）side_effect
     intent/状态转移** —— T1/T2/T7 要求生命周期事件、投影与 intent_recorded 落在同一个事务里，
     分立 API 顺序调无法满足（B6 撕裂测试禁止）；同 event_uid 重放 = 幂等 no-op；
     **launch_ordinal 在本事务内分配并返回**（R3#2：同 (run,node,attempt) 内每个不同
     execution_id 得新 ordinal，不信 orchestrator 预计算；仅真同 execution 的 pre-commit
     re-drive 收敛既有行）；对账侧 side-effect-only 便捷方法（若保留）委托同一 batch 事务、
     绝不用于 T1/T2/T7 创建；
   - 活影子 run 唯一性 = 部分唯一索引 (project_name, issue_id) WHERE status='active'。
9. 可选窄接口 workflowShadow 注入（§1.4 规范转移表为唯一挂点合同）；注入面 =
   run-infra.ts（RunInfraOptions 可选字段）+ PhaseOrchestratorDeps；plugin.ts 按 flag 决定
   构造与否（单一开关点）。undefined ⇒ 全 no-op。**物理 spawn 的唯一 owner = RunDispatcher.
   start() 的 pre-launch seam（R2#1）**：execId 在 start() 内部才分配、dispatchNextPhase 拿不到
   pre-launch 时机，且 reconcileQaLoss 的 respawn 也经 handoff→dispatchNextPhase→start() ——
   故 orchestrator 侧挂点只提供**语义影子上下文**（前置边 / node / attempt，经 StartRequest
   可选 shadowContext 字段传入 —— **绝不含 ordinal**，ordinal 只由 writer 事务内分配返回，
   R4#1），复合事务由 start() 在 execId 分配之后、CommDB 预注册与 Blueprint.run() 之前执行。
10. 专用 workflowShadow.reconcileOnStartup（R1#4）：按转移表「持久源」列（CommDB 行 /
    commit marker / 持久 verdict 记录 / post_ship_finalization_claim）回填缺失影子事实，
    **不依赖 orchestrator 既有 skip-heavy reconcile 路径、绝不触发生产动作**
    （started-evidence 的 live 探针不在回填依据内 —— 它回答存活不回答历史，R3#1）。
11. 终结（T9，R2#5 定稿单一权威设计）：**best-effort 可选 hook 挂在唯一串行化的
    runPostShipFinalization 路径**（post-ship-finalization.ts）→ 影子 run status
    active→completed；**加 claim 兜底修复** —— reconcileOnStartup 从持久的
    post_ship_finalization_claim 派生补终结（外部 merge 路径 / hook 失败都由它收敛）。
12. 失败姿态：影子事务失败 = 整体回滚 + 带标识 loud warn，绝不阻断生产流（显式观察期姿态）。

**模块②b — 派发 outbox/reconcile 状态机**（独立模块结构，同 flag 门控）：

13. 新表 workflow_side_effect_ledger：kind 本单只启用 dispatch；行身份 =
    (run_id, node_id, attempt, kind, **launch_ordinal**) UNIQUE；列含 execution_id（副作用前
    预留，**已提交行永不改写**）/ state / reason / created_at / updated_at / abandoned_at。
    状态机单向：intent_recorded → launch_committed → started（终态）；任何非终态 → abandoned
    需 reason；同态重放幂等、非法转移拒。**全部转移经 applyWorkflowShadowBatch 落库**（R3#5
    单一命名面，无独立 side-effect API）。**状态审计 = ledger 行自身**（R4#2）：加 per-state
    时间戳列（committed_at / started_at；abandoned_at 已列），行创建（intent_recorded）随
    T1/T2/T7 的 batch 与 node_dispatched 同事务落库；后续状态推进只更新 ledger 行 + 时间戳，
    **不追加 run_event**（伞单 §3.1b 词汇表无对应事件 kind —— 与 B9 合规，不造词、不挪用
    生命周期 kind）。
14. **证据真值表 = research §F.3**（R1#1 + R2#3 + R3#1 修正版，判据全部为持久事实）：
    launch_committed = adapter durable commit marker（WRITE flag ON 时 fresh 路径也传
    launchCommitPath —— BlueprintContext 既有字段、零 adapter 代码改动；OFF 保持 undefined =
    既有哨兵）；**started = launch_committed 已达成（marker 已证）∧ CommDB 非 :pending 行存在
    —— 双证据缺一不可，绝无「仅行」捷径**（Codex 路径的行是 adapter 在 goal runtime 前建的、
    失败也保留终态行，行单独证明不了启动），终态；abandoned 仅 pre-commit 正失败（run() 显式拒
    ∧ 无 marker ∧ 无行）；Codex pre-goal 失败 ⇒ 永远停在 intent_recorded（诚实 unknown）；
    commit 后 window 死 / indeterminate / lookup_error ⇒ 停在 launch_committed，**永不伪造历史**。
15. 对账原语 reconcileSideEffects：以 execution_id join durable 证据只推进影子状态，
    **绝不驱动派发副作用**（无 spawn/wake/Blueprint 调用面 —— 接管派发驱动 = 子单 D）。

**attempt/ordinal 语义（R1#3 + R3#2 + R4#1，normative）**：attempt = 逻辑决策轮（kickback
重入 +1，含 keep-alive wake 复用执行的形态）。launch_ordinal **只由 writer 在 batch 事务内
分配并返回**（调用方任何位置不预计算、shadowContext 不携带），规则 = 同 (run,node,attempt) 内
**每个不同的 execution_id 得新 ordinal**，覆盖全部三种重入：post-start 替换 respawn（新
execution ⇒ 新行）、**crash 后 reconcile 重进以新 execution 重启动（同样新行）**、真·同
execution 的 pre-commit re-drive（收敛同一行）。wake 不产生 side_effect 行（不是 spawn
副作用），只产生生命周期事件。

**红线**：

- 不接线任何生产**读**路径；不动 verify-approval / codex_review_record / qa_required 等现有门。
- **本地 claim 并行写（QA/codex verdict 生产者）不在本单 —— Lead 终裁归 B**（ask c33d61d2）。
  理由（Lead 采纳并将于 B 单直令引用）：claim 行必须挂 authority；影子期没有 capability 下发
  机制，此时强写 claim 行 = 系统里第一批 claim 就是无授权的替身声明 —— 恰是整套设计要消灭的
  东西。A = 影子三表 + outbox（观察价值足够）；claim 生产者与「谁有权声明」全家归 B。
- 账本表绝不弱化 append-only；sentinel 绝不因目录缺失而 skip 化。
- flag 全 OFF 时字节兼容：接缝处 undefined + 纯增表 + fresh 路径 launchCommitPath 保持
  undefined ⇒ 现有行为一字不变。
- 外部注入 startDispatcher（startBridge 选项，测试/QA harness 用）不做 shadow 包装 ——
  观察期显式声明的覆盖边界（生产组装路径 = setupRunInfrastructure），文档 + 测试钉住。
- merge 即入库、生效等 Bridge 重启（攒批）。

## 1. 实施步骤（implement 阶段执行序）

### Step 1 — 伞单设计文档收带（第一个 commit，钉死 sha）

```
git checkout 9ed7ea69e -- engineering/doc/FLY-1135-layer1-dag-templates/
```

文档先行，保证下一步 cherry-pick 落地后 sentinel 测试即绿（每个 commit 可构建，R1#7）。

### Step 2 — 模块①：cherry-pick

```
git cherry-pick 3a993f3d5
```

预检结论（research §A）：与 main 增量零文件重叠 → 预期零冲突；冲突则以 3a993f3d5 为准手工落块。

### Step 3 — 模块①硬化 + E6 契约 jsdoc（TDD：先补 RED 测试再改）

按 research §B.6 四项：非有限时间戳拒 / 签发 deadline cap / consumed+revoked 续期拒测试 /
system claim issue 身份从 run 派生。E6 jsdoc：issuerVendor / subjectProducerVendor 必须是
服务端解析后的 family（adapterTypeToFamily 同口径，绝不信 manifest/runner 自报）；claim 层门
是第二道（admission 家族校验 = 子单 B/D）。

### Step 4 — 规范转移表（②a/②b 的唯一挂点合同，R1#4 + R2#1/#2/#4/#5 修正版）

每行 = 生命周期时刻的**唯一 owner**、event_uid 公式（**全部以 runId+node+attempt 为命名空间**，
R2#2 —— keep-alive 同一 execution 跨多轮、同 issue 多个 run 都不得撞车）、影子写入、attempt
规则、**持久源（T8 回填依据）**。实现与测试逐行对号，任何时刻恰一个挂点。

**spawn 类时刻（T1/T2/T7）的统一 owner = RunDispatcher.start() 的 pre-launch seam**（R2#1）：
execId 在 start() 内部分配，orchestrator 侧（dispatchNextPhase 等）只把**语义**影子上下文
（shadowContext：前置边 / node / attempt —— 不含 ordinal，R4#1）放进 StartRequest；start() 在
execId 分配后、CommDB 预注册与 Blueprint.run() 之前，用**一个** applyWorkflowShadowBatch 复合
事务写齐该时刻的全部生命周期事件 + 投影 + intent_recorded（ordinal 由该事务分配并返回）。

| # | 时刻 | 唯一 owner（挂点） | event_uid（run 命名空间） | 影子写入（单复合事务） | attempt/ordinal | 持久源（T8 回填） |
|---|------|--------------------|---------------------------|------------------------|-----------------|-------------------|
| T1 | run 起点（design 首派发） | start() pre-launch seam（shadowContext: design/1） | run:{runId}:dispatch:design:1:{ordinal}（ordinal = writer 事务内分配返回，R3#2） | getOrCreate run(active) + run_node(design,1,running) + node_dispatched + intent_recorded | attempt=1；ordinal 按「新 execution ⇒ +1」规则由 writer 定 | intent 行 + commit marker + CommDB 行 |
| T2 | handoff spawn（→implement / →qa 首次物理启动） | dispatchNextPhase 提供 shadowContext（含前置边）→ start() pre-launch seam | run:{runId}:edge:{from}:{to}:{attempt} + run:{runId}:dispatch:{node}:{attempt}:{ordinal} | edge_traversed + run_node + node_dispatched + intent_recorded | 该节点当前逻辑轮；ordinal 同上由 writer 定 | sessions 行 + marker + CommDB 行 |
| T3 | keep-alive fix 轮 wake（qa FAIL → implement 复用执行） | runFailFlowKeepAlive wake 点 | run:{runId}:wake:implement:{attempt} | node_dispatched + run_node（**无 side_effect 行** —— wake 非 spawn） | attempt = 新逻辑轮 | belt/fix 轮持久记录（部分） |
| T3b | handoff wake（implement 修完 → 已活 QA retest） | handoff() wake 分支 | run:{runId}:edge:implement:qa:{attempt} + run:{runId}:wake:qa:{attempt} | **edge_traversed + node_dispatched**（同一复合事务；wake 交接走的是同一条 DAG 边，R3#3）+ run_node（无 side_effect 行） | attempt = 新逻辑轮 | belt/verdict 持久记录（部分） |
| T4 | node 完成 | onPhaseComplete | run:{runId}:complete:{node}:{attempt}:{execId} | node_completed + run_node ended + run.current_node_id | 不变 | **最新完成边界可回填（phase session 现态）；跨多轮 keep-alive 的历史完成 = 声明的部分缺口**（R3#4 —— session 行是可变投影，不为每轮保留唯一持久身份；不为回填把源身份穿进 sink/route） |
| T5 | QA PASS | onQaResult PASS 分支 | run:{runId}:complete:qa:{attempt}:{execId} + run:{runId}:edge:qa:end:{attempt} | node_completed + edge_traversed | 不变 | 持久 QA verdict 记录（eventId） |
| T6 | QA FAIL kickback | belt 轮递增点（loop_iteration **唯一** owner） | run:{runId}:kickback:{round} | **仅 loop_iteration**（新 attempt 的 run_node 行由其后续 T2/T3/T3b/T7 时刻创建 —— 单一 owner） | 声明 attempt+1 | 持久 verdict + belt 轮记录 |
| T7 | QA respawn（started 后丢失，reconcileQaLoss 触发） | 物理 spawn 仍经 handoff→dispatchNextPhase→start() ⇒ 同 T2 的 pre-launch seam；shadowContext 只请求「同 attempt 的替换启动」，下一 ordinal 由 writer 事务内发现并返回（R4#1） | run:{runId}:dispatch:qa:{attempt}:{ordinal} | node_dispatched + intent_recorded（**新** side_effect 行；旧行不改写） | attempt 不变；ordinal = writer 分配 | marker + CommDB 行 |
| T8 | 启动重放 | workflowShadow.reconcileOnStartup（专用，不借 orchestrator skip-heavy 路径） | 复用各时刻公式（幂等去重） | 按本表「持久源」列逐行回填 crash 窗口（生产源已写、影子未写）；**两类声明缺口绝不冒充回填**（R2#4+R3#4/R4#1）：wake 类细粒度时点、跨多轮 keep-alive 的 T4 历史完成 | 按证据 | — |
| T9 | post-ship 终结 | runPostShipFinalization 单一串行化路径的 best-effort hook + reconcileOnStartup 从 post_ship_finalization_claim 兜底（R2#5） | run:{runId}:finalized | run.status active→completed | — | post_ship_finalization_claim |

### Step 5 — 模块②a TDD（RED→GREEN→REFACTOR）

RED：转移表逐行断言（fake deps 驱动全部 T1–T9 含 T3b，spawn 与 wake 两种交接的生命周期序列
各自完整含边事件）；flag-off/undefined 哨兵；重放幂等（每路径跑两遍零重复）；**uid 命名空间
双撞车案例**（同一 execution 跨两轮 keep-alive 的第二次完成不被去重；同 issue 两个独立 run 的
kickback 不互撞，R2#2）；**crash 换 execId 案例（R3#2）**：batch 已提交 → crash 在 CommDB
预注册/marker 之前 → 重启 reconcile 重进 handoff 分配**新** execution id ⇒ 第二次物理启动得
**独立**账本行（新 ordinal），逻辑边事件仍被去重；**逐语句故障注入**（复合事务任一语句抛错 ⇒
整体回滚零残留 + 重放成功，R1#2+R2#1）；失败姿态（shadow 抛错 ⇒ 生产回调照常 + warn）。
GREEN：applyWorkflowShadowBatch + WorkflowShadowWriter + StartRequest.shadowContext +
deps/run-infra/plugin 接线。REFACTOR：每时刻恰一处调用（review 逐点数）。

### Step 6 — 模块②b TDD

RED：真值表逐态断言（indeterminate/lookup_error 保持 / abandon 仅 pre-commit 正失败 /
started 终态且判据 = **marker 已证 ∧ 非 pending 行**双证据 / 已提交行 execution_id 不可改写）；
**R2#3 三案例**：post-start Blueprint.run() 失败绝不 abandon；runner 启动成功后退出、之后对账
仍判 started；两种 adapter 时序（TmuxAdapter marker→注册→回调 / CodexTmuxAdapter 行→回调→
marker）都收敛到同一终态；**R3#1 Codex 负例**：行存在而 marker 从未写出（pre-goal 失败）⇒
永远停在 intent_recorded，绝不 started；attempt/ordinal 五案例（keep-alive wake / legacy close-respawn / pre-commit 同 id
re-drive / post-start QA 替换 / founder-feedback kickback）；对账零副作用。
GREEN：DDL + 状态机原语 + fresh 路径 launchCommitPath 传递（flag ON）+ 对账。
与 commit marker / CommDB 自注册行的对账用真 better-sqlite3 + 临时文件系统集成测
（mock 之外的 real-tool 补位）。

### Step 7 — 全量验证（verification-before-completion）

| 检查 | 通过线 |
|------|--------|
| 段① substrate + sentinel + 硬化测试 | 全绿（32+3 + 新增硬化测试） |
| 段② 新测试 | 全绿 |
| teamlead 全套 vitest | 无新增失败（对照 main 基线；预存环境性失败逐一核对确属预存） |
| tsc --noEmit / pnpm lint（全仓） | 零错 / 干净（push 前铁律） |
| 字节兼容反向哨兵 | flag 全 OFF：现有测试结果与 main 基线一致；normal 路径 launchCommitPath 仍 undefined（既有哨兵测试保持绿）；表/flag 的生产引用 = migration + shadow 模块 + 测试 |

### Step 8 — review 与 QA（起步快 ≠ 免检）

1. 开 PR（英文描述 + Linear 链接 + 测试计划），stage set pr_created → Codex code review
   （xhigh）循环到 APPROVED。
2. auto-QA / 独立 QA 按 §2 验收矩阵逐格独立复验（不采信 implement 自报）；**flag ON 的真机
   验证**：隔离环境起一次真 fresh spawn，确认 commit marker 落盘 + started 证据推进 + 影子
   账本序列正确（flag ON 改变 fresh 启动命令形态 —— 见 §5 风险 7）。
3. head 纪律（FLY-945）：review 后不再推 commit；必须推则重跑增量 review + 新 head QA verdict。
4. 三段式收尾按 approve gate 流程；ship 走 :cool:，绝不自 merge。

## 2. 验收矩阵（QA 逐格核）

**段①（A1–A13）**：

| # | 验收 |
|---|------|
| A1 | 6 表 DDL 逐列符合伞单 §2.1/§2.2/§3.1b 规范（research §B.1 核对表） |
| A2 | 三账本表 UPDATE/DELETE 在 DB 层被 RAISE(ABORT) 拒 |
| A3 | capability 表无明文 token 列；签发后 DB 内只有 sha256 |
| A4 | E3(a) 同 payload 重放幂等零新行；E3(b) 异 payload / 过期 / stale attempt 拒；E3(c) 无凭证/未知 token 拒 |
| A5 | 拒绝路径零残留 |
| A6 | 解析绝不回落旧 attempt（FAIL/吊销双场景） |
| A7 | E6 同 family review claim 拒；缺 producer 拒 |
| A8 | 系统 claim allowlist 双向锁 + subject_kind 强制 |
| A9 | 续期 ≤ absolute_deadline_at；过期/**consumed/revoked** 票不可续（硬化补测） |
| A10 | 3 flag 默认 OFF 且独立；enrollment 只认显式入参 |
| A11 | doc sentinel 3 测绿（含突变自检「能红」）且伞单文档钉 9ed7ea69e 在本分支、先于代码 commit |
| A12 | 字节兼容反向哨兵（Step 7 最后一行）成立 |
| A13 | 硬化四项：非有限时间戳拒；签发 expires_at ≤ absolute_deadline_at；system claim issue 身份从 run 派生/校验；上述各配负测 |

**段②（B1–B11）**：

| # | 验收 |
|---|------|
| B1 | flag OFF：接缝 undefined、全路径零 workflow 写、normal 路径 launchCommitPath 仍 undefined（既有哨兵测试原样绿） |
| B2 | flag ON：转移表 T1–T9（含 T3b）逐行行为一致（fake deps 全覆盖）；spawn 与 wake 两种交接的序列都含 edge_traversed（R3#3） |
| B3 | attempt/ordinal 五案例（keep-alive wake / legacy close-respawn / pre-commit 同 id re-drive / post-start QA 替换 / founder-feedback kickback）各自产出正确的 attempt、ordinal 与行数；uid 命名空间双撞车案例（同 execution 跨两轮 / 同 issue 两 run）不误去重；**crash 换 execId 案例**：batch 提交后、预注册前 crash → 新 execId 重启动 → 独立账本行 + 逻辑边去重（R3#2） |
| B4 | 重放幂等：每路径跑两遍零重复；reconcileOnStartup 按转移表持久源列逐行回填 —— 每个可回填时刻配「生产源已写、影子未写」的 crash 窗口测试；声明的部分缺口（wake 类 + 跨多轮 T4 历史完成）有显式测试证明不误报不冒充（R2#4+R3#4） |
| B5 | 影子事务失败 ⇒ 整体回滚 + loud warn + 生产流零影响 |
| B6 | 逐语句故障注入 ⇒ applyWorkflowShadowBatch 全量回滚零撕裂写（生命周期事件/投影/intent 之间无孤儿），随后重放成功；无任何绕过 batch 的 side-effect 写面（R3#5） |
| B7 | ②b 真值表：indeterminate/lookup_error 保持现状；abandon 仅 pre-commit 正失败且带 reason+时间戳；**started = marker 已证 ∧ 非 pending 行（双证据），终态；Codex 行在而 marker 永缺 ⇒ 停在 intent_recorded 绝不 started**（R3#1）；post-start run() 失败不 abandon；runner 退出后对账仍 started；两种 adapter 时序收敛；已提交行 execution_id 不可改写 |
| B8 | 对账零副作用（无 spawn/wake/Blueprint 调用面） |
| B9 | 事件 kind 全在伞单 §3.1b 词汇内，无自造 kind |
| B10 | 活影子 run 唯一（部分唯一索引生效）；T9 双路径（进程内 finalization hook + 外部 merge 走 claim 兜底）都把 run 推出 active；终结后同 issue 新 workflow 得新 run |
| B11 | flag ON 真机：fresh spawn 落 commit marker + started 证据推进 + 影子序列正确（隔离环境） |

## 3. 文件清单（预期全部改动）

| 文件 | 性质 |
|------|------|
| packages/teamlead/src/workflow-claims.ts | 新增（cherry-pick） |
| packages/teamlead/src/StateStore.ts | 追加（cherry-pick + 硬化 + 事务级影子 API + side_effect DDL/原语 + 部分唯一索引） |
| packages/teamlead/src/bridge/workflow-shadow-writer.ts | 新增（②a/②b 适配层） |
| packages/teamlead/src/bridge/phase-orchestrator.ts | 修改（deps 可选字段 + T3/T3b/T4/T5/T6 挂点 + T2/T7 的 shadowContext 组装） |
| packages/teamlead/src/bridge/run-dispatcher.ts | 修改（T1/T2/T7 pre-launch seam 复合事务 + flag ON 时 fresh 路径传 launchCommitPath） |
| packages/teamlead/src/bridge/retry-dispatcher.ts | 修改（StartRequest 可选 shadowContext 类型字段，R2#1） |
| packages/teamlead/src/bridge/run-infra.ts | 修改（RunInfraOptions 可选 workflowShadow + 组装接线，R1#5） |
| packages/teamlead/src/bridge/post-ship-finalization.ts | 修改（T9 best-effort 可选 hook，R2#5） |
| packages/teamlead/src/bridge/plugin.ts | 修改（flag 判定 + 构造注入，单一开关点） |
| packages/claude-runner/src/TmuxAdapter.ts | 仅注释修正（「ONLY path sets launchCommitPath」在 flag ON 后不再成立） |
| packages/teamlead/src/__tests__/StateStore.workflow-claims.test.ts | 新增（cherry-pick + 硬化补测） |
| packages/teamlead/src/__tests__/fly1135-doc-sentinel.test.ts | 新增（cherry-pick） |
| packages/teamlead/src/bridge/__tests__/workflow-shadow-writer.test.ts（±拆分） | 新增（②a/②b + 故障注入 + run-infra 接线测试） |
| engineering/doc/FLY-1135-layer1-dag-templates/*（9 文件，钉 9ed7ea69e） | 收带（Step 1，先行 commit） |
| engineering/doc/FLY-1232-pr1-claims-substrate/*（本三件套 + progress） | 设计阶段已入 |

若实现中发现真值表证据接线需要触碰 Blueprint/adapter 代码（预期不需要 —— launchCommitPath
是既有字段），先回 Lead 再动；其余超出清单的改动同规则。

## 4. 与后续子单的接缝（4 单结构，明确留白）

| 接缝 | 归属 |
|------|------|
| 本地 claim 并行写（verdict 生产者）+ capability 下发通道 + founder guard 收口 + 跨库投影 | B（执法层，原③④⑤） |
| claims 读切换（READ flag 消费方）+ 红测变绿（E1）+ E4/E5 行为级验收 + 模板 schema/DDL 完整态 + admission 家族校验 | B |
| node-id 生命周期 8 面 + generic 契约 + Blueprint capability 门控 | C（原⑥） |
| 注册表迁移 + orchestrator 按 snapshot 解释 + 模板派发启用（outbox 观察→驱动） | D（原⑦⑧，等 FLY-1224） |
| materialize kind 副作用状态机（product 线） | B |
| 外部注入 startDispatcher 的 shadow 覆盖 | 观察期显式不覆盖（文档+测试钉住） |

## 5. 风险与对策

1. **cherry-pick drift**（低）：零重叠已核；冲突以 3a993f3d5 为准。
2. **段② 碰生产文件**（本单最大爆炸半径）：可选接缝（undefined 即旧行为）+ 单一开关点 +
   B1 哨兵 + 事务级失败回滚 + 每时刻恰一处挂点（review 逐点数）。
3. **观察期双写语义误解**：影子账本不是权威 —— plan/代码注释双处声明；READ flag 无消费方是
   结构保证。
4. **「起步快 = 免检」错觉**：Step 8 完整 review + 独立 QA 硬步骤。
5. **server_seq 单写者假设**：当前架构事实（Bridge 单进程写者）；多写者需显式 sequence，不在本单。
6. **sentinel 词汇回潮**：三件套已规避；sentinel 扫三 src 树兜底。
7. **flag ON 的 fresh 启动形态差异**（R1#1 衍生，显式声明）：WRITE flag ON 时 fresh 路径传
   launchCommitPath ⇒ 启动走 commit-gate 包装（与 retry 路径同形态，FLY-245 已审机制）。
   默认 OFF ⇒ ship 零风险；启用前置 = B11 真机验证 + Lead/founder 按攒批重启节奏拍板。
8. **转移表覆盖漂移**：orchestrator 未来新增生命周期分支可能绕过挂点 —— 对策 = 转移表写进
   shadow writer 模块头部注释作为合同 + B2 全路径测试在 CI 常驻。

## 6. 开放项

无 —— scope 三条边界（②b 在 A / claim 并行写归 B / 跨库投影归 B）均已 Lead 终裁；Codex design
R1 七项 + R2 五项 + R3 五项 + R4 两项全部折入（本版）。
