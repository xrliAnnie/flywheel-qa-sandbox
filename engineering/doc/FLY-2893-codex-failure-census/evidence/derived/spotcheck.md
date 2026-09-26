# FLY-2893 抽查记录 — 10 条出事记录对照生产原始数据
Issue: FLY-2893
日期: 2026-09-25
基于: evidence/derived/incidents.csv

抽样方法：`random.seed(2893)` 后从 incidents.csv 全体（559 行）无放回抽取 10 条。
核对方法：只读查询生产 `teamlead.db`（`session_events.session_failed` 原文、`workflow_run_event` 里的判死 / 起跑回滚 / 节点完成 / writer_replacement），并用 grep 查 `~/.flywheel/state/codex-sessions/<exec>/transcript.log` 里的上游错误。

| exec | 单 | 分类 | 生产原始证据 | 结论 |
|---|---|---|---|---|
| 7553c3bd | FLY-2694 | K1 | session_failed 03:04:20 `goal_usage_limited`；transcript 里有 `usageLimitExceeded` | 一致 |
| 2d58c10a | FLY-2688 | K6 | session_failed 02:41:16 `worktree_takeover_failed … clean=false`；02:54:02 `unlaunched_admission_rolled_back` | 一致（t_i 取两者中较早的 02:41:16） |
| 2815301c | FLY-2774 | K1 | session_failed 20:15:06 usageLimited；20:16:12 判死，writer_replacement → 7a5b0a5e | 一致；接班者还没接上就又出事，所以这一段在对方出事时切断 |
| 9578428d | FLY-2643 | K1 | session_failed 22:04:28；22:12:58 判死 → f5543708 | 一致 |
| dd375653 | FLY-2669 | K1 | session_failed 02:58:52；03:00:25 判死 → c1ab5587 | 一致 |
| 9f360087 | FLY-2638 | K0 | 05:15:12 node_completed；06:27:00 判死 reason=`actor_session_terminal:completed` | 一致（非故障：land 冲突再激活）；这条样本暴露了 t_need 边界 bug（`>` 应为 `>=`），已修复并重跑 |
| 41ec9e44 | FLY-2711 | K1 | 03:48:02 node_completed；04:05:50 usageLimited | 一致；停驻中死掉、之后引擎没再要它 → 浪费记 0 |
| 46e91f56 | FLY-2802 | K12 | 没有 session_failed，也没有判死；只有运维终结 run，原文为 FLY-2373 完工死锁 | 一致 |
| 6426a497 | FLY-2774 | K1 | session_failed 20:32:37 usageLimited；transcript 里有 `usageLimitExceeded` | 一致 |
| cec3f253 | FLY-2447 | K8 | 17:06:02 node_completed；17:18:54 `[GitResultChecker] … Child stdio did not close within 250ms` | 一致；交卷之后才出事 → 浪费记 0 |

10/10 一致。发现的 1 个 bug 已修，修复后全流程重跑，自检通过；同一冻结点重跑两次，全部 CSV 逐字节相同。
