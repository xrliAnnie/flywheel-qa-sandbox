# FLY-1425 qa-result fail-loud + 引擎层看门狗 — 探索

Issue: FLY-1425 (https://linear.app/geoforge3d/issue/FLY-1425/enginebug2-qa-result-凭据缺失静默回退-events-假成功-fail-loud-引擎层未消费看门狗)
日期: 2026-07-22
基于: 无

## 1. 问题是什么(founder 原话)

> 「Runner 根本没有告诉引擎 QA 已经跑完,导致后面所有的这一套都不 work。那最根本的原因还是:为什么 Runner 没有告诉引擎呢?」

FLY-1407 当晚实证:QA runner 把 verdict 投错了端点(`/events` 而不是 `/api/workflow/decision`),两条路都返回 200、都打印「delivered」,但只有 decision 端点会消费凭据并推进 DAG。结果 qa 节点 `running` 卡了 1.5h+,零报警;带凭据重跑立刻消费+推进(06:41:11)。

founder 追问「看门狗不是已经加了吗?」——答案:**已有看门狗全部盯在 session/终端层**(pane 10min 不动 → runner_stuck_escalation;auto-QA pipeline → auto_qa_stuck;进程死 → dead-exec sweep),**没有任何一只盯引擎图层**的「qa 节点 running + 凭据未消费 + runner 已经宣告干完」这个组合。本单补的就是这只。

## 2. 代码实证(2026-07-22,本 worktree HEAD ee2bf78f)

### 2.1 双路由静默回退(直接病灶)

`packages/flywheel-comm/src/commands/qa-result.ts:140-152`:

```ts
const submissionBody = workflowCredential ? {credential, ...} : body;
const endpoint = workflowCredential
    ? `${bridgeUrl}/api/workflow/decision`   // 消费凭据 + 推进节点
    : `${bridgeUrl}/events`;                 // legacy 通用端点,200 但不推进 DAG
```

- 凭据来自 env `FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL`(TmuxAdapter.ts:447-452 / CodexTmuxAdapter.ts:1418-1420 注入)。
- **env 变量一旦被剥(FLY-1407 的 `env -u` 记忆方子)客户端无从察觉自己是 engine-owned run**——没有第二个哨兵信号。
- 两条路 2xx 时打印同一句 `[qa-result] ... verdict delivered ...`(qa-result.ts:174-176)+ exit 0。**「delivered」在 /events 路是谎言**:对 engine-owned run,/events 只是把事件存进 events 表,然后落进 legacy 三段式/auto-QA 分支(event-route.ts:808-852),DAG 节点纹丝不动。

### 2.2 `env -u` 邪方的根源诱因(409 语义)

`StateStore.submitWorkflowDecisionByCredential`(StateStore.ts:18082-18100):凭据已消费时——
- 同 client_request_id + 同 digest → `idempotentReplay: true`,200。
- **新 client_request_id(qa-result 每次调用 `randomUUID()` 重新生成 event_id)→ `replay_payload_mismatch` → 409**。

即:verdict 已成功记录后重跑 qa-result 必然 409。Runner 把 409 误读成失败,发明了「剥凭据走 /events 就 200」的方子(memory 里已有「qa-result 连返 409 = verdict already recorded 非故障」的教训条目,但提示词层没有拦住)。**fail-loud 后这条邪路必须变成硬报错,同时 409 场景的输出要把话说透,消灭再犯的土壤。**

### 2.3 现有看门狗为什么全部漏过(结构性证明)

引擎侧唯一的周期机制是 `WorkflowEngineDispatcher.reconcile()`(1s tick,workflow-engine-dispatcher.ts:192-274),里面已有:

| 机制 | 谓词 | 为什么漏过 FLY-1407 |
|---|---|---|
| `reconcileDeadExecutions`(dead-exec sweep, FLY-1417) | node running + session ∈ zombie 终态 + 无 completion → 探活 → dead 才 retry/alert | 两条 skip 路径:① session 终态但 **runner pane 还活着**(parked keep-alive)→ `liveness !== "dead"` → continue(line 518);② 有 completion 记录 → 直接 skip(line 456-464) |
| `reconcileWorkflowDivergence` | node **done** + session zombie 终态 | 只看 done 节点,与「node 卡 running」正交 |
| dead-exec tripwires | 已判死的 exec 又有活动迹象 | 前提是先判死,parked-alive 到不了这一步 |
| session 层 pane watchdog(FLY-83/92 系) | pane 10min 不动 | QA runner 干完活 pane 正常收尾/park,不算 stuck;FLY-1407 当晚唯一 session_stuck 反而是 1375 做完 QA 的误报 |

关键事实:**generalized qa/review 节点不跑 `complete`**(Blueprint.ts:1586-1589 注入的指令原话:「Do not run `complete`; the accepted verdict is this node attempt's terminal fact」)——节点推进唯一依赖 decision 凭据消费。runner 宣告干完(park 或 session 终态)而凭据未消费,就是「QA 跑完了但引擎不知道」的精确机器可读形态,而这个组合今天没有任何谓词覆盖。

### 2.4 可复用的现成基建(不重造轮子)

- **告警外发**:`workflow_alert_outbox`(escalation_uid **PRIMARY KEY** → 天然一次一报,FLY-220 教训免疫)+ `enqueueWorkflowEngineAlert` + `reconcileWorkflowEngineAlerts` 租约投递到 alertSink(`workflow_engine_escalation` 事件类型已有,dead-exec probe_unknown 在用)。
- **engine-owned 判定**:`store.isWorkflowEngineOwnedExecution(executionId)`(StateStore.ts:15668)已存在——服务端闸直接用。
- **parked 判定**:`isRunnerDeclaredParked(execId, projectName)`(event-route.ts:103-121,读 comm.db declared state,fail-closed)已存在。
- **凭据台账**:`workflow_submission_credential` 表有 `consumed_at / revoked / expires_at(1h TTL) / absolute_deadline_at(24h)`,且 family 天然限定 qa_verdict/review_verdict——候选查询纯 SQL。
- **进程内计数模式**:dispatcher 的 `unknownLivenessCounts`(连续 3 次才报)是 soft 窗口去抖的现成同款模式。

## 3. 失效模式全景(本单要补哪几块)

| 失效形态 | 现有覆盖 | 本单动作 |
|---|---|---|
| runner 剥凭据投 /events(假成功) | ❌ 200 + 「delivered」 | 修1 fail-loud(客户端哨兵 + 服务端闸) |
| 「delivered」谎报 | ❌ | 修2 日志诚实 |
| runner 宣告干完(park/终态)但凭据未消费 | ❌ 零报警 | 修3 看门狗 soft tier |
| 任何原因导致凭据过期(1h)仍未消费、节点还 running | ❌ 零报警 | 修3 看门狗 hard tier(兜一切形态) |
| 409 replay_payload_mismatch 被误读成失败 | ❌(诱因) | 修1 客户端 4xx 不盲重试 + 把话说透;修4 prompt 硬化 |
| pane 卡死不动 | ✅ session watchdog | 不碰 |
| 进程死 + 无 completion | ✅ dead-exec sweep retry | 不碰 |

## 4. 边界(本单不做什么)

- **不自动 re-dispatch / 不自动代消费凭据**:alive-parked 场景重派会造成同节点双 runner(违反 exactly-one 纪律);Bridge 代消费绕过凭据授权链。看门狗 alert-only,把可行动的上下文给 owning Lead。
- **不动 legacy 三段式 auto-QA 的 /events 路径**:无凭据、无 engine binding 的 legacy QA runner 行为逐字不变(reverse-compat sentinel 测试保)。
- **不做孤儿 qa_result 事件的自动收养**:fail-loud 落地后 misroute 不再发生,历史孤儿由 Lead 按告警里的证据人工处置。
