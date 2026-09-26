# FLY-959 QA verification — 独立三段式 QA 阶段

Issue: FLY-959 · phase: QA (three-stage, independent session ≠ implement) · date: 2026-07-07
基于: `engineering/doc/FLY-959-voice-core-bugfixes/plan.md` + implement 的
`evidence/fly-959-regression.md`（分支 `flywheel-FLY-959` @ `ac031d5e`）

本文件是**独立 QA**（与 implement 不同 session）对 4 处 bug 修复的**重新验证**，
不复述 implement 的自证，而是从零跑一遍能跑的、并补齐一处真实的测试覆盖缺口。
key 沿用 543/959 已获授权的借用方案（`~/.zshrc` 的 `NANOBANANA_GEMINI_API_KEY`），
**key 值全程不落任何文档/消息/argv**（只经子进程 env 传递）。

## 静态验证（全绿）

| 项 | 命令 | 结果 |
|----|------|------|
| 单测 | `pnpm --filter flywheel-voice-core test` | **91 passed**（implement 88 + QA 新增 3 集成测试） |
| typecheck | `tsc --noEmit` | 0 error |
| build | `tsc` | 干净 |
| lint | `biome check` | exit 0（本分支改动的 10 个文件零 finding；`headless-brain.test.ts` 的 info 级 FIXABLE 建议是本分支**未改动**文件的既有项，不 fail check） |

## R1 — mic 默认设备跟随系统默认（bug 1）· 独立复现 PASS

本机 avfoundation 设备表（QA 当天，`ffmpeg -f avfoundation -list_devices true`）：

```
[0] DJI MIC MINI          ← 现在是索引 0
[1] MacBook Pro Microphone
[2] OpenRun by Shokz
[3] LG UltraFine Display Audio
```

**独立发现 —— avfoundation 索引会漂移**：implement 阶段（`fly-959-regression.md`）
记录的是 `[0] MacBook Pro / [2] DJI MIC MINI`;QA 当天变成 `[0] DJI MIC MINI /
[1] MacBook Pro`。**同一台机器、几小时内，DJI 从索引 2 漂到索引 0。** 这正是写死
`:0` 为什么从根上是错的：avfoundation 的**设备编号**和 macOS 的**系统默认输入**是
两套独立命名，只会偶尔重合。`:default` 跟随系统默认才是稳定正确的语义。

实测（`-loglevel debug`，各真录 1s 产出真实 PCM 字节）：

```
-i ":default" → audio device 'DJI MIC MINI' opened          （= 系统默认，system_profiler: Default Input Device: Yes）
-i ":1"       → audio device 'MacBook Pro Microphone' opened （按索引寻址仍可用，但 ≠ 默认）
```

`MicCapture` 默认 `device ?? ":default"`、config `micDevice` 默认 `":default"`、
`--device` / `FLYWHEEL_VOICE_MIC_DEVICE` 透传，均有单测（`config.test.ts` /
`audio.test.ts`）。声学收音质量（真人对麦说话）留 founder 白天补（543 已划为体验验收）。

## R2 — talk session 过期自动续期（bug 2）· 覆盖补齐 + 证据核验 PASS

**新增测试覆盖缺口（QA 补）**：implement 的 rotator 单测用 `FakeSession`,backend 单测
不涉及 rotator —— 两半分别测过、接缝没测过。QA 新增
`src/__tests__/rotator-backend-integration.test.ts`(3 tests) 把**真 `GeminiLiveBackend`
session + `TalkSessionRotator`** 按 cli.ts 同款方式接起来,验证端到端:

1. server `resumption-update {handle:"H1"}` → `go-away` → backend session emit
   `session-expiring` → rotator close 旧 session → **用 `H1` connect 出 resumed
   session**(断言第二次 connect 的 `params.resumeHandle === "H1"`、旧 conn.closed、
   CLI handlers 重新 attach、log `[session resumed]`)。
2. 续期后 mic 帧路由到 resumed conn、不碰死 conn。
3. 无 prior handle 的 goAway → fresh restart(`context lost`,不瞎带 handle)。

**implement 真机证据核验**(`fly-959-e2e-events.json`,44 事件,内部自洽):同一次真
API 会话在 **540.5s** 收 `session-expiring inSec=50`(543 撞死的正是这个点)→ **540.7s**
`[session resumed]`(200ms 续期)→ 545.9s 续期后再问一句 → 有回答。串在一次真会话里。

## R3 — ask_lead 带 schema 后真模型真调用（bug 3）· 独立真机复现 PASS

这是"mock 测不出"的那个 bug(543 直接教训):单测能证明 schema 被**声明**
(`gemini-live.test.ts:271`),但证明不了**真模型真的会调用**。QA 从零跑了一次独立
真机复现 —— 用**真 repo dist 代码**(`buildGeminiBackend` + `createGenaiTransport` +
真 `ASK_LEAD_DECLARATION` schema),edge-tts 合成的项目问题喂进去,看真模型是否 fire
tool-call:

```
model: gemini-3.1-flash-live-preview
6.2s transcript user: "Hey, can you briefly tell me what FLY-543 is about?"
6.2s TOOL-CALL name=ask_lead callId=fc_9082245028121388169     ← 真模型真调用 ask_lead
6.8s..7.3s assistant: "That's a voice core bugfix issue."       ← tool-call→brain→function-response→语音全环通
7.4s audioChunks=13
verdict: ask_lead tool-call fired: true
```

- **callId `fc_9082245028121388169`** 与 implement 证据的 `fc_6478266169522919146`
  **不同** → 这是一次**独立的新真会话**,不是重放 implement 的产物。
- 对照 543 原始故障:零 schema 下模型**从不调用**、一次瞎编"肯尼亚航空公司"、一次
  卡壳。补 schema 后真模型真调用 —— **独立复现,与 implement 结论一致**。

## R4 — 默认模型直连（bug 4）· 独立复现 PASS

`client.models.list()`(只读一次 HTTPS 往返)确认默认模型仍在 `bidiGenerateContent`
支持列表(与 `real-live-models-list.json` 快照一致,5 个模型):

```
default-model "models/gemini-3.1-flash-live-preview" live? true
[models/gemini-2.5-flash-native-audio-latest,
 models/gemini-2.5-flash-native-audio-preview-09-2025,
 models/gemini-2.5-flash-native-audio-preview-12-2025,
 models/gemini-3.1-flash-live-preview,          ← config.ts 新默认,活跃
 models/gemini-3.5-live-translate-preview]
```

R3 的真机 driver 也**不设** `FLYWHEEL_VOICE_GEMINI_MODEL`、用 config 新默认直连成功、
全程无 "not found"/404。旧模型名的 404 自救指引有单测(`genai-connector.test.ts`)。

## 结论

4 处 bug 修复 **全部独立复现/验证通过**:

| Bug | QA 独立动作 | 判定 |
|-----|-------------|------|
| 1 mic 默认设备 | 独立设备表 + `:default`/`:1` 实测(+ 抓到索引漂移铁证) | **PASS** |
| 2 session 续期 | 新增 backend↔rotator 端到端集成测试(3) + implement 真机证据核验 | **PASS** |
| 3 ask_lead schema | **独立真机复现**:真 repo 代码 → 真模型 fire tool-call(新 callId) | **PASS** |
| 4 默认模型 404 | 独立 `models.list()` + R3 driver 用新默认直连无 404 | **PASS** |

**唯一未由本轮覆盖的**:声音经空气进真麦克风的**声学环节**(真人对麦说话、口音、
真实时打断听感)—— 543 已明确划为 founder-acceptance 体验验收,非技术验收,Annie 白天
5 分钟可补。技术风险已清零。

## QA 交付物

- `src/__tests__/rotator-backend-integration.test.ts` —— 新增 3 个端到端集成测试(闭合 R2 覆盖缺口)。
- 本报告 —— 独立验证记录(R1 设备实测 / R3 真机 tool-call trace / R4 models.list)。
