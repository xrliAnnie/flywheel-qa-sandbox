# FLY-1995 Bridge 健康停顿 — 清理避让清单
Issue: FLY-1995 (https://linear.app/geoforge3d/issue/FLY-1995/容量bug症状-生产-bridge-低负载下准周期不可用623percent-墙钟-health-答不进-1s最大-26-29s进程-cpu)
日期: 2026-08-22
基于: design-correction.md

本清单定义 FLY-1995 独占处置的两组数据。FLY-1998 及其他全库清扫必须显式排除这些谓词；不得用近似的时间窗、event type 或「旧数据」条件抢先删除。

## 1. CommDB session-less orphan questions

- 数据库：`~/.flywheel/comm/flywheel/comm.db`
- 基表：`mailbox`（`mailbox_message_projection` 只是只读 VIEW）
- FLY-1995 动作：guarded `UPDATE`，不是 `DELETE`；置 `relay_state='terminal_disposed'`、`resolved_via='fly1995_sessionless_ask'`，并保留 1 小时 forensic window。
- 立单时日志 census 是 46 个 qid；它不是稳定删除 cohort。2026-08-22 只读复核时日志集合已漂到 50 个，而下面的已确认 voice 积压仍是 42 行。避让以谓词为权威，不硬编码过期的「46」。

已确认存量行集（复核结果：42 行，`created_at` 为 `2026-08-21T20:35:34.179Z` 至 `2026-08-22T00:54:55.205Z`）：

```sql
SELECT q.id
FROM mailbox AS q
WHERE q.type = 'question'
  AND q.checkpoint IS NULL
  AND q.from_agent = 'voice-honeylemon-fly1911'
  AND q.relay_state != 'terminal_disposed'
  AND NOT EXISTS (
    SELECT 1 FROM mailbox AS r
    WHERE r.ref_id = q.id AND r.type = 'response'
  );
```

运行时 authority 只认上述 `voice-honeylemon-fly1911` sender，并叠加更严格的守卫：`checkpoint IS NULL`、可识别的 UTC `created_at` 且年龄大于 24 小时（兼容 StateStore 的 `YYYY-MM-DD HH:MM:SS` 与 mailbox 生产实际的 `YYYY-MM-DDTHH:MM:SS.sssZ`；上述 42 行全是后者）、CommDB registration 不存在、StateStore session 不存在、无 response、尚未 `terminal_disposed`。最终 mutation 仍以 `(id, from_agent)` 和 response race 双守卫。FLY-1998 应同时排除：

```sql
-- 未处置的已确认存量
(type = 'question' AND checkpoint IS NULL
 AND from_agent = 'voice-honeylemon-fly1911')
-- 已由 FLY-1995 处置、仍处于 forensic window 的行
OR (type = 'question' AND resolved_via = 'fly1995_sessionless_ask')
```

## 2. teamlead.db skip-audit storm residue

- 数据库：`~/.flywheel/teamlead.db`
- 基表：`session_events`
- FLY-1995 动作：operator-gated 精确 `DELETE`，由 `scripts/fly-1995-session-events-residue-surgery.mjs` 执行；dry-run receipt、source identity、script SHA、backup 与事务内复核共同绑定。
- 精确半开 cohort（2026-08-22 只读复核：2,638,046 行；`id` 3,673,869..6,320,302；实际 `ts` 2026-08-01 22:36:14..2026-08-05 03:09:04）：

```sql
event_type = 'issue_thread_infra_notify_skipped'
AND source = 'bridge.founder-thread-notifier'
AND ts >= '2026-08-01 22:00:00'
AND ts <  '2026-08-05 04:00:00'
```

FLY-1998 必须对该完整谓词取反；不能只排除 `event_type`，因为同类型在 cohort 外的新审计不归这次手术所有。最终行数以 FLY-1995 dry-run receipt 为准，apply 时若与 receipt 不一致则 fail closed。

## 3. Index 交界（供清扫计划估算，不授权 schema 变更）

- `session_events` cohort 搜索使用现有 `idx_events_type_ts(event_type, ts)`；`source` 余滤。
- `mailbox` 的 response anti-join 使用 `mailbox_unique_response(ref_id) WHERE type='response'`；pending-question 外层目前扫描 `mailbox` 并为 `created_at` 排序。
- 本清单不授权 FLY-1998 创建/删除 index、分区或改写上述谓词；schema 优化按 founder 裁定留作后续。
