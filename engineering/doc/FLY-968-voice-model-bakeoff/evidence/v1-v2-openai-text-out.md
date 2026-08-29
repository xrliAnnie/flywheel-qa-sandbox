# FLY-968 V1+V2 — OpenAI Realtime text-out 真机验证

Issue: FLY-968
日期: 2026-07-07
基于: ../plan.md §3 P1

## Verdict

- **V1（text-out 模态）= PASS**：`gpt-realtime-2.1` 接受
  `output_modalities: ["text"]`，3/3 轮真语音入 → 纯 text 出，**零 audio delta 帧**。
  545 原 B 设计（text → per-Lead edge-tts）在 OpenAI 上**真机复活**。
- **V2（全链首音）= FAIL（现配方），缓解路径明确**：模型侧 speech-end→首 text
  仅 392-720ms（预算内绰绰有余）；但 edge-tts CLI 冷启动叠上去后，分句流水全链
  1.48-1.83s（首字节口径）/ 1.94-2.03s（首句全合成口径），2/3 轮破 §15 的 1.5s
  线。**瓶颈 100% 在本地 TTS 侧，不在 OpenAI**——缓解见下。

## 实测数据（2026-07-07，model=gpt-realtime-2.1，server_vad，输入 24k PCM 20ms 帧实时节奏）

| 轮 | 话术 | VAD 滞后 | 首 text | 首句就绪 | response.done | audio 帧 | 全链(首句全合成) | 全链(首字节口径*) |
|----|------|---------|---------|----------|---------------|----------|------------------|-------------------|
| 1 | u1 中文 | 117ms | 720ms | 806ms | 991ms | **0** | 2737ms(整段)/2034ms | ~1829ms |
| 2 | u2 混说 | 141ms | 392ms | 580ms | 1270ms | **0** | 3484ms(整段)/1971ms | ~1483ms |
| 3 | u1 重放 | 108ms | 616ms | 696ms | 989ms | **0** | 3357ms(整段)/1937ms | ~1550ms |

*首字节口径 = 首句 text 就绪时刻 + edge-tts 首字节 median（同句 3 次实测，
853-1118ms，median 902ms；见 `out/s2b-firstbyte-results.json` 复现）。

**输入转写**（`gpt-4o-mini-transcribe`，session 内置）：
- u1:「帮我看一下,哈豆模式今天能不能用。」——"Huddle" 被听成「哈豆」（音译错，
  中英混专名弱点，与 Gemini S1 同款问题量级）。
- u2:「帮我check一下flight968的status,顺便看看PR有没有approve。」——check/status/
  PR/approve 四个英文词**全对**，"FLY-968" 被听成 "flight968"（编号类专名错）。
  混说日常动词层面**可辨认**，专名需词表/上下文纠偏。

## V2 的缓解路径（写明，不在本 issue 做）

1. **edge-tts CLI 冷启动 ≈300-400ms 纯浪费**（Python spawn + Azure TLS 握手每次重来）。
   产品化用常驻 websocket session（edge-tts Python lib / 自持连接）即可剥掉。
2. 剥掉冷启动后估算：首句就绪 580-806ms + 流式首包 ~400-500ms ≈ **1.0-1.3s**，
   落 §15 可接受带（≤1.2s）边缘 → B-on-OpenAI 判 **MARGINAL 可救**，非死刑。
3. 再进一步 = 换流式 TTS（如 ElevenLabs flash / OpenAI tts streaming），属 545 后续
   迭代选型，越界不做。

## 事件词汇表（GA 接口实测，供未来 openai backend adapter 映射）

`session.created/updated` → `input_audio_buffer.speech_started/stopped/committed` →
`conversation.item.added` → `conversation.item.input_audio_transcription.delta/completed`
→ `response.created` → `response.output_item.added` → `response.content_part.added` →
`response.output_text.delta`(text 路)/`.done` → `response.done`（含 usage）。
无任何 `response.output_audio.*` 事件出现（V1 判据的零 audio 帧证据）。

## Token 消耗（成本核对素材）

单轮量级（u1b 轮）：input 312 tok（audio 140 + text 172，其中 cached 256）、
output 70 text tok。3 轮合计 <$0.03（gpt-realtime-2.1 单价 audio-in $32/1M、
text-out $16/1M 口径）。

## 复现

```bash
cd engineering/spike/FLY-968-voice-bakeoff
npm install && ./gen-ref-audio.sh
node s2-openai-text-out.mjs          # V1+V2 主实验(需 env OPENAI_API_KEY)
node s2b-edge-tts-firstbyte.mjs      # edge-tts 首字节口径补测
```

事件日志 `out/s2-openai-text-out.jsonl`、结果 `out/s2-openai-text-out-results.json`
（gitignored，复跑即得）。
