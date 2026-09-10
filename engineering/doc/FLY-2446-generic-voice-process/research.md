# FLY-2446 通用 voice 进程 — 调研
Issue: FLY-2446 (https://linear.app/geoforge3d/issue/FLY-2446/语音-通用-voice-进程会议模式所有-lead-可挂rg随身模式先-raya-用独立-codex-realtime-进程语音文字经)
日期: 2026-09-08
基于: exploration.md

> 目的:把 exploration §3–§6 的每一格落到**现有代码的接缝**上,给 plan 用。每行带 file:line;「未验证」明写。锚点同 exploration:flywheel `d7b75c755`,raya main `0f77e97`,Codex `0.153.2` / `rust-v0.153.2`。

## 1. 语音进程要复用的 Flywheel 接缝

### 1.1 Codex 子进程客户端(不复制 Raya 的 `AppServerClient`)

| 需要 | 现成 | 证据 |
|---|---|---|
| spawn `codex … app-server --strict-config` + stdio 行分隔 JSON-RPC + `initialize/initialized` 握手 + `request/notify` | `CodexLeadProcess`(Lead 壳在用) | `packages/teamlead/src/lead-backends/codex/CodexLeadProcess.ts:166-292`;壳的 argv 组装 `codex-lead-runtime.ts:1312-1314` |
| 服务端→客户端通知分发(`thread/realtime/*`) | `CodexLeadProcessEvents` 事件面 | `CodexLeadProcess.ts:89-100` |
| 服务端→客户端**请求**(审批/elicitation)一律视为协议违规(前台无工具,不该出现) | Raya `V2WebSocketTransport` 的 fail-closed 规则可搬 | raya `apps/voice/src/codex/RealtimeTransport.ts:152-154` |

⇒ 语音进程 = `CodexLeadProcess` + argv 前缀 `--enable realtime_conversation` + 一层从 Raya 提取的 `RealtimeTransport` 协议校验(音色白名单、指令 token 上限、canonical base64、24 kHz mono 校验,`RealtimeTransport.ts:91-124, 169-175, 419-443`)。这满足 FLY-2445 `plan.md:150`「不得从旧 cli/AppServerClient 复制出新的专属 Codex 脑」——复制的是**音频与协议校验**,脑子在 Lead。

### 1.2 realtime 启动参数(exploration §3.2 守卫的落点)

`thread/realtime/start` 参数(`codex-rs/app-server-protocol/src/protocol/v2/realtime.rs:197-263`):

```ts
{ threadId, transport: { type: "websocket" }, version: "v2", outputModality: "audio",
  voice: <lead.realtimeVoice ?? "marin">, prompt: <前台角色书>,
  clientManagedHandoffs: true,        // realtime.rs:199-202 → core handoff_out 直接 return (:802-804)
  includeStartupContext: false,       // realtime.rs:233-235
  delegationAckFiller: false }        // realtime.rs:203-206;v2 忽略也无害
```

后台 thread(前台会话挂在它上面,`thread/realtime/start` 需要 `threadId`):`thread/start { cwd: ~/.flywheel/voice/scratch/<sessionId>, sandbox: "read-only", approvalPolicy: "never", baseInstructions: "<no-brain 一句话>", config: { sandbox_workspace_write: { network_access: false } } }`。Raya 的 `assertThreadReceipt`(model/sandbox 降级即抛,`packages/contracts/src/codex-session.ts:148-173`)反向复用:**sandbox 回执不是 read-only 即拒绝启动**。

`appendSpeech` 语义与预算(必须写进 plan 的分块规则):`core/src/realtime_conversation.rs:1006-1029` → `RealtimeOutbound::StandaloneSpeech` → v2 路径 `:2237-2247` = `conversation.item.create(role=user, "[BACKEND] <text>")` + `response.create`;文本经 `realtime_backend_output` 按 `REALTIME_ASSISTANT_OUTPUT_TOKEN_BUDGET = 1_000`(`:100`)截断。Raya `Speaker` 分块 `chunkChars - wrapperChars`(`speech/Speaker.ts:567-578`)沿用,块上限按 token 估算取保守值(plan 定,🔶 可配)。

### 1.3 Discord 语音房(从 Raya 提取)

| 段 | 文件(raya) | 备注 |
|---|---|---|
| 进房/订阅/播放 | `discord/DiscordAdapter.ts:148-381`(`joinVoiceChannel`、`entersState Ready`、`SubscriptionRegistry`、`createAudioPlayer`) | 依赖 `@discordjs/voice 0.19.2` + `opusscript 0.0.8`(纯 JS,无 sodium 原生依赖,raya `pnpm-lock.yaml:35-37, 1559-1561`);`onnxruntime-node 1.29.0` 是唯一原生模块 |
| 说话人/在场 | `VoiceRoom.ts:175-258`(`PresenceTracker`,只数人不数 bot)、`runtime.ts:1510-1562`(授权说话人 + `activeOwner`) | founder id 改从 Bridge `DISCORD_OWNER_USER_ID`(`bridge/plugin.ts:7081, 9667`)投影;QA 白名单进 `voice.json` |
| 上行/下行 | `pipeline/Uplink.ts`(48k/2ch → 24k mono,闭麦送静音 `:145-156`)、`pipeline/Downlink.ts`(24k → 48k/2ch,`SUPPRESSION_MAX_MS` `:12`)、`audio/AudioClock.ts`(20 ms tick) | 原样 |
| 抢话 | `pipeline/UplinkSpeechGate.ts` + `SileroVad.ts`(模型 SHA 钉死 `:5-6`)+ 平台 `speech_started`(`RealtimeTransport.ts:340-356`)+ 让位(`runtime.ts:1148-1195`) | 原样;C5「能做就做」——Raya 已做到,不退 |
| 字幕镜像 | `discord/VoiceTextMirror.ts:42-100`(1,800 字截断、密钥脱敏、去 @) | 改为:镜像消息**先发、拿 id、再 ingest**(见 §2.1) |
| 转写账 | `speech/TranscriptLog.ts`(内存,含说话人归属 `attributionWindowMs`)+ `evidence.ts`(`realtime_transcript` 行,`runtime.ts:1741-1755`) | 原样;evidence 目录按会话可指定(§4) |
| 状态机 | `session/Coordinator.ts:3-112`(纯 reducer,四个 generation 计数) | 原样;`RoomIdle` 之前加 `Idle`(无 desired 会话时不起 Codex、不进房) |

### 1.4 不提取的部分与替代

| Raya 部件 | 替代 |
|---|---|
| `codex/CodexLeg.ts` baseInstructions/ACTIONS 合同、`RAYA_VOICE_OUTBOX_DIR` | 无。前台无动作合同 |
| `actions/OutboxWatcher.ts`、`actions/ReadbackGate.ts`(`relay_to_lead`,不反对即发,FLY-2439 D25a/b) | mailbox 通路本身;founder 的每句话都进 Lead |
| `inbox/InboxReader.ts`、`packages/contracts/src/voice-inbox.ts`(无生产写入方,D22–D24) | Bridge 回程账本 `voice_outbound`(§3) |
| `approval/*`(ship 审批口头投票) | Bridge 既有 `POST /api/voice/ship-approval`(`bridge/voice-routes.ts:319`)保留;v1 语音进程不接,RG 的「用嘴批 ship」= 后续单 |
| `meeting-context.ts`、`leads/<id>/profile.json`、`voice-leads.json` | registry 投影(FLY-2445 `LeadDirectory`);前台只需 `displayName/realtimeVoice/botUserId/chatChannel` |
| `apps/brain/src/voice-mode.ts` 的 `launchctl kickstart` 监督 | 常驻 daemon 轮询 desired 会话(§3.2);Bridge 不碰 launchctl |

## 2. 入站接缝(exploration §4.1)

### 2.1 镜像消息 → 真 snowflake → `ingestDiscordChat`

| 步 | 接缝 | 证据 |
|---|---|---|
| 发镜像 | 语音 bot REST `POST /channels/<thread>/messages`;Bridge 侧已有同款 helper `postDiscordMessageToChannel`,语音进程用自己的 token 直发(它是取信器,不是 Lead 出站) | `packages/teamlead/src/bridge/discord-utils.ts:201` |
| ingest | `ingestDiscordChat({ dbPath, leadId, chatId: threadId, originChannelId: threadId, messageId: 镜像id, authorId: 说话人id, authorName, ts, msgKind: "guild", text: 转写, founderId, replyChannelId: threadId, replyRoute })` | `packages/flywheel-comm/src/discord-chat-ingest.ts:20-40, 92-103` |
| id 校验 | 五个 id 都走 `snowflake()`;镜像 id / thread id / 说话人 id 都是真 snowflake,**规则不动** | `chat-delivery-envelope.ts:48-57, 65, 112` |
| 幂等 | `delivery_id = chat:<lead>:<镜像id>`;Lead 自己的取信器若也 ingest 同一条,`claimDiscordLane` 返回 `active_inbox` 不插第二行 | `mailbox-queue.ts:698-726` |
| 门铃 | `lane === "inserted_inbox"` 时 `POST /api/lead-inbox/nudge`(可丢) | `packages/flywheel-comm/src/index.ts:831-840` |
| CLI 形态 | `flywheel-comm chat-ingest --lead … --chat-id … --origin-channel-id … --message-id … --author-id … --author-name … --ts … --msg-kind guild --content-stdin --founder-id … --reply-channel-id … --db …` | `index.ts:712-838` |

**Lead 取信器对 bot 消息的处理(决定会不会「看到两次」)**:Claude 插件 `messageCreate`(`~/.claude/plugins/cache/flywheel-plugins/discord/0.0.7/server.ts:1597`)与 Codex `CodexDiscordMailboxStrategy.accept`(`codex-lead-tui-runtime.ts:665` 起)的 bot 过滤规则**未逐行核**;但两种结果都安全:过滤掉 ⇒ 只有语音进程 ingest;不过滤 ⇒ 撞同一幂等键。plan 的负向测试覆盖后者。

### 2.2 envelope 加 `origin`(照 FLY-2443 先例)

| 改点 | 现状 | 改法 |
|---|---|---|
| `ChatDeliveryEnvelopeV1` | `heldSince?/heldReason?` 是「可选 + 闭集 + 成对校验」的先例 | 加 `origin?: "discord" \| "voice"`、`voiceSessionId?: string`(origin=voice 时必填,UUID 校验);缺席 = discord | `chat-delivery-envelope.ts:28-30, 113-125` |
| 渲染 | `source="plugin:discord:discord"` 字面量 | origin=voice ⇒ `source="voice"`,并在 `<channel …>` 内加一行 `[voice] 这句话是 founder 口述、会被念给她听;请在本 thread 用可说出口的短句回复` | `discord-chat-ingest.ts:63-88` |
| DB 列 | `source_kind` 无 CHECK,今天硬编码 `"discord_chat"` | origin=voice ⇒ `sourceKind: "voice"`;`type` **保持 `discord_chat`**(否则 `discordBatchPartitionKey` 把它归成泛 `model`,丢回程路由分区) | `discord-chat-ingest.ts:146, 161-164`;`mailbox-schema.ts:200, 202` |
| CLI | `--version-probe` 输出 `protocolVersion: 2` | 加 `--origin voice --voice-session <uuid>`;probe 升 3 | `index.ts:741-746` |
| 泵/适配器 | 无改动 | `lead-inbox-loop.ts` 只按 `type` 分区 | — |

## 3. 回程接缝(exploration §4.2)

### 3.1 Bridge 轮询绑定频道(复用 Codex 取信器同族)

| 需要 | 现成 | 证据 |
|---|---|---|
| 按 `(project,lead)` 解析 bot token,token 不出 Bridge | `buildResolveBotToken` | `packages/teamlead/src/lead-backends/codexLeadBridgeWiring.ts:27` |
| REST 拉频道消息(`after=<cursor>`,首次基线到最新,持久 cursor) | `RestPollDiscordInboundSource` + `InboundCursorStore`(`DISCORD_API = https://discord.com/api/v10`) | `lead-backends/codex/RestPollDiscordInboundSource.ts:47-131, 168-217, 262-276`;`InboundCursorStore.ts` |
| 只认该 Lead 的 bot | registry `botUserId`(registry 拥有,不从 token 推) | `ProjectConfig.ts:23` |
| 频道授权集(thread 的父频道 ∈ `{chatChannel, generalChannel, roundtableChannel}`) | `buildAuthorizeLeadChannel` | `codexLeadBridgeWiring.ts:65-100` |
| 单条取消息(补漏/校验) | `fetchDiscordMessageFromChannel` | `bridge/discord-utils.ts:94` |

**差异**:`RestPollDiscordInboundSource` 的消费者是 mailbox 策略;回程用它的**拉取与 cursor**部分,消费者换成 `voice_outbound` 账本写入 + 作者过滤。是否抽公共基类由 plan 定(倾向:新 `VoiceOutboundPoller` 组合而非继承,避免动 Codex 取信器)。

### 3.2 Bridge 建绑定 thread(会议模式)

| 需要 | 现成 | 证据 |
|---|---|---|
| 用 Lead bot 在其 `chatChannel` 发一条卡 + 从卡开 thread + 拉 founder 进 thread | `ChatThreadCreator`(`startThreadFromMessage`、`addThreadMember(threadId, ownerUserId, botToken)`) | `bridge/ChatThreadCreator.ts:15, 382-466, 500-547` |
| thread 在授权集内(父频道 = chatChannel) | `buildAuthorizeLeadChannel` 已含「父频道在集合内的 thread」 | `codexLeadBridgeWiring.ts:65-100` |

### 3.3 语音进程侧

`GET /api/voice/sessions/:id/outbound?afterSeq=` → 逐条 `Speaker.speak({pendingKey: messageId, text})` → `confirmed/unconfirmed/dropped` → `POST …/spoken`。`Speaker` 的确认协议(`speech/Speaker.ts:384-458`)与「只在 `Live` 才念」(`:175-181`)原样。

## 4. 编排与产物接缝(exploration §4.3, §5)

### 4.1 Bridge 路由与鉴权

| 路由 | 鉴权 | 备注 |
|---|---|---|
| `POST /api/voice/sessions`、`…/:id/stop` | `tokenAuthMiddleware(config.apiToken, config.geminiAgentToken)`(`bridge/plugin.ts:1162`) | **Claude Lead 与 Codex Lead 进程都持有 `TEAMLEAD_API_TOKEN`**:`packages/teamlead/scripts/claude-lead.sh:265`、插件 `server.ts:370`;Codex launcher 别名 `FLYWHEEL_API_TOKEN`(FLY-2442 C5)。⇒ exploration U5 已解:**不需要**接受 ingest token |
| `GET /api/voice/sessions/desired`、`GET/POST …/:id/{outbound,state,spoken}` | 同上;daemon 从 `~/.flywheel/.env`(wrapper `set -a; source`,`scripts/flywheel-voice-bridge-wrapper.sh:38-42`)拿同一 token | — |
| 挂载点 | 与现有 `createVoiceRouter` 同一前缀 `/api/voice`(`plugin.ts:9378-9382`);新路由放新文件 `voice-session-routes.ts`,不改 FLY-546 四条 | — |

### 4.2 Bridge 表(teamlead.db)

| 表 | 主键 | 列(草案) |
|---|---|---|
| `voice_sessions` | `session_id TEXT` | `mode CHECK IN('meeting','rg')`, `project_name`, `lead_id`, `guild_id`, `voice_channel_id`, `bound_channel_ids TEXT(json)`, `meeting_id`, `evidence_dir`, `requested_by`, `state CHECK IN('desired','warming','live','ending','ended','failed')`, `reason`, `daemon_boot_id`, `created_at`, `updated_at`, `ended_at` |
| `voice_outbound` | `seq INTEGER PK AUTOINCREMENT` | `session_id`, `message_id TEXT UNIQUE`, `channel_id`, `author_id`, `text`, `observed_at`, `spoken_status CHECK IN('pending','confirmed','unconfirmed','dropped')`, `spoken_at` |

FLY-2006 保留注册表三处同改(`scripts/lib/fly-2006-retention-registry.mjs` 分组、`scripts/__tests__/fixtures/fly-2006-teamlead-production-tables.json`、`packages/teamlead/src/__tests__/fly-2006-database-retention-sweep.test.ts` 硬计数);两表归 `protectedCurrentOrReference`(证据,不进 `deleteTarget`,避免再加 engine/consumer-gate 两处)。

### 4.3 registry 字段

| 字段 | 校验位置 | 语义 |
|---|---|---|
| `LeadConfig.voiceModes?: { meeting?: boolean; rg?: boolean }` | 与 `roundtableChannel` 同块(`ProjectConfig.ts:575-590` 附近),布尔严格 | `meeting` 缺席 = 开;`rg` 缺席 = 关;消费者只认 `=== false` / `=== true`(FLY-231 反向兼容) |
| `LeadConfig.realtimeVoice?: string` | 新块,枚举 = Raya 白名单十个 v2 音色(`RealtimeTransport.ts:91-102`) | 缺席 ⇒ `marin`;C8 的三个已定映射由运维写入 |
| 不动 `LeadConfig.voice` | `:194, 545-561` | edge-tts 语义,FLY-546 消费者不变 |

### 4.4 宿主配置与 launchd

| 项 | 接缝 |
|---|---|
| `~/.flywheel/voice.json` | Bridge 与 daemon 都读;`readTrustedFile` 风格(realpath、非 symlink,`meeting-notes-config.ts` 已有实现可搬) |
| bot token | `voice.json.botTokenEnv` → 名称;值来自 `.env`;推荐 = `HuddleConfig.orchestratorBotTokenEnv`(`packages/voice-bridge/src/config.ts:170-182` 读法可搬),前提 `com.flywheel.voice-bridge` 未加载(2026-09-08 `launchctl list` 无此 label);exploration U4 已问 Lead(question `804c102d`) |
| 单元 | `scripts/launchd/units.manifest` 加一行 `com.flywheel.voice\tcom.flywheel.voice.plist\thold\t0\t…`(`:16` meeting-notes 先例);plist 抄 `com.flywheel.voice-bridge.plist`;wrapper 抄 `flywheel-voice-bridge-wrapper.sh`(含 FLY-2190 host tmux gate) |
| 重启分类 | `scripts/restart-services.sh:1937-1974` `classify_changes` 对 `packages/voice-*`、`scripts/*wrapper*.sh` **无匹配** ⇒ 加 `packages/voice-codex/*` → `restart_voice`(新动作)或明写「靠 launchd KeepAlive/手动」 |
| 基名白名单 | 语音 daemon **不是 Lead 载体**,不进 `host-tmux-selection-gate.sh:125-160` 等六处 Codex Lead 白名单(它们只管 `flywheel-codex-lead-wrapper-*` / `flywheel-lead-wrapper-v2`);但 wrapper 仍走 gate(FLY-2190 对所有 KeepAlive 直出生的单元) |

### 4.5 会议产物零改动的条件

FLY-2033 只读 `<meetingStateDir>/meetings/<uuid>/meeting.json`、`…/voice-signal.json`、`voice-evidence/events.jsonl`(`meeting-notes-config.ts:212-275`),信任窗按 `meeting_container_starting/live` 锚点(`meeting-notes-scheduler.ts:600-682`)。⇒ 会议模式的 `POST /api/voice/sessions` 必带 `evidenceDir`(= CoS 的 meetingStateDir),语音进程在其中写 `voice-evidence/events.jsonl`(`realtime_transcript` + 两个锚点行)与 `meetings/<meetingId>/voice-signal.json`(`ready/live/interrupted/ended`,单调、终态不可改,raya `packages/contracts/src/meeting.ts:590-614`)。`evidenceDir` 校验:realpath 存在、目录、在 `voice.json.evidenceRoots[]`(默认 = 各 project `projectRoot` + `~/.flywheel`)内。

## 5. 未验证清单(plan 必须标 🔶 或列 QA)

| # | 项 | 影响 |
|---|---|---|
| N1 | 前台模型在 conversational 下的「只应一字」可控性、`unconfirmed` 比例 | 守卫 4 是软约束;QA 指标 + 退路(transcription 模式)|
| N2 | Claude 插件 / Codex 策略对 bot 消息的过滤规则 | 只影响「是否撞幂等键」,两种结果都安全 |
| N3 | Bridge 3 s 轮询 × 泵 30 s 窗的端到端体感 | 不定阈值;录音波形量 |
| N4 | 独立 `codex-home` 登录 vs 池账号软链 | rollout 前置 |
| N5 | `--enable realtime_conversation` 在 0.153.2 仍是实验开关的形态(Raya preflight 同 argv 已验) | preflight 复用 raya `preflight.ts:59` 思路 |
| N6 | `@discordjs/voice 0.19.2` 在 Flywheel monorepo 的 pnpm 解析(opusscript 而非原生 opus) | plan 锁版本,QA 装机验证 |
| N7 | Huddle orchestrator bot 是否有目标语音房的 CONNECT/SPEAK 权限 | rollout 前置;否则新建 bot |
