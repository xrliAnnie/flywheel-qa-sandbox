# FLY-2883 受控打断 Lead — 调研
Issue: FLY-2883 (https://linear.app/geoforge3d/issue/FLY-2883/语音耳机bridge-受控打断-lead先记审计-正文进信箱标加急-插进它当前这一轮不让它停下手上的活-回复回到发起方claudecodex)
日期: 2026-09-25
基于: exploration.md

本文件把 exploration 里每个设计决定要依赖的事实逐条钉死(出处均为 origin/main a084f3a99),并给出取舍。

## R1 发起方身份:复用语音会话租约,不新建调用方注册表

- 语音守护进程是唯一的生产发起方(FLY-2881 S4 第 21 步)。它已经持 master token + 会话租约 `X-Voice-Lease`;`store.getActiveVoiceLease(sessionId, lease, now)` 判「此刻合法持有该会话」(`bridge/voice-session-routes.ts:420-431`)。Runner 只有 ingest 档,`masterOnly()` 直接 403(`:45-53`)。
- 取舍:另建「调用方注册表」(新表 + 新 token)是给还不存在的第二个发起方预付成本。**v1 的「Bridge 注册的调用方」= 路由挂在 `/api/voice/sessions/:sessionId/` 下、要求 master 档 + 活租约**;代码里用一个只有 `voice_session` 一项的 `initiator_kind` 枚举(表上 CHECK),以后加发起方要显式改枚举 + 评审。
- QA 可用性:529 房里 QA 台架可以自己 `POST …/claim` 拿租约扮演守护进程(不需要 founder 真人进房;`live` 才要真人,见记忆 reference_voice_room_live_requires_founder_presence)。所以路由接受会话状态 `claimed|warming|live`,不要求 `live`。

## R2 「引用 founder 的哪句话」:可验证,不是自由文本

- 语音的每句 founder 原话都以 `chat:<sessionLead>:<messageId>` 为 id 进 CommDB(`discord-chat-ingest.ts:163-197`),信封里有 `origin`、`voiceSessionId`、`authorId`。
- `CommDB.openReadonly` + `inspectMailboxDeliveryState` / `inspectMailboxDeliveryContent` + `parseChatDeliveryEnvelope` 能在「活表」和「已归档」两处查到(`commands/message-status.ts:107-124`)——这正是语音守护进程自己确认投递用的查法(`voice-codex/src/adapters.ts:163-198`)。
- 决定:请求必须带 `founderMessageId`(17–20 位雪花号);Bridge 查会话所在项目 CommDB,要求 `location ∈ {live, archived}`、`origin === "voice"`、`voiceSessionId === sessionId`、`authorId === session.founderUserId`。查不到 = 422 `founder_quote_unverified`(也记审计 `refused`)。这把「实时模型自己编了一句 founder 说的话」挡在门外,也让审计里的消息 id 真的指向一句她说过的话。
- 已知边界:引擎 B(FLY-2799,未合入)的原话若不再走 chat-ingest,这个校验器要随集成单调整;校验器做成一个独立函数,便于替换。

## R3 审计 fail-closed 的语义

- StateStore = better-sqlite3 WAL,`run()` 同步、抛错直达,`transaction()` 原子,`synchronous=NORMAL`(掉电最多丢最后一个事务)(`StateStore.ts:625-765, 6360-6367`)。
- 决定:请求行 + `requested` 审计事件**同一个事务**;事务抛错 → 503 `audit_unavailable`,**不写信、不插轮、不打字**。之后每一次「对 Lead 产生可见效果」的动作(steer / 终端打字)之前都先写一条审计事件,写不进就不做那个动作(信已在信箱里,Lead 仍会在空闲时看到——降级而不是丢信)。
- 追加式:审计表用 `lead_config_audit` 的触发器写法(UPDATE/DELETE → `RAISE(ABORT)`)。
- 阴性对照怎么真跑(QA 判据 2):不加生产后门。QA 在 529 slot 的 `teamlead.db` 上临时装一个 `BEFORE INSERT ON lead_interrupt_audit … RAISE(ABORT,'qa_forced')` 触发器(WAL 下对活 Bridge 立即生效),发起一次打断 → 期望 503、目标 Lead 信箱无新行、pane 无输入;删触发器后恢复。单测里用同样的触发器做。

## R4 Codex:steer 必须在 sidecar 里做

- `CodexLeadProcess.steerTurn({threadId, expectedTurnId, input, clientUserMessageId})` → JSON-RPC `turn/steer`,协议错误抛 `CodexLeadProcessError(kind:"protocol")`(`CodexLeadProcess.ts:536-545, 749-757`)。输入形状与 startTurn 一致:`[{ type: "text", text }]`(`CodexTurnExecutor.ts:160`)。
- 活跃轮 id 只在 sidecar:机器轮 `CodexTurnExecutor.active.turnId`;founder 在 TUI 起的轮 `founderTurnId`(`founderTurnActive` 初值 `"unknown"`)(`codex-lead-tui-runtime.ts:685-687, 1234-1243`)。
- Bridge→sidecar 唯一通道是认证的 Unix socket(HMAC `authSecret` + `ownerEpoch`);现有方法里没有 steer(`CodexLeadInboxSocket.ts:42-103, 425-554`);新增方法要走 `capabilities.features` 协商(先例 `discord_route_v2`,`lead-delivery-adapter.ts:115-143`)。
- 决定:新增 socket 方法 `submitInterrupt` + 特性位 `lead_interrupt_steer_v1`。sidecar 内的逻辑:
  1. 同一 batchId 已记过 → 返回 `duplicate`(不再 steer);
  2. 有活跃轮(机器轮优先,其次 `founderTurnActive === true` 的 founder 轮)→ 先把 batch 记进 journal(`steering`)→ `turn/steer` → 记 `steered`,返回 `steered`;
  3. 无活跃轮 / steer 抛错(轮刚结束、expectedTurnId 不符)→ 走普通 `router.submitBatch`,返回 `queued`;
  4. 崩在 `steering` 与 `steered` 之间的重投 → 当作 ambiguous,走普通排队(**至少一次**;Lead 可能看到两次,回信接口幂等兜住)。
- 旧 sidecar(无特性位)→ adapter 退回普通 `submitBatch`,disposition = `mailbox_only`。无头 app-server 形态(只用于测试/回滚)不接此特性,同样退回。
- A2(steer 对 founder 在 TUI 起的轮是否有效):app-server 协议 `turn/steer` 只认 threadId + expectedTurnId,不区分哪个 client 起的轮(FLY-2881 第三版引 codex @44a9bfa `app-server-protocol v2/thread.rs:1649-1666`)。仍列为 QA 要验的点。

## R5 Claude:信箱进不了当前轮,只能打一句固定短语

- 原生 `useInboxPoller` 忙时不提交(`doc/engineer/exploration/new/FLY-142-option4-detail.md:322`)。
- 在忙的 Claude Code 输入框里打字 + Enter = 排队指令,下一次工具边界并入当前轮,不取消(FLY-2881 第三版,源码快照;生产版本未核实 → QA 判据 1)。
- 打字原语:`locateLeadWindow` + `probeV2LeadPane(…, "send")`(私有 socket、`lead-body.sh` 父进程、前台是 claude)(`LeadWindowLocator.ts:48-141`)。现有 `sendEnterToWindow` 已经是「先 probe 再 `tmux -S sock send-keys -t %0`」的写法(`tmux-lookup.ts:919-965`);本单在它旁边加一个同构的 `sendLiteralLineToLeadPane(ref, text)`(`send-keys -l -- text` 再 `Enter`)。
- 何时打字(全部在 capture 快照上判,判不准 = 不打):
  - 忙:底部区域命中 `ACTIVE_INFLIGHT`(`model-cap.ts:20-21`,`esc to interrupt` / spinner 秒数 / compacting);
  - 不阻塞:`pane-blocked-classifier` 不判为阻塞,且不出现权限/选择对话框提示;
  - 输入框为空:提示符行 `❯` 后无内容(founder 可能正在 cmux 里打字——绝不拼到她的半句话后面)。
  - 不满足任一条 → 不打字,disposition = `mailbox_only`,原因写进审计。
- 固定短语(白名单、完全相等):`有加急信件,请先运行 flywheel-comm lead-interrupt pending 看信并回复,然后继续手上的活`。不含 id、不含正文。竞态(快照后这一轮恰好结束)的后果:短语变成一条新输入,Lead 照样去看信并回复,之后信箱那份再到时会看到「已回复」——无害。
- 取舍:Claude 侧**不**另建忙闲接口;FLY-2882 落地后可以把判据换成它的只读接口(follow-up)。

## R6 回信:显式回信接口,不靠 Discord 轮询

- 现状回信无关联 id(`voice-session-poller.ts:35-111`)。
- Lead 写身份:Bridge 侧 `authorizeLeadWrite`(lease claim 或 carrier claim + identityDigest),先例 `founder-routing-response-route.ts:57-75`。
- 两种载体的客户端不同:
  - Claude Lead:壳里有 `TEAMLEAD_API_TOKEN`,已经在用 `flywheel-comm respond` 这类带身份的 Bridge 写命令 → 新增 `flywheel-comm lead-interrupt pending|reply`。
  - Codex Lead:raw bearer 只在 `lead_actions` MCP 子进程环境里,Bridge 写一律走 `lead_actions` 工具(`lead-actions-main.ts:374-390`)→ 新增 `lead_actions` 工具 `lead_interrupt_pending` / `lead_interrupt_reply`。
  - 两者打同一对 Bridge 路由,服务端只有一份校验。
- 回信幂等:同一打断只收第一条回复(之后 409 `already_replied`,原文不覆盖);回复上限 2000 code points。
- 发起方取回:`GET /api/voice/sessions/:sessionId/lead-interrupts/:interruptId`(master + 活租约,且只能看本会话发起的)。

## R7 新增表的周边义务

- `scripts/lib/fly-2006-retention-tables/teamlead/lead_interrupts.json`、`lead_interrupt_audit.json`,分类 `protectedCurrentOrReference`(与 `lead_config_audit` 同)。
- 新 `execFile("tmux", …)` 调用点落在已登记的 `tmux-lookup.ts` 里;实现时按记忆 reference_new_spawn_kill_or_shell_test_must_be_registered_in_four_inventories 核对 child-process census,不新建 shell 测试文件。
- 不改 `lead-rules-base/*.md`(全 main 共享的字节预算余量只剩个位数,见记忆 reference_lead_rules_byte_budget_is_shared_headroom_across_prs)。Lead 该怎么做写在信件标头和提示短语里,自说明。
