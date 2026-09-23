# FLY-2786 语音架构讨论页 — 探索
Issue: FLY-2786 (https://linear.app/geoforge3d/issue/FLY-2786/语音架构讨论页-founder-亲测语音延迟大漏听要一页可互动-html现在三种模式随身语音-rg-耳机模式-会议)
日期: 2026-09-22
基于: 无

> 本单只调研 + 出页面,**不改代码、不改语音配置、不开语音会话、不重启服务**。
> 所有延迟数字要么是生产留痕里算出来的实测(标 **实测**),要么是代码常量(标 **常量**),要么写「未测」。

## 0. 一句话

今天的 rg(随身语音)是「OpenAI Realtime 只当耳朵和嘴 + 每一句话都走 Raya(Codex Lead)完整一轮」。
2026-09-23 03:05Z founder 亲测那场的留痕算出来:**她说完到听到第一个字,两句分别约 38s 和 18s;另有一段约 5 秒的话被识别出来了但因说话人归属没对上被丢弃**。
9 月初那版是 Raya 仓里的独立进程,走 **Codex app-server 自带的 realtime v2**,实时模型 `create_response:true` 自己答、需要干活才调 `background_agent` 交给后台 Codex —— 这就是她说的「自带脑子」。

## 1. 三种模式今天分别是什么(代码事实)

| 模式 | 代码 | 今天在生产能不能用 | 谁出答案 |
|---|---|---|---|
| 随身语音 rg | `packages/voice-codex`(launchd `com.flywheel.voice`,进程在跑) | 能,只开给 Raya(`projects.json` 仅 raya `voiceModes.rg=true`) | Lead(Raya)一整轮 |
| 会议 meeting | 同一个 `voice-codex` 守护进程 + 同一套 Bridge 外层,`projection.mode==="meeting"`;挂哪个 Lead 由 `meeting.leadId` 定(`voice-session-start.ts:155-189`) | 代码允许所有 Lead(含 Claude Lead);**生产库 `voice_sessions` 从无一行 meeting** | 被挂的那个 Lead 一整轮 |
| 耳机模式 | `packages/voice-headphone`(FLY-546) | **没部署,也不是语音通道**:本机无 launchd、无进程、无 `~/.flywheel/headphone-state.json`;代码是「桌面试运行版」—— 念到 Mac 本机扬声器、不进语音房,语音房接入标为 M-B4 未落地(`voice-headphone/src/cli.ts:3-4`,`null-audio-io.ts:1-8`)。它依赖的 Bridge 接口是在的(`teamlead/src/bridge/voice-routes.ts:231,264,295,319`,`plugin.ts:11259` 始终挂载) | 没有 LLM:只念 Discord 文字消息(本机 Edge-TTS),你的回复只能打字口令触发后以文字 @ Lead 发出 |

- meeting 与 rg **复用同一个语音进程和 Bridge 外层**(收音、转写、镜像、邮箱、两层轮询、朗读);`mode` 在语音进程里只影响 evidence 路径、会议信号文件、健康 demandId(`voice-codex/src/cli.ts:70,283,297`,`daemon.ts:704`)。meeting 多出来的只在会前会后:按 `meeting.json` 起会(`teamlead/src/bridge/voice-session-start.ts:155-189`)、会后 120s tick 派 Runner 写纪要(`scripts/meeting-notes-scheduler.ts:437-439, 525-548`)。**但「收件 → Lead 想 → 回帖」这段随被挂的 Lead 而变**:Raya 走 Codex sidecar(有 rg 实测);Claude Lead 走 tmux 收件,未读实现、未测。所以会议端到端不能和 rg 比快慢。
- 耳机模式里 `founder_speaking_start` 在全仓没有生产者;`utterance` 唯一的生产者是打字口令 `芝麻关门`(`voice-headphone/src/daemon-core.ts:159`)。即没有语音输入。
- 更正记录:调研初稿曾写「Bridge 缺 4 个接口 ⇒ 起不来」,Codex 设计评审 R1 指出接口存在,已核实并改正(当时的 grep 只搜了完整字符串 `api/voice/scope`,而路由是 `app.use("/api/voice")` + `router.get("/scope")` 分段注册)。

## 2. rg 一句话的完整旅程(代码 + 实测)

| # | 跳 | 进程 | 串/并 | 依据 |
|---|---|---|---|---|
| 1 | Discord 语音收包 → Opus 解码 48k 立体声 | voice 守护进程 | 流 | `discord-room.ts:325-395`;`discordWiring.ts:377-383` |
| 2 | 本地 Silero 人声门(≥200ms、阈 0.5,延迟线 280ms,关门需 100ms 低分) | voice | 串(单推理在飞) | `discord-room.ts:135-137`;`pipeline/UplinkSpeechGate.ts:121-129,200,399-429` |
| 3 | 20ms 一帧上行 OpenAI Realtime(静音也发静音帧) | voice → OpenAI | 周期 | `discord-room.ts:196-215`;`pipeline/Uplink.ts:167-182`;`realtime.ts:287-336` |
| 4 | OpenAI server_vad 静 500ms 才提交 → `gpt-4o-mini-transcribe` 转写 | OpenAI | 串 | `realtime.ts:170-177`(`silence_duration_ms:500`,`create_response:false`);`:608-698` |
| 5 | 说话人归属:归不上的整句丢弃,只发「📻 有一句话没能确认说话人」 | voice | 串 | `realtime.ts:739-761`;`speaker-attribution.ts:20-50` |
| 6 | **先**把 `🗣️ Annie: …` 镜像发进 Discord thread(拿消息 id)| voice → Discord REST | 串,且是下一步前提 | `delivery.ts:119-171`;`adapters.ts:17-51` |
| 7 | 起子进程 `flywheel-comm chat-ingest --origin voice` 写入 Raya 邮箱 + 按门铃 | voice → comm.db → Bridge | 串 | `delivery.ts:173-226`;`adapters.ts:103-161`;`lead-inbox-nudge.ts:38-102` |
| 8 | Bridge 收件循环把批次经 unix socket 推给 Raya(活跃 1s / 空闲 30s 轮询,门铃可丢) | Bridge → Lead sidecar | 串 | `lead-inbox-loop.ts:30-31,187-219`;`CodexLeadInboxSocket.ts:582` |
| 9 | **Raya 一整轮 Codex turn**(串行队列,一次只跑一个 turn,语音没有插队通道) | Lead | **与她所有其他工作串行** | `LeadInputRouter.ts:2-8,285-302`;`CodexTurnExecutor.ts:136-138` |
| 10 | Raya 把文字回复发进 thread | Lead → Discord | 串 | `LeadInputRouter.ts:353-372`;`teamlead/src/bridge/discord-utils.ts:212-260` |
| 11 | Bridge 每 3s 轮询 thread 发现回复 → `voice_outbound` | Bridge → Discord REST | 轮询 | `voice-session-services.ts:57-65`;`voice-session-poller.ts:64-111` |
| 12 | 守护进程每 4s 拉一次 outbound 并领取 | voice ↔ Bridge | 轮询 | `daemon.ts:554-566,735-812`;`config.ts:135` |
| 13 | 按 ≤80 字切段,**一段一段串行**:`response.create` 逐字朗读,**整段生成完才开始播** | voice → OpenAI | 串 | `speech.ts:81,174-192`;`daemon.ts:781-788`;`realtime.ts:338-378,997-1022` |
| 14 | 20ms 一帧播进语音房,播完才请求下一段 | voice → Discord | 串 | `session.ts:270-299`;`audio.ts:131-158,223-229` |

「文字先出现、过一会儿才念」的代码原因:第 6 跳镜像先于一切;第 10 跳 Raya 的回复是先发成文字,语音这边要靠第 11、12 两层轮询**事后发现**它,再整段合成。没有从 Lead 到语音进程的推送通道。

### 2.1 实测:2026-09-23 03:05–03:08Z 会话 `c1b4b972`

数据源(全部只读):`~/.flywheel/voice/sessions/c1b4b972-…/events.jsonl` + `journal.jsonl`;`~/.flywheel/comm/raya/comm.db` 表 `mailbox` seq 283、285;`~/.flywheel/teamlead.db` 表 `voice_outbound` seq 3、4;Discord 消息 id 自带毫秒时间戳。

| 段 | U1「你在念什么东西啊?…」 | U2「你有听见我刚才在说的话吗?」 |
|---|---|---|
| 她说完(人声门关) | 03:06:23.39 | 03:07:36.44 |
| → 转写完成 | +2.1s | +1.2s |
| → 镜像进 thread / 写进邮箱 | +2.1s | +0.6s |
| → 推给 Raya(`notified_at`) | **+12.7s** | +2.1s |
| → Raya 回复出现在 thread(Raya 一整轮) | **+12.5s** | +8.2s |
| → 语音进程领取(两层轮询) | +6.8s | +3.8s |
| → 整段合成完、开始出声 | +1.7s | +2.1s |
| **说完 → 听到第一个字** | **≈ 38s** | **≈ 18s** |
| 念完(音频长) | +5.7s | +9.2s |

- U1 的 12.7s 等待与「空闲 30s 轮询」量级吻合,门铃为何没立即生效**未定位**(推断,不作结论)。
- **漏听**:03:07:11–16 她有两段真人声(人声门概率 0.99998,放行 117+143 帧),OpenAI 合成为一条输入,转写是 `delivered`,但说话人归属为空 → `realtime_input_terminal status=skipped_unknown` → 丢弃(`realtime.ts:739-761`)。Raya 在 U2 的回复里自己说「如果中间还说了别的,那部分我没收到」。
- 本场共 11 条人声门记录,4 条真放行,3 条 OpenAI 输入,2 条到了 Raya。样本只有一场、两句,只能说明量级,不能当分布。
- 进房先念「已进语音频道,正在等音频…」是 Raya 在主频道发的连接状态被当成回复念了(`voice_outbound` seq 2,channel 为 Raya 主频道;`voice-session-poller.ts` 同时轮询主频道与 thread,`voice-session-provisioner.ts:426`)。

## 3. 9 月初「自带脑子」那版是什么(git 考古)

代码不在本仓,在 `xrliAnnie/raya` 的 `apps/voice`(本机 `~/.flywheel/raya/code`,2026-09-09 FLY-2445 `9d63a2b` 删除运行壳)。9-02 前后部署的 SHA 无记录;`f669d1b`(08-30)与 `b1b5a64`(09-03)之间核心文件(`codex/CodexLeg.ts`、`VoiceTextMirror.ts`)未变,下面引用 `@f669d1b`。

| 跳 | 依据(raya 仓) |
|---|---|
| 另起一个 Codex 进程:`codex --enable realtime_conversation app-server` | FLY-2074 `research.md@e33f87d70:14-16`(本仓) |
| `thread/start`,`baseInstructions = IDENTITY.md + MEMORY.md` | `apps/voice/src/codex/CodexLeg.ts:115-134@f669d1b` |
| 同一 thread 上 `thread/realtime/start {outputModality:"audio", voice, version:"v2", prompt}` | `apps/voice/src/codex/RealtimeTransport.ts:181@f669d1b` |
| 默认口令:「始终用简短、自然的中文口语回答;需要工具时可以委托后台 Codex。」 | `apps/voice/src/cli.ts:84@f669d1b` |
| app-server 替我们配的 Realtime 会话:`instructions:"Answer user messages directly."`,`tools:[background_agent, remain_silent]`,`server_vad{silence_duration_ms:500, create_response:true, interrupt_response:true}` | 本仓 `engineering/doc/FLY-2159-voice-response-recovery/evidence/i5-true-upstream-frames.jsonl:2`;FLY-2249 `plan.md@4a4bc2994:372` |
| 实时模型自己决定 `background_agent` → `handoff_request` → 后台 Codex turn(推理/跑命令)→ 结果由实时模型用自己的声音说 | `runtime.ts:1653-1674@b1b5a64`;FLY-2031 `research.md@a1b333bc4:35-45` |
| 字幕 🗣️/💭/💬:`🗣️ Annie`、`💭 Raya:正在思考`、`💬 Raya` | `apps/voice/src/discord/VoiceTextMirror.ts:52,69,84@f669d1b` |

Raya 在跑的 Codex 0.154.0 二进制里仍能看到这两个工具的描述串(as-of 2026-09-23T03:46Z;`strings ~/.codex-raya/packages/standalone/releases/0.154.0-aarch64-apple-darwin/bin/codex`,注意 `which codex` 随 PATH 可能解析到 0.153.2:「The user request to delegate to the background agent」「remain_silent … Call this when the best response is to say nothing」)。

**这版没有逐句延迟实测留痕**(Raya 数据目录 `voice-evidence/events.jsonl` 只有 08-27 的 19 行)。能引用的只有「同类自带脑子」的参考值:FLY-1347 测量包里 `/gemini`(Gemini Live 自带脑子,另一条管线)真人「说完 → 回应 0.86s」(`FLY-1347-voice-measurement-pack/voice-measurement-pack.md:17`,2026-07-17)。

## 4. 为什么变成今天这样(两步)

1. **2026-09-08 founder 直令 F1–F4**(`FLY-2446-generic-voice-process/exploration.md:13-20`):一个独立 voice 进程,任何 Lead(含 Claude Lead)开会都能挂;语音转写成文字进 mailbox、走与文字完全相同的路;Lead 回复经 Bridge 交给 voice 念;会议模式所有 Lead 都要有,rg 先给 Raya。落地 = FLY-2446(09-09 `4eeaeda51`):实时模型降为「前台」,脑子改成 Lead。当时还走 app-server,`create_response` 关不掉,只能靠提示词压(`exploration.md@4eeaeda51:111`)。被否决的「一个脑子两个适配器」理由写的是「只对 Codex Lead 可行,Claude Lead 根本没有 realtime」(`:198`)。
2. **2026-09-22 FLY-2655**(`58693d28c`):app-server realtime 在生产收不到回话(「979 条真人 appendAudio 已被 app-server 收到;session.update 后无服务器事件,session.created 被标记 unsupported realtime v2」,`FLY-2655-voice-receive-recovery/exploration.md:54`),Lead 批准改为**直连 OpenAI Realtime**,并定「Realtime 只做 STT/TTS,不得独立回答」→ `tools:[]`、`create_response:false`(`realtime.ts:163-176`)。当时已登记「分段串行让回复延迟翻倍」为后续项(`realtime-handoff.md@58693d28c`)。

## 5. 她的三个问题 —— 事实层

- **Q1 Codex 有没有原生语音**:**历史上有过实验接口**,今天没有一条已证可用、受支持、能挂到 Raya Lead 本线程的路径。历史实证:app-server `thread/realtime/{start,appendAudio,appendText,appendSpeech,stop,listVoices}` + 通知 `outputAudio/delta`、`transcript/*`(FLY-2446 `exploration.md:56-70`,rust-v0.153.2 源码核过;本机 0.154.0 `strings` 可见)。9 月初那版就是它。但:① 那是 Raya 仓另起的**第二个** Codex 进程,不是 Raya Lead 自己那个会话;我们与 Lead 会话之间只送文字(`CodexTurnExecutor.ts:157-160` `input:[{type:"text"}]`);② 生产实证:今天这条路不通(FLY-2655 `exploration.md:54`);当前本机实证:本机 as-of 2026-09-23T03:46Z:Raya 实际在跑的二进制 `~/.codex-raya/…/0.154.0` → `codex features list` 为 `realtime_conversation removed false`;另一个 PATH 上的 `~/.local/bin/codex` 0.153.2 为 `under development false`;OpenAI 现行 Codex App Server 文档概览未列出 `thread/realtime/*`(Codex 设计评审 R1 所引 developers.openai.com/codex/app-server,未独立复核)。
- **Q2 Claude 系 Lead**:语音的「脑」接口今天是纯文字进出,与厂商无关——入:`chat-ingest` 进邮箱(`delivery.ts:30-40`,`adapters.ts:113-142`);出:Bridge 轮询 thread 里 Lead bot 发的文字(`voice-session-poller.ts:36-41`)。起会门不看 backend(`voice-session-start.ts:96-134`);所有 Lead 在 `projects.json` 都是 `voiceModes.meeting=true`。未验证:Claude Lead 会不会把 🗣️ 镜像当新消息二次摄入(Codex 侧有 `voiceMirrorIgnoredAuthorIds`,`CodexDiscordGateway.ts:100,183`;Claude 侧未找到对应逻辑);生产从没跑过 meeting。
- **Q3 进语音时原来的工作还能不能继续**:语音守护进程是独立进程、独立租约,不占 Lead(`daemon.ts:432-444`)。但**每句话都是 Raya 串行队列里的一个 turn**,与 Discord 回复、邮箱、Runner 督办同一个循环、同一个 app-server thread(`LeadInputRouter.ts:2-8,22-24,285-300`;`CodexTurnExecutor.ts:136-138`),语音没有优先级(`LeadInputRouter.ts` 里无 `voice`)。已派出去的 Runner 是独立进程,照跑。

## 6. 未验证 / 边界

- 9 月初那版的逐句延迟:无留痕,未测。
- 会议模式延迟:生产从未跑过,未测;外层与 rg 共用,Lead 那一段随 Lead 而变,Claude Lead 那一段(tmux 收件轮询)未读实现、未测。
- U1 那 12.7s 为什么没被门铃叫醒:未定位。
- `@discordjs/voice` 说话结束判定的去抖常量:本 worktree 无 node_modules,未核。
- OpenAI 侧转写 / 合成耗时只有本场两句的实测。
