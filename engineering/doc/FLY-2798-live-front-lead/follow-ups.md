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

## R10 review round 2 非阻断 advisory

以下 finding 来自精确头 `f692b6b23` 的 review request `56d72113-0dd6-4885-b3e2-6cc560eee1aa`。唯一 HIGH 已在后续实现头关闭；该 MEDIUM 不扩大当前锁定返工范围：

| findingKey | 级别 | 后续处置 |
|---|---|---|
| late-frontend-frame-dropped-during-drain | MEDIUM | 把前台 audio boundary 与真实 playback drain 对齐，或为已结束但仍在 drain 的段提供显式续接/缓冲协议，避免 provider delta 间隔超过 idle boundary 时新帧在旧尾音窗口被拒。 |

## R11 review round 3 非阻断 advisories

以下 finding 来自精确头 `0143d079e` 的 review request `47771602-dffb-436a-b6b4-f4a73b41d918`。唯一 HIGH 已在后续实现头关闭；两项 advisory 保持非阻断：

| findingKey | 级别 | 后续处置 |
|---|---|---|
| late-frontend-frame-dropped-during-drain | MEDIUM | round 3 下迟到帧会先 flush 尚在播的旧段再开新段，而不是 round 2 的拒绝新帧；仍需把 provider idle boundary 与 playback drain 对齐，避免同一回答内长间隔造成任一侧音频丢失。 |
| tail-not-shortened-when-cancelling-an-ended-speech | LOW | RoomIO 取消已 end 的 speech 后应让 `tailUntil` 反映实际停止，而非保留整段估算；补共享 RoomIO 合同测试，避免 phantom tail 延后 heartbeat 或阻止后续 clip。 |

## Main-sync 头 069af1144 复审（request 930b3f21）

以下来自精确头 `069af1144` 的 review request `930b3f21-ace1-4bcd-a860-2f10c62f35df`（gate `3a7e1c3e-c429-491d-9578-d2757ed5795b`，CHANGES_REQUESTED，整 PR 全审）。本单 6 条 HIGH 已在后续实现头先红后绿关闭：`ffmpeg-exit-drops-buffered-stdout`、`voice-handoff-cobatched-loses-lead-reply`、`resume-failure-wedges-live-face`、`live-socket-loss-silent-until-next-speak`、`spoken-exit-never-arms-engine-a`、`inbox-acked-before-founder-present`；同时关闭 R9 advisory `live-face-stuck-suspended-on-resume-failure` 与 `edge-tts-stream-tail-dropped-on-exit`（streaming edge-tts 与 ffmpeg 同源的 exit/close 缺陷一并按 close 收尾）。

### 2796 房间层 HIGH（Lead 裁定归 FLY-2860，本分支不改 2796 文件）

| findingKey | 级别 | 位置 | Lead ruling |
|---|---|---|---|
| room-frames-24k-into-16k-consumers | HIGH | `packages/voice-bridge/src/VoiceRoomRuntime.ts:43` | FLY-2860 follow-up `b8054ce3` |
| glaw-room-consumers-clobbered-by-assistant-session | HIGH | `packages/voice-bridge/src/cli.ts:445` | FLY-2860 follow-up `720a7d71` |
| lease-close-ended-reason-refused-by-bridge | HIGH | `packages/voice-bridge/src/assistant/AssistantSession.ts:614` | FLY-2860 follow-up `5aa0d728` |
| glaw-lease-never-renewed | HIGH | `packages/voice-bridge/src/cli.ts:736` | FLY-2860 follow-up `ea2f9685` |

### 非阻断 advisories（MEDIUM/LOW，policy medium_low_findings_are_non_blocking_v1）

| findingKey | 级别 | 位置 | reviewer 摘要 |
|---|---|---|---|
| results-route-unbound-kind-eventid-no-committed-gate | MEDIUM | `packages/teamlead/src/bridge/voice-handoff-routes.ts:378` | HTTP POST /:handoffId/results is far weaker than the producer contract: caller-chosen resultKind/createdAt/resultEventId, no committed-state gate |
| reconcile-unavailable-counted-as-not-found-needs-human-dead-end | MEDIUM | `packages/teamlead/src/bridge/plugin.ts:11840` | Transient CommDB unavailability during reconcile is counted like not-found and burns the 5-attempt budget into a terminal needs_human with no operator surface |
| dispatching-state-no-crash-recovery | MEDIUM | `packages/teamlead/src/bridge/voice-handoff-store.ts:242` | A Bridge crash between beginDispatch and finishDispatch leaves the handoff in dispatching forever |
| plain-outbound-voice-result-forgeable-by-master-token-holder | MEDIUM | `packages/teamlead/src/lead-backends/codexLeadBridgeWiring.ts:142` | On the plain /api/lead-outbound/send path any holder of the shared API token can commit a voice result for another Lead's handoff that is then spoken to the founder as that Lead's answer |
| claim-ttl-cap-below-playback-for-long-items | MEDIUM | `packages/teamlead/src/bridge/headphone-inbox.ts:11` | The 15-minute claim TTL cap is below playback time for items over ~3360 code points, so long items are re-spoken and then stranded |
| headphone-collector-blocks-bridge-event-loop | MEDIUM | `packages/teamlead/src/bridge/headphone-collector.ts:249` | The collector tick runs synchronously on the Bridge loop every 5 s regardless of any headphone session (known R9 advisory, quantified) |
| collector-ingest-throw-starves-all-scopes | MEDIUM | `packages/teamlead/src/bridge/headphone-collector.ts:260` | A persistent ingestPage throw for one scope re-selects that scope every tick forever and starves every other scope |
| rejected-receipt-wedges-handoff-cursor | MEDIUM | `packages/voice-codex/src/live-lead-adapter.ts:207` | A rejected speak receipt is cached forever under the handoff-result pending key and the reply cursor never advances past it |
| post-cue-failure-silent-no-retry | MEDIUM | `packages/voice-codex/src/live-lead-adapter.ts:451` | After 我问下 Lead is spoken, every later delegation failure only writes evidence: nothing is said to the founder and there is no retry |
| replay-timeline-skew-breaks-delegation | MEDIUM | `packages/voice-codex/src/live-lead-adapter.ts:568` | Suspended-input replay after resume is time-anchored at resume, so a request spoken during announcer takeover may never bind to a RoomIO window and cannot become a handoff |
| engine-a-config-validated-late-and-sanitized | MEDIUM | `packages/voice-codex/src/cli.ts:349` | Missing Engine A configuration is only discovered inside createHeadphoneSession after the session is claimed and joined, and the daemon sanitizes it to an undiagnosable unknown_runtime_error |
| lead-restatement-guard-not-wired | MEDIUM | `packages/voice-core/src/backends/openai-live/LeadRestatementGuard.ts:1` | LeadRestatementGuard has no runtime caller and is not exported; the R1 restatement rule is enforced only structurally |
| consumer-throw-inside-socket-path-is-session-fatal | MEDIUM | `packages/voice-core/src/backends/openai-live/LiveUtteranceAssembler.ts:158` | A throwing listener inside the socket message path kills the whole Live session; appendInput throws on provider deltas that liveProtocol accepts |
| stream-engine-enoent-misreported | MEDIUM | `packages/voice-core/src/process.ts:97` | A missing ffmpeg or python3 binary is reported as subprocess-failed 'exited unknown: ' instead of component-missing |
| edge-tts-stream-cap-and-total-deadline-cut-long-readbacks | MEDIUM | `packages/voice-core/src/backends/edge-tts/EdgeTtsEngine.ts:166` | The 1 MiB buffered cap (python stdout never paused) and the 30 s total deadline cut long Lead readbacks mid-speech |
| headphone-close-awaits-work-before-cancelling-engine | MEDIUM | `packages/voice-core/src/headphone/HeadphoneMode.ts:116` | HeadphoneMode.close() awaits in-flight work before engine.close(), the only thing that cancels a stalled speak, so close can hang forever |
| audible-tail-overestimates-streamed-speech | MEDIUM | `packages/voice-bridge/src/room/RoomIO.ts:635` | endSpeech sets tailUntil from the total bytes ever written, ignoring what already played, and playSpeech adds duration before the mouth accepts |
| speaking-listeners-leak-per-session | MEDIUM | `packages/voice-bridge/src/room/RoomIO.ts:478` | start() subscribes speaking start/end on the borrowed receiver emitter without unsubscribe and wireIdleRoomEars builds a new EarsReceiver after every session |
| utterance-end-emitted-before-gated-tail-frames | MEDIUM | `packages/voice-bridge/src/room/RoomIO.ts:952` | emitUtterance('end') fires before the speech gate finalizes, so the last ~300 ms of each utterance reach consumers after endUserTurn/flushAudio; gated silence is fail-closed for /gemini and /eleven |
| receive-health-down-replaces-physical-ears-down | MEDIUM | `packages/voice-bridge/src/cli.ts:370` | During a session the physical ears connection down/up signal is disposed and replaced by ReceiveHealth, which only reports after a capture fails |
| teardown-awaits-leave-before-slot-release | MEDIUM | `packages/voice-bridge/src/assistant/AssistantSession.ts:606` | voice.leave() is awaited outside try/finally; a rejection skips slot release and lease close with done already true |
| speaker-flush-after-endturn-cannot-cancel-draining-tail | MEDIUM | `packages/voice-bridge/src/assistant/AssistantSpeaker.ts:152` | endTurn clears roomSpeechId while up to 5 s of frames are still queued, so a later flush() cannot cancel the tail |
| assistant-leadId-now-required | MEDIUM | `packages/voice-bridge/src/assistant/config.ts:97` | huddle.assistant.leadId became boot-fatal (was optional on origin/main) |
| test-evidence-and-host-coupled-failures | LOW | `packages/flywheel-comm/src/commands/__tests__/lead-operation-cli.test.ts:80` | Test evidence for this review; the only red suites are host-coupled and outside the diff |
| handoff-results-not-session-scoped | LOW | `packages/teamlead/src/bridge/voice-handoff-routes.ts:455` | GET results binds the handoff to project and founder but not to the requesting session's sessionId/generation (known R9 advisory) |
| routes-echo-raw-error-messages | LOW | `packages/teamlead/src/bridge/voice-handoff-routes.ts:320` | Unexpected store errors are returned verbatim to the client (also 440-445 and headphone-routes.ts:128,165-168,219) |
| envelope-nonsnowflake-messageid-breaks-vendored-parsers | LOW | `packages/flywheel-comm/src/chat-delivery-envelope.ts:131` | Handoff envelopes carry messageId voice-handoff:<uuid>, which origin/main's parser rejects as a non-snowflake |
| headphone-bootstrap-unbounded-growth-no-purge | LOW | `packages/teamlead/src/bridge/headphone-inbox.ts:508` | Full-history bootstrap is approved design (FLY-2796 plan 4.1) but there is no retention or purge and the snapshot query has no covering index |
| open-failure-leaks-live | LOW | `packages/voice-codex/src/live-lead-adapter.ts:189` | If open() fails after createConversation resolved, closing=true makes close() a no-op and this.live is never closed |
| results-page-fields-unvalidated | LOW | `packages/voice-headphone/src/bridge-client.ts:611` | results page fields (resultEventId/text/requestDigest/sourceLeadId) are not type-checked |
| raw-error-messages-in-evidence | LOW | `packages/voice-codex/src/cli.ts:361` | New per-session evidence records persist raw error.message (e.g. transcript file path) although the daemon-level failure record is causeCode-only |
| tts-timeout-zero-env | LOW | `packages/voice-core/src/config.ts:198` | FLYWHEEL_VOICE_TTS_TIMEOUT_MS=0 or negative is accepted |
| composite-rejected-receipt-pinned-under-pending-key | LOW | `packages/voice-core/src/backends/openai-live/CompositeSpeech.ts:92` | CompositeSpeech evicts only failed receipts; rejected (speech_busy, empty_text) stays pinned under a stable pending key |
| permanent-vs-transient-produce-failure-indistinguishable | LOW | `packages/teamlead/src/lead-backends/codex/CodexLeadOutboundHandler.ts:301` | Every producer throw, including permanent binding mismatches, maps to 503 and leaves the outbox row pending |
| headphone-background-env-forwarded-but-unread | LOW | `scripts/test-deploy.sh:1583` | FLYWHEEL_HEADPHONE_BACKGROUND_ENABLED is forwarded and tested but no code under packages/ reads it |
| waiting-cue-reschedules-at-0ms-when-clip-active | LOW | `packages/voice-bridge/src/eleven/wiring.ts:89` | remainingMs ?? 0 is null while a clip is active, so the waiting cue reschedules with setTimeout 0 in a hot loop |
