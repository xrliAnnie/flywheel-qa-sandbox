# FLY-2883 受控打断 Lead — 探索
Issue: FLY-2883 (https://linear.app/geoforge3d/issue/FLY-2883/语音耳机bridge-受控打断-lead先记审计-正文进信箱标加急-插进它当前这一轮不让它停下手上的活-回复回到发起方claudecodex)
日期: 2026-09-25
基于: 无(设计出处 = FLY-2881 第三版 §2 S4 第 21–24 步 + 琥珀卡「打断别的 Lead」)

## 1. 要解决的问题(founder 原话收敛)

founder 在耳机模式里问别的 Lead,Lead 在忙时 Raya 会问她「等,还是打断」。她选「打断」时,要:

1. 先记审计(谁发起、引用她哪句话、目标 Lead、内容摘要、时间),**审计写不进就不发**;
2. 正文进目标 Lead 信箱,标「加急」,标明「语音代 founder 转问」而不是 founder 本人终端输入;
3. 插进 Lead **当前这一轮**,不取消手上的活:Codex 用 `turn/steer`;Claude 只往终端打一句**固定提示短语**,正文不进终端;
4. Lead 的回复能被发起方按打断 id 取回;
5. Lead 空闲 = 普通信箱投递。

⛔ 不做 Esc / 取消当前轮;⛔ 不动 Lead→Runner 的禁令;只允许 Bridge 注册的调用方对 Lead 发起。

## 2. 现状审计(origin/main a084f3a99)

### 2.1 Lead 的「信箱」到底是什么

| 层 | 事实 | 出处 |
|---|---|---|
| 权威存储 | 每项目 CommDB `mailbox` 表;`priority 0–3`(小的先领);`type` 是自由 TEXT(无 CHECK) | `packages/flywheel-comm/src/mailbox-schema.ts:201-255` |
| 投递循环 | Bridge 内 `LeadInboxLoop` 按 Lead 领批次,交给按载体选的 adapter;Discord 行与普通行不混批 | `bridge/lead-inbox-loop.ts:422-500` |
| 选 adapter | `codex-app-server` → `CodexLeadDeliveryAdapter`,否则 `ClaudeLeadDeliveryAdapter` | `bridge/lead-inbox-runtime.ts:1299-1326` |
| Claude 收件 | 写 Claude Code 原生 team inbox 文件 + `.flywheel.jsonl` sidecar;由**原生 `useInboxPoller`** 读 | `bridge/lead-delivery-adapter.ts:56-89` |
| Codex 收件 | Unix socket `submitBatch` → sidecar 里 `LeadInputRouter.submitBatch` | `bridge/lead-delivery-adapter.ts:91-176`、`lead-backends/codex/CodexLeadInboxSocket.ts:425-554` |
| 语音进信箱 | 语音守护进程 spawn `flywheel-comm chat-ingest --origin voice …`,写一行 `type=discord_chat, source_kind=voice, priority=1` | `packages/voice-codex/src/adapters.ts:103-161`、`flywheel-comm/src/discord-chat-ingest.ts:134-207` |

**关键限制 1(Claude)**:原生 `useInboxPoller` 只在会话空闲时提交;忙时信件排到这一轮结束(`doc/engineer/exploration/new/FLY-142-option4-detail.md:322`)。⇒ **信箱本身进不了 Claude Lead 的当前这一轮**,必须靠终端那句固定提示。而且 Claude Lead **没有**「自己读信箱」的命令(`flywheel-comm inbox` 只给 Runner,按 exec-id)。⇒ 提示短语之后 Lead 要有一个命令能把正文取出来。

**关键限制 2(Codex)**:`CodexLeadProcess.steerTurn`(`CodexLeadProcess.ts:536-545`,发 `turn/steer`,必须带 `expectedTurnId`)零调用方;`LeadInputRouter` 头注释写明 steer 是「Phase 4b 要接但没接」(`LeadInputRouter.ts:20-23`),忙时新输入只排队。Bridge **不持有**任何 `CodexLeadProcess`;生产 Codex Lead 是 TUI 形态,进程在 sidecar(`codex-lead-tui-runtime.ts:1201`),Bridge 只能经 inbox socket 够到它。当前活跃轮 id 只有 sidecar 知道:机器轮在 `CodexTurnExecutor.active.turnId`(`CodexTurnExecutor.ts:83,131-165`),founder 在 TUI 里敲的轮在 `founderTurnActive/founderTurnId`(`codex-lead-tui-runtime.ts:685-687,1234-1243`)。⇒ **steer 必须作为一个新的、经认证的 socket 方法在 sidecar 里执行**。

### 2.2 往 Lead 终端打字的现有原语

- `LeadWindowLocator.locateLeadWindow` + `probeV2LeadPane(…, "send")`:私有 tmux socket、`%0` 由 `lead-body.sh` 起、前台命令必须是 `claude`(`LeadWindowLocator.ts:48-141`)。
- `sendEnterToWindow(LeadWindowRef)` 只发裸 Enter(`bridge/tmux-lookup.ts:919-965`);`quota-revive-scan.ts:533-550` 只打 `continue`。
- 最接近的先例:**`runner-recovery-nudge.ts`**(FLY-368)——白名单短语、先审计后发、审计失败 fail-closed(`:1-21, 358-370`),还有 `WAKE_POINTER_PHRASE = "你有 pending wake,跑 flywheel-comm inbox"`。它只管 Runner;本单是它在 Lead 侧的同构物,但不共用、不放宽它。
- 忙闲判据(Claude,只有 pane 启发式):`model-cap.ts:20-21 ACTIVE_INFLIGHT`(`esc to interrupt` / spinner 秒数 / compacting);`pane-blocked-classifier.ts` 判阻塞;`detectInputBoxPresent` 单独用不可靠(忙时输入框也在)。

### 2.3 调用方认证

- 三档凭据:master `TEAMLEAD_API_TOKEN`(Lead、语音守护进程持有)、ingest(Runner 持有)、scoped(gemini)。HTTP 层没有按调用方的身份(`bridge/plugin.ts:1424-1534`)。
- 语音会话路由:`voiceSessionAuthMiddleware` 记档位,`masterOnly()` + `X-Voice-Lease` + `store.getActiveVoiceLease(sessionId, lease, now)` 绑定「当前持有该会话租约的守护进程」(`bridge/voice-session-routes.ts:45-57, 420-431`)。⇒ **这就是现成的「Bridge 注册的调用方」**:只有持租约的语音守护进程能过;Runner 的 ingest 档直接 403。
- Lead 写身份:`authorizeLeadWrite`(lease claim 或 carrier claim + identityDigest)在 Bridge 侧校验,先例 `bridge/founder-routing-response-route.ts:57-75`。⇒ 回复/取信用它证明「回信的就是目标 Lead」。

### 2.4 审计存储

- StateStore 已是 better-sqlite3 WAL(不是 sql.js);`run()` 同步、抛错直达调用方,`transaction()` 原子(`StateStore.ts:625-765, 6360-6367`)。⇒ 「审计写不进就不发」= 事务抛错即 503,后面什么都不做。
- 追加式审计先例:`lead_config_audit`(`StateStore.ts:14300-14339`,UPDATE/DELETE 触发器 ABORT)。
- 新表必须配 `scripts/lib/fly-2006-retention-tables/teamlead/<table>.json`,否则 Quick Gate `schema_unclassified`。

### 2.5 回复怎么回到发起方(现状)

没有关联 id。Bridge 轮询 Lead bot 在 Discord 的发言塞进 `voice_outbound`,整条频道里 Lead bot 说的话都会被念(`bridge/voice-session-poller.ts:35-111`)。⇒ 本单要新增「按打断 id 取回复」。

### 2.6 并行单与依赖

- FLY-2882(Lead 忙闲只读接口)与本单并行,还在设计 1/7。本单**不依赖**它:投递那一刻由载体自己判(Codex sidecar 知道确切活跃轮;Claude 用 pane 启发式)。
- 语音侧的 handoff 表(`voice_handoffs`)只在 FLY-2799 未合入的 PR #1306 里,main 上没有。⇒ 本单不挂在 handoff 上,做成独立接口;Raya 何时、怎么调用(S4 第 18–20、25 步的对话)归后续集成单。

## 3. 方案候选

| 方案 | 做法 | 结论 |
|---|---|---|
| A 直接往终端敲原话 | 现状手工做法 | ❌ founder 已否(无审计、被当成 founder 本人、回复不回传) |
| B 只写信箱(priority 0) | 什么都不插 | ❌ Claude 忙时这一轮读不到;Codex 忙时也只是排队 |
| **C 受控接口:审计 → 信箱(加急) → 按载体插一句 → 按 id 回信** | 本单 | ✅ 采用 |
| D Bridge 直连 Codex daemon 调 `turn/steer` | 绕过 sidecar | ❌ Bridge 不知道活跃轮 id,且会和 sidecar 的 TurnDemux 抢;socket 边界是既有设计 |
| E Claude 侧用 hook(PostToolUse)注入 | 让 inbox-check hook 把正文塞进 additionalContext | ❌ Lead 已切到原生 mailbox,hook 路径是旧的(FLY-142);而且会让正文绕开「只在终端提示」这条 |

## 4. 采用方案的骨架(细节见 plan.md)

1. 新路由 `POST /api/voice/sessions/:sessionId/lead-interrupts`(master 档 + 活租约),校验 → **一个事务**写 `lead_interrupts` 行 + `lead_interrupt_audit` 的 `requested` 事件;抛错 = 503,什么都不发。
2. 往目标 Lead 所在项目的 CommDB 写一行 `type=lead_interrupt, priority=0` 的信,正文带「加急 · 语音代 founder 转问 · 不构成授权」标头。
3. `LeadInboxLoop` 对这类行单独成批;
   - Codex:adapter 调新 socket 方法 `submitInterrupt`,sidecar 有活跃轮就 `turn/steer`(失败/无活跃轮 → 退回普通排队);
   - Claude:信照常写进 inbox 文件;pane 判为「忙且可安全输入」时,先写审计,再打固定短语 `有加急信件,请先运行 flywheel-comm lead-interrupt pending 看信并回复,然后继续手上的活`。空闲/阻塞/判不准 → 不打字,靠信箱。
4. Lead 用 `flywheel-comm lead-interrupt pending|reply` 取信、回信(Lead 写身份校验);发起方 `GET …/lead-interrupts/:id` 取回复。

## 5. 待确认的假设

- A1:Claude Code 忙时在输入框打字 + Enter 会排成「queued command」,在下一次工具边界并入当前轮,不取消(FLY-2881 第三版:源码快照,生产版本未核实)——**QA 判据 1 就是在验它**。
- A2:Codex app-server 的 `turn/steer` 对 founder 在 TUI 起的轮同样有效(同一 thread,不同 client)。
- A3:两种载体的 Lead 都能跑 `flywheel-comm` 且带 `authorizeLeadWrite` 需要的身份环境(`respond` 命令已在两边用)。
