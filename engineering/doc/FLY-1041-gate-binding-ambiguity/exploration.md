# FLY-1041 Founder 批准绑定故障 — 探索

Issue: FLY-1041 (https://linear.app/geoforge3d/issue/FLY-1041/founder-approval-binding-glitch-thread-reply-wont-bind-to-gate-under)
日期: 2026-07-08
基于: 无

## 1. 问题一句话

Annie 在 FLY-910 issue thread 里连续 3 次尝试批准 ship("嗯ship" → "910 ship 的吗?" → "okk"),每次 `verify-approval` 都返回 `approved:false / gate_not_answered` —— 她的 thread 回复绑不到 ship gate 上;同一晚 `founder_reply_ambiguous` 在 9+ 个 thread 里刷了几十条,founder 批准通道整体脆弱。

## 2. 生产取证(ground truth,非推测)

以下全部来自生产 DB 直查(`~/.flywheel/comm/flywheel/comm.db` + `~/.flywheel/teamlead.db`,只读),UTC 时间:

### 2.1 FLY-910 事件时间线(execution `84cf4790`,thread `1523768790494609460`)

| 时间 (07-09 UTC) | 事件 | 证据 |
|---|---|---|
| 03:30:29 | `complete --route needs_review` → FSM `running→awaiting_review`,绑 gate **c450a598** | session_events `state_transition` |
| 04:59:28 | Annie **"嗯ship"**(msg `…734196`)→ 只触发 `founder_ship_reply_waked`(WAKE-only,**没有写 response**)| session_events;此时**只有一个** ship gate,不存在多 gate 歧义 |
| 05:00–05:12 | runner 两次 `verify-approval` → `gate_not_answered` | comm.db runner 报告消息 |
| 05:15:17 | 重开新 gate **d989dc78**(【干净重开 · 唯一待答】)+ 第二次 `needs_review` completion → isReReview 路径 rebind 成功(session `review_question_id` = d989dc78)| comm.db + session_events |
| 05:15 之后 | **旧 gate c450a598 仍然 pending**(无人退役;后被手动收敛/prune 掉)| 05:27 起每条 founder 消息 wake **两个** qid |
| 05:27:46 | Annie **"910 ship 的吗?"** → WAKE ×2(c450a598 + d989dc78)+ `founder_reply_ambiguous` | session_events + lead_events |
| 05:30:08 | Annie **"okk"** → 同上,WAKE ×2 + ambiguous | 同上 |
| 05:47:41 | Annie 第 4 条消息 → **d989dc78 终于绑上**:response `{"approved": true}`(from_agent = founder Discord id `1138241636057481306`)→ FSM `awaiting_review→approved_to_ship`;同一秒旧 gate c450a598 又 WAKE 一次 | comm.db response 行 + session_events |
| 05:47:52 | GatePoller 把**旧 gate c450a598** 的 founder 直通知卡("🚀 Ship gate 等你批准…已等 137 分钟")发进 thread —— **批准已落地 11 秒后还在为死 gate 造噪音**;而新 gate d989dc78 整个 32 分钟生命期里从未发过卡 | session_events `founder_thread_notified` |
| 05:49–06:01 | 后续 founder 消息继续触发 c450a598 WAKE + ambiguous ×2 | session_events + lead_events |
| 05:55:18 | Tadashi executor-merge #471(人工 workaround)→ completed | `lead_close_runner_finalized` |

### 2.2 歧义风暴(fix 方向 3 的证据)

`lead_events` 表 07-09 当晚 `founder_reply_ambiguous`:1 小时内几十条,横跨 FLY-353 / 910 / 545 / 967 / 1005 / 915 / 336 / 347 / 1020。

### 2.3 "open question 噪音"的来源(关键新发现)

FLY-910 runner 按 FLY-208 的 LEAD REPORT-BACK 协议用 `flywheel-comm ask` 发了 **~20 条 "DONE/报你" 汇报**。每条 ask 都是 CommDB `type=question` 行、**72 小时才过期、无人应答就一直 pending**。`GatePoller.founderReplyDeliverPass` 把「该 lead 名下所有 pending question」按 issue thread 分组后**全量**作为 founder 回复的候选绑定目标 —— 于是:

- thread 里只要有 ≥2 条 pending(几乎恒真),founder 任意回复 → `matching.length >= 2` → 非 ship 分支判 ambiguous → 甩给 Lead 人工 relay(风暴来源);
- 更危险:恰好只剩 1 条 pending 时,founder 消息会被**自动写成那条 question 的 response** —— 07-08 15:48 Annie 的一条 thread 消息就被绑成了某条 "DONE 报告"(`020dd8b4`)的答复(错绑实锤)。

## 3. Root causes(按因果排序)

### RC-1 · re-fire 后旧 ship gate 无人退役(issue fix 方向 1,本次事故直接根因)

`gate approve_to_ship --no-block` 只插入新 question;`complete --route needs_review --question-id` 只改写 `sessions.review_question_id`。**没有任何代码退役旧的 pending approve_to_ship question**(它要活满 72h TTL)。后果(全部有取证):

1. 每条 founder 消息双份 WAKE(两个 gate 各一次);
2. 旧 gate 持续参与 `matching` 集合,推高歧义;
3. GatePoller 的 relay / founder-thread fallback / lead-pending nudge 都继续为死 gate 工作 —— 批准落地后 11 秒还把旧 gate 的"等你批准"卡发进 thread;
4. attribution 的 A-2 收窄(`session.status==='awaiting_review' && review_question_id===qid`,要求恰好 1 个)这次侥幸兜住了;一旦同 thread 出现两个 awaiting_review session(三段式/多 runner),或撞上 FLY-1035 那类 FSM 状态腐坏,`current.length !== 1` → 永远 `return null` → 永远绑不上。

### RC-2 · 单一干净 gate 时 "嗯ship" 也没绑上(04:59,比多 gate 歧义更早的失败)

文本归因管线:Tier-2 **整句精确** allowlist("ship"/"可以"/"上线吧"…)→ 未命中 → Tier-3 Haiku 分类器(严格 fail-closed)。"嗯ship" 不在 allowlist(带了语气前缀"嗯")→ 降级 Tier-3 → 返回 unclear 或 runner 失败 → WAKE-only。**归因路径零审计**:tier2 结果、tier3 verdict、A-2 收窄结果都不落事件,事后无法区分"分类为 unclear"还是"classifier 进程失败"。

### RC-3 · founder 得不到任何绑定反馈(UX 放大器)

她每次批准后系统毫无回音(绑上没有?没绑上为什么?),只能重试 —— 重试又制造更多歧义消息。4 条消息、3 次失败、全程盲打。

### RC-4 · 缺一个确定性的批准载体(issue fix 方向 2)

✅-reaction 批准路径(FLY-799)已存在,但它依赖 founder-thread-notifier 发出的 gate 卡(`gateMessageId` 绑定)。而该通知是 **10 分钟 grace 的"Lead 可能漏转"兜底**,生产中还常年迟发/不发:910 的**当前** gate(d989dc78)从未发卡,反而是**旧** gate 在批准落地后发了卡。没有卡 → 没有 reaction 目标 → 也没有"回复这张卡"的确定性绑定。

### RC-5 · runner 汇报复用 `ask`(type=question)污染绑定候选集(issue fix 方向 3)

见 §2.3。"DONE 报你"是汇报不是提问,但传输层与提问同型,进 pending 集合 72h,既造歧义风暴、又会单独吃掉 founder 回复(错绑)。

## 4. 与相邻 issue 的边界

- **FLY-1035**(parked 时 `stage set completed` → FSM terminal → `review_question_unbound`):独立的 FSM 状态腐坏 bug,本设计不修它;但 RC-1 的收敛机制(sweeper)天然降低它的次生伤害面。
- **FLY-945**(founder approve self-ship,已 merge):本设计站在它的 Fix A/C/E 之上,不动 `verify-approval`(安全关键,保持字节不变)。
- **FLY-799**(founder 文本/✅ 归因,已 merge):本设计扩展它(Tier-2 归一化、reply-to-card、审计),不推翻。

## 5. 解法方向(供 brainstorm gate 确认)

按「Annie 的核心诉求 = 一个动作可靠绑定 + 看得见结果」排优先级:

### Fix A · 单一可绑 gate 不变量(retire-on-rebind + 兜底 sweeper)——修 RC-1

- **主路径**:Bridge 两个 completion sink(event-route.ts + DirectEventSink)处理 needs_review rebind(旧 qid → 新 qid)时,同步退役旧的 pending approve_to_ship question(`resolveGate(old, 0)` 语义:立即过期,不删行留取证)+ 落 `ship_gate_superseded` 审计事件。
- **兜底 sweeper**(GatePoller,复用现有 eviction 机制):pending approve_to_ship question q,若其 session 当前绑定的 question 存在且 **created_at 严格晚于** q → q 已被取代 → 退役。严格晚于(不含同秒)防止「gate 刚 fire、complete 还没到」窗口里误杀新 gate。
- 不变量:**任一 session 任意时刻至多一个可绑的 ship gate**。

### Fix B · 确定性批准载体(ship gate 卡转正 + reply-to-card 绑定)——修 RC-4

- approve_to_ship 的 founder-thread 通知从「10 分钟兜底」升级为**主路径、及时发**(brainstorm 等其它 checkpoint 不动);卡上引导「回复这条消息或点 ✅ 即批准」。
- founder-reply-deliverer 读消息时带 `message_reference`:founder 消息若是对已绑 gate 卡的 **Discord reply** → 确定性绑定到那个 gate(跳过歧义判定),文本仍走 tier2/tier3 判 approve/reject,但 Tier-3 prompt 注入「这是对 ship gate 卡的直接回复」上下文("okk" 这类短语在此上下文可判 approve)。
- ✅-reaction 路径照旧,受益于卡的及时性。

### Fix C · 归因可见性(审计 + 回执 reaction)——修 RC-2 观测性 + RC-3

- 归因每步落 session_events:tier2 命中/降级、tier3 verdict(approve/reject/unclear/runner_failed)、A-2 收窄结果(0/1/N)。
- founder 消息绑定成功 → Bridge 给**她那条消息**点 ✅(一次 API 调用,无 thread 噪音);ship gate 在场但判 unclear → 点 ❓(提示"没绑上,请回复 gate 卡或点卡上 ✅")。
- Tier-2 归一化:剥离前导语气词(嗯/嗯嗯/好/哦/行/ok/okk,含无空格 CJK+latin 粘连)后再整句匹配 —— "嗯ship" 确定性命中,不动 fail-closed 骨架。

### Fix D · 汇报不再是 question(降噪)——修 RC-5

- `flywheel-comm ask` 加 `--report` 标记(或新子命令 `report`):仍写 CommDB、仍 relay 给 Lead,但 founder-reply-deliverer 的候选集**排除**之(founder 回复永不绑到汇报上)。
- Blueprint 的 LEAD REPORT-BACK 协议文本同 PR 更新为用 `--report`。
- 未标记的旧行为字节不变(渐进迁移)。

### 开关与兼容

全部默认 ON + 各自 env kill-switch(项目惯例);`verify-approval` 与 FSM 边零改动。

## 6. 不做什么(YAGNI)

- 不做 Discord button/组件交互(reaction + reply-to-card 已覆盖诉求,button 需要 interaction endpoint,平台面大);
- 不修 FLY-1035 的 FSM terminal 复活;
- 不动非 ship checkpoint(brainstorm/question)的通知节奏;
- 不做「thread 全量开放问题清单 UI」。

## 7. 待研究(research.md 输入)

1. 两个 completion sink + marker-reconciler 是否还有第三处 rebind 位点(FLY-208 的 complete-marker 恢复路径)?
2. founder-thread-notifier 为何 910 迟发 2h17m(transient 重试预算耗尽?`no_chat_thread`?)—— Fix B 转正前必须弄清生产不发卡的真实原因。
3. `message_reference` 在现有 GET `/channels/{id}/messages` 返回里是否已含(避免 per-message 二次请求)。
4. reaction 回执(✅/❓)与 reply-guard / mention-gating 的相互作用(Bridge bot 在 thread 里点 reaction 是否触发任何入站处理)。
5. Tier-3 classifier 的失败率/延迟(subscription headless Haiku)—— 是否需要超时后的 durable retry,还是靠 Fix B 的确定性通道兜底即可。
6. `--report` 迁移半径:Blueprint 注入文本、既有 runner prompt、QA fixtures。
