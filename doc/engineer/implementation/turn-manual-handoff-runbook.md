# FLY-1614 TURN 手工交棒 — 应急 Runbook

Issue: FLY-1614 (https://linear.app/geoforge3d/issue/FLY-1614/巡检场景1-节点完成下一棒交接无死线无自播报-turn-beltfounder-gate-停滞只能靠-lead-查表发现今晚-3)
日期: 2026-08-11
基于: engineering/doc/FLY-1614-turn-handoff-deadline/plan.md

## 首选恢复路径

引擎拥有的 run **禁止直接改 SQL**。按故障类型走正规恢复面:

1. `workflow_rework_delivery.state = needs_lead`:调用既有 `POST /api/runs/:runId/rework`,创建新的 operator rework request。它会重新执行 master 鉴权、quiescence、凭据撤销和 target attempt 分配。
2. `workflow_carrier_delivery` 未交到棒:调用 bearer-authenticated `POST /api/workflow/carrier-redrive/stage`,请求体只允许 `runId/questionId/approvedHead/reason`;用返回的 server canonical + `confirmToken` 调 `POST /api/workflow/carrier-redrive`。apply 会重新核对批准 tuple,写审计事件,再由既有 engine tick 投递。
3. Bridge 可运行但两条正规路径都拒绝:停止,保留返回的 409/证据并升级 Lead;不要把 SQL 当成绕过 fail-close 的办法。

carrier redrive 的两个 POST 都要求 loopback Host、`Authorization: Bearer $TEAMLEAD_API_TOKEN` 和与 Host **完全同源**的 `Origin`(curl 不会自动补 `Origin`,漏掉会返回 `403 origin_rejected`)。可按下列模板执行;`BRIDGE_ORIGIN` 必须与实际 Bridge 的 scheme/host/port 一致:

```sh
BRIDGE_ORIGIN='http://127.0.0.1:3100'

STAGED="$(curl --fail-with-body --silent --show-error \
  -X POST "$BRIDGE_ORIGIN/api/workflow/carrier-redrive/stage" \
  -H "Authorization: Bearer $TEAMLEAD_API_TOKEN" \
  -H "Origin: $BRIDGE_ORIGIN" \
  -H 'Content-Type: application/json' \
  --data '{"runId":"RUN_ID","questionId":"QUESTION_ID","approvedHead":"40_HEX_HEAD","reason":"Lead-confirmed carrier redrive"}')"

jq -e '.ok == true and (.canonical | type == "object") and (.confirmToken | type == "string")' \
  <<<"$STAGED" >/dev/null

curl --fail-with-body --silent --show-error \
  -X POST "$BRIDGE_ORIGIN/api/workflow/carrier-redrive" \
  -H "Authorization: Bearer $TEAMLEAD_API_TOKEN" \
  -H "Origin: $BRIDGE_ORIGIN" \
  -H 'Content-Type: application/json' \
  --data "$(jq -c '{canonical, confirmToken}' <<<"$STAGED")"
```

不要手改 stage 返回的 `canonical`;apply 会重新计算 digest、复核当前批准 tuple,并消费一次性 `confirmToken`。

## SQL 手术的严格适用范围

仅当以下条件**全部**成立才可使用:

- Bridge 已挂死,无法执行上述 API;
- 该行是 legacy 三阶段 TURN:`target_run_id/target_node_id/target_attempt/activation_id` 全部为 `NULL`;
- 目标 runner 是同一 issue/shared worktree 的已知存活 legacy phase;
- 已记录预期旧 `(holder_exec_id, phase, epoch)` 与新 `(holder_exec_id, phase)`;
- 操作者能在 UPDATE 成功后立即执行配对 `flywheel-comm send`。

任何 engine-owned / activation-bearing 行都禁止手术。SQL 只能移动 belt,无法铸造 activation/output/submission credential;强行移动会让 runner 拿到 TURN 后在提交面得到 409。

## 前置取证

```sh
sqlite3 "$COMM_DB" ".headers on" ".mode box" \
  "SELECT issue_id, holder_exec_id, phase, epoch, granted_at,
          target_run_id, target_node_id, target_attempt, activation_id
     FROM three_stage_turn WHERE issue_id = '$ISSUE_ID';"

sqlite3 "$COMM_DB" ".headers on" ".mode box" \
  "SELECT execution_id, project_name, issue_id, lead_id, status
     FROM sessions WHERE execution_id IN ('$OLD_EXEC_ID','$NEW_EXEC_ID');"
```

确认目标行存在、旧 tuple 精确匹配、四个 engine 字段全为 `NULL`,并记录输出。

## exact-epoch CAS

不要把未解析的 shell 变量直接交给不可信输入。下列模板中的值必须先人工核对并替换为明确常量:

```sql
BEGIN IMMEDIATE;
UPDATE three_stage_turn
   SET holder_exec_id = 'NEW_EXEC_ID',
       phase = 'NEW_PHASE',
       epoch = epoch + 1,
       granted_at = CAST(strftime('%s','now') AS INTEGER) * 1000
 WHERE issue_id = 'FLY-XXXX'
   AND holder_exec_id = 'OLD_EXEC_ID'
   AND phase = 'OLD_PHASE'
   AND epoch = OLD_EPOCH
   AND target_run_id IS NULL
   AND target_node_id IS NULL
   AND target_attempt IS NULL
   AND activation_id IS NULL;
SELECT changes() AS changed_rows;
COMMIT;
```

`changed_rows` 必须严格等于 `1`;否则停止,重新 SELECT,不得放宽 WHERE。

## 配对唤醒(必做)

SQL commit 后立即写目标 runner 信箱;消息必须带新 holder/phase/epoch,并明确 `turn` 仍是唯一权限源:

```sh
node "$FLYWHEEL_COMM_CLI" send \
  --from flywheel-eng-lead \
  --to NEW_EXEC_ID \
  --project PROJECT_NAME \
  "[manual-turn-recovery FLY-XXXX epoch NEW_EPOCH] Legacy TURN was reassigned to NEW_EXEC_ID (NEW_PHASE). FIRST run flywheel-comm turn --exec-id NEW_EXEC_ID and proceed only on yours."
```

若 `send` 失败,此次恢复不算成功;保留 SQL 取证并升级 Lead,不得假设 runner 会自行轮询醒来。

## 后置取证

重复前置 `three_stage_turn` SELECT,确认 holder/phase/epoch 精确为新 tuple;再确认目标 runner 执行 `turn` 后产生了活动/回报。将前后 SELECT、UPDATE changes、instruction id 放入同一事故记录。

## 已知副作用(必须逐条接受)

1. SQL 不写 `turn_source_history/workflow_source_event`,因此没有 sourced-grant replay/audit 语义。
2. SQL 不写 StateStore activation-turn projection,跨账本校验对 engine-owned 形态会正确报 divergence。
3. SQL 本身不 unpark、不写 mailbox、不产生 wake receipt;漏掉配对 `send` 会复刻本事故。
4. SQL 绕过 worktree/head/liveness/terminal-attempt guard;目标选错可能让两个 runner 同时写 shared worktree。
5. 后续 Bridge reconcile 可以覆盖该行或删除它;这只是 Bridge 挂死时的 legacy 担架,不是持久的业务状态迁移。
