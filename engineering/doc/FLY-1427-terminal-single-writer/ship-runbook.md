# FLY-1427 终态单写入者 + 覆盖保护 — 上线手册

Issue: FLY-1427 (https://linear.app/geoforge3d/issue/FLY-1427/enginebug5-dag-收尾第二写入者覆盖-terminate-终态completed-骗写-终态单写入者-覆盖保护)
日期: 2026-07-22
基于: plan.md

## 1. 上线范围与责任边界

- 本次发布包含 `flywheel-core` 的共享无出边终态判据，以及 TeamLead 的 StateStore、DirectEventSink、HTTP event route、complete-marker reconciler 改动。
- StateStore 启动迁移仅定点修正下列 5 个 execution；谓词是“该 id 当前仍为 `completed`”，因此可重复启动且不会改动其他行：
  - `88d06933-5795-4d21-aea0-db51930d7171`（FLY-1412）
  - `57e09567-68ba-49de-9448-9bcbc143c1d5`（FLY-1412）
  - `a955657f-010b-4527-99c4-5c0ef6714e8d`（FLY-1414）
  - `7b76d2a0-5a0a-45f1-9d29-09f14b57846c`（FLY-1413）
  - `c80fad41-998b-4843-b756-8886547049a8`（FLY-1414）
- 另 27 行 `completed AND session_stage='started'` 且没有 terminate 转移的 staleness 明确不在本单范围，发布前后应保持 27。
- FLY-1412/1413/1414 的 3 个 held workflow run 不自动推进、不自动 retry。session 终态修正不等于 run 已收敛；由 founder/Lead 逐个决定 retry、放弃或另行修复。

## 2. 发布前只读基线

在生产机上从当前 `~/.flywheel/teamlead.db` 读取 WAL 一致视图。先保留下列三组输出到发布记录；任何查询失败都停止发布。

```bash
sqlite3 -readonly ~/.flywheel/teamlead.db <<'SQL'
.headers on
.mode column
SELECT s.execution_id, s.issue_id, s.status, s.session_stage,
       s.lifecycle_revision, s.terminal_at
FROM sessions AS s
WHERE s.execution_id IN (
  '88d06933-5795-4d21-aea0-db51930d7171',
  '57e09567-68ba-49de-9448-9bcbc143c1d5',
  'a955657f-010b-4527-99c4-5c0ef6714e8d',
  '7b76d2a0-5a0a-45f1-9d29-09f14b57846c',
  'c80fad41-998b-4843-b756-8886547049a8'
)
ORDER BY s.execution_id;

SELECT COUNT(*) AS overwritten_terminate_then_completed
FROM sessions AS s
WHERE s.status = 'completed'
  AND EXISTS (
    SELECT 1 FROM session_events AS e
    WHERE e.execution_id = s.execution_id
      AND e.event_type = 'state_transition'
      AND json_extract(e.payload, '$.to') = 'terminated'
  );

SELECT COUNT(*) AS unrelated_started_staleness
FROM sessions AS s
WHERE s.status = 'completed'
  AND s.session_stage = 'started'
  AND NOT EXISTS (
    SELECT 1 FROM session_events AS e
    WHERE e.execution_id = s.execution_id
      AND e.event_type = 'state_transition'
      AND json_extract(e.payload, '$.to') = 'terminated'
  );
SQL
```

期望基线：第一组 5 行均为 `completed`；第二组为 5；第三组为 27。若线上数据已经变化，先记录原因并由 Lead 决定是否继续，不要手工扩大 backfill 集合。

同时确认 3 个相关 run 当前状态，留给人工处置：

```bash
sqlite3 -readonly ~/.flywheel/teamlead.db <<'SQL'
.headers on
.mode column
SELECT r.run_id, r.issue_id, r.status AS run_status,
       n.node_id, n.attempt, n.state AS node_state, n.execution_id
FROM workflow_run AS r
JOIN workflow_run_node AS n ON n.run_id = r.run_id
WHERE n.execution_id IN (
  '88d06933-5795-4d21-aea0-db51930d7171',
  '57e09567-68ba-49de-9448-9bcbc143c1d5',
  'a955657f-010b-4527-99c4-5c0ef6714e8d',
  '7b76d2a0-5a0a-45f1-9d29-09f14b57846c',
  'c80fad41-998b-4843-b756-8886547049a8'
)
ORDER BY r.issue_id, r.run_id, n.node_id, n.attempt;
SQL
```

## 3. 部署与单次 Bridge 重启

1. 合并并部署已通过 CI/QA 的提交，确认生产 checkout/build 已包含该提交。
2. 若当前有不宜中断的活跃 session，先协调到安全边界；使用 sanctioned Bridge-only 流程等待空闲后重启。该命令只重启 Bridge，不重启 Lead 或 Runner：

```bash
cd ~/Dev/flywheel
bash scripts/restart-services.sh --bridge-only --wait-idle
```

3. 确认命令的 health check 成功。不要再执行第二次重启；backfill 会随首次 StateStore 打开同步、幂等完成。

## 4. 发布后验证

重跑 §2 的三组只读查询，并增加审计核验：

```bash
sqlite3 -readonly ~/.flywheel/teamlead.db <<'SQL'
.headers on
.mode column
SELECT s.execution_id, s.issue_id, s.status, s.session_stage,
       s.lifecycle_revision, s.terminal_at
FROM sessions AS s
WHERE s.execution_id IN (
  '88d06933-5795-4d21-aea0-db51930d7171',
  '57e09567-68ba-49de-9448-9bcbc143c1d5',
  'a955657f-010b-4527-99c4-5c0ef6714e8d',
  '7b76d2a0-5a0a-45f1-9d29-09f14b57846c',
  'c80fad41-998b-4843-b756-8886547049a8'
)
ORDER BY s.execution_id;

SELECT COUNT(*) AS overwritten_terminate_then_completed
FROM sessions AS s
WHERE s.status = 'completed'
  AND EXISTS (
    SELECT 1 FROM session_events AS e
    WHERE e.execution_id = s.execution_id
      AND e.event_type = 'state_transition'
      AND json_extract(e.payload, '$.to') = 'terminated'
  );

SELECT COUNT(*) AS unrelated_started_staleness
FROM sessions AS s
WHERE s.status = 'completed'
  AND s.session_stage = 'started'
  AND NOT EXISTS (
    SELECT 1 FROM session_events AS e
    WHERE e.execution_id = s.execution_id
      AND e.event_type = 'state_transition'
      AND json_extract(e.payload, '$.to') = 'terminated'
  );

SELECT event_id, execution_id, event_type, source, payload, ts
FROM session_events
WHERE event_id IN (
  'fly1427:88d06933-5795-4d21-aea0-db51930d7171',
  'fly1427:57e09567-68ba-49de-9448-9bcbc143c1d5',
  'fly1427:a955657f-010b-4527-99c4-5c0ef6714e8d',
  'fly1427:7b76d2a0-5a0a-45f1-9d29-09f14b57846c',
  'fly1427:c80fad41-998b-4843-b756-8886547049a8'
)
ORDER BY execution_id;
SQL
```

硬性期望：

- 5 个 execution 全为 `terminated`，`session_stage` 和原 `terminal_at` 没有被 backfill 改写；每行 `lifecycle_revision` 只增加 1。
- `overwritten_terminate_then_completed = 0`。
- `unrelated_started_staleness = 27`，证明本单没有顺带改动另一类异常。
- 恰有 5 条 deterministic `state_correction` 审计，source 为 `fly-1427-backfill`，payload 为 `completed → terminated`。
- 3 个 workflow run/node 仍维持发布前 held/running 账面，不因 session backfill 自动推进。

随后由独立 QA 注入一个可丢弃的 DAG run：节点运行中执行受支持的 terminate 动作，等待原本会迟到的 completion 收尾信号，再确认 `sessions.status` 始终为 `terminated`，session event/teardown fact 仍有审计，但 lifecycle revision 与 terminal timestamp 没被迟到信号二次改写。

## 5. Held run 人工处置

把 §2 的 run 查询输出交给 founder/Lead。对 FLY-1412、FLY-1413、FLY-1414 分别明确记录一种处置：

- retry：按现有 workflow recovery/phase retry 流程生成新 execution；不得把旧 terminated execution 改回 completed。
- abandon：保留 held run 与 terminated session 作为事故事实，按受支持的关闭流程终结 issue/run。
- follow-up：若 run/node 账需要专项收敛，另立单；本 PR 不在 migration 中擅自推进 held run。

## 6. 回滚

1. 回滚本 PR 的代码并重新 build。
2. 再用 sanctioned `--bridge-only --wait-idle` 流程重启 Bridge。
3. 不回滚 5 行数据修正：`terminated` 才是原 FSM 终态，恢复为 `completed` 会重新制造假成功。
4. 重跑 §4 查询；若新写入仍出现 `terminate → completed`，立即停止相关 DAG 调度并升级给 Lead。27 行独立 staleness 仍不得在本回滚中修改。
