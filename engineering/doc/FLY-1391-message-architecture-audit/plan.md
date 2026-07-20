# FLY-1391 消息/通知架构全貌 — 缝隙裁定表与整顿选项

Issue: FLY-1391 (https://linear.app/geoforge3d/issue/FLY-1391/audit消息全貌-message通知架构全图-谁发给谁哪些送-lead哪些送-runner哪些根本没送annie-直令不打地鼠先看全貌)
日期: 2026-07-20
基于: research.md

> **这不是实施计划。** 本单只画图。本文是**裁定表 + 整顿选项**,供 Annie 拿着拍 FLY-1388 的最终形态。
> 每条给证据、给严重度、给取舍;**不替她选**。
> 凡 research.md 标 `unverified` 的,本文不给确定裁定。

## 0. 一句话结论

> **收信的主路径已接线;兜底的那几条被一次有意的范围裁剪关掉了 —— 而留下的那条,判据是坏的。**

> ⚠️ 这句话经 Codex 设计复核改过两次。初稿是「收信线基本是好的;查岗线大面积关着 ——
> 被一次改进顺手关掉的,没人知道」。**两处都过度断言**:① 本单没做端到端测试,证明不了"好";
> ② FLY-1373 的 plan §7 **白纸黑字列了关停清单**,不是"没人知道"。更正后的说法更弱,但撑得住。

Annie 三问的直接回答:

| 她的问题 | 答案 |
|---------|------|
| 哪些送 Lead? | 几乎全部 runner 出站(ask/gate/complete/stage)都进 Lead 收件箱 —— **主路径已接线且默认开启**(端到端健康度本单未验证)。 |
| 哪些送 Runner? | founder 的 **ship 门批准**和**恰好一条匹配**的回复 —— **直送,不经 Lead**。 |
| 哪些根本没送? | ① `SendMessage to:"team-lead"` 全丢且回执成功 ② `legacy_delivery_watchdogs` 圈内的若干兜底子巷关着 ③ 多个 flag 显示"开"但组件没接线 ④ `stale_approved_ship_dead` 有记录但零人类触达 |

**最该带走的一句**:关停不是事故,是 FLY-1373 有意画的一个圈。问题在于**圈是按"新循环取代了什么"画的,
不是按"谁在兜底、谁在吵"画的** —— 结果 **判据有缺陷的那条(AlertHub reconcile)留在了圈外,
而专门捞回丢件、专管"人压着不答"的那几条留在了圈内**。详见 research.md §1.3。

## 1. 严重度口径

| 档 | 含义 |
|----|------|
| **S1** | 会**丢掉 founder 已付出的注意力/决策**,或让人**误以为已送达** |
| **S2** | 结构性缺口:该有人兜的时候没人兜,但有其它路径可能偶然兜住 |
| **S3** | 会造成误报/轰炸,消耗信任 |
| **S4** | 记账/可观测性问题,不直接丢消息 |

## 2. 裁定表

### 2.1 无人消费 / 零人类触达

| ID | 缝 | 严重度 | 证据 | 裁定 |
|----|----|--------|------|------|
| G-1 | `stale_approved_ship_dead` —— founder 已批准 + runner 已死,**零人类触达**(有 `console.warn` + 有 `session_events` 审计行,但两样都到不了人;全仓 grep 亲验该事件仅 1 处写入、无读取者) | **S1** | `gate-poller.ts:3844-3866` | **必修。**全图唯一「吞掉 founder 决策且从不对人说」的路径。它是兜底分支(先试 `reWake`),但兜底本身必须出声。**修法 = 把已有记录接到一条人能看见的巷子,不是补记录。**(措辞经 Codex 复核收紧:原写「零事件」不实。) |
| G-2 | `founder_ack_failed` —— ✅/🕒/❓ 回执 PUT 失败,**明确不重试**,founder 看不到回执且无人被告知 | S2 | `founder-reply-deliverer.ts:720-723`,注释 `:678-680` | 建议修。回执是 Annie 判断"我的话被收到没"的唯一信号。 |
| G-3 | `founder_reply_delivered` 无消费者 ⇒ **没有投递率信号** | S4 | `:765-768` | 可选。做可观测性时一并。 |
| G-4 | 其余 `founder_reply_*` / `founder_thread_notify_*` 事件行无读取者(部分经返回值缓解) | S4 | research.md §9 | 可选。 |

### 2.2 静默丢件 / 假成功

| ID | 缝 | 严重度 | 证据 | 裁定 |
|----|----|--------|------|------|
| G-5 | **`SendMessage to:"team-lead"` 黑洞** —— stock 工具不校验收件人,自动建文件并回报成功;已记录 184 条积压;捞回巡检**生产上关着** | **S1** | `Blueprint.ts:1672-1680`、`hook-payload.ts:318-325`;巡检 `gate-poller.ts:1012` + `plugin.ts:7077-7079` | **必修。**唯一在生效的防线是一句提示词。真 Lead 收件箱与黑洞**只差一个文件名**。 |
| G-6 | `checkpoint` 是**不校验的自由字符串**;拼错(如 `aprove_to_ship`)会把 ship 门**静默降级成 Lead-only**,零告警 | **S1** | `index.ts:1599-1602`;过滤 `gate-poller.ts:2439` | **必修。**一个 typo 能让一道 ship 门永远到不了 Annie。加 enum 校验成本极低。 |
| G-7 | `/events` 收到无效 route → **HTTP 200 + warning**,FSM 不动;发送方重试见 2xx 即停 | **S2**(降档) | `event-route.ts:1071-1080`、`:1088-1103` | 建议修。「带成功回执的丢弃」是最坏的失败形状。⚠️ **归属经 Codex 复核更正**:官方 CLI **到不了**这个分支(`complete.ts:97-106` 在 POST 前就拒绝非法 route),故**不是**每次 runner 完成都可能中招 → 由 S1 降为 S2。受害面 = 非-CLI 发送方(旧 emitter、直打 `/events` 的重放/reconciler)。 |
| G-8 | `revoked_orphan` —— `from_agent` 无会话的 `ask` 被丢弃,**一行日志都没有**(旧路径还会 warn) | S2 | `question-admission.ts:169-170` → `:91` | 建议修。至少留一条日志。 |
| G-9 | 无标记的 `--no-block` 门 **永久搁浅 runner**(轮询已退出 + 推送无标记) | S2 | `gate.ts:163-176`;`respond.ts:201,242` | 建议修。代码已自陈风险。 |
| G-10 | 重投不复检 —— `revalidateModel` 仅在 `attempts === 0` 跑 | S4 | `lead-inbox-loop.ts:196` | 可选。 |

### 2.3 单点无 backstop(查岗线关停)

| ID | 缝 | 严重度 | 证据 | 裁定 |
|----|----|--------|------|------|
| G-11 | **`legacy_delivery_watchdogs` 圈内关停的是「兜底」那一批** —— misroute 捞回、lead-pending 升级、FLY-1048 检测簇、闲置/卡住检测、`gate_timed_out`、投递对账 | **S1** | `legacy-delivery-watchdog-policy.ts:6-10`;`plugin.ts:3715, 7016, 7019, 7039, 7049`;`RunnerIdleWatchdog.ts:202,257`;`HeartbeatService.ts:701`;**关停清单原文** `FLY-1373-inbox-consume-loop/plan.md §7` | **不是修 bug,是重划边界(需 Annie 定,见 D-2)。**⚠️ **本条经 Codex 复核重写**:初稿说「关停半径远超预期/未被记录」——**不实**,1373 的 plan §7 逐条列了圈内圈外。真正的问题是**圈按「新循环取代了什么」画,而非按「谁兜底、谁吵」画**:判据有缺陷的 AlertHub reconcile 留在圈外,捞回与「人压着不答」留在圈内。 |
| G-12 | **多个 flag 显示 `1` 但组件根本没接线** —— `DETECTION_GAP_SCAN=1`、`STUCK_FOUNDER_PAGE=1` 都是惰性的 | **S1** | `plugin.ts:6707, 6908, 7039, 7049`;`stuck-escalation.ts:480` | **必修(至少必须让它诚实)。**「flag 开着」≠「功能在跑」。任何人查 env 都会得出错误结论 —— 包括未来做这次整顿的人。 |
| G-13 | shell `lead-alert.sh` **不认统一告警频道**;shell 独有的那批告警(`bridge_wrapper_fail` / `deploy_failed` / `tui_window_lost` 等)结构性地不在 Annie 盯的频道 | S2 | `scripts/lead-alert.sh:1-36`;仓库自述 `product/doc/FLY-915-infra-alerts-pipeline/exploration.md:17`(FLY-368 §9 仍 open) | 建议修。这批恰是"Bridge 死了才发得出"的最需要被看见的。 |
| G-14 | 非 guardrail 的 Lead 事件在 `delivered:false` 时**仍标记为已投递** | S2 | `event-route.ts:2625-2653`(**引用经 Codex 复核更正**,初稿误引 `:844-850`);`HeartbeatService.ts:3125-3126` | 建议修。**限定失败形态**:仅 `delivered:false` 分支如此;`queued` 不标(由持久 inbox loop 接管收据),throw 分支只记 warning。`session_stale_completed` 等会静默丢失。 |

### 2.4 会重复轰炸 / 误报

| ID | 缝 | 严重度 | 证据 | 裁定 |
|----|----|--------|------|------|
| G-15 | **F3 最可能来源:`AlertChannelHub` T2 升级只看持久工单行,从不读活门态**(代码缺陷 CONFIRMED;「它就是 Annie 那次撞到的」= PLAUSIBLE,排除法得出,未坐实) —— 已答完门的 runner 只要 pane 抓不到就被升级;恢复判定 fail-closed / 升级判定 fail-open,方向相反 | **S3** | `ticket-escalation.ts:88-119`;`AlertChannelHub.ts:821, 835, 891, 955-966`;`plugin.ts:8969, 8990-8995` | **必修 —— 依据是代码缺陷本身,不依赖归因成立。**修法明确:升级前加一次活状态复检(`runner-recovery-nudge.ts:195-202` 已有范本可抄)。 |
| G-16 | **F4:Flywheel 不区分「人重开」与「bot 发言导致的重开」** —— 已核 sender 无一检查归档态;解档后归档-一次逻辑不再归档 → 永久停在活跃 | S3 | `founder-thread-notifier.ts:253-292`、`AlertChannelHub.ts:102-131`、`ChatThreadCreator.ts:387/986/1018/1334`;归档-一次 `done-thread-archiver.ts:107`;意图注释 `chat-thread-utils.ts:112-113` | **必修,且应与 G-15 一起修。**注释「不跟她抢」的理由只对**人**重开成立。⚠️ 两处收紧(Codex 复核):① 已核的是**三个 sender**,完整清单未做(`disposition-receipt` / `runner-ready-to-close` / standup / digest 未核);② **「Discord 对 bot POST 也自动解档」本单未实证**(注释原文说的是 *a user sends*)—— 该环节 `unverified`,前后两端已由代码证实。 |
| G-17 | `auto_qa_stuck` 告警 eventId 带时间戳 ⇒ **claims.db 去重永远打不中** | S3 | `auto-qa-effects.ts:461`;对照组 `alertCodexGateBlocked` 故意不带时间戳 `:491-497` | 建议修。当前仅靠上游状态 CAS 兜住。 |

> **G-15 的精确措辞(避免被复核抓过度断言)**:`decideTicketEscalation` 并非"只看年龄" ——
> REPAIRING/ACK 分支是 `attempt_count >= maxAttempts` **OR** `age > timeoutMs`(`ticket-escalation.ts:103`),
> NEW 分支是 `ownerConfigured && age > unclaimedMs`(`:117`)。**准确的指控是**:
> ① **年龄单独就足以触发升级**(是 OR,不是 AND);② 判定的三个输入(`ticket_status` / `attempt_count` /
> `first_seen_at`)**全部来自持久行,没有一个是活状态**。
>
> 而且代码自己承认了这个依赖 —— `:100-101` 注释写「the recovery check ran before us」:
> **它把新鲜度外包给了上游的恢复检查**。缺陷就在这个外包上:上游 `shouldResolveRunner`
> (`AlertChannelHub.ts:955-966`)拿不准时返回 `false`(不放过),而下游照样按超时升级 ——
> **一个 fail-closed 的检查,喂给了一个 fail-open 的决策。**这才是根因,不是"忘了查门态"。

### 2.5 优先级/路由错配

| ID | 缝 | 严重度 | 证据 | 裁定 |
|----|----|--------|------|------|
| G-18 | `runner_lead_pending_escalation` 落 **P3(最低)** —— 名字里没有 `gate`/`question`,升级事件排在普通 `completed` 后面 | S4 | `lead-event-queue.ts:17-43` | 该路径当前关着;**若 G-11 决定重开,此条必须同时修**,否则重开的是一条低优先级的升级。 |
| G-19 | `ask --report` 落 priority 2,排在普通 ask 之后 | S4 | `question-admission.ts:150` | 设计如此(去噪),记录备查。 |
| G-20 | transport=none(agy/kimi)的判定横跨**三个字段**(`adapter_type` / `vendor` / `adapter_type`),无写入期不变式 | S2 · `unverified` | `runner-wake.ts:121`、`send.ts:91`、`auto-qa-effects.ts:637` | 不给确定裁定 —— 是否存在不变式未核。建议单独核一次。 |

## 3. 需要 Annie 拍的三个方向性问题

这三个不是工程选择,是产品/架构方向,**只有她能定**。

### D-1 · 规格与实现已经分叉,以哪个为准?

`product-experience-spec.md §2.4` 写的是「Annie 从不直接对 Runner 说话;**Lead 是唯一沟通渠道**」。
实现已经演化成:**founder 的 ship 批准与单一匹配回复直送 Runner,Lead 只兜歧义**
(`founder-reply-deliverer.ts:556-566, 756-763`)。

⚠️ **措辞经 Codex 复核更正**:初稿写「未被记录的架构漂移/不是任何人选的」——**不实**。
`founder-reply-deliverer.ts:1-18` 明确记录了 FLY-605 的目的,并写明 FLY-175 的 Tadashi-confirmed 硬边界。
准确说法是:**后续的分支设计各自有据可查,但作为 source of truth 的 `product-experience-spec.md` 没同步** ——
分叉是真的,「无人知晓」不是。

| 选项 | 拿到什么 | 代价 |
|------|---------|------|
| **A · 认可现状,更新规格** | 快。ship 批准延迟最低(不经 Lead 中转) | Lead 对 issue 上发生了什么的掌握变弱;歧义兜底是唯一的 Lead 触点 |
| **B · 回归 Lead 唯一枢纽** | 与 spec 一致;Lead 始终知情;一个统一的升级点 | 每次 ship 批准多一跳,延迟增加;Lead 成为新的单点 |
| **C · 分层** —— ship 批准直送(时效敏感),其余经 Lead | 兼顾 | 两条路径要各自维护,复杂度上升 |

> 工程侧观察(不是建议):分叉的每一步都有单可查,**缺的是把它回写进 spec 的那一步**。
> 无论她选哪个,价值主要来自"**明确选了一个、并写回 spec**",而不是选中哪个。

### D-2 · 查岗线要不要重开?按什么口径?(G-11 前置)

现状:`legacy_delivery_watchdogs` 圈内的若干兜底子巷关着(**不是整条查岗线** —— AlertHub reconcile 等仍在跑);
收信主路径已接线且默认开启(**端到端健康度未验证**)。

| 选项 | 说明 |
|------|------|
| **A · 原样重开** `FLYWHEEL_LEGACY_DELIVERY_WATCHDOGS=1` | 最快恢复兜底。但把 FLY-193/218/220 治过的误报风险一起放回来,且 G-18 的优先级错配会生效 |
| **B · 只重开捞回,不重开催办** | misroute 捞回(防丢件)风险低、收益直接;催办类留到判据修好(G-15)再开 |
| **C · 不重开,改为在新架构里重建** | 最干净,也最慢;期间裸奔 |

> 工程侧观察:**A 与 C 之间不必二选一。**B 的风险剖面明显最好 —— 捞回类只在"确实丢了"时出声,
> 天然不轰炸;催办类才是历史上刷屏的那批。

### D-3 · FLY-1388(统一升级流)的形态

这张图对 1388 的输入是:**升级流的问题不在"没有升级流",在"升级流的判据读的是陈旧行"**(G-15)
**和"它被一个 flag 整条关掉了"**(G-11)。

据此,1388 至少有三种形态可选:

| 形态 | 内容 | 取舍 |
|------|------|------|
| **① 修判据** | 保留现有 AlertChannelHub,给升级加活状态复检(抄 `runner-recovery-nudge.ts:195-202`) | 改动最小、见效最快;但仍是两套体系并存 |
| **② 统一到 FLY-1048 升级流** | 把 T2 工单升级并入 detection-escalation 状态机(它已有 CLEARING 静音、fleet 聚合、grace) | 架构最干净;但该状态机**当前整条关着**(G-11),得先决 D-2 |
| **③ 按 Annie 的「处理不了」二分重建** | 需 founder 决策 = 零缓冲直达;Lead 能动手 = 30 分钟止损再升级 | 与她当天拍的框架直接对齐;工作量最大,但只做一次 |

> 工程侧观察:①②③ 不互斥,是**递进**。①能立刻止血(F3 就是它),②是中期收敛,③是她要的终局。
> 如果只能先做一件,①的成本收益比最高 —— 但它不解决"整条线关着"这个更大的问题,
> **所以 D-2 逻辑上排在 D-3 前面。**

## 4. 如果只修三件

按"每单位工作量挽回的 Annie 注意力"排序:

1. **G-11 / G-12 的诚实化** —— 先让"哪些在跑"这件事可查。不修好这个,后面每一次整顿都建在错前提上。
2. **G-15 + G-16**(T2 升级判据 + 归档 thread) —— 同一条链的两端,一起修;这是她今天亲眼撞到的。
3. **G-5 / G-6 / G-7 三个"假成功"** —— 都是小改动,但每一个都能让一条消息带着成功回执消失。

## 4.5 复核记录

**Codex 设计复核 R1 → CHANGES REQUESTED(5 HIGH + 5 MED),10 条全部采纳。**
其中 5 条我自己先回核了源码确认复核是对的(FLY-1373 plan §7 的关停清单原文、
`complete.ts:97-106` 的 POST 前拒绝、`event-route.ts:2625-2653` 的真实分支)。

**R2 又抓出 5 条 NOT RESOLVED + 2 条新缺陷,已全部再修一轮。**R2 的发现全部是同一个形状:
**我改了正文,却漏改了标题和别处的陈旧孪生**(§8 标题仍写「完全静默」、§11.1/11.2 标题仍挂 `CONFIRMED`、
§12 仍写「未被记录」)。这正是「**更正要按 claim 扫、不按位置修,改完 re-grep 验归零**」那条纪律的原因 ——
本轮补跑了 re-grep 归零验证。R2 还抓到我在一次更正里**过度更正**:急着给 G-7 找一个替代受害者,
把 `complete-marker-reconciler` 举成实际受害者,而它同样在 POST 前 quarantine —— 同一条上错了两次。

最有价值的两条,都是**我自己造成的自相矛盾**:

1. 我写「整条查岗线关着」,同时又在 §11.1 证明 AlertHub reconcile 不但在跑、还是 F3 最可能的来源 —— 直接打架。
2. 我写 `stale_approved_ship_dead`「零事件」,而我自己的 research.md 就写着它有 `console.warn` + `insertEvent`。

第三条改变了**结论的性质**:初稿把关停说成「顺手关掉、没人知道」,查证后是**有意画的圈**。
这让指控从「有人疏忽」变成「**边界画在了错的维度上**」—— 后者更弱、更准,也更可行动。

## 5. 本文的边界(诚实声明)

- **运行事实是 2026-07-20 当日活 Bridge 进程的快照。**下次重启若加了 env,§1 的结论即失效。
- **本单未做真机 E2E。**所有裁定基于静态代码 + 运行时 env 读取 + 一次只读生产 DB 查询。
- ~~G-11 是否为 FLY-1373 的预期后果~~ —— **已核实:是**,`FLY-1373-inbox-consume-loop/plan.md §7` 有逐条关停清单。
- **G-15 的归因级裁定(它就是 Annie 那次催办的来源)= PLAUSIBLE,未坐实**;代码级缺陷 = CONFIRMED。坐实需核 `repairChainResolves` 配置或对上 `alert_threads` 的 escalate 时间戳。
- **G-16 中「Discord 对 bot POST 自动解档」未实证**(需真机 E2E);链条前后两端已由代码证实。
- **覆盖面不是全仓 sender 普查** —— 见 exploration.md §3 的未覆盖清单(disposition-receipt / ready-to-close / standup / roundtable / digest)。
- G-20:`unverified`,不给确定裁定。
- AlertChannelHub 的 `repairChainResolves` 前置条件:`unverified`(属配置,未核)。
- **本文不替 Annie 选 D-1/D-2/D-3 的任何一项。**
