# FLY-2074 Raya 实时语音流水线正经重写 — 调研
Issue: FLY-2074 (https://linear.app/geoforge3d/issue/FLY-2074/raya语音通道-实时语音流水线按-prd-正经重写常开连接音频流断流重连语义原型权宜不带-自-fly-2029-拆出)
日期: 2026-08-26
基于: exploration.md

> 本文只记**技术事实**与**方案对比**。每条事实标出处与成色:✅ 实测/源码逐行核过 · 📖 库文档 · ⚠️ 读到但未量 · ⬜ 未验。
> 文末「会过期的结论」表逐条给 as-of + 重核命令。

## 1. Codex app-server realtime 协议(v2 路)

### 1.1 进程与握手

| 事实 | 出处 | 成色 |
|---|---|---|
| 起法:`codex --enable realtime_conversation app-server`,stdio 上跑 JSON-RPC 2.0(一行一条) | `bridge-hl.mjs:187` | ✅ |
| 握手:`initialize {clientInfo, capabilities:{experimentalApi:true}}` → 通知 `initialized` → `thread/start {baseInstructions?, sandbox?, approvalPolicy?, model?, config?, cwd?...}` → `thread.id` | `bridge-hl.mjs:735–905`;schema `ThreadStartParams` | ✅ |
| `thread/resume {threadId, baseInstructions?, model?, config?...}` 存在,但 C0 P2 已证 realtime thread 不产 rollout,跨进程稳定 `no rollout found` | schema + §7.4 | ✅(当前 realtime 不可用) |
| `thread/fork`、`turn/interrupt {threadId, turnId}`、`turn/steer` 存在 | schema | 📖 |
| `realtime_conversation` 在 0.149.1 仍是 `under development / false`;`codex --help` 无 voice 子命令 | `codex features list` 2026-08-25 | ✅ |
| **schema(`generate-json-schema`)只导出 realtime 的 8 条通知,不导出 `thread/realtime/start / appendAudio / appendSpeech` 请求定义** | 0.149.1 导出 41 个文件 grep | ✅ ⇒ 请求形状的唯一来源是 PoC 实测 + `realtime_conversation.rs` |
| 客户端名可以自己编(`fly1911-v3full`),服务端不校验 | B §3.1c | ✅ |

### 1.2 realtime 请求(PoC 实测形状,0.148.0;FLY-2021 证 v2 在 0.149.1 也通)

```jsonc
// 建会话(v2)
{"method":"thread/realtime/start","params":{
  "threadId":"…",
  "transport":{"type":"websocket"},          // v3 是 {"type":"webrtc","sdp":"…"}
  "outputModality":"audio",                  // enum text|audio
  "voice":"marin",                           // enum 19 个;⚠️ v2 表 ≠ v3 表,配错【不报错、会话根本不建】(1911 坑 3)
  "version":"v2",                            // enum v1|v2|v3
  "realtimeStartInstructions":"…"            // 逐字通道,上限 8,192(B §12.1,产品侧读源码)
  // v3 才有:"delegationAckFiller":bool, "codexResponseHandoffMode":"thinking"
}}
// 上行音频,每 20ms 一帧
{"method":"thread/realtime/appendAudio","params":{"threadId":"…",
  "audio":{"data":"<base64 s16le>","sampleRate":24000,"numChannels":1,"samplesPerChannel":480}}}
// 文字触发(只有 v2 有;v3 无 response.create)
{"method":"thread/realtime/appendSpeech","params":{"threadId":"…","text":"我上线了…"}}
```

| 事实 | 出处 | 成色 |
|---|---|---|
| 上行 24 kHz 单声道 s16le,每帧 480 samples = 960 bytes;桥**无条件**每 20ms 送一帧,队列空则送全零 | `bridge-hl.mjs:1287–1309`;`bridge2.mjs:456–461` | ✅ 逐行核 |
| **没有** `thread/realtime/stop` / `pause` / `resume` 请求;PoC 结束会话 = `cx.stdin.end()` 杀进程 | schema 全量 method 清单;`bridge-hl.mjs:1443` | ✅ ⇒ 「只收会话不杀进程」**没有 API**(影响 exploration Q1/Q2) |
| 服务端动作清单里有 `input_audio.pause/resume`,CLI 二进制未实现 | C §16.4 | ✅ |
| 审批请求可作为 JSON-RPC request 到客户端;但 Raya 合同 `approvalPolicy:"never"`,本单不留审批 seam,若仍收到则 protocol violation | schema;`@raya/contracts` session builder | ✅ 合同 |

### 1.3 realtime 通知(schema 0.149.1 导出,与 PoC 一致)

| 通知 | payload | 用途 |
|---|---|---|
| `thread/realtime/started` | `{threadId, version, realtimeSessionId?}` | 会话锚(`realtimeStartedAt`) |
| `thread/realtime/closed` | `{threadId, reason?}` | reason=`requested` 是我们要求的;其余 = 死了 |
| `thread/realtime/error` | `{threadId, message}` | 握手失败等 |
| `thread/realtime/outputAudio/delta` | `{threadId, audio:{data(base64), sampleRate, numChannels, samplesPerChannel?, itemId?}}` | 下行音频;**chunk 自带采样率**,⛔ 不要假定 24k(PoC 假定了) |
| `thread/realtime/transcript/delta` / `done` | `{threadId, role, delta|text}` | 双方转写(状态面字幕) |
| `thread/realtime/itemAdded` | `{threadId, item}`(`handoff_request` 等) | 交办事件 |
| `thread/realtime/sdp` | `{threadId, sdp}` | 仅 v3 |

其它有用的通知:`item/started|completed`(`commandExecution` / `reasoning` / `agentMessage{phase: commentary|final_answer}`)= **「它在忙」的信号源**;`thread/tokenUsage/updated {threadId, turnId, tokenUsage:{total, last, modelContextWindow}}` = **三指标 ③ 的候选信号**;`account/rateLimits/updated`。

`thread/tokenUsage/updated` 的语义已由 C0 分层实测:纯 realtime 音频回复没有 backend `turn/*`,10 分钟内 usage 0 次,这是 **not applicable**;P5 强制委托 backend Codex 后出现 4 次 usage 通知,含 `total/last/modelContextWindow`,可由 `parseContextUsage` 消费。只有 backend `turn/completed` 后仍缺同 turn usage 才标 `metrics_unavailable`(§7.5–7.6)。
另:`thread/unsubscribe {threadId}` 的返回是 `notLoaded | notSubscribed | unsubscribed` —— 它只是退订通知,**不是**关闭 realtime 的手段(Codex R1-2 核出)。

### 1.4 上下文进入语音侧的两条通道(B §12.1 / 1911 坑 ⑫)

```
thread 里塞的(baseInstructions 等)      → 语音侧只拿到【有预算的摘要】(5,300 tokens)
realtimeStartInstructions               → 【逐字】,上限 8,192,超了直接报错
```
⇒ 要让语音侧可靠知道的东西必须走逐字通道 —— **这条通道每次 `realtime/start` 才能喂一次**。二次进房若不重建会话,就没有逐字通道可用,只能靠 `appendSpeech`(文字触发,它会当成「她说的」)—— ⚠️ 语义不同,归 2030 决定用哪条。

### 1.5 版本与上游状态

| 事实 | 出处 |
|---|---|
| PoC 用 0.148.0(硬编码);PATH 上是 0.149.1;两者 v2 都通 | FLY-2021 证伪矩阵 |
| 0.150.0-alpha.7 上 v2 报 `AVAS requires v1 or v3` —— **alpha 已弃 v2** | FLY-2021 ✅ |
| v3 在 0.148/0.149.1/0.150-alpha 逐字同错 `session.model is not allowed` | FLY-2021 ✅ |
| realtime 烧的是**平台预付余额**,不是订阅额度;余额 $0 时 codex 把 `insufficient_quota` 吞成「Connection closed normally」 | 1911 坑 ⑮ ✅ |

⇒ 两条设计约束:① Raya **自己钉 codex 二进制版本**(`RAYA_CODEX_BIN`),升版前跑协议探针;② `closed` 的 reason 不可信,**余额检查要独立做**(`account/rateLimits/read` 里 `credits` / `rateLimitReachedType`)。

## 2. Discord 语音腿(`@discordjs/voice` 0.19.2 + discord.js 14.x)

### 2.1 连接与重连

| 事实 | 出处 | 成色 |
|---|---|---|
| `VoiceConnectionStatus`:`Signalling → Connecting → Ready`;断开进 `Disconnected`(带 `reason`:WebSocketClose(closeCode)/ AdapterUnavailable / EndpointRemoved / Manual);`destroy()` 后 `Destroyed` 不可恢复 | 📖 Context7 | 📖 |
| `Disconnected(WebSocketClose, code 4014)` = 被踢/被移频道/频道删除;库不会自动 rejoin,要自己 `rejoin()` | 📖 库指南(经验) | 📖 |
| `rejoin(joinConfig?)` 返回 boolean;`disconnect()` 是可 rejoin 的临时断开 | 📖 | 📖 |
| 库自身的 resume 在 Disconnected 后会短暂经过 Signalling/Connecting;**可能停在那里不回 Ready**(Codex R15) | voice-bridge `VoiceConnSupervisor.ts` | ✅ 生产同款 |
| `VoiceConnSupervisor`(flywheel 内)已实现:任何非 Ready 状态 → settle 5s → `rejoin()` 上限 3 次 → `onFatal` 大声失败;`error` 事件必须监听(未处理的 `error` 会杀进程) | `packages/voice-bridge/src/audio/VoiceConnSupervisor.ts` | ✅ **模式可抄,代码不可 import(§8.5)** |
| Node **v25** 上 IP-discovery 曾在 Ready 之后异步报错导致 bot 静默离房(Annie 真机) | 同上文件头 | ✅ 本机现在就是 v25.6.1 |
| 进房 701 ms;`entersState(conn, Ready, 25s)` | 1911 D1 | ✅ |
| DAVE(E2EE):0.19.x 需 `@snazzah/davey`;PoC 没装也能进房(频道未强制) | voice-bridge deps;PoC package.json | ⚠️ Discord 在逐步强制,**生产要装** |

### 2.2 播放(下行)

| 事实 | 出处 | 成色 |
|---|---|---|
| `AudioPlayer` 按精确 50 帧/秒拉 Opus 帧;资源流拿不到帧计 `missedFrames`(连续计数);**默认 `maxMissedFrames: 5`**,超过 → 资源被停 → `Idle` | 库源码 `maxMissedFrames: 5`;📖 | ✅ 源码 |
| `Idle` 后**不再消费**流 ⇒ 之后写多少都进不了房(§3.1d 的下行那半) | 1911 B1 | ✅ |
| `NoSubscriberBehavior` 默认 Pause:没有 VoiceConnection 订阅时 AutoPaused | 📖 | 📖 |
| `createAudioResource(stream, {inputType: StreamType.Raw})` = 48 kHz 立体声 s16le 直喂,库内部 Opus 编码;不标 Raw 会被探测/转码 | voice-bridge `LeadSpeaker.ts` 注释 | ✅ |
| PoC:`PassThrough` 常驻资源 + 每拍**维持缓冲深度 5 帧(100ms)**,空则写静音帧 ⇒ player 永不 idle;实测 `missedFrames = 0`,60 秒静音 2997 个 Opus 包照传 | `bridge-hl.mjs:1113–1181`;AN1 | ✅ |
| `playbackDuration` 含填充静音;`speaking` 事件在常开流下恒为「在说话」⇒ **量首声只能量波形** | C §18.2 | ✅ |

### 2.3 收音(上行)

| 事实 | 出处 | 成色 |
|---|---|---|
| `conn.receiver.speaking.on('start', userId)` → `receiver.subscribe(userId, {end})` 得 Opus 流;`EndBehaviorType.AfterSilence(duration)` 自动结束 / `Manual` 不结束 | 📖;PoC 用 AfterSilence 800ms | ✅ |
| Discord **只在有人说话时才有包**,中间断 ⇒ 服务端 VAD 判不出「说完」⇒ 上行必须自己补静音 | §3.1d | ✅ |
| Opus 48 kHz 立体声 → PCM(`opusscript` 纯 JS 解码;`prism-media` 也行);PoC 用 `OpusScript(48000,2)` | PoC | ✅ |
| 回声防护 = **只订阅非 bot 用户**(自己的播放永远不会回灌);QA 注入用 allow-list | voice-bridge `EarsReceiver` | ✅ |
| speaking start 会抖动重触发 ⇒ 每用户一份订阅去重 | EarsReceiver(FLY-960 A-1) | ✅ |
| backchannel 门:说话持续 ≥350ms 才算「真开口」;打断锁存 1000ms 一句一次 | EarsReceiver | ✅(本单不做打断,但门的形状可复用做「她开口了」事件) |

### 2.4 节拍与重采样

| 事实 | 出处 | 成色 |
|---|---|---|
| 裸 `setInterval(fn, 20)` 负载下真实周期 ~25ms:4 分钟该发 12000 帧只发 9578(80%)⇒ 上行 ASR 听错、下行卡顿 | 1911 | ✅ |
| 按绝对时刻排程 + 落后补发(≤10 帧)+ 落后太多重新对表 ⇒ ≥47.9 帧/秒;达标线定 47.5(逐字对的臂全 ≥47.9,错的臂 ≤43.7,真边界未量) | `bridge-hl.mjs:112–131`;manifest 达标线注释 | ✅ |
| 上行 48k 立体声 → 24k 单声道:L/R 平均 + 2:1 取样(PoC 是隔一个取,无低通);下行 24k → 48k 立体声:线性插值中点 | `bridge-hl.mjs:1101,1218` | ✅ 能用;**卡顿嫌疑人是节拍不是重采样**(已排) |
| voice-bridge 有**有状态**重采样器(`StereoDownmixDecimator`,跨 chunk 边界字节一致) | `resample.ts` | ✅ 模式可抄 |
| `opusscript` 纯 JS,20ms 一帧编解码可跑;`@discordjs/opus` 原生更省 CPU 但要编译 | 生态常识 | ⚠️ 未量 CPU |

## 3. PoC 量出来的数(拿来定尺子,⛔ 不拿来定阈值)

| 量 | 值 | 原件 |
|---|---|---|
| 她进房 → realtime started → 首句 | 01:20:02 → 01:20:03 → 01:20:05 | HANDOFF-08-24 |
| v2 想事情的沉默 | 8 场 19.3–26.4s,中位 21.8s(无先应一声) | B §6.4.2 |
| 首个 indicator 事件(`agentMessage.commentary`)距她问完 | 7.8s;命令 12.3s;开口 57.9s | B §6.4 |
| v2 五分钟不断;codex 会话(v3)静默 29 分钟不断(一直送静音) | Y3;P-6 | B §6.5【1】;C §25 |
| **Discord 腿半小时静默:零数据** | — | C §25 |
| 桥放进房的声音:Codex 交出 10.95s → 房里响 10.73s(2% 内);静音负对照峰值 0 | AN1 | HANDOFF-08-24 |
| 进房 701ms | D1 | README |
| 打断(v2):不打断,**排队**不丢 | 她实测 | B §6.5 一 |
| 她受不了的沉默:101s 自发抱怨 | LIVE-annie-3 | ANNIE-LIVE-SESSION-FINDINGS |

## 4. 方案对比(按部件)

### 4.1 进程形态

| 方案 | 评 |
|---|---|
| **A. 独立进程 `raya-voice`,与大脑(Codex TUI Lead)不同进程** ⭐ | Lead 已批(2026-08-25 回复);音频热路径不能被别的事件循环卡住(voice-bridge 当年同一理由);崩了不带走大脑 |
| B. 塞进 Raya 大脑进程 | 20ms 热路径与 Lead 的 I/O 抢事件循环;否 |

### 4.2 与 codex 的连接形态

| 方案 | 评 |
|---|---|
| **A. 管线自己 spawn 一个 app-server(与 brain 共享 `RAYA_CODEX_HOME`)** ⭐ | PoC 形态;进程/线程生命周期在自己手里;P6 专门验共享 home 双进程并发 |
| B. 连接 Raya 大脑已经在跑的 app-server | 大脑是 windowed TUI(FLY-398),不是 app-server;没有连接面 |

⚠️ 与大脑的关系(它说什么)是 2030 的事;本单只保证「有一个能听能说的 codex 线程」并把 `thread/start` 参数透传。

### 4.3 realtime 会话生命周期(exploration Q1/Q2 的技术底)

**关键事实:没有「只收会话」的 API(§1.2)。** 所以「空房收会话」只能是杀 app-server 进程。由此三条路重新写:

| 路 | 做法 | 依赖的未验事实 | 探针 |
|---|---|---|---|
| L1 会话常开(探索期曾选,founder 8-27 已推翻) | 有人没人都不动 | P6 只证 app-server/realtime ≥30m,不证明产品应常驻 | 历史分支,⛔ 不实现 |
| L2 进程按需 + `thread/resume` | 空房结束进程;她进房 resume | **P2 已否**:`no rollout found` | ⛔ 不实现 |
| L3 新 thread + 摘要回灌 | 每次进房新 thread,自己发明摘要 | 摘要 producer 属于 FLY-2030 | ⛔ 本单不实现 |

最终结论(以 plan §14 为准):只有 brain 文字触发器常驻;voice + Discord + app-server/realtime 在 `voice-mode.requested` 存在时运行。最后授权人离房过 grace 或文字 stop 后清 marker、停 Codex、exit0;下一次模式与异常重拉都 fresh thread,对外固定「记得:否」。

### 4.4 三条腿的 supervisor

| 腿 | 失效信号 | 恢复 | 借鉴 |
|---|---|---|---|
| Discord | `stateChange` 到非 Ready;`error`;`player.state.missedFrames` 连续增长;`player` 进 Idle | settle 后仍未自行 Ready ⇒ 断线一行 + persist + whole voice exit1 | `VoiceConnSupervisor` 只借检测模式 |
| codex 进程 | 子进程 `exit/error`;stdin `EPIPE`;**心跳**:`account/rateLimits/read` 连续 miss | 断线一行 + persist + whole voice exit1 | Lead 保守版 |
| realtime 会话 | `thread/realtime/closed`(reason≠requested)/`error`/protocol violation | 先查余额;否则断线一行 + persist + whole voice exit1 | Lead 保守版 |

⚠️ **心跳 RPC 与 `appendAudio` 回执(C0 已验)**:每帧 appendAudio 都是带 id 的请求。P3/P4 的 10 分钟真 app-server 运行里,27,898 次写入全部收到 result、结束时 outstanding=0;保留的末 1,000 个 RTT 为 median 1ms / p95 1ms / max 4ms。100fps 压测没有触发本机 Node stdin highWaterMark,但这不取消生产代码的有界背压合同。`account/rateLimits/read` 每 30s 一次共 20 次均成功且没有打断三次问答。

### 4.5 状态面(文字频道)

| 方案 | 评 |
|---|---|
| A. `TivPresenter` 式:一条状态消息原地 edit | ⛔ 她 8-20 推翻:位置最老、内容最新,看不到 |
| **B. 每次状态变化发新消息,1s 合并抖动、相同行去重、转写按 turn 一条** ⭐ | 她验过的形态(bridge-hl `tiv.card` 走 send) |
| 每条发送 fire-and-forget、失败只记日志(会话不能因为一条字幕死) | voice-bridge 纪律 | ✅ 沿用 |

### 4.6 等待音(indicator)混音

| 方案 | 评 |
|---|---|
| A. 等待音进播放队列 | ⛔ 排队 = 把它开口那句往后推 |
| **B. 在写帧那一刻叠加,gain 60ms 收敛;队列有话即 duck** ⭐ | 她验过(46 秒场);结构上不可能盖住说话 |
| 触发:keyed busy(`item/started|completed`;realtime itemAdded fallback),下限 1s 才响,turn final/closed 清零 | P5 真事件 + PoC | ✅ |
| 音色 B「更疏更慢-最安静」= 连续生成(`beds.mjs` 的 boxB 取样函数),不是循环样本 | PoC | ✅ 她挑的;**移植取样函数,不复制脚手架** |

### 4.7 观测与证据

| 要求 | 做法 |
|---|---|
| 播放账目每 30s 一行(状态 / missedFrames / playbackDuration / 上下行帧率 / 静音帧占比) | JSONL `events.jsonl`,字段名不许自证(⛔ 不要 `ok`/`outcome`) |
| 会话锚与进程锚分开 | `realtimeStartedAt/closedAt/durationMs` |
| 三指标 ③ | backend turn 的 `thread/tokenUsage/updated` → `RAYA_METRICS_DIR/context-usage.jsonl` 追加 `parseContextUsage(ts, params)` 合同行;纯 realtime reply 不适用;backend turn 缺 usage 才落 unavailable evidence;峰值由 brain 派生 |
| 首声/断音验收 | 只认波形(第二只 bot 耳朵录 + 静音负对照,AN1 方法)与 `missedFrames`,⛔ 不认 speaking 事件 |

## 5. 工具链(**已是事实**:FLY-2029 骨架 2026-08-26 落地;C0 探针基线 `~/.flywheel/raya/code` @ `daf35d9`)

```
xrliAnnie/raya · Node ≥ 22(⚠️ 本机 v25.6.1;Node 25 有 IP-discovery 异常前科,生产钉 22)· TS ESM
pnpm@10.13.1 workspace · Vitest 3.2.7 · Biome 2.1.4
布局:apps/brain(大脑)· packages/contracts(共享合同:env key / metrics 行 / session builders)· apps/voice(本单,独立进程 + launchd job com.xrli.raya.voice)
deps(apps/voice 私有):discord.js ^14.27 · @discordjs/voice ^0.19.2 · @snazzah/davey · opusscript(或 @discordjs/opus)· libsodium-wrappers
不装:werift(v3 才需要;留 optional)
合同要点:shipping contract 是 14 个必填 RAYA_* key + 3 个可选;`RAYA_DISCORD_TEXT_CHANNEL_ID` / `RAYA_FOUNDER_DISCORD_USER_ID` 是按需触发授权边界;context-usage.jsonl 行 = parseContextUsage();进程身份落 resource-usage.jsonl,pid = RAYA_METRICS_DIR/run/voice.pid,claim 与 brain sampler 共用 `isRayaVoiceProcessCommand` 防号码复用误判;model/effort/1M 只在会话参数
```

## 6. 会过期的结论

| 结论 | as-of | 怎么重核 |
|---|---|---|
| schema 不导出 realtime 请求定义 | 0.149.1,2026-08-25 | `codex app-server generate-json-schema --out D && grep -l appendAudio D/*.json` |
| `maxMissedFrames` 默认 5 | @discordjs/voice 0.19.2 | `grep -o "maxMissedFrames: [0-9]*" node_modules/@discordjs/voice/dist/index.js` |
| `realtime_conversation` under development/false | 0.149.1 | `codex features list \| grep realtime` |
| alpha 已弃 v2 | 0.150.0-alpha.7,2026-08-24 | FLY-2021 探针换 alpha 二进制 |
| 本机 Node v25.6.1 | 2026-08-25 | `node --version` |
| 接口边界 = `@raya/contracts`(骨架已落地) | 2026-08-26 Lead 指令 `8f544a54`;C0 仓 HEAD `daf35d9`,contracts last-touch `b8ee5f6` | `git -C ~/.flywheel/raya/code log -1 -- packages/contracts` |
| `thread/tokenUsage/updated` 在 realtime 期间何时触发 | 纯 realtime 0;delegated backend turn P5 4 次,`modelContextWindow=828400` | Raya `probes/evidence/P3-P4-voice-key/`、`P5-busy/` |
| `thread/resume` 后能否 `realtime/start` | ❌ realtime 线程没有 rollout;含 5s settle 对照仍 `no rollout found` | Raya `probes/evidence/P2-voice-key{,-settle}/` |
| 同 thread 二次 `realtime/start` 能否说话 | 不适用:没有终止旧会话的 API,探针 P1 已从最终计划删除 | plan C0 probe 表 |

## 7. C0 实测(2026-08-26,实施节点)

### 7.1 新的前置事实:当前 Raya 凭据起不了 realtime

在 Raya 仓 `daf35d9`、同一份 `RAYA_ENV_FILE` / `RAYA_CODEX_HOME` / contracts session 参数下跑 P2,`thread/start` 成功,但 `thread/realtime/start` 立即发:

```text
thread/realtime/error: realtime conversation requires API key auth
```

证据原件在 Raya 分支 `fly-2074-raya-voice` 的:

- `probes/evidence/P2-0.149-chatgpt/`:0.149.1,失败;
- `probes/evidence/P2-0.148-raya-home/`:只把 binary 换成 PoC 的 0.148.0,仍同错。

所以 **binary 版本不是根因**。当前 Raya home 的 `auth_mode=chatgpt`,进程环境也没有 `OPENAI_API_KEY`;P2 在记词之前就被 auth 边界拒绝,P3/P4 同样无法进入 realtime,不是它们自己的协议结论。

### 7.2 旧 v2 阳性证据没有证明「不靠 API key」

回查 FLY-1911 原件:

- Y3 v2 阳性场生成 manifest 时还没有 `openaiApiKeyPresent` 字段,因此该变量未知;
- 后续带该字段的 Z6 v2 八场全部是 `openaiApiKeyPresent=true`;
- 旧实验只在 **v3** 做过一次去掉 key 的对照,没有 v2 no-key 阳性对照。

因此旧文档里「`auth_mode=chatgpt` 的同一账号上 v2 通」只能证明 auth 文件标签,**不能证明实际 realtime 请求未使用 ambient API key**。C0 把这个未证变量显式暴露出来。

### 7.3 对计划的影响

C0.5 必须先明确一个可部署且不泄密的 auth 合同,再重跑 P2/P3/P4。Lead 已在 question gate `34e3b58f-fd3b-4fa7-bdb9-332c3e6a0852` 选择第二条:

1. brain 保持 ChatGPT-subscription auth;
2. 本单向 `@raya/contracts` additive 增加 voice-only `RAYA_OPENAI_API_KEY`;
3. `apps/voice` 只把它映射成其 Codex child 的 `OPENAI_API_KEY`;brain child 不接收;
4. key 只在 operator 的 `RAYA_ENV_FILE`(无 group/other 权限),不进仓/evidence/status。

key provision 后同一 P2 已越过 auth:第一进程 `thread/realtime/started`,并回答「记住了」。当前 `apps/brain` preflight 只验 `thread/start`,所以在缺 key 配置上仍可绿,却证明不了 voice realtime 能启动。voice `preflight` 必须覆盖一次最小 realtime auth 握手,否则会复制同一个假绿面。

### 7.4 P2 结果:`thread/resume` 没有可恢复 rollout

voice key 生效后,P2 的第一进程完成:

1. `thread/start`;
2. `thread/realtime/start` → `thread/realtime/started`;
3. `appendSpeech` 让它记随机校验词;
4. assistant transcript final =「记住了」。

真正关闭 app-server 后,第二进程对同一个 id 调 `thread/resume`,稳定返回:

```text
thread/resume failed (-32600): no rollout found for thread id <id>
```

为了排除「transcript final 后 31ms 就关得太早」,又做了一个只增加 **5 秒 settle** 的对照;仍是同错。Raya `CODEX_HOME` 内也找不到该 thread 的 rollout 文件。⇒ 当前 v2 realtime turn 不产 `thread/resume` 所需 rollout,P2 判 **不通**。

P2 只闭合一件事:跨进程 resume 不可用。founder 8-27 随后把运行模型定为按需:clean stop 结束整个 voice/codex 进程,下一次 trigger fresh start;异常重拉也 fresh start,状态行必须写「记得:否」。不发明摘要,也不调用已证必失败的 resume。

### 7.5 P3/P4 结果:音频热路径与心跳可用;纯 realtime reply 没有 backend context usage

在 voice-only key 合同下,同一个真 app-server 进程持续跑满 600,000ms:

- 上行静音 50fps,中间加 100fps burst:27,898 次 `appendAudio` 写入 / 27,898 次回执 / 0 错误 / 结束时 0 outstanding;`write()` 从未返回 false。保存的末 1,000 个回执 RTT 为 min 0ms / median 1ms / p95 1ms / p99 2ms / max 4ms;
- `account/rateLimits/read` 每 30s 一次共 20 次,全部回执;开始、约 142s、约 541s 三次问答都得到正确 final transcript;
- `thread/tokenUsage/updated` 通知 **0 次**;
- P3 与 P4 两次 `account/usage/read {threadId}` 的 `threadUsage` 都是 **null**,summary 字段也全 null。

因此 P3 选出的生产分支是:

1. `appendAudio` 走无 waiter 热路径;若为了观测 RTT,只保留最多 100 个未决 id,超限驱逐最旧且永不作为恢复触发器;
2. 心跳用 `account/rateLimits/read`,连续 miss 才判 realtime 腿 down;
3. P3/P4 的三次回答都是纯 realtime reply,没有 `turn/started|completed`,所以没有 backend Codex context 用量可记。不得把 null 冒充 0,也不得把这种 not-applicable 伪报成 unavailable。

Lead 在问题 `a44c2056-4e25-4269-8191-2444ff8e668b` 裁定「不因上游 Codex observability 卡住 2074」,但要求先反证 underlying OpenAI Realtime 的 `response.done.usage` 是否穿透 app-server。补查结果:

- P3/P4 全量 JSON-RPC 的 inbound method 只有 startup/warning 与 `thread/realtime/{started,itemAdded,outputAudio/delta,transcript/delta,transcript/done}`;没有 `response.done` / `rate_limits.updated`;27,898 个 appendAudio result 都是空对象;
- 对 Codex 0.149.1 重新生成 app-server JSON schema,server notifications 只列上面的 `thread/realtime/*` 类型与 `thread/tokenUsage/updated`,没有 raw OpenAI `response.done` / `rate_limits.updated` 类型;
- 因而 underlying OpenAI Realtime 模型自身的 usage 在当前 app-server 代理边界不可见;但 G7 要记录的是 Raya 委托 backend Codex 工作时的 context,其阳性面由 P5 另测。

若未来某个 backend `turn/completed` 仍没有同 turn usage,最终合同才是 evidence 精确落:

```json
{"metric":"context_usage","status":"metrics_unavailable","source":"codex_app_server","evidence":{"threadId":"…","turnId":"…","turnCompleted":true,"tokenUsageUpdatedCount":0}}
```

### 7.6 P5 结果:backend busy 与实际 context usage 都有阳性信号

P5 强制 realtime 委托 backend Codex 使用工具。31 秒内观察到:

- `item/started` 6 次、`item/completed` 6 次,另有 `thread/realtime/itemAdded` 6 次与 assistant transcript done;keyed busy 有真实成对信号;
- `turn/started` / `turn/completed` 出现;
- `thread/tokenUsage/updated` 4 次,payload 是现有合同形状:`{threadId,turnId,tokenUsage:{total,last,modelContextWindow:828400}}`。

所以 G6/G7 都有可实现的 app-server 面。生产只为 backend turn 写 usage;纯 realtime reply 不写。**但 828400 与 contracts 请求的 `RAYA_CONTEXT_WINDOW=1050000` 不同**:解析阳性不等于 1M 兑现。生产保留 actual 行并另落 `context_window_mismatch{requested,actual}`;合同取值是否调整归 FLY-2029。证据在 Raya `probes/evidence/P5-busy/`。

### 7.7 `CODEX_HOME` 隔离实验与 Lead 裁定

同一个 P5 分两次换全新临时 home:

1. 空 home + `OPENAI_API_KEY`:thread/start 与 realtime/start 可用,但委托 backend Codex 调 `/v1/responses` 返回 401 missing bearer,240 秒超时;
2. 对临时 home 先 `codex login --with-api-key`:P5 22 秒通过,但这会把 voice backend carrier 改成 API-key ledger并在 `auth.json` 存凭据。

Lead 问题 `1f7d2be9` 选择 **本单不加 `RAYA_VOICE_CODEX_HOME`**,voice 与 brain 共享 ChatGPT-subscription 的 `RAYA_CODEX_HOME`;voice key 只供 realtime。P6 已用两个并发 app-server(voice + brain-like)在同一 home 上跑满 1,800,000ms:

- 同一 realtime session 82,316 次 audio write / 82,316 ack,0 error,0 outstanding,0 `thread/realtime/closed`;
- voice heartbeat 60/60、brain-like check 60/60;
- 约 1.9s 的开场回答「P6开始。」,约 1,741s 的末场回答「P6三十分钟后仍正常。」。

所以 C0.5 的 realtime lifetime 与 shared-home concurrency 两项均有阳性证据。

### 7.8 launchd `SuccessfulExit=false` 探针执行边界

C0.5 review 发现当前 `KeepAlive.Crashed=true` 不能保证普通 exit1 拉起;本机 `man launchd.plist` 也明确 `SuccessfulExit=false` 才表达「非零退出后拉起」。已写唯一临时 label 的 probe fixture:首次进程收 TERM→exit1,第二次 fresh thread/start+realtime/start 后 exit0,并检查没有第三次启动。

plist 已过 `plutil`;fixture direct 也已过:首次 TERM 后 code 1;第二次 fresh `thread/start` + `realtime/start`,逐字回答「回来但不记得。」后 code 0。当前 managed runner 对 `bootstrap gui/501`、`bootstrap user/501`、legacy `load` 都返回 `EIO(5)`,且没有 service 注册。Lead 在 question `e44df615` 裁定:C0.5 不因 runner 限制卡 gate;renderer tests 放 C1,C9 把 exact temp plist path 与预期观测交给 Lead shell 真跑 bootstrap/observe/bootout。账本固定写 **fixture-verified; live registration = Lead-shell probe at C9**。
