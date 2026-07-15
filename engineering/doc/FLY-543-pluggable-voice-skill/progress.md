---
issue: FLY-543
phase: implement
phaseCursor: 8/9
updated: 2026-07-06T19:45:00.000Z
nextStep: "QA round 3 PASS (independent re-verify of playbackStartMs fix) — proceeding to approve gate"
chunks:
  - id: scaffold
    status: done
  - id: edge-tts-engine
    status: done
  - id: announcer-session
    status: done
  - id: headless-brain-s01
    status: done
  - id: gemini-live-session
    status: done
  - id: audio-io
    status: done
  - id: cli-say-talk
    status: done
  - id: poc-real-machine
    status: blocked-needs-annie
  - id: eval-set
    status: blocked-needs-annie
pointers:
  package: packages/voice-core
  evidence: packages/voice-core/evidence/README.md
---

# FLY-543 progress
**phase**: implement (7/9 — 代码/测试全量完成;真机 POC + eval 需 Annie 硬件/key)
**next**: CI → approve gate (hold — ship is founder-gated)。Codex code review 2 轮 APPROVED @5d791eeb(R1: late-tool-call 取消缺口/connector 断连静默/stale qa-report,全修);PR #480 开出;FLY-827 硬 gate 已过

## done this phase（按 r2 plan 建,双面架构）
- packages/voice-core 全量:types.ts r2 §3 合同(announce/converse 双面 + capability flags)
- EdgeTtsBackend + AnnouncerSession(串行 speak 队列/interrupt 清队列/SpeakResult 三指标)
- GeminiLiveBackend + GeminiLiveSession(注入式 transport;barge-in vs 手动 interrupt 双路径
  取消合同;toolCallCancellation abort ask_lead;resume connect-time 注入 + newHandle 滚动)
- genaiConnector(真 @google/genai transport,S0.2-PENDING 标注,动态 import)
- HeadlessClaudeBrain 按 S0.1 spike 定稿参数(--tools "" --strict-mcp-config 每轮重传/
  --append-system-prompt-file persona/--resume session_id 捕获/stream-json 只取 text_delta)
- audio:FilePlayer(afplay)+ StreamPlayer(ffplay 流播,interrupt=kill+respawn)+
  MicCapture(持续流+mute)
- CLI:say(--stdin/--file only,无位置参数)+ talk
- 68/68 vitest 绿、tsc 干净、biome 干净、全仓 pnpm lint exit 0
- 注:本轮曾误按已被 r2 取代的旧 plan 建过 whisper 管线版(90 测),fetch 发现 rescope
  后已重建到 r2 双面;process seam/transcript/brain 骨架复用,Lead 已确认路线正确

## real-machine gap(Lead 已知会)
S0.2 Gemini 连通 spike + POC-A/POC-B + eval set → 需 GEMINI_API_KEY / 真 mic,见
packages/voice-core/evidence/README.md

## QA round 2 — FAIL（详见 qa-report.md）
真机跑 `say --stdin`（本机已装 edge-tts/ffmpeg/ffplay/afplay）发现 `playbackStartMs`
不诚实：真实合成耗时 1625ms 时该字段只报 2ms，违反 types.ts/plan.md 自身文档的
「诚实端到端首响」承诺（FilePlayer 计时起点在 TTS 合成完成之后才开始，mock 因
FakeAudioPlayer 硬编码 playbackStartMs=3 而未捕获）。已提交回归测试
（`fakes.ts` + `announcer.test.ts`）复现该 bug。其余合同点（可插拔/取消/argv 卫生/
失败路径/CLI）经真机执行 + 代码审查确认落实准确。

## QA round 2 fix — DONE（本轮 implement）
根因即 QA 所述：`SpeakResult.playbackStartMs` 盲目转发 `Playback.playbackStartMs`
（只测本地 temp-write+spawn，发生在合成 await 完成之后）。修法：
- `EdgeTtsBackend.runSpeak()` 在合成开始前打点 `speakStart = now()`，播放开始时
  算 `playbackStartMs = now() - speakStart` → 端到端（含 TTS 合成等待）的诚实首响。
- 为防「同名字段被再次盲转发」复发，把 FilePlayer 的 `Playback.playbackStartMs`
  改名为 `spawnMs`（语义收窄为本地 spawn 开销，仍由 audio.test.ts 独测）；doc
  comment（FilePlayer/types.ts）改为明确两层语义不同。
- 更新 `fakes.ts`(spawnMs)、`audio.test.ts`(spawnMs)、`announcer.test.ts:32`
  断言（playbackStartMs 不再是 player 常量 3，改断非负）。
- 新增 `.gitignore` 忽略默认 transcript 输出目录 `voice-transcripts/`。

验证：`vitest run` 71/71 绿（含 QA 回归测试转绿）、`tsc --noEmit` 0 error、
改动文件 `biome check` 干净。真机复跑 `say --stdin`：修前 ttsFirstByte=1625ms /
playbackStart=2ms（撒谎）→ 修后 ttsFirstByte=2581ms / playbackStart=2587ms
（诚实 ≈ 合成 + spawn），`first-response=playbackStart` 现在名副其实。

## QA round 3 — PASS（独立复核，详见 qa-report.md）
本 QA 会话独立重跑（非引用 implement 自报数字）：vitest 71/71（含回归测试转绿）、
tsc 0 error、biome 改动文件干净、两次独立真机 `say --stdin` 均确认
playbackStart≈ttsFirstByte+spawn（不再是 ~2ms 撒谎值）、`talk` 无 key 快速失败未受
影响、CI pass、PR mergeable、Codex code review 专项 APPROVED（PR #480 评论
@2026-07-07T02:25:44Z）。无新增缺陷，转入 approve gate。
