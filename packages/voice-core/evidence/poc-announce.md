# FLY-543 evidence — Edge TTS real E2E (announce face)

Issue: FLY-543 · phase: QA (post-round-3, Annie-requested real API sweep) · date: 2026-07-06
基于: `EdgeTtsEngine.ts` / `EdgeTtsBackend.ts` / `FilePlayer.ts`（分支 `flywheel-FLY-543` @ `05ec0e1a`）

Annie 明确要求"有 key 就用真的测、别 defer"。这份文档记录**真 edge-tts CLI + 真
afplay 播放**的端到端验证（非 mock transport），补 A2 验收（POC-A 播报闭环）。

## 真机验证 1 — CLI 全链路（`flywheel-voice-poc say --stdin`）

命令（在 `packages/voice-core` 下）：
```
echo "<中英混合文本>" | node dist/cli.js say --stdin --voice zh-CN-XiaoxiaoNeural
```

两次独立真机执行（本机已装 `edge-tts` / `ffmpeg` / `ffplay` / `afplay`）：

| 跑次 | ttsFirstByte | playbackStart | duration |
|------|--------------|----------------|----------|
| #1 | 2355ms | 2363ms | 14896ms |
| #2 | 2344ms | 2350ms | 7389ms |

`playbackStart` ≈ `ttsFirstByte` + 几 ms 本地 spawn 开销 —— 与 QA round 2/3 验证过的
"诚实端到端首响"口径一致（round-2 修复前是 ~2ms 撒谎值）。transcript JSONL 正确落盘
到 `voice-transcripts/`（`.gitignore` 已忽略该目录，不产生仓库污染）。

## 真机验证 2 — 直调真 `EdgeTts` 类（绕开 CLI，验证核心引擎本身）

用 built `dist/backends/edge-tts/EdgeTtsEngine.js` 的真 `EdgeTts` 类（非 fake/mock）
直接 `synthesize()`，把返回的音频 buffer 落盘并用 `ffprobe`/`afplay` 核验，证明生成
的确实是合法可播放音频，而不只是"进程 exit 0"这种弱证据：

```js
import { EdgeTts } from ".../dist/backends/edge-tts/EdgeTtsEngine.js";
const engine = new EdgeTts({ command: "edge-tts" });
const result = await engine.synthesize(text, "zh-CN-XiaoxiaoNeural", { signal });
// result.audio 是真实 mp3 buffer（95616 bytes）
```

输出：
```
ttsFirstByteMs: 2603
audioBytes: 95616
format: { encoding: "mp3", sampleRateHz: 24000, channels: 1 }
```

`ffprobe` 独立核验落盘文件（不信任 EdgeTtsEngine 自报的 format，客观工具核实）：
```
codec_name=mp3
sample_rate=24000
channels=1
duration=15.936000
size=95616
bit_rate=48000
```
`file` 命令确认：`MPEG ADTS, layer III, v2, 48 kbps, 24 kHz, Monaural` —— 合法 mp3，
非空文件/非损坏数据。

`afplay` 独立播放该文件：进程正常退出（exit 0），播放耗时 ~17.3s（对应 ffprobe
15.9s 音频时长 + 进程启动开销），证明生成的音频文件确实可被真实播放器完整播放，
不是一个"看起来像 mp3 但打不开"的假产物。

## 结论

Edge TTS 面（announce）端到端流程 —— 真文本 → 真 edge-tts 子进程合成 → 真 mp3 →
真 afplay 播放 —— 在本机完整跑通两条独立路径（CLI 全链路 + 直调核心引擎），均产出
可独立核验（ffprobe/file/afplay exit code）的真实音频证据，非 mock transport。

converse 面（Gemini Live）的真 API 验证见 `poc-converse.md`（待 `GEMINI_API_KEY` 到位）。
