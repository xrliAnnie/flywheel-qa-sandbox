# FLY-1443 Codex CLI realtime 语音会话验证 — 结论报告

Issue: FLY-1443 (https://linear.app/geoforge3d/issue/FLY-1443/prototypehl-验-codex-cli-能不能起-realtime-语音会话-后端认不认codex-as-lead-架构的生死闸门)
日期: 2026-07-23
基于: 无

---

## 结论

**能。在 `codex-cli 0.145.0` + `version: "v2"` 下,headless app-server 建立了 realtime 语音会话,外部音频喂得进去、模型的可懂语音取得出来。后端-能力这道闸门:通过。**

三个问题:

| # | 问题 | 答案 |
|---|------|------|
| 1 | 后端认不认 CLI 发起的 realtime 会话 | **认**。`v2` 全链跑通(留档 2 次独立运行);`v1` 也拿到准入(`started` 已发出,后因 transport 不符失败)。**只有 `v3` 被拒**,留档 3 次(见 §2) |
| 2 | 无头能不能建会话 | **能**。纯 stdio JSON-RPC,无 GUI / 无 TUI / 不碰系统录音放音设备 |
| 3 | 音频能不能进出 | **能**。外部 WAV 喂进去被转写出目标语义;模型语音以 PCM 取出,离线 ASR 可识别 |

> ⚠️ **前提 —— 任何基于本结论的计划都必须带上这三条**
>
> 1. **验的是"能力",不是"稳定性"。** `realtime_conversation` 状态是 **under development**,CLI 每次启动都警告"不完整、行为可能不可预测";请求方法**没有进导出的 JSON schema**。协议随时可能变。
> 2. **验的是 headless app-server,不是生产形态。** `CLAUDE.md` 明确规定生产 Codex Lead 必须是 **windowed TUI**,headless app-server 只允许 tests/QA/rollback。本次证明的是 backend capability,**不证明**生产 windowed TUI 能承载同一条 Discord 语音链路。
> 3. **因此:没有发现 backend-capability 层面的阻塞,可以进入下一阶段验证。** 现有证据**还不足以**取消 Gemini/ElevenLabs 的 fallback —— 那需要稳定性 + 生产形态 + Discord 端到端都验过。

---

## 1. 生死题的证据

### 1.1 全链跑通(C1 / C2 两次独立运行,均完成全链)

用 macOS `say` 合成一段外部音频(**不是** OpenAI 客户端录的),经 `thread/realtime/appendAudio` 送入,尾部补 2 秒静音。C2 用修正后的探针跑(见 §6),两次都完成了同一条链路 —— 但**具体数值每次不同**(ASR 文本、音频长度都有抖动),下面所有数字取自当前 evidence 里可逐字节核验的 C2。

> 计数口径:本报告只声称**当前 evidence 目录里可独立复核**的运行次数(全链 2 次、denial 3 次)。迭代过程中确有更多次运行,但那些 artifact 在重跑时被覆盖了 —— 没有留档就不计数。

C2 原始事件(全量见 `evidence/C2-v2-audio-full-loop-fixed-probe.jsonl`):

```json
{"method":"thread/realtime/started","params":{"threadId":"019f91cb-869a-7c11-aadb-f6eafc3dbfc1","realtimeSessionId":"019f91cb-869a-7c11-aadb-f6eafc3dbfc1","version":"v2"}}
{"method":"thread/realtime/transcript/done","params":{"role":"user","text":"Hello, please reply with the words: flywheel Probook K."}}
{"method":"thread/realtime/transcript/done","params":{"role":"assistant","text":"Flywheel PROBE_OK"}}
```

逐条:

1. **会话建立** —— `thread/realtime/started`,携带 `realtimeSessionId`(注:该值与 `threadId` 相同,无证据表明它由后端另行签发)
2. **后端 VAD 听见了喂进去的音频** —— C1 中可见 `input_audio_buffer.speech_started`
3. **喂进去的音频被转写出目标语义** —— 与合成原话语义一致;`probe ok` 这个生造词在各次运行中被 ASR 写成 `Probook K.` / `Proboke` / `probe OK` 不等
4. **模型回话** —— `"Flywheel PROBE_OK"`
5. **音频返回** —— 5 个 `outputAudio/delta`,合计 96000 字节 PCM16/24k/mono = **2.00 秒**

30 个 `appendAudio` 请求(约 20 个音频 + 约 10 个静音尾)全部成功。

### 1.2 返回的音频确实是可懂语音

波形统计只能证明"非静音",不能证明"是说话声"。这两件事分开验:

- **非静音**(C2 输出 `C2-model-audio-out.wav`,sha256 `c4ed5243…`):48000 samples / 2.00s / RMS 2293.49 / peak 14542 / 44.93% 采样点振幅 > 200
- **可懂语音**(同一文件,独立离线 ASR):
  ```
  $ whisper C2-model-audio-out.wav --model base --language en
  [00:00.000 --> 00:02.000]  Flywheel Probe OK.
  ```
  与 assistant transcript `"Flywheel PROBE_OK"` 对应。

**是波形统计 + 独立 ASR 两条证据,不是单靠 RMS 下的结论。** C1 的输出音频亦留档(`C1-model-audio-out.wav`,sha256 `888c4de4…`,1.35s / RMS 2542.89 / peak 14484 / 68.26%)。

---

## 2. v3 的 access denial —— 证据与判断严格分开

### 2.1 观察到的错误文本(逐字)

```
failed to start realtime conversation: stream disconnected before completion: Voice session access denied.
```

JSON-RPC 通知形式:

```json
{"method":"thread/realtime/error","params":{"threadId":"019f91cc-3e70-7430-9ff1-ee743fe2998c","message":"stream disconnected before completion: Voice session access denied."}}
```

**留档 3 次**(`evidence/D1-`、`D2-`、`D3-`,三个不同 thread),参数均为 `version:"v3"` + `voice:"cove"` + `outputModality:"audio"`,均未收到 `started`。

### 2.2 这句话"来自后端"是强推论,不是 wire-level 证明

把 271MB codex 二进制完整 `strings -a`(另查 UTF-16LE):

| 字符串 | 命中 | 说明 |
|--------|------|------|
| `Voice session access denied` | **0** | 也查了 `Voice session` / `access denied` 片段,同为 0 |
| `stream disconnected before completion` | 1 | 本机 CLI 的包装词 |
| `failed to start realtime conversation` | 1 | 本机 CLI 的包装词 |

外层包装词在本地、内层短语不在本地 —— **强烈暗示 server-originated**。

**但这不是证明。** 该测试漏得掉:运行时字符串拼接 / format assembly、压缩或编码的字符串表、内嵌压缩 JS/WASM blob、动态生成,以及"远端只回 error code、本地映射成人话"。(该 binary 是签名的 thin arm64 Mach-O,只有常规 native section、无 sealed resource bundle,使"另有明文资源包"这一解释不太可能,但未排除其余路径。)

日志中**没有** WebSocket handshake、HTTP status 或 raw frame,因此不能说"不是 HTTP 响应",也不能说"后端先接了连接再关流"。`thread/realtime/start` 请求先返回的 `{}` 只是本地 app-server 对异步请求的 ack。

### 2.3 对照实验能说什么、不能说什么

| 实验 | version | voice | outputModality | 输入 | 结果 |
|------|---------|-------|----------------|------|------|
| A | v3 | marin | audio | — | **本地**音色校验失败(未到后端):`realtime voice 'marin' is not supported for v3` |
| B | v2 | marin | text | appendText | `started` ✅ |
| C1 / C2 | v2 | marin | audio | appendAudio × 30 | 全链跑通 ✅ |
| D1 / D2 | v3 | cove | audio | appendText | access denied |
| D3 | v3 | cove | audio | — (start 即 error,输入前中止) | access denied,event-driven 干净复现 |
| E1 | **v1** | cove | audio | — (started 后随即 error) | **后端接受了会话**(`started` 已发出),随后:`Quicksilver sessions require WebRTC.` |

**证据支持的**:

- v2 下 text 与 audio 两种 output modality 都能建立会话(B vs C)→ 可以排除"这个账号完全没登录"、"CLI 客户端一概不允许"、"audio 一概不允许"
- **v1 也过了准入**(E1):后端发出了 `thread/realtime/started`,失败发生在**之后**且原因是 transport 不对(v1 走 WebRTC,我用的是 WebSocket)。所以三个版本里 **v1、v2 都拿得到准入,只有 v3 被拒** —— 这让 v3 的拒绝比原先看起来更窄
- `version:"v3"` + `voice:"cove"` + audio 的组合,留档的 3 次尝试全部返回 access denial

**证据不支持的(上一版写错了,已删)**:

- ❌ ~~"A vs C 只差 version"~~ —— A 的 `marin` 对 v3 非法,A 比的是"本地参数校验失败"与"合法 v2 会话",根本没走到后端准入
- ❌ ~~"卡的是 v3 版本本身"~~ —— **v2 与 v3 的合法音色集不重叠**(见 §3.3),因此在本次实验设计下**无法把 version 与 voice 隔离开**。现有证据不能排除 voice family、version×voice、version×modality 交互
- ❌ ~~"拒绝与语音无关"~~ —— B vs C 只说明 v2 下两种 modality 都行,不能证明 v3 的拒绝与 audio modality 无交互
- ❌ ~~"D3 与 C2 输入路径一致"~~ —— D3 在 start 报错后即中止,**实际发送了 0 个 `appendAudio`**。D3 的价值是"消除了固定 sleep race 的干净 startup denial 复现",不是输入路径对照;拒绝发生在 startup,输入路径也帮不上归因

**因此,准确的表述是**:同一 client / 同一账号下,`v2 + marin` 的 text 与 audio 会话均成功;`v3 + cove` 的 audio 会话在留档的 3 次尝试中均返回 access denial。**现有证据不能进一步归因。**

对我们不挡路 —— v2 已足够跑完整语音会话。

> **旁证(不是解释,别当结论用)**:上游 issue #17158 提到语音可用性由 Statsig 服务端按账号 gate(有人同账号跨设备表现不同)。这与 v3 被拒**可能**同源,但那条 issue 讲的是桌面版、报错文本也不同 —— 只能算旁证,不能当作对本次现象的解释。

---

## 3. 复现步骤

### 3.1 环境 pin

```
requested   /Users/xiaorongli/.local/bin/codex
resolved    /Users/xiaorongli/.codex-infra-bot/packages/standalone/releases/0.145.0-aarch64-apple-darwin/bin/codex
sha256      1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590   (codex-cli 0.145.0)
probe sha256 6f7599cc046f8de31307f1744755e87e69fc53a438c966cf5bdecc11c5a02fb4
auth        auth_mode=chatgpt, plan=pro, subscription active until 2026-08-03
```

其中 **binary 与探针脚本的 path / hash** 由探针**自己 resolve + 计算**并写入 manifest(不是调用方声明的),见 `evidence/C2-manifest.json` / `D3-manifest.json`。auth 那一行**不在** manifest 里,是我另行读取 `auth.json` 所得(未留档,见 §8 诚实边界)。

> **一条必须记录的环境变动 —— 这个 symlink 在反复摆动**:`~/.local/bin/codex` 在本次工作期间被**多次**重写(观察到的 mtime:`18:09:50`、`19:02:15`),`.codex-infra-bot/packages/standalone/current` 亦同步变动。mtime 与 link 形态符合安装器/更新器行为,但**不能识别实际写入者**。
>
> - **摆动的是 resolved path**,在两套并存的 Codex 安装之间来回:
>   - Codex review R1/R2 时:`.codex-mufasa/.../bin/codex`
>   - C2/D3/G1/G2 运行时(manifest 实测):`.codex-infra-bot/.../bin/codex`
>   - 定稿期间又观察到摆回 `.codex-mufasa/.../bin/codex`(19:02:15),随后再次变动
>
>   本报告**刻意不记录"当前值"** —— 它在写作期间就变了好几次,任何"当前是 X"的断言都会立刻过期。
> - **没变的是内容**:上述每一个 target 的 SHA-256 都是 `1da3f4e0…`(同为 codex-cli 0.145.0),故**不影响任何实验结论** —— 这也正是探针改为"自己 resolve + 自己算 hash"的价值:每次运行到底跑的哪个文件,manifest 里是实测值而非事后推断。
> - ⚠️ **对后续工作的提醒**:因为 `~/.local/bin/codex` 是被争用的可变 symlink,复现时应直接 pin **versioned 绝对路径**,不要依赖它。
> - `codex-profile` 脚本对 `~/.local/bin`、`standalone/current` 或 symlink **零引用**(`grep -c "local/bin"` = 0,脚本自 2026-02-28 未改),因此该 symlink **不由 profile 切换管理**。
> - **诚实边界**:"不是本 session 所为"属于作者陈述(author attestation)—— 本 session 的命令记录未留档,下一位审计者无法从 evidence 独立复核这一点。

### 3.2 准备输入音频

```bash
say -v Samantha -o probe-in.aiff "Hello. Please reply with the words: flywheel probe ok."
afconvert -f WAVE -d LEI16@24000 -c 1 probe-in.aiff probe-in.wav
afinfo probe-in.wav        # 确认不是 0 字节音频
```

> ⚠️ macOS `afconvert` 会插入一个 `FLLR` 填充块 —— 该文件的 `data` 块实际从 **byte 4096** 开始,不是 44。**必须真正解析 RIFF 块**,不能假设 44 字节头部(第一版探针就踩了这个,见 §6)。探针现已 fail-closed 校验:**PCM 为空 / 非 16-bit / 非单声道 / 非 24kHz** 一律拒跑。

> 已知局限(Codex R3 指出,如实记录):探针**没有**读取 WAV 的 `audioFormat` tag,所以一个 format tag = 3(IEEE float)但 bits=16 的文件仍会通过校验;另外校验发生在 app-server spawn 之后。本次输入经独立解析与 `afinfo` 确认为 **format tag 1 / Int16 / mono / 24kHz**,故不影响任何实测结果。

### 3.3 两道门必须同时开 —— 有 negative control

两道门:

1. **命令行**:`codex --enable realtime_conversation app-server`
2. **协议**:`initialize` 时传 `capabilities.experimentalApi = true`

**各自关掉跑了一次,两条 negative control 都留了档**,错误信息不同:

| 实验 | 门1 `--enable` | 门2 `experimentalApi` | `thread/realtime/start` 的返回 |
|------|---------------|----------------------|------------------------------|
| G1 | ❌ 关 | ✅ 开 | `thread <id> does not support realtime conversation` |
| G2 | ✅ 开 | ❌ 关 | `thread/realtime/start requires experimentalApi capability` |
| C2 | ✅ 开 | ✅ 开 | `result: {}`(异步 ack),**随后**收到 `thread/realtime/started` |

G1/G2 都是在 `thread/realtime/start` 的 JSON-RPC response 里**同步**返回 `-32600`,没有任何 realtime `started` / `error` 通知 —— 也就是说,在 0.145.0 + 当前 config 下,**这两道本机 app-server 闸都是走到 realtime startup 的必要条件**。

**这两句都是本机 CLI 的闸,不是后端。** 精确地说:G2 那句**不是**以整句形式存在于二进制里,binary 里命中的是 format 模板 `"$ requires experimentalApi capability"` 加上单独命中的方法名 —— 即本地拼装而成(G1 那句带动态 thread id,同理)。这仍然支持"本地产生"的判断,但不能说成"整句在二进制里搜得到"。第一轮探针差点把 G2 误判成后端拒绝。

**音色必须配版本**,配错同样是本地拦截(实验 A):

- v1 组:`juniper maple spruce ember vale breeze arbor sol cove`(默认 `cove`)—— **v3 用这一组**
- v2 组:`alloy ash ballad coral echo sage shimmer verse marin cedar`(默认 `marin`)

两组**不重叠**,这也是 §2.3 里 version 无法与 voice 隔离的原因。

### 3.4 调用序列

```
initialize (capabilities.experimentalApi=true)
  → initialized 通知
  → thread/start                      拿 threadId
  → thread/realtime/start             {threadId, transport:{type:"websocket"},
                                       outputModality:"audio", voice:"marin", version:"v2"}
  → 等 thread/realtime/started 或 thread/realtime/error   ← 必须事件驱动,不能固定 sleep
  → thread/realtime/appendAudio       {threadId, audio:{data:<base64 PCM16>,
                                       sampleRate:24000, numChannels:1}}
  → 收 transcript/delta + outputAudio/delta
  → thread/realtime/stop
```

完整可跑脚本:`evidence/probe.mjs`。**在放有 `probe-in.wav` 的目录下运行**(脚本按相对路径读取,或用 `RT_IN_WAV` 指定):

```bash
# 注:$HOME/.local/bin/codex 是被争用的可变 symlink(见 §3.1),复现请 pin versioned 绝对路径:
CODEX=/Users/xiaorongli/.codex-infra-bot/packages/standalone/releases/0.145.0-aarch64-apple-darwin/bin/codex

# C2 —— v2 全链
CODEX_BIN=$CODEX \
RT_VERSION=v2 RT_VOICE=marin RT_MODALITY=audio RT_MODE=audio \
PROBE_LOG=C2.jsonl PROBE_MANIFEST=C2-manifest.json RT_OUT_WAV=C2-out.wav \
node probe.mjs

# D3 —— v3 denial 复现
CODEX_BIN=$CODEX \
RT_VERSION=v3 RT_VOICE=cove RT_MODALITY=audio RT_MODE=audio \
PROBE_LOG=D3.jsonl PROBE_MANIFEST=D3-manifest.json node probe.mjs

# G1 —— 门1(--enable)关
CODEX_BIN=$CODEX PROBE_NO_ENABLE_FLAG=1 \
RT_VERSION=v2 RT_VOICE=marin RT_MODALITY=audio RT_MODE=audio \
PROBE_LOG=G1.jsonl PROBE_MANIFEST=G1-manifest.json node probe.mjs

# G2 —— 门2(experimentalApi)关
CODEX_BIN=$CODEX PROBE_NO_EXPERIMENTAL_API=1 \
RT_VERSION=v2 RT_VOICE=marin RT_MODALITY=audio RT_MODE=audio \
PROBE_LOG=G2.jsonl PROBE_MANIFEST=G2-manifest.json node probe.mjs
```

### 3.5 尾部静音

C1/C2 喂完音频后补了 2 秒静音,服务端 VAD 随后收口并给出转写。**未做"不补静音"的 negative control**,所以这里只写观察到的操作经验,不断言"不补就一定拿不到转写"。

---

## 4. 协议是怎么摸出来的(schema 里没有)

`codex app-server generate-json-schema` 导出的 `ClientRequest` 有 89 个方法、**0 个 `thread/realtime/*` 请求方法**;server 侧有 8 个 realtime 通知。加 `--enable realtime_conversation` 重新导出,`ClientRequest.json` **字节相同**、方法集 diff 为空。

> 这是测量结果。至于"生成器把 under-development 请求方法过滤掉了" —— 那是**假设**,不是测量,本报告不把它当已证事实。

直接扫二进制的方法分发表才找到完整的客户端方法集:

```
thread/realtime/start        thread/realtime/appendAudio
thread/realtime/appendText   thread/realtime/appendSpeech
thread/realtime/stop         thread/realtime/listVoices
```

`ThreadRealtimeStartParams` 的字段名取自二进制内嵌的 TypeScript 符号表:

```
clientManagedHandoffs, flushTranscriptTailOnSessionEnd, codexResponsesAsItems,
codexResponseItemPrefix, codexResponseHandoffMode, outputModality,
includeStartupContext, initialItems, prompt, realtimeSessionId,
transport, version, voice
```

> 注:该符号表只列**可选**字段;必填字段不在其中(`threadId` 即是必填,靠实跑确认)。

---


## 4.5 被拒的准入绑在哪个身份维度?(Lead 追加问题,只读排查)

**问题**:这次走的是 `auth_mode=chatgpt` 的订阅身份。如果 Codex 支持 API key 身份,那是另一扇门 —— 被拒的是订阅这条路,不代表 OpenAI Realtime 这个后端对我们关门。

**只读结论:订阅身份不是 realtime 的门槛;CLI 里确实另有一条 API-key 路径,但它对 v3 有没有用,本次没验。**

### 证据

**① 订阅身份足以拿到 realtime 准入 —— 这是实测,不是推断**

本机 `auth.json` 的 `OPENAI_API_KEY` 为 `null`(全程未配置、未改动任何凭据),三个版本的实测结果:

| version | 准入 | 说明 |
|---------|------|------|
| v1 | ✅ 拿到 | `started` 已发出,之后因 transport 不符失败 |
| v2 | ✅ 拿到 | 全链跑通 |
| v3 | ❌ 被拒 | `Voice session access denied.` |

**所以"realtime 需要 API key"这个假设被实测证伪** —— 纯订阅身份在 v1/v2 上都进得去。

**② CLI 里确实存在一条 API-key 的 realtime 路径**

二进制里有两条只可能属于 API-key 路径的错误串,且带着源文件名:

```
core/src/realtime_conversation.rs   realtime conversation requires API key auth
                                    invalid realtime api key header
```

同时 realtime 的参数/上下文字段簇里 `apikey` 与 `chatgptAuthTokens` **并存**;两个 endpoint 形态也都在:`/v1/realtime`(公共 API,API-key)与 `/backend-api...realtime/calls`(ChatGPT 后端,订阅)。

这两条串在本次全部实验中**一次都没触发过** —— 与①一致:我们走的是订阅那条路。

### 判断(推论,与证据分开)

- 被拒的**不是**"订阅身份进不了 realtime" —— v1/v2 已证伪
- 被拒的是**这个账号 + v3 这个组合**
- 客户端**具备** API-key 路径的代码;但 **API-key 身份能不能拿到 v3,完全未验** —— 那需要真配一把 key,本次按约束**没有做**,也没有动任何凭据

### 对产品决策的意思

两周前横评里 OpenAI Realtime 赢的那条路,若走的是 API 身份,则**与本次被拒的维度不同** —— 本次结果不能用来否定它。要回答"API key 能不能开 v3",需要单独一次带 key 的验证,建议作为独立 follow-up,不要塞进本次一次性探针。

---
## 5. 边界 —— 没验的东西

明确不在本次范围,**不要**从本报告推断这些:

- 长会话稳定性、并发、断线重连
- WebRTC transport(只用了 WebSocket,按 issue 要求)
- 打断(barge-in)、多轮对话
- 延迟数字 —— 单次样本说明不了延迟特性,不写没有实测支撑的数
- **生产形态**:windowed TUI 下的同等能力(`CLAUDE.md` 要求的生产形态)
- Discord 端的编解码 / jitter / 背压 / 实际通话体验
- "不补静音就拿不到转写" —— 无 negative control(两道门的 negative control 已补,见 §3.3)

---

## 6. 探针自身的修正记录(第一版有 bug,已修)

Codex design review 两轮抓出第一版探针的问题,已全部修正并重跑:

1. **WAV 头部假设错误** —— 原脚本假设 44 字节头,实际 `data` 块在 4096(`FLLR` 填充块)。第一版把 4052 字节填充当 PCM 一起发了出去(仍被正确转写,但方法不干净)。现改为真正解析 RIFF 块,并 fail-closed 校验非空 / 16-bit / 单声道 / 24kHz(**不含** `audioFormat` tag,见 §3.2 已知局限)。
2. **固定 sleep 造成 race** —— 原脚本 `start` 后固定睡 6 秒,导致 D1/D2 在 `started` 尚未到达时就发了 `appendText`,不是干净的对照。现改为事件驱动等待 `started|error`,失败即中止输入(D3 即如此)。
3. **chunk 计数写错** —— 原报告写"20 chunks",实际连同尾部静音共 **30** 个 `appendAudio` 请求(全部成功)。
4. **binary provenance 是调用方声明的** —— 原脚本 `spawn("codex")` 走 PATH,manifest 里的路径/hash 只是转抄环境变量。现改为探针自己 `realpath` + 计算 sha256,并 spawn 那个 resolved 绝对路径;manifest 同时记录 requested / resolved / hash / 探针脚本自身 hash。(`CODEX_BIN` 为**建议传入**而非强制:未传时回落到 `which codex`,但无论哪种情况 manifest 里的 resolved path 与 hash 都是实测值。)
5. **证据记录方式** —— 每个音频 chunk(进、出)现在都记录 `index + decoded byte length + sha256`。

---

## 7. 证据清单

| 文件 | 内容 |
|------|------|
| `evidence/A-v3-marin-LOCAL-voice-validation-failure.jsonl` | A —— **本地**音色校验失败(不是后端拒绝) |
| `evidence/B-v2-text-session-started.jsonl` | B —— v2 + text,会话建立 |
| `evidence/C1-v2-audio-full-loop.jsonl` + `C1-model-audio-out.wav` | C1 —— v2 + audio 全链跑通(第一版探针)+ 输出音频 |
| `evidence/C2-v2-audio-full-loop-fixed-probe.jsonl` + `C2-manifest.json` + `C2-model-audio-out.wav` | C2 —— 同上,修正版探针 + 测量式 manifest + 输出音频(本报告数字取自此) |
| `evidence/D1-v3-cove-access-denied.jsonl` | D1 —— v3 access denial,第一次观察 |
| `evidence/D2-v3-cove-access-denied-repro.jsonl` | D2 —— 复现 |
| `evidence/D3-v3-cove-access-denied-clean-control.jsonl` + `D3-manifest.json` | D3 —— event-driven 干净 startup denial 复现(输入前中止,0 个 appendAudio) |
| `evidence/E1-v1-quicksilver-requires-webrtc.jsonl` + `E1-manifest.json` | E1 —— v1:后端接受准入,随后要求 WebRTC transport |
| `evidence/G1-no-enable-flag.jsonl` + `G1-manifest.json` | G1 —— 门1 negative control |
| `evidence/G2-no-experimental-api.jsonl` + `G2-manifest.json` | G2 —— 门2 negative control |
| `evidence/external-audio-in.wav` | 喂进去的外部音频(3.83s,sha256 `e3944fb4…`) |
| `evidence/probe.mjs` | 修正版探针脚本 |

> **关于日志性质的诚实说明**:这些 `.jsonl` 是**探针事件日志**,不是逐字节 raw stdout —— 脚本会过滤 `mcpServer/*` 等噪声通知、把音频 payload 换成 `index + 长度 + sha256` 记录(避免灌入 base64),并输出自算的 `STEP` / `RESULT` / `GATE-RESULT` 标签。上一版报告称其为"原始报文、未润色",**是错的,已更正**。音频完整性可经 manifest 中的 hash 核验。

已扫过无凭据泄漏。

---

## 8. 纪律

- 全程裸 `codex`,未用 `codex-with-fallback`(不触发轮换)。**作者陈述**:与上一条同理,这一点未留 command transcript,审计者无法从 staged evidence 独立复核;可复核的旁证是四份 manifest 里 `codexArgv` 均为 resolved binary 直接调用,不含 wrapper
- **未写** `~/.codex/config.toml`(mtime 仍为 2026-07-19,早于全部实验),只用 `--enable` 单次生效
- **未调用** `codex-profile`,未切账号。可从 evidence 独立复核的部分:`auth.json` mtime 早于全部实验(未观察到账号 auth 切换);§3.1 记录的 symlink 变动**不由** `codex-profile` 管理(该脚本对 `~/.local/bin` 零引用);**C2 / D3 / G1 / G2** 四次运行的 binary 内容(SHA-256)一致 —— 这四次有 hash-bound manifest;**A / B / C1 / D1 / D2** 五次早期运行**没有** binary provenance 留档,不在此列。**作者陈述(未留档、审计者无法独立复核)**:本 session 未执行过 `codex-profile` 任何子命令。旧的 A/B/C1/D1/D2 运行没有 exact-command 留档,因此"从未调用 profile/fallback"不能仅凭 staged evidence 证明
- 未撞 429 / 任何限流
- **B / C / D 各次运行**均 `stop` 并收到 `closed`;**A 与 G1/G2** 在本地校验或 start request 被拒后直接退出,日志中没有 `stop`/`closed`。进程均已清理
- 未改动任何产品代码或生产配置(本 PR 只含 `product/doc/` 下的文档与证据)
