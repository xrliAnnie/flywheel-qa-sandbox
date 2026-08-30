# FLY-2031 Founder 真机首轮 — FAILED 证据
Issue: FLY-2031 (https://linear.app/geoforge3d/issue/FLY-2031/rayav3-随身语音b常开流-念读筛选-用嘴批-ship)
日期: 2026-08-28
基于: founder-round-runbook.md、founder-round-baseline-20260828.json

## 结论

本轮是实际 `voice-test-2` 界面上的**失败轮**，不得用于通过验收。Lead 已让 Founder 离房，并只 bootout `com.xrli.raya.voice.fly2031.qa`；生产 label 未触碰。Relay、P2、P3 均未继续执行。

## 可复核事实

- 场前误用了 6 条历史 `c9-*` item，而 runbook 要求每轮使用全新 id；`c9-inbox-report-01` 还已有旧 `spoken` ack，因此 fixture 本身无效。
- 本 boot 的新增 evidence 是 `voice-evidence/events.jsonl` 第 343–386 行。06:54:55Z 起出现 9 次 `speech_injected`，随后 9 个 assistant final 都没有念出 item 正文，所有尝试均写成 `inbox_speech_unconfirmed`。
- assistant final 的代表性原文是「好的，那就继续吧，我在听」和「了解，最后一条继续吧」。这证明模型把系统播报当成了让 Annie 继续念的对话提示。
- ✅ `speakerUserId` attributed 的 Annie final（evidence log 原文）：「啊,你把话都说完了,我都没话可说啊。」时间为 06:55:41.667Z。
- Founder 现场证词（Lead 按原句转达；不是 evidence log transcript）：「全程自言自语/说自己在念/完全插不进嘴」。该证词与事件链相符，但来源类别保持分开。
- 从首个本 boot `speech_injected` 到首个 attributed user final 约 46 秒；因此本轮没有留下“连续 self-mute 3 分钟”的充分证据，不能判通过。

## 处置

1. 停轮并保留全部旧 item、ack 与本 boot 失败事件，不删除、不改写。
2. `Speaker` 的每次系统注入都增加明确指令：Raya 必须直接对 Annie 说出下一行正文，不得回复播报、不得让 Annie 来念。
3. inbox ack 改为必须在无 intervening user final 时，由 post-cursor assistant final 实际包含该 chunk 正文；无编号 prose 不再因空 identifier 集合而 vacuous confirm。
4. 第二轮前先在无 Founder 场用 loopback listener 听到全新 item 正文；自检不过不再占用 Founder 时间。

## 本轮验收矩阵

| 项目 | 结论 | 证据 |
|---|---|---|
| 常开流/主动打破沉默 | `not proven` | 有主动注入和 assistant 音频，但 3 分钟窗口未证 |
| 念读正文 | `failed` | 9 个 generic assistant final，正文零确认 |
| 新 id + 优先级 | `failed` | 使用历史 `c9-*` fixture |
| 筛选/偏好 | `not run` | 停轮 |
| relay/P2/forged speech | `not run` | 停轮 |
| P3 用嘴批 ship | `not run` | 停轮 |
