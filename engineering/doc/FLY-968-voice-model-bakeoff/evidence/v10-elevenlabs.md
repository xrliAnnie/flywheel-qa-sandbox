# FLY-968 V10 — ElevenLabs Agents 时间盒评估

Issue: FLY-968
日期: 2026-07-07
基于: ../plan.md §3 P4（时间盒 ≤2h，实际 ~1h 含文档）

## Verdict

**V10 = 值得开 follow-up issue**（不在本 issue 升级为主候选，按 plan 纪律）。
「R5 自拼管线的托管版」定位真机成立：**脑可外接（doc 级确认）+ 首音 ~720ms +
海量声线库 + WS 裸 PCM 进出（Discord 桥接摩擦低）**。

## 真机实测（Creator tier 现有额度，agent = eleven_flash_v2_5 + gpt-4o-mini 内置脑 + zh）

| 项 | 结果 |
|----|------|
| 建 Agent | API 一发建成（约束：非英语 agent 必须 turbo/flash v2.5 TTS）|
| 接口形态 | `get-signed-url` → WebSocket；**音频进出都是裸 base64 PCM 16k**（`user_audio_chunk` 入 / `audio` event 出），与 Gemini/OpenAI 同构 → Discord 桥接摩擦与主候选持平，非电话/Widget 锁定 |
| speech-end→首 audio | **717ms / 737ms**（u1/u2 两轮）——注意这是「含 TTS 的完整语音回答首音」，跟 Gemini AUDIO(797-1017ms) 同口径可比 |
| 中文转写（内置 scribe_realtime ASR） | u1 全对（连 "Huddle"→「哈豆」的错法都跟两家大厂一致）；u2 混说 check/status/PR/approve **全对**，"FLY-968"→"Fly968" |
| 转轮/打断 | 平台内置 turn_v3 模型管 turn-taking（不用自己写 VAD 编排）|

## 脑可外接（doc 级确认，2026-07-07）

- 官方 Custom LLM 文档：自有 LLM 只需暴露 **OpenAI 兼容 `/v1/chat/completions` 或
  `/v1/responses`**（SSE 流式）端点，dashboard 填 URL+model id 即接入
  （elevenlabs.io/docs/eleven-agents/customization/llm/custom-llm）。
- → 「Claude 当脑 + ElevenLabs 管 STT/turn/TTS/声线」的托管拼装**接口上成立**。
  未验证（follow-up 内容）：外接脑往返对首音的延迟惩罚、per-Lead 多声线在单 agent
  内怎么切（平台一 agent 一 voice，多 Lead 可能要多 agent = 多并发会话计费）。

## 成本口径

$0.08/min（burst $0.16）会话费 + LLM 费另算（自带脑则平台侧只剩会话费）。
60min 会议 ≈ **$4.8/小时**——比 multi-Gemini gated（~$0.68）贵 7 倍，比 OpenAI
text-out 也贵。托管编排的省工钱 vs 按分钟计费的贵，是 follow-up 的核心权衡。

## 清理

spike agent（`agent_4401kwz7d16mf7et77t5xhyt4ens`）用后已删，
`s5-elevenlabs-agent.mjs` + 本文件的建 agent 参数可完整复现。

## 复现

```bash
cd engineering/spike/FLY-968-voice-bakeoff
# 建 agent(见本文件参数) → 拿 agent_id
ELEVENLABS_API_KEY=... node s5-elevenlabs-agent.mjs <agent_id>
```
