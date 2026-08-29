# FLY-1006 QA fix round 3 — Annie P6 三条 defect 的修复说明 — 实施记录

Issue: FLY-1006 (URL 不可得,只写 issue 号)
日期: 2026-07-10
基于: evidence/m2-annie-p6-session.md（QA-FAIL 证据 + addendum,head c858cf9c）

## 修了什么（对应 addendum 的 3 条 defect）

### ① barge-in 去抖 + 误打断干净恢复（三层）

**1a. EarsReceiver 去抖闩锁（utterance-level debounce）**
`packages/voice-bridge/src/audio/EarsReceiver.ts`

- 原契约:每一段持续 >350ms 的 Discord speaking burst 都触发一次 `onBargeIn`。
  真人说话 = 一串被呼吸/停顿切开的 burst → 一句话触发 8+ 次（P6 风暴的直接来源）。
- 新契约:gate 触发一次后进入 **latched** 状态;只有**连续静音 ≥ bargeInHoldoffMs**
  （默认 1000ms,env `FLYWHEEL_HUDDLE_BARGE_HOLDOFF_MS`）才解闩。闩锁期间的
  续说不再重复触发——**一个 utterance 至多一次 barge-in**。真打断不受影响:
  真插话总是从 ≥1s 的静音后开始（agent 起码要先出声）。闩锁 per-user;detach 清理。

**1b. ElevenSession 的 local barge-in 改为 turn-state-aware（毒 suppress 根除）**
`packages/voice-bridge/src/eleven/ElevenSession.ts`

- 原行为:`onBargeIn → interrupt("local")` 无条件 flush + `suppressed=true`。
  agent 根本没在说话时(P6 前 35s 有 8 次),suppressed 会把**即将到来的答案**
  整段丢掉(直到 user_transcript 才解除)——turn 状态就是这样 thrash 的。
- 新行为:local barge-in **只在 turnOpen（agent 正在出声）时**才是真打断
  （flush + suppress + trail `interruption source=local`）;空闲时只结束等待态
  （停 cue,她又开口了）,**绝不 suppress**,trail 记 `barge_in_idle`（QA 可以
  从 jsonl 数出风暴是否消失,且不再污染 interruption 计数）。

**1c. shim per-conversation single-flight（脑请求不堆积）**
`engineering/spike/FLY-980-eleven/lib/shim-core.mjs`

- 平台在打断/重试时会对同一会话重发 LLM 请求（P6 real log:aborted + 重发对;
  07-09 15:56 双并发对同 key 真实发生过）。原行为两个 claude -p 并跑抢 CPU。
- 新行为:同一 conversation key 的新请求到达即 **abort 上一个 in-flight** 的
  claude -p（`superseded_previous` 落 shim jsonl）,下一轮从零开始;不同会话互不影响。

**机制诚实备注**:local barge-in 是 daemon 本地事件,**不直接**触达 claude -p
（脑的取消一直由平台 abort HTTP 请求驱动,shim 侧原本就会 SIGKILL 子进程）。
QA 报告里「打断正在跑的 claude -p」的因果链在机制上应读作:风暴 thrash 掉
turn/suppress/cue 状态 + 平台侧 turn-taking 被连续语音事件拖住。本轮修复把
**可归因给我们代码的三个环节**（风暴本身、suppress 毒答案、同会话请求堆积）
全部结构性关掉;平台内部 turn-commit 时延(~100s stall 的平台侧成分)不在我们
代码可控面内,复验时应看「barge_in_idle 不再伴随 interruption 风暴 + 逐轮延迟
不再单调恶化」。

### ② 对话文本落 Discord 可见

`packages/voice-bridge/src/eleven/ElevenSession.ts` + `eleven/wiring.ts`

- 新增 `ElevenTiv` surface（assistant `TivSurface` 的 /eleven 子集,照搬 /glaw
  F2 统一标准）。wiring 把它接到 orchestrator bot → **语音频道文本区**:
  - `user_transcript` → `🗣 <她的话>`（平台 STT 原文）
  - `agent_response` → `🤖 <Eleven 的回话>`
- /eleven 每轮各只有一条 user_transcript + agent_response（平台事件,非流式
  delta）,每轮 2 条消息,不会刷屏——这是 /gemini v1 当时把 caption 降级进
  daemon log 的顾虑在 /eleven 不成立的原因。jsonl 落盘照旧(证据链不变)。

### ③ 等待期「正在处理」文字状态

同上两文件:

- 状态机各转换点发文字状态:session live → `🎙 在听`;speech_end(等待开始)
  → `🧠 正在处理…`;答案首帧 → `💬 回话中`;turn 结束(gap) → `🎙 在听`。
- `🧠 正在处理…` **不依赖 cue clip 是否配置**（waitOn 状态门,音效+文字双通道;
  cue 没配文字也照发）。每个等待周期恰好一条(VAD flutter 多次 speech_end 不
  重复发)。

### Codex review 轮的三个补强（R3-fix-1/2 findings,全部采纳）

1. **状态永不撒谎**:任何 interrupt 路径（platform/local/idle barge-in）都把
   状态复位回 `🎙 在听`;`lastStatus` 去重保证状态 churn 不重复发消息。
2. **speaking-start 独立路由**:去抖闩锁生效后,她在 holdoff 内**续说**不再
   触发 barge-in——等待 UI（cue + 🧠）改由 **speaking-start** 结束(她一开口
   等待就停,她下一次说完等待重开)。`VoiceRoomRuntime.routeSpeakingStart` +
   `ElevenEars.onSpeakingStart` 新增;agent 说话中(turnOpen)的短促人声不碰
   turn(backchannel 语义留给 350ms gate)。
3. **🧠 状态 800ms 防刷屏 debounce**:speech_end↔speaking-start 在自然停顿间
   高频翻转,若每次都发「在听/正在处理」会刷屏——`🧠` 只在等待**存活 ≥800ms**
   后才发(真等待 ≥1.5s 必显示;<800ms 的停顿一条消息都不发;答案在 debounce
   内到达则直接 `💬`,不闪假状态)。cue 音效保持立即响(plan §4 原义)。
4. **shim supersede 提到 tool-call 早退之前**:同 key 的 tool-call 请求同样
   终止旧 in-flight brain。

## 证据（本轮机器可验部分）

- RED→GREEN TDD:新增 13 条单测（EarsReceiver holdoff 6 条 + ElevenSession
  idle-barge-in/tiv 6 条 + wiring tiv 1 条）+ shim single-flight 2 条,全部先
  RED 后 GREEN。
- 全套:voice-bridge 239/239、voice-core 196/196、spike shim 17/17;
  voice-core/voice-bridge build 过;`pnpm lint` 回到分支基线(仅存的 2 个 error
  在本单未触碰的 `packages/teamlead/qa-fly1041-real.mts`、
  `packages/voice-headphone/src/null-audio-io.ts`,分支既有)。
- 修改过的既有契约:ears-receiver 测试「a new burst re-arms the gate after a
  barge-in burst ends」改为「≥ holdoff 静音后才 re-arm」——旧契约正是 P6 风暴
  的行为,属被 QA 处方否定的契约,非顺手改。

## 复验建议（给独立 QA）

1. 带自然停顿的真人（或分段 WAV 注入,段间 400-800ms 静音）说一句长话:
   session jsonl 里该 utterance 应至多 1 条 `interruption`/`barge_in_idle`,
   而非 8+ 条 interruption;agent 未出声期间只应出现 `barge_in_idle`。
2. 文字面:语音频道文本区能看到 `🗣/🤖` 双向对话 + `🧠 正在处理…` 等待态。
3. 延迟:逐轮 `first_audio.sinceSpeechEndMs` 不再随轮次单调恶化（load 口径按
   qa-report「低 load 3-4s / 正常 load ~5s」基线读）。
4. shim jsonl:同会话若出现平台重发,应看到 `superseded_previous` 且旧请求
   即刻 abort。
