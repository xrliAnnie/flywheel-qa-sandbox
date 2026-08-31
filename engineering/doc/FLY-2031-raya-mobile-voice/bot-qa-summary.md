# FLY-2031 随身语音(B) — QA bot 十六轮总结
Issue: FLY-2031 (https://linear.app/geoforge3d/issue/FLY-2031/rayav3-随身语音b常开流-念读筛选-用嘴批-ship)
日期: 2026-08-29
基于: plan.md

## 结论

R15 在实际使用的 Discord 界面 `voice-test-2` 通过当时的扩展严格门：六条念读稿逐条匹配且含续接句；诱导的 ship-card Discord fetch 失败恰好发生两次，第二次后 `attempt_cap=2`，ship item 没有任何终态 ack，后续普通 item 正常拿到 `spoken` ack；65 秒静默无 spoken liveness。R15 还验证过三轮旧 custom barge-in，但该层已按 Founder rework 明确整体删除，R15 的打断数据只保留为历史诊断证据，不再代表当前产品合同。

R16 对 rework 后的当前产品做终局实房复验：长念读完整落地，`audibleFrames=98`、`durationMs=3314`、`maxQuietGapMs=267`，没有被 QA bot 的 VAD/开口边沿截断；随后一轮真实语音输入产生 user final、`💭 **Raya**:正在思考` 与 assistant final，四条新消息都落在同一 Discord 文字通道；再观察 65 秒无可听活动。最终 `audio_counters` 为 `silence=7824, sent=4197, voice=1897, clock:delay=16`，`clock:stall=0`。判定器返回 `PASS`、`reasons=[]`。

普通念读稿没有内部编号；ship 编号只允许出现在最终批准句。R15 结果、runtime evidence 与 approval request log 的 SHA-256 分别为 `521c66f3aa6c3ae99fb20a74706df6e94f6d568a24bf76388f7e3f4d88396665`、`514d12f7a0aad77cfc1d70d37e133afef233f141c6bae637a712540201f89eea`、`07ea0d2a30955a6c586039beb5112ba838990a6172b0a0d62089445a2db160f1`。R16 最终 PASS 行与完整 runtime evidence 的 SHA-256 分别为 `a28a5640a3f02e3d733d04c6accac3624c995e8b17fae8114cb3fc8afbdaa64b`、`115f9979938f7d21fcc661957704f0001844d970c50267ee917e5116a4e63417`。

## 隔离场启动纪律

每次启动隔离 QA 场之前，必须先删除 **subject worktree 内的生成目录** `apps/voice/dist`，再从当前 source 运行 `pnpm --filter @raya/voice build`。启动前还要断言 `apps/voice/dist/speech/Liveness.js` 不存在；否则旧 source 已删除但孤儿 dist 仍可能被 Node 载入，整轮按冻结旧 build 判为无效。该清理只针对可重建的 dist，不删除 source、state 或 evidence。

## 十六轮：抓到什么、修了什么、最终状态

| 轮次 | 抓到的事实 | 随后修复/裁定 | 状态 |
|---|---|---|---|
| R1 | 六条稿能念，但三轮 barge 没发生；开头多说介绍语 | 收紧启动指令：禁止自我介绍/称呼，保留续接句 | FAIL，产品+runner |
| R2 | 标点-only ASR 差异被 byte-exact 比较器误判 | 对可听转写做 NFKC/标点归一，仍保留正文严格匹配 | FAIL，runner 假红 |
| R3 | 用户 final 在 `speakingEnd` 后到达，未被 barge latch 接住 | 允许归属窗口内的 late final 完成 latch | FAIL，产品 |
| R4 | 第一轮 barge 完整，但 runner 只投一条长项；旧 player Idle 也出现 | runner 改为三条不同长项、逐轮等 assistant final/release；Downlink 用原子换流清尾 | FAIL，runner+产品 |
| R5 | Lead 启动的是旧 dist/冻结态 | 冻存，不把它当产品判决 | INVALID |
| R6 | 六条正文正确，但前两条漏续接句，runner 仍误确认 | 确认跨度扩到续接句末尾 | FAIL，产品+runner |
| R7 | 六条与第一轮 barge 通过；receiver re-arm 后第二轮收不到 | 保留 QA receiver subscription，继续核 @discordjs/voice cache 语义 | FAIL，产品 |
| R8 | 仍复现 receiver cache/re-arm 缺口 | 按真实 cache 生命周期修复 subscription 复用 | FAIL，产品 |
| R9 | 三轮开口即停均成立；第三问无回答；旧资源 Idle 回调误伤当前播放 | player binding 加 `playbackId`，忽略 stale Idle/error | FAIL，产品+上游 |
| R10 | `player-idle-recovered=0` 证明资源身份修复；旧第三问再次无回答；`clock:stall=11` | 增加 bounded stall 时间戳；judge 对 stall 硬红；准备中立第三问单变量对照 | FAIL，上游+连续性 |
| R11 | 中立第三问 2.569 s 有答，排除“禁止 liveness 内容导致永久不答”；行为/声学全绿；旧尺子报 33 个 timer miss | bed disabled 时 Downlink 走 zero-copy；把内容假设与时序假设拆开 | FAIL，连续性 |
| R12 | 同一中立第三问间歇性无 assistant final；stall 28 | no-response 归上游 FLY-2159，本单不加 `appendText` 重放；TDD 证明 missed tick 真会丢 uplink PCM | FAIL，上游+连续性 |
| R13 | bounded catch-up 后行为/声学全绿；只剩 HumanLeft 后 transport 已关、clock 仍写导致 2 个真 stall | `StopCodex` 前先停 audio clock；拒绝写仍严格算 stall | FAIL，关停顺序 |
| R14 | 六条稿、三轮 barge、静默、声学、连续性全部通过；中立第三问 2.055 s 有答 | 无新增修复 | **PASS** |
| R15 | 在 R14 合同上增加 transient ship-card fetch：两次 GET binding/context 后 Discord fetch 均失败；第二次耗尽、ship 无 ack、后续 item `spoken`；三轮 barge 与静默仍全绿 | 覆盖 `d4b917f` 的真实 runtime/Discord 路径；无新增产品修复 | **PASS** |
| R16 | Founder 要求删除 custom barge-in，并把 user/assistant speech 与 thinking state 同路落文字；首次实房发现 realtime 路径没有 reasoning item，重复运行还可能命中旧固定 itemId | 删除整层 custom barge；user final 直接进入可去重 thinking state；runner 使用唯一 itemId + pre-run transcript cursor。终局实房长念读、双向文字、thinking、65 秒静默与音频连续性全绿 | **PASS** |

## Founder rework 对旧结论的覆盖

R1–R15 围绕 custom barge-in 的实现、cutoff 数值与上游恢复问题只作为历史排障记录保留。当前产品明确没有这层自定义打断：VAD/说话边沿不能截断正在播的系统念读，也不再创建 barge latch、defer/release 或本地尾音清空动作。R16 的硬门改为完整念读不截断、正常 user turn 可继续、语音与 thinking 同路落文字、静默期无主动播报、20 ms 音频时钟持续且零 stall。

## Clock 尺子变更（透明保留）

旧实现把每个 `setTimeout` 迟到都记为 `clock:stall`，同时 `AudioClock` 只 fire 当前帧、直接丢掉错过的 20 ms uplink 帧；因此尺子把“100 ms Downlink buffer 已吸收的迟到”当失败，却没有恢复真正丢失的 PCM 时间。

新实现分开记账：

- `clock:delay`：每个错过的 scheduled tick，保留 `scheduledAt/observedAt/delayMs`；它只表示调度迟到。
- 有界 catch-up：最多补 `downlinkTargetFrames` 个 uplink 帧，再发当前帧；不会无界 burst。
- `clock:stall`：只在 catch-up 超过上限，或任一补发/当前 append 未被接受时增加；judge 仍要求它为 0。
- AudioClock 的 off-by-one 同时修正：250 ms elapsed = 11 missed + 1 current = 12 帧，不再多算一帧。

R13 证明新尺子会抓真问题（teardown 的 `dropped:closed`）；R14 证明正常全程无 delay、无 stall。

## 历史边界（已由 R16 rework 覆盖）

打断后的模型回答依赖 Codex app-server/Realtime 上游会话恢复。R11 的中立第三问 2.569 s 有答，R12 同句无 assistant final、30 s latch deadline 后仍静默，R13/R14 又恢复；该间歇性缺口由 FLY-2159 承接。[OpenAI Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations) 有 `response.create`，但本机 [Codex app-server](https://developers.openai.com/codex/app-server) experimental schema 只暴露 `start/appendAudio/appendText/appendSpeech/stop`，没有等价的显式 response recovery。按已批准设计，本单不以 `appendText role=user` 重放输入，避免双响应和状态错乱。

旧 custom barge 合同及其 FLY-2159 恢复边界不再属于本单当前交付；R16 没有通过 `appendText` 重放，也没有保留任何自定义打断替代层。当前正常 user turn 在实际房间拿到 attributed final 与 assistant final，但这不扩张为上游永久可用性保证。

## Evidence 目录清单

持久根目录：`/Users/xiaorongli/.flywheel/raya/qa/FLY-2031/rounds/`

每轮目录均为 `bot-experience-20260829-rN/`（N=1…16），核心文件：

- `artifacts/voice-experience-result.jsonl`：runner 最终 PASS/FAIL 或 timeout 记录。
- `state/voice-evidence/events.jsonl`：Raya runtime 的 transcript、barge、inbox、clock 与退出证据。
- `state/voice-inbox/items.jsonl` / `acks.jsonl`：本轮六条稿、三条长项及交付确认；冻结无效的 R5 没有生成 `acks.jsonl`。
- `logs/voice.stdout.log` / `voice.stderr.log`：由 Lead 管理的隔离 voice 进程日志（可能为空）。

逐轮目录：

`bot-experience-20260829-r1`、`r2`、`r3`、`r4`、`r5`、`r6`、`r7`、`r8`、`r9`、`r10`、`r11`、`r12`、`r13`、`r14`、`r15`、`r16`。旧 TTS 原件保留在 `r1/tts/round-three.aiff`；R11–R16 的单变量对照使用 `r1/tts/round-three-neutral.aiff`。R16 `voice-experience-result.jsonl` 保留两次前置 FAIL 与最终 PASS，最终 PASS 行 hash 单独列在上文，避免把前置失败抹掉。
