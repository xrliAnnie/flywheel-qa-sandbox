# FLY-2798 后续对齐事项 — 调研
Issue: FLY-2798 (https://linear.app/geoforge3d/issue/FLY-2798/语音v4-引擎-a前台快答-后台-lead-在现有通用管道上让实时模型自己答简单的复杂的交给)
日期: 2026-09-23
基于: plan.md

R2 有效 reviewVerdict=APPROVED，requestId=4d8297f7-3f79-4590-8d9a-6f4999f82db9，questionId=612688a1-1e25-4d88-a290-8a881e6b7658。以下全为非阻断 advisories，交 Lead 选择跟进；不重写已经批准的 plan blob ee5f97dcf948350857d9ad60e1576183a7ca5c84，也不宣称建议已解决。

| findingKey | 级别 | 后续处置/接口对齐落点 |
|---|---|---|
| cross-unit-file-ownership-collision-with-2796 | MEDIUM | T0 对齐2796最终文件迁移：room闭包迁 voice-bridge/src/room，voice-codex shim不得成为测试假证据；cli/session模式I/O和A装配、delivery canonical与消费分工由Lead明确后实施 |
| result-event-unique-key-field-missing | MEDIUM | 上游 c7189944e §7.1⑦ 字段列表缺 resultEventId、唯一键却引用它，已报告Lead要求2796明确；不能以seq猜唯一键或悄悄降级去重，T0锁批准版本 |
| close-rejection-unhandled-in-rotator | MEDIUM | 未来A接TalkSessionRotator/CLI之前补catch或以typed error+audit而resolve undefined；当前A daemon路径不可达，不伪称已修 |
| followup-question-has-no-frontend-context | MEDIUM | 前台不保留已念Lead正文，涉及上一结果的追问会再交Lead；模式层需明确指代绑定/歧义澄清，不能按latest utterance猜。体验影响已在HTML披露 |
| two-cursor-spaces-not-disambiguated | LOW | T0明确 handoffResultSeq（carrier结果流）与voiceOutboundSeq（房间播放队列）的各自作用域/持久化位置，不可混用 |
| no-simple-question-latency-test-right-after-delegation | LOW | QA再加入delegation封存后、Lead回复前立刻问简单问题，原≤2秒判据不自动豁免；重连影响单列 |
| validation-doc-titled-as-research | LOW | 交付记录改为“交付验证记录 — 调研”，保留注入要求的文档类型行，避免与research标题重名 |

另保留R1 MEDIUM announcer-takeover-rebuilds-live-unconditionally：空闲heartbeat/cue减少重连的优化须先证晚帧安全；本轮保留Lead已批准的统一fence基线，并严格量体验。

## R9 review round 1 非阻断 advisories

以下 finding 来自精确头 `ec9384dca` 的 review request `6929978e-fb50-4d20-a8a0-0432403e680d`。三个 HIGH 已在后续实现头关闭；这些 MEDIUM/LOW 不扩大本轮锁定返工范围，交 Lead 选择后续：

| findingKey | 级别 | 后续处置 |
|---|---|---|
| headphone-collector-blocks-bridge-event-loop | MEDIUM | 缓存 scope/statement、按显式能力门控 collector，并把 question authority 刷新与单页 Discord cadence 解耦，避免每 5 秒同步扫描全部 chat thread。 |
| live-face-stuck-suspended-on-resume-failure | MEDIUM | 为 `live.resume()` 失败增加明确恢复或会话终止语义，避免 suspended 状态永久吞输入，也避免 finally 异常覆盖既有 receipt。 |
| edge-tts-stream-tail-dropped-on-exit | MEDIUM | 把 streaming TTS 完成信号从 child `exit` 对齐到 stdio `close`，消除平台相关的尾帧丢失可能。 |
| handoff-results-not-session-scoped | LOW | results GET 在现有 project/founder 校验外，再绑定 handoff 的 sessionId/generation，补 defence-in-depth。 |
