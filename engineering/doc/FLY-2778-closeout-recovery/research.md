# FLY-2778 收尾恢复 — 调研
Issue: FLY-2778 (https://linear.app/geoforge3d/issue/FLY-2778/收尾清理失效-ship-之后-worktree-没被删thread-没归档land-收尾-issue-closeout-incomplete)
日期: 2026-09-26
基于: exploration.md

## 1. 证据范围与可信度
基线 `fdd1b404d`；已读 CLAUDE、产品体验、FLY-2616 plan、FLY-2919 当前 plan/progress。FLY-2616 实现合入 `aaf8e9c0e`，因此本单不是重新实现其计划。FLY-2919 仍在 implement、progress 0/6，不把在飞源码当部署。
生产只读 `sqlite3 mode=ro` + `PRAGMA query_only=ON`，closeout-readonly.json 在一个显式读事务内导出选中关系；其他文件为后续独立观察，不能跨文件宣称同一时刻。受管 snapshot 命令返回 `snapshot_owner_unavailable`，没有 cp DB、修改行、运行 cleanup 或读取取证副本。附件只保留命名样本的选定事件、每执行最新证据、操作收据与告警；不能拿 limit 样本比例估计全月故障分布。

## 2. 核心发现与反证
| 发现 | 证据 | 结论/处置 |
|---|---|---|
| 9-17 后零清理 | session_events 最晚 9-17；但 land_operation_step 9-17 后有 62 done、24 absent，最新 done 9-26 18:37Z | 原推断被否定。保留事件名，用 operation-scoped audit 查 DAG；不伪造 session execution |
| FLY-2934 worktree 没清理 | 同 operation 有 done、absent，仍 partial；目标路径在收据中 | “所有新单都没执行清理”被否定；最终记录步骤失败与目录清理是两件事 |
| held 没有告警 | 2688/2751/2766/2917/2916/2910 六样本 outbox 均 sent；2917 attempt=2；部分线程通知 suppressed_archived | 无告警基础设施推断被否定。sent 在代码中包含 queued，不能证明 Lead 模型消费；检查 crash/retry dedupe |
| FLY-2616 没生效 | 大量 execution evidence=gone；但指定阻塞节点有零 evidence | 已有能力部分运行，入口未全收敛；不能把旁边 gone 节点作为本 blocker 的证据 |

## 3. 逐类原因矩阵
| 原 cause | 样本/实际证据 | 源码原因 | 处置 |
|---|---|---|---|
| nodes_not_confirmed_gone | 2688 `ee549594-ccb1-4163-a68a-9ab770335aea` failed，session_failed 的 failureKind=null、auth source ENOENT；无 closeout evidence。2916 `a542ae1d-4904-4760-a7fa-5103bd12426e`、2910 `47b666b1-b6a8-4c8b-8308-bddcd3fc6a8c` crash_preserve 且无 evidence；后者 Child stdio timeout，不可当 auth-pre-spawn | lifecycle-closeout:1763–1789 在旧 probeRunExecutionLiveness 无 dead 时 return；后面的 collector 根本跑不到。run-quiescence:107–126 要受信 pre-adapter receipt，否则 missing ledger 为 unknown | FLY-2919 同一 body 证据进入 land 所有分支；保留取证，不假称这些未知体已死。旧 auth 样本仅适用 receipt-bound legacy 恢复，stdio timeout 不套用 |
| nodes_not_confirmed_gone / probe_timeout | 2917/2910/2934 附件有 hostProcess:probe_timeout；同时同执行此前有 gone | generalized-launch-recovery:64/79 串行 pgrep 5秒 + ps 5秒；execution-closeout-evidence:185 的外层预算默认5秒，Promise.race 不取消子进程。可产生不一致超时和积压；真实 CPU 因果尚未做性能实验 | 删除 land 重复全主机扫描，消费2919已绑定进程证据与采样预算；timeout 仍 unknown，不能加宽为 dead |
| window_identity_pending | 2751 `d249a2c3-2f7c-41c8-889f-373f6c79437e` terminated，多次 pending/daemon unverifiable，无 closeout evidence | close-runner:1085 调 probeRunExecutionLiveness 未传 storeFacts；旧 window/daemon 路径先挡住统一 collector | 接共同 body API；pending 只是窗口残留身份，不能授权 kill；若无可信旧绑定/出生失败回执则明确缺证待修，不凭“ghost”日志造死亡 |
| husk_lease_stale | 全月 last_error 25 completed + 2 held；2753 后续 shipped_husk_force_reaped + closeout complete；2638/2697 后续 tmux_closed | codex-phase-shutdown:180 用 stale heartbeat + live pane 拒绝，旧 cause 会在后续部分路径保留。pane 不等于可写进程；过期本身也不是 death | 复用2919与2903 stop-owner/drain 顺序；dead body 不受 viewer/旧心跳否决；alive 必须关停重探；真实仍活拒删。完成回执与 last_error 分开解释 |
| phase_shutdown_unacked | cause 分类覆盖 ACK 等待错误；本轮未重现原事故 | ACK/超时不是物理死亡 | 复用共同 stop/drained + body proof，真活/unknown 失败可见；保留负测 |
| commdb_finalize_failed | 代码的 identityRevision、reservation、TURN/wake fencing | 可能是身份变更/消息义务未完成；本轮没有逐个事故回放 | 不绕过 fence，重读并重试原义务；故障注入跨库 crash + 新 TURN 负控 |
| worktree_branch_mismatch | 当前 cleanup 已支持 merged_branch_verified/merge proof + path/gen 比对 | 名字不能代替分支覆盖；本轮未证新缺口 | 复用；MERGED exact head/ancestry 证明；CLOSED 则需独立远端备份证明 |
| lifecycle_conflict | freshAuthority/disposition 对 reopened/canceled/park 拒绝 | 正常安全拒绝，不统称 bug | 保留拒绝；报告冲突，不清理 |
| archive_failed | archive 在全体/目录完成后，外部请求可能失败/结果不明 | 未证新的 Discord 根因 | 查询远端已归档状态后幂等重试；不能将本地请求收据当成功 |

## 4. 实际调用链/消费者
`workflow-engine-dispatcher` → `land-executor` → plugin finalize wiring → `runPostShipFinalization` → `issueCloseout(deferRecordFinalization=true)` → 每节点关闭/证据 → `settleLandOperationWorktrees` → record finalization pass → archive/Linear → `finalization_completed`。
`worktree-cleanup.ts` 的 audit 对 operationContext 调 `recordLandCloseoutAudit` 写 aux step；legacy 才写 session_events。其 absent、parent identity、generation、dirty guard 与 non-force remove 已存在。
`StateStore.releaseLandOperationWithRetryAccounting` 同事务调用 enqueueLandHeldAlertTx；唯一身份 operation/resume_generation。dispatcher.reconcileLegacyLandAlerts 经 sink.alert，sent 或 queued 都记 sent；eventId 目前含 attempt，重试后的外部去重需查稳定 episode identity。不能只修 land-executor 的 best-effort thread 通知。

## 5. 相邻设计边界
FLY-2919 `execution-body-liveness.ts` 组装统一 BodyObservation：exact execution/activation/generation/lifecycleRevision、bindingDigest、alive/dead/unknown、observedAt/expiresAt。其 plan 总探针5秒、有效期10秒；启动/重启 owner 和 writer tree 均为2919所有。FLY-2778 只将它接入 land effect/finalization、收尾诊断与存量回收。实现先核对最终导出与 accepted owner 接线，不能照抄接口另建 evaluator。
FLY-2754 历史方案只提供 auth-pre-spawn receipt-bound 恢复思路；不代表已部署，也不覆盖任意缺 group / stdio timeout。FLY-2662 已有 reclose 和 target absence；沿用鉴权，不新增 Runner 死亡声明入口。

## 6. 未做与后续证据
没有实现、测试房、真实 ship、删除、重启、部署。两个指定 worktree 的 .git 仍存在。现有数据足以定位入口分裂和预算错配，不足以证明未知旧体已死、全月真实未清数量或 Lead 消费告警。实施/QA 必须按计划补齐，而非把本研究当生产修复成功。

## 7. Lead 当前决策
问题回复 cb2a32e9-73f8-4b6e-9520-21223c712403：确认纠正统计口径；2919负责唯一生命真源，2778只消费单一证据seam。2919未合入时可先定义seam并保守回退、记录切换策略；不要求等待才开始实现。继续保留2688/2751，无生产清理。详见plan §2/§10。
