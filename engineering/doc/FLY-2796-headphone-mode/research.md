# FLY-2796 耳机模式最小集 — 调研
Issue: FLY-2796 (https://linear.app/geoforge3d/issue/FLY-2796/语音v2-耳机模式最小集引擎无关一进来主动播报现在什么情况-哪些要你决定会话中有新消息主动念长时间无话报平安-从-9-月初)
日期: 2026-09-23
基于: exploration.md

## 1. 证据与结论

本仓基线 `03bb98d4f`；Raya 只读源码来自 `/Users/xiaorongli/.flywheel/raya/code` 的 `f669d1beac0cf052747a50a9b255516948936384`。这不是对九月初部署版本的断言。研究未开语音会话、未改生产；以下均为源码事实或明确的设计选择。

PRD FLY-1850 §5.1 要进来主动播报，§5.2 区分全部输入与可听表达，§5.4 要静默存活信号，§6.2 默认待使用后调整。本单最新正文明确第一批不筛；不能照搬历史筛选或非决策文字旁路。

## 2. 房间与真实消费者

| 源码 | 已有能力 / 缺口 |
|---|---|
| `packages/voice-codex/src/discord-room.ts:57` | 归属、founder presence、收听健康、租约断言；`:191` bot 身份；`:272` 写死整段 24k mono |
| `packages/voice-codex/src/realtime.ts:57` | RealtimeAudioOwner 是房间归属数据，错误地放在引擎文件内 |
| `packages/voice-codex/src/audio.ts:138` | WaitingMouth 能排队，但 `:216` 最后一次 write 即 resolve，不等 drain；取消未清已写入流 |
| `packages/voice-codex/src/bridge-client.ts:93` | VoiceLease 有单调时钟到期和永久 fence；必须保留 |
| `packages/voice-codex/src/cli.ts:282` / `session.ts:27` | 构造 room / RoomLike + FrontendLike，改动必须同步到这两个消费者 |
| `packages/voice-bridge/src/SessionSlot.ts:40` | 仅进程内互斥，不能证明跨 daemon 独占 |
| `packages/voice-bridge/src/VoiceRoomRuntime.ts:35` | 单消费者路由、旧 unsubscribe 不清新订阅；保留到适配器 |
| `packages/voice-bridge/src/roomEars.ts:53` | EarsReceiver 原有 userId 被丢弃；16k mono 与 codex 24k mono 不同 |
| `packages/voice-bridge/src/assistant/AssistantSpeaker.ts:54` | beginTurn/feed/endTurn 流式播放；不能用只接受完整 buffer 的接口替代 |
| `packages/voice-bridge/src/assistant/wiring.ts:244` | 私有 fallback ears/runtime 与独立 output；必须都接统一实例 |
| `packages/voice-bridge/src/eleven/wiring.ts:331` | 共用 ears/slot、独立 speaker；仅改类型名不算收敛 |
| `packages/voice-bridge/src/cli.ts:302,323,671` | room/slot、glaw receiver 与 resident ears 装配；不能多挂 receiver |
| `packages/teamlead/src/StateStore.ts:10159,10226` | voice_sessions 及 active-room 唯一约束；继续作为跨进程实际会话权威 |

**选择**：唯一实现从 codex 移到已有 `voice-bridge/src/room/`，在 bridge 内导入底层依赖，codex 保留转导出。这样现有 codex → bridge → core 方向不变。`RoomIO` 类型放 core；实现与版本从 bridge 导出。提取音频/VAD/归属依赖闭包，不能留下 bridge → codex import。ONNX 使用仓内已装同版依赖与同一校验模型，属于迁移，不再选一个库。

## 3. 收件链路不是现成的持久积压

| 源码 | 观察 |
|---|---|
| `voice-headphone/src/daemon-core.ts:130-149` | mode off 仍推进 cursor，但不 ingest |
| `voice-headphone/src/daemon.ts:209-267` | off 不恢复 cursor、不 backfill；单页最多一百条 |
| `voice-core/src/headphone/turn-machine.ts:1-38` | 旧完整交互含长文裁剪、逐项问要回吗、审批、打断；不是本单最小集可直接开全的入口 |
| `teamlead/src/bridge/voice-session-poller.ts:1-124` | 已有 Discord REST 分页示例；只服务 active session 单 Lead、既定频道；不能直接覆盖离线所有 Lead |
| `teamlead/src/StateStore.ts:5722-5870` | voice_outbound 绑定 session/lease，结束 dropped/ambiguous；不能拿它保存跨会话积压 |
| `teamlead/src/bridge/voice-routes.ts:229-265` | scope 从各项目 Lead chat、general、issue threads 推导；当前扁平合并，必须保留项目归属再授权 |
| `teamlead/src/lead-backends/codex/CodexLeadOutboundHandler.ts:178-337` | Codex 持久发送不是所有生产者；Claude 与 GatePoller 不能漏 |

**选择**：Bridge 常驻 collector 从授权 founder-facing 频道读原始 Discord 页，不依赖语音 mode 或进程存活。以服务端配置的项目/Lead/频道归属纳入消息；所有 Lead 问题与汇报都收，不做偏好筛选。补 CommDB 当前待 founder 问题投影，确保未成功发卡的问题也可见；两来源以 questionId/Discord message binding 去重。collector 自己的持久 cursor 与逐项播报 ack 分开。

不能复用 Lead inbound gateway 的过滤结果（会拒绝自身 bot 消息）；不能把 outbound dedup 表当正文来源（普通消息只存 key/status/message_id）。Discord 历史删除/无权限不是“没有积压”，必须显示缺口。首启不偷偷基线到最新消息。

## 4. Raya 找回与显式改造

| `apps/voice/src/…@f669d1b` | 复用 | 不照搬 |
|---|---|---|
| `inbox/InboxReader.ts:87-88,237-272` | needsDecision 优先、单 poll promise、每 item/session 两次、六十秒退避、确认后 ack |
| 同文件 `:1-8,173-230` | — | Raya 文件协议、filter、ship 分支、非决策只发文字、坏文案 text_fallback 当终结 |
| `inbox/SpeechBrief.ts:27-53` | what/why/next 三段：非空、各 ≤200 code points、无 Unicode 数字、句末标点；render 与剩余条数 |
| `session/ExitProtocol.ts:12-24` | composeStartInstructions 幂等；8192 UTF-16 code units 上限，超限抛错而非截断 |
| `runtime.ts:1082-1100` | 同 session generation 的 founder user 转写必须先出现；assistant 自说退出无权触发 |
| `actions/OutboxWatcher.ts:444-490` | founder 原话与引文/标识匹配规则 | filter/ship 执行器、内存 transcript store |

坏/缺 speechBrief 不应变相过滤整条：验证并记原因；退回来源原文的分段朗读，不编造三段理由、不删数字、不断章截短。源消息完整保留，只有完整文本或合格三段稿完成所需逐字校验才能 ack；失败仍 pending 并显式提示文字位置。

## 5. 转写与 handoff

`voice-core/src/types.ts:265-282` 的 append 返回 void；`transcript.ts:49-71` 吞写错并让 flush resolve。给共享 sink 增加可等待的 appendDurable / read-back 合同；旧调用仍可追加，但副作用必须等 sessionId + transcriptId + contentDigest 全等回读，不能由客户端自报成功。

`voice-codex/src/adapters.ts:103-194` 已有 comm chat-ingest 与 message-status；`flywheel-comm/src/discord-chat-ingest.ts:166-200` 使用 `chatDeliveryId(leadId,messageId)` 稳定身份与 immutable first delivery。采用该通用载体，发起前先存精确 deliveryId 和 digest；回执丢失后可只读查询同 id。

保留 V1 authorized → dispatching → dispatched → committed/rejected；不确定进入 ambiguous，再查询，最终可 needs_human。**本单 committed 只证明 Lead 信箱 envelope 持久提交**，不等于 Lead 已消费或业务完成。不会把 ship HTTP endpoint 改成通用执行接口。

## 6. 验证边界

复用现有 `discord-room` / `audio` / `lease`、bridge `voice-room-runtime` / `assistant-wiring` / `eleven-wiring` 测试，增加实例身份、格式拒绝、晚帧 fencing、跨进程抢房和恢复证据。假引擎完整实现 V1；三条产品测试与失败路径见 plan。`/gemini`、`/eleven` 真房兼容验收由本单后续 QA 负责；A/B 真机和四场可比性由 V6 负责。此时全部真机状态为未验证。
