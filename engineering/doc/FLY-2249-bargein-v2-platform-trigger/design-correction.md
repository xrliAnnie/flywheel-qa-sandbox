# FLY-2249 heard-position note — 设计更正
Issue: FLY-2249 (https://linear.app/geoforge3d/issue/FLY-2249/raya语音-barge-in-v2正确方向重做-消费平台-speech-started-触发现被静默丢弃保留停口恢复资产检测确认层按)
日期: 2026-09-02
基于: qa-report.md

## 更正边界

已批准的 `plan.md` 保持 pinned,不回写。本文件记录独立 QA 对 C6 假设的运行时证伪,以及 Lead `[lead-instruction 3ecddeb5-d7a0-4d39-95ad-3983097c5432]` 的实现裁定;它只更正 heard-position note 的传输角色和验收降级路径,不改变平台 `speech_started` 主触发、神经确认层、0.55s 下行冲刷或被打断条目恢复资产。

## 运行时地面真相

- 真机证明 `appendText(..., "developer")` 会先在 RPC 层返回成功,随后被 OpenAI Realtime 异步拒绝并终止会话。`system` 不在 Codex realtime 文本角色枚举中,同样不可用。
- 当前 Codex realtime RPC 面只有六个已投影方法,没有 `session.update` / instructions 更新入口。因此本单不能用 session instructions 承载 heard-position。
- 最终路径是 generation-bound `appendText(note, "user", generation)`:文本以 `[旁注,勿回应]` 开头,明确说明它是应用同步状态、不是用户新发言;只创建 context item,绝不调用 `thread/realtime/createResponse`。对应 transport 单测直接检查请求流不存在 `createResponse`。

## 真房语义臂与退路

在 exact Raya head 上启用 note,完成至少 N=5 次真实打断。每轮必须同时保留 `noteAckAtMs`、`nextResponseAtMs`、user final、assistant final、耳侧音频和 realtime tap,逐轮确认 note 之后没有可归因于 note 的新 response、assistant 转写或音频;正常由 founder 新发言触发的下一轮必须单独归因,不能把时间接近当成 note 成功或失败。

若这条 N≥5 语义臂任一轮失败,本单不继续调 prompt:将 `bargeInHeardPositionNote=false`,重跑 note-off 对照,heard-position 只保留 `barge_heard_position` evidence 和人工最后可听词核验。该降级不删除账本,也不改变停口/恢复链。

## 未改变的硬边界

- C7.5 仍为 **未完成·待 founder 真人语料**;合成呼吸/附和不得冒充验收。
- 停口延迟只由 bot 耳侧 `audible_gap` 判定,server tap gap 只作诊断。
- 每条 `uplink_gate_utterance` 记录 `scoreCount / scoreMsP50 / scoreMsP99`;真房生产单进程要求 p99 `≤5ms`,不能用静态预算替代实测。
