# FLY-1385 死 exec 永久楔死 DAG node — 探索
Issue: FLY-1385 (https://linear.app/geoforge3d/issue/FLY-1385/bugdag引擎-死-exec-永久楔死-node失败无-completion-receipt-teardown-held-node-卡)
日期: 2026-07-20
基于: 无

## 1. 问题一句话

DAG 引擎的 node 一旦其 execution 死亡且没有 explicit completion receipt,node 永久卡 `running`:引擎不重试、失败事件被 held 吞掉、Lead 无 API 杠杆,且 run 的 `active` 状态占住 one-active-run 锁把整个 issue 楔死。2026-07-20 夜 batch-3 两单(FLY-1335 / FLY-1356)从两条独立路径同时踩中,停摆 ~1.5h,最终靠手工 `UPDATE status='held'` DB 手术解锁。

## 2. 代码级机制复核(本次审计逐条核实)

Issue 描述的 4 条机制全部成立,其中 2 条经代码审计后有精修(比 issue 描述更糟)。

### 2.1 held teardown:失败事件被吞,session/node 双双不落账

`DirectEventSink.emitFailed()`(`packages/teamlead/src/DirectEventSink.ts:1115-1125`):engine-enrolled execution 失败时,先查 `observeEnrolledTeardown()`;无 completion receipt ⇒ `held:true` ⇒ **直接 return** —— 不 insert `session_failed` 事件、不 upsert session 终态、不回滚 node。`emitCompleted()`(`DirectEventSink.ts:505-515`)与 HTTP 侧 `event-route.ts:663-692`(session_completed 非 flywheel-comm 源 + session_failed 两个分支)是同款 held → 409/early-return。

`observeEnrolledTeardown`(`StateStore.ts:15584-15620`)只做二元判断:有 receipt ⇒ 投影 completed;无 receipt ⇒ 记 `generalized_teardown_hold` run event 后 hold。**没有任何出口条件**(session 已 terminal、进程已死、held 时长,都不看)。

### 2.2 reconcile 结构性看不见死 exec(比 issue 描述更糟)

Issue 说"每轮 reconcile 都把死 exec 重新 markStarted"。实际更糟,分两个子形态:

- **子形态 A(FLY-1335 实际形态):`started` 的 intent 根本不在 reconcile 名单里。** `listNonTerminalWorkflowSideEffects()`(`StateStore.ts:18128-18137`)只回 `state IN ('intent_recorded','launch_committed')`。dispatch ledger 状态机(`StateStore.ts:18540-18550`)明文:`started` 是 terminal,"Rows record launch HISTORY, not liveness"。exec 正常启动后 23min 变 zombie ⇒ intent 早已 `started` ⇒ 引擎对它**零感知**,不存在"每轮重新 markStarted",是彻底失明。
- **子形态 B(恢复窗口形态):`consume()` 的 getSession 检查不看 status。** `workflow-engine-dispatcher.ts:199-202`:`if (store.getSession(intent.execution_id)) { markStarted; return true }` —— 对 `intent_recorded/launch_committed` 的 intent,只要 session row **存在**(哪怕 status=failed/blocked)就 markStarted 判定 in-flight。同款检查在 `:328-331`(committed 分支)重复。

另:启动期安全网 `holdStrandedGeneralizedExecutions()`(`StateStore.ts:15221-15255`)对 engine_owned=1 的 run **整体跳过**,注释理由是"WorkflowEngineDispatcher 会从 durable dispatch outbox 恢复"——该前提对子形态 A 为假(outbox 已不含 started intent)。安全网的假设被状态机断言推翻。

### 2.3 session 终态由 FSM 旁路写入,与引擎账本脱钩(FLY-1335 链路闭合的关键)

zombie 声明(`HeartbeatService.declareZombie()`, `HeartbeatService.ts:1341-1450`)走 `applyTransition(execId, "failed")` —— `applyTransition.ts:42-83` 经 FSM 校验后 `persistTransition` **直写 session status**,完全不经过 DirectEventSink/event-route 的 teardown hold。于是形成分裂账本:**session row = failed(terminal),workflow_run_node = running,dispatch intent = started**。三个账本各说各话,没有任何 reconcile 把它们对齐。

### 2.4 补 receipt 的路也堵死(机制 3,已核)

`flywheel-comm complete --route blocked` → Bridge `/events` source=flywheel-comm → `commitEnrolledCompletion(route:"blocked")`(`event-route.ts:625-646`)。而 node 的 `completion_route` 能力只允许 `phase_design_complete | needs_review | no_code`(`workflow-run-snapshot.ts:257-261`)⇒ 必然 `route_mismatch` ⇒ 409 `workflow_completion_rejected`。fail-close marker 落 `~/.flywheel/state/complete-failed/`,replayer 重放同样 409,永久循环。即使 route 对,FSM 对已 terminal session 的再转移也会拒。

### 2.5 无 run/node 级管理杠杆(机制 4,已核)

`runs-route.ts` 只有 `POST /start`(:213)和 `GET /active`(:1787)。无 hold/cancel/retry/finalize。重复 POST /start 被两道闸拒:
- engine 路径:`resolveWorkflowTemplateSelection` → `workflow-template-selection.ts:193-198` 对**任何** active run(不分 engine_owned/entry_kind)抛 `active workflow run reconciliation hold` → 409 `GENERALIZED_WORKFLOW_REJECTED`。
- DAG 标记 run 路径:`runs-route.ts:822-924` 的 `DAG_RUN_ACTIVE`/recovery 域(只认 `entry_kind === "pipeline_dag_v1"`)。

run status 唯三写点:`held`(loop-limit escalation,`StateStore.ts:16166`)、`completed`(founder source terminal,`:17178`;shadow finalize op,`:18449`)。**没有任何路径能把死 exec 的 run 从 active 挪走** —— 手工 UPDATE 借用的正是 loop-limit 的 `held`(语义=停给人裁),语义借对了,但那是 DB 手术不是产品能力。

### 2.6 影子 run 永久占锁(FLY-1356 变体,已核)

legacy 三段(engine_owned=0)由 `WorkflowShadowWriter`(`bridge/workflow-shadow-writer.ts`)镜像记账,自述"observation-only, production flow unaffected"(`:224`)。但它 materialize 的 run 是同一张 `workflow_run` 表、status=active、entry_kind=null:
- `onDispatchFailed`(`:419-470`)对 pre-commit 失败只把 ledger row 记 `abandoned`,**不动 node state、不动 run status**;
- 唯一 finalize 点是 `onShipFinalized`(T9,`:393-408`)—— ship 成功才收账。legacy belt 半路死掉(FLY-1356:连续 4 个 ordinal 全 `worktree_takeover_failed` 后 abandoned)⇒ run 永久 active;
- 该 active run 恰好落进 2.5 的 selection 闸(`:193` 不分 engine_owned)⇒ **观察性账本反向楔死生产双路**(legacy 重派与 DAG 新 run 全被 409)。

### 2.7 顺带:worktree takeover 的 startPoint 是冻结记录(机制 5,已核,行号修正)

takeover 判定在 `Blueprint.ts:1179`(issue 写 :847 已漂移):`!clean || !ctx.startPoint || head !== ctx.startPoint` ⇒ `worktree_takeover_failed`。engine 派 implement/qa 时 `startPoint` 来自 `resolvePredecessorHead` → `resolveWorkflowHeadAuthority().prHeadSha`(冻结在完成记录里)。predecessor 完成后任何 head 前进(如 progress.md 自动 commit —— 已知陷阱,见 memory `codex_review_record 怎么挣到+head 漂移`)⇒ `head !== startPoint` **永久**成立 ⇒ 重试也全灭(FLY-1356 连续 4 ordinal 同因)。takeover 只认"精确相等",不认 fast-forward 后代。

## 3. 失效链全景

```mermaid
flowchart TD
    subgraph V1335 [FLY-1335 变体: engine_owned=1 真 DAG]
        A1[implement exec 起 23min 后 zombie] --> A2[HeartbeatService.declareZombie<br/>applyTransition → session=failed<br/>(FSM 旁路,不问引擎)]
        A2 --> A3[DecisionLayer → emitFailed<br/>observeEnrolledTeardown → held<br/>早退: 无 session_failed 落账 / 无 node 回滚]
        A3 --> A4[node=running / intent=started<br/>reconcile 名单不含 started → 引擎失明]
        A4 --> A5[Lead 冒名 complete --route blocked<br/>→ route_mismatch 409 → marker 重放循环]
        A5 --> A6[run 卡 active → one-active-run 锁<br/>POST /start 409]
    end
    subgraph V1356 [FLY-1356 变体: engine_owned=0 影子]
        B1[implement 4 ordinal 连败<br/>worktree_takeover_failed<br/>(startPoint 冻结 ≠ 前进后的 head)] --> B2[onDispatchFailed → ledger=abandoned<br/>node/run 不动]
        B2 --> B3[影子 run 永久 active<br/>engine reconcile 因 engine_owned=0 跳过]
        B3 --> B4[selection :193 不分 engine_owned<br/>→ legacy + DAG 双路 409]
    end
    A6 --> C[人工 DB 手术 UPDATE status='held' 才解锁]
    B4 --> C
```

## 4. 修复面(同族合一,五个面)

| # | 面 | 方向 |
|---|----|------|
| 1 | **reconcile 识别死 exec** | 引擎加"死 exec 侦测"域:node=running + 绑定 exec 的 session 已 terminal(或 row 缺失且探针双阴)+ 无 receipt ⇒ 回滚 node + 同 attempt 铸新 launch_ordinal + 新 execution_id(ledger 本就支持多 ordinal,复现 FLY-1356 影子路径的既有形态),带 max-attempt 上限 + backoff;超限 ⇒ run → `held` + 告警 Lead。`consume()` 的 getSession 检查同步补 status 判断(子形态 B) |
| 2 | **held teardown 出口** | `emitFailed`/event-route 的 held 分支不再裸吞:receipt missing + session 已 terminal + tmux/process 双阴 ⇒ 视为 blocked-completion,落 session_failed 账 + 交给 #1 的回滚域;探针说不准 ⇒ 继续 hold + 告警(fail-safe) |
| 3 | **Lead 级 run 管理 API** | `POST /api/runs/:runId/hold`(active→held,复用 loop-limit 的既有语义,append run event 留审计)替代手工 UPDATE。retry 不必做成 API —— #1 让引擎自愈,API 只留人裁停止杠杆 |
| 4 | **影子 run 不占锁** | 锁的判定收窄:selection `:193` 与 runs-route `:822` 的 one-active-run 闸只认 engine_owned=1 或 entry_kind='pipeline_dag_v1' 的 run;影子 run(观察性)不再有资格楔死生产。影子自身生命周期收尾(abandoned 终局 → run 收账)作为卫生项一并看 |
| 5 | **takeover 允许 fast-forward** | `head !== startPoint` 放宽为:head 是 startPoint 的后代(`git merge-base --is-ancestor`)且 tree clean ⇒ 允许 takeover;无关联 head 仍 fail-closed |

## 5. 验收反例 fixture(来自 issue)

- **1335 型**:engine_owned=1 + zombie 死 exec ⇒ 引擎须在 N 分钟内自动回滚 node 并重试(新 exec 起来)。
- **1356 型**:影子 run + 连败 abandoned ⇒ 不得占锁;fresh POST /start 双路皆可走。

## 6. 开放问题(带初步倾向,提交 Lead 确认)

1. **死 exec 侦测放哪**:倾向 reconcile sweep 为主(piggyback 既有 1s reconcile timer,零新 timer,per-exec 探针去抖)+ #2 的事件驱动出口为辅;两者共享同一个"回滚+铸新 intent"store 原语,幂等。
2. **max-attempt/backoff 取值**:倾向 node 级 max 3 次自动重试(与影子 belt 的 ordinal 重试经验一致),指数 backoff(1min/5min/15min);超限 run→held+告警,与 loop-limit escalation 同语义收口。
3. **#4 锁收窄 vs 影子生命周期修复**:倾向锁收窄为主修(一处判定,爆炸半径小、可 reverse-compat 测),影子收尾作卫生 follow-up;不倾向去精确定义"legacy belt 何时算死"(状态空间大,容易再造一类 wedge)。
4. **hold API 的授权面**:倾向 master auth + founder-only-authority 合同覆盖(run-lifecycle 属 reserved 动作族);不做 retry/cancel API(YAGNI,引擎自愈后没有场景)。
5. **#5 是否本单做**:issue 说"顺带"。倾向做(FLY-1356 的 4 连败直接根因,且改动面小:takeover 判定一处 + 允许 ancestor);若 Lead 认为风险大可拆单。
