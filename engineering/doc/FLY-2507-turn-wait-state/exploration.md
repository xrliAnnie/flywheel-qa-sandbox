# FLY-2507 TURN 等待状态 — 探索
Issue: FLY-2507 (https://linear.app/geoforge3d/issue/FLY-2507)
日期: 2026-09-10
基于: 无

问题：实现体已交付、run 进入 founder_gate 后，QA 仍持 TURN；实现体正常 not-yours 轮询被按时长升级为需 Lead 回答的交接逾期问题。

当前审计：`CommDB.observeTurnWait` 只检查 asked_at 和 first_seen_at；`recordTurnWait` 未读 workflow 状态。CommDB 的 runner_workflow_activation 是冻结记录，实时 workflow_run / workflow_run_node 在 StateStore。不能用角色、QA 持有 TURN 或自报 park 单独证明交接已结束。

本次 run 使用 tpl_simple_code revision 5，从 implement 开始，无上游设计节点和文档。按注入 full DOC-FLOW 补设计审查后实施。保持 turn 的 stdout/退出码、TURN 权限和真实交接告警不变；不修 runner 生命周期，不操作生产数据。
