# FLY-545 Huddle 模式 — 调研
Issue: FLY-545 (https://linear.app/geoforge3d/issue/FLY-545/voice-huddle-模式完整-deliverable-voice-bridge-meet-端到端-结论落地原-544545548-合并)
日期: 2026-07-07
基于: exploration.md(brainstorm gate 已过:D1=B、D3=只读白名单、D4=语音确认≠授权、两 PR 切法+不许提前 Done)

> 目的:把 exploration 定下的架构落到「可写 plan」的技术事实层——每条给出处(spike 实测 /
> 源码 / SDK 文档),不确定的显式标为 plan Phase 0 spike。

## 1. Gate 拍板回执(设计输入,不再讨论)

1. **D1 = B**:Gemini Live 当耳+语义端点+turn 管理(TEXT 响应模态),edge-tts 按 speaker tag
   路由到各 Lead bot 播;A(Gemini 音频直出)= documented 降级位;**S1 spike 量真实首音,>2s 回报 Tadashi**。
2. **D3 = 只读白名单**:ask_lead 脑 = headless claude -p persona,工具 = Read/Grep/Glob + Linear
   只读;**白名单外一律没有,尤其无 Bash/无写**(硬边界)。
3. **D4**:语音只 readback + TIV 收据卡;执行走现有 founder gate;**语音确认 ≠ 授权**(与 FLY-945
   归因硬门、FLY-546 语音批准默认 OFF 三处口径统一)。
4. **两 PR**:PR-1 = A 块收发地基真机闭环;PR-2 = B+C;**issue 在 PR-2 落地 + Annie 真用一次
   /meet 全程前不许 Done**(founder 红线)。
5. 补充:耳朵 bot 从 pool claim 时**顺手清 pool-04/05 在测试 guild 的残留**(FLY-960 post-QA 欠账);
   Lead-facing 接口合同与 FLY-546 对齐:**speak / onFounderUtterance / bargeIn / presence**;
   per-Lead TTS 声线读 `leads[].voice` 配置(FLY-546 侧已批的配置键,本 issue 只读它、不定义新键)。

## 2. 收音管线(耳朵 bot → Gemini 16k mono PCM)

**全部 spike 实测背书**(engineering/spike/FLY-960-dave-stt/ears-a.mjs + spike-report):

- 依赖 pin:`discord.js` 14.26.4、`@discordjs/voice` 0.19.2(#11449 修复)、`@snazzah/davey`
  0.1.12、`prism-media` 1.3.5 + `opusscript`(解码走 `prism.opus.Decoder`,无需原生 @discordjs/opus)。
- Client intents = `Guilds + GuildVoiceStates`;**`joinVoiceChannel` 必须等 `clientReady`**
  (ears-a.mjs:38-41,否则静默卡 signalling);耳朵 `selfMute:true, selfDeaf:false`。
- per-speaker:`conn.receiver.subscribe(userId)`;**speaking-start 去重**(activeCaptures Set,
  ears-a.mjs:94-100);**只 subscribe 人类成员**(member.user.bot=false)= 结构性免回声。
- 解码:`prism.opus.Decoder({rate:48000, channels:2, frameSize:960})` → s16le 48k stereo。
- **与 spike 的差异(live 化)**:spike 用 `EndBehaviorType.AfterSilence(1500)` 落文件;Huddle 要
  连续流 → subscribe 用 `EndBehaviorType.Manual`(不自动断),解码后**降混+重采样到 16k mono**
  持续 `sendRealtimeInput`,端点判定完全交给 Gemini 服务端 VAD(语义端点,PRD §15 的要求恰好
  是 Gemini 原生能力;她不说话时无帧可发 = 自然静默)。重采样:48k stereo s16le → 16k mono
  s16le 是纯 PCM 数学(每 3 采样取 1 + 双声道求均),**进程内实现,不 spawn ffmpeg**(每 20ms
  一帧的持续流,子进程边界不划算;逻辑 ~20 行 + 单测)。
- 重连:受控 rejoin ~5.6s(`entersState(Ready, 15s)` 足够);MLS epoch 轮换不影响已连 receiver。

## 3. 播音管线(文本 → edge-tts → Lead bot 开口)

- **Discord 侧 spike 实测背书**(sender.mjs):`createAudioPlayer()` + `conn.subscribe(player)` +
  `player.play(createAudioResource(...))`;DAVE 下 send 官方稳定。**barge-in 停播 = `player.stop()`**
  ——本地调用,满足 <100ms(PRD §15)。
- TTS:voice-core `EdgeTts.synthesize()`(mp3 Buffer + ttsFirstByteMs;FLY-342 实测首包 ~0.66s)。
  mp3 → Discord:`createAudioResource(Readable.from(mp3buf))`(StreamType 推断走 prism ffmpeg
  转码 → opus)。**每个 Lead bot 一个常驻 AudioPlayer**,utterance 串行队列(AnnouncerSession
  的队列语义,但 player 换成 Discord)。
- **playbackStart 诚实口径**沿用 voice-core `SpeakResult.playbackStartMs`(FLY-543 定的合同):
  Discord 侧以 `AudioPlayerStatus.Playing` 转换为准。
- per-Lead 声线:`leads[].voice`(FLY-546 已批配置键)→ EdgeTts voice 参数;缺省
  `zh-CN-XiaoxiaoNeural`(voice-core DEFAULT_VOICE)。
- **earcon/filler 零延迟对策**:earcon(短提示音)与常用 filler(「嗯,让我看一下」等 3-5 句)
  **启动时预合成落盘**,播放时直接 `createAudioResource(file)`——首响与 TTS 合成解耦。

## 4. 对话引擎(Gemini Live TEXT 模态)——含 S1 spike 定义

**现状**(packages/voice-core/src/backends/gemini/genaiConnector.ts:49):`responseModalities`
钉死 `[Modality.AUDIO]`,输出文本只经 `outputTranscription` 旁路;`mapMessage` 只发
`inlineData` 音频块,**不发 `p.text` 文本块**。

**需要的 voice-core 扩展(小而有边界,合同默认值字节兼容)**:
1. `LiveConnectParams` + `ConversationOptions` 加 `responseModality?: "audio" | "text"`(缺省
   audio = 现有行为不动,talk CLI 零变化)。
2. TEXT 模态下 `mapMessage` 把 `sc.modelTurn.parts[].text` 映射为新事件 `response-text`
   (`ConversationEventMap` 增一项;audio 模态不发它)。
3. capability 面:`GeminiLiveBackend.capabilities` 不变(bargeIn 等语义同样成立——
   `serverContent.interrupted` 在 TEXT 模态同样下发)。

**SDK 事实核查**(@google/genai,Context7 2026-07-07):`LiveClientSetup.inputAudioTranscription`
存在(输入转写独立于响应模态);`sendRealtimeInput` 支持 audio blob(16kHz mimeType)与
activityStart/End/audioStreamEnd;Live API 响应模态 TEXT/AUDIO 二选一(connect 时定)。
**待真机确认的两点 = S1 spike(plan Phase 0,不改生产代码)**:
- ①TEXT 模态 + `inputAudioTranscription` 并用时,输入转写事件照常下发(TIV 字幕依赖它);
- ②量数字:她停话 → Gemini 首 token(目标 ≤700ms)/ 全链首音(端点→earcon ≤300ms、
  →真语音 ≤1.5s;**>2s 回报 Tadashi**,降级位 = D1-A)。
- 模型沿用 config 钉的 `gemini-3.1-flash-live-preview`(FLY-959 已换真实可用型号);
  `TalkSessionRotator` 直接复用(~10min 短命续接,FLY-959 上线)。

**speaker-tag 协议**:systemInstruction 要求每轮以 `[speaker:<leadId>]` 开头(参与 Lead 名单
+ persona 摘要注入;单 Lead 时恒等于主持)。bridge 解析 tag 剥掉后送 TTS;解析失败 fallback
主持 bot(错标代价 = 亮错头像,transcript 不受影响)。ask_lead 声明沿用现有(FLY-959 修过
schema),tool 结果走 `injectToolResult(WHEN_IDLE)`(异步调度 = §15 长答先 ack 的原生实现)。

## 5. /meet、按钮、MOVE_MEMBERS、voiceState(全部 discord.js 原生,生产首次引入)

审计确认生产零 slash command / interaction / gateway——以下全在 voice-bridge 进程内,不碰 Bridge:

| 能力 | API | 备注 |
|------|-----|------|
| 注册 /meet | `client.application.commands.create({...}, guildId)`(guild command,秒生效;名字从 config 读) | 编排 bot 的 application;选项 = 可变长 user mention |
| 接 /meet | `client.on("interactionCreate")` → `isChatInputCommand()` | gateway 事件,无需 HTTP interactions endpoint |
| 回执 + Join 按钮 | interaction reply + **link button(style=Link, url=VC 深链 discord.com/channels/&lt;guild&gt;/&lt;vc&gt;)** | link button 零回调零状态;桌面点即进/手机弹确认 = PRD「一次 tap」合同 |
| @通知 Annie | `allowed_mentions:{users:[ownerUserId]}`(founder-thread-notifier 同款口径) | ownerUserId = DISCORD_OWNER_USER_ID |
| 零-tap 挪人 | `guild.members.edit(userId, {channel})`(= PATCH /guilds/{g}/members/{u} channel_id) | 仅她已连语音时可用;编排 bot 需 MOVE_MEMBERS 权限(setup 脚本核) |
| 她进/出 VC | `client.on("voiceStateUpdate")` | 已有 GuildVoiceStates intent;驱动生命周期(live/concluding) |
| TIV 消息/状态行 | VC 频道 id 即 TIV 频道 id;状态行 = 单条消息原地 edit(🎙/🧠/💬/⏸) | 注意 Discord edit 限速,状态行合并节流(≥1s 间隔),沿用 discord-utils 的限速处理思路 |

## 6. C 块落地管道(审计结论,exploration §5 已表格化,此处只记 plan 要用的接口)

- 建 issue:`POST {BRIDGE_URL}/api/linear/create-issue`(Bearer FLYWHEEL_API_TOKEN;title/
  description/team/project/labels;返回 identifier+url)——现成。
- 写 summary:**Bridge 新增 `POST /api/linear/comment`**(照抄 create-issue 的 auth + LinearClient
  代理形态,`client.createComment({issueId, body})`;Linear key 保持只在 Bridge)。
- 关 issue:`PATCH /api/linear/update-issue`(status → Done)——现成。
- worktree:voice-bridge workspace 依赖 `edge-worker`,直调 `WorktreeManager.create({mainRepoPath,
  projectName, issueId})`(Blueprint 同款;sibling 布局 `~/Dev/<repo>-<issue>`)。
- transcript:voice-core `JsonlTranscriptSink`(该文件头注释明言「FLY-548 将消费」——本块即消费腿);
  summary 中 action items 逐条附原话引用(ts + 原句,from JSONL)。
- 「派活」动作(会中 a 档):投递 = create-issue 或往对应 Lead 的 issue thread 发 @Lead 消息
  (`POST /api/chat-threads/send` 已有);**绝不承诺实时**——审计坐实 Lead RPC 全链 poll
  (GatePoller 3s + mailbox idle 无上界 + gate 回查 15s),口径 =「已转给他,进展在 thread」。

## 7. 配置与部署面

- **配置落点 = `~/.flywheel/projects.json` ProjectEntry 新增可选 `huddle` 块**(理由:huddle 需要
  leads[](chatChannel/botTokenEnv/voice)同一文件就地引用;repo 的 .flywheel/config.yaml 是
  Runner/Blueprint 面,voice-bridge 不读它):
  `huddle: { guildId, voiceChannelId, commandName?("meet"), orchestratorBotTokenEnv, earsBotTokenEnv, moveMembers?(true) }`
  ——`ProjectConfig.ts` 加校验(现有 leads[] 校验同款风格);不设 = huddle 关(字节兼容)。
- 秘钥:全走 `~/.flywheel/.env`(GEMINI_API_KEY、各 bot token、FLYWHEEL_API_TOKEN),wrapper source
  ——Bridge daemon 同款(flywheel-bridge-wrapper.sh 模式)。
- 部署:`scripts/launchd/com.flywheel.voice-bridge.plist` + `scripts/flywheel-voice-bridge-wrapper.sh`
  + `scripts/run-voice-bridge.ts`(KeepAlive、bounded shutdown、按 FLY-193/239 纪律:精准 kill、
  改配置先于 kill)。
- bot 池:编排 bot + 耳朵 bot 从 FLY-882 pool claim(`scripts/discord-bot-pool.sh claim/rename/
  invite-url`);**顺手收尾 FLY-960 欠账**:pool-04/05 退测试 guild + 清昵称(gate 补充指令)。

## 8. 延迟预算(§15 对照,S1 实测校准)

| 段 | 预算 | 依据 |
|----|------|------|
| 端点检测(她停话→turn 判定) | 300-700ms | Gemini 服务端 VAD/语义端点(S1 量) |
| earcon(判定→提示音) | +≤300ms | 预合成落盘,createAudioResource(file) 即播 |
| Gemini TEXT 首 token | 300-700ms | S1 量;ask_lead 长答走 WHEN_IDLE,≤1s 口头 filler 兜 |
| edge-tts 首包 | ~660ms | FLY-342 实测 |
| mp3→opus 转码启动 + 网络 | 100-300ms | prism ffmpeg 管道 |
| **全链首音(真语音)** | **1.3-2.0s(worst)** | earcon 先行使体感 ≤1s;>2s 硬线回报 Tadashi |
| barge-in 停播 | <100ms | player.stop() 本地 |
| 状态行/字幕刷新 | ≤1s 节流 | Discord edit 限速 |

## 9. 风险更新(exploration §6 之外新增)

- **同 token 双 gateway 会话**(Lead daemon 与 voice-bridge 共用 Lead bot token):Discord 允许
  多 session,但**语音连接一 bot 一 guild 只一条**——voice-bridge 是唯一持语音连接方,Lead daemon
  纯 REST/插件不碰语音,无冲突;presence 显示可能互相覆盖(可接受,记 known)。
- **opusscript 编码 CPU**(播音是编码路径,spike 只验了解码):N≤3 路串行 utterance,单路编码
  实测预算留在 PR-1 真机验收;不行换 `@discordjs/opus` prebuild(Node 版本核)或 ffmpeg 直出 opus。
- **状态行 edit 限速**:单消息高频 edit 有 per-channel 桶;≥1s 合并节流 + 掉线降级(不刷不致命)。
