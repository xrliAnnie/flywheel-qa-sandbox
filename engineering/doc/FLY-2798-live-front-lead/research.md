# FLY-2798 前台快答与后台 Lead — 调研
Issue: FLY-2798 (https://linear.app/geoforge3d/issue/FLY-2798/语音v4-引擎-a前台快答-后台-lead-在现有通用管道上让实时模型自己答简单的复杂的交给)
日期: 2026-09-23
基于: exploration.md

## 结论
新增 openai-live adapter；继承通用房间与状态权威；快答流式直出，复杂请求消费 FLY-2796 持久 carrier，Lead 回执通过事件推送。逐字播报采用显式 composite（组合：实时对话与确定性朗读两个组件共用房间）；Live 自身不宣称逐字。打断以连接 generation（每次连接独立的代号）彻底隔离旧效果。
研究按注入任务授权继续进入计划；不新增 brainstorm/founder 批准节点，最终必须有效 design review APPROVED。

## 证据表：当前仓库 03bb98d4f
| 文件/锚点 | 事实 | 实施含义 |
|---|---|---|
| voice-core/src/factory.ts:102；backends/registry.ts | registry 只有 edge-tts/gemini-live | 新 GptLiveBackend，稳定 id openai-live |
| voice-codex/src/cli.ts:258；session.ts 构造器 | 直接创建 GenericVoiceSession → RealtimeFrontend | daemon/CLI 必须实际选择新 adapter；只注册不能上线 |
| voice-codex/src/realtime-transport.ts:3 | 旧 /realtime 入口 | 不复用旧握手；新 /live/sessions 与 session.start |
| voice-core/src/types.ts:186-282 | ConversationSession 无 V1 speak、转写身份、归属及 durable receipt | 扩已有抽象，兼容 Gemini/Edge 与测试替身；缺失能力默认 false |
| voice-core/src/transcript.ts:49-71 | append 失败被记账后吞掉，flush 不 reject | V2 transcript durability 接口必须有精确回读；不可拿旧 flush 当成功 |
| voice-codex/src/delivery.ts:73-94,173 | scrub+trim+slice(0,1800) 后才 journal 与邮箱 | 完整 canonical 原话先存；Discord 仅有限长展示投影 |
| voice-codex/src/realtime.ts:1029；session.ts:439；audio.ts:140 | 完整 PCM 拼好再交播放器 | A 增量帧经 RoomIO；不能保留整段等待 |
| voice-codex/src/audio.ts:216-228 | 最后 write 后 resolve，甚至未等 drain | receipt 最远 submitted，不是听见或 playback_drained |
| voice-codex/src/discord-room.ts:272-280 | playSpeech/cancelSpeech 转发到 WaitingMouth | RoomIO v1 由 2796 扩，A 不复制房间层 |
| voice-core/src/backends/edge-tts/EdgeTtsEngine.ts | synthesize 等 CLI 文件结束才读 MP3 | 确定性 announcer 不可直接当流式现成组件；需增量输出适配并复用其参数/错误规则 |
| voice-bridge/src/huddle/{wireMeeting,FeedPipeline,HuddleSession}.ts | Gemini 专属组装、silent feed、interrupt+flush | V3 改模式组装；本单提供合规接口与联调 fixture |

## 输入与门铃：已证和未证
路径：delivery.capture → Discord mirror → adapters.ingest → chat-ingest → mailbox queue → nudge → LeadInboxLoop → backend.deliverBatch → 持久 transport receipt。
- flywheel-comm/src/index.ts:973 已在提交后按门铃；lead-inbox-nudge.ts:41 缺 BRIDGE_URL 会跳过，HTTP 失败退回轮询。
- teamlead/src/bridge/plugin.ts:3601 已有 nudge endpoint；lead-inbox-loop.ts:188,741 会合并忙时 nudge，并在当前 tick 后再跑。
- mailbox-queue.ts:1571 的 30s batch window 是组批上界，不是先睡 30s。
- FLY-2786 的 12.7s 是历史观察；本次未读生产 DB、未复现实验，根因未定位。要逐 deliveryId 记录 commit/nudge accepted/tick/admission/transport receipt/model consume。修复由失败回归驱动，不先重写邮箱。
- 现有 chatDeliveryId 绑定 Discord message ID；新 canonical handoff 不得伪造消息 ID 绕过队列，必须由 V2 carrier 提供稳定映射。

## 输出与推送
- teamlead/src/bridge/voice-session-services.ts:76,273 → voice-session-poller.ts 通过 Discord REST 每 3s 取回复。
- voice-codex/src/daemon.ts:630-640,861 → list/claim/speak/receipt 后 sleep leaseRenewMs（config.ts:136 默认 4s）。续租必须独立保留。
- StateStore.ts:5722-5862 提供持久 outbound、seq、lease、attempt token、终局 receipt；通知不能替代这些权威。
- voice-session-routes.ts:44,420 校验主凭据和 X-Voice-Lease。新的 SSE（服务器持续推送事件的连接）沿用这一鉴权，不复用无鉴权 dashboard /sse。
- CodexLeadOutboundHandler.ts:316-343,416-430 在发送后 markSent；/api/lead-outbound/send 与 broker sender 两入口都经 buildLeadDiscordSend（plugin.ts:3637、capability-outbound.ts:28）。只改其中一个会漏。
- leadDiscordSend.ts:40-57 只返回 Discord 多分片的第一个 ID，不能用每片再独立生成一次语音。
- 新 producer 必须在 canonical Lead result 持久 commit 时出事件，mirror 独立；由 V2 carrier 留下 result/outbox，2798 消费。Claude 正常回复仍需走同一授权 result adapter；不得以扫描任意 bot 频道取代来源证明。

## Live 协议核实（2026-09-23 官方文档 + 仓内单场探针）
[官方 WebSocket 文档](https://developers.openai.com/api/docs/guides/voice-websockets)核实：新连接 session.start/started；持续按采样率发音频，包括静音；输出 delta 可立刻播放；配置 PCM16 mono 24k。音频没有输出结束事件。旧 response.create 不用于启动前台。
[官方 delegation 文档](https://developers.openai.com/api/docs/guides/live-delegation)核实：client 模式由应用保存上下文、执行后台与检查权限；delegation 只触发工作；commentary 用于回送可说出的内容，不是业务提交。
[官方 session 文档](https://developers.openai.com/api/docs/guides/live-conversations)核实：转写 delta 只有近似时间区间，无 item ID/turn-final；保留空格和重复词。thinking.append 用于背景事实，commentary 可改写；运行中 append 的 ACK 是上下文时间进度，非听到/完成。
[官方 server-controls 文档](https://developers.openai.com/api/docs/guides/voice-server-controls)核实：输入 mute 不停止输出；应用自己管播放门和旧结果；指令 ACK 不能用作恢复播放的安全边界。
仓内 `git show 15fe2c875:engineering/doc/FLY-2799-codex-voice-container/gpt-live-handoff.md` 与 duplex-live.jsonl：仅单场协议回环，本地函数回 blue；未跑真实 Lead、房间、逐字校验或可听 ≤2s。文档与实测一致：delegation 有 offset_ms 与 id/type/target，没有完整原话。

## 已获 Lead 裁定
- f2fec268-75dc-4661-8257-918cf72d10a2：RoomIO v1 与 carrier 属 FLY-2796；只读/动作按 intentKind，共用持久身份；完整依赖清单待 V2 定稿同步。
- 817101aa-c418-4fe2-ba6a-f1fd98169418：接受关闭旧连接 + generation fence；须测本地停止与新连接恢复各 10 次、插话缓冲不静默丢、全部旧效果不泄漏。
- 同答复接受显式 Live+announcer composite：双面启动校验，失败报语音不可用；说明声音差异；verbatim 仅 announcer 且逐次 proof。

## 未验证与计划必须解决的事
输入 final 是应用对房间 utterance 的封口，不是虚构 Live final；不能按最近一句认领 delegation。延迟片段、两人重叠、缺 speaker、断线缺片都要保留 unknown，动作拒绝。精确匹配不足时请求澄清。
Live 的 injectContext 要实际验证不触发语音；未通过则明确 unsupported 并关闭依赖它的模式功能，不能把 commentary 当 silent feed。V2/V3 原验收仍未满足，不能因此宣称本单已经可联调。
相关测试才本地跑；没有运行付费探针、生产服务或全量测试。设计交付不是生产证明。

补充：确定性朗读的增量接口可参考 [edge-tts 项目官方流式示例](https://github.com/rany2/edge-tts/blob/master/examples/async_audio_streaming_with_predefined_voice_and_subtitles.py)：Communicate.stream 输出音频与边界元数据。仓内现有 CLI 仍是文件型；这只是可实现性的源码依据，不代表本机版本已验证。实现必须钉版本并测试中途失败、背压和取消。
