# FLY-108 Session Status 不 Flip — 调研

Issue: FLY-108 (https://linear.app/geoforge3d/issue/FLY-108/session-status-不-flip-runner-session-completed-两类-bug-geo-362-empty)
日期: 2026-08-31
基于: exploration.md

> 审计基线:**代码快照 `1855f7a1`**(含 PR #155 已 merge 的 FLY-108 修复;本节点后续 docs-only
> 提交会推进分支 HEAD,但不触任何代码文件——文中「HEAD」均指该代码快照)。
> 本文所有行号均在该快照上核实过(grep + 逐段阅读),不是转述归档 plan。

---

## 1. 发射侧 — `flywheel-comm complete`(`packages/flywheel-comm/src/commands/complete.ts`)

### 1.1 路由枚举与入参校验(L30-145)

`VALID_ROUTES = {auto_approve, needs_review, blocked, no_code, pr_handoff, phase_design_complete}`。
原设计只有前三个;`no_code`(FLY-222)、`pr_handoff`(FLY-493)、`phase_design_complete`(FLY-793)
是后续在同一地基上加的终态路由。校验 fail-close:

- `--route` 必填且在枚举内,否则 exit 1(L97-106)
- `--merged` 必须配 `--pr`(L107-110)
- `no_code`/`phase_design_complete` 拒绝 `--merged`/`--pr`(矛盾旗标,L114-122)
- `pr_handoff` 强制正整数 `--pr`、拒绝 `--merged`(L125-145);还有 land-status 文件一致性 fail-close(L356-376)

**对 Variant A 的意义**:route 必填 + 枚举校验 = 这条产线**发不出空 payload**。

**负面守卫的一处不对称(复审 R1 D1-02 核实)**:`--pr` 在 `index.ts:895` 用 `Number.parseInt` 解析、`complete.ts:107-110` 对 `--merged` 只查 `--pr` 非 null/undefined,正整数严格校验只在 `pr_handoff` 分支(L125-145,FLY-493 Codex R1 加的)。所以 `--route auto_approve --merged --pr abc` 能通过校验并发出 `landingStatus.status="merged"` + `prNumber=NaN`(序列化为 `null`)的终态事件——**空 payload 发不出,但畸形 PR 证据发得出**。记为 plan 缺口 G2。

### 1.2 Payload 构造(L147-208)

- Env 全用现存注入:`FLYWHEEL_EXEC_ID` / `FLYWHEEL_ISSUE_ID` / `FLYWHEEL_PROJECT_NAME` / `FLYWHEEL_BRIDGE_URL` / `FLYWHEEL_INGEST_TOKEN`(可选 auth)
- Evidence 全部从 git 现场拉(L293-347):commitCount / filesChangedCount / linesAdded / linesRemoved / diffSummary / changedFilePaths / commitMessages,base = `merge-base HEAD origin/main`
- `evidence.headSha`(L336-342,FLY-191 Phase 2):完整 40 位 sha,git 失败则**省略而非默认值**——verify-approval 对缺失 sha fail-close
- `issueIdentifier` 从 branch 名 regex `[A-Z]+-\d+` 解析,失败省略(Bridge COALESCE 保留 session_started 值)
- `reviewQuestionId`(FLY-191):绑定 review 请求到唯一 gate question;needs_review 无 question-id 时打 advisory warn(L190-198,FLY-945 Fix C)

Payload shape 与 edge-worker 侧发射器对齐:**接口定义**在 `ExecutionEventEmitter.ts:61-85`,
**payload 构造**在同文件 `emitCompleted()`(~L133-160)——两条产线(Blueprint 路径 / Lead-driven 路径)
喂同一个 Bridge 消费契约。**已知分歧**:Blueprint 产线的 payload 现含 `sessionParams`
(`ExecutionEventEmitter.ts:156-157`,**FLY-123 adapter resume 数据**,如 Codex `threadId`),
`complete.ts` 不携带该字段;Bridge 对缺失 sessionParams 容忍(可选消费)。
注意与 FLY-208 5a 的 evidence-gap 标记区分:后者是 **Bridge 消费侧** `markEvidenceGapCompletion`
写入的,只是与 adapter resume 数据**共存于同一个 `session_params` JSON 列**(merge-preserving 写),
并不经由发射器字段传输。此分歧不破坏契约但应在字段矩阵里显式记录(见 plan §4.7)。

**needs_review 的授权绑定契约(FLY-191,生产 Blueprint 指令原文 `Blueprint.ts:1716-1735`)**:
`complete --route needs_review` 在生产上**不是孤立调用**,完整链是:
1. `gate approve_to_ship --no-block` → 立即返回 questionId;
2. `complete --route needs_review --pr <N> --question-id <questionId>` —— 绑定 review 请求到唯一 gate question
   (无 --question-id 时 `event-route.ts:1135-1154` 在 awaiting_review 结果上**清空** review binding);
3. 被唤醒后 ship 前必须 `verify-approval --exec-id <id> --pr-head $(git rev-parse HEAD)`,
   只认 `"approved": true`——唤醒消息本身不携带授权。

**as-built 不对称(复审 R1 D1-01 核实)**:上面是生产 Blueprint 指令的形态;手工 `/spin` 路径
`.claude/commands/spin.md:440-456` 的 needs_review 位点**仍是旧形态**——没有 `gate --no-block`、
`complete` 不带 `--question-id`(`complete.ts:180-198` 只 warn 不 fail-close)。记为 plan 缺口 G1。

### 1.3 可靠投递(L215-262)

4 attempts × 5s timeout,backoff 1s/2s/4s;全失败 → **fail-close**:写 marker
`~/.flywheel/state/complete-failed/<execId>.json`(含完整 payload)+ exit 1。
marker 写失败也 loud(L422-431)。**不 fail-open**——丢终态事件 = bug 原样复现(设计决策 2)。

## 2. 消费侧 — Bridge `event-route.ts` session_completed 分支(L812-1500)

处理顺序(每步都在 HEAD 核实):

1. **pre-state 读取**(L861-863):`existingSession = store.getSession(execId)`;
   `isPostApproveShip = (status === "approved_to_ship")` ——在 guard 之前算,保住自然完成路径。
2. **FLY-108 Decision 4/5 strict route guard**(L865-895):
   `!isPostApproveShip && (!route || !VALID_ROUTES.has(route))` → **warn + `{ok:true, warning:"invalid route skipped"}` + return**。
   不 upsert、不 silent fallback。旧的 `else status="completed"` fallback 已删,只对
   `approved_to_ship` pre-state 保留 route=undefined 的自然完成。
   **sink 范围(复审 R1 D1-03 核实)**:这套 strict guard 只在 HTTP `/events` sink;in-process
   `DirectEventSink.ts:626-633` 对缺失/未识别 route 仍走 `else status="completed"`,并经 `upsertSession`
   直接落库、不过 `applyTransition`——两个 sink 的守卫**不等价**。可达性:`Blueprint.ts:2064-2098`
   无 DecisionLayer 的 fallback 返回不带 decision 的 success → `emitTerminal` 当 completion 发。
   缓解:FLY-228 terminal-immunity 只挡 no-out-edge 终态;finalization 仍由 merged landing +
   ship-eligibility 把守——分歧影响 status / close eligibility,不触发 teardown。记为 plan 缺口 G3。
3. **running-only 约束**(L903-919):`no_code`/`pr_handoff`/`phase_design_complete` 只允许
   从 `running` 终态化——review-gated session 不能借道清闸。
4. **status mapping**(L921-1135):顺序敏感(Codex R3 修过)——needs_review → auto_approve → blocked →
   undefined(仅 post-approve-ship)。merged landing 先过 `computeAuthoritativeShipDecision`
   ship-eligibility 闸(FLY-869 B),不合格 → 挂 merge_block park 在 `awaiting_review`,不自动 revert。
5. **FSM applyTransition** → 失败升级为 error 日志并携带 pre-state/target/route(L1309,FLY-108 加的 triage 强化)。
6. **finalization**:`isPostApproveShipComplete`(见 §4)→ `runPostShipFinalization`。

### Q1 答案(空 payload Variant A 今天复现会怎样)

pre-state=`awaiting_review`(非 approved_to_ship)+ route=undefined → 走 guard 第 2 步:
**loud skip**(warn 日志 + response 带 warning),session 停在 awaiting_review 但 bug 可见、
不再是静默 FSM dead-end;且 §1.1 表明现役发射器发不出这种 payload——只有 foreign/deprecated emitter 会触发。

## 3. FSM — `packages/core/src/workflow-fsm.ts:120-184`

- `running → completed` 一直合法(Variant B 不需要动 FSM,缺的是事件)
- `awaiting_review → completed` **现已存在**(L146-153,FLY-60 W2 加):服务
  `stage_changed=completed + landing_status="merged"` 的 post-merge re-finalize;
  **merge-proof 守卫在 event-route 调用点**,FSM 表只声明合法性(L140-145 注释明确此分工)
- 后续边:`approved_to_ship → awaiting_review`(FLY-945 Fix C 重开 review)、
  `approved_to_ship → blocked`(FLY-208 5a)、`running → design_done`(FLY-793 三段式)

## 4. Finalization predicate — `post-ship-finalization.ts:68-98`

FLY-208 5a 收紧后:**merged landing 是每个分支的必要条件**(L92 `landingStatus?.status !== "merged" → false`),
然后 `shipEligible === false → false`(FLY-869 B parked 不 finalize),
再 `existingStatus === "approved_to_ship" || route === "auto_approve" || route === "needs_review"(FLY-120)`。

### Q3 答案(双发去重)

`needs_review` 早发(→ awaiting_review)+ ship 后 `auto_approve+merged` 再发(→ completed)是**设计内**双发;
`runPostShipFinalization` 的 atomic claim(L478,`event_id = "post-ship-finalization-<execId>"`,
UNIQUE event_id 落库)保证 orchestrator 恰好跑一次——三个竞争调用面
(DirectEventSink / event-route / merge-ship-gate)共用该 claim(L131 注释)。

## 5. Variant B 的三重保障

1. **主修**:spin.md Step 3.7(`.claude/commands/spin.md:412-474`)硬性要求
   `flywheel-comm complete`;规则原文:「Never exit /spin without a successful flywheel-comm complete」。
   needs_review 位点(PR 后、approve 前)+ auto_approve 位点(ship + 收尾后)都已接线
   (但 needs_review 位点仍是无 gate/question-id 的旧形态,见 §1.2 缺口 G1),
   且 self-ship handoff 失败时 fail-close 不发成功 completion(L387-402)。
2. **W2 re-finalize**(event-route stage_changed 分支,`stage=completed` 且
   payload 带 `landing_status.status="merged"`):对「session_completed 先到但 landing 当时还是
   ready_to_merge、merge 后到」的时序,用 stage_changed 携带的 merge 证据重评 predicate 再终态化,
   同样过 FLY-869 B ship-eligibility 闸。这是 Option 2 的**有限安全形态**——只重终态化
   已有 session_completed 记录的 session,不无中生有 synthesize。
3. **FLY-324 live fallback**(`event-route.ts:1928-1985`,后续迭代补的第二条有限 stage-driven 通道):
   no-PR / no-code / QA Runner 只跑 `stage set completed`、从不调 `complete --route` 时,
   `isDoneButRunning` 守卫(status=running + stage=completed + 无 decision_route + 无 pr_number)
   且无 pending complete marker、incoming land-status 不带 prNumber → 直接 `running → completed`。
   非-merged 检查保证 merged session 仍归 W2 独占;带 PR 的 session 被排除(必须走 review,
   不能被 force-complete)。配套 boot sweep 在 `plugin.ts:4729+`(处理修复前积压,Lead exclude
   list 仅限 cutover boot sweep)。语义合同:报 `stage=completed` = 终态「done」断言,
   想 park 的 Runner 不得报 completed。

## 6. 失败兜底链 — marker 重发(Q2 答案)

`complete` fail-close 写的 marker 由 **FLY-172 boot drain** 承接:
`packages/teamlead/src/bridge/complete-marker-reconciler.ts`(plugin.ts:4693 在 Bridge 启动时调用)——
replay 走 loopback `/events`(与在线路径同一套 guard/FSM/finalization),
删 marker 前 verify terminal status,坏 marker 进 `complete-failed-quarantine/`。
→ 探索 §5.1 的「本 PR 不实现重发」缺口**已由 FLY-172 闭合**。

## 7. 测试覆盖(现存;锚点经二次核对修正)

- `packages/flywheel-comm/src/__tests__/complete.test.ts` — 发射侧(payload shape / 校验 / retry / marker)
- `packages/teamlead/src/__tests__/event-route-session-completed-guard.test.ts` — guard 行为(空/foreign
  route skip;**不含** approved_to_ship 豁免场景——该场景的证据在下一条 dual integration test 的 Scenario D/D2,
  复审 R1 D1-04 纠正)
- `packages/teamlead/src/__tests__/event-route-dual-session-completed.integration.test.ts` —
  **HTTP `/events` sink** 的完成事件场景矩阵(Scenario D: undefined route;Scenario E: blocked 等)。
  注意:该测试**只覆盖 HTTP sink**,不实例化 DirectEventSink——不能当「双 sink parity」证据引用;
  它 mock 了 `runPostShipFinalization`,证明的是 predicate/FSM 之后的调用次数,不是 claim 的原子性。
- `packages/teamlead/src/__tests__/post-ship-finalization.test.ts:320-459` — **atomic claim 的
  exactly-once 真证据**(「archive + remove-user each happen exactly once (orchestrator claim)」+
  重试场景下 claim 去重)。
- `packages/teamlead/src/__tests__/cipher-bridge-e2e.test.ts:204+` — 「FLY-108: Runner-driven emit
  backfills labels from session_started StateStore」(Decision 6 的直接证据)。
- (勘误 + **as-built 行为分歧 + 覆盖缺口(G3)**:早稿引用的 `DirectEventSink.test.ts:798-841` 锚点已漂移——该行段
  现在测 phase-role preservation;且当前 `DirectEventSink.test.ts` 套件(FLY-191 / terminal-immunity /
  no-code / phase-role 各族)里**没有**可直接指认的 FLY-108 parity 用例。更重要的是 §2 核实的
  **行为本身未对齐**(DirectEventSink 对空/foreign route 仍宽松 fallback),所以这不是单纯「缺用例」,
  而是「行为分歧 + 缺用例」,补齐属实现域 follow-up——与 plan D5 / §5 对应行 / DoD §8.5 的缺口记录一致。)

## 8. 调研结论

1. 探索 §3 的方向选择(Option 1 主修 + 严格 guard 辅修 + W2 有限 fallback)与落地实现一致,
   且两年半的后续迭代(FLY-120/172/191/208/222/493/793/869/945)都在这套「Runner 单一事实源 +
   Bridge fail-loud 校验」的骨架上生长而未推翻它——方向经受住了演化检验。
2. 残余缺口核实:
   - marker 重发 → **已闭合**(FLY-172,§6)
   - GEO-362 pre-state 之谜(approve 没转 approved_to_ship)→ 仍是 FLY-58 territory,out of scope 维持
   - QA session role 完成信号 → **FLY-108 本体**的 complete 接线只用 `main`(原始 scope 陈述);
     现系统里只报 stage=completed 的 no-PR/QA Runner 已由 FLY-324 live fallback 终态化(§5.3),
     role 级 close_runner 消歧仍由三段式 QA(FLY-859 族)承接
   - **复审 R1 新核实的三处 as-built 缺口**(plan G1-G3):spin.md needs_review 位点未接 gate/question-id(§1.2);
     主路径 `--pr` 无正整数 fail-close(§1.1);DirectEventSink 空/foreign route 宽松 fallback = 行为分歧(§2、§7)
3. plan 阶段的产出物:以归档 plan(v1.23.0,Codex 3 轮 APPROVED)为蓝本的 implementation-ready 设计,
   叠加本 HEAD 的 as-built 核对表与残余缺口清单。
