# FLY-2885 引擎 B 改走 WebRTC + 订阅 — 调研
Issue: FLY-2885 (https://linear.app/geoforge3d/issue/FLY-2885/语音b核心连接层-引擎-b-改走-webrtc-订阅替换-websocket-api-key房间进程-webrtc)
日期: 2026-09-25
基于: exploration.md

证据目录 `evidence/`:源码事实(`codex-v3-webrtc-source-facts.md`,`openai/codex` tag `rust-v0.157.0` 对照 `rust-v0.156.1`)、
三次实测日志(`probe-run1/2/3-*.jsonl`,脚本 `probe2.mjs`)、零额度探针(`probe-account-voices.*`)、上下文计量脚本、电平脚本。
实测全程:固定的 **0.156.1** standalone(sha256 `0196e89f…255a`,与 `CODEX_VOICE_BINARY_SHA256` 一致)、临时 `CODEX_HOME`、
`auth.json` 软链到 `~/.codex/auth.json`、环境去掉 `OPENAI_API_KEY`/`CODEX_API_KEY`;没有 login/logout;三场实时会话合计约 40 秒音频。

## R1. 连接怎么建立(源码)

| 事实 | 出处 |
|---|---|
| app-server 收到 `transport:{type:"webrtc",sdp}` 后**用 HTTP 把 offer 一次性 POST 出去**;ChatGPT 登录走 `chatgpt.com/backend-api/codex/realtime/calls`,API key 登录走 `api.openai.com/v1/live`;返回 answer 用 `thread/realtime/sdp` 通知 | `codex-api/src/endpoint/realtime_call.rs:62-79,139-166` |
| 认证就是 Codex 当前登录(ChatGPT bearer);webrtc 路径**不调用** `realtime_api_key()`;**只有 websocket 传输需要 API key** | `core/src/client.rs:665-699`;`realtime_conversation.rs:1311-1318,1830-1854` |
| 建好后 app-server 另开一条**服务端侧带 WebSocket**(sideband)控制会话;`appendSpeech/appendText/委托`全走 sideband,**不走数据通道**;sideband 断了自己按 200 ms→5 s 退避重连,404/410 视为会话结束 | `realtime_conversation/sideband.rs:59-171` |
| **WebRTC 对端断了 app-server 看不见**(它不持有 PeerConnection)——只报 sideband 断/错误 | `realtime_conversation.rs:2689-2705` |
| 音频只走 RTP;实测 `thread/realtime/outputAudio/delta` 0 条(两场) | `probe-run2/3` |
| v3 必须显式传 `version:"v3"`(webrtc 缺省是 v1);v3 默认模型 `gpt-live-1-codex`,`model` 参数可覆盖 | `realtime_conversation.rs:111-112,1319-1327,1509-1518` |
| **0.156.1 与 0.157.0 的 v3/WebRTC 相关文件逐字相同**;0.157 只多了 `backendReasoningStatus` 等无关项 | 源码 diff |

结论:**不换二进制**。继续用已固定的 0.156.1(版本 + sha256 + `realtime_conversation stable true` 三项校验不变),只改会话参数与认证方式。

## R2. 声线(源码 + 实测)

- v3 **只接受 v1 声线表**:`juniper, maple, spruce, ember, vale, breeze, arbor, sol, cove`,默认 `cove`(`protocol/src/protocol.rs:327-356`)。
- 实测:`voice:"marin"` 时 `thread/realtime/start` **返回成功**,随后才异步来 `thread/realtime/error`:
  `realtime voice 'marin' is not supported for v3; supported voices: juniper, maple, spruce, ember, vale, breeze, arbor, sol, cove`(`probe-run1`)。
  ⇒ 开会话必须等到 `sdp` **或** `error/closed` 才算有结果,不能以 RPC 成功为准(今天的 `CodexRealtimeTransport.start` 已等 `started`,需改为等 `sdp`)。
- `listVoices` 不列 v3(只有 v1/v2 两组)。
- 现网 `projects.json`:17 个 Lead 里 15 个 `marin`、`verse`、`alloy` 各 1 个 —— **全部不在 v3 表里**。FLY-2866 分配的声线在引擎 B 上一个都用不了。

## R3. 上下文(实测 + 计量)

| 场次 | prompt | o200k 估计 | 结果 |
|---|---|---:|---|
| run1 | 61,489 B 中文 | 17,012 | **拒绝**:`Invalid AVAS session_data: UserError[400, user=Instructions must not exceed 16384 tokens.]` |
| run2 | 49,362 B | 13,662 | 通过;问「你叫什么、暗号是什么」→「我叫测试助手 B 号。暗号是青柠七号。」(身份与事实都来自 prompt) |
| run3 | prompt 220 B + `initialItems` 一条 developer 16,461 B(暗号只写在 item 里) | — | 通过;答出「青柠七号」⇒ **initialItems 里的内容模型能用上** |

- Codex 客户端对 `prompt` 不做任何截断/检查;`initialItems` 由客户端校验:≤128 条,单条与合计 ≤8,192 **估计** token,估计法 = 字节数/4 ⇒ 合计 ≤32,768 字节,超了拒绝不截断(`realtime_conversation.rs:104-106,1442-1459`)。
- 服务端上限 16,384 token 与本地 o200k 计数口径一致(17,012 拒 / 13,662 过)。
- 现有 Lead 真实文件(只计大小,`measure-context.mjs`):

| Lead | identity | 记忆 | 合计 |
|---|---:|---:|---:|
| Raya | 3,634 tok / 17.9 KB | 工作区 MEMORY 11,238 tok / 37.8 KB + Codex 记忆摘要 753 tok / 3.5 KB | **15,625 tok / 59.1 KB** |
| Honey Lemon | 4,489 tok / 17.6 KB | 6,492 tok / 23.8 KB | 10,981 tok / 41.4 KB |

  今天 Bridge 的预算是 128 KB / 32,768 tok(`voice-session-context.ts:9-10`)。Raya 身份 + 记忆已 15.6k,加上状态快照、会议上下文、协议说明必然超过 16,384 ⇒ **不改装配,Raya 的引擎 B 语音开不起来**。
  拆法:身份、边界、状态、会议、退出规则、协议说明留在 prompt;记忆文件按顺序放进 `initialItems`(合计 ≤32,000 字节,留余量),放不下的尾部回填到 prompt。
  Raya:items ≈ 32 KB,prompt 里剩约 9 KB 记忆 ⇒ prompt 估计约 8–9k tok,在 15,500 以内。Honey Lemon:记忆全进 items。

## R4. appendSpeech 在 v3 的语义

- v3 的 `appendSpeech` = sideband `session.context.append`,`channel:"speakable"`;**没有 `[BACKEND]` 前缀、没有 `response.create`**;文本截到 1,000 token(`realtime_conversation.rs:1099-1122`)。
- 实测照读:run2 送「测试已经完成,谢谢你的配合。」→ 它说「测试已经完成,谢谢。」(**改写了**);run3 同一句逐字照读。⇒ **v3 不保证逐字**。
  影响:`CodexProofSpeaker` 对 `verification:"required"` 的朗读(Lead 回复、「请再说一遍」)要求转写等价,v3 下会有一部分回执变成 `unconfirmed`。
  这是模型行为,连接层只能:① 把协议说明里 v2 专用的 `[BACKEND]` 句改成 v3 语义(「追加给你的可朗读内容要逐字念出」);② 在 QA 里量逐字率并如实报告。
- 现有 realtime prompt 的 `[BACKEND]` 说明在 v3 下是**死文字**(没有这个前缀了)。

## R5. 事件与转写(源码 + 2884 日志 + 本单实测)

- app-server 通知:`thread/realtime/transcript/delta|done`(role user/assistant,**无 itemId**)、`itemAdded{type:"handoff_request"}`(委托)、`started`、`sdp`、`error`、`closed(reason ∈ requested|transport_closed|error)`。
  v3 **不产生** `input_audio_buffer.speech_started`,也没有 assistant 的 itemAdded。
- 委托:`delegation.created` → `itemAdded handoff_request`,**同时**总会在 backing thread 起一个 turn(`clientManagedHandoffs` 不阻止)——今天的 `backgroundTurnStarted → turn/interrupt` 拦截照旧适用。
- 数据通道 `oai-events`(我们持有):服务端推 `session.started{expires_at}`、`turn.created`、`turn.delta`、`turn.done`、`input_transcript.added`、`output_transcript.added`、`delegation.created`、`session.context.appended`、`session.usage.updated`。
  `turn.created/done` 带 `turn.id`、`role`、`start_ms`、`end_ms`、`transcript`(assistant 的 `turn.done.transcript` 是整句)。
  Codex 官方原生客户端**忽略**数据通道;这些事件不在 Codex 协议面上 ⇒ 我们用它们时必须**容错**(缺事件时有兜底计时,不能卡死)。
- 归属:v2 也没有 itemId,2799 实际靠「房里只有一个人」推断(`resolveSoleRoomUser`)。v3 相同,**归属逻辑不需要改**。

## R6. 插话与 VAD(源码)

- v3 会话配置只有 `{instructions, audio.output.voice, delegation, model, initial_items}`;**没有任何轮次检测 / VAD 参数**,配置和 start 参数都改不了(`methods_frameless_bidi.rs:52-100`)。
- v3 客户端协议**没有取消/截断事件**,app-server 也没有取消 RPC(`protocol.rs:52-85`)。数据通道上发客户端事件服务端是否理会:未知,官方客户端不发。
- 2884 实测:服务端要识别出第一个字才判定插话(均 1,156 ms),判定时会在服务端截断旧回答。
- ⇒ 「立即停」只能靠**本地**:检测到 founder 开口就把下行换成静音帧;「取消」由服务端自己的截断完成(2884 中 10/10 截断)。
  误判(咳一声)时服务端不会起新回合,需要兜底:本地静音后一段时间内服务端没出现新的用户回合,就恢复播放。

## R7. 上行 VAD 门的延迟(读码)

`UplinkSpeechGate` 是**按帧数**放行的延迟线(`takeDue`:`delay.length > delayFrames` 才放),
`uplinkGateDelayFrames(200, 200)` = ⌈(511+512×7)/320⌉ + 1 + ⌈200/20⌉ = **24 帧 = 480 ms**,另有 `Uplink` 预缓冲 3 帧 60 ms。
说话结束后,Discord 停止发包 ⇒ 延迟线不再前进,直到 `speaking end`(约 +100–200 ms)才整批冲出,再按每 20 ms 一帧发 ⇒ 最后一个字比 2884 原型**晚约 0.6 s** 到服务端。

按 2884 程序端均值 985 ms 推算,照搬这条门 ⇒ 约 1.6 s,**超过本单验收上限 1,182 ms**。
2884 原型没有门(起步只缓冲 60 ms),风扇/键盘 0 误触发 —— v3 服务端本身要听出字才起回合,对非人声稳健。

可选做法:
- **G1 门「开了就追」(推荐)**:门在确认人声(≥200 ms)**打开之后**,改为「判定一出就放」而不是等满 24 帧;发送侧积压时每拍多发一包追上(2884 已用同一策略,s3–s7 无问题)。
  句首仍按原 24 帧判定 + 200 ms pre-roll(句首补音不变),只是开口后 0.5 s 内追平;说完时延迟线里只剩未判定的 1–2 帧。
  只对 WebRTC 房开启(选项),旧引擎行为不变。
- G2 WebRTC 下不走门:最快,但丢掉门的全部作用(远处人声判定也没处放),且「句首补音」回归只剩单测。否决。
- G3 照搬:验收 2 预期不过。否决。

## R8. 远处人声(证据复算,`uplink-levels.py`)

| 片段 | 上行帧电平 |
|---|---|
| 2884 s4 风扇 60 s | p50 −27.4 dBFS(Silero 不判为人声,0 误触发) |
| 2884 s4 远处人声 60 s | p50 −39.7 / p99 −35.6 / **最大 −34.1 dBFS**(1 次误触发) |
| 2884 s2 替身近讲 | p50 约 −18 dBFS |
| 2884 s7 founder 真人(7 句) | 最轻一句 p90 −35.2、**最大 −26.2 dBFS**;其余句最大 −13 ~ −9 dBFS |

- 帧级电平门(每帧低于门限就静音)会把 founder 轻声句切碎(最轻一句一半以上的帧 < −32 dBFS)⇒ 否决。
- **句级峰值门**:门在「本来要打开」的那一刻,看判定窗口内(约 0.5 s,含 pre-roll)的**最大帧电平**,低于门限就不开(继续判后面的帧,变响了再开)。
  门限 −30 dBFS:远处人声最大 −34.1(低 4 dB 拒),founder 最轻一句最大 −26.2(高 4 dB 过)。余量只有约 4 dB,且远处人声是合成的、无 Krisp;**做成可配置并在 QA 用 founder 真麦复核**。
- v3 服务端没有 VAD 参数可调(R6),所以这是连接层唯一能做的;「是不是在跟它说话」仍归大脑单。

## R9. 凭据(源码 + 探针 + FLY-2404 结论)

- 临时 home 的 `auth.json` 软链到舰队凭据 `~/.codex/auth.json`(Raya 家也是同样软链);Codex 刷新前回读磁盘、原地写不换 inode,多进程共享安全(FLY-2404 实验结论)。
- **不能拷贝**凭据文件:拷贝会分叉 refresh token,一旦副本先刷新,舰队的原件就会 `refresh_token_reused`。
- 探针:`rm -rf` 临时 root 只删软链本身,源文件仍在、mtime 未变。
- config 需要 `forced_login_method = "chatgpt"`、`cli_auth_credentials_store = "file"`(`ephemeral` 不读文件)。
- 开会话前 `account/read` 必须是 `type:"chatgpt"`,否则按「认证失败」报语音不可用;额度耗尽同样明确报,不切引擎。
- 实测 `account/read` → `planType:"pro"`(当前舰队凭据)。实时语音按音频时长计量(2884:`session.usage.updated` 只有 `audio_duration_ms`)。

## R10. 依赖

- `werift@0.24.4`(纯 TypeScript WebRTC,MIT;2881/2884 与本单三场实测都用它)—— **voice-codex 新依赖**,只动 lockfile。
- `opusscript@0.0.8`:voice-bridge 已有的固定编码器(纯 JS,无原生编译);本单上行用它编码 24 kHz 单声道 → Opus(run2/run3 服务端都听懂了这种上行)。
- 下行 Opus 直推 `@discordjs/voice` AudioPlayer(`StreamType.Opus`),2884 已证。

## R11. 未证 / 留给实现与 QA

1. gpt-live-1-codex 在 9 个 v3 声线上是否都能出声(只实测了 `cove`)。
2. 数据通道事件名/字段的稳定性(不是 Codex 协议面);用时必须有兜底计时。
3. 服务端对 `initialItems` 的上限(实测 16 KB 一条通过;32 KB 合计未测)。
4. 会话服务端寿命(`expires_at` ≈ +2 h,源码无客户端上限)。
5. 追帧发送(2 包/拍)对服务端听感与判停的影响——2884 用过同策略无异常,仍需 QA 量。
