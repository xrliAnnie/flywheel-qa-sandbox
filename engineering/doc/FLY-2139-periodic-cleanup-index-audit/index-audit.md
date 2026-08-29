# FLY-2139 Bridge 全方位定期清理与 index 审计 — 索引审计

Issue: FLY-2139 (https://linear.app/geoforge3d/issue/FLY-2139/bridge-稳定全方位定期清理-文件db-陈旧数据的机制化清理与-index-审计保证-bridge-常快founder-已令开工)
日期: 2026-08-29
基于: plan.md

## 结论

六个 Bridge 热路径 tracing window 共执行 55 次 SELECT、覆盖 39 条不同 SQL。测试在每条查询真实执行前,用**该次调用的原始绑定参数**在同一 better-sqlite3 connection 上运行 `EXPLAIN QUERY PLAN`;六路都有非空捕获且命中预期 query family。结果:

- 审计的大表查询全部出现具名索引(含 SQLite 为 PRIMARY KEY 建的 `sqlite_autoindex_*`),无 bare `SCAN <大表>`。
- 首轮 Bridge 热路径发现 CommDB 以 `batch_id` 回读已冻结 batch 的两条查询缺索引。补 `mailbox_batch_lookup(batch_id, priority, seq) WHERE batch_id IS NOT NULL` 后,两条都从全表扫描 + 临时排序变成具名索引搜索,且不再建临时排序树。全套 CommDB 回归另发现 SQLite 会让 frozen-lease scan 误选新索引,因此同时补 `mailbox_lease_expiry_order(priority, seq, claim_expires_at)` partial index,维持原 lease 热路径的有界顺序扫描。
- QA 真规模复验又发现 retention 自身的 mailbox 候选查询未被首轮热路枚举覆盖:`NOT EXISTS` 的 `ref_id` 与 `superseded_by` 两个 correlated subquery 均逐行 `SCAN child`,使 66,272 行 inventory 达 510 秒。现补 `mailbox_ref_lookup(ref_id) WHERE ref_id IS NOT NULL` 与 `mailbox_superseded_by_lookup(superseded_by) WHERE superseded_by IS NOT NULL`;完整候选 EQP 的两路子查询均变为 `SEARCH child USING COVERING INDEX`。
- 14 个 `TEMP B-TREE` 均出现在**先由具名索引缩小候选集以后**的有界 `GROUP BY` / `COUNT(DISTINCT)` / `ORDER BY MIN(seq)` 或多分支 `OR` 归并。它们不是全量陈旧数据扫描;在不改查询文本/业务语义的边界下保留。测试把「临时树但没有任何具名索引访问」列为硬失败。

## before / after

| 查询族 | before | after |
|---|---|---|
| `SELECT * FROM mailbox WHERE batch_id = ? ORDER BY priority, seq` | `SCAN mailbox` + `USE TEMP B-TREE FOR ORDER BY` | `SEARCH mailbox USING INDEX mailbox_batch_lookup (batch_id=?)`;无 temp tree |
| `SELECT state, claimed_by FROM mailbox WHERE batch_id = ? AND recipient_kind = ? ORDER BY priority, seq` | `SCAN mailbox` + `USE TEMP B-TREE FOR ORDER BY` | `SEARCH mailbox USING INDEX mailbox_batch_lookup (batch_id=?)`;无 temp tree |
| frozen lease 顺序选择 | 仅加 batch index 时误选 `mailbox_batch_lookup (batch_id>?)` + temp sort | `SCAN mailbox USING INDEX mailbox_lease_expiry_order`;该 partial index 只含 inbox/LEASED/有 batch 行,并按 `priority,seq` 排序;无 temp tree |
| retention mailbox parent anti-join | 66,272 行 QA replica:两个 correlated `SCAN child`,候选 inventory 510s | 同规模 66,272 行 replica:两个 `SEARCH child USING COVERING INDEX`;完整候选遍历 74ms |

四个索引同时写入 `MAILBOX_SCHEMA`(新库)和 `ensureMailboxQueueSchema`(存量可写完整库),且 migration 在 legacy 最小 schema 缺列时跳过;独立测试同时证明完整存量库会补齐、最小 schema 仍可升级。没有修改任何查询文本。74ms 是隔离的同规模 after 证据;生产库会在新 Bridge 首次可写打开时通过现有 schema upgrade seam 安装索引。

## 同源自动证据

下列区块由 `fly2139-query-plans.test.ts` 从本次同一 capture set 计算;SQL/plan 变化会改变 digest 或表格并令测试失败。`captures` 是执行次数,`unique SQL` 是规范化 SQL 去重数。

<!-- FLY-2139 GENERATED QUERY-AUDIT EVIDENCE: BEGIN -->
| tracing window | captures | unique SQL | named indexes | temp B-trees after indexed access |
|---|---:|---:|---|---:|
| gate-poller | 2 | 2 | idx_founder_action_status, idx_sessions_status_revision | 1 |
| lead-inbox-admit | 30 | 19 | content_ref_gc_due, idx_sessions_status_revision, mailbox_archive_acked, mailbox_archive_dead, mailbox_batch_lookup, mailbox_bridge_reclaim, mailbox_claim_bridge, mailbox_claim_runner, mailbox_dead_scan, mailbox_deliverable_by_agent, mailbox_lead_reclaim, mailbox_lease_expiry, mailbox_lease_expiry_order, sqlite_autoindex_dead_letter_alerts_2 | 8 |
| runner-mailbox | 14 | 9 | mailbox_batch_lookup, mailbox_claim_runner, mailbox_deliverable_by_agent, mailbox_lease_expiry, mailbox_lease_expiry_order | 3 |
| patrol-tick | 4 | 4 | idx_lead_events_patrol, idx_sessions_status_revision | 0 |
| workflow-transition | 3 | 3 | sqlite_autoindex_workflow_rework_delivery_1, sqlite_autoindex_workflow_rework_request_1, sqlite_autoindex_workflow_rework_route_revision_1 | 0 |
| outbox-dead-letter | 2 | 2 | idx_dead_letter_alert_due, idx_workflow_alert_delivery, sqlite_autoindex_alert_delivery_receipts_1 | 2 |
capture-set-sha256: `225188124ac39050712a7824f35fe21742cd3fcbc19dfeecf488883e45af00d5`
<!-- FLY-2139 GENERATED QUERY-AUDIT EVIDENCE: END -->

## 防真空负控制

绿色 meta-test 在临时 fixture 中先证明 `idx_sessions_status_revision` 可通过 audit checker,随后 `DROP INDEX` 并确认 checker 同时报出 `no named index access`、`SCAN sessions` 与无索引前提下的 `TEMP B-TREE`;fixture 关闭即恢复,所以 CI 保持全绿而量尺本身也有证据。
