# FLY-1911 Codex 语音端到端原型 — 调研(实测事实)

Issue: FLY-1911 (https://linear.app/geoforge3d/issue/FLY-1911/voice原型-把-codex-语音端到端跑通-验它真的能说能听不只是会话能建起来)
日期: 2026-08-19
基于: exploration.md

> 本文只记录**实测到的事实 + 证据出处**。原型形态在 plan.md。
> 全部实验在 **codex-cli 0.148.0** 上跑,二进制 pin 绝对路径并自算 sha256:
> `b0308517b20543012fa2171aa3d46ce455a7456c4eb2a552ab9468ba4eeb1e50`
> (`~/.codex-mufasa/packages/standalone/releases/0.148.0-aarch64-apple-darwin/bin/codex`)。

---

## 结论(一句话)

**它真的会说,也真的听得见** —— 但**专有名词会听错**(`flywheel`→「李维尔」、`PR`→「T、R」)。

而且 **v2 / websocket 这条路不需要 WebRTC** —— 音频进出就走 `codex app-server` 的普通 stdio JSON-RPC(base64 PCM)。
(**两条路并存**:v3 走的正是 webrtc + SDP,见 §7。不要写成「WebRTC 不需要」。)
**假设 A1/A2 在 v2 这条路上被推翻,原型成本因此低一整档。**

同时撞到一堵墙:**「说完之后真去干活」那一步当场撞了账号额度**(见 §6),不是技术不通。

---

## 0. 协议合同不是猜的 —— 是它自己吐出来的

```
codex app-server generate-json-schema --out <dir> --experimental --enable realtime_conversation
```

这条命令直接产出权威 schema,不需要 strings 猜。关键几个:

| 方法 | 方向 | 关键参数 |
|---|---|---|
| `thread/realtime/start` | 我→它 | `threadId` · `outputModality`(text/audio) · `transport`(**websocket** 或 **webrtc+sdp**) · `voice` · `version`(v1/v2/v3) |
| `thread/realtime/appendAudio` | 我→它 | `audio: { data(base64), sampleRate, numChannels, samplesPerChannel? }` |
| `thread/realtime/appendSpeech` | 我→它 | `text` —— 让它开口 |
| `thread/realtime/appendText` | 我→它 | `text` + `role` |
| `thread/realtime/outputAudio/delta` | 它→我 | 同一个 `audio` 结构 —— **音频直接从 JSON-RPC 出来** |
| `thread/realtime/transcript/delta` / `/done` | 它→我 | `role` + 文本 —— 双向逐字稿 |
| `thread/realtime/itemAdded` | 它→我 | 原始 item(function_call / handoff_request 都从这出来) |

⇒ **`outputAudio/delta` 这个通道的存在,本身就是「不需要媒体栈」的结构性证据。**

## 1. 它真的说话了(判据 ①)—— 实验 S1

参数:`version=v2 · voice=marin · outputModality=audio · transport=websocket`,发一次 `appendSpeech`。

| 观察 | 值 |
|---|---|
| 会话准入 | `started`(2.47s) |
| 拿到音频 | **10 个 chunk,189,600 字节,24000 Hz 单声道 Int16** |
| 时长 | **3.95 秒** |
| 是不是静音 | **不是** —— `ffmpeg volumedetect`: mean −20.1 dB / max −5.0 dB |
| 首字音延迟 | **610 ms**(从我发出请求到第一个音频包) |
| 它说了什么 | 逐字稿:`你好呀!很高兴和你聊天。有什么需要帮忙的吗?` |

产物:`evidence/S1-v2-ws-speech.wav`(可直接播放)+ `S1-...jsonl` + `S1-...-manifest.json`。

> **诚实边界**:「人耳听得懂」这一条,机器证不了。我给出的是:文件真实存在、非静音、
> 有逐字稿、格式合法。**最后一锤要 Annie 自己按播放键** —— 这就是 founder 那一环存在的理由。

## 2. 它听得见,但**专有名词会听错**(判据 ②)—— 实验 S2

输入:macOS `say -v Tingting` 合成的一句中文 `今天 Flywheel 有几个 PR 还没合并?`
(3.80 秒,24kHz 单声道,sha256 `0a7e27db…`),按 100ms 一包、**真实语速节奏**喂进 `appendAudio`,
末尾补 1.5 秒静音让服务端 VAD 判断说完了。

它还原出来的文字有**两版**(这点很重要,别只看第一版):

| 第几版 | 出处 | 文本 |
|---|---|---|
| 第一版(流式) | `transcript/done` role=user | `今天,李维尔有几个T、R还没合并。` |
| **第二版(定稿)** | `itemAdded` → `handoff_request.input_transcript` | **`今天,flywheel 有几个 PR 还没合并?`** |

⇒ **两版并存,而且都要如实记。**
- **流式那一版把专有名词听错了**:`flywheel` → 「李维尔」,`PR` → 「T、R」。**这是真缺陷,不是噪声。**
  她说「flywheel 那个 PR」,系统听成「李维尔的 T、R」= **错单**。这条是 B4(认错人/认错单的后果谁兜)的硬输入。
- 交办出去时用的那一版是对的(逐字见 `evidence/S2-v2-ws-listen.jsonl` 的 `input_transcript`)。
- **我不知道第二版为什么更好** —— 可能是后端带上下文重转,也可能是交办层自己规整。**没验过,不下结论。**

> **我先报错过一次**:我看到第二版就写成了「它听懂了」。Lead 查 manifest 时发现 `heard` 字段里只有糊掉的那版 ——
> **他是对的:我的探针只把 `transcript/done` 收进了 manifest,第二版没进去**,这是取样缺口。
> 但第二版确实存在,逐字在同一份已提交的事件流里。⇒ 正确结论是**「听得见,专有名词会错」**,
> 不是「听懂了」,也不是「一定会错」。
>
> **仍然存疑的**:我喂的是 TTS 合成音,不是真人。真人口音 / 语速 / 环境噪音下的表现**没验**。
> 这条只能靠 Annie 真的对着麦克风说一句。

## 3. 「说一句话就有人真去干活」这条链原生就在(判据 ⑤ 的前半段)

S2 里,它听懂之后**自己**做了这一串(全部逐字取自事件流):

```
transcript/done (role=user)
  → itemAdded: function_call name="background_agent"
  → itemAdded: handoff_request { input_transcript: "今天,flywheel 有几个 PR 还没合并?" }
  → turn/started                       ← Codex agent 真的开了一轮
  → item/started: userMessage content="<realtime_delegation><input>今天,flywheel 有几个 PR 还没合并?</input>…"
```

⇒ 语音会话**自动把听到的话交办给 Codex agent**,不需要我们自己写「把语音转成任务」那一层。
这正是 B/C 两条产品线最核心的那根管子,**它是现成的**。

## 4. 打断(判据 ③)—— 实验 S4 / S5,两次独立测量

做法:先让它讲一段长的(`appendSpeech` 要它讲三十秒),等它讲了 2.5 秒,
**在它还在说的时候**开始往 `appendAudio` 推我的语音,量「它最后一个音频包是什么时候到的」。

| 跑次 | 打断前已收音频包 | **打断后它还在送音频的时长** |
|---|---|---|
| S4 | 33 | **150 ms** |
| S5 | 27 | **217 ms** |

逐字稿那一侧也对得上 —— 它的话在 `…从编辑到` 处**被截断**,是被打断的样子。

> **这个数字量的是什么,要说清楚**:我量的是「**服务端多久停止发送音频**」,
> 不是「喇叭多久真的安静」。真实体感还要加上客户端已经缓冲了多少音频。
> 150–217ms 是**服务端停口**的量级,和 issue 里 ~100ms 的目标同一个数量级,但**不是同一个东西**。

## 5. 长会话(判据 ④)—— 实验 S5

做法:一条会话持续 **10.4 分钟**,每 2 分钟发一次「你还在吗」,记录是否回、回得多快、有没有 `closed`/`error`。

| 第几次 | 第几分钟 | 回了吗 | 它开口用了 |
|---|---|---|---|
| 1 | 2.1 | ✓ | 649 ms |
| 2 | 4.2 | ✓ | 621 ms |
| 3 | 6.3 | ✓ | 678 ms |
| 4 | 8.4 | ✓ | 774 ms |

- **零 `error` 事件、零主动断线** —— `closedEvent` 为 null,会话只在我主动 `stop` 时才关。
- 全程 51 个音频包。
- **一个要说出来的小趋势**:开口延迟从 649ms 慢慢爬到 774ms(+19%)。
  4 个点撑不起「会持续劣化」这个结论,**但也不能说「完全没变化」**。要判这条得跑更久、更多次。

⇒ **10 分钟这个量级稳。更长的没验。**

## 6. 撞到的墙:账号额度(不是技术问题)

S2 里 `turn/started` 之后 **0.7 秒**就来了:

```
error  You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage
       to purchase more credits or try again at 11:24 PM.
codexErrorInfo: usageLimitExceeded        credits: { hasCredits: false, balance: "0" }
turn/completed status=failed
```

- 撞的是 `~/.codex/auth.json` 当前 active 的 **business** 号。
- **语音会话本身没被拦** —— 说话、听懂、打断、长会话全部照跑。被拦的只有 **Codex agent 那一轮**。
- 按纪律(runner 撞 Codex 不可用 = 停手上报,不自救):**没有轮转 profile、没碰任何全局配置**,
  已 `flywheel-comm ask` 上报 Lead(`5aedc037`)。

⇒ 判据 ⑤ 的**后半段**(结果回到耳朵)因此**未验**。这是外部额度,不是可行性结论。

## 7. v3 / WebRTC 的今日状态(把 FLY-1844 的未验项关掉一条)

实验 S3:`version=v3 · voice=cove · transport=webrtc(werift 生成真 SDP offer)`

- **`started`,`version:"v3"`** —— **0.148.0 上 v3 准入复验通过**(FLY-1844 只在 0.147.0 验过)。
  ⇒ 建单时列的「0.148.0 上 v3 准入没复验」这条**可以划掉**。
  ⚠️ 但 S3 **只证准入,没证 v3 能出声** —— 它没有 audio 字段(下一条就是原因)。
- 同一次实验里,**JSON-RPC 上一个音频包都没有**(`chunks: 0`)。

⇒ 结构性事实,不是 bug:

| 通道 | 音频走哪 | 原型成本 |
|---|---|---|
| **v2 / websocket** | **base64 PCM 走 JSON-RPC 本身** | 一个 Node 脚本就够,零媒体栈 |
| v3 / webrtc | 走 RTP 媒体面(要接完 SDP answer、收 Opus、解码) | 要 WebRTC 栈 + Opus 解码 |

**没量过的**:v3 走完媒体面要多少工。仓里 `packages/voice-bridge` 已有 Opus 解码那一块,
但我**没接过、没量过**,所以这里**不写「很容易」**。

## 8. 耳朵那半到底归谁(判据 ⑥ —— 直接决定 B/C 载体形状)

先把两条现成的腿核实一遍(不转述,自己看代码):

| 现成的腿 | 收音(设备) | **听懂(ASR)** |
|---|---|---|
| `packages/voice-core` | `audio/MicCapture.ts` 本地麦克风 | **Gemini Live** —— `factory.ts` 注释逐字:「the converse backend (Gemini Live)」,`backends/` 下只有 `gemini/` 和 `edge-tts/` |
| `packages/voice-bridge` | `audio/EarsReceiver.ts` Discord Opus | **Gemini Live** —— `roomEars.ts` 注释逐字:「the FLY-967 /gemini wiring (which owned it privately)」;`audio/GeminiTurnMouth.ts` |

**本单的答案**:用 Codex realtime 的话,**Codex 自己同时承担嘴和耳朵**(TTS + ASR 都在它那边,
§1 §2 是直接证据)。**不需要混合。**

⚠️ 但要把两件事分清楚,别混成一句:
- **收音(把声音采下来)** 永远是我们这边的活 —— 麦克风也好、Discord 音频流也好,Codex 不碰设备。
- **听懂(把声音变成文字/意图)** 可以整个交给 Codex。

⇒ 载体形状上,**Codex 可以独占「嘴 + 耳」,Gemini Live 不是必需品**。
这**不是**在否定 Gemini Live —— 它是 Annie 真机点过头的那条(FLY-1827 audit.md:95),
本单只回答「Codex 能不能自己扛」,答案是**能**。

## 9. 实验清单

| # | 参数 | 问题 | 结果 |
|---|---|---|---|
| S1 | v2 / websocket / audio / appendSpeech | 它会不会说 | **会** — 3.95s wav,非静音,首音 610ms |
| S2 | v2 / websocket / appendAudio | 它听不听得懂 | **听得懂** — 定稿转写逐字全对;并自动交办;agent 轮撞额度 |
| S3 | v3 / webrtc / audio | 0.148.0 上 v3 还能不能进 | **能** — started, version v3;JSON-RPC 上零音频(走媒体面) |
| S4 | v2 / websocket | 能不能打断 | **能** — 服务端 150ms 停口 |
| S5 | v2 / websocket / 10 分钟 | 长会话稳不稳 | **稳** — 10.4 分钟,4 次确认全回,零 error,延迟 649→774ms |

## 10. 纪律

- 全程 pin versioned 绝对路径 + 自算 sha256;**没碰** `~/.local/bin/codex` 那个会摆动的 symlink。
- **没有**写 `~/.codex/config.toml`,**没有**做任何 `codex-profile` 操作(不 use/save/login),
  **没有**改任何生产配置、**没有**启动任何服务。`--enable realtime_conversation` 只单次生效。
- 撞额度当场停手上报,未自救、未轮转。
- 证据性质:**探针事件日志**(过滤 `mcpServer/*` 噪声;音频以 wav 落盘 + SDP 记 sha256),
  非逐字节 raw stdout。已扫无凭据泄漏。
