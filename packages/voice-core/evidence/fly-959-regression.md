# FLY-959 evidence — 4 处已知 bug 修复的真机回归

Issue: FLY-959 · phase: implement (Task 8) · date: 2026-07-07
基于: `engineering/doc/FLY-959-voice-core-bugfixes/plan.md`（分支 `flywheel-FLY-959`）

按 543 的直接教训（mock 测不出这 4 类 bug），全部验收打**真 Gemini Live API**（真
`@google/genai` WebSocket transport，非 mock）。key 沿用 543 的借用方案
（`~/.zshrc` 的 `NANOBANANA_GEMINI_API_KEY`），**key 值全程不落任何文档/消息**。

## 执行环境说明（诚实边界）

本轮回归由 headless implement Runner 在凌晨自治执行：**系统扬声器静音 + Annie 在睡 +
DJI MIC MINI 发射器未开机（`:default` 采集实测 -91dB 数字静音）**。Lead（Tadashi）
明确裁决：不允许解除静音外放合成语音做声学回环。因此拆成两条互补路径，合并覆盖
R1-R4；**唯一没跑的是"声音经空气进麦克风"的声学环节**（白天 Annie 在场 5 分钟可补，
这也是 543 就划给 founder-acceptance 的体验验收边界）：

- **Session 1（真 CLI + 真麦克风路径）**：`node dist/cli.js talk` 原样跑，真 ffmpeg
  avfoundation 采集真实设备、真 API 连接 — 覆盖 R1 设备选择 / R2 续期 / R4 默认模型。
- **Driver（真 API + 真 rotator + 真 brain，喂音频样本）**：与 543 的
  `gemini-live-e2e.mjs` 同款方法，唯一替代是音频源（edge-tts 合成的 16kHz PCM 代替
  实时麦克风帧）— 覆盖 R2 跨续期问答 / R3 ask_lead / R4。

## R1 — mic 默认设备跟随系统默认（bug 1）

本机设备表（`ffmpeg -f avfoundation -list_devices true -i ""`，2026-07-07）：

```
[0] MacBook Pro Microphone
[1] LG UltraFine Display Audio
[2] DJI MIC MINI      ← macOS 系统默认输入（system_profiler: Default Input Device: Yes）
```

**证据 1（CLI 全链路）**：`node dist/cli.js talk --lead flywheel-eng-lead --project
<主仓> `（**不带 --device**，经 `FLYWHEEL_VOICE_FFMPEG` 指向加 `-loglevel debug` 的
包装脚本观察），ffmpeg debug 输出：

```
[in#0 @ 0xca4c0c000] audio device 'DJI MIC MINI' opened
```

打开的是**系统默认输入**（DJI），不是旧默认 `:0` 会打开的内置麦。整个 session
（含一次 goAway 续期）ffmpeg 只 spawn 一次 = "mic 不随 session 轮换重启"的设计得证。

**证据 2（对照）**：同机直接对比两种 input spec（各真录 2s，均产出真实 PCM 字节）：

```
-i ":default" → audio device 'DJI MIC MINI' opened          （新默认，= 系统默认）
-i ":0"       → audio device 'MacBook Pro Microphone' opened （旧 bug 行为）
```

**判定：PASS**（设备选择语义修复得证）。附注：QA 曾验 `--device ":2"` 有效，本轮
`--device`/`FLYWHEEL_VOICE_MIC_DEVICE` 透传有单测覆盖（`audio.test.ts`/
`config.test.ts`）。声学收音质量（真人对麦说话）留 founder 白天补。

## R2 — talk session 过期自动续期（bug 2）

**证据 1（真 CLI + 真麦克风，Session 1）**：session 挂机 ~10 分钟后 stderr 出现：

```
  [session expiring in ~50s — renewing]
  [session resumed]
```

543 的原始故障画面正是"两次 `[session expiring in ~50s]` 然后什么都不发生"；现在
goAway 触发 close() → 取 resume handle → 重连成功。续期后无任何 error 事件，
Ctrl+C(SIGINT) 干净收尾（node + ffmpeg 进程零残留，实测 ps 确认）。

**证据 2（跨续期问答，Driver，`fly-959-e2e-events.json`）**：真 API 会话（持续送
100ms 静音帧模拟真麦克风节奏）在 **540.5s** 收到 `session-expiring {inSec:50}`，
rotator **191ms 内**完成 close→取 handle→resumed（`[session resumed]`）；续期后
**5 秒**内送入问题 B，模型正常 ASR + 触发 tool-call + 语音回答 —— "resume 后再问
一句、有回答"成立。

Driver run-1 顺带证实边界行为符合设计：喂完问题后停止送帧 → 服务端 ~160s 断掉
input-idle 连接 → 以显式 error 事件浮出（scope 内"意外断连不重试、只显式上抛"的
既定合同），真麦克风持续送帧则无此问题（run-2 + Session 1 均活到 goAway）。

**判定：PASS**

## R3 — ask_lead 带完整 schema 后真模型真调用（bug 3）

Driver 用真 `HeadlessClaudeBrain`（真 `claude -p` 子进程、零工具、
`flywheel-eng-lead` 真 identity.md）+ 真 Gemini Live session，语音问
"Hey, can you briefly tell me what FLY 543 is about?"（edge-tts 合成 16kHz PCM，
543 同款样本方法——543 当时同一问题两次跑**从未**触发 tool-call，一次瞎编
"肯尼亚航空公司"、一次卡壳）：

```
[540.5s] session-expiring {"inSec":50}
[540.7s] rotator [session resumed]
[545.9s] user ASR: "Hey, can you briefly tell me what Fly 543 is about?"
[545.9s] tool-call {"callId":"fc_6478266169522919146","name":"ask_lead"}   ← 543 从未出现过的铁证
[566.5s] assistant（语音+transcript）: "I don't have any information..."（9 个真音频 chunk）
```

- **tool-call 真实触发**（必需铁证，543 的原始故障就是零 schema 下模型从不调用）。
- **答案确实来自真 brain**：单独跑同一 `HeadlessClaudeBrain`（真 `claude -p`、同
  identity.md）问同一问题，回答同义："Honestly, I don't have FLY-543 in front of me
  right now... I've got no tools here to hit Linear... So I don't want to guess and
  tell you something wrong." —— 模型语音播出的正是 brain 的诚实回答，**不再瞎编**
  （对照 543 的"FLY-543 是肯尼亚航空公司"幻觉）。
- 诚实边界：零工具 brain 本来就查不了 Linear，"诚实说不知道 + 指路正确渠道"是该
  persona 的正确行为；"brain 能答出 FLY-543 细节"需要带工具的 brain，超出本 issue
  的 4 个 bug 范围（543 已定 POC 边界）。

**判定：PASS**（schema 修复使真模型真调用工具、真 brain 真被问到、回答不再编造）

## R4 — 默认模型直连（bug 4）

- implement 动手前（Task 0）用真 key 重跑 `client.models.list()`：
  `models/gemini-3.1-flash-live-preview` 仍在 `bidiGenerateContent` 支持列表
  （5 个模型，与 `real-live-models-list.json` 快照一致）。
- Session 1 与 Driver 都**不设** `FLYWHEEL_VOICE_GEMINI_MODEL`，用 config 新默认
  `gemini-3.1-flash-live-preview` 直连成功、全程无 "not found" 错误。
- 旧模型名的 404 自救指引（`describeUnexpectedClose`）有单测覆盖
  （`genai-connector.test.ts`，用 543 抓到的真实 API 错误原文断言）。

**判定：PASS**

## 单测 / lint / build

- `pnpm --filter flywheel-voice-core test`：**88 passed**（543 基线 71 + 本 issue 新增 17）
- `pnpm --filter flywheel-voice-core typecheck`：0 error
- 全仓 `pnpm lint`（biome）：0 error
- `pnpm --filter flywheel-voice-core build`：干净

## 发现的相邻问题（超本 issue 范围，建议 follow-up）

真机事件流（543 两份捕获 + 本轮 driver 两跑）显示：真实服务器**从不**在带
transcription 的消息上同帧携带 `turnComplete`，所以 `LiveServerEvent.transcript`
的 `final` 恒为 false → `cli.ts` 里 `if (final)` 才打印的 `you:` / `lead:` 行在真会
话中**永远不会出现**（543 QA 也从未真正见过它打印——当时 mic 根本没通）。功能本身
不受影响（transcript 事件、JSONL sink、语音回答都正常），但 founder 用 `talk` 时
终端会"什么都不显示"，容易误判为坏了。修法涉及 transcript 聚合/显示语义（backend
映射层），超出本 issue 的 4 个 bug 与"不重构 cli.ts"的 scope 边界 → 已报 Lead，
建议单开 issue。

## 证据文件

| 文件 | 内容 |
|------|------|
| `fly-959-e2e-events.json` | Driver 全事件流（transcript/audio/tool-call/rotator，含时间戳） |
| （本文件内嵌） | Session 1 关键日志行、设备对照输出 |

音频类：Driver 的助手回复以 `response-audio` 字节数记录在事件流里（session 播放面
543 已验，本轮不重复落盘 wav）。
