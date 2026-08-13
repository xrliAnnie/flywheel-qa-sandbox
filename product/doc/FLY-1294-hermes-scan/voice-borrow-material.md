# FLY-1294 素材 — Hermes 的 Voice 怎么实现 + 我们哪块能接

Issue: FLY-1294
日期: 2026-07-15
用途: **给 Honey Lemon 拿去跟 Tadashi 聊 + 建 Voice issue 的素材**(不是 PRD、不是结论)
基于: research.md §2.1(已核实)+ 我们这侧 packages 扫描
口径: **我们的现状我不知道 → 一律标『待 Tadashi 补』,不推断。** license/链接为真。

> **这份只答一半**:Annie 要的两件事里,②「他们的 Voice 怎么实现」= 本文;①「我们现在做到什么程度」= **在 Tadashi 手里,我没有**。

---

## §1 他们的 core 语音(半双工)

repo: [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) · **MIT** · docs: [voice-mode](https://hermes-agent.nousresearch.com/docs/user-guide/features/voice-mode)

| 维度 | 实现 | 对我们的意义 |
|---|---|---|
| **STT** | 本地 **`faster-whisper`(免费、无需 key)** / Groq / OpenAI / Mistral / xAI | ⭐ **免费本地 STT 兜底**是个好锚 —— 我们要不要也留一条零成本路径?**待 Tadashi 补:我们现在用什么 STT** |
| **TTS** | **Edge TTS(免费)** / ElevenLabs / OpenAI / NeuTTS | ⭐ 同上:**免费 TTS 兜底**;我们已知在做 ElevenLabs(`/eleven`)。**待 Tadashi 补:我们 TTS 现状** |
| **入口** | CLI(`Ctrl+B` 录音)/ Telegram / Discord / ⭐ **Discord 语音频道(bot 进 VC → 听 → 转写 → 回话)** | ⭐⭐ **这条对我们最相关** —— 我们是 Discord-native。**待 Tadashi 补:我们 Discord VC 现状** |
| **turn-taking** | **3.0s 连续静音触发** + **echo prevention(放 TTS 时暂停 listener = 不误录自己)** | ⭐ 「不误录自己」的**最简解法**:放音时直接停 listener。**待 Tadashi 补:我们怎么防自录** |
| **形态** | **半双工顺序模型**(说完→答;无同时说话/打断) | 他们 core **没有**真打断 → 真打断在插件(§2) |

**可借颗粒度**:**【思路可借】** —— 多-provider 抽象 + 免费兜底 + echo prevention 的做法;不是整包搬。

## §2 他们的全双工实时语音(独立插件)⭐ 最能借的一块

repo: [bielcarpi/hermes-live-voice](https://github.com/bielcarpi/hermes-live-voice) · **MIT** · npm 包

| 能力 | 实现细节 | 对我们的意义 |
|---|---|---|
| **双 provider** | **Gemini Live** / **OpenAI Realtime**(+ mock 模式,无凭证也能测) | ⭐ **mock 模式**这条工程上很实用(CI/离线测语音) |
| **真打断 barge-in** | provider 停播放,**与后台任务执行解耦**;`/interrupt` 只停说话、**不取消已接的活** | ⭐⭐ **「停嘴 ≠ 停活」这个解耦是关键设计** |
| **durable 后台任务** | 说话时任务后台跑;状态落 `~/.hermes/hermes-live/tasks-v1.json`;**断线重连不丢**(reconnect 后对账) | ⭐⭐ 正对 Annie「说话时它还在干活」的诉求 |
| **窄边界(防越权)** | provider **只能调 4 个工具**:`start_background_task` / `list_background_tasks` / `get_background_task` / `stop_background_task` | ⭐⭐ **安全设计值得抄** —— 语音模型拿不到全工具面/凭证 |
| **稳定性三件** | **silent recovery**(重连自动对账不丢状态)/ **no auto-recording**(用户显式控制何时收音)/ **fail-closed 审批**(v0.5 宁可拒绝待批也不猜) | ⭐ 正对 Annie 说的「静默恢复 / 不误录自己 / 审批弹窗不消失」 |
| **客户端** | **无依赖 browser SDK**(麦克风采集 + 重连逻辑)+ dashboard 插件 + 终端文本客户端 | ⭐ browser SDK 可直接读/参考 |
| **架构** | Realtime session 层 + **durable supervisor**(先落盘再执行 + 对账)+ WebSocket 网关(JSON/PCM16)+ 本地 JSON 任务存储;经 SSE + 周期对账桥到 Hermes `/v1/runs` | 骨架清晰,**可当参考实现** |
| **已知边界(他们自己标的)** | 任务**扛得住客户端断线,扛不住 Hermes 重启**;上游 run 状态丢了结果变 `unknown`;**本地状态文件不支持多节点** | 诚实:**不是成熟品**(beta v0.5) |

**可借颗粒度**:**【骨架/整包可评估】** —— MIT、npm、browser SDK 无依赖。**但集成需自己验证,不是保证 drop-in。**

## §3 映射到我们(⚠️ 一半是空的)

我们这侧**我只扫到包存在**,**做到什么程度不知道**:

| 我们的包 | 我扫到的 | 可对接他们哪块 | 借法 |
|---|---|---|---|
| `packages/voice-core` | 存在;有 `backends/` `audio/` `brain/` `TalkSessionRotator.ts` `cli.ts` | 他们 core 的**多-provider STT/TTS 抽象** + **免费本地兜底** | 【思路可借】 |
| `packages/voice-bridge` | 存在;有 `roomEars.ts` `assistant/AssistantLanding.ts` `config.ts` | 他们的 **Discord VC 进场听→转写→回话** + **echo prevention** | 【思路可借】 |
| `packages/voice-headphone` | 存在 | 他们的 **browser SDK**(麦克风采集 + 重连) | 【骨架可参考】 |
| **(全局)** | 我们有 barge-in/interrupt 相关代码(grep 命中) | 他们的 **「停嘴 ≠ 停活」解耦** + **durable 后台任务** + **窄 4-tool 边界** | 【骨架可参考】⭐ 最值得聊 |

**❗ 待 Tadashi 补(我不知道、不推断)**:
1. 我们语音**现在做到什么程度**(能跑通哪条链路?哪些是 demo/哪些上生产?)
2. 我们**现在用什么 STT/TTS**、有没有免费兜底
3. 我们的 **Discord VC** 现状(进得去 VC 吗?听得到吗?—— 已知 memory 里有「ears UDP 收音坏」的坑)
4. 我们有没有 **durable 后台任务**(说话时任务后台跑、断线重连不丢)
5. 我们**怎么防自录 / 怎么打断**
6. Annie 说的「初步版本做得差不多但还有很多问题」—— **具体哪些问题?**

## §4 给 Tadashi 聊天用的几个具体问题(建议,你定)

1. 他们「**停嘴 ≠ 停活**」(`/interrupt` 只停 provider 说话、不取消已接任务)—— 我们现在打断是停什么?
2. 他们 **durable supervisor**(先落盘再执行 + 重连对账 + `tasks-v1.json`)—— 我们断线重连丢不丢状态?
3. 他们 **窄 4-tool 边界**(语音 provider 只能起/查/停后台任务)—— 我们语音层能碰多大工具面?有没有越权风险?
4. 他们 **echo prevention = 放 TTS 时暂停 listener** —— 我们防自录怎么做的?
5. 他们**免费本地 STT(faster-whisper 无 key)+ 免费 Edge TTS** 当兜底 —— 我们要不要留零成本路径?
6. 他们自认边界:**扛断线、不扛 Hermes 重启**、本地状态不支持多节点 —— 我们这两条呢?

## §5 诚实台账

| 项 | 状态 |
|---|---|
| 我们的语音现状 | **UNKNOWN — 待 Tadashi**(我只扫到包名/文件名,没读实现、没跑) |
| hermes-live-voice 我有没有实跑 | **没有** —— 只读了 repo README/文档 + 元数据(MIT / **11 star**(gh api 实测 2026-07-15)/ 今天还在推) |
| 它的成熟度 | **beta v0.5,star 数很小(11;gh api 实测 2026-07-15)** —— 跟 core(215,445,同源实测)不是一个量级;**「MIT 可借」≠「成熟可靠」** |
| 全屏语音 UI / 语音队列 归属 | **UNKNOWN**(Annie XHS 提到,我核不到具体在哪个客户端) |
| 版本/时效 | 元数据为 2026-07-15 实测;插件仍在快速迭代,**用前请重核** |
