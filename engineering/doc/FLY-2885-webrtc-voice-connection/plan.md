# FLY-2885 引擎 B 改走 WebRTC + 订阅 — 实施计划
Issue: FLY-2885 (https://linear.app/geoforge3d/issue/FLY-2885/语音b核心连接层-引擎-b-改走-webrtc-订阅替换-websocket-api-key房间进程-webrtc)
日期: 2026-09-25
基于: research.md

状态:**设计评审 APPROVED**(R6,Codex gpt-6-astra xhigh;v6.1 仅按 R6 LOW 拆开一句文字)。本文只设计,不含实现。本文只设计,不含实现。

## 0. 边界与验收映射

| issue 验收 | 本计划落点 | 证明方式 |
|---|---|---|
| 1 无 API key 真人问答 | T1 容器认证改订阅、T10 配置/启动壳/QA 房不再要求或注入 key | QA-1:语音进程与 codex 子进程环境里都没有 `OPENAI_API_KEY`(`ps eww` 取证只记变量名是否存在),真人问答录音 + 转写 |
| 2 延迟 ≤ 2884 均值 +20% | T2/T3 WebRTC 直连、T4 下行直转、T6 门开后追帧 | QA-2:5 次「说完→开口」,**程序端 ≤1,182 ms、房内 ≤1,890 ms**(2884:985 / 1,575 ms) |
| 3 断网/杀连接自动恢复或干净结束 | T7 断线换代(关闭屏障 + 上限)、收尾、遗留目录清扫 | QA-3a 断 WebRTC 腿 → 自动恢复(恰好一个当前代);QA-3b 杀 app-server → 干净结束,查本场 root 已删、本场子进程已退、会话终态、租约已放 |
| 4 2799 三项回归全绿 | 回环排除(文字层,不动)、首帧即播(T4 新测试)、句首补音(T6 保持 pre-roll) | §6 列出的三项现有回归测试 + 新测试 + QA 听感 |
| 5 只跑相关测试;拆 529 房前 ask Lead | §6 测试清单只列改动文件的测试 | runner 纪律 |
| 本单 ① 插话 ≤1.0 s 停 | T5 本地截断 + 有界回放 | QA-4:≥10 次有效插话,旧声音 ≤1.0 s 停 10/10,新回答句首完整 ≥8/10,`boundary_unknown`/`head_lost` 各 ≤1 |
| 本单 ② 远处人声 | T6 句级峰值门 | QA-5:2884 远处人声素材 60 s 零误触发;founder 轻声仍放行 |
| Lead 指令 `0f475441`:朗读自编内容 / 无声 | T5c 越界检测截断 + 审计、无声重试 | QA-7 负向用例 |

**不做**:大脑层(身份措辞、能力说明、只在被叫到时回答)、切生产默认引擎、多人混音、旧引擎 `openai-realtime`、升级舰队 Codex。

## 1. 架构

```mermaid
flowchart LR
  subgraph Room["DiscordVoiceRoom(房间进程,已有)"]
    RX["只收 founder/QA 白名单<br/>单说话人 + prism 解码"]
    GATE["UplinkSpeechGate<br/>Silero + 200ms pre-roll<br/>T6:开后追帧 + 句级峰值门"]
    CLK["20ms 时钟 Uplink.tick<br/>每拍一帧 24k 单声道(人声或静音)"]
    DL["T4 OpusDownlink<br/>对象流 → AudioPlayer StreamType.Opus"]
  end
  subgraph Leg["T2 WebRtcLeg(新,werift)"]
    ENC["opusscript 24k 单声道编码<br/>RTP PT111 ts+960"]
    RTPIN["下行 RTP 校验 TOC=960<br/>旁路解码只算电平"]
    DC["数据通道 oai-events<br/>turn.created/done 等(容错)"]
  end
  subgraph Box["容器(每场一个)"]
    AS["codex app-server 0.156.1<br/>临时 CODEX_HOME<br/>auth.json 软链订阅凭据"]
  end
  OAI["OpenAI 实时会话<br/>gpt-live-1-codex / v3"]
  RX --> GATE --> CLK --> ENC -->|RTP| OAI
  OAI -->|RTP| RTPIN --> MUTE{"T5 本地静音门"} --> DL
  OAI <-->|DTLS 数据通道| DC
  AS <-->|"HTTP 建会话 + sideband WS"| OAI
  AS -->|"sdp / 转写 / 委托 / 错误 通知"| T3["T3 RealtimeTransport v3"]
  T3 -->|"start{webrtc offer} / appendSpeech / stop"| AS
```

- 音频只走我们进程里的 WebRTC 腿;app-server 只做建会话、sideband(appendSpeech、委托)与通知。
- 上行保留 2799 整条 PCM 管线,**只把末端的 JSON-RPC appendAudio 换成「编码一次 Opus + RTP」**(research U1)。
- 下行不解码不重编码(2884 已证),只在本地插话时把负载换成预编码静音帧。

## 2. 稳定身份与配置

| 名称 | 值 / 来源 | 说明 |
|---|---|---|
| 后端 id | `codex-realtime`(不变) | 注册表、投影、证据都沿用 |
| 二进制 | `CODEX_VOICE_BINARY_VERSION = "codex-cli 0.156.1"`、sha256 `0196e89f…255a`(不变) | research R1:v3/WebRTC 代码与 0.157.0 逐字相同 |
| 会话参数 | 常量 `CODEX_VOICE_REALTIME_VERSION = "v3"`、`CODEX_VOICE_REALTIME_MODEL = "gpt-live-1-codex"`、`transport:{type:"webrtc",sdp}`、`outputModality:"audio"`、`clientManagedHandoffs:true`、`includeStartupContext:false` | 与 CLI `/voice` 同参;模型**显式传**,不靠默认 |
| 声线 | 每个 Lead 新字段 **`liveVoice`**,枚举 = v3 九个(`LIVE_V3_VOICES`,放 `teamlead/src/realtime-voices.ts`),缺省 `cove` | 旧引擎继续读 `realtimeVoice`;两个字段互不回退(Lead 裁定 §9①) |
| 凭据源 | 环境 `FLYWHEEL_VOICE_CODEX_AUTH_SOURCE`,缺省 `~/.codex/auth.json`(舰队凭据) | 只建软链,绝不拷贝、不 login/logout |
| 门参数 | `FLYWHEEL_VOICE_UPLINK_MIN_ONSET_DBFS`(缺省 −30,`off` 关闭)、`FLYWHEEL_VOICE_UPLINK_PREROLL_MS`(已有,200) | 峰值门只在 WebRTC 房生效 |
| STUN | `FLYWHEEL_VOICE_WEBRTC_STUN`(缺省 `stun:stun.l.google.com:19302`,空串 = 只用本机候选) | 与 2881/2884 实测同配置 |

## 3. 改动清单

### T1 容器与订阅认证(`codex/CodexVoiceContainer.ts`、`codex-home.ts`、`teamlead/src/codex-process.ts` 调用面)

1. `VOICE_CODEX_HOME_CONFIG` 改为 `forced_login_method = "chatgpt"`、`cli_auth_credentials_store = "file"`,其余特性开关不变(仍关 shell/unified_exec/memories/web 等)。
2. 建 home 时在 `config.toml` 之后创建 `auth.json` **软链** → 凭据源绝对路径。准入校验(改写 `assertVoiceCodexHome`):
   - 凭据源:绝对路径、`lstat` 是本用户拥有的**普通文件**(不是软链)、权限 `0600`;启动时 `realpath` 一次并钉住。
   - home 里的 `auth.json`:必须是软链、`readlink` 恰等于钉住的源路径;其他任何形态(普通文件、指向别处)⇒ `codex_profile_mismatch`。
   - 删除 root 用 `rm({recursive,force})`(按 `lstat` 不跟随软链);加测试:删后源文件仍在、字节不变。
3. 构造参数去掉 `openAiApiKey`;`spawnCodexAppServer` 不再传 `voiceProfile`(保留该能力给别的调用者,不删);子进程环境继续用 `positiveChildEnv` 白名单(本来就不含 key)。
4. 开会话前 `account/read`:`account.type` 必须是 `"chatgpt"`,否则 `codex_auth_rejected`;`classifyOpenError` 增加订阅侧文案匹配(`usage limit`、`rate limit`、HTTP 401/403 的 ChatGPT 形态),额度耗尽 → `codex_quota_exhausted`,**不切引擎、不换模型**。
5. `assertThreadReceipt` 不变(cliVersion 仍 0.156.1)。

### T2 WebRTC 腿(新 `codex/WebRtcLeg.ts`)

- 依赖:`werift@0.24.4`(新,精确版本)、`opusscript@0.0.8`(voice-codex 显式声明,版本同 voice-bridge)。
- `prepareOffer()`:一条 `sendrecv` 音频收发器(opus/48000/2,PT111,`minptime=10;useinbandfec=1`)+ `oai-events` 数据通道;等 ICE 收集完成(≤8 s)返回 offer SDP。
- `acceptAnswer(sdp)`:设远端描述;等 `connectionState=connected`(≤10 s,超时 = 本代失败)。
- 上行 `writePcm24(frame960Bytes)`:只收 960 字节(20 ms 24 kHz 单声道),`opusscript(24000,1,VOIP)` 编码,RTP 序号 +1、时间戳 +960;编码或写失败 → `onInputGap`。
- 下行:每个 RTP 负载先读 TOC 得样本数,**不是 960 就本代失败**(`downlink_non960`,2884 同规则);序号回退/重复丢弃计数;旁路 `opusscript(48000,2)` 解码只算 RMS(不回送)。回调 `onDownlink({payload, voiced, rms})`。
- 数据通道:JSON 解析失败忽略并计数;只转出 `session.started{expires_at}`、`turn.created/done{id,role,start_ms,end_ms,transcript}`,其余只计数。**任何字段缺失都不抛**。
- 状态回调:`connected`、`lost(reason)`(`failed`,或 `disconnected` 持续 >5 s,或数据通道关闭,或连通后 5 s 收不到任何下行包)。
- `close()` 幂等:关数据通道、关 PeerConnection、释放编解码器。

### T3 v3 协议适配(`codex/RealtimeTransport.ts`)

- `start()`:由调用方先给 offer;请求 `thread/realtime/start {..., version:"v3", model, voice, transport:{type:"webrtc",sdp}, prompt, initialItems}`。
  固定版本的顺序是先 `started` 后 `sdp`(`realtime_conversation.rs:1616-1637`,probe-2/3 相隔 <1 ms):收到 `started` 时**照旧校验 `version === "v3"`**(不符立即失败);媒体就绪条件 = `sdp` 到达 → `leg.acceptAnswer` → 连通,三者都成才 `active`。
  RPC 成功不算开成:期间收到 `thread/realtime/error`/`closed` 立即失败(research R2:声线不支持是 start 成功后的异步 error)。总超时沿用 60 s。
- `appendAudio(frame, generation, owner)`:改为同步写 WebRTC 腿;返回值语义保留(`sent`/`dropped:*`),`backpressure` 只在腿不可写时出现;owner 归属、`unsettledInput` 统计照旧。
- `thread/realtime/outputAudio/delta` 在 WebRTC 下**不应出现**:出现即 `fenced` + 证据(防重复出声)。
- 转写、`handoff_request`、`turn/started` 拦截、`item/started` 执行拦截:**不变**。
- **通知路由收口**(配合 T7):transport 不再各自在共享 RPC 上挂常驻监听;由 `CodexVoiceConversation` 持有唯一的 `notification/exit` 监听,只转发给**当前代** transport,退休的 transport 立刻解绑。`onError/onClosed` 统一带上当前代 generation。

### T4 下行直转、首帧即播、清队列(`discord-room.ts`、新 `audio/OpusDownlink.ts`、voice-bridge `discordWiring.ts`)

- voice-bridge `ResourceSource` 新增 `{kind:"opus-stream", stream}` → `createAudioResource(stream,{inputType: StreamType.Opus})`(加法,不改已有三种)。
- `DiscordVoiceRoom` 新选项 `downlink: "pcm-mouth" | "opus-passthrough"`(缺省 `pcm-mouth` = 今天行为,旧引擎不受影响)。`opus-passthrough` 时不起 `WaitingMouth`,改起 `OpusDownlink`:
  - 一个对象模式可读流 + 一个 `opus-stream` 资源常驻播放;`push(payload)` 在 RTP 回调里**同步**入流(首帧即播)。
  - **`cut()`(同步清队列)**:沿用 `WaitingMouth.dropQueuedOutput` 的做法(`audio.ts:377-392`)——新建流与资源交给播放器、销毁旧流,应用队列与已交给播放器但未取走的旧包一起作废,记 `downlink_flushed{droppedPackets}`。
    `DiscordVoiceRoom.cancelAllSpeech()` 在 opus 模式下调用 `downlink.cut()`;插话、换代(T7)、租约失效都调用它。
  - **租约**:每次 `push` 前调 `assertLease()`(迁移 `WaitingMouth.tick` 的检查,`audio.ts:395-402`),失败 ⇒ `cut()` + 停止 + `onError`。
  - 积压保护:流里 >25 包(500 ms)才裁到 3 包并记 `downlink_queue_trim`(2884 最深 7–10 包,正常不触发)。
  - 播放器进入 idle(连续 5 s 无数据)⇒ 重建资源继续播并记证据。
- `CodexVoiceBackend` 去掉按 assistant item 开 `openAudio` 的逐项输出;改为会话级 `downlink` 接口 `{push(payload, meta), cut(), mute(), unmute()}`。
  `response-audio` 事件不再发 PCM;`response-started/done` 改由 `OpusDownlink.audible()` 判定(未消费的有声包,或 300 ms 内播放器取走过有声包;定义见 T5,`voiced` 由 WebRTC 腿旁路解码给出)。

### T5 本地插话(`codex/CodexVoiceBackend.ts` + `audio/OpusDownlink.ts`;`session.ts` 触发条件不改)

触发点沿用 `GenericVoiceSession`:founder 的音频离开门(门确认人声 ≥200 ms 的那一刻)且 `frontendResponseActive` ⇒ `frontend.cancelSpeech` ⇒ `CodexVoiceSession.interrupt()` 与 `room.cancelAllSpeech()`。
`interrupt()` 在 WebRTC 下**不再 `restart()`**,改为下面的「静音 + 有界回放」状态机。

**「还听得到」的定义(R3-2)**:`OpusDownlink.audible()` = 播放器里还有**未消费的有声包**(沿用 `audio.ts:363-374` 的消费进度思路:已推出包数 − 播放器已取走包数,逐包记 `voiced`),或最近 300 ms 内播放器取走过有声包。
`response-started/done`(⇒ `frontendResponseActive`)与 T5b 空闲准入都以 `audible()` 为准,**不再只看网络下行最近 300 ms**;因此回放积压还在播时 founder 再开口,一定会走到 cut。

**事实前提(设计依据,不是协议保证)**:① 事件比音频晚且不定:assistant `turn.created` 比首个有声包晚 915/968 ms(probe-2/3);2884 s3 里用户 delta 到达后旧回答音频还持续了约 0.9 s(R3-1 复算);`turn.start_ms` 与有声起点偏差 770–930 ms 且不恒定。② 服务端判定插话后截断旧回答(2884:10/10)。③ 新回答只能在 founder 说完、服务端判停、模型起答之后出声。
⇒ 新旧回答的分界**只能估计**。本节只承诺:旧声音在本地 cut 后立即停;新回答句首「尽量」保住,并且**任何情况下都在有限时间内恢复播放**,每次结果可观测。

```mermaid
stateDiagram-v2
  [*] --> Playing
  Playing --> Muted: founder 开口且 audible·cut 清队列·开始缓冲下行
  Muted --> Deciding: 用户回合证据到达且 founder 门已关
  Muted --> Deciding: 兜底·cutAt 后 3s 无证据且门已关 1.5s
  Deciding --> Playing: 缓冲里最长间隙之后已有有声包·从该处回放
  Deciding --> WaitGap: 缓冲里还没有合格间隙
  WaitGap --> Playing: 合格间隙之后第一个有声包·直接放行
  WaitGap --> Playing: 进入 Deciding 满 2s·从当下放行·记 boundary_unknown
```

- **Muted**:下行包换成预编码静音帧推给播放器(不断粮);原始包连同 `voiced` 进回放缓冲(环形 75 包 = 1.5 s)。
- **用户回合证据**:数据通道 `turn.created{role:user}` 或 app-server `transcript/delta{role:user}`,取先到;只认 `cutAt` 之后到达的。进入 Deciding 还要求 founder 门已关。
- **合格间隙**:cut 之后连续 `voiced=false` ≥240 ms(12 包)的一段。阈值按 2884 s3 真实切换处(15 包、19 包)取在其下;有多段取最长,并列取最后。这只是估计:回答内的长停顿、或切换处恰好很短,都可能判错——结果进证据由 QA 统计,不宣称句首一定完整。
- **Deciding**:最长合格间隙之后缓冲里已有有声包 ⇒ 从该间隙结束处回放全部后续缓冲包再接实时包(额外延迟 = 当前 − 间隙结束,≤1.5 s)。该间隙已被挤出缓冲 ⇒ 从当下实时放行,记 `head_lost`。
- **WaitGap**:还没有合格间隙 ⇒ 继续静音,出现合格间隙后第一个有声包直接放行(零额外延迟)。**期限 2 s**(自进入 Deciding 起):到期仍无合格间隙 ⇒ 从当下实时放行,记 `boundary_unknown`(可能丢了新回答句首,也可能放出一小段旧回答尾巴)。
- 所有路径都有终点:founder 门不关就保持 Muted(她在说话时不该放声);门关后最长 3 s(兜底)+ 2 s(期限)必然恢复播放。
- 回放积压在后续停顿里消化:队列 >3 包时收到的 `voiced=false` 包直接丢弃(只丢静音);回放包不受 T4「>25 包裁剪」规则影响。
- 解除时证据 `codex_barge_in_resumed{trigger: user_turn|unconfirmed, boundary: replay|live|head_lost|boundary_unknown, gapMs, replayMs, mutedMs}`;QA-4 用它统计,并检查插话后的新回答是否完整、何时开始可听。
- 进入静音时:在途朗读按 T5b 结算、发 `response-cancelled`、证据 `codex_barge_in_local_cut{cutAt}`。
- 取消:v3 没有客户端取消事件(research R6),**不发任何数据通道客户端事件**;旧回答由服务端判定插话时自己截断。
- 协议说明(Bridge,T8)加一句:被打断就放弃没说完的话、直接回应新问题,不要接着说完或重复。

### T5b 朗读回执在 v3 下的准入与绑定(`codex/CodexProofSpeaker.ts`、`codex/CodexVoiceBackend.ts`)

今天的回执靠 assistant item id + 同 id 的 final 转写 + 逐 item 播放完成(`CodexProofSpeaker.ts:154-208`、`CodexVoiceBackend.ts:797-825`),v3 三样都没有;`appendSpeech` RPC 成功只表示请求入队(`C156 turn_processor.rs:1339-1361`),不带 turn id。先**准入**再绑定:

**待答用户轮次(R3-3)**:每条用户回合证据(见 T5)都开一个「待答」标记,记下证据到达时刻 `u`。只有满足下面条件的 assistant 回合 A 才能清除它:A 的 `turn.created` **在 `u` 之后到达**,且 A 的 `turn.done` 已到。在 `u` 之前就已 created 的 assistant 回合(旧回答)即使其 done 晚于 `u` 到达,也**不能**清除(2884 s3 实测:旧回答的 done 晚于新用户 delta 到达)。数据通道没有 assistant 回合事件时无法证明 ⇒ 待答标记一直保留。

1. **空闲准入**(每块发送前,全部满足才发):① 没有未结束的 assistant 回合(created 而无同 id done);② `OpusDownlink.audible()` 为假且已持续 600 ms;③ founder 门关着,且**没有待答用户轮次**;④ 不在 Muted/Deciding/WaitGap;⑤ **不在 T5c 的 OverrunDiscard 态**(丢弃态会把声音换成静音,`audible()` 为假不代表它已结束)。T5c 的无声重试同样要过这五条。不满足就等,最多 10 s ⇒ 仍不满足 ⇒ `rejected{reason:"busy_conversation"}`、`transport:none`(前端 `failed`,走现有「没能念出」路径)。
2. **绑定**:准入并发出后,本代第一个 `turn.created{role:assistant}` 的 `turn.id`;绑定前出现新的用户回合证据 ⇒ `speech_preempted`。准入已排除「有待答用户轮次」与「有在途 assistant 回合」,首个新回合才被认为由本次朗读引起;这仍是基于事件完整性的推断,数据通道缺事件时走第 6 条的诚实失败。
3. **转写**:同一 `turn.id` 的 `turn.done.transcript`,用现有 `isFiniteSpeechEquivalent` 判等价(越界见 T5c)。
4. **已提交播放**:发出到同 id `turn.done` 之间,播放器以未静音状态**消费**过 ≥1 个有声包,且期间没有 cut、没有 T4 裁剪、没有静音丢包。发生裁剪 ⇒ `failed{reason:"playback_trimmed", transport:"submitted"}`。
5. **中断**:期间本地插话 cut ⇒ `speech_interrupted`;换代 / 会话关闭 ⇒ `generation_changed`;已消费过有声包则 `transport:submitted`,否则 `none`。
6. **无法关联**:30 s 内没有可绑定的 `turn.created`,或 `turn.done` 缺失 ⇒ `speech_binding_unavailable`,不重试;`transport` 按消费口径:发出后播放器消费过有声包 ⇒ `submitted`(前端 `unconfirmed`),否则 `none`(前端 `failed`,`CodexRoomFrontend.ts:140-143`)。
7. 多块朗读逐块走 1–6;每块都重新准入(前一块尾音播完、`audible()` 为假 600 ms 后才发下一块)。

### T5c 朗读越界与无声的守卫(`codex/CodexProofSpeaker.ts`、`codex/CodexVoiceBackend.ts`、`audio/OpusDownlink.ts`)

输入(Lead 指令 `0f475441`,FLY-2866 `research-v3.md:49-52`,gpt-live-1-codex / v3 / WebRTC 同路径):23 次 `appendSpeech` 实录中 **4 次在念完原句后自编了一段虚构「工作汇报」**(原始记录 `spruce-3、sol-3、spruce-1、vale-1/session.jsonl:18`),**1 次整段无声**(`vale-3`,appendSpeech 成功后约 60 s 无声),另有十几次 1–6 字出入。

守卫只作用于**朗读类输出**(T5b 准入并发出的块);自由对话回合里的编造属于大脑层,本单不管。

**1. 检测输入(单一来源)**
- 只用 app-server `thread/realtime/transcript/delta{role:assistant}` 与 `transcript/done{role:assistant}`(Codex 协议面;数据通道的 `output_transcript.added` 是同一内容的另一份,**不用**,避免两路去重问题;T2 的数据通道只转出 `session.started` 与 `turn.*`)。
- 从该块**发出那一刻**起累积所有 assistant 增量(含早于 `turn.created` 到达的前缀):T5b 准入保证此刻没有别的 assistant 回合在途,所以发出之后到本块结算之间的 assistant 增量都归本块;结算后迟到的增量见第 3 条。
- 增量缺失、只有 final 的情况:在 `transcript/done{assistant}` 到达时对全文再做一次同样的检查(第 2 条),**先检查再持久化/镜像**。

**2. 越界判定(对齐计量,R4-1)**
- 规范化同 `prepareReplySpeech`(去标点、全半角、空白)。期望文本 `E`、累积转写 `A`。
- 用有界的逐字对齐(LCS;`E` 为单块 ≤80 字的朗读块,`A` 超过 `2×|E|+64` 字时截断计算并直接判越界)算出 `A` 中**没有对齐到 `E` 的字数** `u`。
- **`u ≥ 8` ⇒ 越界**(容忍 1–6 字改写与 1 字标点/语气词余量)。每来一个增量就重算一次(字数小,开销可忽略)。
- 这样「改几个字 + 追加一段」不会绕过:R4 反例(期望 38 字,把「目前」改成「现在」再追加 20 字)得 `u = 22` ⇒ 越界;单纯 1–6 字改写 `u ≤ 6` ⇒ 不越界。

**3. 越界处置与「丢弃态」生命周期(R4-2)**
- 触发即 `downlink.cut()`,进入会话级 **OverrunDiscard 状态**(属于 `CodexVoiceSession`,不挂在朗读 Promise 上,朗读回执结算后仍存在):该态下每个下行包都换成静音帧。
- **退出条件**:
  ① **恢复播放**只有一种:已见本块绑定回合的 `turn.done` **且**其后下行连续 ≥240 ms 无声(处理「done 先到、尾音后到」)。
  ② **没有 done 就不恢复本代音频**:未见 done 而下行已连续 ≥1.5 s 无声(可能只是话中停顿,不能当作回合结束),**或**进入丢弃态满 **15 s**(绝对期限,不论此刻有声无声)⇒ 走 T7 的换代流程(旧会话 stop + closed 屏障 → 新一代;屏障确认不了就干净结束本场),记 `codex_speech_overrun_forced_restart{reason: silence_without_done|deadline}`。旧代的任何音频都不会再被放行。
- **优先级**:founder 开口 ⇒ T5 的插话静音接管(OverrunDiscard 清除,之后按 T5 的边界规则恢复);换代/关闭 ⇒ 清除。
- **转写处理**:本块被判越界后,「截断标记」保留到对应的 assistant `transcript/done` 被处理完(最长 30 s):持久化与 thread 镜像**截到期望文本为止**并标注「(已截断越界内容)」;越界部分只进审计证据 `codex_speech_overrun{pendingKey, turnId, expectedChars, unalignedChars, extraTextSha256, detectedAtMs, stopLatencyMs}`(长度与指纹,不含正文)。迟到的 final 因此不会走回普通镜像路径。
- 回执 `failed{reason:"speech_overrun", transport:"submitted"}` ⇒ 前端 `unconfirmed`。

**4. 无声与「不知道」分开(R4-3)**
- 统一用**消费**口径:播放器取走的有声包数(T5b 同口径),外加「仍在队列里的有声包」。
- **确认无声**(以下全部成立):本块绑定回合的 `turn.done` 已到;从发出到此刻播放器消费的有声包为 0、队列里也没有有声包;之后再等 600 ms 仍为 0;这段时间里客户端**从未**对下行做过 cut 或静音替换(插话静音、OverrunDiscard 等)。
  ⇒ `speech_silent`,**重试 1 次**(重新走空闲准入;旧回合已 done,迟到事件不会被结算给新尝试,因为新尝试只绑定它发出之后才 created 的回合,且旧回合 id 已登记为已结束)。重试仍确认无声 ⇒ `failed{speech_silent, transport:none}` ⇒ 前端 `failed`,thread 有文字。
- **观察窗口里发生过客户端 cut / 静音替换**:不算「服务端无声」⇒ 按中断/未知结算(`speech_interrupted` 或 `speech_binding_unavailable`),**不重试**。
- **不知道** = 30 s 内没有可绑定的 `turn.created` 或没有 `turn.done`(不论有没有听到声音)⇒ 沿用 T5b 的 `speech_binding_unavailable`,**不自动重试**(可能已经念过,重试会重复);已消费过有声包则 `transport:submitted`,否则 `none`。

**5. 指标与验收口径(R4-4)**
- `stopLatencyMs`(进程内、单调时钟):从越界判定时刻,到播放器消费最后一个**非静音替换**的越界回合音频包的时刻(`OpusDownlink` 消费记录)。每次越界都记。验收:**每次 ≤200 ms**。
- `overrunExposureMs`(房内录音人工标注):从越界内容第一个可听音节,到它最终停下。由 QA 的房内录音 bot 录音 + 转写,人工/离线标注起止,**不从字符数或 `turn.done` 推算**。验收:**每次 ≤1.0 s**,并报告分布。
- 诚实边界:检测跟随转写,转写比声音晚时越界开头会先播出一段;`overrunExposureMs` 就是量这一段。若 QA 实测超 1.0 s,如实报告,交 Lead 决定是否改为「朗读整句转写确认后再放」(显著加延迟,本单不默认采用)。

### T6 上行门:开后追帧 + 句级峰值门(`pipeline/UplinkSpeechGate.ts`、`pipeline/Uplink.ts`、`discord-room.ts`)

两个新选项,只在 `downlink:"opus-passthrough"` 的房间传入,缺省关闭 ⇒ 旧引擎字节级不变:

1. `releaseWhenOpen: true`:链打开后,延迟线里**已有判定**的帧立即放行(不再等满 24 帧);链关闭(连续 100 ms 非人声)后恢复按固定延迟,下一句句首仍有完整 200 ms pre-roll。
2. `minOnsetPeakDbfs: -30`:在链「本该打开」的那一刻,计算延迟线里全部帧(含 pre-roll)的最大帧电平;低于门限则**不打开**,这些帧按静音放行,继续判后续帧(变响再开)。记 `uplink_gate_rejected_quiet{peakDbfs}`。

`Uplink` 发送侧:WebRTC 模式下每拍若抖动队列 >3 帧,本拍多发一帧(每拍最多 2 帧;2884 同策略)。句首积压约 0.5 s 在开口后约 0.5 s 内追平。
仍保留:单说话人、白名单、`setMicOpen`、失败降级 `passthrough`。

### T7 断线换代、收尾、遗留目录(`codex/CodexVoiceContainer.ts` `CodexVoiceConversation`、`CodexVoiceBackend.ts`、`cli.ts` 启动段)

```mermaid
stateDiagram-v2
  [*] --> Opening
  Opening --> Live: sdp 与连通都成功
  Opening --> Closed: 失败·清理后报语音不可用
  Live --> Draining: 腿 lost 或 realtime closed/error(合并为一次)
  Draining --> Reopening: 旧会话 closed 已确认·旧腿已关·下行已 cut
  Draining --> Closed: 5s 内确认不了旧会话关闭
  Reopening --> Live: 新一代 sdp 与连通成功
  Reopening --> Draining: 本次尝试失败或 20s 超时(次数未满)
  Reopening --> Closed: 已换 3 次仍失败
  Live --> Closed: 会话结束或 app-server 退出
  Closed --> [*]
```

- **合并**:腿 `lost`、`thread/realtime/closed`(非本端发起)、`thread/realtime/error` 任一先到即进入 Draining,之后同类信号只记证据,不再触发第二次换代。
- **关闭屏障(R1-4)**:同一 thread 的 error/closed 通知不带 realtime 代号,只能靠顺序。Draining 必须**观察到旧会话的 `thread/realtime/closed`**(本来就已到,或 `thread/realtime/stop` 之后 5 s 内到)才允许开新代;屏障内到达的 closed/error 全部归旧代。
  确认不了(stop 超时且无 closed)⇒ 不复用这个 thread,**干净结束本场**(`realtime_reconnect_unconfirmed`)。
- **尝试归属**:每次 Reopening 持有一个 `AbortController`;新腿从创建起归该尝试,超时/关闭 ⇒ abort ⇒ 关腿;若新 `realtime/start` 已发出则按上面的屏障先 stop 再决定下一次,绝不留下半开的腿或会话。
- 上限:每场最多 3 次换代,退避 0 / 2 / 5 s,每次 20 s;用尽 ⇒ `realtime_reconnect_exhausted`,走已有 `onClosed → finish(failed)`。
- 换代期间上行帧丢弃并 `markInputGap`(这段话归属 unknown,不授权委托);下行先 `cut()` 再静默;在途朗读按 `generation_changed` 结算。
  首次掉线 thread 发一行「📻 语音连接断了,正在重连」,恢复发「📻 已重连」。
- 新一代用**同一份上下文快照**(不重新拉取);实时会话里之前的对话历史不回放(§8)。
- app-server 退出 ⇒ 不重连,直接结束(已有行为)。
- 收尾顺序(幂等):停止写上行 → `downlink.cut()` → `thread/realtime/stop`(等 closed,5 s)→ 腿 `close()` → `process.stop()`(已有 TERM→KILL 与退出确认)→ 删 root → 证据 `codex_voice_container_closed`。
- **遗留目录(R1-5 简化;R2-4 措辞校准)**:本单实验(`evidence/orphan-parent-kill.*`,只覆盖 initialize 之后、无活动 thread 的情形)里,父进程被 `SIGKILL` 后 app-server 1 s 内退出;固定版本源码在 stdin EOF 后启动关停,并有 45 s 的退出兜底(`C156 app-server-transport/src/transport/stdio.rs:125-133,168-180`),正常关停还会先收尾后台任务。WebRTC 腿在我们进程里随之消失 ⇒ **孤儿进程至多存活到这个有界收尾结束,之后只可能遗留临时目录**。
  守护进程在拿到 `voice.lock`(`cli.ts:177-207`)**之后、接受任何会话之前**,扫 `codex-containers/container-*`:锁保证没有别的守护进程,本进程也还没开过容器。
  删除前查一次 `lsof -d cwd -Fn`:有进程的 cwd 落在该目录下(旧子进程仍在收尾)⇒ 不删、记 `codex_voice_stale_root_busy`;`lsof` 不可用或出错 ⇒ **同样保留**并记 `codex_voice_stale_root_unverified`(不能当作确认空闲);确认无人使用才 `rm`(按 lstat 不跟随软链)并记 `codex_voice_stale_root_removed`。不杀任何进程,不需要 PID 接口或 owner 文件。

### T8 上下文装配:prompt + initialItems(teamlead `bridge/voice-session-context.ts`;voice-codex `codex/CodexVoiceContainer.ts`、`codex/RealtimeTransport.ts`)

Lead 已批准(§9②)。服务端实测上限与本地计量见 research R3:`Instructions must not exceed 16384 tokens`(probe-1:17,012 o200k 被拒;probe-2:13,662 通过);`initialItems` 由 Codex 客户端按「字节/4」估计、单条与合计 ≤8,192(`C156 realtime_conversation.rs:104-106,1442-1459`),probe-3 证实 item 里的事实模型能用上。

**Bridge 侧装配(`buildVoiceSessionContext`)**
- `baseInstructions` 不变:头 + 身份 + 边界 + **全部记忆** + 状态 + 会议 + 退出规则,只给 backing thread 的 `thread/start`(那里没有 16k 限制)。
- 新增 `realtime` 块,确定性生成:
  - `prompt` = 头 + 身份 + 只读边界 + 状态快照 + 会议上下文 + 退出规则 + **v3 协议说明** +(若有)「# Selected Lead memory (continued)」里放不进 items 的记忆段。
  - `initialItems` = 记忆文件按 manifest 顺序、按行切段(不在行中间切),每段一条 `{role:"developer", text:"【记忆文件 <relativePath> 第 i/n 段·只读数据】\n<段落>"}`;按顺序装,直到再加一条会使合计超过 32,000 字节(Codex 估计 8,000,留 192 余量)或超过 128 条为止;剩余段按原顺序进 prompt 的 continued 块。单个无法切到 ≤32,000 字节的超长行 ⇒ 整段进 prompt。
  - v3 协议说明:删去 `[BACKEND]` 句(v3 没有此前缀,research R4),改为「追加给你的可朗读内容要逐字念出,不要回答、改写或转交」;加 T5 的被打断规则。其余句子不变。
- 预算(不截断、不摘要):`realtime.prompt` ≤15,500 o200k 且 ≤128 KB;`initialItems` 合计 ≤32,000 字节、≤128 条;`baseInstructions` 沿用现有 128 KB / 32,768 预算。任一超限 ⇒ `context_too_large{block, bytes, estimatedTokens, limits}`(不含内容)。
- **digest 计算顺序(R3-4,无自引用)**:先构造三样**不含头**的正文——`baseBody`(= 今天的 assembled)、`realtimePromptBody`、最终 `initialItems`;再对 canonical JSON `{baseBody, realtimePromptBody, initialItems, leaseBindingDigest, sourceManifest, rosterDigest, sessionId}` 求 `snapshotDigest`(`sourceManifest` = `input.sources.manifest` 原样,不含任何衍生字段如 `snapshotDigest/capturedAt`);最后给两段正文加同一个头 `[voice-context version=2 snapshotDigest=… sessionId=…]` 得到 `baseInstructions` 与 `realtime.prompt`。字节/token 预算对**加头后**的实际发送文本计量。返回的 `manifest` 另加 `version:2`、`snapshotDigest` 等衍生字段(同今天 `:594-603` 的做法)。
- `measurements` 增加 `realtimePrompt{bytes,estimatedTokens}` 与 `initialItems{count,bytes,codexEstimatedTokens}`。
- 路由 `GET /api/voice/sessions/:sessionId/context`(`voice-session-routes.ts:374`)原样返回新形状;只有引擎 B 调它(`cli.ts` 的 `loadContext`),无其他消费者需要兼容。

**容器侧**
- `CodexVoiceContextSnapshot` 改为 `{baseInstructions, realtime:{prompt, initialItems}, snapshotDigest, manifest(version 2), measurements}`;删除 `realtimePrompt` 字段。
- `assertContext` 改写:删去 `realtimePrompt.startsWith(baseInstructions)` 不变量(拆分后必然不成立);改为 ① `baseInstructions` 与 `realtime.prompt` 都以同一 `[voice-context version=2 snapshotDigest=… sessionId=…]` 头开头;② manifest.version=2,且按上面同一顺序(去头 → canonical → SHA-256)复算 digest 与头一致;③ 字节与 token 复核(prompt ≤15,500 / 128 KB,items 字节 ≤32,000、条数 ≤128、每条 `role==="developer"` 且 `text` 为非空字符串);④ 新鲜度检查不变。任何不符 ⇒ `context_invalid`。
- `thread/start.baseInstructions = snapshot.baseInstructions`(不变);`thread/realtime/start.prompt = snapshot.realtime.prompt`、`initialItems = snapshot.realtime.initialItems`(T3 原样透传,每次换代用同一份)。

### T9 声线字段(teamlead `ProjectConfig.ts`、`realtime-voices.ts`、`bridge/voice-session-services.ts`;voice-codex `projection.ts`、`bridge-client.ts`、`cli.ts`)

- `leads[].liveVoice?: LiveV3Voice`,校验失败的错误信息指明合法 9 个值;Bridge 投影新增 `liveVoice: lead.liveVoice ?? "cove"`。
- **旧投影兼容(R1-6)**:voice-codex `parseVoiceProjection` 把 `liveVoice` 当**可选**字段:缺失合法(已存盘的投影、恢复中的会话都没有它);出现则必须是 9 个值之一,否则拒绝。
  缺省 `cove` 只在**引擎 B 消费处**(`cli.ts` 构造容器时)补上;旧引擎不读这个字段;不回退到 `realtimeVoice`。
- **声线映射从哪来(Lead 指令 `f845f720`)**:founder 已选定——raya=`sol`、flywheel-eng-lead=`cove`、flywheel-product-lead=`breeze`、flywheel-cos-lead=`vale`、product-lead=`ember`、ops-lead=`spruce`、joycon-lead=`arbor`、tidal-echo-content-lead=`maple`、sub-lead=`juniper`,其余 8 个缺省 `cove`。
  **运行时唯一来源 = `projects.json` 的 `leads[].liveVoice`**(Bridge 启动时 `loadProjects()` 读入 → 投影 `liveVoice` → 引擎 B)。FLY-2866 在它的 PR 里落的机器可读映射文件**只是写入输入**,运行时不读它;不复用 `realtimeVoice`。
  写入方式沿用 FLY-2866 的受控写(`projects.json.cfglock` + 临时文件 fsync rename + 写前备份 + 写后 `validate-projects`),**由本单实施执行**(Lead 裁定 `54c3646c`:不回 FLY-2866 改;在 T9 里新增一个写 `liveVoice` 的受控写入步骤,以 FLY-2866 的映射文件为输入,不直接运行其写 `realtimeVoice` 的旧脚本)。写入时点不受代码合入顺序限制:现有 `ProjectConfig` 只对 `cosContext` 做未知字段拒绝(`ProjectConfig.ts:768-779`),lead 顶层的 `liveVoice` 在 T9 合入前会被忽略、不会让校验失败;T9 合入并部署后才生效。写入与生效时机:Bridge 只在启动时读配置,生效要等下一次定时部署重启。
  本单 QA 在 529 测试房用测试项目自己的 `projects.json` 配 `liveVoice`,不依赖现网写入。

### T10 配置、启动壳、QA 房(`config.ts`、`scripts/flywheel-voice-wrapper.sh`、`scripts/qa/fly2655-voice-room.mjs`)

- `loadVoiceDaemonConfig`:只有 `backendId === "openai-realtime"` 才要求 `OPENAI_API_KEY`;`codex-realtime` 时 `realtimeApiKey` 为 `null`,并从本进程 `process.env` 删除 `OPENAI_API_KEY`/`CODEX_API_KEY`(第二道防线)。
- 启动壳(R1-7):`.env` 仍整体加载(共享文件,旧引擎要用);**在 exec Node 之前**,若 `FLYWHEEL_VOICE_BACKEND=codex-realtime` 则 `unset OPENAI_API_KEY CODEX_API_KEY`,并改为检查凭据源文件存在且是普通文件(不读内容);其他后端照旧检查并传递 key。
- QA 房启动器:`backendId === "codex-realtime"` 时不读 `~/.flywheel/.env` 的 key、不注入 `OPENAI_API_KEY`,改注入 `FLYWHEEL_VOICE_CODEX_AUTH_SOURCE`。
- 保证的准确说法:**codex 路径不要求、不使用 API key,也不把它传给语音进程及其 Codex 子进程**(共享 `.env` 文件里可以仍有这把 key,供旧引擎用)。

## 4. 失败处置

| 情况 | 行为 | 用户看到 |
|---|---|---|
| 凭据源缺失/形态不对 | 容器拒绝打开 `codex_profile_mismatch` | 📻 语音不可用:Codex 容器启动失败 |
| `account/read` 非 chatgpt / 401 | `codex_auth_rejected` | 📻 语音不可用:Codex 认证失败 |
| 额度耗尽 | `codex_quota_exhausted`,不换引擎 | 📻 语音不可用:Codex 额度已用完 |
| 声线不在 v3 表 | 投影/配置校验先拒;漏网时 `thread/realtime/error` ⇒ 开会话失败 | 语音不可用(原因写证据) |
| 上下文超限 | Bridge `context_too_large` | 语音不可用(同今天) |
| 下行非 960 样本包 | 本代失败 → 换代 | 断续一下或结束 |
| 断线 | T7 换代,最多 3 次 | 状态行 |
| app-server 退出 | 结束本场,清理 | 已有结束提示 |

## 5. 回滚与负向守卫

- 生产默认引擎是旧引擎(`FLYWHEEL_VOICE_BACKEND` 未设),本单只影响显式选 `codex-realtime` 的房(今天只有 QA)。回滚 = revert PR。
- 负向测试:① codex 路径不要求、不使用 `OPENAI_API_KEY`,也不传给语音进程与 Codex 子进程(wrapper 捕获 exec 环境的测试 + config 单测 + 容器 env 单测);② 不拷贝凭据(home 里 `auth.json` 必须是软链);③ 旧引擎 `openai-realtime` 仍要求 key、房间缺省 `pcm-mouth`、门缺省行为字节不变(已有测试全绿);④ 不静默换声线/模型/引擎;⑤ 上下文不截断。

## 6. 测试(只跑改动文件直接相关的)

| 块 | 测试文件 |
|---|---|
| T1 | `voice-codex/src/__tests__/codex-container.test.ts`、`codex-home.test.ts`(软链准入、删 root 不伤源、account 非 chatgpt 拒绝、env 无 key) |
| T2 | 新 `__tests__/webrtc-leg.test.ts`(werift 两个本地 PeerConnection 回环:编码上行、非 960 拒、数据通道容错、lost 判定) |
| T3 | `__tests__/codex-transport.test.ts`、`realtime-transport.test.ts`(先 started 后 sdp 的顺序、started 版本不符即失败、异步 error 失败、outputAudio 出现即 fence、handoff/turn 拦截不变、退休 transport 收不到通知) |
| T4 | 新 `__tests__/opus-downlink.test.ts`(首包同步入流;积压 10/25 包且播放器已取走部分时 `cut()` 后消费不到旧包、随后新首包正常;租约失效停止;idle 重建);`discord-room.test.ts`(缺省 pcm-mouth 不变、opus 模式 `cancelAllSpeech` 走 cut);voice-bridge `discordWiring` 资源工厂单测 |
| T5 | `__tests__/codex-room.test.ts` + 新 `opus-downlink.test.ts`(按实际推给播放器的包序列断言:R2 合成反例从 1800 回放 40/40;R3 反例 16 包间隙 + 35 包回答 ⇒ 按 ≥240 ms 规则回放,不再 0/35;整段回答无合格间隙 ⇒ 2 s 期限放行并记 `boundary_unknown`;2884 s3 时间线夹具;两路事件都缺失走兜底且终会恢复;合格间隙挤出缓冲 ⇒ `head_lost`;回放积压消化;founder 连说 >15 s 保持静音) + **跨层**:回放积压仍在播、网络下行已静音 >600 ms 时 founder 开口 ⇒ `frontendResponseActive` 为真、cut 真被调用、之后旧包消费为 0 |
| T5b | `__tests__/codex-speak.test.ts`(待答轮次:旧回答 done 晚于新用户 delta 到达时不清待答 ⇒ busy;R3 反例(新自然回答音频先到、created 迟到 915 ms、期间 600 ms 安静)不发朗读;短自然回答后长停顿;数据通道缺 assistant 事件 ⇒ 待答不清 ⇒ 10 s 后 `busy_conversation`;准入后用户抢先 ⇒ `speech_preempted`;单块/多块;等价旧转写不被借用;裁剪 ⇒ `playback_trimmed`;插话中断;无 turn ⇒ `speech_binding_unavailable`;换代 ⇒ `generation_changed`);`codex-room.test.ts` 里 Lead 回复朗读的现有用例改到新契约 |
| T5c | `__tests__/codex-speak.test.ts`(越界:R4 反例「2 字替换 + 20 字追加」⇒ 越界;FLY-2866 四个真实越界文本的逐字增量夹具在第 56 字附近触发;1–6 字改写不越界;早于 `turn.created` 的增量被计入;只有 final 无增量时 final 检查仍截断;越界 ⇒ cut、OverrunDiscard 静音、回执 `speech_overrun`、镜像截到期望文本并标注、审计无正文。丢弃态:同一越界回合暂停 >1.5 s 后续说且 done 缺失 ⇒ 不放回任何旧有声包、走强制换代;done 早于尾音 RTP 时尾音仍被静音;15 s 绝对期限 ⇒ 强制换代;丢弃态未退出时下一块朗读不发送、退出后才发送且首个有声包正常消费;确认无声窗口内有过客户端静音 ⇒ 不重试;`speech_binding_unavailable` 已消费/未消费两种 ⇒ 前端 `unconfirmed`/`failed`;done 之后迟到的 final 仍走截断;插话/换代与越界同时发生。无声:确认无声(已 done、零消费、零积压)⇒ 重试 1 次、旧回合迟到事件不结算给新尝试、再次无声 ⇒ `speech_silent`;已播但 created 缺失 ⇒ `speech_binding_unavailable` 不重试;done 先于队列消费不误判无声) |
| T6 | `pipeline/UplinkSpeechGate.test.ts`、`Uplink.test.ts`、`UplinkSpeechGate.preroll.smoke.test.ts`(开后追帧、峰值门;用 2884 s4 远处人声与 s7 founder 帧电平时间线做夹具;旧默认不变) |
| T7 | `__tests__/codex-container.test.ts`(合并多重故障为一次换代;stop 超时无 closed ⇒ 干净结束;屏障内迟到 closed/error 归旧代;ICE/answer 等待中 abort 关腿;上限与退避;收尾顺序;启动清扫 busy/removed 两分支) |
| T8 | teamlead `src/__tests__/voice-session-context.test.ts`(Raya/Honey 规模夹具:builder→container 确定性样例(改任一 prompt 正文或 item ⇒ digest 变、加头不影响计算输入)、拆分确定性、按行切段、items 32,000 字节/128 条边界、prompt 15,500 边界、超长单行进 prompt、超限报错不截断、digest 覆盖 prompt 与 items);voice-codex `codex-container.test.ts`(v2 快照校验通过/各类不符 ⇒ `context_invalid`,同一快照把完整 prompt 与 items 原样传给 `realtime/start`,换代复用同一份);teamlead voice-session-routes 路由形状测试 |
| T9 | teamlead `ProjectConfig` 校验测试、`voice-session-services` 投影测试;voice-codex `projection.test.ts`、`session-state.test.ts`、`recovery.test.ts`(缺 `liveVoice` 的旧投影照常解析与恢复,非法值拒绝) |
| T10 | `config.test.ts`、`scripts/__tests__/fly2655-voice-room.test.mjs`、wrapper 测试(codex 分支 exec 环境无 key,旧引擎分支照旧) |
| 2799 回归 | 回环按来源排除:`voice-codex/src/__tests__/codex-handoff-transcript.test.ts`、teamlead `src/bridge/__tests__/voice-session-poller.test.ts`;句首补音:`UplinkSpeechGate.preroll.smoke.test.ts`、`discord-room.test.ts` pre-roll 用例;首帧即播:新 `opus-downlink.test.ts` 首包用例 |

### QA(529 测试语音房;founder 或替身 bot,沿用 2884 说话人夹具)

- QA-1:启动器不注入 key;`ps eww` 记录两进程是否含 `OPENAI_API_KEY`(只记是/否);替身 5 问 + founder 至少 3 问。
- QA-2:5 次短问,两口径延迟(同 2884 定义)。
- QA-3a(恢复):QA 专用故障开关(`FLYWHEEL_VOICE_QA_FAULTS=1` 时 `SIGUSR2` 关闭当前 WebRTC 腿;生产启动壳从不设置)。判据:证据里恰好一次 Draining→Reopening→Live、当前代号 +1、旧腿已关、会话租约仍有效、紧接着能继续问答;本阶段**不**要求目录为空或会话终态。
- QA-3b(干净结束):对**本场**记录的 app-server 子进程 `kill -9`。判据:本场会话在 Bridge 为终态、本场租约已放、本场 container root 已删、该子进程已退出;守护进程自己的 `voice.lock` 合法保留;进程/目录检查只针对本场 root 与本场子进程,不用全局 `pgrep`。
- QA-3c(收尾):获 Lead 同意结束 QA-3a 那一场后,同样按 QA-3b 判据检查。
- QA-4:≥10 次有效插话(同 2884 规则)。**验收阈值**:① 每次房内旧声音在 founder 开口后 ≤1.0 s 停止(10/10);② 新回答从第一个字起可听(人工对照录音与转写)≥8/10;③ `boundary_unknown` ≤1/10 且 `head_lost` ≤1/10;④ 插话后新回答开始可听的额外延迟(相对无插话时的「说完→开口」)中位数 ≤0.5 s、最大 ≤1.5 s。不达标如实报告、不放宽。另记「先说完旧的」次数(大脑层指标,只报告)。
- QA-5:播放 2884 远处人声 60 s(零误触发);风扇/键盘各 60 s;founder 轻声 3 句全部被听到。
- QA-7(负向,Lead 指令 `0f475441`):用固定的 Lead 回复文本做 ≥20 次朗读(覆盖 cove 与 FLY-2866 里出过问题的 spruce/vale/sol),房内录音 bot 录下全程。判据:① 事后人工听录音确认的所有越界都被检测;② 每次 `stopLatencyMs` ≤200 ms;③ 每次 `overrunExposureMs`(人工标注越界首个可听音节 → 停下)≤1.0 s;④ thread 镜像里没有越界内容、回执为 `unconfirmed`;⑤ 确认无声的块被重试,重试仍无声时回执 `failed` 且 thread 有文字;「不知道」的块不重试。
- QA-6:v3 九个声线各开 5 s 会话说一句,记能否出声(交给 FLY-2866 试听分配用,每个约 5 s 音频额度)。
- 拆房前 ask Lead。

## 7. 实施顺序(chunk)

T10 → T1 → T2 → T3 → T8 → T9 → T4 → T6 → T5 → T5b → T5c → T7 → 单测 → QA。每块一个 commit,`progress` 游标随块更新。

## 8. 已知边界(诚实)

- v3 朗读不保证逐字(research R4):Lead 回复朗读在「已推出有声包但转写不等价」时回执为 `unconfirmed`(T5b),这是模型行为;QA 报逐字率与绑定成功率。
- 插话「停」是本地的;服务端仍约 1.2 s 才判定。插话后新回答的起点只能估计(T5),可能丢句首或漏出一小段旧音,QA 按次统计。
- 朗读越界只能在转写出现后截断,越界开头可能已播出一小段(T5c,`overrunExposureMs` 验收 ≤1.0 s);越界丢弃态最坏靠强制换代收尾,会丢实时会话历史。模型之后是否接着说旧内容归大脑层(本单只加一句协议说明并量)。
- 峰值门余量约 4 dB,基于合成远处人声;真人麦与 Krisp 下需 QA 复核,可配置/可关。
- 数据通道事件不在 Codex 协议面上。静音解除以下行音频为准、事件只作「用户回合证据」之一(另一来源是 app-server 用户转写);朗读回执绑定依赖它,缺失时回执诚实地变 `speech_binding_unavailable`(已消费过有声包 ⇒ `unconfirmed`,否则 `failed`)。
- 换代会丢失实时会话里的对话历史(新会话只带开场上下文);本单不回放历史。

## 9. Lead 裁定记录

- 2026-09-25 问题 `1b96a832`:评审满 3 轮后选 (a)——v4 并入 R3 四条、T5c、声线映射后跑 1 轮限定 R4;T5c 的 HIGH 必须本轮修掉;其余新 HIGH 以下进 §11;QA 统计写成可量阈值。
- 2026-09-25 问题 `54c3646c`:founder 声线映射写入 `liveVoice` 归本单 T9 实施。
- 2026-09-25 问题 `2cb14675`(Lead 已回复):
  ① **同意** 新增 `liveVoice`(9 个 v3 声线枚举,缺省 `cove`),引擎 B 读它,旧引擎继续读 `realtimeVoice`;本单全部先用 `cove`。**试听分配不另开单**,由 Lead 把 FLY-2866 改成试听这 9 个声线。
  ② **同意** 身份/边界/状态/协议留在 prompt(预算 15,500 o200k),记忆放 v3 `initialItems`(developer 角色),都放不下才 `context_too_large`;两个上限与实测数据写入本计划(research R3,§3 T8)。

## 10. 修订轨迹

- v1(2026-09-25):初稿。
- v2(2026-09-25):设计评审 R1(4 HIGH / 4 MEDIUM / 1 LOW)全部接受:
  1. 静音解除改为「用户回合证据 + 下行 200 ms 静音边界」,不再以迟到约 0.9 s 的 `turn.created` 当音频边界;误判也只在静音边界恢复(T5)。
  2. 新增 `OpusDownlink.cut()` 同步清应用队列与播放器资源,接入 `cancelAllSpeech`、换代、租约失效(T4)。
  3. 新增 T5b:v3 朗读回执绑定契约(数据通道 turn id + 未静音有声包 + 无 cut),无法关联时诚实返回 `failed`。
  4. T7 加关闭屏障(观察到旧会话 closed 才开新代,确认不了就结束)、故障合并、尝试 abort;T3 通知路由收口到当前代。
  5. 实测 app-server 在父进程被杀后 1 s 内自退 ⇒ 去掉 owner/PID 方案,改为拿锁后清扫遗留目录 + `lsof` cwd 复核(T7)。
  6. `liveVoice` 在投影里可选,缺省只在引擎 B 消费处补,旧投影恢复不受影响(T9)。
  7. 启动壳在 exec 前 unset key,保证措辞收窄为「不要求、不使用、不传给」(T10、§5)。
  8. QA-3 拆成恢复/干净结束/收尾三段,检查绑定本场 root 与子进程;补 2799 回环排除回归测试、修正 T8 测试路径(§6)。
  9. 更正 v3 顺序为先 started 后 sdp,started 时仍校验版本(T3)。
- v3(2026-09-25):设计评审 R2(新 thread;原 thread 因 15:38–16:44 PDT 共享 Codex 登录故障不可用)3 HIGH / 1 LOW 全部接受:
  1. T5 改为「静音 + 1.5 s 有界回放缓冲」,边界取 cut 后最长的 ≥400 ms 下行静音段;证据迟到时从该段之后回放保住句首(额外延迟 ≤1.5 s,挤出缓冲则记 `head_lost`),回放积压在下一段静音里消化;不再把低能量间隙称作句间停顿。复算 2884 s6:`turn.start_ms` 与有声起点偏差 770–930 ms 且不恒定,故不用它逐包划分。
  2. T5b 增加「空闲准入」:无未结束 assistant 回合、600 ms 无有声下行、founder 未说话且无待答用户回合时才发朗读,否则等待 ≤10 s 后 `busy_conversation`;绑定、播放证明、裁剪、抢占的结算逐条写明。
  3. 恢复 v2 误删的 T8,并补全端到端契约:Bridge 快照 v2 字段、digest/measurements、容器 `assertContext` 改写(去掉 startsWith 不变量)、`realtime/start` 透传与测试。
  4. 遗留目录一节改为引用源码的 EOF 退出兜底(45 s),实验只作 initialize 场景证据;`lsof` 失败也保留目录。
- v4(2026-09-25):设计评审 R3(3 HIGH / 1 MEDIUM)全部接受 + Lead 指令 `0f475441`:
  1. T5 合格间隙降到 ≥240 ms(按 2884 s3 真实切换处 15/19 包),WaitGap 加 2 s 期限,到期实时放行并记 `boundary_unknown`;所有路径都有终点;保证措辞收窄为「估计」。
  2. 新增 `OpusDownlink.audible()`(未消费有声包或 300 ms 内播过),`response-active` 与朗读准入都以它为准;补跨层测试。
  3. T5b 引入「待答用户轮次」:只有证据之后才 created 且已 done 的 assistant 回合能清除;旧回答迟到的 done 不算;数据通道证明不了就 busy。
  4. T8 digest 先 hash 无头正文再加头,明确排除衍生 manifest 字段。
  5. 新增 T5c(Lead 指令):朗读越界边播边比、越界即 cut + 审计 + 镜像截断;无声重试 1 次;QA-7 负向用例(越界后已播 ≤1.0 s)。
  6. T9 并入 founder 选定的声线映射(Lead 指令 `f845f720`),写明运行时唯一来源 = `projects.json` `leads[].liveVoice`,FLY-2866 映射文件只作受控写入的输入。
  7. QA-4 改成可量阈值(Lead 裁定 `1b96a832`)。
- v5(2026-09-25):限定 R4 通过 R3 四条与 T9 映射;T5c 的 3 HIGH / 1 MEDIUM 按 Lead 裁定本轮修掉:
  1. 越界改为 LCS 对齐计量「未对齐字数 ≥8」,不再依赖「先覆盖全文」;检测输入只用 app-server assistant 转写,从发出起累积(含 created 前的前缀),final 到达时再检一次后才持久化/镜像。
  2. 新增会话级 OverrunDiscard 态:done + 240 ms 静音 / 无 done 时 1.5 s 静音 / 15 s 上限强制换代三种退出;插话、换代优先;截断标记保留到对应 final 处理完。
  3. 「确认无声」(已 done、零消费、零积压)才重试 1 次;绑定或完成状态未知一律 `speech_binding_unavailable` 不重试;统一消费口径。
  4. 指标拆成 `stopLatencyMs`(进程内,≤200 ms)与 `overrunExposureMs`(房内录音人工标注,≤1.0 s),QA-7 按两项判定。
- v6(2026-09-25):限定 R5 关闭 R4-1/3/4;T5c 余 2 HIGH + 1 LOW 全部修正:
  1. OverrunDiscard 只在「已见 done 且其后 ≥240 ms 静音」时恢复播放;无 done 时 1.5 s 静音或 15 s 绝对期限一律走 T7 换代,旧代音频不再放行。
  2. T5b 准入加第⑤条「不在 OverrunDiscard」,无声重试同样过准入;「确认无声」要求观察窗口内没有任何客户端静音/cut。
  3. 统一 `speech_binding_unavailable` 的 transport 口径(按消费,已播 ⇒ unconfirmed,未播 ⇒ failed)。另记 Lead 裁定 `54c3646c`:声线映射写入归本单 T9。
- R6(2026-09-25,thread `01a0daf5-f9f0-77b2-bc4e-ae18c8f1dfb5`):**APPROVED**。R5-1/2/3 全部关闭,无新 HIGH 以上。
- v6.1:按 R6 唯一的 LOW 把 T5c「确认无声」与「期间有客户端静音」拆成两条独立分支(纯文字,状态机与判据不变)。

## 11. Follow-ups(R4 之后按 Lead 裁定 `1b96a832` 登记,由 Lead 开单)

- R4–R6 未发现范围外问题。
- R5 LOW(`speech_binding_unavailable` 口径不一)与 R6 LOW(无声分支文字连写)已分别在 v6 / v6.1 直接修正,无需开单。
- (写 `liveVoice` 的受控写入按 Lead 裁定 `54c3646c` 归本单 T9 实施,不是 follow-up。)

## 12. T8 修订（probe4 / probe7 实测）

Lead 裁定 `0ee0c065`（2026-09-25）：只追加本节，不重写全案；外部 Codex 只复核本节。**本节收紧 §3 T8 的 `initialItems` 预算，并补上 T8 的分段规则、上下文错误的 HTTP 传播和测试**。原 T8 的数字（合计 ≤32,000 字节、≤128 条，prompt ≤15,500 o200k / 128 KB）全部保留、继续生效；本节在它们之上再加一道真实 token 上限。

修订 r2（Lead 指令 `564f9436`，§12 复核 `d13bfbb89` 的 1 HIGH + 2 MEDIUM）：
- 12.1、12.3 补了多条目实测（probe7），并按实测校准每条包装余量；
- 12.3 收窄了保证的范围，新增 12.6 重验条件；
- 新增 12.4 分段规则；
- 12.5 补了 HTTP 错误传播契约；
- 12.7 测试相应扩充。

### 12.1 实测依据

- 证据：`evidence/probe4-initialitems-summary.md`（commit `e1bd108b2`、`df76230ef`，r2 的探针 7 一节随本次提交），台架 `evidence/probe4.mjs`，条目生成器 `evidence/probe7-gen-items.mjs`，41 场日志 `evidence/probe-run{4,5,6,7}-*.jsonl`。环境同 research：固定 0.156.1、v3、WebRTC、gpt-live-1-codex、订阅、无 key。
- developer 角色**被接受**：41 场零 `thread/realtime/error`、零提前 `closed`。未超限时条目里的事实被用上 16/16：1、3、16、128 条，事实放在首、中、尾条，文本混合中英文、数字和编号。
- **服务端有一道不报错的上限**，超过后条目**整体**看不到，与事实放在哪一条、用哪个角色无关，也没有任何错误事件：
  - 3 条：内容 7,951 token 能用上，8,251 就看不到了（0/20 场）；
  - 128 条：内容 7,267 能用上，7,580 就看不到了（0/3 场）。
- **每条包装开销**：把服务端计数设为「内容 + w·条数」，上面两组边界给出 125·w ∈ (371, 984)，即 **w ∈ (2.97, 7.87) token/条**。
- Codex 客户端只按「字节/4」估算（上限 8,192）。中文每 token 约 3.4 字节，这道检查拦不住（失败组在它的估算里只有 5,897–7,610）。
- 结论：原 T8 的「≤32,000 字节」在中文记忆上会让大记忆的 Lead **静默丢掉全部记忆**，必须按真实 o200k 计数，并计入每条的包装开销。

### 12.2 计数方法

- 实现：`js-tiktoken`，**精确钉在 1.0.21**，编码 `o200k_base`。这是 Bridge 已经在用的计数器（`VOICE_CONTEXT_TOKENIZER = "js-tiktoken@1.0.21/o200k_base"`）。rank 表随 npm 包打包，`getEncoding("o200k_base")` 不联网。
- Bridge 与 container 用**同一实现、同一版本**：voice-codex 新增依赖 `js-tiktoken: 1.0.21`（同一个 lockfile 条目）。container 的 `assertContext` 先核 `manifest.tokenizer === "js-tiktoken@1.0.21/o200k_base"`，不一致就 `context_invalid`；再对每条 item 重新计数，与快照 `measurements.initialItems` 逐项比对。同一计数器只能证明两侧一致；这个口径和服务端之间的关系，由 12.3 的实测和 12.6 的重验来保证。
- 计数口径：`itemsTokens = Σ o200k(item.text) + 8 × 条数`。每条 +8 是包装开销的上界，依据是 12.1 的 w < 7.87。
- **计数失败即 fail-closed**：编码器加载失败或 `encode` 抛错时，Bridge 报新错误码 `context_token_count_unavailable`，container 报 `context_invalid`。**任何一侧都不许退回只按字节限额。**

### 12.3 上限 7,600 与余量

- `initialItems` 同时满足三条才算放得下：`itemsTokens ≤ 7,600`；≤32,000 字节（Codex 估算 ≤8,000）；≤128 条。
- 余量（以 12.1 的实测为准，不依赖对服务端实现的假设）：
  - 128 条时，规则最多装 6,576 个内容 token，比同条数实测能用上的 7,267 **低 691**；
  - 16 条时，规则最多装 7,472，实测 7,471 能用上；
  - 按 12.1 的线性包装模型，任意条数下规则允许的最大值都比「一定能用上」的下界低至少约 **375**。
- 这个余量也覆盖分词器版本在两侧的小幅偏差。
- **保证的范围**：以上只对**已实测的组合**成立——固定二进制 0.156.1（sha256 `0196e89f…255a`）、模型 `gpt-live-1-codex`、v3、WebRTC，以及 probe4/7 期间的服务端行为。服务端上限或计数方式变了，本地计数无法察觉；12.6 规定何时必须重验，重验未过不得上线。

### 12.4 分段规则（T8「按行切段」的具体化）

- 每个记忆文件按 manifest 顺序、**只在行边界**切段。一段连同标题（`【记忆文件 <relativePath> 第 i/n 段·只读数据】\n`）和 +8 包装，必须同时满足：
  - **≤ 2,000 o200k**：保证至少 3 段能进 items，头一段大也不会挤掉整份记忆；
  - **≤ 8,000 字节**：远低于 Codex 单条 8,192 的估算上限。
  逐行累加，再加一行会超出任一条件就收段。n 在切完后确定，标题里的 i/n 对切段结果没有影响：切段时按 n 取最大可能位数预留标题长度。
- 单行本身就超过 2,000 token 或 8,000 字节的，自成一段，标记为「只能进 prompt」。
- 装配：按顺序把段装进 items，直到下一段会使 `itemsTokens`、字节或条数任一超限，或者下一段是「只能进 prompt」的超长行为止。之后的全部段**按原顺序**进 prompt 的「# Selected Lead memory (continued)」块，保证记忆不乱序、不重复、不缺失。
- 容量复核（research R3 的 Raya 数字）：Raya 记忆约 11,991 o200k。按 ≤2,000 token 切段后，items 装到 ≤7,600，其余约 4,400 回填进 prompt。prompt 约为身份 3,634 + 状态/会议/边界/协议约 2,000 + 4,400 ≈ 10,000，低于 15,500。Honey Lemon 记忆 6,492，全部进 items。§12 复核里构造的 12,000-token 多行夹具，按新规则可以装配成功，见 12.7。

### 12.5 溢出回填、双超与错误传播

1. 放不进 items 的段依次回填 prompt（12.4）。
2. 回填后按原 T8 预算复核 prompt：≤15,500 o200k 且 ≤128 KB，按加头后的实际发送文本计。
3. **双超**（items 已按 12.3/12.4 装满，回填后 prompt 仍超）：**不截断、不摘要、不丢任何一段**，整场不开，并明示原因。
4. **HTTP 错误契约**。今天的路由只返回 `{error, reason}`，客户端在非 2xx 时丢弃正文，container 只看到笼统的开会话失败。本节规定：
   - **Bridge 路由**（`GET /api/voice/sessions/:sessionId/context`）：`VoiceSessionContextError` 返回 503，正文为 `{error:"voice_unavailable", reason, details}`。`details` 只取白名单字段，且只收数字或短 ASCII 标识：`block`、`bytes`、`estimatedTokens`、`itemsTokens`、`itemsCount`、`maxBytes`、`maxEstimatedTokens`、`maxItemsTokens`、`tokenizer`。任何正文、路径、文件内容都不返回。
   - **voice-codex 客户端**：非 2xx 时解析 JSON 正文。`reason` 是已知上下文错误码（`context_too_large`、`context_token_count_unavailable`、`context_stale`、`context_source_unresolved`、`context_state_unavailable`）时，把 `reason` 和按同一白名单过滤后的 `details` 挂在 `BridgeVoiceHttpError` 上；未知形状照旧，只有状态码。
   - **container**：`loadContext` 失败且带 `reason=context_too_large` 时报 `CodexVoiceContainerError("context_too_large")`；带 `context_token_count_unavailable` 时报 `context_invalid`。证据 `codex_voice_container_open_failed` 带 `reason` 和白名单 `details`。
   - **前端提示**（`CodexRoomFrontend.unavailableCopy`）：
     - `context_too_large` →「📻 语音不可用：这位 Lead 的记忆与上下文超出语音会话上限」；
     - `context_invalid` →「📻 语音不可用：上下文无法核对大小」。
     两句都发在 Lead 自己频道的语音 thread 里，founder 和 Lead 都能看到。Bridge 另 `console.warn` 一行同样的白名单字段。
5. 在 12.3 的保证范围内，一段记忆只有三种去处：在 items 里（计数证明 ≤7,600）；在 prompt 里（计数证明 ≤15,500）；或者整场不开并明示原因。

### 12.6 重验条件

以下任一发生，**上线前必须在新环境里重验**：
- `CODEX_VOICE_BINARY_VERSION` 或 sha256 变了（升级 Codex）；
- `CODEX_VOICE_REALTIME_MODEL`、`version`、`transport` 变了；
- 新增或替换条目的包装格式（标题、角色）；
- QA 或 founder 报告模型答不出记忆里的事实。本单 QA-1 加一问：取 items 中间一段里的一条事实，要求答对。

重验矩阵全部在新环境里现测。**不得沿用旧探针（probe6/probe7）的任何边界**，因为服务端或版本一变，旧边界就不能约束新的 w。

1. **3 条的成败边界**：用 `probe7-gen-items.mjs` 生成 3 条，逐步提高内容 token（步长 ≤300），找到相邻的「能用上 / 用不上」一对，记为 C3 通过、C3′ 失败。
2. **128 条的成败边界**：同样方法，得到 C128 通过、C128′ 失败。
3. **推导 w 与 L 的界**：服务端计数 = 内容 + w·条数，上限为 L。由 C3 ≤ L − 3w < C3′ 和 C128 ≤ L − 128w < C128′ 得：
   - w 的上界 **w_max = (C3′ − C128) / 125**，下界 **w_min = (C3 − C128′) / 125**；
   - L 的下界 **L_min = C3 + 3·w_min**（由 L ≥ C3 + 3w 且 w > w_min）。用 128 条那组导出的下界 C128 + 128·w_min 恒比它小 (C128′ − C128)，所以取 3 条这组。
4. **贴近上限的回归**：16 条和 128 条各一组，本地计数 Σtok + 8·条数 贴近 7,600，事实分别放首条和尾条，必须全部答对。

判据：
- 同时满足以下三条，才可上线，且当前的 +8/条和 7,600 继续有效：
  - **w_max < 8**；
  - **L_min ≥ 7,600**；
  - 规则允许的最大内容（128 条时为 7,600 − 8·128 = 6,576）**低于新测到的 C128**。
- **为什么这三条覆盖全部允许条数**：
  - 规则对 N 条（1 ≤ N ≤ 128）最多放行内容 7,600 − 8N。服务端计数为 7,600 − 8N + wN = 7,600 − (8 − w)·N。
  - 由 w < w_max < 8，这个值对每个 N 都 < 7,600；又有 7,600 ≤ L_min < L，所以规则放行的任何上下文都在服务端上限之内。
  - 只证 w < 8 不够，还必须证 L ≥ 7,600。复核给的反例是 w≈1、L=7,500：w_max≈1.008，但 L_min≈7,500，被这一条拦下。
  - 步长越粗，通过点（C3、C128）越低、失败点（C3′、C128′）越高：w_max 只会变大，L_min 只会变小，两者都更保守，不会误放。
- 对照：当前固定环境（12.1 的 probe6/probe7 边界 C3=7,951、C3′=8,251、C128=7,267、C128′=7,580）三条都满足：w ∈ (2.968, 7.872)，L_min ≈ 7,959.9 ≥ 7,600，6,576 < 7,267。这一行只用来说明判据的算法，不能替代新环境里的重测。
- 任一不满足，或者任一边界测不出来（例如找不到失败点、结果不一致），就**保持禁止上线（fail-closed）**：不部署新的二进制或模型，或者不启用新的包装格式。之后按新数据改 +8 或 7,600，或者收紧条数上限，再复核本节。
- 重验结果连同全部会话日志写进 `evidence/`，并在对应 PR 里引用。

### 12.7 测试（并入 §6 的 T8 行）

teamlead `voice-session-context.test.ts`：
- **边界**：记忆恰好 `itemsTokens = 7,600` 时全部进 items；多出一段就回填 prompt；「字节未超、token 超」的中文夹具证明 token 这一条在起作用。
- **分段**：每段 ≤2,000 token 且 ≤8,000 字节，只在行边界切；12,000-token 多行夹具（§12 复核的反例）装配成功，items ≤7,600，其余按序进 prompt，prompt ≤15,500；超长单行自成一段进 prompt，其后的段也按序进 prompt。
- **溢出回填**：Raya 规模夹具。所有记忆段在 items 与 prompt 里恰好各出现一次，不重复、不缺失、不乱序。
- **双超**：回填后 prompt > 15,500，抛 `context_too_large`，带白名单 details，不带正文，不返回任何被截断的快照。
- **计数器不可用**：注入抛错的 `countTokens`，抛 `context_token_count_unavailable`，不产生只按字节放行的快照。

teamlead `voice-session-routes.test.ts`：两类错误返回 503 + `{reason, details}`，`details` 只有白名单字段，正文里没有任何记忆内容。

voice-codex：
- `bridge-client.test.ts`：**真实 HTTP**（本地 http server）返回上面两类 503 正文。客户端的 `BridgeVoiceHttpError` 带 `reason` 和过滤后的 `details`；多余字段被丢弃；非 JSON 正文只保留状态码。
- `codex-container.test.ts`：`loadContext` 以上面的错误失败时，分别报 `context_too_large` / `context_invalid`，且不 spawn 进程。`manifest.tokenizer` 不一致、item 复算 token 不符或超过 7,600、计数器抛错，也都报 `context_invalid`，且不 spawn 进程。
- `codex-room.test.ts`：两类原因走到前端提示回调，文案正确，且不含任何上下文正文。

原 §6 的 T8 用例（按字节和条数的边界等）照旧保留。

## 13. founder 朗读返工（2026-09-26，Lead 打回 `rework:48e91c59`）

founder 原话（FLY-2885 thread，09:24 PDT）：「越界保护是什么东西？你可以修，你可以先修一下。」证据：真人会话 `1043b4a4`（`~/.flywheel/artifacts/FLY-2885-qa/founder-live/readback-evidence.json`）。Lead 回了两句，语音只念了第一句：第一块越界被截断；后两块各等 10 s 准入（`busy=assistant_turn_open`，她一直在和模型对话）后被拒，`phase=failed`，没有任何提示。**只改朗读这条路径**，其余行为不动。

### 13.1 结构

引擎 B 把整条 Lead 回复一次交给说话者，由它负责读完：`daemon.deliverOutbound → GenericVoiceSession.speakReply → CodexRoomFrontend.appendReply → CodexVoiceSession.readReply → CodexProofSpeaker.readReply`。切块与以前相同（`prepareReplySpeech`，80 字）。引擎 A 的前端没有 `appendReply`，daemon 仍按块逐个 `speak`，行为不变。非朗读类（`cue` 提示等）也仍走原来的逐块、首错即停、10 s 准入。

### 13.2 A：越界后从下一个没念的句子接着念

- 越界时，按句（`。！？!?；;\n`）把本块切开，**按顺序**逐句对齐转写：每句只在上一句结束处之后找一段连续转写，缺字和多字都不超过容差（`min(6, ⌊len/4⌋)`，与越界守卫的 1–6 字改写同口径）才算念过；第一句没对上就停，后面的句子即使有相同措辞也不算（评审 R1）。
- 从最后一个念过的句子之后接着念；本块都念过了就进下一块。已念过的不再重复。
- 镜像（thread / 持久化）只保留实际念过的句子，后面标「（已截断越界内容）」。
- 越界若是在增量上判出的，这一块仍欠一条 app-server final（评审 R1）：它挡住续读和下一块（等它最多 30 s，期间算进展，不触发「安静 8 s」），到达时只接走截断标记、不再检查；截断标记只贴在这一块自己的 final 上。她插话或出现新回合都不丢这条登记——越界回合在前，它的 final 也一定先到；只有过期、换代或关闭才丢，标记随之作废。
- 本块一句都没念到：同一段重念一次；再一次仍没进展，就停下，计为未读（走 C）。

### 13.3 B：等她说完、等轮次结束再念，上限按时间

- 每块发送前等对话出现停顿，准入条件仍是 T5b 的五条。
- 放弃条件按时间，不按次数：
  - 房间已安静 **8 s**（没人说话、没有可听下行、没有插话静音或越界丢弃态），却仍然不能准入。这时忙碌状态是卡住了，不是在对话。
  - 或者一共等满 **120 s**。
- 等待期间不占用说话者：`cue` 提示可以先说，说完再轮到回复。回复到达时正在说 `cue`，也是排队，不会被拒。
- 换代重连（T7）期间继续等，接到新一代后在新一代上念。
- 证据 `codex_speech_admission_timeout` 增加 `limit: quiet|ceiling`、`waitedMs` 和 `quietMs`。

### 13.4 C：真的念不了，要说一句

- 以下情况停下，把剩下的块计为未读：
  - 等不到停顿；
  - 她插话打断了朗读，或朗读刚发出就被她抢先；
  - 两次确认无声；
  - 传输失败；
  - 在途块遇到换代；
  - 会话关闭。
- 念过、只是没证明的块（改写不等价、回放被裁剪、绑定不上但已播放），照旧进下一块，和原来的逐块循环一致。
- 有未读时：
  - 先说「剩下的内容在频道里。」，按 B 的规则等停顿，最长 30 s；
  - 这句没有完整念完（包括只播出一个包就被打断），或者会话已在关闭，就在 thread 发「📻 剩下的内容在频道里」（评审 R1）。
- 证据 `codex_readback_unfinished{pendingKey, reason, unreadChunks}`。

### 13.5 Handoff ID 关联行不念（Lead 答复 `7bec9fc5`）

Lead 按 hook 要求附上的「关联 Handoff ID：<uuid>」只在朗读投影里去掉。规则只匹配整行：`(关联)? Handoff ID [:：] <uuid>`。thread 文字不变，正文里带 ID 的句子不受影响。

### 13.6 D：先红后绿

- `codex-readback-replay.test.ts`：用 `fixtures/fly2885-founder-readback-1043b4a4.json` 走生产路径回放。只模拟了 provider 事件和房间播放器；daemon → session → 前端 → 后端 → 说话者 → OpusDownlink 都是真实代码。
- 修复前，回放逐项复现了证据：越界 27/9 字、4266 ms；丢弃态 4974 ms（录制值 4994）；两次 `assistant_turn_open` 准入超时；只发出第一句。修复后两句都发出，第二句在她那轮问答结束后发出。
- 第二个回放：她连续说 32 s，回复一直排队，等她那一轮结束后念出。修复前这条在 10 s 时被丢。
