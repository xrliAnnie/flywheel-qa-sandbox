# FLY-2655 Realtime R1 复审处置 — 实施计划
Issue: FLY-2655 (https://linear.app/geoforge3d/issue/FLY-2655/2598follow-up-raya-rg-语音会话-live-10-秒即-faileddiscord-audio)
日期: 2026-09-20
基于: design-correction.md

R1 question 10a6ac2a-0712-49cd-b792-3edf6bf6f3eb / request e96aaec1-7038-4a53-99e2-45fca321a709：有效CHANGES_REQUESTED。以下仅为设计修正，不表示实现已修好。

- HIGH `speech-deadline-vs-600-char-chunks`：§5/5.1：投影后句级≤80码点；共享生成预算+独立播放预算，保留全部文字。
- HIGH `exact-readback-gate-yields-silence`：§5：唯一spokenText先scrub；有限读法等价，不再session原文二道门；失败显式文字提示且仍QA不通过。
- HIGH `transcript-chain-stall-kills-session`：§4：failed/empty/timeout均tombstone推进tail；测试A空/B失败/C有效。
- HIGH `session-update-sends-unupdatable-model`：§3：model只在URL，不放session.update；E5真实断言。
- HIGH `model-echo-snapshot-vs-alias`：§3：精确别名或有效日期同族快照，created/updated一致并记录resolvedModel。
- MEDIUM `buffered-audio-released-in-one-burst`：§5.1：每tick一帧、块队列、播放完成输入才处理下段。
- MEDIUM `no-session-expiry-handling`：§3/5.2：expiry提示与ended结局；不自动重连。
- MEDIUM `response-created-metadata-echo-assumption`：§5：有metadata严格核；无metadata唯一inflight+完整内容门，E5核真实回显。
- MEDIUM `backtoback-finals-drop-speaker-epochs`：§4：发送sample位置绑定item owner；队列携带元数据，禁止final时批量consume。
- MEDIUM `flush-session-end-contract-ambiguous`：§5.2：未放行失败只清该段+提示，已播放故障才stop并Bridge failed/本地interrupted；所有结果明确定义。
- MEDIUM `maxpayload-equals-per-event-cap`：§3：2MiB wire vs1MiB decoded delta，单响应2MiB。
- LOW `realtime-voice-not-enum-validated-at-daemon-boundary`：§3/E3：HTTP边界复用共享voice枚举，禁止复制。
- LOW `qa-legacy-frames-identity-key-ambiguous`：§6 E4：旧未open零帧不参与冲突，非零缺身份标unknown。

本轮HIGH均修改设计重新送审。MEDIUM/LOW中直接影响新adapter可达性或硬门禁的有限修正纳入；历史DAVE/卡片等advisory仍按原review-disposition.md后续账处理，未扩修生产。
补充：review对session.update同model是否总被拒的推断没有新实测；采用不发送model的稳健方案，不将其当已证原场根因。alias快照和metadata形状同样须E5真实取证，不宣称本design已观察。


## R2 处置与R3范围

R2 question 75d4e6dd-29db-4220-86ce-d3871a5e024f / request fbe2d8fe-7c84-4a15-b338-4a1d61961ee1：有效CHANGES_REQUESTED；完整原文realtime-design-review-r2.json。

- HIGH `ended-reason-not-accepted-by-statestore`：源码复核成立。附录§2.1与E2补齐StateStore两道白名单、保持text-stop/lease/CAS边界，以及实际Store/route终态、outbound结算与daemon本地清理测试。
- MEDIUM `skipped-only-reply-receipts-confirmed`：附录§5/E2明确空数组/全skipped=dropped，禁止默认confirmed。这是补齐已有skipped路径的收据，不增加功能。
- MEDIUM `playback-deadline-is-total-duration-not-stall`：Follow-up。当前总PCM时长+5s预算保持；QA记录真实播放时长/丢拍，若触发则不得以单测或文字兜底判真人PASS；交Lead决定后续调整。
- MEDIUM `segment-serialization-doubles-reply-latency`：Follow-up。保留逐段完整校验后串行播放；首声/段间静场与总时长按E4记录。没有新增预生成并行队列；真人体验不通过不能算PASS。
- LOW `capacity-reason-token-overloaded`：Follow-up。本轮实际正常终态固定ended/realtime_capacity，pending溢出仍failed，状态与原因联合取证；不把文字表格capacity当正常结束指令。
- LOW `expiry-fallback-55min-unverified`：Follow-up。55分钟为未实测兜底，不声称API寿命保证；E3既有expiry证据与E5真实配置记录交QA，缺失/提前断开不能当通过。
- LOW `dead-code-disposition-unlisted`：Follow-up。后继执行仓库不可达代码清理规则并在实现PR列去留，当前design未删除实现；不要悄悄保留第二套出声授权入口。
- LOW `uplink-drop-counters-absent-from-evidence`：Follow-up。现有计数的接入未在本轮扩写实现范围，QA报告应说明该可观测性缺口，缺证据的假说不得下肯定结论。

以上Follow-up不是对HIGH的治理裁决；有效门禁仍须R3新review。按Lead指令若R3仍HIGH，携findingKey与源码证据请求Lead review-ruling，不自行无限加轮或以本段文字代替治理。


## R3有效批准

R3 question 1e7e6c09-a3ae-423c-b952-183e8235892e / request 508b90a8-5c0e-409f-b9fe-0a5f0818417f：有效APPROVED，0 HIGH、3 MEDIUM、6 LOW。完整原文realtime-design-review-r3.json，9项逐项交接及测试路径勘误见realtime-handoff.md；受审plan/correction字节保持冻结。设计批准不等于实现或真人QA通过。
