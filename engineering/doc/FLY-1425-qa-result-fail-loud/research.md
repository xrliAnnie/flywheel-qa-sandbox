# FLY-1425 qa-result fail-loud + 引擎层看门狗 — 调研

Issue: FLY-1425 (https://linear.app/geoforge3d/issue/FLY-1425/enginebug2-qa-result-凭据缺失静默回退-events-假成功-fail-loud-引擎层未消费看门狗)
日期: 2026-07-22
基于: exploration.md

## 1. 凭据发放的两条路(修 1 的 scope 必须都盖住)

| 路 | 发放点 | run.engine_owned | verdict 正道 |
|---|---|---|---|
| generalized engine(FLY-1407 事故路) | `workflow-engine-dispatcher.ts:1076-1089` rotate → `run-dispatcher.ts:1459` `req.generalizedExecution.submissionCredential` | 1 | `/api/workflow/decision`(engineCanonical 分支,消费凭据+推进节点) |
| three-stage shadow(claims 入册,FLY-1244) | `run-dispatcher.ts:1293-1301` `workflowClaimsAdmission.admit`(shareParentBranch + role=qa + shadowContext) | 0(shadow) | `/api/workflow/decision`(非 canonical 分支:消费凭据 + 落 claim + 驱动 PhaseOrchestrator) |

结论:**「被发过 submission credential」才是 fail-loud 的正确判据**,不是 engine_owned。shadow 路走 /events 虽然 PhaseOrchestrator 还能动,但凭据不消费 → claims 台账缺 qa_passed claim → claims_read_enrolled 的 gate 侧同样烂(FLY-1041 族问题)。两条路都必须禁止回退。

真正的 legacy(auto-QA 无 shadow、无凭据)runner:两个信号都没有,`/events` 行为逐字保留。

## 2. 修 1 落点验证(fail-loud 双闸)

### 2.1 客户端哨兵 env

- 注入点仅两处:`TmuxAdapter.execute()`(claude-tmux 共享路径,agy/kimi 子类继承同一段;TmuxAdapter.ts:447-452 旁)+ `CodexTmuxAdapter`(:1418-1420 旁)。条件与凭据注入完全一致(`ctx.workflowSubmissionCredential` 非空)→ 同时注入 `FLYWHEEL_WORKFLOW_SUBMISSION_EXPECTED=1`。
- 语义:「本 runner 曾被发放 submission credential;qa-result 无凭据即为异常」。名字刻意不叫 ENGINE_OWNED——见 §1。
- ctx 无需新字段(哨兵由凭据存在性推出),`adapter-types.ts` 零改动。
- env 注册:`packages/config/src/feature-flags/truth.ts` 加一行(audit 惯例,类别 plumbing)。
- **对抗性局限(诚实边界)**:runner `env -u` 连哨兵一起剥仍可绕过客户端闸——所以必须有 §2.2 服务端闸,那才是权威;哨兵只是让 90% 的错误在本地就红得明白。

### 2.2 服务端闸(/events 拒收)

- 落点:`event-route.ts` POST /events handler,`insertEvent`(:778)**之前**、限定 `event.event_type === "qa_result"`。误投的 verdict 不落 events 表(落了就会进 legacy 分支制造二次混乱)。
- 谓词(或):
  1. `store.isWorkflowEngineOwnedExecution(event.execution_id)`(已存在,StateStore.ts:15668)——engine-owned 无论凭据死活一律拒;
  2. reporting execution 存在**未消费且未撤销**的 submission credential(新 StateStore 只读小方法,`workflow_execution_binding` join `workflow_submission_credential`,单行查询)——盖住 shadow 路 + 「凭据还活着却绕道」的一切形态。
- 响应:`409 {ok:false, error:"workflow_submission_required", hint:"..."}`。409 与既有 /events 语义不冲突(teardown record 冲突同样用 409,event-route.ts:761)。
- 顺序注意:此 guard 在 dedup(insertEvent)之前,重复误投会重复 409——无害且正确(每次都该红)。

### 2.3 客户端重试语义(把 4xx 从盲重试里摘出来)

现状 qa-result.ts:162-192 对一切非 2xx 重试 4 次。改:
- 4xx(400/401/403/409;408/429 除外)= deterministic rejection → 立即停,打印 server 返回的 reason/hint,exit 1(仍写 fail-close marker,marker 里带 reason)。
- 5xx / 网络错 / 超时 → 维持现有 4 次退避 + fail-close marker,行为不变。
- 特例文案:409 且 reason=`replay_payload_mismatch` → 明确打印「verdict 已被更早的提交记录;这不是投递失败;禁止重提、禁止剥凭据;有疑问 ask Lead」。exit 仍非零(新 request_id 重复提交本身是异常流,该让上层看见),但话说透,消灭 `env -u` 邪方再生土壤。

## 3. 修 2 落点(日志诚实)

- `/api/workflow/decision` 2xx → 解析 body,只在 `ok:true` 时打印 `decision consumed (claimId=…, serverSeq=…, idempotentReplay=…)`——这才配叫 delivered。
- `/events` 2xx(仅 legacy 可达)→ 打印 `accepted by legacy /events (event stored; NOT a DAG decision)`。
- 所有失败打印 endpoint + HTTP status + body 里的 reason。

## 4. 修 3 落点(引擎层看门狗)

### 4.1 宿主与节奏

挂进 `WorkflowEngineDispatcher.reconcile()`(1s tick,零新 timer——与 alert outbox / divergence / dead-exec 同宿主)。内部用 `lastQaStallSweepAt` 节流到 **60s 一扫**(检测语义是分钟级,秒级只是烧 SQL)。kill-switch env `FLYWHEEL_QA_DECISION_WATCHDOG=0`(FLY-218/220 教训:检测类新代码给误报应急旁路;default ON)。

### 4.2 候选查询(新 StateStore 方法,纯 SQL)

```sql
SELECT n.run_id, n.node_id, n.attempt, n.execution_id,
       r.issue_id, r.project_name,
       c.id AS credential_id, c.issued_at, c.expires_at,
       s.status AS session_status
  FROM workflow_run_node n
  JOIN workflow_run r ON r.run_id = n.run_id
       AND r.engine_owned = 1 AND r.status = 'active'
  JOIN workflow_submission_credential c
       ON c.run_id = n.run_id AND c.node_id = n.node_id AND c.attempt = n.attempt
       AND c.consumed_at IS NULL AND c.revoked = 0
  LEFT JOIN sessions s ON s.execution_id = n.execution_id
 WHERE n.state = 'running'
```

- credential 只发给 qa/review 节点(family CHECK 约束)→ 节点类型天然限定,无需 snapshot 解析。
- scope 锁 engine_owned=1(issue 原文;shadow 三段式已有 PhaseOrchestrator/auto-QA 层的 reconcile,不重复)。

### 4.3 两档触发(候选逐个判)

| 档 | 谓词 | 检测延迟 | 盖住什么 |
|---|---|---|---|
| soft | session_status ∈ ZOMBIE_IRREVERSIBLE_TERMINAL_STATUSES **或** `isRunnerDeclaredParked(execId, projectName)`(event-route.ts:103 已有,提为共享 util),且该候选连续 stalled 观测 ≥ soft 窗口(默认 10min,env `FLYWHEEL_QA_DECISION_STALL_SOFT_MS`) | ~10-11min | FLY-1407 形态:runner 宣告干完(park/终态)、凭据没消费 |
| hard | `now > c.expires_at`(凭据 1h TTL 过期仍未消费) | ≤1h | 一切形态兜底:runner 活着装死、park 检测失灵、进程内窗口计时被重启清零…… |

- soft 窗口计时用进程内 `firstStalledObservedAt` map(与 dispatcher 现有 `unknownLivenessCounts` 同款模式);Bridge 重启丢计时只是推迟告警,hard 档持久兜底。恢复(凭据被消费/节点推进/候选消失)→ 清 map 项。
- comm.db 读(parked 判定)只对已过 SQL 筛的候选做,量级 ≈ 个位数。

### 4.4 告警动作(alert-only)

`enqueueWorkflowEngineAlert`,uid = `qa_decision_stalled:{run_id}:{node_id}:{attempt}`:
- `workflow_alert_outbox.escalation_uid` 是 PRIMARY KEY → **一个 attempt 终生一报**,结构性免疫 FLY-220 刷屏;
- payload:eventType `workflow_engine_escalation`(已有类型,sink 已接 owning Lead 解析 `resolveRunAlertIdentity`),severity severe,body 含:issue/run/node/attempt/exec、凭据状态(未消费 or 已过期)、runner 状态(parked/终态/未知)、是否存在孤儿 qa_result 事件(events 表按 execution_id 查,给 Lead 做证据)、修复动作提示(检查 QA thread;确认 verdict 后由 Lead 走 re-dispatch 或人工 decision)。
- **不自动 re-dispatch**:alive-parked 下重派 = 同节点双 runner(违反 exactly-one);dead 场景 dead-exec sweep 已有 retry 职责。**不自动代消费**:Bridge 无凭据 token,代签 = 伪造授权链。

### 4.5 与既有看门狗的互补矩阵(不重复)

| 失效层 | 谓词 owner | 动作 |
|---|---|---|
| pane 卡死 | session 层 LeadWatchdog/runner idle(FLY-83/92) | escalation |
| 进程死 + 节点无 completion | dead-exec sweep(FLY-1417) | 探活 → retry/hold/alert |
| node done + session 僵尸终态 | divergence check | 记录 divergence |
| **node running + 凭据未消费 + runner 宣告干完 / 凭据过期** | **本单看门狗** | **alert owning Lead** |

## 5. 修 4 落点(prompt 硬化,severable)

`Blueprint.ts:1586-1589` submission-credential 分支的 systemPromptLines 追加一句:凭据 env 必须原样存在于 qa-result 进程(禁止 `env -u` / 重开无继承 shell);409 replay_payload_mismatch = verdict 已记录,不是失败,禁止重提。

## 6. 被否掉的替代方案

1. **只做客户端哨兵、不做服务端闸** — 否。`env -u` 能剥凭据就能剥哨兵;权威闸必须在 Bridge(它有 DB ground truth)。
2. **服务端闸 key 在 engine_owned** — 否。shadow 三段式凭据路同样会被 /events 绕过消费(§1);key 在「凭据存在性」+「engine_owned」双谓词。
3. **看门狗自动 re-dispatch / 自动代消费** — 否。见 §4.4;alert-only,人(Lead)在环。
4. **看门狗用新 timer / 新表** — 否。dispatcher reconcile + alert outbox 全是现成的;唯一新增持久物是候选查询方法(只读)。
5. **把 409 replay_payload_mismatch 改成 200 duplicate** — 否(本单)。同凭据不同 request_id 的重提是异常流,200 会掩盖上游乱跑;先把话说透(§2.3),真有正当重提需求再单开 issue。
6. **qa-result 读 StateStore 直接判 engine-owned(绕过 env)** — 否。sql.js WASM 加载 + 只读打开 Bridge 库,重且有 FLY-663 损坏前科;env 哨兵 + 服务端闸已闭环。
