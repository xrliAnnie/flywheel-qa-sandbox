# FLY-2796 耳机模式最小集 — 实施计划
Issue: FLY-2796 (https://linear.app/geoforge3d/issue/FLY-2796/语音v2-耳机模式最小集引擎无关一进来主动播报现在什么情况-哪些要你决定会话中有新消息主动念长时间无话报平安-从-9-月初)
日期: 2026-09-23
基于: research.md

Status: approved (effective reviewVerdict=APPROVED, R3 request 6d3956ba-c2a6-45d2-9590-9a433a693fd5)

## 1. 给使用者看的结果

进入耳机模式就听到“现在的情况”和“等你决定的事”，会中有新消息会主动念，安静一段时间会报平安。两个引擎使用同一套房间和模式规则；切引擎不改变哪些消息会念。

本单还铺好可靠信箱与来源回执：发给 Lead 的事能查到送达结果，但这不代表 Lead 已动手。本阶段仅设计；A/B 真人比较在 V6。`/gemini` 和 `/eleven` 现有命令继续保留，收敛后的真房兼容验收在本单 QA。

```mermaid
flowchart LR
  L[所有 Lead 的问题与汇报] --> I[Bridge 持久收件箱]
  I --> M[耳机规则：开场 / 新消息 / 报平安]
  M --> E[V1 引擎接口 A 或 B]
  E --> R[同一 RoomIO 房间实现]
  R --> U[耳机中的她]
  U --> R
  R --> T[带说话来源的转写与持久回执]
  T --> H[需动手的请求：送 Lead 信箱]
```

### 权威、范围与默认值

- 按注入 issue 的 G1/G2；V1 原“G1 owner 未定”由本单关闭。Lead 问答 `8b5d2b54-ec11-4ab7-a173-8ae695b7fb2d` 确认 G1-d 为交付门，不阻止本单开工。
- 第一批全部纳入，不增加偏好筛选、用嘴批 ship、打断或动手前专名编号复述。既有 ship 专用通道维持现状；本单新模式入口不调用它。
- 存活信号配置 `headphone.heartbeatIntervalMs`：默认 `300000`（五分钟，**工程默认，待她用过再定**）；正安全整数且 ≤2147483647，非法值启动报错。测试注入时钟；不是网络 keepalive，也不替代引擎健康检查。
- 不开放前台自主回答的新权限，不替 A/B 选模型或端点，不增加第二个 Codex app-server。

## 2. 所有权与文件切线

| 所有者 | 具体落点 | 职责 |
|---|---|---|
| 共享类型 | `packages/voice-core/src/room-io.ts`、`types.ts`、`index.ts` | RoomIO、RoomAudioOwner、V1 规范形状、转写回执；复用 AudioFormat |
| 唯一房间实现 | `packages/voice-bridge/src/room/RoomIO.ts`，从 `voice-codex/src/discord-room.ts` 提取 | 只此一个 Discord 收/放音、presence、健康、取消、归属、slot/lease 驱动 |
| 房间支持闭包 | `voice-bridge/src/room/` 内移入 `audio.ts`（其中包含 WaitingMouth 类）、`receive-health.ts`、`speaker-attribution.ts`、`audio/*`、`pipeline/*` | 移动 codex 原文件，保留既有算法和测试，不重写 DSP/VAD |
| 兼容适配 | `voice-codex/src/{discord-room,audio}.ts` 转导出；bridge `VoiceRoomRuntime.ts`、`roomEars.ts`、`assistant/AssistantSpeaker.ts` | 保留旧 API，委托同一 RoomIO 实例；不能保留第二套物理播放器 |
| 模式策略 | `voice-core/src/headphone/{InboxReader,SpeechBrief,ExitProtocol,HeadphoneMode}.ts` | 找回 Raya 规则并接 V1；只管理播报 item，不另设会话状态权威 |
| 模式 I/O | `voice-headphone/src/{room-io,bridge-client}.ts`，`voice-codex/src/{cli,session}.ts` | 引擎事件/房间/Bridge 持久回执组合；模式模块只依赖注入接口 |
| Bridge 持久化 | `teamlead/src/StateStore.ts`，`bridge/{headphone-inbox,headphone-routes,voice-handoff-routes}.ts` | inbox、cursor、ack、claim、handoff durable 状态 |
| 唯一转写底座 | `voice-core/src/transcript.ts` | 原有 sink 的 durable 扩展，不搬 Raya TranscriptLog store |
| comm 通用载体 | `flywheel-comm/src/{chat-delivery-envelope,discord-chat-ingest}.ts` | 增量 typed handoff metadata；沿用 deterministic delivery identity |

`RoomIO` 实现和 `ROOM_IO_VERSION = 1` 从 `flywheel-voice-bridge` 同一公共导出提供；稳定 implementation key 为 `flywheel-voice-bridge/room/RoomIO#createRoomIO`。不增加新包。voice-headphone/src/room-io.ts 仅接收注入的 core RoomIO 类型和 V1 engine，不 import bridge 实现；实例由 codex/bridge composition root 传入，因此不增加 headphone → bridge 依赖。codex composition root 导入 headphone 的注入组合函数，显式新增 `voice-codex/package.json` 的 `flywheel-voice-headphone: workspace:*` 依赖；方向 codex→headphone→core 无环。bridge legacy composition 不依赖 headphone（V2 模式只由 codex carrier 组合），仅创建自己共用的 RoomIO。codex → bridge → core 依赖方向保持；room 内将原 `flywheel-voice-bridge` 自引用改成本包相对 import。`RealtimeAudioOwner` 移到 core，legacy 类型可转导出别名。

依赖闭包具体迁移：codex `audio/{AudioClock,FrameQueue,JitterBuffer,Resample,Silence}.ts`、`pipeline/{Uplink,UplinkSpeechGate,SileroVad}.ts`、`receive-health.ts`、`speaker-attribution.ts`、`audio.ts`、`discord-room.ts`。ONNX runtime `1.29.0` 迁到 bridge manifest（复用已装依赖），模型随提取包发布、保留 sha256 验证；修改 model fileURL 基准及 `files` 清单，不靠 codex 源目录相对路径。旧 import 先保持转导出；确认零消费者后才删除多余 shim。

## 3. RoomIO v1 可实现合同

### 3.1 输入、输出与调度

- 输入 `RoomAudioFrame = {pcm:Buffer, format:AudioFormat, sessionId, generation, sequence, capturedAt, utteranceId:string|null, attribution:known|unknown}`。known 由房间收音身份产生；静音/多人重叠/关联失效给 unknown，不能从模型文字或时间区间猜成 known。旧 ownerUserId 转此 union；A/B 将房间关联依据带到最终 utterance。
- 格式复用 `AudioFormat`；RoomIO 接受 PCM16 的 16k/24k mono、48k stereo，进入边界核验整样本长度、有限合法采样率、通道和流内格式一致。帧接口中的 WAV/MP3 显式 rejected；旧提示音及压缩 TTS 走下述 clip 操作，不能把媒体 bytes 改标签冒充 PCM。
- 输出 `playSpeech({speechId, generation, sequence, pcm, format, final})` 支持完整 buffer（单帧 final=true）和流式帧；同 speechId 单序列、同格式、final 只一次；无音频 final 合法用于结束。调用返回该帧被本地接受/拒绝的结果，末帧 receipt 仅 `submitted`；不宣称 drain 或听到。RoomIO 按容量提供异步背压，生产者 await，不无限堆内存、不静默丢正文。低水位恢复，close/cancel 唤醒并 reject 等待者。
- 非 PCM 兼容操作 `playClip({speechId,generation,source:{kind:"file",path}|{kind:"encoded",bytes,format:"wav"|"mp3"},priority:"cue"|"speech"})` 复用 `DiscordDeps.createResource` 的 file / probeable stream 分支（discordWiring.ts:792），由既有 ffmpeg/prism 解码，**仍使用 RoomIO 同一 AudioPlayer**，不造 decoder/helper 或第二 player。path 仅接受应用配置的 cue 文件/受管 TTS 临时文件，不接模型任意路径。AssistantSpeaker 的 earcon/filler 和 LeadSpeaker 的 edge-tts bytes/text→TtsEngine 明确映射到此操作。cue 遇正在播的正文沿用 skip+diagnostic，speech 媒体按同一串行队列播放；generation/lease 在排队和 player.play 前重验。Playing/Idle/error 事件决定该 clip 本地回执；未知长度时 audibleTail（估算）保持 remainingMs=null、drained=false，直到该资源 Idle 后经过余量。取消统一 stop player、清流和解码资源，晚回调 fenced。启动保留 ffmpeg preflight，缺解码器明确报错不静音。
- **R2 修正：clip 与常驻 PCM 资源的交接协议**。`WaitingMouth.start()` 当前只安装一次长命 PassThrough，不能拿它来重载资源。改为同一 mouth 的显式 `suspendForClip()` / `resumePcm()`：clip 只在当前正文 stream 已 end、队列空且 audibleTail（估算）排空后进入；设置 output phase=clip，暂停 PCM/音床 tick，递增 resourceEpoch，解绑旧 drain/Playing/Idle/error 回调，stop player 并销毁旧 PassThrough。随后安装 clip resource。结束/失败/取消后，在 lease/generation 仍有效时创建**全新** PassThrough/resource，重绑带 resourceEpoch 的回调、reset writeBlocked、player.play 新 raw resource，重新启动单一二十毫秒 timer，并在资源确认为当前且播放器就绪后恢复队列。不能重用 end/destroy 过的 stream；不能以 timer 已存在直接返回，也不能多开 timer。没有有效 lease 或进入 closing 则不 re-arm。
  clip 期间新 PCM start/write 等待同一 bounded queue 的背压（不报告 submitted、不往被卸下的流写、不丢弃）；clip Idle 后 re-arm 才提交等待帧。队列满会持续阻塞写者，调用者取消/超时则显式 reject。cue 本来有正文在飞就 skip，不切断正文；encoded speech 遵循串行顺序。资源重载失败将当前及等待输出全部 failed、上报健康不可用；不让 write offset 推进冒充播放提交。localPlaybackCancel 通过 speechId/generation/resourceEpoch fencing，旧 clip 的 late Idle 不能重装覆盖继任流。保持上行 AudioClock/Uplink 静音帧连续，只有下行音床在 clip 播放窗口暂停。
  必测序列是 **PCM 正文一→earcon→PCM 正文二→filler→PCM 正文三**，不仅看 promise：实际 player 资源消费到各段不同 PCM 标记，始终同 player；另测 clip 中背压、clip error、取消/换代和 late Idle、重复 resume 无双 timer。它覆盖“clip 后永久静音但仍回 submitted”的原反例。
- `localPlaybackCancel(speechId,generation)`：清应用队列 + stop/reset 物理 player/PassThrough，拒绝未完成 promise，记本地 cancelled；该 generation/speechId 的后续帧全部拒绝。它不是引擎 turnCancelOrSuppress，本单不据此宣称支持用户打断。
- `audibleTail()`（估算）返回 `{estimated:true,remainingMs,drained,observedAt,sessionId,generation}`。remainingMs 纳入待播放 PCM 时长、已写未消费 buffer 和可配置输送余量；无可信计量则 remainingMs=null/drained=false。cancel 后也不能凭清数组立即认定远端无尾音。该估算只用于下一段播报调度，不作为人耳证据。
- `onPresence` 同时给 exact founderPresent 与 humanCount；耳机用 founderPresent，旧 Gemini 任意 human occupancy 行为由 adapter 保留。`onReceiveHealth` 沿用现有健康 schema，不把没人说话判故障。所有订阅返回 unsubscribe，并以 holder/generation 防旧 unsubscribe 清掉新会话。
- 空闲时维持原 AudioClock/Uplink 静音流语义；不要把“没有人声”改为“停止送帧”。已有 bot 身份断言、receive retry/cooldown、VAD 校验与错误上报必须保留。

### 3.2 一间房只一个持有者

`VoiceSessionState` 是会话唯一权威，`voice_sessions_active_room` 已有跨进程互斥。`SessionSlot` 是该租约的进程内投影，不创建第二套持久房间锁。

所有 `/gemini`、`/eleven`、codex A/B 与 `/glaw` 的开会路径，先预留同一个 voice_sessions room 行并获取 lease，再 acquire 本地 `(mode,sessionId,generation)` slot，之后才订阅帧/启用输出；legacy live 命令映射 mode=rg，glaw 映射 meeting，backend/mode 标签放会话 metadata，不扩大 state enum。RoomIO 依赖注入现有 lease 的 assert/renew/release，保留单调截止与永久 fencing。Bridge 不可达时不绕过开新会话；已开会话只活到当前 lease 截止。

**R1 修正：不得直接复用当前 reserveVoiceSession 的 provisioning 路径给旧命令。** 当前路径会发 root、建 thread，并让 wakeTick 唤醒 codex daemon，getDesired/claim 又没有承运者过滤；“只有一个 winner”不能证明 winner 正确。

新增 additive `carrier_kind`（`daemon` 默认 / `resident`）、`owner_boot_id`、`session_generation` 字段，旧行默认 daemon；不扩 VoiceSessionState enum。`voice-session-routes.ts` 增加 master-only resident reserve-and-claim 入口，验证服务端配置中的 project/Lead/bot/guild/channel 和调用者的 resident 注册绑定，拒绝客户端任意指定目标。使用同一个 active-room UNIQUE 约束，**一个事务直接建立 resident 行 state=claimed + provisioning_step=done + owner_boot_id + generation + leaseToken**，返回 lease；不曾可见 desired/provisioning，因此无跨进程 claim 窗口。绑定现有命令文字频道，root/thread/member 可空，不补发 Discord 产物。owner_boot_id 是路由绑定，不单独充当认证凭据；重试同 requestId 返回同 reservation，换 boot 不接管旧 lease。

消费扫面必须一起改（包括下面的 tick 顶部 admission 校验，不能只改 wake admission）：StateStore `getDesiredVoiceSession` / 普通 `claimVoiceSession`、`listRecoverableVoiceProvisioning`、`admitVoiceLaunchAttempt` 只接受 carrier_kind=daemon；`voice-session-provisioner.ts` 对 resident 明确拒绝，`voice-session-runtime.ts` wakeTick 在 admission 之前过滤 resident，active poll 只对需要 daemon outbound 的会话运行。生命周期 sweep/过期租约回收仍覆盖两类；收听健康与房间需求统计保留两类但 codex launchd demand 只计 daemon。card/root/thread 消费者对 resident 无产物明确跳过，不能因 null 当损坏而修复创建。resident renew/state/release 除 leaseToken 还要求 owner_boot_id/generation 一致；普通 daemon 即使知道 sessionId 也不能 claim resident。

**R2 修正：tick 顶部校验不能使用 daemon 的 resolve。** `voice-session-runtime.ts:52-81` 遍历所有活跃状态调用 validateSession，失败会 `failVoiceSessionAdmission`；将 `voice-session-services.ts:105/143` 的 resolve/validateSession 按 carrier_kind 显式分支。daemon 完全保留现有 voiceRoom、Lead bot 和 probeVoiceSelfFilter 语义；resident 必须走独立 `resolveResidentSession`，依据唯一 `project.huddle.guildId/voiceChannelId`、已注册 owner_boot_id 与当前 generation 校验，不能要求 voiceRoom 存在或 huddle 为空。resident 输出 bot 为该 huddle 配置的 orchestrator、输入为 ears；允许与 lead.botUserId 不同。reserve 路由从服务端 huddle 注册记录填 voiceBotUserId/ears identity，不能留空也不接受调用方自选身份。

resident **仍需自过滤证明**，但不是 daemon 的单 Lead bot 证明：在现有 BotRegistry 登录成功、Discord 返回真实 user.id 并与服务端配置所解析的 bot binding 对齐后，RoomIO 针对该会话的实际 receive filter 产生 boot/generation/room 绑定的自检回执，断言 outputBotDropped、earsBotDropped、unknownDropped、allowedHumanPassed；Bridge 校验来自该受信 resident 注册通道、完整 bot/room/boot/generation 匹配且未过期。借用 EarsReceiver 的 isHuman/allowUserIds 过滤函数跑此测试，不用文本 self-filter 证明冒充音频过滤。创建/续租和 tick validateSession 都检查同一 resident 绑定及证明；过期/漂移按 failVoiceSessionAdmission 正确终止，不能为免误杀把所有 resident 验证跳过。member lookup 未就绪时既有 fail-closed+prefetch 行为保留。server side 注册/证明回执验证和 carrier 分支同时纳入 `voice-session-services` 相关测试。

精确负测：启动 /gemini 或 /eleven 后，root/thread/addMember/send、requestWake、admit launch budget 均零次；普通 GET desired 不返回该行，直接 daemon claim resident ID 拒绝；仅原 resident 拿到 lease 并能收放。同房另一个命令仍被拒绝；resident 崩溃到期后允许重新发起新 session，不自动变成 daemon。增加跨多个 runtime tick 的正例：huddle 非空、voiceRoom 为空，resident 仍 live 并能双向收放；反例：bot 身份/room/boot 漂移和失败自过滤证明使该 resident 终结，同时 daemon 原有负测仍有效。把 `voice-session-{runtime,services,provisioner,routes}`、StateStore session methods 和 health demand projection 的 carrier predicates 列入 T2 消费者测试。

失败启动必须释放自己 generation 的 slot 并结束对应 session；stale close/renew/release 不得影响继任者。resident bot 可保持 Discord 连接，但没有有效 slot 时不把音频喂给任何模式，也不播报；连接存活不是活动会话。租约丢失立即停收转发、清输出、使所有未完成回执失败。

### 3.3 voice-bridge 适配路径（G1-c/d）

- `voice-bridge/src/cli.ts` 创建一个 canonical RoomIO，注入既有 earsClient/earsConnection 和 orchestrator output connection；codex 构造路径可以自行创建一个 bot connection，底层依然同实现。通过 `owned`/`borrowed` 连接所有权决定 close 是否 leave，不让 session close 杀掉常驻 note-taker。
- `VoiceRoomRuntime`、`wireRoomEars` 改为 RoomIO 的薄路由；`AssistantSpeaker.beginTurn/feed/endTurn` 和 Eleven 对应播放接通用格式帧。移除这些激活路径里的第二个 player/receiver 构造；保留类/API、caption、brain、landing、TIV、等待提示和命令功能。
- `assistant/wiring.ts` 的私有 fallback 也必须调用同 createRoomIO，不能藏一套旧实现。`eleven/wiring.ts` 同样处理；`cli.ts` 的 glaw 订阅走同 slot，避免重复 receiver。不改会议编排策略。
- bridge 原 16k 输入按真实 resample 转给现有消费者；codex/A/B 用协商格式。旧 Eleven 的 backchannel/holdoff、Gemini 的 bargeIn 设置保留在兼容 adapter，既有取消效果也保留；新 V2 不开启打断策略。
- 给会话收据写 RoomIO 自身生成的 `{moduleExport,roomIOVersion:1,implementationDigest,buildSha,instanceId,sessionId,roomKey,generation,inputRouteInstanceId,outputRouteInstanceId}`。digest 对部署模块及上述支持闭包取稳定有序内容 hash。V6 比较四场 module/version/digest 相同、各场输入输出 instanceId 相同且有真实帧事件；不比较四场 instanceId 相同。不接受配置自报版本而无导出和真实路由证据。

## 4. Bridge durable inbox（先做再接模式）

### 4.1 来源闭包与初次历史

Bridge `headphone-inbox.ts` 常驻运行，与 mode off / voice 进程退出无关。每个 canonical founder，服务端按 ProjectConfig/Lead chat/general/issue-thread binding 建立 `(project,founder,channel)` scope；先保留项目归属，再聚合该 founder 被授权的多个项目。不得直接拿旧 `/voice/scope` 的扁平结果做授权。只纳入配置 Lead/system 身份在 founder-facing 范围的消息，排除 founder 自己、明确 voice relay 自回声、无关频道；不按内容偏好、长度或是否需决定过滤。

来源覆盖：Codex outbound、Claude/direct Discord、GatePoller 问题卡/回退、report-deliver 都从原始 Discord 内容/embeds/components 的可读文字归一收取。没有文字的附件保留 URL 与来源，播报有附件提示；不假装读过附件。CommDB 只补**明确已路由 founder 且未解决的**问题及持久 binding；普通 Runner→Lead pending question 不纳入。补投影与 Discord 发卡通过 questionId/message binding 合并一个 item；解决状态由原问题权威更新，不由播报 ack 推断。

首次接入及新增 scope：完整分页恢复可访问历史，不设“最新一条”基线、不设隐藏天数截断。保存 bootstrap lower/upper bound 和继续位置，分 tick 跑到各频道固定 high watermark；期间持续插入已读页，不丢新来消息。历史已解决的问题记 source-resolved 不再问，旧报告没有可靠“已听”证据则保留 pending；数量大是公开代价，不暗中筛选。源已删除/403/权限缺失记 `source_gap`，进入时说明“某些来源暂未读全”，不能说“没有新消息”。未发送到 Discord 的普通报告不在可读取的持久来源中，不编造存在；当前未发卡的 founder 问题由上述投影补齐。

**速率纪律（工程默认，不是产品承诺）**：collector 全局并发一，每 token 至多每五秒一页，每 tick 至多一页/一百条；跨 scope 轮转，bootstrap 与增量共享预算，增量优先。Bridge 的 founder 通知/问题卡有待发请求时，通过注入的 token 背景准入回调暂停 collector，不让历史回填排到通知前面；在 `discord-utils.ts` 的既有请求边界只增加在飞通知/限流窗口观测，不重建一套发送队列。遇 429 按服务器 retry_after（秒）或 Retry-After、global 标志设置持久 token/bucket nextAllowedAt，尊重更长值并加少量 jitter；格式缺失用三十秒退避，连续限流指数增长到五分钟，成功后复位。重启仍守 nextAllowedAt，cursor 不前进、不忙重试。状态是 `rate_limited/recovering`，**不是 source_gap**；只有历史不可访问/删除等才是 gap。测试共享 token 通知优先、429 global 与桶、重启冷却、失败页不前进及多频道公平性。

### 4.2 最小表和事务

均加到 StateStore additive migration，参数化 SQL；不改既有 session outbound 的终结含义。

| 表 | key 与字段 | 权威 |
|---|---|---|
| `headphone_inbox_items` | itemId；project/founder；sourceKind、sourceId、channelId、authorId、questionId?；revision、contentDigest、text、speechBrief?、needsDecision；seq、createdAt、resolvedAt? | UNIQUE(project,founder,sourceKind,sourceId,revision)，消息正文不可变 |
| `headphone_inbox_sources` | project/founder/sourceId；scopeRevision、bootstrapPosition、highWatermark、cursor、status、lastError | 页入库和推进 cursor 同事务；失败两者都不生效 |
| `headphone_inbox_delivery` | (itemId,revision,sessionId) 主键；generation、claimToken、leaseExpiresAt、stateVersion；attempts、nextAt；pendingKey/requestDigest；SpeakReceipt | 每真实 session 两次预算；恢复同 session 不重置 |
| item 的全局回执字段 | inbox_items 的 spokenAt、spokenReceipt；对该 item/revision 全局唯一的 activeClaimSession/token | 跨 session 不重播已 spoken；不能同时认领不同 session 行绕开单 claim |

同 Discord id 内容变更形成新 revision；稳定 contentDigest 去掉采集时间等非内容字段。相同源+revision 不同 digest 为冲突并告警，不能覆盖。question 投影与发卡合并用持久 alias，不新造第二条；投影本身已有完整正文时不等待卡片发出。collector pages 根据 source cursor 重放幂等；超过单 tick 工作额度保存游标，继续后续 tick，不能跳到高水位。

模式入口 `snapshot` 返回 `{snapshotId,highWatermark,sourceStatus,nextCursor,items}`；页按 needsDecision desc、seq asc、itemId 排序，cursor 包含排序元组及 watermark，不能只用 seq 忽略排序。收完 ≤watermark 的全部 pending 才算开场清单读全；同时持久发现 >watermark 的新消息，新消息在段落边界进入队列。阅读页游标不是 ack。

claim 必须验证服务端 session/lease/generation/founder 范围；同 item 只有一个活跃 claim。播报使用 `pendingKey=inbox:<itemId>:<revision>:<sessionId>:<generation>:<attempt>`；attempt 在 speak 前 CAS 持久递增，最多两次/session，六十秒退避。同 session 的换 generation 不重置 attempts；不同 session 新建预算行但先查 item 的全局 spoken/activeClaim。保持 Raya 每 session 两次原语义，**本单不另设终身自动丢弃上限**：永久坏项可在下次会话再尝试，代价明确列入使用观察；每场到上限即停止并提示文字，不悄悄耗尽后永远漏报。请求 digest 按 V1 完整正文/kind/verification/voice/format 计算，ack 重算期望值再比较。

ack 条件：outcome=completed，contentProof 正向枚举 deterministic_tts 或 transcript_equivalent，pendingKey/requestDigest 全等，item revision 与活 lease/claim 相符；原文分段必须所有段满足。无 proof、缺字段、timeout、旧 lease、文本变更一律不 ack。ack 本身失败则先重试同一 receipt 写入，不再播；崩溃后重查 receipt。无法证明上次已经提交时允许重播并记录 ambiguous playback：**物理声音不承诺 exactly-once**；已持久 spoken 不重播。

进入模式先立即 `speak` 一个事实开场（正在整理/有来源未完成/当前清单为空都分别真实表述），再播全部清单。不能等待大历史恢复完才第一次开口。重进同 session generation 不重复已成功开场；新 session 可以开场，但不重置已 spoken item。

### 4.3 API 边界

在 `/api/voice/headphone` 下增加 inbox snapshot/page、claim、ack、source-health；所有 mode 请求沿用 voice-session-routes 的 master daemon auth + session lease 校验。仅 collector 内部写来源项，客户端不能伪造 author、needsDecision、scope 或来源正文。请求长度/分页大小/整数/枚举有上限，body 未知字段拒绝；非法范围 403，lease/revision 冲突 409，输入坏 400，依赖不可用 503。只读页面也按服务端 founder 授权，不信 URL 中传来的 founder ID。

## 5. 模式、文案与完整 V1 接口

Raya `InboxReader` 和 `SpeechBrief` 实际文件找回到 §2 路径，保留 provenance 注释与对应原测试。改成注入 `list/claim/ack/speak/record/clock`，去掉 Raya import、filter、ship 和“非决策只发文字”分支。沿用单 poll promise、防重复、排序、重试；不复制完整旧 turn-machine（含第二批交互），旧桌面 dry-run 留原入口，不与新 RoomIO 会话同时放音。

**SpeechBrief 生产者与可达路径**：生产者是发布原问题/汇报的 Lead，不让 collector 猜“为什么”。使用不进入常驻 bundle 的 `packages/teamlead/lead-rules-base/runbooks/voice-speech-brief.md` 按需规则：需要语音友好稿时，Lead 在原消息写明三个自然段“现状：… / 原因：… / 下一步：…”，或同名 Discord embed fields；原稿真实、不编造、保留原文和链接。collector 在已认证来源消息内解析这三个完整标签到 what/why/next；多组/缺段/歧义不提取，走原文。此为可选语音文案，不要求所有历史报告改写，也不把三段文字当机器授权。不修改常驻 Lead 规则或抬规则预算基线（R2 核实余量仅约五个字符）。在耳机会话已授权的 Lead briefing/交办动态上下文中，通过既有 mailbox/context 注入携带该 runbook 同版本路径与“发语音友好报告时按需读取”的提示；Claude/Codex 使用同一动态载荷，来源接入时保存一次性 notice identity 避免每轮重复提示。它不授予新业务权限，也不是新常驻 rule 文件。未读取/无三段稿仍全文兜底；测试按需入口→Lead 消息样本→collector 贯通并验证常驻 bundle 字节不变。新增测试必须从实际三段 Discord message/embed 经 collector 入库，再经恢复后的 SpeechBrief 验证/render 到 speak/ack，而非直接给函数塞 fixture；另测普通历史消息走原文。这样复用校验路径在生产可达，且没有三段稿的内容仍全部播。

SpeechBrief 三字段各 ≤200 code points、非空、无 Unicode 数字、末尾句号等规则逐项保留。没有合格三段稿时记录 reject 原因，改读来源原文，按句子/最大 backend 文本长度拆段；不截掉尾部，不把内部数字删掉后伪装“校验通过”。原文分段共享 item claim，分别 requestDigest；所有段完成后才写 item ack。来源内容是数据，不当系统指令；不能从三段摘要生成动作授权。

HeadphoneMode 管一个串行播报任务：entry → pending items → idle；新消息唤醒，无消息时到存活期限发 `speak("我还在，有新消息会告诉你。","heartbeat",verification:none)`。新消息、user 人声、引擎正在出声和 RoomIO 尾音估算非空时暂缓；pending heartbeat 只留一个、不累计补播。lastActivity 在人声/实际音频输出活动更新，不以失败请求或空 polling 更新。来源断线时改说“我还在，但消息更新暂时连不上”；收音故障明确说“我暂时听不到你”；引擎输出不可用则记录语音不可用并发文字状态，不能记“已报平安”。退出/lease 丢失清 timer 与订阅。

V1 扩既有 `ConversationSession` 的共享对外面（不把 backend factory 当 session）：speak(text,kind,opts)、onUtterance、open/close、initialSessionContext、injectContext；handoffToLead 属于模式注入的载体，不是引擎工具执行器。类型以 FLY-2795 research §4.1 的 SpeakReceipt discriminated union 为准，所有字段必填，required 无 proof 必须 failed；pendingKey 同 key 不同 digest rejected。旧 ConversationSession 保留兼容，新增 V1 约束接口由新模式显式要求；A/B 实现与 capability 声明由 V4/V5 接入，V2 输出同一公共合同避免各自发明字段。不能把不支持 onUtterance 的 announcer 强制 cast 成合规引擎。

完整 FakeV1Session 实现音频事件、speak 三态+proof、onUtterance 订阅、open/close、静默 injectContext 和初始上下文；记录调用、可注入失败/延迟。capabilities 未满足音频格式交集则模式不可用；每次 required proof 未取得则该 item 保留 pending，不谎称可播。

## 6. 转写持久回执与安全退出

扩已有 TranscriptEntry：稳定 transcriptId、utteranceId、sessionId、generation、sequence、timestamp、role、text、final、attribution union、backendId、source。旧 sink append 兼容；新增 `appendDurable(entry):Promise<TranscriptDurabilityReceipt>` 和受控 `readReceipt(sessionId,transcriptId,contentDigest)`。副作用候选只接受最终 user 条目；partial 可留普通日志但不能取得授权证明。

沿用 JSONL 有序 async tail，appendDurable 等写入、文件 sync、flush 后按三键回读；首次创建目录/文件同步必要 metadata，写失败/截断行/读回不一致 reject 并保留既有 writeFailures 供 landing 检查。相同 ID+digest 幂等复用 receipt；同 ID 不同 digest rejected；重启从有效 JSONL 记录重建查询索引，尾部破损不能装成全记录完整。只在 final transcript 处理持久化，不在每二十毫秒音频路径 fsync。

Bridge 接受 handoff 前必须自己验证可访问的受管会话 transcript 文件和 receipt，不接受任意文件路径、软链接越界或客户端自报 hash。文件路径由 session.evidence_dir 受管根导出；同 key 回读内容后独立算 digest，要求 role=user、final=true、known 且 canonical founder 相符。MemoryTranscriptSink 的回执标 durable=false，生产拒绝；端到端持久测试用真实临时目录。

`composeStartInstructions` 复用 Raya 条款，组合身份/memory/模式/退出条款，幂等；8192 按 JS string.length（UTF-16 code units）明确，超限报错，不静默截断身份。engine 自有 token 限制另由 adapter 校验。

口头退出：当前 session generation 的 founder final user 转写持久成功，模式识别明确退出意图，之后才接受其对应 assistant exit 句；旧 generation、assistant 自说、非 founder、unknown、只有 partial、写失败都不能触发。沿用明确 stop phrase，模糊语义要澄清，否定句不命中。首次退出操作即标 ending、停止新增播报/清 timer，完成现有 session 关闭与自己 lease 释放。房间 presence 退出按已存在会话生命周期处理，不另存一种 ready 状态。

## 7. 通用 handoff：只到 Lead 信箱

### 请求与授权

`{handoffId,idempotencyKey,requestDigest,intentKind:"query"|"judgment"|"action",payload:{targetLeadId,text,quotes},sessionId,generation,transcriptId,utteranceId,originalText,authorityBinding,transcriptDurabilityReceipt,delegationBinding?}`。

按 Lead 追加指令，carrier 分类 query（请 Lead 查事实）、judgment（请 Lead 判断）、action（请 Lead 办事）；三者都是 relay 语义，不能携带可执行 ship consent 或审批凭据。authorityBinding 绑定 project、canonical founder、target Lead、source session/generation/transcript digest 和当前 room lease；目标 Lead 必须服务端可路由且在批准范围。引用/标识必须在持久 founder 原话中可验证，采用 OutboxWatcher grounding 规则；不要求整段改写后的摘要逐字存在。未知说话人的整句照常留 transcript，但不能发 handoff。

模式仅从明确要交给 Lead 处理的 final utterance 构造候选；V2 默认只发 action，query/judgment 接口供 V4 经已授权路由使用，闲聊/一般问答不逐句投递；重复触发复用同 transcript/target/intent 的键。模型输出只当候选，不给模型创建动作权限。A delegation.id 可附关联，但不能当业务幂等键；B 不能同时开第二条 background_agent 投递。前台自主回答策略仍属 V4/V5 和 founder 裁定。

### 持久状态与承运

新增 `voice_handoffs`：§7 请求全字段、state、attemptToken、claimToken、leaseExpiresAt、stateVersion、providerOperationId、lastReconcileAt、nextReconcileAt、terminalReason。即时/后续回执沿用 V1 HandoffReceipt / HandoffExecutionReceipt 同一 state enum。

1. 验证可信 transcript 回读及当前 binding，落 authorized。相同 key+digest 返回原记录；同 key 不同 digest=409。未证明 durable 不进入 authorized。
2. 确定目标 project 的 CommDB carrier，预分配 messageId=`voice-handoff:<handoffId>`，由 **扩展后的 chatDeliveryId** 算 deliveryId；将二者与完整 envelope digest 持久写入，CAS authorized→dispatching，然后才调用已存在 ingestDiscordChat/通用 comm service。
3. 扩 canonical envelope 的可选 typed voiceHandoff metadata，校验/编码/渲染/读取整链一起更新，旧 envelope 仍有效；Lead 收到清楚的原话、来源、目标与“待 Lead 判断执行”。不伪造真实 Discord snowflake。明确修改 `chat-delivery-envelope.ts` 的 `chatDeliveryId` 与 `normalizeChatDeliveryEnvelope`：保留通用 snowflake() 不变，给 message identity 增加只在 origin=voice、voiceSessionId 非空且已验证 typed voiceHandoff.handoffId 与 `voice-handoff:<uuid>` 完全一致时才可用的分支。chatDeliveryId 新增可选 identity context 参数，默认仍走原 snowflake；normalize 先验 origin/metadata，再以同一 context 重算 deliveryId；discord-chat-ingest.ts 同步传 context。所有非 voice、仅声称 voice 但缺绑定、格式错误、错 handoffId 都拒绝合成 ID；chatId/channelId/authorId/replyTo 继续强制原 snowflake。禁止无条件放宽 snowflake 正则，补这些负例和旧 Discord envelope 回归。
4. provider ACK 回来记 dispatched；按预分配 deliveryId 只读查询并核对 envelope source、lead、session、founder、typed metadata 和完整 digest 一致，才 committed。**committed=信箱记录已持久存在，非 Lead 消费、非业务完成**；消费状态另外据真实 mailbox 状态展示。
5. timeout/崩溃后的 dispatching → ambiguous；reconciler 以 CAS+claim lease 在 Bridge 重启后继续，按预分配键只读查询。找到一致提交→committed，确定拒绝→rejected，查不到/读取失败不当未提交。采用 1s/5s/30s/120s/600s 工程退避，仍无证明→持久 needs_human，不盲重投或换键。UI/播报说“送达结果还没确认”，不能说已交办。
6. 重复 worker/旧 attemptToken 无权更新。dispatch 前再校验 lease/target/binding；已进入 uncertain 的结果查询可以在源会话结束后继续，因为它不再创建新副作用。

providerOperationId=预分配 deterministic deliveryId，满足 V1 “查询键在 I/O 前可用”。复用 source envelope query，不能用现有 adapter 把所有读错误都 catch 成 null 的行为；明确 found/not_found/unavailable/conflict。ship 专用 endpoint 原封不动，新路由不调用它。

### 7.1 Lead 追加消费合同（2026-09-23T18:04Z）

指令 `019dae00-909f-48e9-a594-532b49ea2422` 的九项逐条落点；这些是 carrier 合同，不代表开启 V2 第二批产品能力：

| # | 合同与实现落点 |
|---|---|
| ① | RoomIO 显式提供 `startSpeech({speechId,generation,format})`、`writeSpeech(frame):Promise<FrameReceipt>`、`endSpeech(speechId,generation):Promise<SubmittedReceipt>`、`localPlaybackCancel`；§3 的 playSpeech 是完整 buffer 兼容包装，内部只调这四件，只有一个 player。await write 的背压贯穿上游；generation 在 start、write、end 各自检查。 |
| ② | `onBargeIn` 输出持续发言事件 `{sessionId,generation,utteranceId,owner:known|unknown,startedAt,observedAt,durationMs,phase:start|sustained|end}`，由实际输入能量/backchannel gate 产生，持续期间按房间时钟推进；不能只有 speaking-start。复用 EarsReceiver 的 backchannel/holdoff 规则迁入统一 room，不靠引擎猜说话人。V2 只观测/暂缓新播报，不调用打断；V4/V3 自己组合 turnCancelOrSuppress。 |
| ③ | 每个 capture/output frame 带 sessionId/generation；写入和最终送入物理 sink 前重新 assert 当前 lease。异步背压解开后也重验；旧 generation 帧与 end/cancel 不能触及新输出。 |
| ④ | query/judgment/action 枚举在 core handoff、Bridge validator、comm metadata 和结果事件同源定义。查询/判断也不是模型自己宣称的动作授权，不能用分类绕过来源/目标校验。 |
| ⑤ | `VoiceDelivery.capture` 当前 `:74` 把 safeText 截至 1800，不能作为新 carrier 的 canonical。§6 sink 保存完整 originalText（完整原话 digest）；displayText 单独 scrub/拆为 Discord 可容纳的片段。新 handoff 直接引用完整 sink+typed envelope，绕开旧截短 canonical；同时修改 delivery/journal 的新 capture 字段以保存完整原话，mirror 仅显示分段。旧短 journal 标 legacy/truncated 无法恢复，不给它补造完整 proof。超过单请求上限返回明确错误并保留本地原记录，不能静默截短。>1800 字尾部包含关键对象的测试必过。 |
| ⑥ | §7 的预分配 chatDeliveryId 是发送之前可查询的键；不是等 ACK 才拿 deliveryId。 |
| ⑦ | Bridge 持久 `voice_handoff_results` 事件流，`(handoffId,resultEventId)` 唯一，字段 `{seq,handoffId,requestDigest,sourceLeadId,sourceDeliveryId,resultKind,text,createdAt}`；只有已绑定目标 Lead 的认证回写或可核对持久 outbound 关联能 append，不信用户传 leadId。GET `/api/voice/handoffs/:id/results?after=<seq>` 返回稳定分页与 nextCursor，重连按原 cursor 重放；也提供订阅通知，通知只是唤醒，漏通知可查询追回。写结果沿现有 Lead outbound/回复能力增加 handoffId 关联，跨项目/错 digest 拒绝。没有完成证据的自然语言回复标 `lead_reply`，不标业务已执行。未授权结果不能发给引擎出声。 |
| ⑧ | dispatching CAS 与实际 ingest 之前均重新核对 session generation/lease/binding；过期不派发。提交后结果对账只读可继续，回放到新语音场必须重新建立同 founder 的合法关联，不借旧 generation 直放。 |
| ⑨ | 会话 leaseToken、CommDB mailbox claim token、既有 voice_outbound attemptToken 仍由各自现有权威产生。handoff 状态的 CAS claim 仅协调 reconciliation，不替代/伪造这些 token；结果进入既有 voice_outbound 播放时沿用 `claimVoiceOutbound`→attemptToken→receipt，不可凭 result seq 直接 ack。新 inbox claim 只管自己的 item，不能改旧 queue 的 claim。 |

Lead mailbox 门铃已存在，复用；2798 负责事件驱动的回复接入和门铃可观测性，本单只交 durable 结果流及可重放接口，不造另一套 carrier。此前十二点七秒邮箱空等的根因未证实，此设计不宣称已修。

结果读取认证固定落在 `plugin.ts` 单独挂载的 voiceSessionAuthMiddleware/master-only handoff router 下，不借通用 `/api/voice` 的 Gemini token 权限。GET results 和订阅都校验 master token、服务端 handoff.project/founder 与请求会话同一授权范围及活 lease/generation；跨 project、错 founder、scoped Gemini token 一律拒绝。会话结束后的 reconciler 用 Bridge 内部只读 service 查询，不通过放宽外部路由权限实现。新会话补读历史结果必须先证明同 founder/project 的合法关联。读/写分别测试，不把写入鉴权当读权限证明。

新增验证：持续发言的 owner/时间线与 unknown 分支；等背压期间换代；>1800 字 canonical 无丢尾；三种 intent roundtrip；结果重复/乱序/断线重放/伪造 Lead/错 digest；旧 claim/attempt token 不能被新字段绕过。

### 7.1a FLY-2798 消费分工与结果游标定稿

依据 Lead 指令 `cf7aeb81-f149-4ff2-80ce-044ca80dd9ae`（2026-09-23T18:27Z），核对其批准 plan@757434f30 后，本表覆盖该稿 §3 中尚未对齐的共享文件改动归属。此处与 R2 findings 一起进入 R3，不单独开审查。

| 文件或接口 | 唯一改动 owner / 消费界限 |
|---|---|
| core `room-io.ts`、共享 V1 receipt/utterance/transcript 类型与导出 | 2796 固定单一公共合同；2798 使用导出，不另定义相同字段。A 专有类型放 adapter 文件内。 |
| codex `realtime.ts` 的 RealtimeAudioOwner 迁出、`discord-room.ts`/`audio.ts` 迁移与兼容 shim，bridge room 支持闭包及旧命令 adapters | 2796；2798 不改房间捕获/输出实现。旧 realtime 引擎其余逻辑维持。 |
| codex `cli.ts`/`session.ts` 的 RoomIO/V1 factory 注入接缝，`delivery.ts`/`journal.ts` 的完整原话，`adapters.ts` 的 carrier 接线 | 2796；2798 不再直接改这些共享本体文件，以导出的注入点提供 A adapter。 |
| codex `daemon.ts`/`bridge-client.ts` 的通用 lease、claim/attempt receipt、本单 carrier/result 查询 | 2796；2798 的事件驱动回复接入写在新 `live-reply-events.ts`，由本单留出的 `subscribeReplies` 注入点装配，不另写收件/状态机。 |
| core `backends/openai-live/*`、A 专有 config/factory/registry 注册；codex 新 `live-lead-adapter.ts` | 2798；只实现 A 的协议、能力与上述注入接口，依赖 2796 定稿版本。 |
| Bridge handoff request/result 持久化、授权 producer adapter、查询/claim 权威 | 2796；2798 的 session events/SSE 只订阅、投影既有结果并触发既有 claim，不创建第二存储或 carrier。 |
| comm 子进程 URL resolver、现有 mailbox 门铃触发与可观测性 | 2798；本单只消费已有 ingest/查询能力，不认领邮箱等待延迟修复。 |

实现者以 2796 最终 approved commit 的 module exports、V1 conformance fixtures 和注入接口作为 dependency-lock；任何接口缺口先报 Lead，不到对方 owner 文件中补第二实现。通用启动可按 registry 选择工厂，2798 只注册 A，不必再修改 cli/session。

**结果事件形状**：`{resultEventId,seq,handoffId,requestDigest,sourceLeadId,sourceDeliveryId,resultKind,text,createdAt}`。resultEventId 是上游授权 result producer 在提交前持久确定的稳定事件 ID，随同一正文重试复用；Bridge 校验 `(handoffId,resultEventId)` 唯一，相同 ID 不同 payload digest 为 409 conflict，不能覆盖。可由已稳定的 sourceDeliveryId 加修订号确定性派生；禁止每次 retry 随机生成。

**seq 是每 handoff 的严格递增序号**，不是 voice session 序号，也不是全 carrier 全局序号。Bridge 在写事件同一事务中为该 handoff 分配下一个 seq；同事件重复提交返回原 seq、不占新位置。源 session 结束、换代或换引擎不重置 seq。

**replay cursor 为 `(handoffId,lastAppliedSeq)`**。现有 GET `/api/voice/handoffs/:id/results?after=<seq>` 的路径固定 handoffId；response 带该 handoff 的 highWatermark/nextCursor，升序分页。客户端先注册通知再补读 watermark 内 backlog，按 eventId/seq 去重；多个 handoff 保存各自 cursor map，绝不能拿 A handoff 的 after 值查 B。只有事件及后续 voice_outbound 关联已持久提交才推进 lastAppliedSeq，声音成功仍以既有 claim/attempt receipt 为权威。2798 若另建 session SSE 聚合流，session 的推送 event id 只作通知句柄，重连仍回到这组 handoff cursor 恢复，不能冒充本 carrier seq。测试同一 handoff 跨 session 连续 seq、不同 handoff 都有 seq=1、断线重放/重叠通知/冲突 eventId，确认不漏不串。

## 8. 实施顺序与相关测试

每步先补失败测试→确认失败→最小实现→相关测试通过→提交；不在本机跑全量。

| 次序 | 文件/交付 | 必须测试的真实失败 |
|---|---|---|
| T1 | core room-io/types/index；bridge room 提取支持闭包、manifest/model；codex 转导出 | import 无循环；唯一实现；所有旧 room/audio/lease 测试；模型路径与 hash；格式拒绝、流式 final、背压、晚帧、physical cancel |
| T2 | StateStore carrier columns + resident atomic claim、voice-session runtime/provisioner/routes/demand 消费者过滤；bridge SessionSlot/VoiceRoomRuntime/roomEars/cli/assistant/eleven wiring；teamlead voice-session-routes | 两 daemon 同房仅一正确 owner，resident 不触发 root/thread/wake/budget；旧 close 不释放新 holder；启动失败清理；borrowed connection 不被杀；legacy bot/健康/帧身份保留 |
| T3 | StateStore + headphone-inbox/headphone-routes + plugin 注册/关闭 collector | OFF 和无 voice 进程仍收消息；>100 多页；首启/新增 scope；未发卡 founder 问题；投影/卡片去重；事务崩溃；source gap；跨项目拒绝；编辑 revision |
| T4 | core transcript/types + consumer/fake 适配 | await fsync/read-back；失败拒绝；三键同一性；重复句不同 ID；冲突 ID；损坏尾部；landing 原失败保护不退化 |
| T5 | core headphone 四文件；headphone room-io/client + codex session/cli 组合 | 三条产品测试如下；全部汇报朗读；坏 brief 原文兜底；多段全 ack；两次/六十秒；晚 ack 拒绝；退出守卫 |
| T6 | StateStore handoff + voice-handoff-routes + plugin reconciler + comm metadata | known founder durable→唯一信箱项；unknown/partial/读错零 dispatch；调用前崩溃/提交后丢 ACK/多 worker/重启；查询错误不重投；不能触发 ship |
| T7 | integration + session evidence + QA 记录 | `/gemini`、`/eleven` 各真房一场；V6 四场 identity 验证器接受同源、拒绝版本/digest/路由不匹配 |

三条最小产品用例必须直接驱动同一 HeadphoneMode + 完整 FakeV1Session：

- **进入即播报**：Bridge 已存一问题、两汇报（含 mode off）；founder presence + live 后未输入任何 user utterance 就见 speak；全部内容覆盖、问题优先、无第二批动作；空队列也主动说明现状。
- **新消息插播**：开场完成后插入一新 item，正在播另一段时先排队，段落结束即 speak，新消息不依赖 user 提问；重复采集只播一次已 ack item。
- **存活信号**：注入时钟推至默认间隔前一刻无 heartbeat，到期一次；正在说话时延迟、不重叠、不积攒，退出后永不触发。

新增测试路径：`voice-core/src/__tests__/headphone-mode.test.ts`、`transcript-durable.test.ts`；`voice-bridge/src/__tests__/room-io.test.ts`；`teamlead/src/bridge/__tests__/{headphone-inbox,headphone-routes,voice-handoff-routes}.test.ts`；comm existing envelope/ingest suites 加新形状。

本机执行（根据新增文件精确选择，不跑整个 monorepo）：

```sh
pnpm --filter flywheel-voice-core test -- src/__tests__/headphone-mode.test.ts src/__tests__/transcript-durable.test.ts
pnpm --filter flywheel-voice-codex test -- src/__tests__/discord-room.test.ts src/__tests__/audio.test.ts src/__tests__/lease.test.ts
pnpm --filter flywheel-voice-bridge test -- src/__tests__/room-io.test.ts src/__tests__/voice-room-runtime.test.ts src/__tests__/assistant-wiring.test.ts src/__tests__/eleven-wiring.test.ts
pnpm --filter flywheel-teamlead test -- src/bridge/__tests__/headphone-inbox.test.ts src/bridge/__tests__/headphone-routes.test.ts src/bridge/__tests__/voice-handoff-routes.test.ts
```

还需相关 comm envelope/ingest、voice-session-routes、Gemini/Eleven landing 原回归按实际文件逐个执行；改动包 typecheck/build。全量由 PR CI 承担，不把计划中的测试写成已通过。

### QA 硬门与证据清单

G1-b: ROOM_IO_VERSION=1 导出、格式输入输出、取消、presence、健康、audibleTail（估算）、租约/slot 全部有正反例。
G1-c: codex 与 bridge 激活路径都到同模块；保留 voice-bridge 命令；无 bridge→codex 依赖、无第三套 receiver/player。
G1-d: `/gemini` 与 `/eleven` 各启动真实会话，分别记录 founder 输入帧→该引擎接收→输出音频→RoomIO 提交，以及现场能收能放的 QA 观察；附 sessionId/build/配置（去密）/实例 identity。静态测试不替代真房观察。权限/引擎不可用时写 NOT VERIFIED，不伪造通过。
G1-e: 两旧命令及 A/B 接缝均生成同规格 RoomIO 会话收据；V6 后续对四场进行机械核验，本单不声称 A/B 真机通过。

## 9. 迁移、回滚与风险

先 additive schema 和共享接口，再迁 adapter 与模式。已活跃 session 不热切 RoomIO：自然结束后新场走新版；独立 updater 在获准窗口部署，设计/merge 均不等于部署。旧事件/转写无新 receipt 不补造授权，仍可用于历史展示。

旧 headphone 本地 queue/cursor 不能直接变成权威 spoken：以来源 messageId 导入待处理项，与 collector 去重；没有来源证据的本地状态记迁移缺口。新模式禁用旧 daemon 对同一会话的播放和投递，但保留独立 dry-run 工具。不会删除 voice-bridge 产品功能或业务落地流程。

回滚应用二进制时保留新增 inbox/ack/handoff 表、未决查询与 JSONL 证据，禁止回退数据库或重置幂等键。先停止新会话准入、让既有 lease 自然结束，再切旧程序；若旧版本不理解 handoff 未决状态，则保留新 reconciler 直到收敛，不能把 ambiguous 当失败重发。部署/回滚由后续获准操作者执行。

主要风险：首次历史量大（渐进播报+公开恢复进度）；部分来源无权限（source_gap）；物理播放崩溃窗口可能重播（明确 at-least-once，不虚称听到）；跨包迁移影响旧命令（真实 QA 硬门）；A/B 尚不具备 required proof 或归属（逐能力 fail closed，V6 不可比时明确 blocked）。

## 10. 本设计阶段交付与非结论

探索、调研、计划、Mermaid 源/SVG、可逐节评论的浅色 founder HTML 一并提交推送。获得 effective reviewVerdict=APPROVED 后发布 HTML（publish-only），核对托管 HTTP/CSP/nonce/页面内容并 report Lead，再 `complete --route phase_design_complete` 和 park。此阶段不实现、不开真房、不部署、不申请 ship，不把后续 QA 判据当已获证据。

## Follow-ups（R3 非阻塞建议，交 Lead 决定）

- `resident-self-filter-proof-races-cold-member-cache`（MEDIUM）：成员缓存未解析不等于身份失败；后续细化初始化等待/有界重试、刷新周期与租约关系，避免误拒或误终止。该 finding 不改变本轮 effective APPROVED；不在设计收尾阶段重开方案。
- `cue-skip-condition-ambiguous-vs-tail-drain-gate`（LOW）：正文已 end、但 audibleTail（估算）仍未排空时，cue 等待还是跳过需明确；后续保留提示音实际触发观察。
