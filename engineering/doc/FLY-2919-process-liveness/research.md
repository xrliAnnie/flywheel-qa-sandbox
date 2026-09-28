# FLY-2919 进程生死单一真源 — 调研
Issue: FLY-2919 (https://linear.app/geoforge3d/issue/FLY-2919/病根修复-2-体的生死只认一个真源死体当场终结活体不再按窗口判死9-张-68)
日期: 2026-09-26
基于: exploration.md

状态: 源码核验完成，待本轮有效设计审查。
审计基线: af853328d；续稿基线: 7520e274b。所有新接口均为拟实现，不是现有可调用能力。

## 3. 源码调研与必须改变的入口

下列行号以审计基线为准；实现时用符号查找，禁止凭行号直接修改。

| 入口 | 当前事实 | 处置 |
|---|---|---|
| `packages/teamlead/src/HeartbeatService.ts:847,963,1204,1987` | parked 另走报告路径；pending/absent pane 判 dead；最终复核仍是同一窗口探针 | 全部改读执行身份的进程证据，证死不受 parked 分流影响 |
| `packages/teamlead/src/bridge/tmux-lookup.ts:790` | 名为 probeRunnerProcessLiveness，实际只读 pane_dead | 保留为窗口观察工具并明确命名/注释；本单所有死亡授权调用方迁走，不能只改名字 |
| `packages/teamlead/src/bridge/generalized-launch-recovery.ts:145`、`run-quiescence.ts:41,80` | 通用恢复还信窗口；Codex daemon absent 后又受窗口/host-shell 否决 | 统一适配层；精确 worker absence 不被 viewer/poll shell 覆盖 |
| `packages/claude-runner/src/codex-daemon-runtime.ts:260–395` | 活=socket 持有者属于持久化 group；死=socket 不活且 group 不在；no_group/missing 未知 | 复用，保留身份、权限错误和 pre-spawn 边界 |
| `packages/teamlead/src/bridge/workflow-engine-dispatcher.ts:927,1984,2076` | held recovery 限 persisted_target_missing；dead sweep 先要求账面终态；alive+终态静默等待 | 删账面终态前置，按进程证据收敛；活的残留先请求收体再证死 |
| `packages/teamlead/src/StateStore.ts:44324,61335` | heldPaneLossRecovery 与 rollbackDeadWorkflowNodeExecution 再要求终态 | 以当前进程证据代替；保留精确 request/route/node/attempt 和 CAS |
| `StateStore.ts:16411` | terminalizeProvenDeadSessionTx 已维护时间戳、版本与资格撤销 | 扩展现有事务路径，不用裸 UPDATE 绕过不变量 |
| `packages/teamlead/src/bridge/commdb-fsm-reconcile.ts:207–350`、`packages/flywheel-comm/src/db.ts:9435` | 先等窗口死，再由 parked 声明否决；活窗口也阻挡结账 | 进程证明进入受信结账；自报 parked 不再有否决权 |
| `packages/flywheel-comm/src/db.ts:9267` | finalizeProvenGoneSession 已有 identity epoch、过期校验、幂等回执、TURN/创始人唤醒保护，但上下文是 land reservation | 提取内部受信 finalization 核心供生命周期协调器用，不伪造 land reservation |
| `packages/teamlead/src/bridge/delivery-operations.ts:167`、`StateStore.ts:49521` | CommDB running 可阻止到期探测；释放只结算特定 ship_parked | 到期走同一收体/结账路径，两载体均覆盖 |
| `packages/claude-runner/src/TmuxAdapter.ts:1301,1408,2120,2188` | 两条 wait 路径都把 pane 丢失当正常完成，返回 success:true | 窗口失联继续进程探测；无完成回执的真实异常退出记 failed |
| `packages/teamlead/src/DirectEventSink.ts:695,966`、`packages/edge-worker/src/Blueprint.ts` | adapter success 可落 session_completed | 增加异常退出分类，直接/HTTP 两入口同义，已接受交卷不被覆盖 |
| `StateStore.ts:50886,51872`、`packages/teamlead/src/bridge/plugin.ts:1911` | terminate 候选只收非终态；缺 session 直接当已收走 | collection 专用全归属候选，逐具核验物理体与通信残留 |
| `packages/teamlead/src/bridge/codex-phase-shutdown.ts:104,166` | 缺窗可绕协作关停，ACK 仅查窗消失 | 活控制器先协作停止；ACK 后仍核进程退出；窗口是另项清理 |
| `packages/claude-runner/src/CodexTmuxAdapter.ts:1727,2278` | runEnded/finally 已取消 TUI 恢复 | 让真关闭到达该路径；恢复前重核当前 run/owner 关闭事实 |
| `packages/teamlead/src/bridge/plugin.ts:15839`、`server-loss.ts` | tmux 服务损失可按窗口 gone 强制 failed | 服务损失只触发共同进程探测，不直接判死 |
| `packages/teamlead/src/bridge/crash-reaper.ts`、`zombie-scan.ts:93` | dead_pin / 24h 心跳 + pane 决定尸体 | 分离进程死亡与窗口清理；生命判断共用接口 |
| `packages/teamlead/src/bridge/pane-loss-reconcile.ts:510` | server generation + 窗口缺失仍可直接 applyTransition failed | 窗口事件只能触发共同进程探测；没有死亡证明只报窗口缺陷 |
| `packages/teamlead/src/bridge/execution-closeout-evidence.ts:126,470`、`lifecycle-closeout.ts:1799` | window/heartbeat 可以 veto gone，另有只按窗确认 gone 的分支 | body verdict 统一来源，拆开物理体终结与 UI 残留；保留 land reservation/归属与消息保护 |
| `packages/teamlead/src/bridge/commdb-session-prune.ts:503` | point/sweep parked veto、窗口探针仍独立决定 eligible_dead | 共用受信证据和结账义务，不保留旁路收账 |
| `packages/teamlead/src/bridge/patrol-process-liveness.ts:58`、`scripts/lead-patrol-snapshot.sh:432` | 巡检按窗判死/活，MISSING_PANE 被当“未工作”线索 | 进程结论与窗口缺失分别输出；窗口缺失仍须修复，但不导出体死或 TURN 无人 |


## 已核验的关键调用链

1. HeartbeatService.reconcileRunningSession 在非 running 时先分流 parked，后续通过 pane 探针给出死活；因此只改 dispatcher 不能消除此豁免。
2. codex-daemon-runtime.inspectCodexDaemonOwnership 用持久化 group、socket 与 socket holder 判断 daemon。无 group 返回 unknown，socket 不活加 group absent 才证明 daemon absent；该结果还未覆盖 controller 的重启能力。
3. codex-daemon-goal-runtime.runGoal 的重试会 killSession → drainExit → startSession → onSpawnIdentity；前后是同一个 thread。必须将 controller 身份与每次 native spawn 所有权纳入竞态守卫，不能拿旧 group absence 直接终结整个 execution。
4. StateStore 先记可靠死亡及可重放义务，CommDB 再投影；两个数据库不是一笔事务。现有 finalizeProvenGoneSession 绑定 land reservation，不能伪造 reservation 来复用。
5. CommDB.completeRunnerPhaseWakeTerminal(input) 接收 executionId/messageId/reason/terminalLifecycleId/nowMs；会将 pending wake 终结并保留 founder 来源和 wake_failed 告警。没有后继时也可明确交代失败，不能永远保留 running。
6. CommDB.deleteTurnIfCurrent(issueId, expectedHolder, expectedEpoch) 是 SQL compare-and-delete，可避免旧死亡证据删除新 TURN。工作树权限交接必须走现有 controller grant。

## 消费者覆盖核对

本轮重跑 plugin.ts 三种窗口探针搜索，确认 16 处调用/注入，另 3 处 import，与 plan §10.1 表一致。done-thread-reconcile、state-store-ghost-reconcile 与 closeout 必须迁移；纯 UI 查找仍可用窗口工具。接受的目标是删除窗口对死亡的授权，不是删除所有窗口 API。

## 相邻变更的当前证据

2026-09-26 本轮 gh pr view 1343 返回 MERGED，mergedAt=2026-09-26T15:15:00Z，merge SHA cfc8d52d81ed0f4f2a0d79bc3825ae22107a4bba。git show 可读取该提交；它不在当前设计分支。实现开工先同步该已有 stop-owner-before-reap/drained 原语，禁止再造平行收体器；合并事实不等于生产部署或本单验收完成。

## 约束与测试证据

- 仅设计文档与 HTML 改动，本轮未运行实现回归，未进行 529 故障注入。
- plan §7 完整保留九单×68矩阵；历史次数与当前测试通过数严格区分。
- plan §8 列精确 vitest 文件以及 529 的窗口/进程逆向、重启、两库中断恢复、旧代次拒绝。
- 外部文件与 OS 输出是输入，需限长、格式验证、身份复核；SQL 参数化；展示数据转义。绑定表不会形成同 UID 安全隔离。
- 无法确认的旧绑定保留 unknown，量化迁移缺口；不能为达到“当场”伪造死亡。
- 本地 Mermaid 渲染与托管 CSP 交互验证单独记证据，不将控制器测试称作浏览器视觉 QA。

## 评审驱动的必要补强

R1/R2 唯一 HIGH 是正常 Codex 原地重启空窗；保留提交已补 plan §4.1 的实际写点、owner token、spawn epoch、低层 spawn permit 与四边界红测。其他意见落实在 §4.2（writer 集合和采样预算）、§5（无后继 wake 与终态镜像）及 §10.1（旁路消费者）。本轮有效 APPROVED 前不得交付完成。
