# FLY-2799 qa6 返工 — 播放侧回放证据

日期: 2026-09-25
基于: QA 第三轮报告（exec 52137bb6，会话 3cedfff5）的 events.jsonl / codex-transcript.jsonl

## 为什么是回放、不是真引擎

真引擎台架（真 codex-standalone 0.156.1）在 2026-09-25 ~19:10Z 开场时收到 OpenAI
`You have no credits remaining`，引擎 B 无法开口；已报 Lead（question 2fb1867b），之后不再调用 API。
所以本轮用 founder 真人场录下的**真实上游时序**回放：12 条回答的每个音频 delta 的到达时刻、
每条终稿的到达时刻，原样喂进真 `CodexVoiceBackend` → 真 `WaitingMouth`。

播放器替身按 @discordjs/voice 0.19.2 `audioCycleStep` 的算法取帧：每槽 `nextTime += 20`，
下一槽 `setTimeout(max(1, nextTime - now))`，卡顿后连续补读错过的槽；资源按实际取到的帧报
`playbackDuration`。`stallMs` 是每 1.4 秒一次的人为事件循环阻塞（房里实测：出声的 72 秒里
20ms 时钟晚到 51 次，全场最长一次 177ms）。

## 结果（最终 dist，`node replay-bench.mjs <out.json> <stallMs>`，`LEAD=1` 为对照）

| 文件 | 卡顿 | 提前量 | 语音内空槽 | 欠载诊断 | 第一段音频→开口 |
|---|---|---|---|---|---|
| final-nostall.json | 0 | 默认（说话 10 帧 / 空闲 2 帧） | 0 | 0 | 24–57ms |
| final-stall150.json | 150ms | 默认 | **0** | 0 | 25–59ms |
| final-stall150-lead1.json | 150ms | 1 帧（≈旧行为的对照） | **519** | 3603 | 15–32ms |
| final-stall300.json | 300ms（超过 200ms 提前量） | 默认 | 291 | 53 | 21–55ms |

- 旧实现要等终稿才播：同 12 条回答的「第一段音频→终稿」为 327–4869ms（`wholeItemWaitMs`），
  现在全部在第一段音频到达后约 60ms 内开口。
- 超过提前量的卡顿仍会断，但每次都落一条 `playback_underrun`（`queuedFrames`、
  `sincePreviousPumpMs`、`upstreamStarved`），下次能把听到的断口对到具体卡顿。
- 音色（线性插值替代零阶保持）是推断，本回放不能证明，需要真人再听。

## 重采样听感对照（Lead 353a5633：「改后要听感对照录音」）

`node resample-ab.mjs <assistant.pcm> <outDir> 0 20` 把同一段真实引擎 B 输出（QA 台架
`qa6-dd6be6bf7-bench/plainSole/assistant.pcm`，marin，24 kHz 单声道）的前 20 秒渲染两遍：
`zoh.wav` 走旧的 voice-bridge 零阶保持，`linear.wav` 取真 `WaitingMouth` 实际写出的帧。
两段录音在本机 `~/.flywheel/artifacts/FLY-2799-impl/qa6-resample-ab/`（各 3.8 MB，不入库），供真人 A/B 试听。

客观指标（`resample-ab.json`，左声道功率谱；24 kHz 源在 12 kHz 以上没有内容，那里的能量全是上采样镜像）：

| | 12 kHz 以上 | 16 kHz 以上 |
|---|---|---|
| 零阶保持（旧） | -22.2 dB | -24.2 dB |
| 线性插值（新） | -29.5 dB | -34.3 dB |

线性插值把镜像压低 7–10 dB，但没有消除。「音色奇怪」是否由此而来仍要靠真人试听确认；
如果试听后仍觉得刺，下一步是带限 FIR 插值（可压到 -50 dB 以下），本轮不做。
