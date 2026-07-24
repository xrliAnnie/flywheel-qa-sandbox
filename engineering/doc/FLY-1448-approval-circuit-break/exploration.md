# FLY-1448 批准断路 — 探索

Issue: FLY-1448 (https://linear.app/geoforge3d/issue/FLY-1448/p1批准断路-founder-批准被静默丢弃-session-卡-running-无-durable-park-wake-拒投)
日期: 2026-07-23
基于: 无

## 1. 问题一句话

真 founder 对 DAG ship-gate 卡的批准回复(散文和逐字 `{"approved": true}` 两种格式)被系统「读到即丢」:游标推进过消息、CommDB question 永不 resolve、run 卡 `founder_gate`、全程零告警 —— founder 视角是「我批了,系统装没听见」。

## 2. 症状与铁证(529 房,2026-07-23)

来源:`doc/engineer/test-reports/FLY-1441-room-e2e-round2.md`(第九棒,commits 89b282db → 8a4dc59d → cbfb9d37 → 1796fa9c),真 founder 账号 `xrliannie_96634`(bot=false)、真 Chrome。

- run A(`tpl_eng_trivial_land_v1`,land authority)走到 `founder_gate`,thread 恰 1 张 ship-gate 卡,卡面写「直接回复这条消息或点 ✅ 即批准」。
- founder 先按卡面用中文散文回复,再按 Lead 给的合同用逐字 `{"approved": true}` 回复 —— **两种都被丢弃**:
  - `~/.flywheel/founder-reply-cursor.json` 游标已推进过两条消息(= deliverer 读到并处置了);
  - CommDB question `workflow-gate:ff6b7c7e…` 的 `resolved_via / resolved_at / read_at` 恒空,`relay_state=protected`;
  - holder 停 `awaiting_review`,run 停 `founder_gate`;
  - `workflow_alert_outbox` 对该 run **零告警** —— Lead 也没有被 fail-loud 通知「批准掉了」。
- 房内 Lead 独立复核同一事实,并给出因果链(第 ③ 环被第九棒一手复核):qa session `3c1750ea` 状态 `running`,不在任何 durable park 态 → wake 指针按合同拒投(`wake_pointer_status is "running" without a durable park`)。
- ✅ reaction 路径:三次 Chrome 点击均未落上(API 复核 reaction=0),**工具侧问题,产品侧零证据零结论**。
- 定性(round3 二分,commit 1796fa9c):#690 在 gate-poller 的 +39 行(三处 `workflowGatePresentationDisposition` 呈现守卫)用 run A 真实行值逐条求值 = `allow:true`,**非 #690 回归**;生产全天跑 pre-#690 代码,同款 wake 拒投症状 16+ 条 → **既有引擎缺陷**。

## 3. 问题空间分解(审计结论预览,详证见 research.md)

审计把「批准断路」拆成四个互相独立、叠加成灾的断点:

### RC-1 · text 批准绑定被弃线(主根因,断言 C 直接成因)

FLY-799/1041/1099 建成的整套 founder ship-approval text 归因组件(`tryFounderShipApproval` handler + factory + Tier-3 classifier + deferral/rebind + guards,Codex 多轮审过、约 80 测试)在 **FLY-1392(PR #661)重写 deliverer 为 hub 拓扑时被断线**:

- FLY-1099 时代 deliverer(`d0039166`)第 552 行有 `tryFounderShipApproval` ship 分支;
- FLY-1392 v2 deliverer(`d817eff2`)只剩 hub-root + `deliverAmbiguousToLead`,ship 分支消失;
- `makeFounderShipApprovalCallback` 全仓生产代码**零调用方**(只剩测试与 flag registry 引用)。

同时 Lead 侧也无路可走:`routeFounderReply`(db.ts:2227-2234)明确拒绝路由 `approve_to_ship`(「not founder-routable」)。于是 founder text 批准在当前拓扑下**没有任何自动消费者** —— 只剩 Lead 人工跑 founder-consent `respond`、dashboard、voice、✅ reaction 四条旁路。卡面文案(founder-thread-notifier.ts:111,120)承诺的「直接回复即批准」= FLY-945 生产合同,已名存实亡。

### RC-2 · wake 合同与 park 记账错位

wake 指针合同(runner-recovery-nudge.ts:196-214)只认 `awaiting_review / approved_to_ship / design_done / (running + CommDB declared park)`。但:

- DAG keep-alive 下 phase session 在节点间/门禁旁**合法地**停在 `running`(FLY-887/FLY-1269),无人替它落 declared park → 一切发往它的 mailbox 消息进 wake ladder,T2 wake_pointer 拒投 → `wake_failed`(生产 16+/天的假警报家族本体);
- #690 新增的 `ship_parked` FSM 态**不在 allowlist** —— FLY-1441 W3 六族消费面矩阵(re-adopt / inventory / duplicate admission / worktree protection / parked patrol / finalize-terminate)没有覆盖 wake 合同,这是**被漏掉的第七个消费面**;
- `message_traffic` purpose 的 wake 对 running-无-park 目标被 patrol **静默 dispose**(runner-receipt-patrol.ts:116-124),零审计零告警 —— 又一个「读到即丢」形态。

### RC-3 · wake_failed 指纹跑步机

告警指纹 = `sha256(wake.message_id)`(plugin.ts:7905-7910)—— 对同一个已完结 session,每条新 wake 都是新指纹,claims 去重永远闩不住 → 告警跑步机(~35 条历史手工 resolve)。且 patrol 的 `resolveTargetState` 终态清单只有 `failed/blocked/timeout/canceled(cancelled)`,**`completed`/`terminated` 被当 live** 跑完整 ladder。

### RC-4 · 「批准必达」无兜底

deliverer 把「hub 交接成功」当作消息处置成功 —— 没有任何机制核对「这条 founder 消息对应的 ship gate 到底 resolve 了没有」。FLY-1099 的 bounded-retry/dead-letter 账本只覆盖**处理失败**,不覆盖**处理成功但语义丢失**。所以 RC-1 这类断线可以静默存在数周。

## 4. 方案空间与取舍

### Q1 · text 批准归谁绑?

| 选项 | 说明 | 判定 |
|---|---|---|
| **A. 重接 Bridge 侧归因组件(选定)** | 把孤儿的 `tryFounderShipApproval` 组件接回 v2 deliverer 的 founder 消息处理链,ship gate 消息先走归因、不可归因再落 hub 交接 | ✅ 组件已存在、已过 Codex 多轮 review、engine-aware(gateAuthorityView)、有现成 kill-switch `FLYWHEEL_FOUNDER_AUTO_APPROVE`;恢复的是 FLY-945 已上线合同,卡面文案零改动 |
| B. Lead 人工 respond 作为正路 | founder text → Lead 收 hub root → Lead 判断后跑 founder-consent `respond` | ❌ 把 founder 控制面决定的时延与可靠性押在 Lead session 活性上(房测/生产两次实证不可靠);FLY-1427 拓扑本意是让 Lead 路由**普通问题**,`approve_to_ship` 从一开始就被 `routeFounderReply` 排除在 Lead 路由外 —— ship 归因本就是 Bridge 控制面职能(founder 身份校验、Tier-3 语义分类、hold/deferral 语义都在 Bridge) |
| C. 新建第三条绑定通路 | 例如让 workflow 引擎自己轮询 thread | ❌ 重复建设,放弃已审组件,新增攻击面 |

### Q2 · park/wake 记账怎么对齐?(issue 给的两个方向都要,分层取)

| 层 | 选项 | 判定 |
|---|---|---|
| B1 | wake allowlist 纳入 `ship_parked` | ✅ 必做 —— `ship_parked` 就是 durable park 的定义本身,#690 W3 矩阵漏掉的 wake 消费面补账 |
| B2 | 引擎替 keep-alive/gate-等待中的 session 落 **engine-declared park**(写现有 CommDB `runner_declared_states` 基座) | ✅ 选定 —— 走「carrier 停驻语义正确落 durable park 态」方向;复用现有 `isDeclaredParked` seam,wake 合同**零修改**,不放松安全语义 |
| B2' | wake 合同直接承认「gate-等待中的 running」 | ❌ 放松合同 = 把「不知道对方在干嘛也敢打字进 pane」重新合法化,FLY-1392 收紧的初衷会被掏空;engine-declared park 能表达同一事实且保留 fail-closed |
| B3 | founder-origin 的 wake 永不静默 dispose | ✅ 必做 —— `message_traffic` 静默 dispose 对普通闲聊可容忍,对 founder 决定不可容忍;带 origin 标记的 wake 改走 escalate |

### Q3 · fail-loud 怎么做?

选定:**founder 决定收敛看门狗** —— deliverer 处置任何「thread 上有 pending approve_to_ship」的 founder 消息时,落一条 durable 收敛行(msgId + questionIds + deadline);GatePoller 既有 cadence 上扫(零新 timer),超时未 resolve → detection escalation 告警 Lead + founder 消息上 ❓ 回执。这是**结构性兜底**:无论未来哪条绑定路径再断,founder 决定被丢都会在分钟级浮出。仅告警(不自动重放)—— 重放语义交给已有 deferral/rebind 组件。

### Q4 · 指纹跑步机怎么治?

选定:双管 —— ① `resolveTargetState` 终态清单补全(`completed`/`terminated` 等 FSM 终态),终态目标**不进 ladder**,wake 直接 dispose + 以 `execution_id` 为键的**稳定指纹**单次终态告警;② 存量 escalate 路径指纹从 `sha256(message_id)` 改为 `(execution_id, kind, 终态 episode)` 稳定键。与 FLY-1220 episode-latch 语义对齐,不重复建设。

## 5. 范围边界

- **不并入 FLY-1374**(状态真相双对账器)—— 本单是批准投递断路急修;对账循环是结构工程,依 founder 排期。
- **不动 #690 呈现守卫**(已被二分无罪释放)。
- **不改 `routeFounderReply` 的 approve_to_ship 拒绝** —— Lead 永远不能代 founder 路由 ship 批准,这是安全语义不是缺陷。
- **不改卡面文案** —— Fix A 恢复后文案与行为重新一致。
- ✅ reaction 路径**无已知代码缺陷**(房测是点击工具问题)—— 本单交付后由 QA 真机补证,不在实现范围内动它。

## 6. 验收(能力级,529 房,来自 issue)

① 真 founder 散文回复 ship 卡 → 批准生效、holder→approved、run 推进;② 逐字 JSON 同;③ ✅ reaction 同(真机取证);④ 人为造投递失败 → Lead 收 fail-loud 告警,绝不静默;⑤ 完结会话不再重铸 wake_failed 指纹。
