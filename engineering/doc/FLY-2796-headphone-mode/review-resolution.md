# FLY-2796 耳机模式最小集 — 调研
Issue: FLY-2796 (https://linear.app/geoforge3d/issue/FLY-2796/语音v2-耳机模式最小集引擎无关一进来主动播报现在什么情况-哪些要你决定会话中有新消息主动念长时间无话报平安-从-9-月初)
日期: 2026-09-23
基于: plan.md

## R1 — CHANGES_REQUESTED

Question: 1f845599-b14a-4069-9ebc-86c34d181f78
Request: 3af3a235-2b23-423a-a758-242d847f898c
Effective verdict 与 reviewer verdict 均为 CHANGES_REQUESTED。以下均已核对源代码并写入 R2 plan，未自行宣称通过。

| findingKey | 级别 | 处置 |
|---|---|---|
| voice-session-reservation-triggers-provisioning-and-daemon-wake | HIGH | 接受。§3.2 定义 resident 原子 reserve-and-claim，additive carrier/owner/generation；provisioner/desired/claim/wake/admission/demand/card 消费者一起过滤；负测要求零 root/thread/wake 且正确 owner。 |
| roomio-pcm-only-drops-cue-and-tts-playback | HIGH | 接受。§3.1 增 playClip，复用 createResource 的 file/probeable stream 和 ffmpeg，经同 player、lease/generation/cancel，明确 cue/正文仲裁。 |
| chat-delivery-id-rejects-synthetic-message-id | MEDIUM | 接受。点名 chatDeliveryId、normalize 和 ingest context；通用 snowflake 不放宽，voice+typed handoff 专门分支及反例。 |
| inbox-delivery-key-cannot-express-per-session-attempts | MEDIUM | 澄清。session 纳入 delivery 主键，global spoken/activeClaim 放 item；每 session 两次，同 session 重启不重置。保持旧语义，不另设终身自动丢弃上限，公开跨场重试代价。 |
| speech-brief-has-no-producer | MEDIUM | 接受。由 Lead 原始报告明确三段标签/embeds 生产，公共规则和 collector 提取贯通；真实 message→入库→render/speak 用例，历史缺稿仍读全文。 |
| collector-has-no-discord-429-policy | MEDIUM | 接受。collector 并发/单 tick/token 页预算、通知优先、Retry-After/global/bucket 持久冷却；429 不等于 source_gap。 |
| handoff-results-route-auth-unspecified | LOW | 接受。结果读取/订阅 master-only + 服务端 project/founder/活 lease，内部结束后 reconciliation 不放宽外部读权限。 |
| waiting-mouth-listed-as-nonexistent-file | LOW | 接受。清单修成 audio.ts 中的 WaitingMouth 类。 |
| headphone-package-needs-new-bridge-dependency | LOW | 澄清。headphone room-io 仅依赖 core 注入类型，composition root 提供实例，不新增 headphone→bridge 边。 |

## R2 — CHANGES_REQUESTED

Question: e15c75df-122a-4a54-bc81-e68073a2fbef
Request: ec688e80-8878-4e14-b61b-cc639c3a94cd

| findingKey | 级别 | 处置 |
|---|---|---|
| resident-session-killed-by-admission-validator | HIGH | 接受。补 tick 顶部 validateSession/failVoiceSessionAdmission；resident 按 huddle 与实际 ears/output bot 绑定和自过滤回执验证，daemon 原检验不放松；多 runtime tick 真实收放正例及配置漂移负例。 |
| playclip-displaces-continuous-downlink-resource | HIGH | 接受。明确 suspend/re-arm 新 PassThrough、resourceEpoch、单 timer、clip 窗口背压与错误恢复；测试 PCM→clip→PCM 的实际 player 消费，不只看 Promise。 |
| speech-brief-rule-exceeds-lead-rule-byte-budget | MEDIUM | 接受。改按需 runbook + 现有动态 briefing/context 入口，常驻 bundle 不增字、不抬基线；补入口贯通证据。 |
| headphone-package-needs-new-bridge-dependency | LOW | 接受。显式增加 codex→headphone workspace 依赖（无环），bridge legacy 不 import headphone。 |

Lead 指令 cf7aeb81-f149-4ff2-80ce-044ca80dd9ae 同轮纳入 plan §7.1a：文件 owner 表覆盖 2798 旧分工；resultEventId 稳定，seq 每 handoff 单调，cursor=(handoffId,lastAppliedSeq)。

## R3 — APPROVED

Question: 2722e726-a1e3-4822-83e8-0c91752a04af
Request: 6d3956ba-c2a6-45d2-9590-9a433a693fd5
Effective reviewVerdict=APPROVED；reviewerVerdict=APPROVED。2026-09-23T19:31:47Z 持久结果。

本轮曾于 18:40Z 因 API ENOTFOUND/nonzero_exit 失败，无 verdict；19:29:50Z 通过同一 requestId/gate 的受支持重试恢复，并得到以上结论。没有新造身份或自行放行。

R1/R2 所有 HIGH 均已闭合。R3 新增两项非阻塞建议保留在 plan Follow-ups：resident-self-filter-proof-races-cold-member-cache（MEDIUM）、cue-skip-condition-ambiguous-vs-tail-drain-gate（LOW）。已批准的设计实现边界不变。

Lead 两项补充与 R2 修复在本轮一起审阅，没有另开独立轮次。HTML 产品表述仍适用；未开启第二批功能。
