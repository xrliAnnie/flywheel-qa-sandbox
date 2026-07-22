# FLY-1425 qa-result fail-loud + 引擎层看门狗 — 实施计划

Issue: FLY-1425 (https://linear.app/geoforge3d/issue/FLY-1425/enginebug2-qa-result-凭据缺失静默回退-events-假成功-fail-loud-引擎层未消费看门狗)
日期: 2026-07-22
基于: research.md(修订依据:Codex design review R1,8 项反馈全部采纳或按事实裁定)

> **Founder correction（2026-07-22）**：本计划中的「引擎层 qa 未消费看门狗」整层已废除；最终交付只保留 fail-loud、幂等存储与日志诚实。权威边界见 `design-correction.md`，冲突处以该文件为准。

## 0. 一句话

engine-owned run 的 qa-result「凭据缺失→静默投 /events→假成功」改成客户端+服务端双闸 fail-loud;「delivered」只在真消费凭据后才打印;引擎图层补一只「qa 节点 running + 凭据未消费 + runner 宣告干完/凭据过期」的看门狗,alert-only 报 owning Lead,一个 episode 只报一次。

## 0.5 车道裁定(R1-BLOCKER-1/2 的核心决策)

凭据发放有两条路(research §1),但**多轮 verdict 合同只存在于 shadow 车道**:

| 车道 | verdict 生命周期 | fail-loud 闸 |
|---|---|---|
| generalized engine(engine_owned=1,FLY-1407 事故路) | **单 verdict / attempt**(Blueprint 注入原话「the accepted verdict is this node attempt's terminal fact」;retest = 引擎新 attempt + 新 execution + 新凭据,dispatcher rotate 路径) | **双闸全开**:客户端哨兵 + 服务端 /events 拒收 |
| three-stage shadow(engine_owned=0,claims 入册) | **多轮合法**:FLY-887 keep-alive 同一 QA session 多轮 verdict(FAIL→fix→wake retest),FLY-939 founder kickback;但 shadow 凭据只在物理 spawn 发一次、第一轮 /decision 消费后 round-2 必然 `replay_payload_mismatch` 409 → **今天 round-2 的实际投递路就是 /events**(env -u 邪方的真实起源) | **本单不闸**:/events 照旧;凭据多轮生命周期是 FLY-1244 的既有债务,follow-up 已建为 **FLY-1429**(建议:每 logical QA attempt 换物理 execution,或 wake 载荷带新凭据),本单不动 |

推论:服务端闸判据 = `isWorkflowEngineOwnedExecution(execution_id)`,**不含** live-credential 谓词(research §2.2-ii 撤销:live-only 对 shadow 车道会闸掉合法 round-2,ever-credentialized 更会永久封死;shadow 的凭据缺口只能靠生命周期修复,不能靠 /events 拒收硬压)。客户端哨兵**只注入 engine 车道**。

## 1. 总体架构

```mermaid
flowchart TB
    subgraph runner [QA Runner - engine-owned]
        QR[flywheel-comm qa-result]
    end
    subgraph bridge [Bridge]
        DEC["/api/workflow/decision<br/>消费凭据+推进节点"]
        EV["/events (legacy + shadow round-2)<br/>新增: engine-owned qa_result 拒收闸"]
        WD[WorkflowEngineDispatcher.reconcile<br/>新增: stalled-decision 看门狗 60s<br/>(在 dead-exec sweep 之后)]
        OB[(workflow_alert_outbox<br/>episode UID 一次一报)]
        LEAD[owning Lead 告警]
    end
    QR -- 有凭据 --> DEC
    QR -- "无凭据+有哨兵 → 本地红退 exit 1" --x QR
    QR -- "无凭据+无哨兵" --> EV
    EV -- "engine-owned → 409 不落库" --x QR
    WD -- "soft: parked/终态(探活=alive)≥10min<br/>hard: 凭据过期" --> OB --> LEAD
```

## 2. 改动清单(按包)

### 2.1 修 1a — 客户端哨兵(engine 车道,fail-loud 第一闸)

| 文件 | 改动 |
|---|---|
| `packages/core/src/adapter-types.ts` | 新可选字段 `workflowSubmissionExpected?: boolean`(engine 车道专属;shadow 车道不设) |
| `packages/teamlead/src/bridge/run-dispatcher.ts` | **两处** generalized context 组装都设 `workflowSubmissionExpected: true`:fresh/start 路(:1449-1461)**与 retry 路(:837-849)**(R2-3:generalized QA 的手动/恢复 retry 经 `actions.ts` → `retryDispatcher.dispatch()`,发新凭据,漏注哨兵则第一闸残缺);shadow admission 分支(:1293-1301)**不设** |
| `packages/edge-worker/src/Blueprint.ts` | ctx 透传该字段(:557 / :2590 两处旁) |
| `packages/claude-runner/src/TmuxAdapter.ts` | `ctx.workflowSubmissionExpected` 为真 → 注入 `FLYWHEEL_WORKFLOW_SUBMISSION_EXPECTED=1`(claude/agy/kimi 共享路径,:447-452 旁) |
| `packages/claude-runner/src/CodexTmuxAdapter.ts` | 同上(:1418-1420 旁) |
| `packages/flywheel-comm/src/commands/qa-result.ts` | 哨兵严格 `=== "1"` 且 credential 缺失 → 红错(指名 env 被剥的可能与 env -u 反模式)+ exit 1,**不发任何请求** |
| `packages/config/src/feature-flags/truth.ts` | 注册 `FLYWHEEL_WORKFLOW_SUBMISSION_EXPECTED`(plumbing/context) |

### 2.2 修 1b — 服务端闸(权威闸,engine 车道)

| 文件 | 改动 |
|---|---|
| `packages/teamlead/src/bridge/event-route.ts` | POST /events:`event_type==="qa_result"` 且 `store.isWorkflowEngineOwnedExecution(event.execution_id)` → `insertEvent`(:778)**之前** 409 `{ok:false, reason:"workflow_submission_required", hint:…}`,事件不落库。字段名锁 **`reason`**(R2-1:与 /decision 的 `{ok:false, reason}` 合同统一,客户端分类器才读得到);客户端解析器兼容 `reason ?? error` 防旧形态 |

(R1-2 裁定:不加 live/ever-credentialized 谓词,理由见 §0.5。)

### 2.3 修 1c + 修 2 — 客户端按 reason 分类与日志诚实(两车道共享,行为向后安全)

`packages/flywheel-comm/src/commands/qa-result.ts`:

1. **按 response body reason 分类,不按 HTTP class 一刀切**(R1-7 + R2-4 + R3-3):分类做成**纯函数** `classifyQaResultRejection(reason)`。**合同定性(R3-3 选 B):/decision 的 reason 是开放集合**(路由会把捕获的 Error.message 透传进 reason),所以这不是穷举,而是「**已知稳定 reasons 显式分类 + unknown fallback**」;对下列已知清单做全覆盖测试:
   - deterministic fail(立即停,不重试):`workflow_submission_required` / `credential_not_found` / `credential_revoked` / `credential_expired` / `credential_receipt_corrupt` / `invalid_request` / `invalid_status` / `invalid_client_head` / `invalid_timestamp` / `head_authority_mismatch` / `replay_payload_mismatch` / `not_durable_qa_execution` / `predicate_not_allowed` / `binding_not_current` / `same_vendor_review` / `missing_subject_producer` / `node_does_not_emit_decisions` / `decision_family_mismatch` / `materialized_head_invalid` / `materialized_output_mismatch` / `materialized_producer_ambiguous`(歧义是结构性的)/ `execution_not_found` / `worktree_not_found` / `invalid_git_head` / `run_not_found` / `transition_refused`。
   - 保留 bounded retry(现有 4 次退避):5xx、网络/超时、408/425/429、可恢复的 authority/readiness reasons(`materialized_head_unavailable` / `materialized_run_snapshot_unavailable` / `materialized_review_node_unavailable` / `materialized_producer_unavailable` / `execution_runtime_unavailable` / `producer_runtime_unavailable` / `head_unavailable` / `git_head_unavailable` / `decision_authority_unavailable` / `invalid_server_clock`)、**`producer_not_found`**(R2-4 裁定:predecessor materialization 刚完成的竞态窗口可自愈,与 `producer_runtime_unavailable` 同类)、以及**一切未知 reason**(reverse-compatible 缺省——unknown→retry 是安全阀,文档与测试不得声称穷举)。
   - deterministic fail 同样写 fail-close marker(marker 含 reason),exit 1。解析器读 `reason ?? error`。
2. `replay_payload_mismatch` 专属文案(措辞按 R1-7 修正):「凭据已被另一次提交消费;**不能证明你当前这份 verdict 已落账**(先前记录的可能是不同结论);停止重试、禁止剥凭据,把两份结论报给 Lead 裁定」,exit 1。
3. 成功判定收紧(R1-7 + R2-4):**两个端点** 2xx 都必须 JSON 解析成功且 `ok === true` 才算成功;decision 路还要校验 `claimId`/`serverSeq` 基本形状(数值)后才打印 consumed(杜绝畸形 `{ok:true}` 打出 `claimId=undefined` 的假诚实日志);否则按失败路径处理。
4. 成功输出诚实两分支:
   - decision 路:`decision consumed (claimId=… serverSeq=… idempotentReplay=…)`;
   - /events 路(legacy/shadow round-2 可达):`accepted by /events (event stored; NOT a DAG decision)`。

### 2.4 修 3 — 引擎层看门狗(stalled-decision sweep)

**候选查询**:`packages/teamlead/src/StateStore.ts` 新只读方法 `listWorkflowStalledDecisionCandidates()`:

```sql
SELECT n.run_id, n.node_id, n.attempt, n.execution_id,
       r.issue_id, r.project_name,
       c.id AS credential_id, c.issued_at, c.expires_at,
       n.started_at AS node_started_at,
       s.status AS session_status,
       s.terminal_at AS session_terminal_at
  FROM workflow_run_node n
  JOIN workflow_run r ON r.run_id = n.run_id
       AND r.engine_owned = 1 AND r.status = 'active'
  JOIN workflow_submission_credential c
       ON c.run_id = n.run_id AND c.node_id = n.node_id AND c.attempt = n.attempt
       AND c.execution_id = n.execution_id
       AND c.consumed_at IS NULL AND c.revoked = 0
       AND c.family = 'qa_verdict'
  LEFT JOIN sessions s ON s.execution_id = n.execution_id
 WHERE n.state = 'running'
   AND NOT EXISTS (
       SELECT 1 FROM workflow_alert_outbox o
        WHERE o.escalation_uid = 'qa_decision_stalled:' || n.run_id || ':'
              || n.node_id || ':' || n.attempt || ':' || n.execution_id || ':' || c.id
   )
 ORDER BY c.expires_at, n.run_id, n.node_id, n.attempt
 LIMIT ?
```

**公平扫描**(R3-1,防 200 上限饿死后续候选):
- SQL 内嵌 `NOT EXISTS` 把已告警 episode 直接移出结果集(与 `listWorkflowDivergenceCandidates` 的 progress predicate 同理——告警即离场);
- 方法签名 `listWorkflowStalledDecisionCandidates(limit, afterKey?)`,keyset 分页 + dispatcher 持 round-robin cursor(`stalledDecisionCursor`,页空即重置)——照抄本文件现成的 `listActiveWorkflowDeadExecutionWatches(200, cursor)` 模式,「前 200 个未到窗口的占位候选」不再阻塞后续 parked/hard 候选;
- 测试:201 个候选、前 200 个不命中/已告警时,第 201 个 parked/hard 候选在有界轮数内被检查并入队。

(R1-8:锁 `family='qa_verdict'`——issue/验收/文案全是 QA,review_verdict 车道后续单开;加稳定 ORDER BY;`c.execution_id = n.execution_id` 保证 dead-exec replacement 换 execution 后旧凭据行自动出候选。R2-2:**`LEFT JOIN sessions`**——session 行缺失时 hard tier 仍必须命中(兜一切形态),soft terminal tier 仅在 `session_status`/`session_terminal_at` 都有效时参与;terminal 锚列名已核实为 `sessions.terminal_at`(StateStore.ts:1330-1338)。)

**parked 读取器重构**(R1-4 + R3-2):`isRunnerDeclaredParked`(event-route.ts:103)提取为共享 tri-state helper `readRunnerDeclaredParkState(execId, projectName) → { kind: "parked"|"not_parked"|"unknown", updatedAtMs?: number }`:
- event-route 原 wrapper 语义字节不变(unknown → 继续 veto);
- 看门狗:**unknown → defer(不告警)**——comm.db 损坏/锁死绝不能翻译成「runner 声明了 park」引发 fleet burst。

**时间规范化**(R3-2,三种锚两套表示必须统一):CommDB `runner_declared_states.updated_at` 是 epoch-ms INTEGER;`workflow_run_node.started_at` / `sessions.terminal_at` 是 SQLite UTC text;credential 时间是 ISO text。合同:**一切锚统一转 epoch ms** 再比较——SQLite text 复用 dispatcher 已导入的 `parseSqliteUtcMs()`(兼容 ISO),CommDB 原生 number 直取;每个锚验 finite 且 non-future,**任一必要锚无效 → soft tier defer**;hard tier 只依赖验证过的 `expires_at`。测试喂 SQLite text / ISO / epoch-ms / invalid / future 混合值 + Bridge 非 UTC 时区场景。

**sweep 逻辑**:`packages/teamlead/src/bridge/workflow-engine-dispatcher.ts` 新私有 `reconcileStalledDecisions()`:
- 位置:`reconcile()` 中 **`reconcileDeadExecutions()` 之后**(R1-5:让 dead-exec 先做 retry/replacement,本 sweep 拿到的是它处理后的余量);60s 节流(`lastQaStallSweepAt`);kill-switch OFF 整段旁路。
- 每候选判定(先 hard 后 soft):
  - **hard tier**:`now > c.expires_at` → 命中(凭据 1h TTL 过期仍未消费,兜一切形态)。
  - **soft tier**:先取 durable 信号锚——
    - parked:`readRunnerDeclaredParkState` = parked,锚 = 其 `updatedAtMs`;
    - 终态:`session_status ∈ ZOMBIE_IRREVERSIBLE_TERMINAL_STATUSES`,锚 = `session_terminal_at`(两者任一无效则该候选不走 terminal 分支;R2-2),**且 `probeLaunchLiveness` = alive 才算**(R1-5:dead → dead-exec sweep 的 retry 职责;unknown → probe_unknown 告警已 own,skip);
    - 窗口起点 = `max(node.started_at, credential.issued_at, 信号锚)`,持续 ≥ `FLYWHEEL_QA_DECISION_STALL_SOFT_MS` → 命中。**无进程内计时 map**(R1-4:全 durable 锚,Bridge 重启零损失)。
- 命中 → **enqueue 前 re-validate 全部 authority 谓词**(R1-5 + R2-2):重读 run(仍 `engine_owned=1 AND status='active'`)+ node(execution_id 未变、state 仍 running)+ 同 credential id(仍 qa_verdict / 未消费 / 未撤销)→ 任一有变即 skip。
- **episode 一报**(R1-3):UID = `qa_decision_stalled:{run_id}:{node_id}:{attempt}:{execution_id}:{credential_id}`;payload 从候选行**冻结构建**(episode-stable 字段:issue/run/node/attempt/exec/credential_id/tier-of-first-detection/runner 状态/孤儿 qa_result 查证/修复提示);enqueue 前先查 outbox 是否已有该 UID(新只读 `hasWorkflowAlert(escalationUid)`,单行 SELECT)→ 已有即 skip(soft 先中后 hard **不再二次报**;同 episode 重复 sweep 幂等,结构性杜绝 `workflow_alert_uid_conflict`)。
- payload 走 `enqueueWorkflowEngineAlert`,eventType `workflow_engine_escalation`,severity severe,投递复用现成 outbox → alertSink → owning Lead。

**类型合同**(R1-3):`WorkflowEngineAlertPayload` disposition union(StateStore.ts:22593-22617)+ `LeadAlertNotifier` `AlertMetadata` disposition union(:356-370)加 `qa_decision_stalled`,含各自 wiring 测试。

**配置注册**(R1-6):
- `FLYWHEEL_QA_DECISION_WATCHDOG` → `packages/config/src/feature-flags/registry.ts` 正式 **kill_switch**(default-on、Bridge-global、call-time 读取,模式照抄 `FLYWHEEL_ENGINE_DEAD_EXEC_SWEEP` :1627-1648),加同实例 OFF↔ON 直证测试;
- `FLYWHEEL_QA_DECISION_STALL_SOFT_MS` → truth.ts numeric tuning knob:finite parse,clamp [60_000, 86_400_000],无效值回默认 600_000;
- `FLYWHEEL_WORKFLOW_SUBMISSION_EXPECTED` → truth.ts(plumbing),仅 `=== "1"` 生效。

### 2.5 修 4 — prompt 硬化(severable)

`packages/edge-worker/src/Blueprint.ts`(:1586-1589 submission 分支)追加一行:凭据 env 必须原样带着跑 qa-result(禁止 env -u / 无继承 shell);收到 `replay_payload_mismatch` = 凭据已被更早提交消费,停止重试并报 Lead。

### 2.6 follow-up issue(本单开单不实现;已建 **FLY-1429**,PR body 必须引用,R2-5)

shadow 三段式多轮 verdict 的凭据生命周期(FLY-1244 债务;follow-up **FLY-1429**):round-2+ 无新凭据可消费,今天 CLI 带凭据会 409(`replay_payload_mismatch`),/events 只是 workaround 落点、claims 台账缺 round-2 claim。两个可验收方向:① 每 logical QA attempt 换物理 execution 拿新票(该 lane 放弃 QA in-place keep-alive);② wake 载荷安全携带新凭据(需 restart-safe reissue + attempt binding + 运行中进程 secret 交付设计)。owner = Flywheel Eng(Tadashi 分派)。FLY-1429 已引用本文档 §0.5 的边界。

## 3. 不变式(reverse-compat)

1. legacy runner(无凭据无哨兵无 binding):qa-result 走 /events,exit code 语义不变(仅输出措辞更诚实)。
2. shadow 三段式(engine_owned=0):/events 路径逐字保留(round-1 有凭据走 /decision 不变;round-2 /events 不变)。
3. /events 对非 qa_result 事件、非 engine-owned qa_result:逐字节不变。
4. `/api/workflow/decision`:零改动。
5. 看门狗只扫 `engine_owned=1 AND status='active' AND family='qa_verdict'`;kill-switch OFF 时 dispatcher 行为字节回退。
6. 无 schema migration(零新表新列;新增 StateStore 方法均只读)。
7. event-route 的 parked veto 语义(unknown→veto)字节不变(重构只是提取 helper)。

## 4. 测试计划(TDD,顺序 = 实现顺序)

### Phase A — 合同测试先行(R1-8 顺序)
1. **three-stage 兼容双测**(R1-1 防护,R2-5 拆名——两条测试各自诚实命名,不宣称 credential transport 已修复):
   - *guard-compatibility test*:**直接 POST /events** 构造 shadow(engine_owned=0)round-2 verdict(显式模拟既有 workaround / legacy producer 形态)→ 200 照旧落库、PhaseOrchestrator 驱动、**不被新闸拦截**;
   - *orchestration regression*:现有 PhaseOrchestrator 多轮(FAIL→fix→wake retest;founder kickback)编排回归,验证本单零改动不破——**不经 CLI 自然路径断言 round-2 投递**(现状 CLI 带凭据会 409,那正是 §2.6 follow-up 的债务)。
2. event-route 闸:engine-owned qa_result → 409(body `reason="workflow_submission_required"`)+ events 表零行;shadow(engine_owned=0)qa_result → 200 照旧;legacy → 200 照旧;非 qa_result 不受影响(reverse-compat sentinel)。
3. outbox episode 合同:同 episode 重复 sweep 零新行零异常;soft 后 hard 不二次报;dead-exec replacement(同 attempt 新 execution+新凭据)构成**新 episode** 可再报;`hasWorkflowAlert` 五态。

### Phase B — 实现随测
4. qa-result:哨兵+无凭据 → exit 1 且 fetch 零调用;哨兵非 "1" 不触发;reason 分类纯函数**已知稳定清单全覆盖 + unknown fallback**(deterministic 全清单立即停 / retryable 全清单保留 4 次 / 未知 reason 重试 / `reason ?? error` 兼容;不声称穷举,R3-3);replay 文案;两端点 2xx 非 JSON / ok!==true / decision 缺 claimId·serverSeq 形状 → 失败路径;成功输出两分支;5xx 回归。
5. adapter 哨兵注入:TmuxAdapter / CodexTmuxAdapter 各一(有 expected 注入、无不注入);run-dispatcher **三分支**(fresh generalized 设 / **retry generalized 设**(R2-3)/ shadow 不设),retry-dispatcher 合同测试验证最终 adapter env。
6. StateStore:候选查询(engine/shadow/legacy/已消费/已撤销/family=review 排除/execution 换代出候选/ORDER BY 稳定/**session 行缺失但凭据过期仍出候选**(R2-2)/**run held·terminated 不出候选**/**已告警 episode 被 NOT EXISTS 移出结果集**/**201 候选公平性:keyset cursor 有界轮数内触达第 201 个**(R3-1))。
7. dispatcher sweep:hard 命中(含 session 行缺失场景);soft parked 命中 / 终态+alive 命中 / 终态+dead skip / 终态+unknown skip / parked-unknown defer / terminal_at 缺失不走 terminal 分支 / 未到窗口不报;**时间锚混合格式**(SQLite text / ISO / epoch-ms / invalid / future,非 UTC 时区,R3-2);durable 锚跨重启(构造 now 推进)仍按真实持续时间告警;re-validate 全谓词拦截(run 不再 active / node 换 execution / 凭据被消费 各一);kill-switch OFF↔ON 同实例直证;60s 节流。
8. 类型合同:WorkflowEngineAlertPayload / LeadAlertNotifier metadata wiring。

### Phase C — 集成 + 真机
9. 假 store+假 sink 全链:候选 → outbox → sink 收到 workflow_engine_escalation,payload 字段齐全。
10. FLY-1407 重放:qa node running + credential 未消费 + comm.db parked → 窗口后**恰一条**告警;告警后注入凭据消费 → 候选消失。
11. 真机隔离房 E2E(验收原文 + R1-8 增强):
    - 剥凭据跑 qa-result(留哨兵→客户端闸红退;连哨兵剥→服务端 409)→ 非零退出 + 明确报错 + **Bridge events 表零新行 + credential 仍未消费 + node 仍 running**;
    - 注入「qa 干完没上报」→ 窗口过期后 owning Lead 收到告警、outbox 状态 sent、**只报一次**(重复 sweep + Bridge 重启跨窗口两个场景)。
    - E2E 用受控低阈值(`FLYWHEEL_QA_DECISION_STALL_SOFT_MS` 合法下限 60s)。

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| 闸误伤 three-stage round-2 合法 verdict | §0.5 车道裁定:闸只认 engine_owned;Phase A-1 多轮回归铁包 |
| comm.db 损坏/锁死 → parked 误报 fleet burst | tri-state helper,watchdog unknown→defer(veto 语义只留给 event-route 原用途) |
| outbox uid_conflict 异常 | episode UID(含 exec+credential)+ 冻结 payload + enqueue 前 hasWorkflowAlert 查重 |
| 与 dead-exec sweep 打架 | 顺序锁死(dead-exec 后)+ 终态候选需探活 alive + enqueue 前 re-validate + unknown 让位 probe_unknown |
| 看门狗误报(QA 合法长跑) | soft 只认「宣告干完」durable 信号;hard 以凭据 TTL 为准 |
| 检测类新代码需应急旁路 | registry 正式 kill_switch(fail-loud 双闸**刻意不给**旁路——静默回退本身就是 bug) |
| 4xx 一刀切砍掉竞态恢复 | 按 reason 分类,未知 409 默认重试(reverse-compatible) |

## 5.5 实现提示(Codex R4 非阻塞,实现时保持字节一致)

- helper 字段统一 `updatedAtMs`(实现与测试同名)。
- keyset `afterKey` 必须包含完整 ORDER BY tuple(`expires_at, run_id, node_id, attempt`)并用同序严格 lexicographic 谓词(`workflow_run_node` 主键 + live-credential 唯一索引保证可稳定分页)。
- decision ack 打印 `idempotentReplay` 时顺手验证其为 boolean。

## 6. 交付边界

- 本单不做:自动 re-dispatch、自动代消费、孤儿 qa_result 自动收养、409→200 duplicate 语义改造、shadow 车道凭据多轮生命周期(→ §2.6 follow-up)、review_verdict 车道看门狗(后续)。
- 修 4(prompt 硬化)可独立砍,不影响 1-3。
