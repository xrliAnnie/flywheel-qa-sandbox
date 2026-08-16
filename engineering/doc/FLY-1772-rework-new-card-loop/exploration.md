# FLY-1772 打回后返工闭环出新卡 — 探索

Issue: FLY-1772 (https://linear.app/geoforge3d/issue/FLY-1772/bug-打回后的返工闭环必须出新卡打回-返工新-head-自动出新卡旧卡作废不再接受操作founder-8-14-裁定版)
日期: 2026-08-14
基于: 无(founder 8-14 裁定 + FLY-1560 事故铁证为直接上游输入)

## 1. Founder 裁定(设计的最高约束,2026-08-14 13:18 PT)

> 第一张 ship 卡我打回去了…卡打回来之后,他应该做的事情是给我出一张新的卡。…第一张卡既然已经被打回去了,理论上来说我就不应该在之前已经识别出有问题的 ship 卡上再去操作。

裁定翻译成产品模型:**一轮打回 = 一张新卡**。

- ✅ 打回落账后,返工产生新 head 时,引擎必须**自动**出一张绑新 head 的新卡;founder 在新卡上操作。
- ✅ 旧卡随新卡作废:作废卡**不存在被误点的语义**(卡面可见地失效)。
- ❌ 明确不做:「打回过的卡仍能被后续 ✅ 批准」(第一版方案,founder 已推翻作废)。
- ❌ 明确不做:「点错卡给 founder 回执」(FLY-1757 已裁过不做,别自行加回)。

## 2. 事故铁证(2026-08-14,FLY-1560 的 ship 卡)

1. 卡 `1537825938736291841` 上 founder 的 ✅ 真实存在(Discord API 可读),但 gate 唯一入账应答 = 15:36 文字打回;✅ 从未入账,她白等零提示。
2. 深层:打回落账后,workflow-source-projector 对同一 gate 的**全部后续 founder 输入**死信丢弃(`founder feedback source payload invalid: run state` 家族),且完全静默 —— 只有 `console.warn`,无人收到告警。她当天连点四张卡全落空、零人知晓,靠她自己起疑才发现。
3. 返工闭环当时断在 FLY-1765 的账面终态问题(implement 体完工投 `completed` → wake 闸 100% 拒绝),#837(2026-08-14 12:45 PT merged)已修——但「打回 → 新卡」这条 founder 视角的环从未被作为一个整体验证与守护过。

## 3. 问题陈述

系统里"打回 → 返工 → 新卡"的机件**分段存在**(kickback 转移、rework request/delivery、gate 重入建新 holder、materializer 发卡),但:

- **环从未整体闭合验证**:FLY-1560 当天的断点(1765)修了,环上其余静默失效点(materializer 卡死只 warn、projector 死信只 log)仍在,任何一段断掉 founder 都在白等,零提示。
- **旧卡在打回后仍长着一张"可操作的脸"**:卡面不变,founder 无法从卡面分辨它已作废,误点必然发生(当天连点四张)。
- **founder 输入被静默丢弃**:死信只进 log,Lead 与 founder 双盲。

## 4. 交付边界(按裁定)

| # | 交付 | 一句话 |
|---|------|--------|
| D1 | 打回→返工→出新卡的闭环可靠 | 打回落账后,返工产生新 head 时引擎自动 materialize 新卡(绑新 head);环上静默失效点 fail-loud。**主修。** |
| D2 | 旧卡随新卡作废 | 打回落账即编辑旧卡面为作废态(「已打回作废」样式),作废卡不存在被误点的语义。 |
| D3 | founder 输入被静默丢弃 ⇒ 告警 Lead | projector deadletter founder 输入时必须告警 Lead(不打扰 founder)。 |

**验收**(issue 原文):打回→返工新 head→断言新卡自动出现且旧卡面变作废态;founder 在新卡 ✅→正常入账走 ship;对旧卡的任何输入不被静默吞(Lead 收告警,founder 不被打扰);纯 ✅ 无打回场景零回归。

## 5. 关联单与边界切分

- **FLY-1765(已 merge #837)**:返工环的账面停驻修复(implement 体完工投 `ship_parked` + Fix 2 受控收体)。本单的新卡触发**依赖**它 —— 打回 rework 与 QA-FAIL rework 共用同一套 coordinator/delivery 机器。本单不重做它,只在其上闭环。
- **FLY-1757(Backlog,Urgent)**:同 head 去重发卡 + 「卡随交付自动失效」。与 D2 同族但触发不同:1757 = 同 head 别发两张 / PR 已合入卡转终态;1772-D2 = 打回后旧卡作废。**本单把「卡面作废编辑」做成可复用原语**,1757 后续可直接搭(它的"交付失效"= 另一个触发源调同一原语);同 head 去重本身留在 1757,不在本单做。
- **FLY-1655(已 merge #795)**:terminal land 不变量 —— 有 PR 的 schema-v2 DAG 一律经 approval gate 进 engine-owned `land`。本单的 gate/holder 语义在其框架内,零改动其不变量。
- **FLY-1448(pending ship)**:founder 批准投递断路根治(durable receipt / dead-letter / wake fence)。它管的是「founder 决定 → gate writer」的投递链;本单管的是「gate 死信 → 告警」与「打回 → 新卡」的引擎环,正交。

## 6. 方案方向(供 research 深挖)

初步判断(细节与取舍在 research.md 展开):

- **D1**:审计证实 kickback→rework→gate 重入→新 holder→发卡的机件链已全部存在(1765 修复后)。主修落点 = ①补上环上两处静默失效的 fail-loud(materializer 反复失败只 `console.warn`;projector 死信只 log);②以真实 compiled manifest 写「打回→新卡」端到端回归,把环作为整体钉死。
- **D2**:打回落账(holder → `superseded`)同事务落一条 durable「卡面作废」工作项,由既有 tick 驱动 `editDiscordMessageInChannel`(PATCH,原语已存在)把旧卡面改成作废样式;at-least-once,失败重试,反复失败走既有 engine alert。
- **D3**:workflow-source-projector 的 deadletter 落账点(founder-origin kind)接既有 workflow engine alert 队列(durable、去重、经 dispatcher `reconcileWorkflowEngineAlerts` 投 Lead),不打扰 founder。

不引入新 env/flag(FLY-1466 铁律);不开终态复活边;不动 FLY-1655 不变量。

## 7. 下一步

- research.md:逐段代码位点审计(kickback 事务/rework 链/gate 重入/holder 材料化/死信路径/告警轨道),把 D1-D3 的修点精确到行,列出候选方案与取舍。

---

# 第二轮(founder 8-15 打回):去上限 + 打回目标可选

日期: 2026-08-15
基于: 第一轮交付(PR #846,head `fd00170d`,R3 code review APPROVED)+ founder 8-15 04:32 打回原话。本轮为重派后的全新 run(原 run 97152daf 载体结构性卡死,founder 05:31 选收体重派)。

## 8. Founder 打回原话(本轮最高约束)

> 1. 「为什么要最多3轮呢?那我打回去可能超过3轮,就是没有必要设这个限制呀」
> 2. 「打回去也不一定是给 Implement 返工呀…可能是给 Design 返工,给 Implement 返工,给 QA 打返工」

翻译成交付:

| # | 交付 | 一句话 |
|---|------|--------|
| E1 | founder_rework 循环去 3 轮上限 | 无上限;超过参考线只告警 Lead,绝不阻断 founder。 |
| E2 | 打回目标可选 design / implement / qa | 不写死 implement;founder 表达的返工对象决定路由。engine operator-rework 端点(dispatch 注:现只收 design\|implement)一并打通或在设计里说明形态。 |

## 9. 意图理解(在拆方案之前先摸真实诉求)

- **E1 的真实诉求不是「把 3 改成 30」**,是「打回是 founder 的裁量权,机器不得给它设额度」。QA-FAIL 循环是机器自转,cap+escalate 是防机器空转的护栏,应保留;founder 打回每一轮都是真人动作,天然有界,cap 没有存在理由。「仅告警」的意义是给 Lead 一个「循环没在收敛」的可见性,不是给 founder 设闸。
- **E2 的真实诉求是「打回落到该返工的人头上」**。她口语化表达「给 Design 返工 / 给 QA 打返工」—— 她**不会**为了路由去学一套命令语法;设计必须让她的自然表达生效,同时保留确定性通道与安全默认值。
- 两条共同的隐含约束(继承第一轮裁定):一轮打回 = 一张新卡,不管打回落到哪个节点、绕多少轮,每次 gate 重入都出新卡、旧卡作废 —— 第一轮交付的 supersede/void/materialize 机器对 E1/E2 完全复用,本轮零重做。

## 10. 方案空间(brainstorm 结论,细节在 research/plan)

**E1 — 上限住在哪里、怎么拆:**

- 审计发现(细节见 research §6):engine 运行时对 founder authority 的 loop 逃逸**在 main 上本就豁免**(`reworkAuthority !== "founder"` 才走 escalate→held);3 轮上限只活在两处**声明层** —— `menus/shapes/code.yaml` 的 `founder_rework` loop(`maxIterations: 3`,第一轮 #846 自己加的)与 `workflow-menu.ts` 的 code shape 校验(founder loop 必须恰为 3)。
- 候选 A(选):**schema 允许 founder loop 声明为无上限**(省略 `maxIterations`/`onLimit`),菜单校验改为「founder loop 必须无上限、QA loop 保持 3/escalate」,engine 保留 authority 豁免(它才是横跨新旧 frozen manifest 的真保证),另起每轮 ≥4 的 Lead-only warning 告警。声明与行为一致,QA 护栏不动。
- 候选 B(否):把 3 改成大数(如 99)。声明仍是谎言,founder 原话就是「没有必要设这个限制」。
- 候选 C(否):只删 menu 校验、YAML 留 3。行为已无上限但声明仍写 3,下一个读 shape 的人会再造一个 cap。

**E2 — 目标怎么进引擎、founder 怎么表达:**

- 引擎侧候选 A(选):**复用既有(休眠的)rework route-revision 改道层**。DAG 拓扑不动(loop 边保持 founder_gate → implement 单条;transition 选边是 find-first,多条同 outcome 的 loop 边不可判,加边方案直接排除),打回默认落 implement,带 target hint 时经 `appendWorkflowReworkRouteRevision` 白名单改道 —— design 改道形态已存在,补 qa 形态(scope [qa],policy [qa_retest, founder_gate])即可。operator-rework 端点审计证实其 scope 是拓扑可达性计算,qa 结构上已通,补端到端证明。
- 引擎侧候选 B(否):三条 loop 边(founder_gate→design/implement/qa)。transition 的 `loops.find(from && loop_when)` 返回第一条,选边不可判;改选边逻辑动的是 FLY-1765 刚焊好的核心机器,风险不成比例。
- 表达层候选(分层,选「前缀 > 分类器提取 > 默认 implement」):
  - **显式前缀**(`design:` / `implement:` / `qa:` 起头):确定性最高,零解释;卡面文案写明用法。
  - **既有 approve/reject 分类器顺带提取目标**:打回文字本就经 subscription-Claude 分类器判 approve/reject/unclear(比目标提取更高风险的判定已托付给它);顺带输出 target(design/implement/qa/null),经白名单校验只作 hint。她说「给 QA 打返工」即可路由,不用学语法。错路可恢复(再打回或 operator-rework),非终局。
  - **默认 implement**:两层都无信号时保持今天行为,零回归。
  - 拒绝「仅前缀」:她口语化的「给 QA 打返工」(无前缀)会默认路由 implement,直接违背她的预期。拒绝「新增打回按钮/reaction 菜单」:动卡交互面,FLY-1757 邻接,founder 没要按钮。

## 11. 边界(本轮不做)

- ❌ QA-FAIL 循环(qa_retry)的 cap 不动 —— 机器自转护栏,3/escalate 保留。
- ❌ 不改 transition 选边逻辑、不加 loop 边、不动 FLY-1765 返工机器与 FLY-1655 terminal-land 不变量。
- ❌ 不加新 env/flag(FLY-1466 铁律)。
- ❌ 同 head 去重发卡仍归 FLY-1757;本轮只声明交集规则(qa 目标返工可产生同 head 新卡,以 gate attempt 换代为准,1757 去重不得吃掉打回换代出的新卡)。
