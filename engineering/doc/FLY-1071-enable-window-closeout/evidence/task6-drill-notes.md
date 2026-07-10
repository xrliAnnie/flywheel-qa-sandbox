# FLY-1071 演练结论(runbook 步6 ①)— 2026-07-09 17:45

root 帖:msg 1524938174600712342(#flywheel-alerts),eventId fly1071-drill-96875-951740881737291
脚本:task6-drill-fire.mjs(preflight 三门全过后发射;运行 log = task6-drill-run.txt)

## 五点验证

| # | 判据 | 结果 | 证据 |
|---|---|---|---|
| ① | 🎫 schema 头完整 | ✅ | 「⚠️ [FLY-1071 演练 可删]…(codex-infra-bot-lead / login_expired)\n🎫 flywheel · 首见 17:39 · owner <@claw> · 状态 NEW」(task6-drill-post.json) |
| ② | root 帖作者 = dispatcher(sender≠owner 不变量) | ✅ | author = flywheel-alerts-dispatcher 1524831623164596265 |
| ③ | @-target 唯一 = claw(无 @Codex 无 @Annie) | ✅ | mentions=[claw-infra-bot],mention_everyone=false,mention_roles=[] |
| ④ | claw 唤醒 → claim → 频道 ACK | ⚠️ 唤醒+claim 行为 ✅;频道 ACK 被真实缺陷挡住(见下) | task6-drill-pane.txt |
| ⑤ | 全程无 founder 升级 | ✅ | claw 明确「没有 @Annie」;频道无升级帖 |

## ④ 挖出的真实缺陷(演练价值所在;claw 原话确认「都是真实报错,不是演练脚本内容」)

1. **Discord reply 被 routing guard 拒(guard_unavailable)**:claw 想在频道回 ACK,被 Bridge
   路由 guard 以「guard 当前不可用」拦下(提示应走 POST /api/chat-threads/send)。fail-closed
   行为本身正确,但 guard 不可用会挡住真实告警时 owner 该发的救援证据帖/ACK。
2. **Alerts 工单帖未进 claw 的 flywheel-inbox**:flywheel_inbox_ack 对该帖(以及此前的
   FLY-1018 帖)都报 unknown message_id —— 工单唤醒走的是 Discord 入站,而 inbox-ack 语义
   没有对应条目。owner claim/ACK 的 inbox 路径与 Alerts 工单投递之间存在缺口。

claw 的处置纪律满分:不硬绕 guard、不在 Alerts 刷屏、不 @Annie,把发现经 SendMessage 报给
bridge 判断。对照:探针① 的 ✅ reaction 应答成功 —— reaction 路径不过 reply guard,文字回帖路径过。

## 硬证据边界(plan 6.3,逐条)

**覆盖**:root 帖 POST、🎫 工单头、owner-only allowed_mentions、dispatcher sender、
claw 唤醒 + claim 尝试、共享 claims.db(drill 复用生产 claims reader/claimer)。

**不覆盖(推迟到观察日真实工单取证,不做结论性断言)**:AlertChannelHub 的 thread 生命周期、
root 状态 edit(drill 进程持有 ticket 状态,生产 Bridge 不接手其后续 edit —— root 帖停在 NEW
属预期)、T2 升级、rate-limiter 攒批/溢出汇总、生产 Bridge 进程内秩序。

## 清理选择(plan 6.4)

**保留 24h、由观察日清理**(全部帖子已标「可删」)。理由:探针/演练帖现在是 ④ 两个真实缺陷的
现场证据,观察日/QA 需要它们做取证;删除反而毁证。
