# FLY-545 S1 spike 证据 — Gemini Live TEXT 模态验证 + 延迟量测
Issue: FLY-545 (URL 不可得,只写 issue 号)
日期: 2026-07-07
基于: plan.md §7 P0-S1(spike 脚本 = engineering/spike/FLY-545-huddle/,throwaway 不进包)

## 结论(TL;DR)

**D1-B(TEXT 模态 + edge-tts)不可行:当前所有 Gemini Live 模型都不支持 TEXT 响应模态,
服务端明确拒绝。** 触发 plan §7 P0-S1 的「停,报 Tadashi」检查点,降级位 = **D1-A(audio
直出主持 bot,plan 附录 A 保留通路)** — audio 模态延迟实测 **797-1017ms 首 audio chunk**,
落在 PRD §15「≤1.2s 可接受」带内,且输入转写(TIV 字幕依赖)在 audio 模态下照常下发。

## 1. TEXT 模态验证(判据①)— FAIL

脚本:`engineering/spike/FLY-545-huddle/s1-text-modality.mjs`(真实 16k mono PCM 按 20ms
帧节奏实时推流,3 轮)。

服务端关闭原因(逐字,out/s1-events.jsonl):

```
The requested combination of response modalities (TEXT) is not supported by the model. models/gemini-3.1-flash-live-preview
```

全量 bidiGenerateContent(Live)模型探测(2026-07-07,client.models.list() + 逐个空连接
TEXT 模态,脚本内嵌于会话记录):

| 模型 | TEXT 模态 |
|------|-----------|
| gemini-3.1-flash-live-preview(config 钉的现役模型) | ❌ 服务端拒绝(上面原话) |
| gemini-2.5-flash-native-audio-latest | ❌ 同样拒绝 |
| gemini-2.5-flash-native-audio-preview-09-2025 | ❌ 同样拒绝 |
| gemini-2.5-flash-native-audio-preview-12-2025 | ❌ 同样拒绝 |
| gemini-3.5-live-translate-preview | 连接即关(no reason);翻译特化,非对话模型,不适用 |

半级联(half-cascade)一代模型(gemini-live-2.5-flash-preview / gemini-2.0-flash-live-001,
曾支持 TEXT)已全部退役 — 与 FLY-959 的模型退役经验一致。**TEXT 模态在当前模型面上物理不存在。**

## 2. AUDIO 模态延迟量测(D1-A 口径 + 混合口径同场量出)

脚本:`engineering/spike/FLY-545-huddle/s1-audio-modality.mjs`(同一段 3.8s 中文问话,
`帮我看一下,Huddle 模式今天能不能用?`,3 轮,20ms 帧实时推流,尾部持续静默帧)。

模型 = gemini-3.1-flash-live-preview;`responseModalities:[AUDIO]` +
`inputAudioTranscription:{}` + `outputAudioTranscription:{}`:

| 轮 | speech-end→首 audio chunk | speech-end→首 output 转写 | 输入转写 | 模型回答(output 转写) |
|----|---------------------------|---------------------------|----------|------------------------|
| 1 | **900ms** | 900ms | ✓ | 「我查一下系统状态。你稍等。」 |
| 2 | **1017ms** | 1017ms | ✓ | 「目前看接口是通的,应该没问题。你那边有报错吗?」 |
| 3 | **797ms** | 797ms | ✓ | 「刚才确认了,系统服务正常,可以用。你直接跑脚本试试。」 |

- **输入转写在 audio 模态下照常下发**(3/3 轮,字级增量)→ TIV 字幕依赖成立(判据①的
  audio 模态版)。
- 输出转写与首 audio chunk 同时到达(同一 server message)→「audio 丢弃 + output 转写→
  edge-tts」混合路线没有先发优势。
- 模型行为自带「长答先 ack」(轮 1 原话「我查一下系统状态。你稍等。」)— §15 的 ack 合同
  在 audio 模态是模型原生行为。

## 3. edge-tts 本机复测(混合路线的加法项)

`edge-tts --voice zh-CN-YunxiNeural`(一句典型回答,全合成到 mp3 落盘,×3):
**1.25s / 1.86s / 2.12s**(EdgeTts 引擎的 ttsFirstByteMs 口径 = 合成完成,非流式)。

## 4. 全链首音对照表(→ 引擎选型)

| 路线 | 组成 | 全链首音估算 | PRD §15 判定 |
|------|------|--------------|--------------|
| D1-B TEXT+edge-tts(plan 主线) | — | **不可行**(TEXT 模态不存在) | — |
| 混合:audio 丢弃 + output 转写→edge-tts | 0.9s 转写 + 1.3-2.1s edge-tts + ~0.2s 转码 | **2.4-3.2s** | ❌ 破(>1.5s;撞 2s 硬线);且双倍烧 token |
| **D1-A:audio 直出主持 bot(附录 A)** | 0.8-1.0s 模型首 chunk + 0.1-0.3s(24k→48k 重采样 + opus 编码 + 网络) | **~0.9-1.3s** | ✅ ≤1.2s 可接受带(≤800ms「好」偶尔可达) |

## 5. D1-A 激活的范围后果(供 Tadashi 确认)

- voice-core **不加** responseModality/response-text(服务端不支持,加了是死配置);
  **仍加** `extraTools`(LiveToolSpec 分发)— issue_status tool(PR-2)与模态无关。
- 播音管线:Gemini 24k mono PCM → 48k stereo 重采样 → **主持 Lead bot 单嘴播**;
  TurnRouter/多 Lead speaker-tag 路由随 D1-A 退化为主持单路(= exploration D2 已备案的降级位)。
- 声线 = Gemini 预置声线(voice 参数化课题按附录 A 原文移交 FLY-546);`leads[].voice`
  配置键照加(edge-tts 声线继续服务 announce 面 + 未来 546)。
- earcon/filler 预合成照做(耳朵断连提示等 orchestrator 侧本地播报仍需要)。
- barge-in:audio 模态自带 server `interrupted` 事件(voice-core 已映射)+ 本地
  player.stop() <100ms — 合同不变。
- 收音管线(EarsReceiver/重采样/BotRegistry/部署件)与模态无关,零变化。

## 6. 复现

```bash
cd engineering/spike/FLY-545-huddle && npm install
eval "$(grep '^export GOOGLE_API_KEY=' ~/.zshrc)"
GEMINI_API_KEY="$GOOGLE_API_KEY" node s1-text-modality.mjs ref/s1-question-16k.pcm 3   # TEXT:必复现服务端拒绝
GEMINI_API_KEY="$GOOGLE_API_KEY" node s1-audio-modality.mjs ref/s1-question-16k.pcm 3  # AUDIO:延迟数字
```

事件级原始日志:out/s1-events.jsonl / out/s1-audio-events.jsonl(不进 git,复跑即得)。
