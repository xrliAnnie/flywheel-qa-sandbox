# FLY-2298 founder_review 等待判据 — 探索
Issue: FLY-2298 (https://linear.app/geoforge3d/issue/FLY-2298/病根-dwell-的是否等-founder判据不认-founder-review-卡-question-checkpoint)
日期: 2026-09-06
基于: 无

## 问题

`STEP DWELL` 当前只把两种形状当作「正在等 founder」：`founder_gate/review` 节点，或当前 run 绑定的未答 `approve_to_ship` question。一个普通工作节点（现场为 `pm`）打开了 `founder_review` 卡并停下来等 founder 时，两条都不命中，于是每过一个阈值窗都被路由为 `deep_dive`。

这不会误催 founder，但会永久重复读取终端和工作日志，并且绕过已有的「同一 waiting episode 只提醒一次」抑制路径。重复 deep dive 同时也是节点 liveness 的兜底；把第三种形状接入抑制路径会继承 `approve_to_ship` 已有的取舍：提醒成功后，本 episode 不再由 STEP DWELL 周期性复查节点存活，必须依靠既有 runner/engine liveness 机制。问题不在阈值，而在 founder-wait 值域缺少第三种合法决定形状。

## 锁定边界

- 新增第三个 founder-wait 判据：当前节点名下存在仍可回答的 `founder_review` 卡。
- 「仍可回答」必须沿用 question domain 的 durable 状态：question 未 supersede、未 terminal dispose，且没有 response 子消息；founder-facing 卡是否真实存在，以 StateStore immutable `founder_review_card_binding` 为准，不以 best-effort `relay_state` 猜测。
- binding 的 `run_id` 与 question sender 必须分别绑定当前 `run_id` 与当前节点 `execution_id`；不能把 `pm` 节点整体豁免，也不能仅按 issue 关联。
- 进入既有 `founder_reminder` 路径后，继续复用 grouped reminder 与 `waiting_founder` receipt；不加 daemon、timer 或对账器。
- 新的 `founder_review` round 是新的 waiting episode；只有新卡或 founder thread/gate 动作能重新武装，纯时间流逝不能。
- question domain 或 card binding 映射不可读时 fail closed 为 DWELL unavailable，不能猜测为 deep dive 或 founder wait。

## 验收形状

1. 超阈的普通节点若持有当前 run 已绑定卡片的未答 `founder_review`，输出 `route=founder_reminder`，不输出 `route=deep_dive`。
2. 同一 episode 写入 `waiting_founder` receipt 后，即使再跨越多个阈值窗也不再产生 reminder action。
3. 同一 run/节点打开更新的 `founder_review` round 后，以新卡时间重置阈值；再次超阈时只允许一条新提醒。
4. 无 card binding、已答、已 supersede/注销、属于其他 run 或其他 execution 的卡均不能触发 founder-wait。
5. 现有 `founder_gate/review` 与 `approve_to_ship` 两个判据保持原样。
