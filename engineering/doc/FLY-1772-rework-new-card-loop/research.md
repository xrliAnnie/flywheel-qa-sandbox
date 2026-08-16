# FLY-1772 打回后返工闭环出新卡 — 调研

Issue: FLY-1772 (https://linear.app/geoforge3d/issue/FLY-1772/bug-打回后的返工闭环必须出新卡打回-返工新-head-自动出新卡旧卡作废不再接受操作founder-8-14-裁定版)
日期: 2026-08-14
基于: exploration.md

## 1. 现状全链审计(代码位点,基于 branch head = origin/main `59e8bd645`)

### 1.1 打回落账(founder_feedback apply)— 机件完整

founder 打回(文字/reaction/voice 全部通路)→ `writeGateResponseAndRunPostWrite`(`approval-signal/write-gate-response.ts`,唯一可信写原语)→ CommDB `insertFounderApprovalResponseWithSource`(`flywheel-comm/src/db.ts:1842-1916`):answerable 守卫(问题未 resolved/superseded/无 response/`relay_state != terminal_disposed`)通过后,**同事务**落 mailbox response + `markQuestionTerminalDisposed` + `workflow_source_event`(kind 按 `approved` 分类 `founder_approval`/`founder_feedback`)。

投影侧 `applyWorkflowSourceEvent` 的 `founder_feedback` 分支(`StateStore.ts:31933-32175`):

1. 校验 run active、engine_owned、snapshot、`run.current_node_id === gateNodeId`、kickback loop 存在(`:32007-32031`);
2. holder 校验(`awaiting_review` + head 匹配 + `card_message_id` 非空,`:32039-32053`);
3. **同事务**:holder → `superseded`(reason=`founder_feedback`,`:32055-32065`)+ ship target binding supersede + runner_ship carrier park `ship_parked`(`:32072-32092`)+ `commitWorkflowTransitionTx(outcome=founder_feedback_kickback)`(`:32093`)。

kickback 转移(`commitWorkflowTransitionTx`,`StateStore.ts:30094+`)建 rework request(authority=`founder`,legacy 默认 target=implement,verification policy `[code_review, qa_retest, founder_gate]`,`:30699-30705`)+ route revision + delivery(pending)+ verification path。

**实现期复核补充:**上述机件在 legacy/测试 manifest 中成立,但以真实 `menus/shapes/code.yaml` 经 `importWorkflowMenuSeeds` 编译后发现,生产 `tpl_code` 当时只有 `qa_fail → implement` loop,缺少 `founder_feedback_kickback → implement` loop。因此 founder 打回在 source projector 的 run-state/kickback-loop guard 直接失败,并不会进入已有返工机器。FLY-1772 必须同时把 founder-rework loop 加入 code menu,否则“整环测试”无法从真实 compiled template 起步。

### 1.2 返工投递与验证链 — FLY-1765(#837,2026-08-14 12:45 PT merged)已修

- 打回 rework 与 QA-FAIL rework **共用**同一 coordinator/delivery 机器(`workflow-rework-coordinator.ts` reconcile → wake/replace)。
- FLY-1765 Fix 1:land-authority run 的 implement 体完工投 `ship_parked`(park reason `rework_reachable_wait`)→ wake 闸可复活;Fix 2:不可逆终态 actor 受控收体 → proven-dead replacement(generic 单阶段 founder rework 明确走此降级,1765 plan §2 有意取舍)。
- 链式验证:implement 返工完工 → chained rework(`verification_path_next_step`)→ qa_retest → QA 重判新 head PASS → 转移 qa→gate,verification path → `completed`(`StateStore.ts:30949-30988`)。

### 1.3 gate 重入建新 holder — 机件完整

转移目标为 gate 时(`StateStore.ts:30827-30909`):

- `gate_carrier_epoch === 1` → `createWorkflowGateHolderTx`(`:32717-32930`):旧 holder 全部 → `superseded`(reason=**`new_gate_attempt`**,`:32828-32836`)+ 新 holder(`materializing`/`question_intent`,新 head)+ evidence 冻结 + runner_ship carrier 绑定(unbound 时已有 `gate_carrier_unbound` 告警,`:32904-32926`)。
- terminal-land manifest(FLY-1655 后生产常态)→ 同形:supersede 旧 holder + 新 holder 绑新 head(`:30857-30908`),head 必须 40-hex 否则 throw `land_gate_holder_requires_head`。

**注意:两处 supersede 都只改 DB 状态,旧卡的 Discord 卡面零变化 —— D2 的缺口在此。**

### 1.4 新卡 materialize — 机件存在,失败静默(D1 缺口 α)

`workflowGateMaterializeTick`(`plugin.ts:7196-7263`,GatePoller 周期驱动)→ `listWorkflowGateHoldersForMaterialization(20)`(`StateStore.ts:38888-38907`,选 `materializing`/未完成 + run active + carrier bound)→ `materializeWorkflowGateHolder`(`gate-materializer.ts:60-199`,六阶段 durable:question_written → session_bound → card_posted → card_bound → completed,经 `emitFounderThreadNotification` 发卡)。

**缺口 α:tick 的 catch 只 `console.warn`(`plugin.ts:7253-7257`)。** holder 卡在 `materializing`(thread 找不到 / Discord 持续失败 / carrier unbound 之外的任何原因)会被每 tick 重试且**永远无人知晓** —— 打回→返工闭环即使全通,最后一米(发卡)断了 founder 照样白等,与本次事故同形。`created_at ASC` 排序保证卡住的 holder 一直被扫到,但无告警出口。

### 1.5 旧卡上的 founder 输入 — 两扇门,都静默

- **前门(CommDB 写拒绝)**:打回落账时 `markQuestionTerminalDisposed`,同卡后续任何输入在 `insertFounderApprovalResponseWithSource` 的 answerable SELECT 直接落空 → 返回 false → 零 source event、零痕迹。FLY-1560 卡上打回后的 ✅ 属此形态。
- **后门(projector deadletter)**:问题仍 answerable(FLY-1757 普查的 22 张存量卡即此形态:run 已走/换代但 question 未 disposed)→ source event 写成 → `applyWorkflowSourceEvent` 抛 `source payload invalid` 家族(`run state`/`gate holder`/`subject` 等,`StateStore.ts:32030/32050/32196/32267`)→ `drainWorkflowSourceEvents` 判 terminal(`founder-approval-projector.ts:68-72`)→ `recordWorkflowSourceDeadletter` + **仅 `args.log`**(`:129-147`)。**D3 缺口:founder-origin 死信零告警。**

✅ 在当前合法卡上(阳性通路):`founder_approval` apply → founder_decision claim + holder → `approved` + land 转移(`:32199-32299`)—— 本单零改动,回归钉死。

### 1.6 卡面编辑与告警的既有原语(复用面)

| 原语 | 位点 | 状态 |
|---|---|---|
| Discord 卡面编辑 | `editDiscordMessageInChannel`(`discord-utils.ts:201-238`,PATCH 单 chunk,404 可区分) | ✅ 已存在(FLY-887) |
| 卡片 thread/message 绑定 | `gate_message_binding`(write-once per (question, head),`gate-message-binding-store.ts`)+ holder.card_message_id | ✅ 已存在 |
| durable 引擎告警 | `enqueueWorkflowEngineAlert`(`StateStore.ts:25651-25668`,`workflow_alert_outbox`,escalation_uid 幂等去重)→ dispatcher `reconcileWorkflowEngineAlerts`(`workflow-engine-dispatcher.ts:1624+`)投 Lead | ✅ 已存在 |
| Lead 直投告警 | `leadAlertNotifier` / `routedAlertSinkHolder`(plugin.ts,eventId 去重) | ✅ 已存在 |
| Lead/bot 解析 | `resolveLeadForIssue` + `lead.botToken ?? config.discordBotToken`(materializer tick 同款) | ✅ 已存在 |

## 2. 断点结论(与交付映射)

| 断点 | 现状 | 交付 |
|---|---|---|
| 打回→返工→gate 重入→新 holder | 底层机件存在,但真实 compiled `tpl_code` 缺 founder-rework loop;FLY-1560 当天还叠加 1765 可达性问题;**从未作为整环被端到端验证** | D1(补 menu loop + 整环回归钉死) |
| 新 holder → 新卡(最后一米) | materialize 失败仅 console.warn,永久卡 `materializing` 无人知 | D1 缺口 α(fail-loud) |
| 旧卡卡面 | supersede 只改 DB,卡面仍是"可操作的脸" | D2 |
| 旧卡输入·前门 | CommDB 写拒绝,静默 | D2 治本(卡面作废 → 不会去点)+ 明确不做回执(founder 裁定) |
| 旧卡输入·后门 | projector 死信仅 log | D3 |

## 3. 前科与不变量(修法边界)

| 前科 | 约束 |
|---|---|
| FLY-1655 terminal land | approval gate → engine-owned land 不变量零改动;holder 生命周期语义(materializing/awaiting_review/approved/superseded)零新状态 |
| FLY-1765 | 返工可达性已修,本单**不重做**;E2E 回归以真实 compiled `tpl_code` 为基座,并补齐实现期发现的 founder-rework menu loop |
| FLY-1757(Backlog) | 同 head 去重发卡 + 交付失效 —— 不在本单做;D2 的卡面作废原语按可复用形态设计(supersede 触发之外,1757 可加 delivery-landed 触发) |
| FLY-1448(pending ship) | founder 决定投递链(receipt/dead-letter/wake)正交;本单不碰其 seam |
| FLY-1466 | 不加新 env/flag |
| FLY-1731 | completion_disposition / immutable holder authority 语义不动 |
| 终态免疫(FLY-1228/1229) | 不开终态复活边;D1 不触碰 session 生命周期 |
| Founder 裁定(1757/1772) | 旧卡不复活、不做点错回执、不搞复杂 |

## 4. 修法候选空间

### D1 — 闭环可靠

**候选 A(推荐):fail-loud 补最后一米 + 整环 E2E 钉死。**
- α:materialization 卡住告警 —— tick 内对 `materializing` 超龄 holder(`created_at` 距今 > 阈值,复用 tick 周期自然节流)`enqueueWorkflowEngineAlert`(escalationUid=`gate_materialization_stuck:${question_id}`,outbox 幂等 = 每 holder 恰一次);holder 完成后自然停。零新表、零新 timer。
- β:整环端到端回归(真实 compiled manifest):打回 → holder superseded + kickback → rework 投递 → implement 新 head → qa_retest PASS → gate 重入新 holder(新 head)→ materializer 发新卡 → 新卡 ✅ → 正常入账 land。含阴性:纯 ✅ 无打回零回归。
- 不引入任何新「重发机制」:发卡的 at-least-once 收敛机器已存在(六阶段 durable + 每 tick 重试),缺的只是失败可见性。

**候选 B(否):引擎加「打回后 N 分钟必须出新卡否则自动重建 holder」的对账器。** 返工本身可能合法耗时数小时,新卡本来就该等新 head;时间阈值语义错误,且与既有 materializer 收敛机器重复。**拒绝。**

### D2 — 旧卡作废

**候选 A(推荐):holder 行自带 void 台账 + 既有 tick 顺驱。**
- `workflow_gate_holder` 加列:`card_void_state`(NULL/pending/done/failed/skipped_legacy)+ `card_void_attempts`;两处 supersede(`founder_feedback` / `new_gate_attempt`)同事务将有 `card_message_id` 的旧 holder 标 `pending`。
- `workflowGateMaterializeTick` 同 tick 顺带 sweep `pending` void:resolveLeadForIssue 拿 bot token,binding/thread 拿 threadId,`editDiscordMessageInChannel` 把卡面改作废样式(reason 分文案:打回=「⛔ 已打回作废 — 返工完成后会自动出一张新 ship 卡,请勿在本卡操作」;换代=「⛔ 已作废 — 新的 ship 卡见下」);成功→`done`,404(卡已删)→`done`,失败→attempts+1,≥5 →`failed` + `enqueueWorkflowEngineAlert` 一次。
- 迁移:存量 superseded holder 一次性标 `skipped_legacy`(不去编辑历史卡,存量 21 张归 FLY-1757 清账)。
- durable(重启安全:holder 行即台账)、幂等(编辑天然幂等 + 状态列)、零新表、零新 timer。

**候选 B(否):打回时在 thread 里另发一条「旧卡已作废」提示消息。** 不改卡面 = 旧卡的"可操作的脸"还在,founder 往上翻仍会点;且多一条消息噪音。**违背裁定意图,拒绝。**

**候选 C(否):删除旧卡(DELETE)。** 抹掉决策历史(打回原文所在的卡上下文),founder 翻 thread 时失去"我打回过什么"的锚;编辑保留痕迹更诚实。**拒绝。**

### D3 — 死信告警

**候选 A(推荐):deadletter 落账同事务 enqueue durable 告警。**
- `recordWorkflowSourceDeadletter` 扩展:kind ∈ {founder_approval, founder_feedback} 时,同事务解析 payload 的 `run_id`,run 可解析 → `enqueueWorkflowEngineAlertTx`(escalationUid=`founder_input_deadletter:${source_event_id}`,幂等);run 不可解析(payload 畸形)→ projector 层面直投 `leadAlertNotifier` 兜底(best-effort;畸形 payload 无 run 上下文,claims 去重防刷)。
- 告警正文含:issue、卡(question_id/message)、founder 动作(approve/feedback)、死信 reason、指引(「founder 的输入没有入账;确认新卡是否已出,必要时人工跟进」)。投 Lead,不打扰 founder。
- projector 只 deadletter 一次每 source_event_id(重放走 skipped),自然一事一告警。

**候选 B(否):只在 projector drain 层 log 后补发告警(不落 outbox)。** crash 窗口丢告警,重放不补(deadletter 已记录 → skipped)。**拒绝**(与「fail-loud 必须可靠」自相矛盾)。

## 5. 结论

D1-A + D2-A + D3-A:全部骑在既有原语上(engine alert outbox、materializer tick、Discord PATCH、holder 状态机),零新表(仅 holder 加两列)、零新 timer、零新 flag、零新对账器。主修实为「把已存在的环焊死 + 三处静默点 fail-loud/可见化」,与 founder「别搞复杂」裁定同向。

---

# 第二轮(founder 8-15 打回):去上限 + 打回目标可选 — 调研

日期: 2026-08-15
基于: 本文件第一轮审计 + exploration.md §8-11。审计基线 = branch head `fd00170d`(PR #846)与 origin/main `2ca8d2f14` 对照。

## 6. E1 审计:「3 轮上限」到底活在哪几层

| 层 | 位点 | 现状 | 是否咬人 |
|---|---|---|---|
| shape 声明 | `menus/shapes/code.yaml` `founder_rework` loop | `maxIterations: 3, onLimit: escalate`(第一轮 #846 自己加的) | 声明层谎言 —— 运行时根本不执行,但它是「读 shape 的人」看到的合同 |
| menu 校验 | `workflow-menu.ts:299-308` | code shape 要求 founder loop `maxIterations === 3`(恰等,`!== 3` 即 throw) | 锁死声明,想改成别的数都不行 |
| menu parser | `workflow-menu.ts:257-286` | loop `exactKeys` 强制含 `maxIterations`/`onLimit`;`:267-270` 正整数;`:286` onLimit 只认 `escalate`;`:419` 编译成 manifest `max_iterations` | schema 不允许「无上限」表达 |
| manifest schema | `workflow-template.ts:83-84` 类型;`:597/:1184` exactKeys(两套 validator);`:612-615/:1199-1202` 正整数必填 | `max_iterations: number` 必填 | 同上 |
| engine 运行时 | `StateStore.ts:30453-30456` | escalate→held 分支带 `reworkAuthority !== "founder"` 前置(**main 既有**,非本分支引入);`:30419-30424` founder kickback ⇒ `authorityKickback="founder"` | **不咬** —— founder 打回在运行时已经无上限 |
| loop 计数 | `StateStore.ts:30653-30666` | `loop_iteration` 事件**只给非 founder loop** 追加;founder loop 的 loopIteration 恒算 1 | 无上限的副作用:轮次不可观测,没有告警的账本 |

**结论**:E1 不是「解锁运行时」(已解锁),是①把声明层改诚实(schema 允许 founder loop 无上限,QA loop 3/escalate 不动);②补轮次可观测性(founder loop 也记 `loop_iteration`)+ 每轮 ≥4 的 Lead-only warning 告警。engine 的 authority 豁免**保留** —— 它才是横跨存量 frozen manifest(内嵌 `max_iterations: 3`)的真无上限保证:老 run 开始记轮次后 count 会超 3,豁免在,永不 held。

**`loop_iteration` 新增追加的溢出面核查**(把 founder loop 也纳入计数后,谁会受影响):

- `StateStore.ts:30444-30451` escalation 用的 count —— founder 分支被 authority 豁免短路,安全。
- `StateStore.ts:29927-29963` loop-reentry receipt 身份 —— `:29931` 对 `founder_feedback_kickback` loop 直接返回 undefined,上游已排除,安全。
- `StateStore.ts:33932` `countWorkflowRunLoopIterations`(run 级 attempt source 注释)—— 全仓 grep 零生产调用方(仅定义),安全;实现期以 grep 复核钉死。
- `workflow-engine-dispatcher.ts:2176-2187` `phaseFixContext` —— 条件含 `outcome === "qa_fail"`,founder 轮不命中,安全。

## 7. E2 审计:打回目标的现有机器与缺口

### 7.1 目标进引擎的三条既有轨道

**轨道 A — loop 边(默认路由)**:`code.yaml` loop `founder_rework` `to: implement` 写死。transition 选边(`StateStore.ts:30328-30342`)= `edges.find(condition===outcome)` / `loops.find(loop_when===outcome)` 各取**第一条**,且 `(edge?1:0)+(loop?1:0) !== 1` 即 `illegal_transition`;projector 侧(`:32077-32085`)同样单 loop 假设(`run.current_node_id === gate && feedbackLoop` 唯一)。⇒ **同 outcome 多条 loop 边不可判,加边方案排除**;loop 边保持单条、默认 implement。

**轨道 B — rework route-revision 改道层(休眠)**:
- `write-gate-response.ts:158-171` `founderRework` seam:`target: "design" | "implement"` + scope/policy/interpretedBy/interpretationReason;`:258-269` 落进 gate response payload 的 `rework` 键。**全仓零生产调用方** —— seam 存在但从没人喂。
- projector 消费(`StateStore.ts:31989-32060`):`rework` hint 严格校验(target 只认 design|implement,`:32022`;scope/policy 枚举;exactKeys)→ `:32164-32209` kickback transition 落账后 `appendWorkflowReworkRouteRevision` 改道(priorTarget 在目标节点的历史 attempt 里找 preferred actor,`:32170-32185`)。
- 白名单(`StateStore.ts:23443-23464`):恰三种形态 —— design/[design]/[design_review,founder_gate]、design/[design,implement,qa]/全链、implement/[implement,qa]/[code_review,qa_retest,founder_gate]。**qa 不存在**;`:23489` route revision 只对 `authority === "founder"` 的 request 开放。
- 下游通用性:`workflow-rework-coordinator.ts` 零节点名硬编码,投递按 `route.target_node_id`/`route.invalidation_scope` 走;验证链行走(`StateStore.ts:30400-30417`)= 按 `invalidation_scope` 顺序推进,走完进 approval gate。⇒ 补 qa 形态后下游天然吃得下。

**轨道 C — operator rework(Lead/master 侧)**:`openOperatorRework`(`StateStore.ts:25105+`)target 校验 = `!target?.dispatch || target.type === "gate"`(`:25322` 附近),scope/policy 是**拓扑可达性计算**(`:25382-25413`:从 target 可达的非 gate 节点;qa ⇒ scope [qa]、policy [qa_retest, founder_gate])。HTTP 端点(`runs-route.ts:820-915`)对 targetNodeId 只做非空校验。⇒ **dispatch 注里「现只收 design|implement」与代码不符:qa 在此端点结构上已通**;缺的是端到端证明(无任何 qa-target 的测试/实跑证据),实现期补 e2e 回归即可,若跑出隐藏栓塞按发现修。

### 7.2 founder 表达层的现有机器

- 打回文字入账链(FLY-1448 后):文本/逐字 JSON/卡片回复 → durable founder receipt → 共享 ship-gate writer(`founder-ship-approval-handler.ts` → `writeGateResponseAndRunPostWrite`)。
- 文字判定已有 LLM 分类器:`founder-ship-approval-classifier.ts` 用 subscription-Claude 判 `approve|reject|unclear`(输出强 JSON 合同,`:82-85`)—— **比目标提取更高风险的判定(要不要 ship)已经托付给它**,且它就在打回路径上跑。
- `founderRework` hint 的语义注释(`write-gate-response.ts:158-162`)明说它是「server-interpreted routing hint…never founder authority」—— 目标提取只作 hint、经白名单校验,authority 仍是 feedback 原文。错路可恢复(再打回 / operator-rework),非终局。

### 7.3 E2 接线缺口(实现期必须覆盖)

1. **白名单/类型面**:`appendWorkflowReworkRouteRevision` 白名单 + 类型(`StateStore.ts:23429-23432`)、projector hint 校验(`:32022`)、`write-gate-response.ts:163-171` 类型 —— 三处同步加 qa(形态:qa/[qa]/[qa_retest,founder_gate])。
2. **producer 缺席**:founderRework hint 零生产调用方 —— 需要新的表达层(前缀解析 + 分类器提取)把 hint 喂进共享 writer。
3. **fresh-dispatch 的 feedback 注入门**:`workflow-engine-dispatcher.ts:2188-2196` founderFeedback 注入 carrier 写死 `node.type === "implement"` —— 改道 design/qa 后 fresh dispatch 收不到打回原文(coordinator wake 路径经 `authorityContext.founderFeedback` 投递,目标无关,`workflow-rework-coordinator.ts:489-499`,不受影响)。需把 implement 门放宽为「rework 目标节点」。
4. **qa 目标 + 同 head 新卡**:qa 返工不产新 head;gate 重入的 land 头校验(`StateStore.ts:30366-30376`)只要求 head 有 current PR binding —— 同 head 重入结构上通,新 holder/新卡照出(第一轮机器)。与 FLY-1757 的同 head 去重规则交集:以 gate attempt 换代为准,声明为边界。

## 8. 修法候选(结论)

- **E1-A(选)**:manifest/menu schema 把 `max_iterations`/`on_limit` 改为可选对(省略 = 无上限;`on_limit` 仅在有界时合法),`code.yaml` founder loop 去掉两键、QA loop 不动;menu 校验改为「founder loop 必须无上限,QA loop 恰 3/escalate」;engine 豁免保留 + escalation 条件补 `typeof max_iterations === "number"` 结构守卫;founder loop 开始记 `loop_iteration`;轮次 ≥4 每轮一条 warning 告警(outbox uid 按轮幂等)。零新表零新 flag。
- E1-B(否):改成大数 —— 声明仍是谎言。E1-C(否):只删校验留 3 —— 同上。
- **E2-A(选)**:复用轨道 B,白名单补 qa;表达层三层(前缀 > 分类器提取 > 默认 implement);轨道 C 补 qa e2e 证明;修 §7.3 缺口 3。
- E2-B(否):三条 loop 边 —— 轨道 A 审计已证不可判。
- E2-C(否):打回按钮/reaction 菜单 —— 动卡交互面,1757 邻接,founder 没要。
