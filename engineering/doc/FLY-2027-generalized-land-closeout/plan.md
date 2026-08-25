# FLY-2027 generalized land 收尾对等 — 实施计划

Issue: FLY-2027 (https://linear.app/geoforge3d/issue/FLY-2027/engine收尾-generalized-land-路径缺-fly-369-收尾链ship-后停驻体不收thread-不自动归档8-24-双)
日期: 2026-08-24
基于: research.md

---

## 0. 重新定scope 后的问题陈述(Lead 已裁决,ask `ad25c887`)

审计推翻了立单前提:generalized land 与老 🆒 路径共用同一个收尾编排器(`runPostShipFinalizationInner`),8-24 双 ship(FLY-2000/2015,implement producer)与 8-23 generic 对照组(FLY-1986 等)的收尾链均全自动跑通(merge 后 3-63 秒收体、13-125 秒归档)。"滞留"是批准前正常等门被误读,"不归档"是 FLY-1709 founder_reopened 保护的设计行为。

真实缺口(Lead 批准的收敛 scope):**generic 类型节点的收尾纵深与 implement 不对等** + **park 结算账本硬伤** + **诊断/文案不诚实**。本单目标:让验收①(无人工介入,停驻体全收、thread 自动归档)对 generic producer 在**边角形态**(pane 卡死、shutdown 失败)下也成立;验收②(founder_reopened 保留)③(老路零回归)不动。

## 1. 目标 / 非目标

**目标**
1. **全部 workflow-bound session**(含 generic、review 及未来可执行非-phase 节点,`workflow_node_id` 非空即是)获得与 phase role 对等的收尾纵深:优雅 Codex phase shutdown、FLY-1992 husk 强收、post-ship step 1.25 收编三层全部纳管(Codex R2-1:纳管范围显式选择为"所有 workflow-bound main",不是仅 generic——收体不挑食是安全方向)。
2. `ship_parked` keepalive park 投影去掉 `node.type === "implement"` 硬编码,改按 capability(`keepalive_park && creates_pr`)判定——generic producer 在 land 模式下同样 park,kickback 获得 **durable 可达性(不保证活体)**;park 判据仍挑食(仅 carrier 能力节点),与刀 1 的全量收编正交。
3. park 结算账本硬化:`runner_ship_gate_wait` park 获得结算消费者;结算静默跳过补审计事件。
4. 诊断/文案诚实化:`land_partial` 的 `cause=unknown`(8-24 实测形态)补 typed cause;founder_reopened 归档豁免消息改为真话。

**非目标(显式不做)**
- 不动 FLY-1709 founder_reopened 保护语义与其 fail-closed 判定(验收②)。
- 不动老 🆒 路径与非 workflow session(`workflow_node_id` NULL)的任何行为(验收③):`getPhaseSessionsForIssue` / `isWorkflowPhaseSession` 函数本体不改,消费点按点位加性扩展。
- D3(completion_disposition 对 land-park 体提示"立即退出"的语义矛盾)与 D5(`isEngineParked` 死代码/FLY-1448 B2 接线)→ follow-up 单,理由:牵动 runner 退出行为与 rework wake 全链(FLY-1628/1731 教训区)。
- FLY-1770 retry 预算跨 epoch 收敛(FLY-1940)、held resume 语义(FLY-1861)不碰。
- plugin.ts:9419(rework actor 查找)的 `getPhaseSessionsForIssue` 消费点不动:FLY-1912 fresh-dispatch 兜底存在;记录为"已评估未动"。(Codex R1-3 推翻了 R0 草案"Heartbeat 也不动"的判断:刀 2 让 generic 进 `ship_parked` 后与 FLY-1204 巡检直接交集,已纳入刀 1 接入点⑤。)

## 2. 四刀设计

### 刀 1 — generic 收体对等(D1)

**新判据(加性)**:
- `runner-shutdown-evidence.ts` 新增 `isWorkflowManagedSession(session)` = `isWorkflowPhaseSession(session) || !!session?.workflow_node_id`。`isWorkflowPhaseSession` 本体不动。
- `StateStore.ts` 新增 `getWorkflowManagedSessionsForIssue(issueId)`:`WHERE issue_id = ? AND (chat_thread_role IN ('design','implement','qa') OR workflow_node_id IS NOT NULL)`,排序与 `getPhaseSessionsForIssue`(:7580)一致。原查询不动。

**五个接入点**:
| 点位 | 现状 | 改法 |
|---|---|---|
| ① post-ship step 1.25 `makeFinalizeWorkflowPhaseRoles`(`post-ship-finalization.ts:493`) | `getPhaseSessionsForIssue`,finalizer 只收 issue/project/lock 参数 | **双分支 + 跨 run fencing(Codex R1-4)**:phase-role 分支保持旧查询旧行为逐字不变;新增 generic 分支要求 post-ship opts 已有的 `runId`(:278-302)传入,且 execution 经 run attribution / immutable activation binding **精确归属当前 land run** 才收编;无 run authority 时 fail-closed 不扩 generic(防止收掉同 issue 旧 held run 的 generic 体——DB 只保证单 active run,不禁止 held 旧 run 并存,`StateStore.ts:41148-41153`) |
| ② FLY-1992 husk 强收(`shipped-husk-escalation.ts:310-311`) | `getPhaseSessionsForIssue` + `isWorkflowPhaseSession` | 换新查询 + `isWorkflowManagedSession`;:60 的单体入口同步。**证据门(pane alive + >30s 未 ack + land claim + retry≥1)与既有 exact-run attribution(:208-219)原样复用** |
| ③ 优雅 Codex shutdown(`codex-phase-shutdown.ts:84 isResidentCodexPhase`) | `adapter_type==='codex-tmux' && isWorkflowPhaseSession` | `isWorkflowPhaseSession` → `isWorkflowManagedSession`:generic Codex 体获得 daemon drain + credential scrub + founder-TUI removal,不再被 legacy 直杀 |
| ④ husk 审计/收据(`shipped-husk-escalation.ts` intent/receipt 路径) | 跟随候选集 | 无独立改动,回归覆盖 |
| ⑤ **Heartbeat / FLY-1204 巡检面(Codex R1-3)**:`getParkedPhaseCandidates`(`StateStore.ts:7620-7626`)与 `classifyIssueWorking`(`HeartbeatService.ts:1768-1784`) | 只认 phase role → 新 generic park 体进不了泄漏告警/回收,活跃 generic 也不参与 fail-closed 的"issue 仍工作"判定 | 不改旧查询本体,新增 workflow-managed candidate/probe 查询(`workflow_node_id IS NOT NULL` 的 main session)并入两处消费;四类测试:generic 有 ship claim 自动回收 / 无 claim 仅告警 / 活跃 generic 阻止同 issue 回收 / 普通 main session 永不纳入 |

**兼容性论证**:非 workflow session 的 `workflow_node_id` 为 NULL → 新判据对其恒等于旧判据;phase role session 两个判据都命中 → 行为不变。行为变化 = **全部 workflow-bound 且 role='main' 的体**(generic、review 等可执行非-phase 节点,`workflow-engine-dispatcher.ts:2732-2742` 对它们统一派生 main;`DirectEventSink.ts:254-264` 持久化其 `workflow_node_id`)从"仅 step 1 直杀 + step 1.7 兜底"升级为完整纵深——这是有意选择(Codex R2-1 方案 A),TDD 含 review-main 正向收编测试与"证据门不满足不动"反测;普通非 workflow main(NULL)负测保留。**实施顺序硬约束:刀 1(含⑤)先落、测试绿,刀 2 才允许翻投影**——先有收体与巡检能力,再制造 park 体。

### 刀 2 — `ship_parked` 投影去硬编码(裁决②)

`StateStore.ts:33291-33297 projectGeneralizedCompletionTx`:

```ts
// 现状
node?.type === "implement" && node?.capabilities.creates_pr === true
// 改为(capability 判定;node-type-registry 中 generic 与 implement 同构)
node?.capabilities.keepalive_park === true && node?.capabilities.creates_pr === true
```

- `no_code` route 仍投影 `completed`(:33298 分支在前,不 park)——generic 的 `allow_no_code_completion` 行为不变。
- park reason 仍为 `rework_reachable_wait`(land 模式)→ 结算落入刀 3 泛化后的结算器;与 implement 完全对齐(含相同的 D3 既有缺陷与 husk/FLY-1628 兜底——**对等而非新造**)。
- **收益措辞诚实化(Codex R1-6)**:本刀交付的是与 implement 对等的 **durable rework reachability**(park 行 + wake 地址持久存在),**不承诺活体复用**——land 模式 disposition 仍是 `engine_gate_handoff`(`StateStore.ts:35246-35263`),runner 收据提示立即退出(`complete.ts:460-465`),pane 大概率已是 husk;kickback 时死体走 FLY-1628 恢复提案 / FLY-1912 fresh-dispatch fallback。**D3 矛盾随本刀扩展到 generic**(park 体被提示退出的形态从 implement 复制到 generic),根修留 follow-up 单;本单以死体 kickback 收敛集成测试兜住扩展面。
- **行为变化(如实呈报 founder)**:generic producer 在 gate 等待期 pane 驻留数小时(与 implement 现状一致),不再"完成即收"。收益 = kickback 可达性对等、收尾对称;成本 = 等待期 pane 资源(与 implement 对等)。
- 受影响读点核查:`ship_parked` 的所有 status 消费者(FSM 出边、`getActiveSessions`、patrol roster、close-runner `FINALIZE_DONE_SOURCE_STATES`)对 generic session 无 role 分支——按 status 统一处理,无需伴随改动;实现期以 grep 清单逐一核对并入测试。

### 刀 3 — park 结算硬化(D2;按 Codex R1-1/R1-2 重构)

R0 草案"只扩 SELECT 的 reason 过滤"有两个真缺陷,重构为:

1. **结算器泛化 + clear receipt 保真(R1-1)**:`appendWorkflowEngineParkSettlementClearTx` 的 replay 校验与 clear 写入均硬编码 `rework_reachable_wait`(`StateStore.ts:13740-13776`)——直接扩 SELECT 会把 `runner_ship_gate_wait` 的 open 清成语义不实的 rework receipt。改法:settler/clear helper 泛化,**clear 行继承并校验 `open.reason`**;仍以 `<executionId>:<openGeneration>` 定位 exact open;same-ID replay 校验完整 tuple(run/node/attempt/activation/generation/reason),不一致 fail-closed。既有"unrelated reason 不被触碰"回归(`StateStore.workflow-engine-transition.test.ts:1343-1385`)**有意识地改写为新契约**(不是顺手放宽)。
2. **call-site 级 allowed-reasons,逐点表(R1-2 + R2-2)**:R0 断言"调用点全部是终结语境"与源码不符——`:26550` 在 run 仍 active/held 时调用。settler 增加显式 `allowedReasons` 参数(**closed type、无默认值**,迫使每个 caller 显式选择)。全部 9 个调用点 exact table:

   | 调用点(`StateStore.ts`) | 语境 | allowedReasons |
   |---|---|---|
   | `:26550` `materializeWorkflowReworkReplacement` | run 可能 active/held 的原子替换 | `{rework_reachable_wait}` **仅此一种** |
   | `:29786` carrier close(run 终结) | terminal | `{rework_reachable_wait, runner_ship_gate_wait}` |
   | `:30528` operator terminate | terminal | 同上 |
   | `:36049` no_code exit | terminal | 同上 |
   | `:39962` / `:40073` founder approval terminal | terminal | 同上 |
   | `:42496` FSM finalize | terminal | 同上 |
   | `:51074` / `:51105` land completion(replay/首次) | land completion | 同上 |

   8 个 terminal caller 的 runner-ship clear 均在既有状态 CAS 之后;正反测试覆盖(尤其:活跃替换事务不得清 runner-ship gate holder)。
3. **skip 审计事件(R1-2 后半)**:静默 `continue`(:13834-13846、:13864-13866)补 `workflow_engine_park_settlement_skipped` run event——**稳定可重放 `event_uid`**(含 run/execution/open generation/skip 枚举),经 `appendWorkflowRunEventCheckedTx` 式 payload 冲突校验落账,防 retry 重复写与同 UID 吞掉不同诊断。只加事件,不改控制流。
4. 缺口 D(generation 筛选把旧 open 行排出结算)维持复核疑点处理:实现期先写 RED 复现(构造"admit clear 之后 session 仍 ship_parked"的账面),**复现成立才修,复现不成立记录进 implementation notes 并跳过**。测试矩阵补 admission-clear → completion-open → settlement-clear、finalizer-first、replay conflict、attempt N+1 re-park 四形态(R1-1)。

### 刀 4 — 诊断/文案诚实化(D4;按 Codex R1-5 定位传导断点)

- **传导断点是结构性的,不是字符串匹配缺词**:`inferLandCloseoutCause` 已能把 `controller_lease_stale` 映射为 `husk_lease_stale`(`land-closeout-cause.ts:28-42`);8-24 报 `unknown` 的真因是 `lifecycleCloseoutFn` 的 `ClosureReport.nodes[].teardown/transition` 细节被 plugin 压缩成 `{ outcome }` 丢弃(`plugin.ts:5548-5580`),post-ship 拿不到失败明细(`post-ship-finalization.ts:1000-1024`)。改法:**扩展 `issueCloseout` 返回契约为 `{ outcome: ClosureReport['outcome']; cause?: LandCloseoutCause }`**,cause 由 `NodeClosureReport` 失败项映射为枚举(**不向 founder 泄漏 raw error**),post-ship 优先消费该 typed cause,`inferLandCloseoutCause` 兜底;补 `phase_shutdown_unacked` 枚举 + 中文描述 + reason parser。
- **确定性契约(Codex R2-3)**:
  - **cause precedence 稳定**:同一 report 含多个失败 cause 时按 `LAND_CLOSEOUT_CAUSES` 枚举声明序取最高优先(不依赖 collector/节点遍历顺序);测试覆盖双 cause 稳定选取。
  - **五种 outcome 消费矩阵**(行为保持,只有 cause 变准):

    | outcome | closeoutBlocked | cause 消费 |
    |---|---|---|
    | `complete` | false(现状) | 无 |
    | `partial` | false(现状,**不改**) | cause 落诊断/事件,不阻塞 worktree/archive/Linear |
    | `needs_operator` | false(现状,**不改**) | 同上 |
    | `blocked` | true(现状) | typed cause **优先于** `lifecycle_conflict` 兜底 |
    | `conflict` | true(现状) | 同上 |

    即:本刀只让 blocked/conflict 的 retry reason 从 `unknown`/`lifecycle_conflict` 变准,partial/needs_operator 保持既有非阻塞行为并附带诊断;测试为五行矩阵各一例 + `partial`/`needs_operator` 携带 cause 不被 `lifecycle_conflict` 覆盖。
- **RED 形态(R1-5)**:从与 8-24 同形的 closure report 出发,经 plugin wiring 一路断言到 `finalization_partial`/held 通知的 typed cause——不允许只测纯函数输入数组。
- founder_reopened 归档豁免消息(`post-ship-finalization.ts:1186-1258`):"原因解除后会由清理流程重试" → 真话版:"founder 在本 thread 发过言,thread 将保持打开、不再自动归档;需要归档时由 Lead 手动处理"。仅文案,不改判定。

## 3. TDD 计划(RED → GREEN)

| 测试 | 断言 | 类型 |
|---|---|---|
| `projectGeneralizedCompletionTx` generic park | land 模式 generic needs_review → `ship_parked` + `rework_reachable_wait` park 行;no_code → `completed` 无 park;runner_ship 分支不回归 | StateStore 单测(RED:现状投影 completed) |
| implement 投影字节不变 | 既有 implement park 用例全绿 | 回归 |
| `isWorkflowManagedSession` / 新查询 | phase role、workflow-bound main、非 workflow main 三分类;NULL workflow_node_id 恒旧行为 | 单测 |
| review-main 纳管(R2-1) | workflow-bound `review` main 体被收编(正向);证据门不满足不动(反向);普通非 workflow main NULL 负测 | 单测 |
| post-ship 1.25 收 generic 体 | workflow-bound generic `ship_parked` 体被 `finalizeDone` 收编;非 workflow main 体不被收(验收③) | post-ship-finalization 单测(RED:现状候选集为空) |
| husk 强收纳管 generic | 证据门满足时 generic husk 被 force reap;门不满足不动 | shipped-husk-escalation 单测 |
| `isResidentCodexPhase` → managed | generic codex-tmux 体走优雅协议;claude 体、非 workflow 体不变 | codex-phase-shutdown 单测 |
| park 结算 `runner_ship_gate_wait` | 允许语境结算之,clear 行继承 `open.reason`;rework replacement 语境**不得**清 runner-ship holder(反测) | StateStore 单测(RED:现状零消费) |
| settler 契约矩阵 | admission-clear→completion-open→settlement-clear / finalizer-first / replay conflict(tuple 不符 fail-closed)/ attempt N+1 re-park | StateStore 单测 |
| settlement skip 审计 | 七项前置任一失败 → `workflow_engine_park_settlement_skipped`(稳定 event_uid,checked append),控制流不变;retry 不重复写 | 单测 |
| 跨 run fencing | 当前 run generic + 同 issue 旧 held-run generic 并存 → 只收当前 run actor;无 runId authority → generic 分支 fail-closed 不收 | post-ship-finalization 单测 |
| Heartbeat 巡检面 | generic 有 ship claim 自动回收 / 无 claim 仅告警 / 活跃 generic 阻止同 issue 回收 / 普通 main 永不纳入 | HeartbeatService 单测 |
| cause 传导 | 与 8-24 同形 closure report 经 plugin wiring 断言到 finalization_partial 通知的 typed cause(RED:现状 `unknown`) | 集成级单测 |
| waiver 文案 | 新文案锚点;旧误导句 grep-zero | 单测 + 文案 sweep |
| land 全链(generic) | 模拟 generic run:complete → park → 批准 → land → 收体 + 归档 + settle,全自动 | 集成(post-ship + dispatcher 既有 harness 扩展) |
| kickback 死体收敛 | generic runner 已退出(husk)后 founder kickback → FLY-1912 fresh-dispatch 收敛,不 strand | 集成(Codex R1-6) |

全仓门:`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run`(FLY-224/248 教训);宿主既有环境项(headless Terminal.app 等)按惯例隔离复跑并如实留证。

## 4. 独立 QA 面(下游 qa 节点建议)

1. 529 房 generic 模板全链:execute 完成 → `ship_parked`(新行为)→ founder 批准 → engine land → **无人工介入**体全收 + thread 自动归档 + run_completed(验收①对 generic 成立)。
2. 边角注入:generic Codex 体 shutdown 不 ack(模拟 8-24 husk 形态)→ husk force 在 retry 轮解开,land 不 held。
3. 对照回归:implement 全链(8-24 形态 replay)与非 workflow 老 🆒 路径行为逐字节对照(验收③)。
4. founder_reopened:归档后向 thread 注入人类消息 → 不再归档 + 新 waiver 文案(验收②)。

## 5. 风险与边界

| 风险 | 缓解 |
|---|---|
| 刀 2 改变 generic run 的资源形态(等待期 pane 驻留) | founder HTML 明示;与 implement 对等,无新增机制 |
| 刀 1 扩大 husk force 杀伤面 | 证据门原样复用(pane alive + 30s 未 ack + land claim + retry≥1),仅候选集扩展;单测覆盖门不满足不动 |
| 优雅协议对 generic Codex 体首次启用,drain 路径未在 generic 上跑过 | codex-phase-shutdown 的 blocked → 保留 pane → husk force 兜底(刀 1 已纳管),失败链闭合 |
| 刀 3 reason 扩展误结算 | 9 调用点 = **1 个 active caller(`:26550`)reason-scoped 到 `{rework_reachable_wait}` + 8 个 terminal caller 经既有状态 CAS 后才允许 runner-ship clear**;七项身份前置 + `status='ship_parked'` CAS 保持;`allowedReasons` closed type 无默认值 |
| D3 矛盾随刀 2 **扩展**到 generic(park 体被提示退出,pane 成 husk) | 如实承认扩展(不写"不扩大"):generic 获得的是 durable rework reachability 而非活体保证;死体 kickback 由 FLY-1628/1912 fallback 收敛并有集成测试;D3 根修 follow-up 单 |

## 5.5 Codex design review 记录

R1(6 项:settler receipt 保真、call-site 权限、Heartbeat 交集、跨 run fencing、cause 传导断点、D3 诚实化)→ R2(4 项:review-main blast radius 显式选择、9 调用点逐点表、typed-cause 确定性矩阵、旧句清除)→ **R3 APPROVED**。R3 非阻塞实现提示(实现者必读):①`allowedReasons` 不得提供宽松默认值;②post-ship workflow-bound main 分支必须**逐 actor** exact-run attribution,不能因候选查询已按 issue 筛选而省略 fencing;③`phase_shutdown_unacked` 插入 `LAND_CLOSEOUT_CAUSES` 后用双 cause 测试固定其优先级位置,防未来枚举重排静默改变 founder 诊断。

## 6. 交付物

- 代码 PR(单 PR):四刀 + 测试;`doc/VERSION` 与 CLAUDE.md 里程碑按 ship 惯例最后一 commit。
- 本 doc 文件夹(exploration/research/plan/design HTML)随分支合入。
- follow-up 单(报 Lead 建单):D3 disposition 语义对齐、D5 isEngineParked 接线、缺口 D 若复现成立且非本单修。

## 7. 实施记录(2026-08-24)

- 刀 1 已落地:`workflow_node_id` 非空的 main actor 获得 graceful shutdown、husk force、post-ship 1.25 与 Heartbeat 巡检；post-ship generic 分支以 `runId + activation binding` 逐 actor fencing，普通 main 与旧 held run 不进入收编。
- 刀 2 已落地:`ship_parked` 投影改为 `keepalive_park && creates_pr`；generic `needs_review` 会 park，`no_code` 与既有 implement/runner-ship 行为保持。
- 刀 3 已落地:9 个 caller 全部显式选择 allowed reasons；terminal caller 可消费 `runner_ship_gate_wait`，active replacement 只能消费 `rework_reachable_wait`；clear receipt 继承 open reason；所有 fencing skip 写 checked run event。
- 缺口 D 的 RED 复核未复现:现有 generation 规则在 admission-clear→completion-open→settlement-clear、finalizer-first、exact replay 与 generic land dispatcher 全链上均能选中当前 open；因此未改 generation 查询，避免无证据扩大账本语义。
- 刀 4 已落地:plugin 不再把 `ClosureReport` 压缩成裸 `{ outcome }`；typed cause 传到 post-ship，`phase_shutdown_unacked` 有稳定 enum precedence；`partial/needs_operator` 保持非阻塞，`blocked/conflict` 才阻塞；founder_reopened 明确“不自动重试、Lead 手动归档”。
- 新增 generic land dispatcher 集成证据:producer `ship_parked` → durable finalization receipt(thread archived + Linear Done) → run completed → producer terminal → exact park clear，全程无人工结算。
- 有意留给 follow-up:D3 `engine_gate_handoff` 仍提示 runner 立即退出，与 durable keepalive park 的活体复用语义冲突；D5 `runner-recovery-nudge` 的 `isEngineParked` 依赖仍未在 production plugin 注入。本单仅报 Lead，不跨 scope 修改。
- 验证留证:`pnpm lint` 0 error(8 条既有 warning)、`pnpm -r build` 全绿；core 排除真实 Terminal.app GUI 文件后 219/219；config 降并发后 661/661；claude-runner 32 files / 864 pass / 2 skip、teamlead 725 files / 9521 pass / 6 skip，断言均全绿。canonical `pnpm test:packages:run` 仍诚实非零:本 sandbox 有 `osascript` 但无 HiServices GUI 会话，另外 Vitest 3.2.4 在长同步 shell/file suite 收尾时固定报 `Timeout calling "onTaskUpdate"`；降低到 4 workers、隔离 npm cache 后所有此前并发 timeout/mock/`npm pack` 失败均消失，只剩该 runner RPC error。
