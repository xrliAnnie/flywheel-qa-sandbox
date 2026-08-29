# FLY-543 通用可插拔 voice skill — QA 报告（round 1，已被取代）

Issue: FLY-543 (https://linear.app/geoforge3d/issue/FLY-543/voice-核心通用可插拔-voice-skill全-lead-共用realtime-后端)
日期: 2026-07-06
基于: plan.md / progress.md + 分支 `flywheel-FLY-543` 全量 diff

> **⚠️ SUPERSEDED（2026-07-06,implement fix round）**:本报告记录的是 QA round 1
> 对**当时零代码状态**的 BLOCKED 裁定(历史留档,判定当时正确)。此后 implement 已按
> r2 plan 重新交付:`packages/voice-core` 全量存在(双面架构 + 68 vitest)、PR #480
> 已开。当前状态以 progress.md 与 PR 为准;下一轮 QA 会出新的报告。

## 裁定：BLOCKED（无法进入 QA）— implement 阶段零代码交付

三段式流水线（Design → Implement → QA）的 **Implement 阶段没有产出任何实现代码**。
QA 阶段没有可验证的对象；本 QA 会话按规则不得重新实现该功能，故裁定为 BLOCKED 并
如实上报 Lead 重新派发 implement，而非 PASS/FAIL。

## 证据（可复现）

| 检查项 | 命令 | 结果 |
|--------|------|------|
| 分支 vs main 的改动 | `git diff main...HEAD --name-only` | **仅 6 个文档文件**（exploration/research/plan/design-review×2/progress），零非文档改动 |
| 计划主交付物是否存在 | `git ls-tree -r HEAD` 找 `packages/voice-core` | **不存在**（plan §2 要求的新包完全没建） |
| 是否有 PR | `gh pr view` | `no pull requests found for branch "flywheel-FLY-543"` |
| 进度账本状态 | `progress.md` | `phase: implement`，`phaseCursor: 0/12`，nextStep 仍停在 "Phase 0 spikes" |
| implement commit 内容 | `git show 852e7de7 --stat` | 仅把 `progress.md` 6 行从 `design 4/4` 翻成 `implement 0/12`，**零代码** |
| 代码是否藏在别处 | `git worktree list` / `git stash list` / 全仓 `find … voice` | 无 voice-core 代码，无相关 stash/worktree |

分支最后 6 个 commit 全是 design 阶段文档 + 一个只翻 phase marker 的 progress commit：

```
852e7de7 chore(progress): FLY-543 implement 0/12          ← 只改 progress.md 6 行，无代码
07f75a39 docs(FLY-543): plan revised per Codex R1 — APPROVED R2
90c623d2 chore(progress): FLY-543 design 4/4
f8016b8d docs(FLY-543): design trio — exploration/research/plan
b83b72ad chore(progress): FLY-543 design 2/4
7e42a921 chore(progress): FLY-543 design 1/4
```

## 计划本应交付但缺失的内容（plan §0 目标 / §5 验收）

- `packages/voice-core` 新包（VoiceBackend / VoiceSession / BrainAdapter 接口 + capability flags）— **缺失**
- PipelineBackend（whisper.cpp STT + edge-tts TTS）— **缺失**
- POC CLI（`flywheel-voice-poc`，push-to-talk + 高危确认门）— **缺失**
- zh-en mic eval set + 管线基线数字 — **缺失**
- vitest 用例（plan 明确「PipelineSession 状态机是测试重心」）— **缺失**
- Phase 2 GeminiLiveBackend adapter — **缺失**

验收标准 A1–A8 无一具备可验证前提（没有代码、没有测试、没有 evidence 落档）。

## 结论与建议

- **设计三件套（exploration/research/plan）质量完好**，Codex design review R1 8 项已采纳、R2 APPROVED，可直接作为重新 implement 的输入。
- 需要**重新派发一个 implement 阶段** 照 plan.md 建 `packages/voice-core`（Phase 0 spike → Phase 1 主体 → Phase 2 可选），完成后再进 QA。
- 本 QA 会话不重新实现（角色边界 + 三段式职责划分），已 `qa-result --status fail`（无实现可验）并 `complete --route blocked`，交 Lead 重新调度。

---

# FLY-543 通用可插拔 voice skill — QA 报告（round 2）

Issue: FLY-543 (https://linear.app/geoforge3d/issue/FLY-543/voice-核心通用可插拔-voice-skill全-lead-共用realtime-后端)
日期: 2026-07-06
基于: plan.md r2 / progress.md（8/9,Codex 两轮 APPROVED）/ PR #480 @ `5d791eeb`

## 裁定：FAIL — 一处诚实口径 metric 违反自身文档合同（回归测试已随本报告提交）

实现范围（`packages/voice-core` 双面架构：EdgeTtsBackend announce + GeminiLiveBackend
converse + HeadlessClaudeBrain + registry + CLI）**结构完整、合同落实准确**——见下方
「已验证通过」。但真机执行 `say` 时发现一处具体 metric 违反其自身文档承诺的语义，且
现有 mock 结构性地掩盖了它。判定为 FAIL 而非「PASS + 记录 nit」的原因：这个字段正是
plan §5 A2 验收标准点名要落 evidence 的三指标之一，若现在放行，未来 Annie/eval 真机
收集 A2 证据（`evidence/poc-announce.md`）时会记录一个自相矛盾、误导性的延迟数字。

### 核心发现：`playbackStartMs` 不诚实——不包含它自己承诺要包含的 TTS 合成等待

**证据链（可复现）：**

1. **合同文本**（两处独立声明同一语义）：
   - `types.ts:104`："when the founder actually hears sound (the honest first-response anchor)"
   - `plan.md:153`："playbackStartMs: number; // 用户真正听到声音（诚实口径）"
   - `EdgeTtsEngine.ts:10-12` 明确交棒："ttsFirstByteMs note (honest): ... End-to-end
     'first response' is measured downstream **at playback start** (plan.md §4 step 8),
     never here." —— 即 playbackStartMs 被设计为**端到端**（含 TTS 合成等待）的首次
     有声响应延迟。
   - CLI 自己也这样标注：`cli.ts:148` 输出行尾 `(first-response=playbackStart)`。

2. **真机复现**（本机已装 edge-tts/ffmpeg/ffplay/afplay，真跑而非 mock）：
   ```
   $ echo "早上好 Annie，... test speech ... 123 ..." | node dist/cli.js say --stdin
   flywheel-voice-poc say — backend=edge-tts  voice=zh-CN-XiaoxiaoNeural
     [metrics] ttsFirstByte=1625ms  playbackStart=2ms  duration=10518ms  (first-response=playbackStart)
   ```
   真实合成耗时 1625ms，但被标注为"first-response"的 playbackStart 只有 2ms——founder
   实际等了 ~1.6s 才听到声音，metric 却诚实性地撒了谎。

3. **根因**：`EdgeTtsBackend.ts` `runSpeak()` 里 `playbackStartMs` 直接取自
   `FilePlayer.play()` 的返回值；而 `FilePlayer.play()`（`FilePlayer.ts:52-61`）的计时
   起点 `Date.now()` 是在 `this.player.play(audio, format)` **调用那一刻**——此时
   `this.tts.synthesize()` 早已 await 完毕。所以 playbackStartMs 只测「写临时文件 +
   spawn afplay」这几毫秒本地开销，从未把前面的合成等待算进去。

4. **为什么 68/70 单测没抓到**：`fakes.ts` 的 `FakeAudioPlayer.play()` 硬编码返回
   `playbackStartMs: 3`，与传入的 `FakeTts` 模拟的 `ttsFirstByteMs` 完全脱钩——mock
   世界里两个字段永远互不影响，真实时钟下的耦合关系从未被单测检验过。

**本报告已提交回归测试复现该 bug**（`src/__tests__/announcer.test.ts`
「playbackStartMs reflects real elapsed time to first sound, including TTS synth
wait」+ `fakes.ts` 新增 `FakeTts.realDelayMs` 选项模拟真实合成耗时）：

```
 × AnnouncerSession > playbackStartMs reflects real elapsed time to first sound, including TTS synth wait
   AssertionError: expected 3 to be greater than or equal to 55
```

**建议修法**（implement 阶段裁量，不代做）：`playbackStartMs` 应从 `speak()` 调用起点
（而非 `player.play()` 调用起点）算起，或者显式把 `ttsFirstByteMs` 累加进去；两者选
一，但字段名/文档承诺的「诚实端到端首响」语义必须与实际计算口径一致。

## 已验证通过（合同 / 真机行为，均可复现）

| 检查项 | 方法 | 结果 |
|--------|------|------|
| vitest 全绿 | `npx vitest run`（本 QA 独立跑，非引用 Codex 报告） | 70/70（不含本报告新增的 1 个回归测试） |
| tsc 干净 | `npx tsc --noEmit` | 0 error |
| 全仓 lint | `pnpm lint`（含 voice-core） | exit 0（14 processing-wide warnings，均非本包新引入的阻塞项，与 CI 口径一致） |
| CI | `gh pr view` | Build & Test SUCCESS |
| Codex code review | PR #480 评论 | Round 1→2 APPROVED，R1 两项 MEDIUM 已修（晚到 tool-call 未过滤 / genaiConnector 静默丢断连） |
| types.ts 合同 vs plan §3 | 逐字段对照 | 完全一致（VoiceBackend/AnnouncerSession/ConversationSession/BrainAdapter/TtsEngine/TranscriptSink） |
| registry capability/factory 一致性 fail-fast | `registry.ts` + `registry.test.ts` | 落实（announce/converse 各自声明与工厂方法不匹配时 fail-fast） |
| 取消合同两条路径分测 | `gemini-live.test.ts` | barge-in（服务端 interrupted）与手动 interrupt() 分别断言停播 + response-cancelled + 无 assistant transcript；R1 fix（晚到 tool-call 在取消窗口内被丢弃、下一轮恢复）有专门用例覆盖 |
| toolCallCancellation abort ask_lead | `gemini-live.test.ts` | 覆盖（无 function-response 发出） |
| genaiConnector 断连显式报错 | `genaiConnector.ts` onclose | 非主动 close → 发 `backend-protocol` error（R1 fix，代码级确认） |
| argv 卫生 | `edge-tts.test.ts` / `headless-brain.test.ts` + 真机 | edge-tts 文本走 0600 `--file`；claude prompt 走 stdin（`child.end(prompt)`）；两处 mock argv 断言均不含文本 |
| CLI `say` 无位置参数 | `cli.ts` `readSayText` + `cli-factory.test.ts` | 仅 `--stdin`/`--file`，验证一致 |
| **真机执行 `say --stdin`** | 本 QA 真跑（非 mock） | 端到端成功：真实合成 mp3 → 真实 afplay 播放 → transcript JSONL 正确落盘 |
| **真机执行 `talk` 缺 key 快速失败** | 本 QA 真跑 `unset GEMINI_API_KEY` | `fatal: GEMINI_API_KEY not set — the converse (Gemini Live) face needs an API key`，exit 1，符合 A6 fail-fast |
| HeadlessClaudeBrain S0.1 参数 | `HeadlessClaudeBrain.ts` 逐项核对 spike 结论 | `--tools "" --strict-mcp-config` 每轮重传、`--append-system-prompt-file` 只在非 resume 轮发、stream-json 解析 + session_id 捕获、resume 分支正确 |

## real-machine gap（承认，非本轮新增缺口）

S0.2 Gemini Live 连通性 spike / POC-B 对话闭环 / zh-en eval set 仍需 GEMINI_API_KEY +
真 mic，本 QA 环境不具备（`GEMINI_API_KEY` 未设置），与 progress.md 记录的
`blocked-needs-annie` 一致，非本报告裁定的阻塞点。

## 结论

- **FAIL** — 已在本分支提交回归测试（`fakes.ts` + `announcer.test.ts`），实现阶段需
  修 `playbackStartMs` 计时起点后重新提交 QA。
- 其余全部合同点（可插拔 / 取消 / argv 卫生 / 失败路径 / CLI 卫生）经代码审查 + 真机
  执行验证，均落实准确，无需返工。
- `qa-result --status fail` + 详细 summary 已上报；不进 approve gate。

---

# FLY-543 通用可插拔 voice skill — QA 报告（round 3）

Issue: FLY-543 (https://linear.app/geoforge3d/issue/FLY-543/voice-核心通用可插拔-voice-skill全-lead-共用realtime-后端)
日期: 2026-07-06
基于: PR #480 @ `0cefc89b`（round 2 fix commit）/ progress.md（8/9）

## 裁定：PASS

本轮独立复核 round 2 FAIL 的修复（commit `0cefc89b`），验证方法与结果如下——全部由
本 QA 会话独立重跑，非引用 Codex/implement 自报数字。

### 修复是否对症

- 根因核对：`EdgeTtsBackend.runSpeak()` 原来把 `playback.playbackStartMs`（player
  的 spawn 计时，起点在 `synthesize()` await 完成之后）直接转发为 `SpeakResult.
  playbackStartMs`。修复把计时起点搬到 `synthesize()` 调用之前（`speakStart =
  this.now()`），播放开始时算 `playbackStartMs = playStart - speakStart`——现在
  必然 ≥ `ttsFirstByteMs`，语义与 `types.ts`/`plan.md` 的"诚实端到端首响"文档承诺
  一致。
- 防复发设计核对：`FilePlayer.Playback.playbackStartMs` 改名为 `spawnMs`（窄化为
  本地 spawn 开销），`EdgeTtsBackend` 不再读这个字段，杜绝"同名字段被再次盲转发"。
  逐处 grep 确认改名后无遗留旧字段名引用（`cli.ts`/`types.ts`/`EdgeTtsBackend.ts`/
  `FilePlayer.ts` 全部一致，仅 `SpeakResult.playbackStartMs` 这一处保留原名，语义
  已换成端到端）。

### 独立验证（本 QA 会话本机实跑，非复用 Codex/implement 报告）

| 检查项 | 方法 | 结果 |
|--------|------|------|
| 单测回归 | `npx vitest run`（voice-core，独立执行） | **71/71 绿**，含 round 2 提交的回归测试（此前 FAIL：`expected 3 to be greater than or equal to 55`，现在通过） |
| 类型检查 | `npx tsc --noEmit` | 0 error |
| lint（改动文件） | `npx biome check` 对本轮 6 个改动文件 | 干净，0 warning |
| 构建 | `npx tsc`（生成 dist） | 成功 |
| **真机复现 #1** | `say --stdin`（真 edge-tts 合成 + 真 afplay 播放） | `ttsFirstByte=2355ms playbackStart=2363ms`——playbackStart 现在 ≥ ttsFirstByte（含合成等待），不再是 round 2 抓到的 ~2ms 撒谎值 |
| **真机复现 #2**（独立第二次跑，验证非偶然） | 同上，不同文本 | `ttsFirstByte=2344ms playbackStart=2350ms`——同样一致，两次数字都紧贴 ttsFirstByte（仅高出几 ms 的本地 spawn 开销），符合"合成等待+本地 spawn"的诚实口径 |
| `talk` 无 key 快速失败（未被本轮改动破坏） | `unset GEMINI_API_KEY && node dist/cli.js talk` | `fatal: GEMINI_API_KEY not set...`，exit 1，与 round 2 一致 |
| CI | `gh pr checks 480` | Build & Test pass |
| PR 可合并性 | `gh pr view 480` | `state=OPEN mergeable=MERGEABLE` |
| Codex code review（本轮修复专项） | PR #480 评论 @ 2026-07-07T02:25:44Z | **APPROVED**——"no correctness bug / semantic regression / contract violation introduced by the diff" |
| 遗留字段名 grep | `grep -rn "playbackStartMs\|spawnMs" src` | 无脱节引用，两个字段各自语义清晰分离 |
| 临时产物卫生 | `git status` 真机跑完后 | 干净（`voice-transcripts/` 已被 round 2 fix 新增的 `.gitignore` 正确忽略） |

### 未变化的既有合同（round 2 已验证，本轮未受影响，不重复深挖）

可插拔/取消（barge-in + 手动 interrupt 双路径）/ argv 卫生 / CLI stdin-file-only /
`talk` fail-fast——round 2 报告已用代码审查 + 真机验证确认落实准确，本轮修复未触碰
这些路径，抽查 `gemini-live.test.ts`（11/11）与 CLI 真机 `talk` 快速失败均随
71/71 一并保持绿色。

### real-machine gap（承认，非本轮阻塞点）

S0.2 Gemini Live 连通性 / POC-B 对话闭环 / zh-en eval set 仍需 `GEMINI_API_KEY` +
真 mic，本 QA 环境不具备，与 progress.md `blocked-needs-annie` 记录一致。

## 结论

- **PASS** — round 2 FAIL 的具体缺陷（`playbackStartMs` 不诚实）已修复且经本 QA
  独立复现验证（两次真机跑、单测回归、Codex 专项 code review）；其余合同点无回归。
- 无新增缺陷。转入 approve gate。
