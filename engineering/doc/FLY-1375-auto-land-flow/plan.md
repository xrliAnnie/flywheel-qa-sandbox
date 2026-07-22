# FLY-1375 Ship 后全自动收尾 — land 流程 — 实施计划

Issue: FLY-1375 (https://linear.app/geoforge3d/issue/FLY-1375/ship-自动化-founder-说-ship-后全自动收尾-land-流程cool-merge-清-worktree-关全部)
日期: 2026-07-21
基于: research.md
Codex design review: **5 轮 APPROVED**(R1 七项 + R2 五项 + R3 三项 + R4 三项全采纳)。R5 实施边界备注:① engine-only GateAuthorityView 必须由 snapshot variant + engine ownership **双重判定**,不得仅凭 question shape 猜测;② feedback 的「retire question/card」实现为可验证的 durable authority retirement(CommDB response 已回答 + StateStore current-holder/card binding 已撤销),不得重新引入跨 StateStore/CommDB/Discord 的伪原子事务。

## 0. 一句话

把「founder 批准之后的一切」(:cool: merge → cleanup 钩子 → 关该单全部 session → 清 worktree → Linear Done → thread archive)收编为 **schema-v1 工程 DAG 模板**的最后一个节点 **land**,由引擎执行并持扳机;收尾原语复用现有代码,本单新增四块硬骨头:**引擎执行节点形态(带可判别 manifest variant)、gate materialization 合同(engine run 的 founder ship card 今天没人发)、land_operation 独占执行权(lease/fencing)、resumable finalization(替换 once-claim,含 consumer 迁移矩阵)**。

## 1. 目标 / 非目标

**目标**(issue 能力级验收,②按 R1-4 精确化):
1. founder ✅ 批准后零人工介入:merge(🆒 sanctioned)→ worktree 消失 → 该单全部 session 关闭 → issue Done → thread archived。
2. 故意留 stale session → land 照样收掉。**精确语义**:pane absent / dead_pin(进程实际已死)→ 收掉;**live-but-stale** resident Codex controller → 不硬杀(FLY-1269 安全合同不动),land 记 `partial` + escalation。
3. 烂 worktree 场景:land 后同分支新 runner 干净起。
4. 全程 Discord thread 链路播报。

**非目标**:
- 不改 founder 批准语义(✅ reaction + 六轴 + founder-only-authority 全保持)。
- **范围限 schema-v1 工程模板**;v2/product「无 PR merge tail」现状不动。
- 不为 legacy 在飞单造第二套自动扳机 — legacy 走 Lead 人肉 1338 范式(显式 land 入口 + runbook 服务它)。
- 不动 FLY-1369 / Discord 显示重渲染。
- 不改 resident Codex phase shutdown 安全合同。
- 不改 ship-on-comment 的 permission / CI / merge **语义**(允许一处纯审计 correlation 增强,见 D3;R2-5)。

## 2. 核心架构决策

### D1. land = 新「引擎执行节点」形态 + 可判别 manifest variant(R2-4)

新增第三种节点形态 `land`(engine-executed,不 spawn session)。**不无版本地替换 v1 shape**:

- v1 parser 支持两种**不可混用**的 variant:legacy variant(现 `terminal_gate` vocabulary,逐字节保持)与 land variant(`approval_gate` + `terminal_node` 字段,land 节点必需 engine-executed 标记)。判别字段显式(如 `manifest_variant: land_v1`),混用即校验失败。
- **旧 snapshot 按原字节 vocabulary 解析、digest 不变**(`workflow-run-snapshot.ts:270-310,450-473` 会重跑 live validator + 重算 digest — legacy variant 分支保证旧 snapshot 永远走旧路径);新 capability(`can_request_ship_approval`)与 engine-executed 字段只在 land variant 必需,legacy capability keys 严格校验不动(`:229-266,326-382`)。
- **PR-1 不改 bundled seeds**(seeds 加载即过 validator,`workflow-template.ts:1085-1115` — legacy variant 分支让现有 seeds 原样通过);**land seed 用新 template IDs**(如 `tpl_eng_heavy_land_v1`,revision 1)在 PR-3 引入(R3-2:`importWorkflowTemplateSeed` 对同 template_id 内容变化会立即 publication + 更新 `current_published_revision`,而 binding 只存 template_id 不 pin revision — 同 ID 加 revision 等于隐式全量切换,违反「不切 binding」承诺)。现有 binding 零改动;真机 E2E 经显式 template override 选 land 模板;cutover = 之后的显式 rebind 动作。
- PR-1 验证:未改 seeds 全量加载 + 真实旧 snapshot fixture 解析 + digest 不变哨兵。

### D2. gate materialization:durable staged convergence(R1-3 + R2-1 + R2-2)

**现状事实**:generalized/QA execution 跳过 `approve_to_ship` checkpoint(`Blueprint.ts:1520-1539,2075-2088`);`gate_opened` 只是一条 run event,**全仓无运行时消费者**创建 question/card — engine run 的 founder 批准面今天是断的。且 engine-owned implement 在 `commitEnrolledCompletion` 后被无条件写 `completed`(不可逆终态,`StateStore.ts:17109-17153,17228-17281`),**不能**当 gate holder(R2-1)。

**合同**(PR-2 落地):
- **canonical ship authority = first-class `workflow_gate_holder` 记录,与 session status 解耦**(R3-1):qa PASS 同 tx 把 QA node 写 `done` 后,dead-exec reconciler 不再扫它(只扫 running node,`workflow-engine-dispatcher.ts:430-455`),且 agent teardown 会无条件覆盖 session status(`StateStore.ts:15682-15708`)— 把 authority 挂在 QA session 的可变 status 上没有恢复路径。改为:`workflow_gate_holder` 表以 gate identity `(run, gate_node, attempt, head)` 绑定 QA execution(仅来源归属)+ head + question + card,**自身状态机 `materializing → awaiting_review → approved | superseded`**,verifier(engine 路径)与 ship decision 读它;QA session 死亡/teardown 不抹已提交的 QA/gate authority。**在 QA decision transition 的同一 StateStore tx 内**创建 holder 行 + deterministic question intent(gate_opened 与 holder 原子同生)。legacy verify-approval 路径逐字不动。
- **不宣称原子;建模为 durable staged convergence**(R2-2):identity = `(run, gate_node, attempt, head)`,阶段 receipt ≥ `question_intent → question_written → session_bound → card_posted → card_bound → completed`。CommDB gate writer 扩展支持 **caller-supplied deterministic question id(或 insert-or-verify digest)**(现每次随机 UUID,`gate.ts:107-140`,重启找不回同一 question);Discord card 显式 at-least-once,**只有 current bound card 可授权**(`(question, head) → gateMessageId` 绑定沿用,`gate-poller.ts:2523-2644`);每相邻阶段之间补 crash 测试。
- **founder approval 的第二窗口**(R2-2):trusted response + `workflow_source_event` 在 CommDB tx 提交后、StateStore post-write hook 翻 `approved_to_ship` 之前进程退出(`write-gate-response.ts:368-450`)→ claim 可投影而 holder 仍 `awaiting_review`。修法:StateStore 侧 apply 在**一个 StateStore transaction** 内完成 holder status projection + founder claim + land intent,并提供启动 post-write repair;land 对「response 已 durable、projection 未完成」**retry/reconcile,不是 held**。
- **GateAuthorityView(engine-only ingress adapter,R4-1)**:holder 建了还不够 — 现有 founder ✅ 全部入口都按 session status 拒绝(reaction handler 要求 `session.status==="awaiting_review"`,`founder-reaction-approval-handler.ts:84-107`;text handler 初筛 + TOCTOU recheck 同,`founder-ship-approval-handler.ts:208-222,486-505`;共享 writer 写 response 前拒非 awaiting/approved session,`write-gate-response.ts:252-280`;deferred rebind 用 session binding 判 gate 存活,`deferred-approval.ts:537-579`)— QA teardown 后 ✅ 会在写入前被丢。新增 engine-only `GateAuthorityView` adapter:按 question id 解析唯一 current `workflow_gate_holder`,校验 holder state / head / current card / founder attribution;**reaction、text、direct/consent writer、deferred rebind、card authority 在 engine-owned land variant 上统一读它**(GatePoller/plugin wiring 同步);legacy 分支逐字读 session。四个 ingress 文件全部列入 PR-2 改动面。
- **founder reject/feedback 收敛路径(R4-2)**:engine-owned QA 被 `PhaseOrchestrator.onQaResult` 排除(`phase-orchestrator.ts:1178-1183`),QA node 已 done、credential 已消费 — 旧「唤醒 QA 发 FAIL 进 fix-loop」不可用;holder 若只有 approved|superseded,reject 会造成 answered-but-awaiting 永久卡死。合同:可信 reject(`{approved:false, feedback}`)写 durable source event → StateStore 单 tx 把 current holder 标 `superseded(reason=founder_feedback)` + 退休 question/card + 旧 head authority 不可再用 + 经 **land-variant-only `founder_feedback_kickback` edge**(approval_gate → implement loop,模板校验器放行)激活新 Implement attempt;后续 QA PASS 建新 attempt/head holder(保持与 three-stage 现有 feedback loop 行为等价,不降级为 held)。crash tests:feedback source durable 但 StateStore 未 apply / kickback 后新 dispatch 前重启 / 旧 card 在新 holder 出生后无法批准。
- 能力字段:`can_request_ship_approval` 与 `can_ship` 拆分。
- 测试:stale/superseded gate、QA retry 后新 head(gate identity 含 attempt,旧 holder → `superseded` 重建)、materialization 各阶段间重启、`implement_done → qa → gate_opened → holder materializing → awaiting_review → approved` 全链真实 FSM/holder 集成测试;**两个必测 teardown 窗口**(R3-1):`qa_pass/gate_opened committed → materializer 首 tick` 之间 QA teardown;`session_bound → founder response` 之间 QA teardown — 两者下 holder authority 均存活、founder 批准链不断。**ingress 端到端测试**(R4-1):从「QA 已 teardown + founder 在已绑定 card 上点 ✅」出发,穿过 reaction poller → CommDB response/source → holder `approved` + claim + 同一 land operation;text reply 与 response-loss/deferred rebind 各一条 parity test — 不允许只直调 StateStore projector。

### D3. merge 驱动权移交:引擎代发 :cool:,at-least-once + run correlation(R1-2 + R2-5)

- land 执行体第一段:
  1. **前置验证**:`computeAuthoritativeShipDecision`(authoritative head + engine claims + 经 D2 canonical execution 的六轴)。不通过 → 区分「authority 缺失」(held + escalation)与「projection 未完成」(retry/reconcile,见 D2)。
  2. **merge 驱动**:PR 已 MERGED(`headRefOid`/`mergeCommitOid` 证据)→ 跳过;否则引擎发 `:cool:` PR 评论 → sanctioned workflow 照常 → poll。
  3. **:cool: = at-least-once trigger**:双评论无害(workflow per-PR concurrency + SHA-pinned merge + 已 merged 拒绝);记录自己 POST 返回的 comment id。
  4. **run correlation(R2-5)**:`ship-on-comment.yml` 加一处**纯审计增强**(不改 permission/CI/merge 语义,文件列入 PR-2 改动面):最早可执行步骤发布 `{trigger_comment_id, run_id, run_url, full_head_sha}` receipt(评论形式),success/failure/早期 permission-draft-fork 失败全部引用同一 identity 且皆有终态 receipt。land 以自己的 comment id 等待对应 receipt → 查**该 run** 的 conclusion 判失败(→ held + escalation),不看「PR 仍 OPEN」也不会被别的 run 失败误伤。测试:双 :cool:、一失败一运行/成功、receipt 前 crash、五个 crash 窗口(crash-before-comment / comment-success-before-receipt / workflow-running / workflow-failed / merged-before-receipt)。
- **Runner ship 舞蹈退役(仅 engine-owned run)**;legacy Blueprint 舞蹈逐字保留。
- **授权论证**:founder ✅(head-bound)即授权「merge 该 head + 其必然收尾」;现有 finalization 先例已立;merge 前验证一步不少。

### D4. land_operation:独占执行权 + 恢复(R1-2)

durable **`land_operation`** 表,keyed `(issue, project, pr, approved_head)`:owner/lease/generation fencing(参照 agent-launch owner lease 协议,`workflow-engine-dispatcher.ts:867-925`);单 owner 有效 generation 下推进,stale owner 可接管;source projector / HTTP / reconcile 竞争者全经 operation 收敛。per-step durable receipt,重启从最后 receipt 续跑。land 节点不进「换 execution_id 重派」;`reconcileDeadExecutions` 对 land 型走「operation 续跑/接管」分支;卡死 → run `held` + `workflow_engine_escalation`。reconcile 三兜底保留,经 operation 去重。

### D5. resumable finalization + consumer 迁移矩阵(R1-1 + R2-3)

**现状事实**:`runPostShipFinalization` once-claim 先写、失败只记日志、重复调用直接 return、reconcile 跳过已 claim → claim 后崩溃 = 永久不收尾;且现有顺序先删 worktree 再 closeout。

**改法**(PR-2,legacy 触发/授权/Blueprint 不变;finalization 内部恢复与顺序是**有意改变**,不宣称内部 bytes 不变 — D8 表述已相应修正):
- 分阶段 durable 操作(状态 `claimed/running/partial/completed`,owner/lease/generation 挂 land_operation;legacy 调用路径给独立 operation 行),各步独立 receipt + 可验证后置条件;返回结构化 `ClosureReport`;`land_finalized`/`run_completed` 只在全部强制 postcondition 重读确认后写入。
- **顺序修正**:issue-level closeout(全 session 关闭确认)先于 worktree 删除。
- **三个 durable facts 拆分**(R2-3):`merge_confirmed`(禁止再 spawn、允许进入 cleanup)/ `finalization_partial|running`(继续 reconcile + UI 显示收尾中)/ `finalization_completed`(允许 terminal badge、shadow/run completed)。旧 `post_ship_finalization_claim` 保留为兼容 evidence,**不再兼表 started+completed**。
- **consumer 迁移矩阵**(全部列入改动面):

| reader | 现读 claim 作 | 迁移后读 |
|---|---|---|
| `HeartbeatService.ts:2271-2309`(parked phase 自动回收授权) | claim 存在 | `merge_confirmed` |
| `phase-orchestrator.ts:410-423` + `plugin.ts:8403-8410`(防已 merge 再 spawn Implement) | claim 存在 | `merge_confirmed` |
| `issue-display-refresher.ts:390-412,667-679`(shipped/final 显示) | claim 存在 | `finalization_completed`(partial 显示「收尾中」) |
| `workflow-shadow-writer.ts:550-568,678-690`(startup 见 claim 即 finalize run) | claim 存在 | `finalization_completed` |
| `StateStore.ts:19994-20010`(run-attributed claim 查询)+ `external-merge-reconcile.ts:624-636`(跳过) | claim 存在 | operation 状态(partial → 续跑不跳过) |

- **启动 backfill**:旧 claim 存在但 postconditions 不全的 live legacy issue → 建成 `partial` operation 续跑(而非继续跳过);postconditions 全 → 标 completed。

### D6. cleanup 钩子(断点⑤)

关前给每 session 有界收尾机会:resident Codex phase 走已有 request/ack(30s,合同不动);Claude/普通 session 新增 best-effort mailbox shutdown 通知 + 短有界窗(默认 30s,env 可调),超时照关 — fail-safe 向「关」收敛。live-but-stale 见目标 2(partial + escalation)。

### D7. 显式 land 入口(R1-5)

`POST /api/lifecycle/land`:只持久化 intent,**202 + operation_id**,fenced worker 推进;重复请求返回同一 operation。canonicalize issue UUID/identifier;**engine run 解析 current `workflow_gate_holder` record、legacy run 解析现有 session authority,两者进入同一 worker authorization result**;PR/head 显式 mismatch 拒绝。授权在 worker 内重验(founder attribution + bound question/head + claims);API token 不是 ship authority;reserved-metadata 不依赖(resolver 只覆盖 action-router/close mounts)。配套 operation 状态查询 + 安全重跑。产出 `land-runbook.md`(1338 范式成文:Lead 人肉 land = 调入口 + 核对四件事)。

### D8. byte-compat 红线与激活顺序(R1-7 + R2-4)

- 生产 dispatch OFF,全部在飞单 legacy;**legacy trigger / approval / Blueprint 逐字不变**;finalization 内部按 D5 有意改变(哨兵改测:legacy 路径的对外可观察行为 — 触发条件、每步效果、UI facts — 等价或显式改进,逐条列出)。
- `FLYWHEEL_LAND_NODE` 默认 OFF。**flag/snapshot matrix 的期望行为**(不只是测试项):

| 情形 | 期望 |
|---|---|
| 旧(legacy variant)snapshot,flag 任意 | 走旧 seam,逐字现状 |
| land snapshot,flag ON | 全链 land |
| land snapshot,flag 在 QA 前/后关闭 | fail-closed 停在 approval_gate(gate 照 materialize,批准后不推进 land)+ escalation 指向 **runbook 恢复合同**(见下) |
| land snapshot,founder 批准后关闭 | 已激活 operation 续跑完(不半途丢);未激活 → 同上停在 gate |
| flag OFF 时 dispatch entry 选 land 模板 | 拒绝 materialize(fail-loud) |
| flag OFF 时调 land endpoint | 503,不写 intent |

- **flag-off 恢复合同**(R3-3,runbook 成文,消除「escalation 指向 503 端点」自相矛盾):恢复路 **A**(land 本身健康,flag 因误关/演练关闭)= 显式重开 `FLYWHEEL_LAND_NODE` → 确认 worker 健康 → 调 land endpoint,收敛到**同一** operation;恢复路 **B**(land 止血期间,不重开 flag)= runbook 人肉逐步章节(1338 范式:人肉发 :cool: / lifecycle-apply / close-runner --done / 核对四件事),不依赖 land endpoint。**operator recovery E2E**:flag-off held run 按 A 路从 503/held 收敛到同一 operation。
- PR-3 引入 land seed(新 template IDs),默认 binding 不切换;真机全链过后 cutover/default ON 单独决定。
- **最终切片验收(Lead design-review 绑定备注,default-enable 铁律)**:`FLYWHEEL_LAND_NODE` 默认 OFF **只是切片期脚手架** — 最终切片必须**默认 ON 交付**,或把「不开」的决定显式呈 founder 拍板;「做了不开 = 没做」。PR-3 验收含此项。

## 3. 流程图

```mermaid
flowchart TD
    QA[qa 节点 PASS] -->|qa_pass edge| FG[approval_gate 开门 gate_opened]
    FG -->|gate-materializer D2<br/>staged convergence<br/>workflow_gate_holder source_execution=QA| CARD[founder ship card<br/>current bound card 唯一可授权]
    CARD -.founder reject+feedback.-> KB[holder superseded<br/>founder_feedback_kickback<br/>→ 新 Implement attempt]
    CARD -->|founder ✅ head-bound<br/>单 tx: projection+claim+land intent| LAND[land 节点激活<br/>land_operation lease/fencing D4]
    subgraph land 执行体(per-step durable receipt)
        V[computeAuthoritativeShipDecision] --> M{PR 已 MERGED?}
        M -->|否| C[引擎发 :cool:<br/>at-least-once,记 comment id] --> P[等 correlation receipt<br/>查该 run conclusion]
        M -->|是| H[cleanup 钩子 D6]
        P --> H
        H --> F[resumable finalization D5<br/>closeout 全关确认→清 worktree→分支删<br/>→archive→Linear Done→sweep<br/>facts: merge_confirmed/partial/completed]
    end
    LAND --> RC[postcondition 复核 → run_completed]
    V -.authority 缺失.-> HELD[run held + escalation]
    V -.projection 未完.-> RETRY[retry/reconcile]
    P -.该 run failed/超时.-> HELD
    F -.partial.-> PART[partial fact<br/>reconcile 三兜底接盘]
```

## 4. 改动面(文件级)

| # | 文件 | 改动 |
|---|------|------|
| 1 | `packages/config/src/node-type-registry.ts` | 新 type `land`;`can_request_ship_approval`/`can_ship` 拆分(land variant 专用) |
| 2 | `packages/teamlead/src/workflow-template.ts` | v1 双 variant parser(legacy 逐字节保持;land variant 校验) |
| 3 | `packages/teamlead/src/workflow-run-snapshot.ts` | legacy snapshot 原 vocabulary 解析 + digest 不变;land variant 固化 |
| 4 | `packages/teamlead/src/StateStore.ts` | `land_operation` + `workflow_gate_holder` 表;QA decision tx 内同生 holder+question intent;v1 founder source 单 tx(holder projection+claim+intent);`commitWorkflowTransitionTx` land 型 `land_activated`;run-attributed 查询迁移 |
| 5 | **新** `bridge/gate-materializer.ts` | D2 staged convergence(deterministic question id + card at-least-once + holder 迁移) |
| 6 | `packages/flywheel-comm/src/commands/gate.ts` + `db.ts` | caller-supplied question id / insert-or-verify |
| 7 | **新** `bridge/land-executor.ts` | D3/D4 状态机 + thread 播报点 |
| 8 | `bridge/workflow-engine-dispatcher.ts` | land 非-spawn 分支;dead-exec land 续跑/接管分支 |
| 9 | `bridge/post-ship-finalization.ts` | D5 resumable 化 + 三 facts + 顺序修正 |
| 10 | `HeartbeatService.ts` / `bridge/phase-orchestrator.ts` + `plugin.ts` / `bridge/issue-display-refresher.ts` / `bridge/workflow-shadow-writer.ts` / `bridge/external-merge-reconcile.ts` | D5 consumer 迁移矩阵逐点 |
| 11 | `bridge/approval-signal/`(`founder-reaction-approval-handler.ts` / `founder-ship-approval-handler.ts` / `write-gate-response.ts` / `deferred-approval.ts`)+ GatePoller/plugin wiring | GateAuthorityView ingress 接入(engine-owned 读 holder;legacy 逐字);founder source 第二窗口修复(单 tx / post-write repair);reject → holder superseded + kickback |
| 12 | `bridge/lifecycle-routes.ts` | `POST /api/lifecycle/land`(202+operation_id)+ 查询 |
| 13 | `packages/edge-worker/src/Blueprint.ts` | engine-owned 舞蹈退役(legacy 不动) |
| 14 | `flywheel-comm` db + Bridge 调用点 | 通用 mailbox shutdown 通知 + 有界窗 |
| 15 | `.github/workflows/ship-on-comment.yml` | 纯审计 correlation receipt(语义不变) |
| 16 | `packages/config/src/feature-flags/registry.ts` | `FLYWHEEL_LAND_NODE`(默认 OFF) |
| 17 | 文档 | `land-runbook.md` |

## 5. 实施切分(3 个 PR,激活顺序按 D8)

- **PR-1 骨架(不激活)**:#1-#4、#8 land 分支、#16。schema 双 variant + ledger + executor skeleton + 单测(未改 seeds 全量加载、旧 snapshot fixture digest 不变、land_operation lease/接管、receipt 续跑);不改 seed、不从 founder source 激活、不调 finalization。
- **PR-2 能力(仍不激活)**:#5、#6、#7、#9、#10、#11、#13、#14、#15。gate materialization(staged convergence + FSM 全链集成测试)+ authoritative eligibility + :cool: driver(correlation + 五窗口)+ resumable finalization(consumer 矩阵迁移 + backfill)+ cleanup protocol;legacy 对外行为哨兵。
- **PR-3 入口 + 模板 + 真机**:#12、#17、land seed(**新 template IDs,revision 1,现有 binding 零改动**)、flag/snapshot matrix 全表、隔离房真机 E2E 四条验收。

## 6. 验收对照

| issue 验收 | 验法 |
|-----------|------|
| ① 批准后零人工全链 | 隔离房 engine-owned run:✅ → :cool: merge → worktree 消失 → session 全关 → Done → archived,无人碰 |
| ② stale 照收 | absent/dead_pin husk(含 awaiting_review)→ gone;live-but-stale → partial + escalation;E2E 覆盖 absent / indeterminate / live-stale / ACK success / ACK timeout |
| ③ 烂 worktree 后新 runner 干净起 | land 后同分支再派单(land 主删 + FLY-99 pre-create 双防线) |
| ④ thread 链路播报 | 播报点:激活 / merge 确认 / 收尾各步 / 完成或 partial;对照消息序列 |

## 7. 风险与开放问题

1. **引擎 gh 身份**:同机同 gh auth,权限 gate 等价 — PR-2 真机验证;播报注明 engine-driven。
2. **cleanup 窗实际价值**:30s 兜轻动作;v1 接受 best-effort。
3. **批准后可见性**:thread 播报 + operation 查询覆盖「批了没反应」观感。
4. **生产生效依赖 DAG cutover**(FLY-1396 排期);过渡期价值 = land 入口 + runbook 立刻可人肉使用。
5. **gate holder 生命周期(R3-1 修订)**:authority 在 `workflow_gate_holder`,QA execution 只是来源归属 — QA 在 gate 打开后死亡**不**触发重派(dead-exec 只扫 running node,QA node 已 done),也**不**影响已提交 authority;holder 自身状态机负责 supersede/重建(QA retry 新 attempt 时)。teardown 两窗口测试见 D2。
