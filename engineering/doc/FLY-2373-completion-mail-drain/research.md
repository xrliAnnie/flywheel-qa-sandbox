# FLY-2373 完工消息排空 — 调研
Issue: FLY-2373 (https://linear.app/geoforge3d/issue/FLY-2373/病根-完工-drain-与中途延后门铃互锁codex-体在一个-turn-里轮询等-lead-答案-deferred-midturn)
日期: 2026-09-25
基于: exploration.md

## 方法与事实等级
只读当前 checkout 的 CommDB、Bridge、StateStore、CLI、Codex lifecycle；不引用外部产品/API 假设，不连接生产数据库，不启动或拆 529 房。所有下列源码事实针对基线 801ac86cb。没有执行修复后端到端验收。

## 排空消费链
| 消费者 | 当前事实 | 设计影响 |
|---|---|---|
| packages/teamlead/src/bridge/event-route.ts:1774–1875 | 先按 businessDigest 找 issued challenge；即使无 receipt 且内容后来已读，仍原样409；验证 wake 只接受 started/finished | 每次提交重算语义义务；已有 challenge 不能粘住 |
| packages/teamlead/src/StateStore.ts:consumeDrainChallengeTx | 第二处重复 started/finished 判断；commitEnrolledCompletion 同事务消费 challenge | 两处必须同步更改；服务端构造证明，不能信客户端字典 |
| packages/flywheel-comm/src/db.ts:getCompletionDrainPending | pending wake + queued/deferred_midturn 入集合；mailbox 只看 QUEUED/LEASED | 不能丢旧 ACKED 但正文没被读的 legacy wake |
| db.ts:getCompletionDrainVerification | 仅返回 state，既不解析正文也不看绑定 | 新语义核验不能伪造 started/finished |
| db.ts:enqueueRunnerPhaseWake | source_instruction_id 存在时提前 ACK mailbox；无 source 默认 park_wake | transport ACK 与模型消费分开；park 标签不是正文分类 |
| db.ts:commitRunnerDoorbellWake | metadata.memberIds 是 delivery_id；pending doorbell 可以合并成员；started 保留原正文 | 冻结成员/digest；不能按 message id 联结 delivery id；新成员必须让旧证明失效 |
| db.ts:consumeGateResponse / commands/check.ts | 正确归属的 check 才消费；getResponse 是纯查询 | 只在真正消费路径记凭据；后台检查不算 |
| commands/inbox.ts / UNREAD_INSTRUCTIONS_SQL | 现有 inbox 拉取即 ACK；ACKED legacy 正文不会再拉出 | 增加精确 drain 读取通路，保留常规 inbox 兼容 |
| commands/complete.ts:540–675 | 响应先截 1000 字符再 JSON.parse；409给旧 receipt重试；落FAIL-CLOSE marker | 先界限校验和完整解析，再显示；预期未读是可恢复状态，不让 reconciler误判完成 |
| packages/claude-runner/src/codex-daemon-client.ts:enterPhaseHold / observeBoundary | 普通 turn结束≠park；显式park边界进入hold | 源合同必须教会 yield/park，机制不能靠提示词兜底 |

## 门铃分类原则
所有 receiver 入站都经 runnerWakeAdmission；exact holder_exec_id 且 active_turn_id 非空才 deferred_midturn。按来源附录核对 producer，不以 purpose 文本决定授权。
batch门铃用memberIds解析每个正文；source_instruction_id路径查原 instruction；inline wake有正文时保留原文和digest；确证无正文的控制信号用服务端生成的类型+精确activation关联证明。
重复门铃绑定同一义务可以共用消费证明；不同activation、rework request、正文digest不得互相代替。
legacy缺证不批量改库：保留原数据，可当前turn重新读取并产生新凭据。

## 相关既有合同
FLY-2268 的 generation、challenge、writer fencing继续有效。FLY-2517 的 replacement/rework retirement只在原精确证明成立时有效。FLY-1774 batch成员仍是canonical mailbox身份。
FLY-2662 land reclose只处理有merge/op身份的收尾；不能拿来关闭未合入的活Runner。
codex-phase-shutdown.ts 的 stale_live_pane 和 heartbeat_stopped_live_pane 两个拒绝都明确是活pane反证；不得把超时改成直接kill许可。

## 验证状态
现阶段为源码审计。设计新增用例、真实长turn复现、Claude回归均交下游执行，不能拿本文当PASS。

## 来源全集（当前生产调用闭包）
| 来源 | 写入/路由 | 是否可能 deferred_midturn |
|---|---|---|
| Lead send | commands/send.ts:sendDetailed → insertInstructionAndClearDeclaredState → runner-mailbox-lane | 是，batch或legacy instruction |
| Lead respond | commands/respond.ts:respond → insertGuardedResponse → runner-mailbox-lane | 是，batch或raw response |
| design/code verdict | review-request-coordinator.ts:respond → insertReviewResponseIfGateOpen → mailbox response | 是；不是独立purpose |
| approval/feedback | runner-wake.ts:sendRunnerWake；actions / founder-consent / gate-poller调用 | 是，receipt wake或raw正文 |
| founder notice/nudge | gate-poller.ts:founderActionDrainPass → wakeRunnerMailbox | 是 |
| TURN恢复 | plugin.ts:deliverDurableTurnWake，turn_recovery | 是，带持久outbox来源 |
| rework | 同上 workflow_rework，wake/activation/epoch | 是；必须保留rework内容消费 |
| ship carrier | 同上 workflow_ship_carrier | 是；无ship授权扩张 |
| turn-end sweep | db.ts:sweepRunnerDoorbellWake | 直接建message_traffic，当前不走midturn admission |
| operator reroute | db.ts:rerouteRunnerPhaseWake | 显式queued，保留purpose/lineage |
统一receiver入口 plugin.ts:8862 → enqueueRunnerReceiverDelivery → runnerWakeAdmission。测试直接enqueue不是新生产来源。
