VERDICT: CHANGES_REQUESTED

## Round-5 findings disposition

- **H1'-a -> RESOLVED** — 当前 `plan.md` §1、§4 与 D2 均把三项职责拆开，并一致由 B+C 决定 `BargeGate` 去留；A 不再推出删层。
- **H1'-b -> RESOLVED** — A=否时平台 VAD 事件仍可作为触发器；当前 §4 没有再把本地层写成唯一判官，而是把停生成能力缺口指向 R6-2。
- **H3'-a -> RESOLVED** — `research.md` §2.1/§4.2 与 `plan.md` R5、§1、§4、D3 均继续把恢复语义限定在 inbox 念读条目；与 `Speaker.suspendInbox()` 的 `pendingKey.startsWith("inbox:")` 硬门一致。
- **round-3 新 HIGH（R6 全有或全无）-> RESOLVED** — R6-1 的 `threshold` 已独立成无前置台阶；没有重新绑定到 cancel 或 `interrupt_response` 可配。
- **round-4 新 HIGH 1（R1 观测与动作绑定）-> PARTIAL** — 已核当前索引 blob（`plan.md` `6b32cfe5…`，`research.md` `2c323607…`）：路线 1 change-surface 确已拆成无动作的 R1a 与按矩阵路由的 R1b，旧的直接接 `Downlink.interruptVoice()` 文字已消失；但 rev 6 用来撤回 R1a 探针前置的依据不成立，见新 finding 1。
- **round-4 新 HIGH 2（D2 旧轴 + P1(c) 不足）-> RESOLVED** — 当前 D2 已明确 B+C 决定去留和 R1b 路由，A 决定 cancel 的硬需求；也明确 founder 批的是 c-min 还是 c-full，且只有 c-full 能支持删层。
- **round-5 新 HIGH A（`prefix_padding_ms` 误作误触控制面）-> RESOLVED** — false-trigger 控制面只剩 `server_vad.threshold`；`prefix_padding_ms` 只保留在默认值说明和纠错说明中。官方合同也确认前者是激活阈值、后者只是检出后向前包含的音频。调高 threshold 的漏检/轻声灵敏度代价及双率重测要求均已写入 R6-1、§4 与 D4。
- **round-5 新 HIGH B（cancel 被错误绑成原子包）-> RESOLVED** — R6-2 现为无前置、可独立交付，且不移除 `interrupt_response:true` fallback；R6-3 才以 R6-2 为安全前置。Codex `49025589` 的 `RealtimeOutboundMessage` 仍无 `response.cancel`，安装版 0.152.1 的相关字符串仅为入站 `response.cancelled`；官方合同确认无在途 response 时 cancel 只返回 error、session 不受影响。

## New findings

### HIGH — 现成 `startDebugRealtimeTap()` 不能辨认 `speech_started`，所以“不依赖 R1a 就能跑 P1”仍是事实错误

`plan.md:27,53,125,204` 现在断言现成 tap 足以裸录并测出 A/B/C。但 Raya 当前 `RealtimeTap.ts:54-57` 虽订阅了 `AppServerClient.onNotification`，落盘只有 `{ ts, kind: message.method }`；其测试 `RealtimeTap.test.ts:28-51` 还明确要求“only realtime notification kind and timestamp”并禁止写入 params。也就是说，`input_audio_buffer.speech_started` 到盘后只剩共同的 method `thread/realtime/itemAdded`，`params.item.type` 已丢失。

这不是可忽略的字段：Codex app-server `bespoke_event_handling.rs:420-432,494-535` 会把 `input_audio_buffer.speech_started`、`response.cancelled`、普通 `ConversationItemAdded` 和 `handoff_request` 全部投成同一个 `thread/realtime/itemAdded`。因此现成 tap 无法可靠区分“speech_started 通知到了”与其他 itemAdded，也就不能独立测 B 的送达/时延或 C 的 VAD 触发率。应恢复“R1a（或等价地让 P1 探针记录非敏感的 `params.item.type`）是 B/C 测量前置”；R1a 仍可保持纯观测、无行为改变。

### HIGH — R6 对 B=否时 cancel 的“有价值/必需”给了两个不同答案

`plan.md:93` 的台阶表正确地区分：B=否时 R6-2 **有独立价值**，A=否时才是**必需**。但紧接着 `plan.md:96` 又写“R6-2 在 B=否 **或** A=否时升为必需”；这与 D2 `plan.md:134` 的“A 决定要不要 cancel 通道”冲突，也不能由 B 单独推出。B 只说明平台通知对本地 flush 不可靠/不够快；若 A=是，服务端可能早已自动取消，只是通知晚到或丢失。此时本地 cancel 是否成为硬需求，还取决于本地 gate 是否早于服务端取消，而不是 B=否本身。

这会让 founder 在 A=是、B=否格错误地把 R6-2 从可选加速能力升级为必做。保留台阶表的窄表述即可：A=否 ⇒ 必需；B=否（尤其本地 gate 实测更早）⇒ 可独立有价值。这样 §1、§4、D2 和 R6 才会给出同一个决策。
