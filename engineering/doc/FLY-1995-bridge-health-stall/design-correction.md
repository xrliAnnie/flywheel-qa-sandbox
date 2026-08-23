# FLY-1995 Bridge 健康停顿 — 设计修正
Issue: FLY-1995 (https://linear.app/geoforge3d/issue/FLY-1995/容量bug症状-生产-bridge-低负载下准周期不可用623percent-墙钟-health-答不进-1s最大-26-29s进程-cpu)
日期: 2026-08-22
基于: plan.md

本文件按 FLY-1404 记录 founder 在互动页上的增量裁定；不回滚 `plan.md`、不重开 design gate。与 `plan.md` 冲突处以本文为准。

## C1 Founder 原话与处置

- 「相当于说加log吗」：黑匣子并非普通逐条日志，而是低频事件循环窗口、发作时 CPU profile 与 rider 墙钟账；Lead 已在 thread 直接解释，本实现不再增加普通日志。
- 「听起来是该清理数据库了,不过听起来另一个问题就是,我们数据库是不是根本就没有任何的index,导致数据库一大读起来就很慢。」
- 「说句实话,听起来就是数据库太大了,需要把一些老的信息做清理了。另外就是反映出来的问题,就理论上数据库做好分区和index的话,理论上查询不会这么慢的。当然这个优化可以以后再去做,但现在听起来马上可以做的事情就是把数据库的老旧data清理一次。」

处置：把两块已确认的积压收口排在上线后的第一刀；分区与新增 index 留作 follow-up，不扩大本单。

## C2 对 plan.md 时序的修正

`plan.md §4.2` 的「先取得 production profile、再清理」证据门被 founder 的最新裁定覆盖。交付后的运维顺序改为：

1. 部署仅针对已确认 `voice-honeylemon-fly1911` actor 的 orphan hygiene 与 skip-audit 限频；旧 session-less ask 进入 `terminal_disposed`，线性重扫停止。
2. 在 Bridge 停机窗由 operator 对 `session_events` 精确 cohort 做 dry-run、备份、校验与 apply。脚本仍不由 implement runner 在生产执行，也不改变 FLY-1959 的部署纪律。
3. 同一版本的事件循环黑匣子继续采样后续发作，供 FLY-1986 使用；清理前的症状数据、SQL 计时与 cohort 收据保留为 before 基线。

因此本单同时交付清理和仪表，但生产动作先清积压，不再让 profile 成为 apply 前置条件。

## C3 相关 index 盘点（只读，2026-08-22）

结论不是「根本没有 index」：

- `teamlead.db.session_events` 有 `id` 主键、`event_id` 唯一索引、`idx_events_execution(execution_id)`、`idx_events_issue(issue_id)`、`idx_events_type_ts(event_type, ts)`。精确清理 cohort 的 `EXPLAIN QUERY PLAN` 使用 `idx_events_type_ts` 做 event type + 时间范围搜索；`source` 是剩余过滤条件。
- `comm.db.mailbox` 有 `id`/`delivery_id` 唯一索引和多个投递队列 partial index；response 反查使用 `mailbox_unique_response(ref_id) WHERE type='response'`。
- 但 `getPendingQuestions` 的 pending-question 条件没有覆盖型组合索引。生产 query plan 是扫描 `mailbox`、用 `mailbox_unique_response` 做相关 response lookup，再用临时 B-tree 排 `created_at`。这证明「并非零 index」，也证明 pending 面仍有后续优化空间。

本单不新增 index：当前确定性收益来自删除/终态化积压与停止重复写；pending-question 组合索引、通用 retention/归档，以及 SQLite 上可行的分区替代方案另立 follow-up，并用真实 query plan 与写放大成本评审。

## C4 QA 增量

- 交付报告必须引用 `cleanup-exclusion-manifest.md`，让 FLY-1998 显式避开 FLY-1995 所有行集。
- 验证 old asks 终态、orphan 日志斜率归零、skip audit 限频生效。
- 手术前后保存 cohort receipt 和同一测量面的延迟/事件循环指标；不把清理后症状缓解倒写成此前未证实的根因结论。
