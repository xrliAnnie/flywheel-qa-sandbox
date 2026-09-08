# Design Review — plan.md (Round 2)

Date: 2026-09-06
Author: Codex
Status: CHANGES REQUESTED

## Summary

v2 是实质性改进：上一轮关于当前 HEAD 的 F1 事实错误已经纠正；turn nonce/RTT、runner `/status`、非 meeting 生命周期口径、provenance/secret、单调计时和 529 lifecycle 的目标契约都已进入计划。仓库归属上，我裁决 **方案 A 可以保留**：lifecycle parity 要求的是运行契约等价，不要求 driver 物理上住在 Raya 仓；现有导出面足以让 Flywheel driver 复用大部分 529 组件，也确实无需修改 voice pipeline。

但本轮仍是 **CHANGES REQUESTED**。核心原因是上一轮 P0-1/P0-4 尚未真正闭环：当前 proposed PCM 实现会用非唯一的 wall-clock `atMs` 去重，并把每个帧强制按 RMS 分成 voice/bed/silence。现有 API 与信号特征都不保证这两件事成立，因而仍可能静默丢帧、把 quiet voice 当 bed/silence，并把发生 voice overlap 的探针计入 bed 命中率。负对照还被排在正场之后，与“不做负对照就不许开正场”直接矛盾。

另外，lifecycle 的最后几步仍有可执行性/顺序错误：observer error 并不通过现有 emitter API可靠暴露，`readyCensus` 没出现在启动序列，manifest 在 cleanup census 之前就被定稿；runner 候选字段也写成了列表响应不存在的 `session_status`。这些都可能让 INVALID 场次生成看似 VALID 的结果，或让编排候选被全部筛空。

### 上轮 finding ledger

| Round 1 finding | Round 2 状态 |
|---|---|
| P0-1 下行口径/observer 争用 | **部分关闭**：single-arm/cumulative packets 正确；PCM 游标与分类器仍需修正 |
| P0-2 529 lifecycle parity | **大部分关闭**：复用方向正确；ready/error/最终落盘顺序仍有缺口 |
| P0-3 F1 当前 HEAD 前提 | **关闭** |
| P0-4 bed 窗/turn 归因 | **部分关闭**：nonce/RTT/字段修正已关闭；bed/voice eligibility 仍依赖未立住的分类器 |
| P1-5 runner 编排证据 | **契约关闭，字段名需修** |
| P1-6 disconnect/reconnect 口径 | **语义关闭，observer error 能力声明需修** |
| P1-7 provenance/secret/计时 | **大部分关闭，最终 verdict 必须后置到 cleanup 之后** |

## What's Good (Keep)

- research §3 对 `appendText(note, "user")` 的更正完整保留了旧错误及其影响，没有用新结论抹掉审计线索。把非抢话改成显式测量范围，并逐字限制“抢话下的半小时未量”，是正确口径。
- 全场只 `arm()` 一次、用 `wait(id, 0)` 读取累计 packet/byte 再做分钟差分，关闭了两条采样线互相 reset 的问题。指标名“下行 Opus 包（含 voice/bed/编码静音）”也准确。
- 共享锁、0700 排他目录、subject preflight、marker、detached process-group ownership、fresh receipts、全场房间 guard 和统一 finally 的组成项基本齐全；优先 import 现有导出而非复制实现是对的。
- 使用 `requestVoiceMode` 的原子、0600 marker 实现，比重新手写 `session.mjs` 里的旧 helper 更稳妥。
- 每轮唯一 nonce、fixture hash、user/assistant transcript ID、exact tool nonce、generation 与预先冻结的两种 RTT 定义，足以避免把任意 assistant final 错算成目标 turn。对 `realtime_transcript` 是 final-only、但 row 没有 `final` 字段的修正也正确。
- `mode=live` 只做候选发现，最终要求原始 `/status` receipt 中出现 `executing`，并只报告实际重叠样本/时段；没有重叠不关闭三条件，方向正确。
- meeting events 标 N/A、区分进程/传输断开与产品 reconnect，避免了虚假的“0 次掉线”。
- manifest 的两仓 SHA/dirty、dist hash、raw artifact hash、monotonic duration、VALID/INVALID 和 secret 最小化契约应保留。
- B 臂约 10 分钟仍然合理；不需要为了形式对称再烧一场 30 分钟，但有效 N 与配对规则必须在运行前冻结。

## Issues & Recommendations

### 1. P0 — `atMs` 不是无损游标；当前去重会静默丢 PCM 帧

`createRayaAudioObserver` 默认把 `nowMs` 设为 `Date.now`（`probes/c9-voice-emitter.mjs:127-130`），并在每次 decoder `data` 回调时写 `{ atMs: nowMs(), pcm }`（`:164-173`）。它没有 sequence number，也没有保证 `atMs` 严格递增。多个 decoder chunk 完全可能落在同一毫秒；系统挂钟也可能校时回退。

因此 plan §1.5 / research §4.3 的“按 atMs 游标去重”若采用常见的 `frame.atMs > lastAtMs`，会丢掉同毫秒的后续帧；若采用 `>=`，则会重复消费 ring buffer 尾部。两种结果都能在不报错的情况下污染秒桶、静默守卫和 bed eligibility。

**要求：**运行前冻结一个严格单调、唯一的 frame cursor，并给重复时间戳/时钟回退/环形缓冲溢出写反例单测。方案 A 下不需要改 Raya：可以把已导出的 `createRayaAudioObserver` 通过 `loginDiscordEmitter(..., { createAudioObserver })` 注入，用 driver 进程的 monotonic clock 加严格递增序号；或在 driver 侧对同一 timestamp 维护稳定 ordinal，但必须证明跨 ring 滑动不会重复/丢帧。不要再把默认 `Date.now()` 当唯一 ID。

同时在 T0 记录 packet/byte baseline 与 PCM cursor，明确丢弃 join/Live 前的帧；否则第一分钟和第一个秒桶会混入启动期。预先写死最大允许 poll lag，保证它严格小于 1500-frame ring 的覆盖窗口；超过即 INVALID，不能只写“不可解释的大 gap”。

### 2. P0 — 强制 RMS 三档仍不能证明 voice/bed/silence，必须允许 ambiguous 并 fail closed

plan §1.5.1 假定“voice=最高档、bed=中间档、silence=最低档”。源码不提供这个保证：BoxB 本身有衰减包络（`apps/voice/src/audio/Bed.ts:42-67`），quiet phoneme/语音停顿与 bed 尾部的 RMS 区间可以重叠；`Mixer.ts:8-20` 还会在 voice 到来时逐帧 duck bed。一次已知回答、一次 bed 窗和一次空闲窗只能校准样本，不能证明后续所有帧可被一个 RMS 阈值无歧义地三分。

这个错误会同时伤害两条核心结论：quiet voice 被判成 bed/silence 后，静默守卫可能在 Raya 正说话时注入；普通低能量内容被判成 bed 后，探针会被错误计入 bed ON 分母。

**要求：**

1. 分类结果至少改为 `voice | bed | silence | ambiguous/unknown`，不得强迫每帧落入三档；静默守卫只接受连续 3 秒无 voice **且无 unknown**。
2. bed 证明应优先使用 BoxB 的已知频谱/模板特征，而不是只靠“中间 RMS”。pilot 用多个已知 voice/bed/silence 窗建立 calibration，再用未参与定阈值的 holdout 窗验证；任何类别重叠或 OFF 臂仍出现 bed signature 都让尺子 `INSTRUMENT_FAIL`。
3. instrumentation calibration 的阈值、特征、样本窗和 holdout 结果在正场前冻结并进 bundle；这是尺子资格，不是产品 PASS/FAIL 阈值。
4. plan §1.5.1 说负对照“不做就不许开正场”，但 §2 当前顺序是 A 正场后才跑 B。应把短 ON pilot → OFF 负对照/B → 冻结 classifier → A 正场；或者在 A 前增加一个独立的 OFF calibration pilot。不得先跑 30 分钟 A，再用失败的 B 证明 A 的 bed 标签从未有效。

### 3. P0 — bed 探针只证明“窗内出现过 bed”不够；必须排除播放期间的 voice/barge overlap

plan §1.8 只要求“探针播放窗内确有 bed 档”。工具 response 可能在 3 秒 pre-guard 通过后、探针播放到一半时开始出声。此时窗口同时含 bed 与 voice，甚至会触发 barge；当前规则仍可能因为“出现过 bed”把它算作有效 bed probe，和“本场只测不抢话”矛盾。

**要求：**bed probe 的 post-hoc eligibility 必须同时满足：预定义数量的可靠 bed-signature 帧；整个 `playbackStarted → playbackEnded`（加上事先定义的 guard/tail）没有 voice 或 unknown 帧；没有该轮关联的 `barge_* acted` / response cancellation；user transcript 的 nonce 匹配该轮。任一不满足都记明确的 `ineligible:voice_overlap | ambiguous_audio | barge_acted | not_in_bed_window`，不进入 hit/miss 分母。

普通 turn 也应在 playback 后做同样的 no-voice/no-unknown eligibility 复核，而不只依赖播放前 3 秒。否则“刚开始播时 Raya 突然开口”的轮次会污染 turn 完成率。

### 4. P1 — lifecycle 组件已列齐，但现有启动/错误/收尾顺序仍不等价

有三处具体不一致：

- plan §1.1 说实现 `readyCensus`，但 §1.2 启动图没有调用它。现有 `runVoiceSession` 是先轮询 `readyCensus` 确认 voice bot 已在目标房且无第三人（`session.mjs:210-216,282-297`），再校验 fresh Discord-ready receipt、安装 guard、join emitter。请把这一步显式放回图和验收测试，不能只等 receipt。
- plan §1.3 写“receiver stream error 来自 observer.audioError”，但 `audioError` 是 `createRayaAudioObserver` 的私有变量；`loginDiscordEmitter` 不暴露它。更糟的是一旦 `packets > 0`，`wait()` 在 `c9-voice-emitter.mjs:246-256` 会先返回 snapshot，后续 decoder/stream error 不会走到 `audioError` 检查。方案 A 若不改 Raya，就删掉这条不存在的直接 guard，改由 packet/PCM 停止推进与秒桶 gap fail closed；若必须区分 error/end 原因，则需要显式的本地 observer adapter/API，不能声称现有导出已经提供。
- plan §1.4 的顺序是“写 manifest + secret scan → post-cleanup census”。这样 cleanup 不收敛发生时，最终 manifest 已经可能写成 VALID，且新增错误也未经 secret scan。应先完成进程退出与 post-cleanup census，汇总所有 cleanup errors，再原子写最终 manifest，最后 secret scan；若 scan 失败，另写一个最小、无敏感内容的顶层 INVALID receipt。`emitter.leave()` 本身已经 destroy observer（`c9-voice-emitter.mjs:289-296`），外部也拿不到独立 observer handle，因此“leave → observer.destroy → emitter.destroy”应改成符合公开 API 的一次幂等 teardown。

这些路径需要 lifecycle 级单测，不应只列在“纯函数”测试里：至少覆盖 stale ready receipt、ready census 不收敛、第三人/identity leave、child exit、PCM 停止推进、signal、cleanup census failure，以及“cleanup failure 最终一定覆盖先前 VALID”。

### 5. P1 — runner 候选字段名会把候选筛空

plan §1.9 写“对候选中 `session_status=running` 的至少一个”再打 `/status`。但 `GET /api/sessions?mode=live` 返回的 `Session` 字段是 `status`（`packages/teamlead/src/StateStore.ts:1228-1239`，路由在 `bridge/tools.ts:145-161,239-242`）；`session_status` 只由单 session `/status` 响应追加（`tools.ts:362-370`）。

**要求：**候选发现使用 `candidate.status === "running"`；随后 `/status` receipt 同时要求 `receipt.session_status === "running" && receipt.status === "executing"`。为两种 JSON shape 各写 schema/parser 单测。否则照计划字面实现会得到零候选，并把一场可用观测误判为“无编排重叠”。

### 6. P1 — research 仍残留多处已被 v2 推翻的口径，必须同步清理

这不是要求删历史更正；§3/§4.1 的纠错轨迹应保留。需要修的是仍被写成当前事实的冲突：

- research §1.3（lines 47-57）仍说 `last_activity_at` 在动才叫 runner 忙；应改成 plan 的 candidate `status` + `/status executing` 契约。
- research §2.1（lines 84-91）仍写“两臂同一场”，与 plan 和 research §7 的“必然第二场”冲突；应写“两场同链路、同句表、只差启动配置”。
- research §4.5 说 `audio_counters` 是 voice/bed/silence 成分总账，但 `Downlink.ts:211-214` 对非 voice 一律记录 `silence`，bed 并没有独立 counter。它最多是 voice vs non-voice/其他 outcome 的总账，不能验证 bed 秒数。
- research §6.1 的 FLY-2383 编排行仍写 “Bridge live session 窗内采样”，应明确是 live 候选 + `/status executing` 重叠。
- research §1.1/§2.1 继续用 `realtime_transcript(..., final)` 作为 row 形状时，应改成“final-only evidence row”，避免与 plan §1.7 的正确字段契约再次冲突。

### 7. Repository boundary decision — 接受 A，但 contract-version 不能被描述成内部模块的完整漂移保护

**裁决：选 A。** P0-2 的 parity 不要求 driver 住在 Raya；它要求 marker、preflight、lock、fresh receipts、guards 和 teardown 的行为等价。对这次一次性、Flywheel PRD 驱动的数据交付，driver + docs 在一个 Flywheel PR 里更合适，且“不改 Raya 一行”减少了范围。

但 research §5.272-274 的“握手不上就停，因此不会静默跑在漂过的 harness 上”说得过强。`CONTRACT_VERSION` 是 529 场景协议版本，不保证这些被直接 import 的内部函数在语义调整时一定 bump。路径/导出被删会 import-fail，但兼容签名下的语义漂移不会。

**A 的附加条件：**正场要求 harness 与 subject 的 realpath、完整 SHA、dirty bit 和 dist hash 在 preflight 时锁定；本单既然明确基于 `b1b5a64`，建议默认要求两者 clean 且 HEAD 等于预期 full SHA，不符则 exit 78。若确实要允许另一个 SHA，必须通过显式 `--expected-harness-sha/--expected-subject-sha` 更新运行声明，不能只在事后 manifest 里发现。修正这句话后，A 的风险是可接受的，不需要改走 B。

## Verdict

**CHANGES REQUESTED**

批准所需的最小 delta 是：建立唯一单调 PCM cursor；把强制 RMS 三档改成带 unknown 的、先通过 OFF/holdout 的 fail-closed classifier；对整个播放窗排除 voice/barge overlap；修正 ready/error/final-manifest 顺序；把 runner 列表字段改为 `status`；同步清掉 research 的残留冲突。仓库方案 **A 已接受**，无需因 lifecycle parity 改成 B。
