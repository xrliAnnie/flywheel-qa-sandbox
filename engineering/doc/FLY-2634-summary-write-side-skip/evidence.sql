-- # FLY-2634 summary 写侧省量 — 验收证据
-- Issue: FLY-2634 (https://linear.app/geoforge3d/issue/FLY-2634/summary写侧省量-无实质变化不生成周期摘要避免唤醒-lead-只为交空报告)
-- 日期: 2026-09-16
-- 基于: plan.md

-- 只读用法
-- 1. teamlead.db / comm.db 必须先由 scripts/flywheel-snapshot-control.mjs runner
--    取到 /tmp/flywheel-snapshots/<exec>/；禁止直接复制生产数据库。
-- 2. 对每个待验项目，用它自己的 comm.db 重跑本文件：
--
-- sqlite3 -readonly /tmp/flywheel-snapshots/<exec>/teamlead.db \
--   -cmd ".parameter init" \
--   -cmd ".parameter set @effective '2026-09-17T00:00:00.000Z'" \
--   -cmd ".parameter set @until '2026-09-20T00:00:00.000Z'" \
--   -cmd ".parameter set @project 'growth'" \
--   -cmd ".parameter set @lead 'growth-lead'" \
--   -cmd "ATTACH DATABASE 'file:/tmp/flywheel-snapshots/<exec>/growth-comm.db?mode=ro' AS comm" \
--   < engineering/doc/FLY-2634-summary-write-side-skip/evidence.sql
--
-- 可选参数：
--   @baseline_from / @baseline_to       上线前对照窗口（slot_start，ISO Z）
--   @sample_from / @sample_to           A3/A4/A11/A13/A14 的操作窗口（ISO Z）
--   @flag_off_from / @flag_off_to       A9 kill-switch 关闭窗口（ISO Z）
--   @custom_period                       A7 一次性请求使用的精确 period 字符串
--   @teamlead_sampled_at / @comm_sampled_at / @github_sampled_at
--   @merge_sha / @deploy_sha            A10 分层证据，仅作回显，不推导
--
-- 所有时间窗口均为 [from,to)。未提供的参数为 NULL，对应样本查询返回空集。
-- comm alias 必须是 @project 对应的只读快照；GitHub PR 快照另按 plan §6 的
-- `gh pr list --state all --limit 500` 保存并与这里的 delivered_pr 对照。

.bail on
.headers on
.mode column
.nullvalue NULL
PRAGMA query_only = ON;

-- ---------------------------------------------------------------------------
-- M0 writer / reader 调用量（A1/A2/A8 的量化总览）
-- 预期：上线后静默项目 writer_due_rows / delivered_writer_wakes 为 0；
--       无可读内容的 slot reader_round_rows / delivered_reader_wakes 为 0。
-- Bridge 没有 Claude token 账本，因此这里列真实触发事件与送达数，不用文字长度代替。
-- ---------------------------------------------------------------------------
WITH windows(label, from_ts, to_ts) AS (
  VALUES
    ('baseline', @baseline_from, @baseline_to),
    ('post_deploy', @effective, @until)
),
due AS (
  SELECT
    json_extract(payload, '$.project_name') AS project,
    json_extract(payload, '$.summary_due.slot_start') AS slot_start,
    delivered_at
  FROM lead_events
  WHERE event_type = 'summary_due'
),
skipped AS (
  SELECT
    json_extract(payload, '$.project_name') AS project,
    json_extract(payload, '$.summary_due_skipped.slot_start') AS slot_start
  FROM lead_events
  WHERE event_type = 'summary_due_skipped'
),
reader AS (
  SELECT
    substr(event_id, length('summary-absorption:') + 1) AS slot_start,
    delivered_at
  FROM lead_events
  WHERE event_type = 'summary_absorption_round'
)
SELECT
  w.label,
  COUNT(DISTINCT d.slot_start) AS observed_slots_with_due,
  COUNT(d.slot_start) AS writer_due_rows,
  SUM(CASE WHEN d.delivered_at IS NOT NULL THEN 1 ELSE 0 END) AS delivered_writer_wakes,
  (SELECT COUNT(*) FROM skipped s
    WHERE s.slot_start >= w.from_ts AND s.slot_start < w.to_ts
      AND (@project IS NULL OR s.project = @project)) AS skipped_rows,
  (SELECT COUNT(*) FROM reader r
    WHERE r.slot_start >= w.from_ts AND r.slot_start < w.to_ts) AS reader_round_rows,
  (SELECT COUNT(*) FROM reader r
    WHERE r.slot_start >= w.from_ts AND r.slot_start < w.to_ts
      AND r.delivered_at IS NOT NULL) AS delivered_reader_wakes,
  'token totals unavailable in Bridge; delivery events are the call driver' AS token_basis
FROM windows w
LEFT JOIN due d
  ON d.slot_start >= w.from_ts AND d.slot_start < w.to_ts
 AND (@project IS NULL OR d.project = @project)
WHERE w.from_ts IS NOT NULL AND w.to_ts IS NOT NULL
GROUP BY w.label, w.from_ts, w.to_ts;

-- ---------------------------------------------------------------------------
-- A1 静默项目连续 slot
-- 预期：目标静默 Lead skipped_slots >= 3；72h 验收 skipped_slots >= 12；
--       non_quiet_rows = 0、bad_mailbox_status = 0。
-- ---------------------------------------------------------------------------
SELECT
  json_extract(payload, '$.project_name') AS project,
  lead_id,
  COUNT(DISTINCT json_extract(payload, '$.summary_due_skipped.slot_start')) AS skipped_slots,
  SUM(CASE WHEN json_extract(payload, '$.summary_due_skipped.activity.verdict') <> 'quiet'
           THEN 1 ELSE 0 END) AS non_quiet_rows,
  SUM(CASE WHEN json_extract(payload, '$.summary_due_skipped.activity.sources.mailbox.status') <> 'ok'
           THEN 1 ELSE 0 END) AS bad_mailbox_status
FROM lead_events
WHERE event_type = 'summary_due_skipped'
  AND json_extract(payload, '$.summary_due_skipped.slot_start') >= @effective
  AND json_extract(payload, '$.summary_due_skipped.slot_start') < @until
  AND (@project IS NULL OR json_extract(payload, '$.project_name') = @project)
  AND (@lead IS NULL OR lead_id = @lead)
GROUP BY project, lead_id
ORDER BY project, lead_id;

-- A1 invariant：同一 producer / slot 不能同时 due 与 skipped。预期 0 行。
WITH decisions AS (
  SELECT
    json_extract(payload, '$.project_name') AS project,
    lead_id,
    json_extract(payload, '$.summary_due.slot_start') AS slot_start,
    'due' AS disposition
  FROM lead_events WHERE event_type = 'summary_due'
  UNION ALL
  SELECT
    json_extract(payload, '$.project_name'),
    lead_id,
    json_extract(payload, '$.summary_due_skipped.slot_start'),
    'skipped'
  FROM lead_events WHERE event_type = 'summary_due_skipped'
)
SELECT project, lead_id, slot_start, COUNT(*) AS contradictory_rows
FROM decisions
WHERE slot_start >= @effective AND slot_start < @until
  AND (@project IS NULL OR project = @project)
  AND (@lead IS NULL OR lead_id = @lead)
GROUP BY project, lead_id, slot_start
HAVING COUNT(DISTINCT disposition) > 1;

-- A1 CommDB：静默 producer 的 hot + terminal archive 中均不应有 summary_due。
-- 预期 unexpected_summary_due_deliveries = 0。
WITH materialized AS (
  SELECT delivery_id, to_agent, created_at FROM comm.mailbox
  UNION ALL
  SELECT
    delivery_id,
    json_extract(mailbox_json, '$.to_agent'),
    json_extract(mailbox_json, '$.created_at')
  FROM comm.mailbox_terminal_archive
)
SELECT COUNT(*) AS unexpected_summary_due_deliveries
FROM materialized
WHERE delivery_id LIKE 'lead_event:%:summary_due:%'
  AND created_at >= @effective AND created_at < @until
  AND (@lead IS NULL OR to_agent = @lead)
  AND (@project IS NULL OR delivery_id LIKE '%:summary_due:' || @project || '/%');

-- A1/A8：skipped producer 不得出现在冻结行的 due disposition 中。预期 0 行。
WITH frozen AS (
  SELECT json_extract(payload, '$.slot_start') AS slot_start, payload
  FROM lead_events
  WHERE event_type = 'summary_slot_settled'
    AND json_extract(payload, '$.slot_start') >= @effective
    AND json_extract(payload, '$.slot_start') < @until
), producers AS (
  SELECT
    f.slot_start,
    json_extract(p.value, '$.project') AS project,
    json_extract(p.value, '$.lead') AS lead,
    json_extract(p.value, '$.disposition') AS disposition
  FROM frozen f, json_each(f.payload, '$.producers') p
)
SELECT s.slot_start, s.project, s.lead_id, p.disposition
FROM (
  SELECT
    json_extract(payload, '$.summary_due_skipped.slot_start') AS slot_start,
    json_extract(payload, '$.project_name') AS project,
    lead_id
  FROM lead_events
  WHERE event_type = 'summary_due_skipped'
) s
JOIN producers p
  ON p.slot_start = s.slot_start AND p.project = s.project AND p.lead = s.lead_id
WHERE p.disposition = 'due';

-- ---------------------------------------------------------------------------
-- A2 活跃项目：逐 slot 的 verdict、三源计数与已交 PR。
-- 预期：active 样本仍有 due；source count 至少一项 > 0，或方向安全的 unknown。
-- ---------------------------------------------------------------------------
WITH due AS (
  SELECT
    json_extract(payload, '$.summary_due.slot_start') AS slot_start,
    json_extract(payload, '$.project_name') AS project,
    lead_id,
    json_extract(payload, '$.summary_due.period') AS period,
    json_extract(payload, '$.summary_due.activity.verdict') AS verdict,
    json_extract(payload, '$.summary_due.activity.sources.lead_events.count') AS lead_event_count,
    json_extract(payload, '$.summary_due.activity.sources.mailbox.count') AS mailbox_count,
    json_extract(payload, '$.summary_due.activity.sources.linear.count') AS linear_count
  FROM lead_events
  WHERE event_type = 'summary_due'
), delivered AS (
  SELECT
    json_extract(f.payload, '$.slot_start') AS slot_start,
    json_extract(p.value, '$.project') AS project,
    json_extract(p.value, '$.lead') AS lead,
    json_extract(p.value, '$.delivered_pr.number') AS pr_number,
    json_extract(p.value, '$.delivered_pr.state') AS pr_state
  FROM lead_events f, json_each(f.payload, '$.producers') p
  WHERE f.event_type = 'summary_slot_settled'
)
SELECT d.*, x.pr_number, x.pr_state
FROM due d
LEFT JOIN delivered x
  ON x.slot_start = d.slot_start AND x.project = d.project AND x.lead = d.lead_id
WHERE d.slot_start >= @effective AND d.slot_start < @until
  AND (@project IS NULL OR d.project = @project)
  AND (@lead IS NULL OR d.lead_id = @lead)
ORDER BY d.slot_start, d.project, d.lead_id;

-- ---------------------------------------------------------------------------
-- A3 / A13 非代码 founder 消息与 Lead bot @派活样本
-- 预期：操作窗口内存在 due，mailbox_count >= 1。A3 的操作者身份必须另附
-- founder 原始消息证据；A13 另附已配置 Lead bot 与 mention 原文。
-- ---------------------------------------------------------------------------
SELECT
  json_extract(payload, '$.summary_due.slot_start') AS slot_start,
  json_extract(payload, '$.project_name') AS project,
  lead_id,
  json_extract(payload, '$.summary_due.activity.sources.mailbox.status') AS mailbox_status,
  json_extract(payload, '$.summary_due.activity.sources.mailbox.count') AS mailbox_count
FROM lead_events
WHERE event_type = 'summary_due'
  AND json_extract(payload, '$.summary_due.slot_start') >= @sample_from
  AND json_extract(payload, '$.summary_due.slot_start') < @sample_to
  AND json_extract(payload, '$.summary_due.activity.sources.mailbox.count') >= 1
  AND (@project IS NULL OR json_extract(payload, '$.project_name') = @project)
  AND (@lead IS NULL OR lead_id = @lead)
ORDER BY slot_start;

-- ---------------------------------------------------------------------------
-- A4 静默转活跃
-- 预期：操作后的 slot 有 due、lead_event_count >= 1；下一无变化 slot 回 skipped。
-- ---------------------------------------------------------------------------
WITH decisions AS (
  SELECT
    json_extract(payload, '$.summary_due.slot_start') AS slot_start,
    json_extract(payload, '$.project_name') AS project,
    lead_id,
    'due' AS disposition,
    json_extract(payload, '$.summary_due.activity.sources.lead_events.count') AS lead_event_count
  FROM lead_events WHERE event_type = 'summary_due'
  UNION ALL
  SELECT
    json_extract(payload, '$.summary_due_skipped.slot_start'),
    json_extract(payload, '$.project_name'),
    lead_id,
    'skipped',
    json_extract(payload, '$.summary_due_skipped.activity.sources.lead_events.count')
  FROM lead_events WHERE event_type = 'summary_due_skipped'
)
SELECT * FROM decisions
WHERE slot_start >= @sample_from AND slot_start < @sample_to
  AND (@project IS NULL OR project = @project)
  AND (@lead IS NULL OR lead_id = @lead)
ORDER BY slot_start;

-- ---------------------------------------------------------------------------
-- A5 collector 不可用
-- 预期：每行都是 due；同 producer / slot 没有 skipped。原因必须非空。
-- ---------------------------------------------------------------------------
WITH unavailable AS (
  SELECT
    json_extract(d.payload, '$.summary_due.slot_start') AS slot_start,
    json_extract(d.payload, '$.project_name') AS project,
    d.lead_id,
    s.key AS source,
    json_extract(s.value, '$.reason') AS reason
  FROM lead_events d, json_each(d.payload, '$.summary_due.activity.sources') s
  WHERE d.event_type = 'summary_due'
    AND json_extract(s.value, '$.status') = 'unavailable'
    AND json_extract(d.payload, '$.summary_due.slot_start') >= @effective
    AND json_extract(d.payload, '$.summary_due.slot_start') < @until
)
SELECT
  u.*,
  EXISTS (
    SELECT 1 FROM lead_events k
    WHERE k.event_type = 'summary_due_skipped'
      AND k.lead_id = u.lead_id
      AND json_extract(k.payload, '$.project_name') = u.project
      AND json_extract(k.payload, '$.summary_due_skipped.slot_start') = u.slot_start
  ) AS contradictory_skipped
FROM unavailable u
WHERE (@project IS NULL OR u.project = @project)
  AND (@lead IS NULL OR u.lead_id = @lead)
ORDER BY u.slot_start, u.project, u.lead_id, u.source;

-- ---------------------------------------------------------------------------
-- A6 应交未交
-- 预期：due_delivery='delivered' 且 delivered=0 的 producer 在 absent；
--       不得同时在 skipped。以下违规查询预期 0 行。
-- ---------------------------------------------------------------------------
WITH frozen AS (
  SELECT json_extract(payload, '$.slot_start') AS slot_start, payload
  FROM lead_events
  WHERE event_type = 'summary_slot_settled'
    AND json_extract(payload, '$.slot_start') >= @effective
    AND json_extract(payload, '$.slot_start') < @until
), producers AS (
  SELECT
    f.slot_start,
    json_extract(p.value, '$.project') AS project,
    json_extract(p.value, '$.lead') AS lead,
    json_extract(p.value, '$.disposition') AS disposition,
    json_extract(p.value, '$.due_delivery') AS due_delivery,
    json_extract(p.value, '$.delivered') AS delivered,
    f.payload
  FROM frozen f, json_each(f.payload, '$.producers') p
)
SELECT slot_start, project, lead, disposition, due_delivery, delivered
FROM producers
WHERE disposition = 'due' AND due_delivery = 'delivered' AND delivered = 0
  AND (
    NOT EXISTS (
      SELECT 1 FROM json_each(producers.payload, '$.absent') a
      WHERE a.value IN (producers.lead, producers.project || '/' || producers.lead)
    )
    OR EXISTS (
      SELECT 1 FROM json_each(producers.payload, '$.skipped') s
      WHERE s.value IN (producers.lead, producers.project || '/' || producers.lead)
    )
  );

-- A6 正向清单：应交未交与机制异常分别列出，不混作 healthy silence。
SELECT
  json_extract(payload, '$.slot_start') AS slot_start,
  json_extract(payload, '$.absent') AS absent,
  json_extract(payload, '$.skipped') AS skipped,
  json_extract(payload, '$.undelivered') AS undelivered,
  json_extract(payload, '$.delivery_unknown') AS delivery_unknown,
  json_extract(payload, '$.round_ledger') AS round_ledger
FROM lead_events
WHERE event_type = 'summary_slot_settled'
  AND json_extract(payload, '$.slot_start') >= @effective
  AND json_extract(payload, '$.slot_start') < @until
ORDER BY slot_start;

-- ---------------------------------------------------------------------------
-- A7 一次性基线
-- SQL 只能证明它没有变成周期义务；FLY-2633 #160-#165 与命令零 diff 需另附：
-- `git diff <merge-base>...HEAD -- packages/flywheel-comm/src/commands/summary.ts`
-- 预期 periodic_rows_for_custom_period = 0（把 @custom_period 设为一次性请求的精确 period）。
-- ---------------------------------------------------------------------------
SELECT COUNT(*) AS periodic_rows_for_custom_period
FROM lead_events
WHERE event_type IN ('summary_due', 'summary_due_skipped')
  AND COALESCE(
    json_extract(payload, '$.summary_due.period'),
    json_extract(payload, '$.summary_due_skipped.period')
  ) = @custom_period;

-- ---------------------------------------------------------------------------
-- A8 空轮不叫 Raya
-- 预期 0 行：not_issued 没有 round，issued 恰有一行。
-- ---------------------------------------------------------------------------
WITH frozen AS (
  SELECT
    json_extract(payload, '$.slot_start') AS slot_start,
    json_extract(payload, '$.raya_round') AS raya_round,
    json_extract(payload, '$.delivered_count') AS delivered_count,
    json_extract(payload, '$.skipped_delivered_count') AS skipped_delivered_count,
    json_extract(payload, '$.open_unread_count') AS open_unread_count,
    json_array_length(json_extract(payload, '$.undelivered')) AS undelivered_count,
    json_array_length(json_extract(payload, '$.delivery_unknown')) AS delivery_unknown_count,
    json_extract(payload, '$.round_ledger') AS round_ledger
  FROM lead_events
  WHERE event_type = 'summary_slot_settled'
    AND json_extract(payload, '$.slot_start') >= @effective
    AND json_extract(payload, '$.slot_start') < @until
), correlated AS (
  SELECT
    f.*,
    (SELECT COUNT(*) FROM lead_events r
      WHERE r.event_type = 'summary_absorption_round'
        AND r.event_id = 'summary-absorption:' || f.slot_start) AS round_rows
  FROM frozen f
)
SELECT * FROM correlated
WHERE (raya_round = 'not_issued' AND round_rows <> 0)
   OR (raya_round = 'issued' AND round_rows <> 1)
   OR (raya_round = 'not_issued' AND NOT (
        delivered_count = 0
        AND skipped_delivered_count = 0
        AND open_unread_count = 0
        AND undelivered_count = 0
        AND delivery_unknown_count = 0
        AND round_ledger = 'ok'
      ));

-- ---------------------------------------------------------------------------
-- A9 kill-switch（唯一需要操作的验收格）
-- 预期：关闭窗口 skipped_rows=0、due_with_activity=0；同时另存管理台操作回执，
-- 并对 comm.mailbox.delivery_content 做关闭前/后的逐字快照比较。
-- ---------------------------------------------------------------------------
SELECT
  COALESCE(SUM(CASE WHEN event_type = 'summary_due_skipped' THEN 1 ELSE 0 END), 0) AS skipped_rows,
  COALESCE(SUM(CASE WHEN event_type = 'summary_due'
                     AND json_type(payload, '$.summary_due.activity') IS NOT NULL
                    THEN 1 ELSE 0 END), 0) AS due_with_activity,
  COALESCE(SUM(CASE WHEN event_type = 'summary_due' THEN 1 ELSE 0 END), 0) AS legacy_due_rows
FROM lead_events
WHERE COALESCE(
    json_extract(payload, '$.summary_due.slot_start'),
    json_extract(payload, '$.summary_due_skipped.slot_start')
  ) >= @flag_off_from
  AND COALESCE(
    json_extract(payload, '$.summary_due.slot_start'),
    json_extract(payload, '$.summary_due_skipped.slot_start')
  ) < @flag_off_to
  AND (@project IS NULL OR json_extract(payload, '$.project_name') = @project);

-- ---------------------------------------------------------------------------
-- A10 合入 / 部署 / 生效证据分层
-- 本行只回显外部回执；任何 NULL 都是不完整，不得把 merge 当 deploy 或 live proof。
-- 生效证明使用本文件其余查询，水位取三份快照 sampled_at 的最早值。
-- ---------------------------------------------------------------------------
SELECT
  @merge_sha AS merged_head,
  @deploy_sha AS deployed_head,
  @teamlead_sampled_at AS teamlead_sampled_at,
  @comm_sampled_at AS comm_sampled_at,
  @github_sampled_at AS github_sampled_at,
  min(@teamlead_sampled_at, @comm_sampled_at, @github_sampled_at) AS common_watermark;

-- ---------------------------------------------------------------------------
-- A11 周期提醒不唤醒
-- 预期：样本窗口只见 skipped；checkpoint_park_nudge 不形成 due。
-- 若有新的 session_zombie_detected，则对应 slot 应见 due（业务事件 count >= 1）。
-- ---------------------------------------------------------------------------
WITH decisions AS (
  SELECT
    json_extract(payload, '$.summary_due.slot_start') AS slot_start,
    lead_id,
    'due' AS disposition,
    json_extract(payload, '$.summary_due.activity.sources.lead_events.count') AS lead_event_count
  FROM lead_events WHERE event_type = 'summary_due'
  UNION ALL
  SELECT
    json_extract(payload, '$.summary_due_skipped.slot_start'),
    lead_id,
    'skipped',
    json_extract(payload, '$.summary_due_skipped.activity.sources.lead_events.count')
  FROM lead_events WHERE event_type = 'summary_due_skipped'
)
SELECT * FROM decisions
WHERE slot_start >= @sample_from AND slot_start < @sample_to
  AND (@lead IS NULL OR lead_id = @lead)
ORDER BY slot_start;

SELECT event_type, COUNT(*) AS rows_in_operation_window
FROM lead_events
WHERE created_at >= replace(substr(@sample_from, 1, 19), 'T', ' ')
  AND created_at < replace(substr(@sample_to, 1, 19), 'T', ' ')
  AND event_type IN ('checkpoint_park_nudge', 'session_zombie_detected')
  AND (@lead IS NULL OR lead_id = @lead)
GROUP BY event_type;

-- ---------------------------------------------------------------------------
-- A12 晚交不丢
-- 预期：open_unread_count >= 1 的冻结行必为 issued 且恰有一轮；
-- delivered_pr.number/state 与同水位 GitHub 快照的 OPEN PR 对照。
-- ---------------------------------------------------------------------------
SELECT
  json_extract(f.payload, '$.slot_start') AS slot_start,
  json_extract(f.payload, '$.open_unread_count') AS open_unread_count,
  json_extract(f.payload, '$.raya_round') AS raya_round,
  (SELECT COUNT(*) FROM lead_events r
    WHERE r.event_type = 'summary_absorption_round'
      AND r.event_id = 'summary-absorption:' || json_extract(f.payload, '$.slot_start')) AS round_rows,
  json_extract(f.payload, '$.producers') AS producers
FROM lead_events f
WHERE f.event_type = 'summary_slot_settled'
  AND json_extract(f.payload, '$.slot_start') >= @effective
  AND json_extract(f.payload, '$.slot_start') < @until
  AND json_extract(f.payload, '$.open_unread_count') >= 1
ORDER BY slot_start;

-- ---------------------------------------------------------------------------
-- A14 Linear 直接改动
-- 预期：真实 state/parent/priority/new issue 样本 linear_count >= 1；
-- 仅评论或零命中是 unavailable:linear_zero_unprovable，绝不 skipped。
-- ---------------------------------------------------------------------------
SELECT
  json_extract(payload, '$.summary_due.slot_start') AS slot_start,
  json_extract(payload, '$.project_name') AS project,
  lead_id,
  json_extract(payload, '$.summary_due.activity.sources.linear.status') AS linear_status,
  json_extract(payload, '$.summary_due.activity.sources.linear.count') AS linear_count,
  json_extract(payload, '$.summary_due.activity.sources.linear.reason') AS linear_reason,
  json_extract(payload, '$.summary_due.activity.verdict') AS verdict
FROM lead_events
WHERE event_type = 'summary_due'
  AND json_extract(payload, '$.summary_due.slot_start') >= @sample_from
  AND json_extract(payload, '$.summary_due.slot_start') < @sample_to
  AND (@project IS NULL OR json_extract(payload, '$.project_name') = @project)
  AND (@lead IS NULL OR lead_id = @lead)
ORDER BY slot_start, project, lead_id;

-- 最终人工结论必须分别列出：
-- - focused / aggregate tests；
-- - code review verdict；
-- - PR exact head CI；
-- - merge SHA（若已合入）；
-- - deploy receipt SHA（若已部署）；
-- - 本文件对生效后首个完整 slot 的输出（若已生效）；
-- 不得由任一层推导下一层。
