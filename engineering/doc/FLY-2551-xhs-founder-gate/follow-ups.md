# FLY-2551 小红书逐次批准门 — 评审后续事项
Issue: FLY-2551 (https://linear.app/geoforge3d/issue/FLY-2551/2441follow-up-小红书-publishcommentlikefavorite-的机器可验-founder-门今天)
日期: 2026-09-14
基于: review-history.md

R2有效裁定为APPROVED；以下8项均为非阻断建议，不是新增通过条件。保留完整findingKey供Lead决定后续排期；本节点没有实施这些建议，也不派工。完整原文在review-r2.json。

| findingKey | 级别 | 待跟进内容 |
| --- | --- | --- |
| media-ingest-crosses-new-uid-boundary | MEDIUM | 对齐§4/T3与§2.2的跨UID流式导入表述，明确发送方、authority自身store的hash/inode校验及绝不open登录UID提供路径的测试。 |
| video-preview-exceeds-discord-limits | LOW | 将≤10MiB且受实测Discord限制的媒体天花板同步至§11，清理T3旧256MiB表述，统一分批上传限制。 |
| runtime-socket-dir-lifecycle | LOW | 明确重启后root侧重建/var/run目录的责任和ingress目录mode。 |
| notification-cursor-scope | LOW | 明确同UID通知投影可见范围，评估按lead归属过滤；过滤不构成同UID安全边界。 |
| rate-limit-shared-peeruid | LOW | 在全项目共享上限之内评估每lead子额度，规定retry-after语义。 |
| policy-version-consume-semantics | LOW | 明确prepare/批准/消费之间root policy版本变化的作废规则及拒绝码。 |
| challenge-case-folding | LOW | 明确短码是否折叠ASCII大小写，并补相应解析用例。 |
| founder-html-diagram-placeholders | LOW | 本机Chromium权限使两张Mermaid图各两次渲染失败；按注入任务允许的降级交付明确占位与源文件，向Lead显式报告未含渲染图，后续在可用本地环境补图。 |

最后一项按当前任务的明确规则交付：标准参数重试仍失败时保留`DIAGRAM PENDING LOCAL RENDER`，不使用远程服务，不声称已通过视觉验收。它不改变有效APPROVED裁定；发布报告与阶段完成不能被解释为生产写门已上线。

## Activation prerequisite — separately designed host-proof protocol

Lead ruling 80bac618-24f8-4101-a7fd-5685c7dff162 selects A: this issue's
fixture_harness receipt can never authorize production enabled:true.
loadAuthorityConfig rejects that request with host_activation_receipt_absent;
enabled:false remains supported. The missing machine-verifiable host-activation
proof protocol requires a follow-up issue with its own design and authorization.
This implementation does not invent its schema or accept a root enabled flag,
uploaded probe results, or fixture signature as equivalent evidence.

Lead ruling 4af8d085-6e30-4620-935e-7fbcfeefeb18 permits the initial root
installer signature only for directly collected file controls, model file
denials and eight synthetic production-module authority scenarios. It must
explicitly say hostAcceptance:false and identify untested actual model contexts,
process authority, privilege paths, private transport, headless service and
legacy cutover. These remain separate activation requirements.

## Lead e73b0fbc — one separate host activation design issue

Ruling e73b0fbc-65f7-42ac-97c9-6a3e61c08049 assigns the unimplemented real-host
probes and host-activation proof protocol to one separate follow-up design issue.
Its issue number has not been supplied; Lead owns intake and scheduling. The
exact signed exclusion strings are:

- `real_claude_context`
- `real_codex_context`
- `real_runner_context`
- `real_login_context`
- `process_authority`
- `privilege_paths`
- `private_transport`
- `headless_service`
- `legacy_cutover`

This phase delivers the direct-collector fixture-only signer and a validated
OFFLINE artifact/config builder accepting public configuration only. It must
refuse production finalization without externally supplied trusted QA public key
and target host identities. No model-generated production key is permitted.
The three implemented fixture probe modes remain file-authority, file-control
and authority-flow; no future host probe mode is exposed as a partial stub.
After the builder is complete, the remaining phase gates are review, CI and both
PRs. No host activation protocol or host probe implementation is added here.
