# FLY-2885 引擎 B 改走 WebRTC + 订阅 — 探索
Issue: FLY-2885 (https://linear.app/geoforge3d/issue/FLY-2885/语音b核心连接层-引擎-b-改走-webrtc-订阅替换-websocket-api-key房间进程-webrtc)
日期: 2026-09-25
基于: 无(上游证据: FLY-2884 分支 `flywheel-FLY-2884` 结论页与 `evidence/src/bridge.mjs`;FLY-2799 已合入 #1306)

## 1. 要解决什么

founder 2026-09-25 13:07 PDT:WebRTC 连接不需要 API key,效果可能比 WebSocket 更好,多花时间也值得。FLY-2884 闸门已证实
「Discord ↔ WebRTC 订阅会话、Opus 原样转交」在真人场景成立(说完→房内听到均 1.58 s;10 分钟零断线;每场 <1% 周额度)。

本单把**生产代码里的引擎 B**(`packages/voice-codex` 的 `codex-realtime` 后端)从
「Codex app-server + WebSocket + `OPENAI_API_KEY`」改成「Codex app-server + WebRTC + ChatGPT 订阅」,并解决 2884 留给连接层的两件事:

1. 插话:检测到 founder 开口就在**我们这边**立即截断下行播放、取消当前回复(目标 ≤1.0 s 停)。
2. 远处人声误触发(60 s 远处人声触发 1 次)。

## 2. 现状盘点(main `ef47e9a05`,只读审计)

### 2.1 引擎 B 的组成

| 层 | 文件 | 今天做什么 |
|---|---|---|
| 房间(Discord) | `voice-codex/src/discord-room.ts` `DiscordVoiceRoom` | bot 进房;只收 founder + QA 白名单(`allowed`),同一时刻只收一个人;prism Opus 解码成 48k 立体声 PCM → `Uplink`(Silero VAD 门 + 200 ms 句首 pre-roll + 下混 24k 单声道)→ 每 20 ms 时钟 `onAudio(frame, owner)`;下行由 `WaitingMouth`(PCM 泵,Raw PCM 进 AudioPlayer)播放 |
| 会话编排 | `voice-codex/src/session.ts` `GenericVoiceSession` | founder 音频到来且模型在说话 ⇒ `cancelSpeech` + `cancelAllSpeech`(本地插话) |
| 前台适配 | `codex/CodexRoomFrontend.ts` | ConversationSession ↔ 房间回调 |
| 会话语义 | `codex/CodexVoiceBackend.ts` `CodexVoiceSession` | 发音频、转写落盘/上行、委托交 Lead、proof 播报;**插话 = `restart()` 整条实时连接换一代**;下行按 assistant item 开 `openAudio` 流式播放(首帧即播) |
| 协议适配 | `codex/RealtimeTransport.ts` | `thread/realtime/start`(v2)、`appendAudio`(base64 PCM24 走 JSON-RPC)、`outputAudio/delta`(PCM24 走 JSON-RPC)、转写/item/委托/后台回合拦截 |
| 容器 | `codex/CodexVoiceContainer.ts` + `codex-home.ts` | 每场新建临时 root(home/work,0700);固定 **codex 0.156.1** 二进制 + sha256;config.toml `forced_login_method="api"`、`cli_auth_credentials_store="ephemeral"`,**拒绝任何 auth.json**;`voiceProfile.openAiApiKey` 注入;`realtimeStart = {version:"v2", transport:{type:"websocket"}, model:"gpt-realtime-2.1", voice}`;关闭时 stop 子进程 + `rm -rf root` |
| 配置 | `voice-codex/src/config.ts` | **无条件**要求 `OPENAI_API_KEY`(`:137-138`),即使选的是 `codex-realtime` |
| 启动壳 | `scripts/flywheel-voice-wrapper.sh:69-72` | 无 `OPENAI_API_KEY` 直接拒绝启动 |
| QA 房 | `scripts/qa/fly2655-voice-room.mjs:419` | 给语音进程注入 `OPENAI_API_KEY`(读 `~/.flywheel/.env`) |

生产现状:`~/.flywheel/.env` 未设 `FLYWHEEL_VOICE_BACKEND` ⇒ 生产跑的是**旧引擎 `openai-realtime`**(`realtime.ts`);
引擎 B 只在 QA 房(529 slot)显式选 `codex-realtime` 时跑。本单**不切生产默认引擎**。

### 2.2 FLY-2799 已合入、必须保留的四项

| 项 | 在哪 | 与传输的关系 |
|---|---|---|
| 回环按来源排除 | `351c69bc4`:语音侧把镜像到 thread 的每行 Discord 消息 id 报给 Bridge(`POST utterance-mirrors`),出站轮询按 id 不再把它当 Lead 回复念出来 | 文字层,与传输无关;保持原样 |
| 首帧即播 | `CodexVoiceBackend.openAudio`:assistant 音频一到就开流播放,不等 final 转写 | WebRTC 下行本身就是实时连续 RTP;改为「收到第一个下行包即推给播放器」,需要新回归测试 |
| 句首 pre-roll | `c253c1fdf`:`UplinkSpeechGate` 200 ms pre-roll | 上行 PCM 管线不动 ⇒ 原样保留 |
| 身份自答 | Bridge `buildVoiceSessionContext` 生成的 realtime prompt(身份 + 记忆) | 取决于 v3 如何使用 `prompt`(见 research) |

### 2.3 声线

- 投影里已有 `realtimeVoice`(Bridge 启动时从 `projects.json` 读,`realtimeVoice ?? "marin"`),`cli.ts` 已传给容器。
- FLY-2866 写入后的现网值:`flywheel-eng-lead=verse`、`flywheel-product-lead=alloy`,其余 15 个 `marin`。
- 白名单 `REALTIME_V2_VOICES`(teamlead)10 个;0.157.0 `listVoices` 实测只返回 `v1`(9 个)与 `v2`(同那 10 个),**没有 v3 专列**(`probe-account-voices.json`)。

### 2.4 零额度探针(本单,2026-09-25)

0.157.0 + 临时 `CODEX_HOME`(`auth.json` 软链到 `~/.codex/auth.json`,config `forced_login_method="chatgpt"`,环境去掉 `OPENAI_API_KEY`/`CODEX_API_KEY`):
`account/read` → `type=chatgpt`;`listVoices` 如上;进程退出后软链仍是软链,`rm -rf` 临时 root 后源文件仍在、mtime 未变。未开实时会话,不耗额度。

## 3. FLY-2884 给本单的输入(结论页 + 证据)

- 两方向 Opus 直转零违规(18,789 上行 / 62,197 下行包全是 20 ms / 960 样本);上行缓冲策略:起步 60 ms、积压时追赶、>10 包才丢。
- 说完→开口:程序端均 985 ms,房内均 1575 ms(本单验收上限 = 均值 +20%:**程序端 ≤1182 ms,房内 ≤1890 ms**)。
- 插话:服务端判定均 1156 ms(要识别出第一个字),4/10 先把旧句说完;原型本地**没有**做任何截断。
- 远处人声:本单从证据 `s4/frames-bridge` 复算上行电平——风扇 p50 −27.4 dBFS(Silero 不判为人声)、远处人声 p99 −35.6 dBFS/最大 −34.1 dBFS;
  替身近讲 p50 ≈ −18 dBFS;founder 真人场最轻一句最大 −26.2 dBFS。
- 10 分钟稳定;数据通道事件(`session.started` 带 `expires_at` ≈ +2 h、`turn.created/done`、`input_transcript.added`、`output_transcript.added`、`delegation.created`、`session.usage.updated`)。

## 4. 方案候选

### 上行(房间 → WebRTC)

- **U1 保留现有 PCM 管线 + 单次 Opus 编码(推荐)**:`Uplink` 每 20 ms 产出的 24k 单声道帧(人声或静音)原样送一个 Opus 编码器 → RTP PT111,时间戳每包 +960。
  来源白名单、单说话人、Silero 门、200 ms pre-roll、owner 元数据全部不动;时钟本来就每拍必发 ⇒ 天然满足 2884 的「时间轴连续」。
  代价:一次 Opus 重编码(Discord Opus → PCM → Opus),音质一代损失;CPU 用已有依赖 `opusscript`,每 20 ms 一帧。
- U2 真直转:Opus 包带着穿过 Silero 门的延迟线,门判人声就发原包、判静音就发预编码静音帧。零转码,但要把门和捕获改成逐包同步解码,动 2799 已回归的代码,风险大。**否决**(收益只是一代 Opus 损失)。
- U3 原型式「不经门直接转」:丢掉 pre-roll / 门 ⇒ 违反「保留句首补音」。**否决**。

### 下行(WebRTC → 房间)

- **D1 Opus 直转(推荐,2884 已证)**:RTP 负载校验 TOC=960 样本后原样推进对象流,AudioPlayer `StreamType.Opus` 播放。本地插话 = 停止推送当前回答的包(改推空)。
- D2 解码成 PCM 再进现有 `WaitingMouth`:保住 PCM 泵与既有测试,但多一次解码 + Discord 重编码;WebRTC 下行没有 item 边界,要靠数据通道事件切段,复杂。**否决**。

### 插话(本单 ①)

- **B1 本地先截断 + 请服务端取消(推荐)**:房间的 Silero 门一开(founder 连续人声 ≥200 ms)且模型正在出声 ⇒ 立即静音下行(丢弃当前回答后续包)并发取消;
  等服务端出现**新的 assistant 回答**再解除静音。取消手段按 research 的 v3 协议事实选定;若协议没有取消,则只靠本地静音 + 服务端自己的截断,并设兜底解除。
- B2 今天的做法:整条实时连接 `restart()` 换一代。WebRTC 重建要 ICE/DTLS,约 1 s 以上,还丢会话上下文。**否决**(只在断线重连时换代)。

### 远处人声(本单 ②)

- **N1 句首响度门(推荐,可配置)**:Silero 判为人声之外,再要求该段开头窗口内的峰值短时电平 ≥ 门限才放行;按 2884 证据默认 −30 dBFS
  (远处人声最大 −34.1、founder 最轻一句最大 −26.2,两侧各约 4 dB 余量),`0`/`off` 可关。
- N2 只提 Silero 阈值:远处人声也是真人声,概率高,提阈值会先伤到 founder 轻声。**否决**。
- N3「只在被叫到时回答」:属大脑层提示词,不在本单。

### 会话生命周期

- 断线:WebRTC `failed`/长时间 `disconnected`、数据通道关闭、`thread/realtime/closed` 非本端发起 ⇒ 同一容器、同一 thread 内新开一代(新 PeerConnection + 新 realtime/start),有上限;超限干净结束。
- 收尾:realtime/stop → PeerConnection.close → app-server 退出 → 删临时 root(只删软链本身)→ 证据。
- 进程崩溃遗留:启动时扫 `codex-containers/`,按 owner 记录清理孤儿子进程与临时目录。

## 5. 假设(research 逐条核实)

1. 0.157.0 app-server 的 webrtc 传输由它把 SDP offer 送到 OpenAI 并返回 answer;音频只走 RTP,不走 JSON-RPC。
2. v3 默认模型 `gpt-live-1-codex`,可显式传 `model`;`voice` 在 v3 会被送到服务端。
3. v3 的 `prompt` 能承载 Lead 身份 + 记忆(Raya 约 15.6k 估计 token),不会被截成 8k。
4. v3 协议有客户端可发的「取消当前回答」事件,或服务端 VAD 截断之外还有可用手段。
5. 共享 `~/.codex/auth.json` 软链在并发刷新下安全(FLY-2404 结论:原地写、刷新前回读)。

## 6. 不做

- 不改大脑层(身份、记忆、只在被叫到才答、能力说明)——另单。
- 不切生产默认引擎(`FLYWHEEL_VOICE_BACKEND` 仍未设 = 旧引擎)。
- 不做多人混音;不改旧引擎 `openai-realtime` 与它的 API key 路径。
- 不升级舰队 Codex 二进制;引擎 B 继续用已固定的 standalone 0.156.1(research R1:v3/WebRTC 代码与 0.157.0 逐字相同)。
