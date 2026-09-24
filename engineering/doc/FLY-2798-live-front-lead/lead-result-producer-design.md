# FLY-2798 前台快答与后台 Lead — Lead Result Producer 设计说明
Issue: FLY-2798 (https://linear.app/geoforge3d/issue/FLY-2798/语音v4-引擎-a前台快答-后台-lead-在现有通用管道上让实时模型自己答简单的复杂的交给)
日期: 2026-09-24
基于: plan.md

## 载体中立绑定
- 统一语义：Lead outbound 必须引用它所回答的唯一 mailbox delivery；正文永不参与匹配。
- Codex：现有 `deliveryContext` 字段随鉴权 outbound 请求传递；Lead 可信侧用 journal membership 将 entry id 解析为唯一 voice member，去掉 transport `#rN` 后得到 canonical delivery id。entry id 只作本地执行权威，不能直接冒充 delivery id。
- Claude：现有 reply 工具用 `reply_to=voice-handoff:<handoffId>`；producer 以 target Lead 和 synthetic message id 计算同一 `providerOperationId=chatDeliveryId(...)`。
- 多 member batch、零 voice member、多个 voice member或字段冲突均拒绝 producer；普通 Discord outbound 保持原状。

## Producer 验证与写入顺序
1. 仅在 outbound 已由现有鉴权与 Lead/channel scope 校验后运行；voice result 不等待 Discord mirror，因为 plan 要求 mirror 脱离关键路径。
2. 用 canonical delivery id 只读 CommDB，解析精确 voice envelope；逐字核对 targetLeadId、handoffId、requestDigest、sessionGeneration 与 `VoiceHandoffStore` 记录。
3. 以后端鉴权 outbound 的持久 idempotencyKey/operation id（而非 Discord message id）作后缀，构造确定性 response child id；父 id 固定为 providerOperationId，写入 from=targetLeadId、to=founderUserId、正文为 Lead outbound 原文。
4. 调用现有 typed `appendResult`，resultEventId 使用同一 operation id 后缀，sourceDeliveryId 为该 response child id，resultKind=`lead_reply`；之后 Discord mirror 可独立成功、失败或重试。
5. response child 与 result event 均按相同 id 重放；同 id 异正文/绑定 fail closed。result durable commit 后才通知订阅者。

## 边界
- 不改 `voice-handoff-store.ts` / `voice-handoff-routes.ts`，不按频道、时间或文本猜 handoff。
- Discord mirror 与 voice result 共用一次已确认 outbound 正文，但任一 voice projection 失败不伪造成功。
- Codex 与 Claude 走同一个 producer 输入合同；载体只负责把回答引用归一为 canonical delivery id。
