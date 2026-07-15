# FLY-927 告警频道 → bot 工单队列 — 调研

Issue: FLY-927 (https://linear.app/geoforge3d/issue/FLY-927/infra-alerts-告警频道-bot-工单队列-路由-target-门禁-fly-915)
日期: 2026-07-07
基于: exploration.md(同文件夹;brainstorm gate 已过 —— Tadashi 拍了 Q-A「按响应者划分」+ Q-B「单一发送身份取代 own-bot 链」,均标「Lead 裁定、待 Annie 确认」;另加两处对齐:lead-alert.sh 与 FLY-954 对齐、bridge-wrapper 死机 🚨 收进门禁 scope)

---

## 1. 触点清单(file:line 全核过)

### 1.1 发射漏斗(改造主体)

| 触点 | 位置 | 现状 → 要改 |
|---|---|---|
| kind 全集 | `LeadAlertNotifier.ts:52-116`(`AlertEventType` 闭合 union) | 新增「529 runner 真停」kind + Watchdog v2 checkpoint 类 kind |
| 消息模板 | `LeadAlertNotifier.ts:943-951` `formatContent()` | 新工单头(project/first-seen/owner/状态);仅统一频道模式生效,legacy 路径字节不动 |
| 频道解析 | `LeadAlertNotifier.ts:735-747` `resolveChannel()` | 不动(统一频道已覆盖);Router 在它之前分流 |
| 发送身份 | `postAlertWithSendChain`(:521-562)+ `alert-bot-chain.ts` own-bot→Cass→字母序链 | 新 env 单一发送身份;env 未设 = 现状链(字节兼容) |
| 速率 | 无(仅 `MetaAlertNotifier` 10min 按 reason debounce,不管频道) | root post + `drainQueue()`(:575-689)共用令牌桶 20/min + 溢出攒批 |
| queue/deadletter | `~/.flywheel/alert-queue` / `alert-deadletter`(env 可覆盖,FLY-529 隔离已接) | 复用作攒批载体,不新造 |
| Hub 旁路 | `three_stage_stuck`(plugin.ts:4449-4481)、auto-QA(auto-qa-effects.ts:388/462)直调 `alert()` | 收进同一 alertSink 漏斗(至少 Router 可见);threading 是否补开 = plan 决定 |

### 1.2 工单化(Hub 层)

| 触点 | 位置 | 现状 → 要改 |
|---|---|---|
| per-error thread | `AlertChannelHub.ts`(root→thread→ack→attempt→resolve 全叙事已有) | 叠加:owner @-target、状态字段外显、T2 判定、root edit-in-place |
| `alert_threads` 表 | `StateStore.ts:1380-1397` + 访问器(:4318-4404),active-mapping,`repair_status` 已有 | 扩列:`ticket_status`(NEW/ACK/REPAIRING/RESOLVED/ESCALATED)、`owner_kind`、`attempt_count`、`first_seen_at`;幂等 ADD COLUMN 迁移(照 FLY-267 `reply_channel_id` 模式) |
| @-target 先例 | `AlertChannelHub.ts:302-327` + `infraBotId()`(:351-360):`account_switch` 结果贴 `allowed_mentions.users=[FLYWHEEL_INFRA_BOT_USER_ID]` | 泛化成 kind→owner 映射(纯函数),root 消息即带 @ |
| owner bot 唤醒 | mention-gate(`mention-gate.ts`,FLY-267):cross-dept 频道仅被 `<@botId>` 点名才 `shouldHandle` | 零改动 —— @-target 天然只唤 owner;「没被 @ 不动手」已由机制保证 |
| owner bot 动作 | `POST /api/account-switch`(原子 `claimPending`,`actorBackend!==provider` 已强制)/ `POST /api/rescue`(Bearer) | action 路由顺手写 ticket ACK(状态更新);不新开 ack 专用 API(v1) |
| edit 原语 | `discord-utils.ts:192` `editDiscordMessageInChannel`(PATCH,404 区分) | Hub DiscordOps 增 edit 能力,root 状态原地更新;404 → 降级只发 thread 叙事 |
| 修不掉升级 | Hub needs_human @Annie(`FLYWHEEL_FOUNDER_DISCORD_USER_ID`,唯一真 ping) | 绑 issue 的工单升级改走 founder page 进 issue thread(下 1.3),不绑的保留现状 @Annie |

### 1.3 issue-thread 路由(复用面,基本零新造)

| 触点 | 位置 | 用法 |
|---|---|---|
| 绑定链 | `sessions`(execution_id→issue_id/project/labels)→ `resolveLeadForIssue`(stuck-escalation.ts:513)→ `getChatThreadByIssue(issue_id, lead.chatChannel)`(StateStore:3937) | Router 的「绑 thread?」检查 + 升级投递目标 |
| founder page | `founder-thread-notifier.ts`:gate(:145-227)/milestone(:537-613)/**stuck page**(:459-535,FLY-818 M3);`allowed_mentions.users=[founder]`;审计进 `session_events`;transient 预算 45min;烧完 `escalateFounderThreadUndelivered` | 队列工单「已升级」的绑-issue 落点 = 复用 stuck-page 入口(或加一个通用 escalation 入口,plan 定) |
| 现有双投 | `runner_stuck_unhandled` 今天**既**发频道**又** founder page 进 thread(stuck-escalation.ts:501-604 + `founder_page_ledger` 防重页) | 与新模型吻合:频道=工单(bot 修),thread=升级(修不掉才页)。改动点 = founder page 从「立即页」改为「T2 修不掉才页」——**行为收敛,页得更少** |

### 1.4 发送方门禁(三个执行层)

1. **Discord 权限(硬边界,ops)**:告警频道只给 infra bot + 发射身份 Send。写进部署清单,Annie/Tadashi 执行。
2. **Bridge 代码侧**:`tools.ts` `/send`/`/chat-threads` 无任何告警频道拒发逻辑(已核,grep 零命中)→ 新增:目标 channel == 统一告警频道 且 caller 非 infra 身份 → 4xx 拒 + 提示走告警管道。
3. **shell 侧(与 FLY-954 对齐)**:`lead-alert.sh` 是 FLY-954 选定的 Bridge-independent 告警通道(bin 三件套完整性告警将走它)。现状(:142-217)不读 `FLYWHEEL_UNIFIED_ALert_CHANNEL_ID`,按 projects.json per-lead `alertChannel` 解析;claims.db 去重与 TS 字节一致(:248-279);无速率上限。要改:① 统一频道 env 优先(未设=现状)② 发送身份 env(同 Bridge 新 env)③ 按分钟计数近似 20/min,超限落 queue 由 Bridge 代发(queue 目录已对齐,FLY-529)④ 消息头对齐新 schema(`CONTENT` :288 与 TS 模板同步)。
4. **bridge-wrapper 死机 🚨(FLY-929 时拍的「统一治时带 fallback 再换」,收进本 scope)**:`scripts/flywheel-bridge-wrapper.sh:80-95` `bp_fail_loud` 现用 `SIMBA_BOT_TOKEN`/`DISCORD_BOT_TOKEN` 直 curl `DISCORD_CORE_CHANNEL`。要改:优先经 `lead-alert.sh`(门禁内、统一频道、infra 身份、claims 去重);lead-alert.sh 缺失/失败 → 保留现有直 curl 作 fallback(它在 Bridge 死时触发,绝不能失去投递能力);meta-alert.sh 桌面/文件通道不动。`restart-services.sh`/`update-flywheel.sh` 的 notify_discord = FLY-929 CMP-4 迁移面,**本 issue 不碰**。

### 1.5 Watchdog v2 数据源(全部已存在,零新采集)

| 元组字段 | 来源 |
|---|---|
| 真实 stage | `sessions.session_stage` + `stage_updated_at`(`flywheel-comm stage set` → POST /events → event-route.ts:1498-1544 → `patchSessionMetadata`;`VALID_STAGES` 13 值) |
| 球在谁 | 派生:CommDB `messages.checkpoint`(brainstorm/approve_to_ship→founder;question→lead)、`sessions.status=awaiting_review`→founder、auto_qa_record 在跑→ci(尽力)、其余→runner |
| owner | `resolveLeadForIssue(projects, project_name, issue_labels)` |
| waiting_since | gate `messages.created_at` / `sessions.awaiting_review_entered_at`(:2080-2088)/ `stage_updated_at` / `runner_declared_states.created_at`(park) |
| 投递是否已达 | `session_events` 审计(`founder_thread_notified` 等)+ `founder_page_ledger` —— v2 的「没主动上报」检查 = 查无成功投递审计 |

**既有梯子(保留为快路径,v2 不重建)**:FLY-605 founder-relay(10min grace,gate-poller:1401)/ FLY-637-ext lead-pending 指数退避(20min 起 ×2,K=3 页 Annie,gate-poller:1176,`computeStuckKey` 已用 `session_stage`)/ FLY-195 冻死(pending_gate 硬豁免)/ HeartbeatService `checkAwaitingReviewTimeout`(48h 级)。**v2 = 1h 真相兜底巡检 + 措辞收口**:检查「parked ≥1h 且无成功投递证据 / 责任方无响应」→ 按元组生成真话告警;`three_stage_stuck` 等发射点文案改从元组取(治 FLY-912「Code Review 卡 3h」错措辞)。巡检 piggyback GatePoller/Heartbeat 现有 tick(FLY-169 不加 timer)。

### 1.6 W-B(治假冻结)

- idle≠冻结:`isIdleHealthyPane`(LeadWatchdog.ts:812+,FLY-193 default-ON,真 fixture 背书)—— 覆盖确认 = 补验收断言,不改逻辑。
- 529:Lead 侧 `isTransientThrottlePane`(:871+,FLY-218,live-region + 行级 retry 证据闸)只做**压制**。**runner 侧真停无识别**:StuckRunnerDetector 只会当泛化 stagnation(10min 阈,stuck-candidate.ts:26)。要建:stuck-candidate/quiet-classifier 加 throttle-stall 识别(pane 含 529/限流残留 + 无 retry 活动 + 停滞)→ 独立 kind(暂名 `runner_throttle_stalled`)→ 白名单 @ Claude bot;健康 529(还在烧/在 retry)沿用压制。真 fixture:按 FLY-218 教训,合成 fixture 先行 + 真样本 follow-up。

## 2. 关键约束(实现红线)

1. **echo-immunity 模板签名(FLY-220 回归风险,最重要)**:`LeadWatchdog.ts:749` `ALERT_ECHO_START` 正则锚在旧模板的 `(leadId / kind)` 形态 + 英文告警短语。新工单头**必须**保持可被该正则识别(保留 `(<leadId> / <kind>)` 子串)**或**同 PR 扩正则匹配新模板;fixture:新模板回声 pane 必须仍被 `ownStateRegion` 剥掉。否则告警回声会重新触发 FLY-220 风暴家族。
2. **字节兼容纪律**:所有新行为挂 env(未设 = 现状逐字节)。特别是:发送身份 env 未设 = own-bot 链保留;Router env 未设 = 全部直通现状;schema 仅统一频道模式生效。reverse-compat sentinel 测试两侧。
3. **claims.db eventId 字节一致合同**:shell 与 TS 的 `computeEventId` 逐字节一致(lead-alert.sh:233 註明)。schema/路由改动不得触碰 eventId 构造;若新 kind 进 shell 白名单(:97),两侧同步。
4. **founder ping 收敛不发散**:唯一真 @Annie 保持在 Hub needs_human + founder-thread-notifier 两处;新增升级路径必须复用 `founder_page_ledger` / durable marker 防重页。改「立即页→T2 后才页」是行为收敛,需在 plan 里明确写出对 FLY-818 现行为的变更(Annie 可见)。
5. **不加新 timer**(FLY-169):速率桶、T2 判定、v2 巡检全部 piggyback 现有 tick(GatePoller 3s / LeadWatchdog 30s / Heartbeat 5min / drainQueue 既有节奏)。
6. **owner 未配置零回归**:`FLYWHEEL_INFRA_BOT_USER_ID`(Codex 位,已有)/ 新 Claude 位 env 未设 → 不 @、不 T2 无人认领升级,走现状 Cass 行为。FLY-928 部署后纯配置翻转。
7. **flywheel-comm 消息不用反引号**(zsh 合同,memory)。

## 3. 测试策略(照 FLY-368 判例)

- **单元**:Router 分类纯函数(kind×绑定×env 矩阵);owner 映射纯函数(交叉规则 + 动态 Lead 位);令牌桶(20/min、溢出攒批、跨 drain);schema 模板(含 echo-immunity 正则互证 fixture);alert_threads 迁移幂等;T2 判定纯函数(2 次/5 分/无人认领);checkpoint-park 元组派生纯函数(checkpoint×status×审计存在性矩阵);throttle-stall 识别(fixture:真停 must-alert / 在烧 must-suppress / Lead 侧不受扰)。
- **reverse-compat sentinel**:全部 env 未设 → watchdog→notifier→POST 与今天逐字一致;lead-alert.sh 未设统一 env → 现状路径逐字。
- **集成**:全链(检测→Router→root@owner→ACK→attempt→T2→升级落 thread/[@Annie])mock Discord/tmux 断言调用序列;Bridge 重启后 reconcile 保状态(alert_threads 扩列后 stale 语义不破——现有 stale→resolve→新 episode 测试全绿)。
- **真机 QA(独立 runner,529 Room)**:注入工单 → 看 @-target、状态 edit、20/min 攒批、修不掉升级落 issue thread;shell 侧 lead-alert.sh 走统一频道 + 门禁;生产目录零污染(FLY-529 file-set snapshot 判例)。

## 4. PR 切分建议(plan 里细化)

- **PR-1(频道架构核心,W1+W2)**:Router + schema 头 + echo-immunity 同步 + 单一发送身份 + 20/min 攒批 + lead-alert.sh 对齐 + bridge-wrapper 死机改道 + /send 拒发 + infra-alerts-spec.md 文档。
- **PR-2(工单生命周期 + @-target)**:alert_threads 扩列 + owner 映射 + root @-target + edit-in-place 状态 + T2 判定 + 升级落 thread(founder page 复用)。
- **PR-3(Watchdog v2 + W-B)**:checkpoint-park 元组派生 + 1h 巡检 + three_stage_stuck 等措辞收口 + throttle-stall kind + idle≠冻结验收。
- 依赖:PR-2 依赖 PR-1 的 schema;PR-3 依赖 PR-1 的 Router。可 1+2 合并成一个 PR 若 review 半径可控(plan 定)。

## 5. 明确不做(边界)

- bot 本体建/部署(pool claim、launchd、演练)= FLY-928;notify 频道 sender 迁移 + profile 切换启用 = FLY-929;`FLYWHEEL_BRIDGE_URL`/`STANDUP_PROJECT_NAME` = FLY-925;restart-services.sh/update-flywheel.sh notify_discord 迁移 = FLY-929;PM 验收 = FLY-830;重恢复引擎 = FLY-271。
- Watchdog v2 不重写 605/637-ext/195/626 五套(措辞收口 + 兜底巡检而已);ci 一方 v1 尽力派生不建一等状态机。
