# FLY-543 evidence — Gemini Live real E2E (converse face)

Issue: FLY-543 · phase: QA (post-round-3, Annie-requested real API sweep) · date: 2026-07-06
基于: `genaiConnector.ts` / `GeminiLiveBackend.ts`（分支 `flywheel-FLY-543` @ `05ec0e1a`）

Annie 明确要求"有 key 就用真的测、别 defer" + "要能看/能听"。这份文档记录**真
`@google/genai` Live transport**（非 mock）跑通的端到端证据，补 S0.2 spike + A3 部分
验收。**只验证，未改任何实现代码。**

## key 来源说明

`~/.flywheel/.env` 和 shell env 里都没有名为 `GEMINI_API_KEY` 的变量；Lead 指向
`~/.zshrc` 里的 `NANOBANANA_GEMINI_API_KEY`（原用于图像生成 skill）。本轮借用这把
key 做 Live API 验证——**key 的值全程未出现在任何 comm/Discord 消息里**，只在本机
子进程 env 里传递。

## ① 真连上 HTTPS + Gemini API（连接证据，非 mock）

用真 `@google/genai` SDK 的 `client.models.list()`（只读调用）核实这把 key 能真实
认证并拿到 Google 服务器当前的真实模型列表（非硬编码/非 mock 返回）：

```
$ node -e '... client.models.list() ...'
```
返回本 key 真实可用的 5 个支持 `bidiGenerateContent`（Live API）的模型（完整列表见
`real-live-models-list.json`，节选）：
```
models/gemini-2.5-flash-native-audio-latest
models/gemini-3.1-flash-live-preview
models/gemini-3.5-live-translate-preview
```
这是货真价实的一次 HTTPS 往返（认证 + 服务器返回其当前真实模型清单），不是本地
mock transport 能产生的结果。

### 顺带发现：config.ts 里钉的默认模型名已经 404

第一次跑用 `config.ts` 的 `DEFAULT_GEMINI_MODEL = "gemini-live-2.5-flash-preview"`，
真机连接得到**真实 API 错误**（而非我们自己模拟的）：
```
Gemini Live connection closed unexpectedly: models/gemini-live-2.5-flash-preview
is not found for API version v1beta, or is not supported for bidiGenerateContent.
```
这个模型名不在上面真实可用列表里——大概率是 preview 模型被 Google 下线/改名了
（plan.md r2 §4 S0.2 本就标注"能力漂移可追溯"，这正是要追的漂移）。**本报告只验证、
未修改 `config.ts`**；改成哪个真实模型名是 implement 阶段的决定，已单独报告 Lead。
后续测试改用真实可用的 `gemini-3.1-flash-live-preview`。

## ② Edge TTS 真机语音（能听的音频文件）

见 `poc-announce.md`——`real-edge-tts-output.mp3`（95616 bytes，ffprobe 确认合法
mp3、24kHz mono、15.9s，afplay 完整播放 exit 0）。

## ③ Gemini Live 真对话（喂录好的音频样本，拿真 API 响应）

**输入音频样本**：因为这台机器没有物理麦克风采集环节，用 edge-tts 合成一句清晰
提问"What is two plus two? Please answer with just the number."，转成 Gemini Live
input 要求的 16kHz mono PCM16（`sample-question.pcm`，157440 bytes ≈ 4.92s + 1.5s
静音让服务端 VAD 断句）——这是一段"录好的音频样本"的诚实替代品（非 Annie 本人声音，
下面会说明这跟真麦克风测试的边界）。

**测试脚本**：`gemini-live-e2e.mjs`——直接实例化真 `createGenaiTransport`（真
`@google/genai` WebSocket transport，非 mock）+ 真 `GeminiLiveBackend`，把音频样本
按 100ms 帧节奏喂进 `session.sendAudio()`，监听真实服务器事件。

**两次独立真机跑，结果一致**（模型 `gemini-3.1-flash-live-preview`）：

| 跑次 | ASR 识别（user transcript） | 助手回复（assistant transcript） | 助手音频 |
|------|------------------------------|-----------------------------------|----------|
| #1 | "What is 2 + 2?" | "4" | 5 个 chunk，共 32670 bytes pcm16/24kHz |
| #2 | "What is 2 + 2?" | "4." | 5 个 chunk，共 35042 bytes pcm16/24kHz |

真实事件序列（#2，见 `gemini-live-e2e-events.json`）：
`transcript(user,"What is 2 + 2?")` → `response-started` →
`transcript(assistant,"4.")` → 5× `response-audio` → `response-done`。

**助手回复音频落盘 + 独立核验**（`gemini-live-response.pcm` → 转 `gemini-live-
response.wav`）：
```
ffprobe: pcm_s16le, 24000 Hz, mono, duration=0.73s, size=35120 bytes
file:    RIFF (little-endian) data, WAVE audio, Microsoft PCM, 16 bit, mono 24000 Hz
afplay:  exit 0（完整播放，~1.2s 含进程开销）
```
音频时长（0.73s）与"4."这个极短回复相符；且音频与文字 transcript 来自**同一个真实
服务器会话**（Gemini 自己的 `outputAudioTranscription` 逐字对应它刚合成的音频），
不是两个独立、可能对不上的产物。

## 这东西现在怎么用（供 Annie 参考）

- 想亲耳听：`real-edge-tts-output.mp3`（播报女声）、`gemini-live-response.wav`
  （Gemini 说"4."）——文件在本 Runner 工作区的 evidence 目录旁的临时证据文件夹，
  Lead 会把路径/文件转交。
- 想复现：`packages/voice-core` 下 `node dist/cli.js say --stdin` 是 Edge TTS 播报
  的正式 CLI 入口；Gemini Live 目前正式入口是 `talk`（真麦克风），本报告的
  `gemini-live-e2e.mjs` 是绕开麦克风、直接喂音频样本的验证脚本，不是产品入口。

## 还差什么——需不需要 Annie 亲自用真麦克风说一遍？

**已经被这轮验证覆盖、不需要 Annie 再测的部分**：
- 真连上 Gemini Live API（非 mock）——✅ 已证。
- ASR 把语音正确转成文字——✅ 已证（"What is 2 + 2?"识别准确）。
- 模型给出正确、连贯的语音回复（含合成音频）——✅ 已证（"4"/"4."，音频可听）。
- Edge TTS 播报面全链路真机可用——✅ 已证（round 2/3 QA + 本报告两条独立路径）。

**只有 Annie 真人 + 真麦克风才能测出来的部分（本报告结构性测不到）**：
- **真实硬件采集链路**：本测试用的是 edge-tts 合成后转码的音频样本，不是真麦克风
  实时采集的波形（真麦克风有环境噪声、设备增益、编解码路径，跟"喂一段干净合成音频"
  不是同一回事）。
- **Annie 本人的声音/口音/语速**：ASR 对合成女声的识别率不能代表对 Annie 真实说话
  的识别率。
- **真实时打断（barge-in）体验**：`gemini-live.test.ts` 里 barge-in 合同是对
  mock transport 验证的（round 2/3 已确认），但"Annie 说话说到一半、系统真的会不会
  被她的声音打断"这件事只有真人真麦克风连续对话能测出来——这正是 plan.md 里点名
  留给 founder-acceptance 的那部分（POC-B ≥3 轮真对话 + 打断 + resume）。

**建议**：本报告已经证明"真 API 全链路能通、ASR+回复质量过关"，技术风险基本清零；
如果 Annie 只是想确认"这东西真的连得上、说得对"，本报告已经够。如果她想亲身体验
"跟它说话是什么感觉"（打断顺不顺、听感自然不自然、她自己的口音识别准不准），那部分
只能她本人用真麦克风试——这是体验验收，不是技术验收，建议留给她自己判断要不要做。

---

## 追加：完整产品流程真机测试（含 ask_lead 工具调用），抓到一个真发现

Annie 追问"QA 到底测了什么、要设计一个真正的 end-to-end"。上面①②③是"裸的语音
往返"（问 2+2 这种玩具问题，没有走真实产品要用到的"问项目问题→咨询 Lead 大脑→
Lead 真回答→说给你听"这条链路）。这里补一个更贴近真实用法的测试：用真
`HeadlessClaudeBrain`（真 `claude -p` 子进程、零工具、`flywheel-eng-lead` 的真
`identity.md` persona）接进真 Gemini Live session，让它在必要时调用 `ask_lead`
工具去问真的 Lead 大脑，再把答案说出来。问题是真人会问的那种："Hey, can you
briefly tell me what FLY-543 is about?"（录音样本同上，edge-tts 合成转码）。

### 结果：两次真机跑，`ask_lead` 都没有被成功调用

| 跑次 | 结果 |
|------|------|
| #1 | Gemini **没调用工具，直接瞎编**："Fly543 is a domestic airline in Kenya. What specifically would you like to know about it?"（真实、可听，见 `gemini-live-full-e2e-events.json`）|
| #2（加强 systemHint,明确要求"提到项目代号必须先调用 ask_lead,不许瞎猜"）| Gemini **似乎尝试了什么但失败**："One moment while I look into that for you. It seems I had a slight issue connecting to the system. Can you repeat your question so I can try again?"（音频：`gemini-live-full-e2e-response.wav`,7.6s,afplay 确认可听）|

两次都**没有**产出 `tool-call` 事件——也就是说,如果这就是真实产品此刻的样子,Annie
问"FLY-543 什么情况"这种真实场景,系统现在**要么瞎编答案,要么卡壳说连接出问题**,
真正的 Lead 大脑从未被真正问到。

### 根因定位：真实原因很可能是 `genaiConnector.ts` 里 `ask_lead` 的工具声明缺 schema

用绕开 `genaiConnector.ts`（不走仓库代码,直接用 `@google/genai` 原始 SDK,只是为了
定位问题,**没有改任何仓库文件**）的调试脚本对照测试，同一句提问、同一个 systemHint：

| 工具声明 | 结果 |
|----------|------|
| `genaiConnector.ts` 现状：`{ name: "ask_lead" }`（**没有 `parameters`/`description`**）| 真机复现两次：一次瞎编、一次"连接出问题"说不出话——**从未真正触发工具调用** |
| 补上标准 JSON schema：`{ name: "ask_lead", description: "...", parameters: { type: "OBJECT", properties: { question: {type:"STRING"} }, required:["question"] } }` | **真机复现：工具调用成功**——`{"toolCall":{"functionCalls":[{"name":"ask_lead","args":{"question":"What is FLY-543 about?"},"id":"..."}]}}`（见 `gemini-raw-debug-messages.json`）|

`genaiConnector.ts:56-59` 现在的声明：
```ts
tools: [
  { functionDeclarations: [{ name: params.toolNames[0] ?? "ask_lead" }] },
],
```
**没有 `parameters` schema**——真实模型在这种"零 schema"的函数声明下，大概率因为
不知道该传什么参数形状，要么完全不调用（直接瞎猜答案），要么尝试调用但失败/被
模型自己感知为"连接出问题"。补上标准 JSON schema 之后，同一个真会话立刻能正确
调用工具。

**这是单测测不出来的一类 bug**：`gemini-live.test.ts` 的 mock transport 是直接
模拟"SDK 发出了一个 tool-call 事件"，从来不需要一个真实模型自己决定要不要调用、
怎么调用——所以"函数声明缺 schema 导致真模型不会用这个工具"这件事，只有打真实
API 才会暴露。

### 结论

- **只验证、没有改任何实现代码**——上面的 schema 补丁只存在于我本机的临时调试脚本里
  （已删除，不在仓库中），仓库里的 `genaiConnector.ts` 一个字节没动。
- 这是一个**真实的、可复现的产品质量问题**：`ask_lead` 这条"语音问项目问题 → 真
  Lead 大脑回答"的核心体验，现在的实现在真实 API 下大概率不可靠。建议下一轮
  implement 给 `genaiConnector.ts` 的 `ask_lead` 函数声明补上 `parameters`/
  `description` schema，再重新走一遍这个真机测试确认修好。
- 这不是本轮 QA 该动手修的范围（"只验证、别改实现"），已如实报告 Lead。

---

## 追加：Annie 真麦克风试用（`talk` 命令）—— 抓到第三个真实 bug，两条独立故障

Annie 决定现场对着真麦克风试基础对话。用 `node dist/cli.js talk --lead flywheel-eng-lead` 起了真会话（真 GEMINI_API_KEY、真 `--device` 麦克风采集、真 StreamPlayer 放音）。**她说话，系统全程没反应。** 排查发现两个独立的真实 bug，不是同一个原因：

### bug A（已确认根因 + 已现场修复验证）：默认麦克风设备选错了

`MicCapture.ts` 默认用 ffmpeg avfoundation 设备索引 `":0"`（源码注释写的是"default audio device"，这个注释是错的/误导性的）。用 `ffmpeg -f avfoundation -list_devices true` 查这台机器真实设备列表：

```
[0] MacBook Pro Microphone
[1] LG UltraFine Display Audio
[2] DJI MIC MINI
```

`:0` 对应笔记本自带麦克风，**不是** macOS 系统层面设成"默认输入设备"的 DJI Mic Mini（那是 `:2`）。avfoundation 的设备编号和 macOS 系统级"默认输入设备"这两套体系不是一回事——代码默认值 `":0"` 从一开始就没连到 Annie 真正说话的那个麦。

现场验证：单独用 `ffmpeg -f avfoundation -i :2 ... -t 2 out.wav` 真录了 2 秒，`volumedetect` 显示 `mean_volume: -50.9dB / max_volume: -39.5dB`（真实环境噪声信号，不是权限拒绝那种全零静音），排除了 macOS 麦克风权限问题。补 `--device ":2"` 重启后，进程正常监听（ffmpeg 真的挂在 `:2` 上），**这部分已现场确认修复**。

### bug B（Lead 独立发现，未及验证是否被 bug A 掩盖）：`talk` 命令不处理 session 过期重连

原始（bug A 修复前的）会话日志出现两次 `[session expiring in ~50s]`。查 `cli.ts` 的 `runTalk()`：
```ts
session.on("session-expiring", ({ inSec }) =>
  process.stderr.write(`  [session expiring in ~${inSec}s]\n`),
);
```
只打印警告，**没有用 `GeminiLiveSession.close()` 返回的 resume handle 做任何重连**——即使 `GeminiLiveBackend`/`GeminiLiveSession` 本身支持 session resumption（`gemini-live.test.ts` 测过 resume 合同），`talk` 这个 CLI 命令从未真正调用它。会话到期只是被晾在那不再工作，直到用户 Ctrl+C。

**诚实说明因果关系，不夸大**：bug A 修复后的新会话（`--device ":2"`）只运行了约 40 秒就因为 Annie 决定停止测试（不想再花钱）被我按指示杀掉，**从未真正等到有人对着它说话**，所以无法确认"修好麦克风之后，基础对话本身是否能跑通"——修 bug A 是否已经足够让基础对话可用，这一点还没有独立验证过。bug B（session 过期不重连）是一个真实存在、代码审查即可确认的缺口，但它是否是"这次 demo 没反应"的直接原因还是未知——第一次会话本身就没在监听正确的麦克风，所以"她说话时正好话赶话撞上过期"这个因果链目前无法证实，也无法排除。

### 结论

- **确认 + 已验证修复**：默认麦克风设备索引错误（bug A）。
- **确认存在、未验证影响范围**：`talk` 命令 session 过期不自动重连（bug B）。
- 两个都还没有真正被"完整走完一次真人对话"验证过——demo 已按 Annie/Lead 指示终止（不再继续花钱测试），进程已全部清理干净。
- 只验证、未改任何实现代码。
