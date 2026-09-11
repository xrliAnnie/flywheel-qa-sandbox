# FLY-2507 TURN 等待状态 — 实施计划
Issue: FLY-2507 (https://linear.app/geoforge3d/issue/FLY-2507)
日期: 2026-09-10
基于: research.md、Lead instruction 98d6f587-3544-4233-8126-3c1139437e1d

状态：按 Lead 裁定准备，等待已登记 R2 结论和路径函数澄清后提交最后 R3。R3 若打回，只报告 Lead，不再自行扩展。

## 锁定判据

只修 turn-wait 等待体的行动者判定和共享账本消费，不改其它告警机制。

先核对 CommDB 当前 TURN 的 target_run_id 与等待 execution 的 workflow_execution_binding。以 run_id 限定，允许同 execution 的多 attempt 历史；没有匹配 run/binding 或库读取失败是 unknown，沿用原告警并记录诊断。

对已确认属于该 run 的等待体，查询当前 workflow_run.current_node_id 对应的 workflow_run_node 最新 attempt：只有 ended_at IS NULL 且 state IN ('running','review','admitted') 的 execution_id 等于等待体，才视为当前指定行动者，保留超阈值新问题。可确认的非行动者抑制新问题，不以 founder_gate/land 名称或自报 parked 推断。当前节点缺行属 unknown；存在节点但 actor 为 NULL 或节点已结束，表明该体没有当前行动责任。completed run 不再有行动责任；held/terminated 不凭 status 自动替代 actor 判断。

founder 批准后若该体成为当前指定行动者，必须恢复告警。多 attempt 必须按当前节点最新 attempt 查，不能将多条历史绑定视为未知。等待时间没有额外封顶；非行动者停驻不是逾期。新 epoch/grant/no-turn 维持原有清理和计时语义；旧问题不撤回、不自动回答。

## 单账本最小实现

turn_wait_ledger 增加 nullable suppressed_reason TEXT，沿用现有 PRAGMA table_info 幂等加列迁移。每次有效 not-yours 观察更新该列：非行动者写明 run/node/attempt/actor 原因；行动者或 unknown 清空，保证恢复告警。非空时不 insertQuestion，不写 asked_at；原 question+asked_at 原子事务和 deterministic id 保留。

StateStore 读取必须在 CommDB immediate 写事务外完成，参数化单次只读事务、readonly/fileMustExist、try/catch/finally close。计算结果传入 observeTurnWait，无网络端点或状态镜像。debug override 不读/不写。保留 TURN stdout 与退出码。

CommDB patrol 读取投影携带同一 suppressed_reason；judgeLoopLight 的 classifyTurnWaits 忽略被抑制行，不把其加入 blockedExecutionIds/redWaiters，避免两个判读者互相矛盾。旧 readonly schema 缺该列以 NULL 兼容，不能把整个巡检变 unknown。把该列纳入现有字段级 schema/fixture/fingerprint 检查（若适用）；无新表，不新增 retention 类别。

路径：必须复用现成解析，不自建体系。当前已定位 config/commdb-path.ts 与 comm/commands/verify-approval.ts resolveStateDbPath，但未定位 Lead 所指 Bridge 成对函数；澄清问题 0d7ed9f3-7f77-4823-adf8-29228681aaff 待答，解决后才提交 R3。隔离 CommDB 不得静默读取生产 StateStore。

## 验证

严格 TDD：先写非行动者超阈值仍发问的 RED，再最小 GREEN。验证 acting running/review/admitted 各态正常一次告警，ended_at 非 NULL/他人 actor/NULL actor 正常抑制；founder_gate/land 两种名称下都以 actor 为准；多 attempt/跨 run/缺行 unknown；actor 切换解除抑制；重复 reopen/replay 去重；新 epoch 与 grant/no-turn 清理；已发问题不改写；读取失败和 debug override；新列旧库迁移、旧 readonly schema兼容、patrol 同账本不报相反等待状态。

运行 pnpm lint、pnpm -r build、pnpm test:packages:run 和新增 shell tests（若有），保留真实全仓结果。最终 code review、里程碑最后 commit、PR、DONE 报告和 needs_review completion/park 按原注入合同执行。
