# FLY-2778 收尾恢复 — 探索
Issue: FLY-2778 (https://linear.app/geoforge3d/issue/FLY-2778/收尾清理失效-ship-之后-worktree-没被删thread-没归档land-收尾-issue-closeout-incomplete)
日期: 2026-09-26
基于: 无

## 目标与范围
设计正常 ship 的完整收尾：证明所有关联执行已停止，安全移除工作树，归档讨论串，持久标记完成；失败耗尽一次去重告警；存量 dry-run → 安全执行。保留 FLY-2688/2751、脏树、未推分支、OPEN/无 PR 和数据库取证件。设计节点不实施、不做生产清理、不派工、不合入。

## 当前方向
复用 FLY-2616 的 land target、逐执行证据、reservation、absent 处理及告警 outbox；按实际失败证据修调用链。FLY-2919 负责生死真源，当前向 Lead 查询接口，不另造判定器。拒绝取消活体保护、全局 rm、增加重试次数掩盖探针超时、复制第二套告警或清理服务。

## 已确认与尚未确认
- 当前代码 HEAD fdd1b404d。DAG 的清理审计在 land_operation_step；session_events 最后记录 9-17 不能代表之后没有清理。实时只读查询已有 62 条 worktree_cleanup_done，最新 2026-09-26T18:37:18.571Z。
- 最新 closeout_execution_evidence 有 hostProcess:probe_timeout，必须追到完整执行身份与具体失败轮次。
- StateStore 已有 held + land_alert_outbox 原子写入；先查送达/消费，不新建告警机制。
- 受管快照命令返回 snapshot_owner_unavailable；未复制数据库，改用 mode=ro + query_only 的短查询，不将滚动读取伪称一致事故快照。
- 原始 32 份/80GB 为 Lead 历史观察，已多次清理，不能作为今日候选数量。

## 待解问题
1. 不同 cause 的真实阻塞点与探针预算；FLY-2919 接口对齐。
2. gone 证据与 transition/CommDB 前置判断是否矛盾。
3. outbox 的 persisted delivered 是否有 Lead receipt；保留去重粒度。
4. CLOSED 未合入存量的安全回收与 ship 收尾分开，不能伪造 merge receipt。
