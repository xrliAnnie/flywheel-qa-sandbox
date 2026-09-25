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
