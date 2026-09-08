# Design Review — plan.md (Round 4)

Date: 2026-09-06
Author: Codex
Status: CHANGES REQUESTED

## Summary

v4 已经把 Round 3 的七项技术问题实质关闭：exact PCM framing、Raya-root Prism resolution、stereo→mono、mixed/duck 与 quiet-voice qualification、四档报告、唯一 lifecycle 序列、research 同步和 Lead 常量块都已进入规范。方案 A 继续成立；我没有发现需要因此迁回 Raya 仓的理由。

本轮只剩 **一个会让核心数据不可采信的 blocker**，因此仍判 **CHANGES REQUESTED**：plan §1.8 把“user transcript nonce 匹配”同时当成样本 eligibility 条件和识别命中判据。未识别或错误识别的探针因此会被排除分母，而不是计为 miss，命中率会产生选择偏差，极端情况下必然显示 100%。同一套四条件还要求存在 bed signature，若原样用于 bed-OFF 臂，B 臂所有样本都会天然 ineligible、分母为 0。

除这一处分母契约外，未发现新的数据可信度 blocker。下列 minor notes 可以在实现/代码评审阶段吸收，不阻塞计划批准。

## What's Good (Keep)

- `createPcmFrameTap` 复用、3,840-byte frame 边界、partial 不分类和 split/coalesced/partial 测试契约正确。
- Prism 解析明确锚定已校验的 Raya `apps/voice/package.json`，不依赖 Flywheel 根目录 hoist；方案 A 现在具备可执行的 dependency provenance。
- 960-sample mono、48kHz Goertzel 输入被明确冻结，避免把 interleaved stereo 当 mono。
- 四分类保留 unknown 并在 guard 中 fail closed；mixed/duck 和 quiet-voice 均成为必须通过的 qualification，OFF negative control 也已移到 A 正场之前。
- 唯一启动图已经包含 SHA 锁、guard-before-spawn、guard 后 re-census、readyCensus、post-join census、single arm、fresh Live 和 T0 baseline。
- cleanup errors 在最终 manifest 之前汇总；报告只列 driver 实际可见的 decoder error、packet/PCM progression 与桶空洞，不再制造 receiver-error=0。
- research §4.3/§4.4 已与 plan v4 对齐，并保留 v1/v2/v3 的纠错轨迹。
- Lead 指定的七条 import path、expected contract、full SHA 和 Prism anchor 已收敛到单一冻结常量块，并要求进入附录首页。

## Issues & Recommendations

### P0 — 识别结果不能决定自己是否进入分母；ON/OFF 必须有不同的音频 eligibility

plan §1.8:385-394 当前要求四条全部满足才算有效样本，其中 d 是“user transcript 的 nonce 与该轮匹配”；任一不满足都不进 hit/miss 分母。随后第 ④ 步又用同一个 nonce 匹配判断是否识别命中。

这形成循环定义：

```
nonce 匹配     → eligible → hit
nonce 不匹配   → ineligible → 不计 miss
没有 transcript → ineligible → 不计 miss
```

所以“命中/有效 N”不再是识别命中率，而是“已经命中的样本里有多少命中”。这会系统性抬高数字，正是本任务禁止的 silently overstate。

同时，条件 a 要求播放窗内存在 bed signature。它只适用于 ON；B 臂配置 `bedEnabled:false`，若沿用同一 eligibility，B 的所有正常探针都会成为 `not_in_bed_window`，无法形成对照分母。

**必须改为两个正交阶段：**

1. **先判 audio/instrument eligibility，与 STT 结果无关。**
   - ON：fixture 完整播放；播放窗满足预先冻结的 bed-signature 下限；全窗无 voice/unknown；无 barge/cancel；sampling/clock 正常。
   - OFF：fixture 完整播放；同类 busy 窗内确认 bed signature 缺席；全窗无 voice/unknown；无 barge/cancel；sampling/clock 正常。
   - OFF 若检测出 bed signature，应按 §1.5.3 判 classifier/negative-control `INSTRUMENT_FAIL`，而不是普通 `not_in_bed_window`。
2. **对每个已满足 audio eligibility 的播放尝试再判 recognition outcome。** 固定 timeout 内出现匹配 nonce 的 user final = `hit`；没有 user final、只有不匹配/错误文本、或超时 = `miss`，并保存实际观察到的 transcript。识别结果不得反过来改变 eligibility。

目标 N 也应定义为“两臂各自预先冻结的 **audio-eligible playback attempts** 数”，不是“成功识别的 N”。miss 必须永久留在分母。若因 voice overlap/unknown 等音频混杂而补打 replacement，需预先冻结最大总 attempts/调度规则，并同时报告 `attempted / audio-eligible / ineligible-by-reason / hit / miss`，不能一直补到出现 N 个 hit。

附录行建议改成：

```
忙窗探针识别（A: bed confirmed；B: bed absent confirmed）
attempted / audio-eligible / hit / miss；ineligible 原因另列
```

这不是文字偏好，而是决定 A/B 识别数字是否成立的分母契约。

### Minor notes（不阻塞本轮数据设计）

- pre-join 的现有 `readyCensus` 只要求 voice bot 在目标房且所有成员属于 allowlist，并不要求 emitter 已在房；post-join census 才应要求 voice + emitter 两者都存在。建议把两个 predicate 分名，避免照“房里只有 voice+emitter 两个 bot”实现成 pre-join 永久等待。
- 启动图目前先 import/握手再做 SHA 校验。更严谨的实现是先用本地 Git/read-only 操作校验 harness realpath/SHA/dirty，再执行任何跨仓模块；这避免 drifted module 的 top-level code 在拒跑前被执行。它不改变有效场次数据，故列为 minor。
- driver 旁路若要报告 decoder error，代码中应同时监听 decoder 与 PCM tap 的 `error`；即使遗漏，PCM progression/gap 仍会使场次 INVALID，因此不单列 blocker。

## Verdict

**CHANGES REQUESTED**

只需关闭一个数据 blocker：把 audio eligibility 与 STT hit/miss 完全拆开，并分别定义 bed-ON 与 bed-OFF 的 eligibility。完成后，按当前计划其余部分可进入实现与代码评审。
