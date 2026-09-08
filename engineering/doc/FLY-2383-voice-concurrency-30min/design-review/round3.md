# Design Review — plan.md (Round 3)

Date: 2026-09-06
Author: Codex
Status: CHANGES REQUESTED

## Summary

v3 已经关闭 Round 2 的大部分实质问题：严格递增 seq 的方向正确；`unknown` 成为 fail-closed 类别；OFF 负对照已移到正场之前；普通 turn 与 bed probe 都增加了播放后 overlap 复核；runner 两种响应 shape、cleanup 后定稿 manifest、SHA 锁和方案 A 的边界也都写对了。

仓库裁决不变：**方案 A 继续通过**，P0 lifecycle parity 不要求 driver 住进 Raya 仓。

本轮仍是 **CHANGES REQUESTED**，但剩余 delta 已明显缩小。最主要的可执行性错误是：计划把 Prism decoder 的一次 `data` callback 直接称作“一帧”，但 Node stream 的 chunk 不承诺等于一个 3,840-byte/20ms PCM frame；Raya 已经有并导出了专门解决此问题的 `createPcmFrameTap`，计划却没有使用。并且 Flywheel 根目录不能直接 resolve `prism-media`，方案 A 还缺少从 Raya dependency root 解析 decoder 的明确契约。若照当前示例实现，Goertzel/RMS 的采样长度和 seq 单位可能不稳定，核心分类器仍不可采信。

此外，research §4.3 仍完整保留 v2 的 `rayaPcmFrames + atMs 去重 + RMS 三档` 作为当前方案，§4.4 仍写不可观测的 receiver stream error/end；最终附录又漏掉 `unknown` 秒数并保留 `stream error`。这些与 v3 的核心纠错直接冲突，不能让实现者或报告读者自行猜哪份契约生效。

## What's Good (Keep)

- driver-owned、strictly increasing `seq` + `performance.now()` 的设计从根上摆脱了 `Date.now()` 非唯一/非单调问题；T0 packet/byte/seq baseline 与丢弃启动期帧也正确。
- 全场只 arm 一次、永不调用 `rayaPcmFrames()`、packet 走累计差分，关闭了 observer reset 与 ring cursor 两类污染。
- 四分类 `voice | bed | silence | unknown`、unknown 不视为安全、分类失败则 `INSTRUMENT_FAIL`，是正确的 fail-closed 方向。
- 在 RMS 之外加入 BoxB 频点 tonal feature，承认 decay envelope 与 ducking 会使纯 RMS 不成立；pilot、holdout、OFF negative control、freeze-before-A 的顺序正确。
- bed probe 的四条 eligibility 与普通 turn 的 post-playback no-voice/no-unknown/barge 复核，已经关闭“播放中途 Raya 开口仍被算有效”的问题。
- `readyCensus`、fresh receipts、room/identity guard、child exit、PCM/packet 停止推进、cleanup census 和 signal 测试均已进入 lifecycle 测试清单。
- 最终 manifest 已移动到 cleanup census 之后，cleanup failure 可以覆盖先前 VALID；公开 teardown API 也已改成一次 `emitter.leave()`。
- Bridge 列表用 `candidate.status`，单会话 receipt 用 `session_status + status`，并要求各自 parser 单测，正确。
- research 的 runner、两场 A/B、audio counters 和 final-only transcript 五处旧口径已经按 Round 2 要求修正。
- 两仓必须 clean、匹配预期 SHA、另一个 SHA 必须显式声明，而不是只在事后 provenance 里发现，符合方案 A 的风险边界。

## Issues & Recommendations

### 1. P0 — decoder `data` chunk 不是稳定 PCM frame；当前 seq/Goertzel 的单位没有立住

plan §1.5.1 的示例直接在 `decoder.on("data", chunk)` 中 `seq++` 并把 `chunk` 送入 sink，然后写“每一帧只经过我们一次”。这不是 stream API 提供的保证：一个 `data` chunk 可以包含多帧，也可能是非完整帧边界。`frameSize: 960` 是 Opus decoder 配置，不是 Node `data` callback 边界契约。

Raya 当前模块已经给出正确先例：`probes/c9-voice-emitter.mjs:33-55` 导出的 `createPcmFrameTap` 会跨 chunk 累积，并且只在凑齐 **3,840 bytes = 960 个 48kHz stereo sample frames = 20ms** 时调用 `onFrame`；其现有测试 `c9-voice-emitter.test.mjs:288-305` 还专门覆盖了 split/coalesced input。

**要求：**旁路必须改成 `decoder.pipe(createPcmFrameTap(onFrame))`（并消费 tap 输出），只在 `onFrame` 回调里分配 seq、取 monotonic timestamp 和计算特征。不要复制 framer，也不要继续把 raw decoder chunk 叫 frame。测试必须喂入“一次多帧、跨 chunk 半帧、末尾 partial”并证明每个完整 3,840-byte frame 恰好产生一个连续 seq，partial 不进入分类。

特征提取还需明确 stereo 处理：BoxB 左右声道相同，但 3,840-byte frame 是 interleaved stereo。Goertzel 输入应先固定为一个 960-sample mono 序列（例如校验 L/R 后取单声道或明确定义 downmix）；不能把 1,920 个交错 sample 当作 48kHz mono，否则五个目标频率的解释会错。

### 2. P0 — 方案 A 的示例目前拿不到 `prism`；必须从 Raya dependency root 显式解析

`c9-voice-emitter.mjs:15-31` 自己通过 `createRequire(new URL("../apps/voice/package.json", import.meta.url))` 解析 `prism-media`，因为它是 Raya voice app 的依赖。Flywheel 根目录的 driver 若照 plan 示例直接使用 bare `prism`/`import "prism-media"`，没有同一解析上下文；本轮从 Flywheel 根执行 `require.resolve("prism-media")` 实际返回 `NOT_FOUND`。

**要求：**在方案 A 契约里写明 decoder dependency 的来源：用 `createRequire` 锚定已通过 realpath/SHA 校验的 `${harnessRoot}/apps/voice/package.json`，再加载 `prism-media`；或使用另一个同样绑定到 pinned Raya root 的明确办法。禁止依赖开发机恰好 hoist 的 transitive package。该 dependency anchor 也必须进入后述统一常量/路径块和 provenance。

### 3. P1 — classifier holdout 还缺最危险的 bed→voice/duck 混合边界

当前 holdout 只写“另留未参与定阈值的窗，类别重叠则失败”。实际 eligibility 最怕的不是纯 voice 与纯 bed，而是工具 response 开始时的 **bed + voice 混合/duck 过渡**：`Mixer.ts:12-19` 会逐帧压低 bed，短窗内仍可能同时有 BoxB tonal energy 和 voice。若这种帧被规则第二行判成 bed，post-playback 检查就会漏掉真正的 voice overlap。

**要求：**把 transition/mixed window 明列为 classifier qualification case：已知 bed→assistant voice 起音及 duck 过渡中的帧只能是 `voice` 或 `unknown`，不得落成 `bed`/`silence`。最好增加经过相同 Opus encode/decode 链的离线混合 fixture，再用 pilot 真房 transition 作 holdout；任一危险误分类则 `INSTRUMENT_FAIL`。同时对 `energy < silenceFloor` 的第一优先级验证 quiet-voice 样本，避免低能量音素被无条件当成 silence。

这不要求 classifier 在所有帧上高覆盖；大量 unknown 可以接受并如实报告，但不能以漏报 voice 换有效样本数。

### 4. P1 — plan 的最终报告形状仍与“unknown 一等公民/无 receiver error guard”冲突

- plan §3.2 仍写 `voice / bed / silence 秒数`，漏掉 `unknown`。既然 §1.5.2 明确“unknown 多本身就是数据”，附录必须报告 `voice / bed / silence / unknown` 的秒数、占比或桶数；不能在采集层保留、到报告层消失。
- plan §1.5.4 写“电话里有没有声音由 voice 档秒数回答”不准确：bed 也是可听声音。应分别写“Raya 说话由 voice 档回答；已识别的可听内容至少包含 voice + bed；unknown 不外推”。
- plan §3.2 的断档行仍列 `stream error`，但 §1.3 已正确承认 receiver stream error/end 不由公开 API 暴露。可以报告 driver 自己看到的 decoder error、packet/PCM 停止推进和秒桶空洞；不可把未观测到的 receiver stream error 写成 0 或预设成必有字段。

### 5. P1 — `readyCensus` 仍只在图外注释，guard 安装也没有进入可执行启动序列

用户说明称“readyCensus 放回启动图”，但 plan §1.2 的 Mermaid 仍是 `spawn → 等 fresh Discord-ready → emitter join`，没有 `poll readyCensus` 节点，也没有“安装 voice-state guard”节点；正确顺序只存在于图后的说明。

**要求：**把唯一规范启动序列直接改成：initial empty census → 安装 guard（或安装后立即 re-census，避免订阅前进入者漏报）→ marker/spawn → race child/refusal 并 poll readyCensus → fresh Discord-ready receipt → emitter join → post-join ready census → arm → fresh Live → T0。至少保证 census 与 guard 之间不存在“第三人已进入但没有后续 event”的盲窗。实现与 lifecycle 测试都以这条唯一序列为准，不应让图和文字给出两套顺序。

### 6. P1 — research §4.3/§4.4 仍是 v2，必须同步为 v3

research 当前仍把以下内容写成“⇒ 改成”的现行方案，而不是历史引用：

- `maxPcmFrames:1500`；
- 每 3 秒调用 `rayaPcmFrames()`；
- 按 `atMs` 去重；
- 单一 RMS 的 voice/bed/silence 三档；
- receiver stream error/end 是本场可直接读取的证据。

它们分别与 plan §1.5 的“永不调用 `rayaPcmFrames()`、strict seq、energy+tonalRatio 四类”和 §1.3 的“公开 API 不暴露 receiver error”正面冲突。请把 research §4.3 改为 side decoder → exact PCM framer → seq/monotonic → bounded sink → feature/classification 的现行设计，并在 §4.4 把连接证据改成实际可观测的 packet/PCM progression、decoder error（若旁路监听）与秒桶空洞。历史错误可以像 §4.1 一样保留为带日期的纠错块，但不能继续放在“当前方案”标题下。

### 7. Lead 新增约束应写进 plan；它是方案 A 的 drift contract，不只是实现备注

**是的，应写进 plan。** Lead 已明确要求“三个跨仓 import 路径 + 期望 CONTRACT_VERSION 收敛成 driver 一处常量块、报告首页注明”，这既是 acceptance provenance，也是方案 A 防止路径/协议散落的核心约束。

请在 §1.1 或 §1.10 增加一个明确的实现/验收项：driver 只有一个 frozen constants object，包含 Lead 指定的三个相对 import path、`EXPECTED_CONTRACT_VERSION`、预期完整 SHA `b1b5a64f2f060349b95f39c6cf4b05b453a6a7f1`，以及用于解析 Prism 的 Raya package anchor；所有动态 import、握手和报告首页都从这一处取值。若 Lead 所说“三个路径”是经过 facade/re-export 后的三条，plan 应逐字列出那三条，不能让实现者从当前表格里的多个 Raya 文件自行猜测。

## Verdict

**CHANGES REQUESTED**

批准前所需的最小 delta：使用 `createPcmFrameTap` 建立真实 20ms frame 边界并固定 stereo→mono；从 pinned Raya dependency root 解析 Prism；给 classifier 增加 mixed/duck holdout；让最终报告包含 unknown 且只写可观测错误；把 readyCensus/guard 放入唯一启动序列；同步 research §4.3/§4.4；写入 Lead 的统一常量块约束。
