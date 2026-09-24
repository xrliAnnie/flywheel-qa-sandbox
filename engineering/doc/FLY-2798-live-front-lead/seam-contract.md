# FLY-2798 前台快答与后台 Lead — 订阅接缝合同
Issue: FLY-2798 (https://linear.app/geoforge3d/issue/FLY-2798/语音v4-引擎-a前台快答-后台-lead-在现有通用管道上让实时模型自己答简单的复杂的交给)
日期: 2026-09-24
基于: plan.md

## FLY-2796 提供的最小注入缝
方法名：`subscribeReplies(binding, listener): () => void`。

`binding`：`{ sessionId: string; generation: number; leaseToken: string }`。

`listener` 事件：`{ sessionId: string; generation: number; handoffId: string }`；通知只唤醒，不携带正文、权限或完成证明。

生命周期：session admission 后订阅一次；返回的退订函数必须幂等；session close/lease fence 时先退订，再停止 RoomIO；断线重连不得改变 session/generation 绑定。

错误语义：订阅启动失败必须 reject admission；已启动后的断线调用现有 `record` 报 `voice_reply_subscription_failed`，不得静默回退到轮询；重连后对所有已注册 handoff 触发一次 wake。

持久权威：2798 收到 wake 后只调用既有 `listVoiceHandoffResults(binding, handoffId, after, 100)`；逐 event 成功播报后才前移该 handoff 的 seq cursor，失败保持原 cursor。

所有权：FLY-2796 落 daemon/bridge-client 注入与生产 transport；FLY-2798 的 `LiveReplyEvents` 只消费上述抽象源，不修改 shared owner 文件。
