# FLY-1581 generalized node 无法「正常地失败」— 实施计划

Issue: FLY-1581 (https://linear.app/geoforge3d/issue/GEO/issue/FLY-1581)
日期: 2026-07-31
基于: research.md
状态: **Codex design review APPROVED(第 10 轮)** — R1–R9 共 40+ findings 全部折入,每条都回本仓源码复核过;R7 之后主动收回了一处越界范围(见 §2 A4c)。R10 留三条非阻塞实施注记(见 §8)。

---

## 0. 判定(scope ② 的答案,证据在 research.md)

> **不是二选一。引擎在「路由校验」上是对的,但它缺一整条通道;模板在「该有失败出口」上是对的,但它指的门牌号不存在。**

| 候选 | 判定 |
|---|---|
| 放宽 `commitEnrolledCompletion` 收 `blocked` | ❌ **拒**。那等于让「失败」冒充「按某条成功路由完成」,DAG 会据此推进后继节点。校验本身正确,一行不动(留字节兼容哨兵) |
| 模板删掉 `--route blocked` | ❌ **拒**。删完 generalized node 一个失败出口都没有,「正常地失败」仍做不到,只是从撞墙死变静默死 |
| **引擎补 deliberate-terminal-failure 通道 + 模板从同一常量取值** | ✅ **采纳** |

选 `blocked` 而不是造新词,四条理由:legacy sink 已映射它(`event-route.ts:1603`)、CLI 已校验它(`complete.ts:42-51`)、marker 词表已认它(`complete-marker-reconciler.ts:95-110`,`expectedStatusFromMarker:318-320` 已返回 `"blocked"`)、所有 role .md 与 Blueprint 模板已在教它。**改动因此是「去硬编码 + 补引擎入口」,不是「重新教育所有提示词」。** 也符合 issue 的「不加 feature flag」。

## 1. Carrier authority — 谁的话算「runner 声明」(R1 #5 / R2 #7)

先钉死这条,否则各 sink 会各自解释 `route`。**精确表述**(R2 #7 纠正了我 v2 里「Direct 根本不读 route」的不准确说法):

> adapter carrier **可以**携带并为其它 guard 读取 `decision.route`(`ExecutionEventEmitter.ts:179-205` 把 `decision` 放进 payload;`DirectEventSink.ts:517-528` 读 route 做 design guard、`:540-545` 做 generalized PR guard)。**但它们的 generalized teardown 分支不得把 `blocked` 解释为 runner 声明。**

| carrier | 是什么 | `route=blocked` 怎么算 |
|---|---|---|
| HTTP `/events`,`source="flywheel-comm"` | runner 亲手跑 `complete`(`complete.ts:214` `requireEnv("FLYWHEEL_BRIDGE_URL")` → 纯 HTTP;`:328-356` 打这个 body) | ✅ **runner 声明**,admission 面之一 |
| marker 重放 | 同一 body、同一 source,只是延迟(`complete-marker-reconciler.ts:728`) | ✅ **同一声明**,admission 面之二 |
| `TeamLeadClient.emitCompleted` → HTTP enrolled 分支 | `event-route.ts:927-953` 只记 teardown,不解释 route | ❌ teardown,不动 |
| `DirectEventSink` generalized 分支 | `DirectEventSink.ts:529-562` 只记 teardown | ❌ teardown,不动 |
| adapter `failureKind: "goal_blocked"` | `CodexTmuxAdapter.ts:1041-1046`,是 crash/teardown 信号 | ❌ 另一类事实,不得冒充本单的显式声明 |

**⇒ 需要改的 admission 面恰好两处(live HTTP + marker settlement)。** R1 #5 担心的 `DirectEventSink.ts:540-545` `creates_pr` 拒绝挡住 implement 节点的 blocked —— 在这个划分下自动消失(Direct 本来就不承载声明)。**此结论必须写进代码注释**,否则下一个人又会去改 Direct。

## 2. 改动清单

> **R1 #7:模板今天就已经在教 `blocked`。所以「引擎接受它」和「DAG 不再盲换它」必须同一个 PR 落地** —— 否则中间版本里 blocked 会话会被当死进程盲换 3 次。模板改文案不是安全屏障,可以最后落。

### PR-A(行为 PR,不可再拆)— 引擎补门 + 不盲换 + marker 收口

#### A1. `packages/config/src/node-type-registry.ts` — 单一真相

```ts
/**
 * FLY-1581: the ONE terminal-failure exit an enrolled generalized node may take.
 * Deliberately NOT a WorkflowCompletionRoute — an impasse is not a completion and
 * must never write workflow_node_completion nor advance the DAG.
 * Consumers (ALL of them, no local allowlists): flywheel-comm complete.ts,
 * Blueprint template, event-route generalized admission, marker reconciler.
 */
export const WORKFLOW_TERMINAL_FAILURE_ROUTE = "blocked" as const;

export type GeneralizedRouteAdmission =
  | { kind: "completion"; route: WorkflowCompletionRoute }
  | { kind: "terminal_failure" }
  | { kind: "rejected"; reason: "route_mismatch" };

/** The ONE admission the Bridge sinks actually call (contract test calls the same). */
export function admitGeneralizedRoute(
  route: string,
  capabilities: Pick<WorkflowNodeCapabilities, "completion_route">,
): GeneralizedRouteAdmission;
```

**R1 #8 — 明确不做的事**:**不**把 `workflow-run-snapshot.ts:470-474` 的三值白名单改成读 live registry。该文件 `:482` 写着「Parse only pinned snapshot vocabulary; never consult the mutable live registry」——pinned snapshot 的词表是 schema-versioned 合同,让它跟随可变 registry 会让未来删/加 route 改变旧 snapshot 的可解析性。**保留它独立**;只让 live registry / Blueprint / CLI / reconciler 消费共享常量。

**R1 #6 附带**:`complete.ts:42-51` 与 `complete-marker-reconciler.ts:95-110` 各自硬编码的 allowlist 里的 `blocked` 改为引用 `WORKFLOW_TERMINAL_FAILURE_ROUTE`,否则「单一真相」根本没覆盖 runner→CLI→Bridge→replay 全链。

#### A2. `StateStore.commitEnrolledDeclaredBlocked()` — 一个事务干完所有事

**R1 #3**:现有 retry-limit 路径(`StateStore.ts:22970-23005`)在**同一事务**里做 `workflow_run active→held` + run event + durable alert outbox。declared-blocked 必须照抄这个形状,而不是「dispatcher 里 enqueue + continue」(那会留下一个仍为 `active` 的搁浅 run,而且 sweep 可被 `FLYWHEEL_ENGINE_DEAD_EXEC_SWEEP=0` 关掉 → `workflow-engine-dispatcher.ts:180-182`)。

**authority 校验(R1 #4)** —— 逐项复用 `commitEnrolledCompletion:24783-24828` 的语义,**不**用 `recordEnrolledTerminalSignal:21319` 的 single-binding 弱查法:带 `workflowActivation` → 校 activation/run/node/attempt 四元组 + turn epoch;不带 → `listWorkflowActivationsForActor` 多于一个即 `workflow_activation_required`(fail closed);再校 current run-node owner(对齐 `:24964-24970`);`--summary` 非空 + 字节上限。

**outcome table —— 必须在两个 key 上都穷尽(R2 #2 + R3 #1)**。顺序照抄成功 completion 的「先 `:24834-24963` 查 receipt,再 `:24964-24970` 查 current owner」。

> **R3 #1 抓到的洞**:`complete.ts:329` 是 `event_id: randomUUID()` —— **每次 CLI 调用都是新的 `sourceEventId`**。所以「同一 attempt 的第二次调用」既不是 exact receipt、也不是同 ID 冲突,又因为 session 已是 `blocked` 而躲开 `terminal_status_immune` → 掉进「首次提交」→ `active→held` CAS 改到 0 行 → **每次重放都失败,永久卡住**。operator 事先把 run 置 `held` 也会撞同一个洞。

**Key 0 —— 全局 receipt 前置查(R4 #1,必须是第一步,先于任何按当前状态的分流)**

> **R4 #1 抓到的洞**:v4 的 A3 是**先看当前 session status** 再决定进 deflect 还是 declaration。可达时间线:事件 E 在 `approved_to_ship` 上被 deflect、durable receipt 已提交、HTTP 响应全丢;随后 session 合法地重开一轮 review(`approved_to_ship → awaiting_review`)。**重放 E 时当前状态已不是 approved_to_ship → 错过 deflect 分支 → 掉进 A2 → 给同一个 source event 写出第二条互斥的 declaration receipt**,还把重开的会话打成 blocked。

所以第一步必须是:**跨所有 FLY-1581 settlement receipt(declaration / alias / deflection)按 `sourceEventId` 做全局查**,在任何 current-state 路由**之前**:

| 前置事实 | outcome |
|---|---|
| 找到 receipt ∧ 全部 immutable identity 字段(digest / execution / activation / node / attempt)一致 | **返回该 receipt 原本的 outcome**。查找集 = **declaration / alias / deflection 三类**(FLY-869 侧不在本单范围,见 A4c)。什么都不写;是否需要重投告警**按下面的 alert-disposition 表**,不是一律「不发」 |
| 找到 receipt ∧ **任一** identity 字段不同 | `settlement_conflict` → 永久冲突(见 A4b),非 retryable |
| 没找到 | 继续往下按当前状态分流 |

**身份比对用「carrier 原样携带的」,不是「现在重新解析出来的」(R5 #4)** —— `complete.ts:286-305` 只在 CommDB 查得到时才带 activation tuple,查不到是**合法情形**(`workflow-activation.ts:5-20`),A2 本来就保留 execution-only 准入。所以:

- 比对项 = `sourceEventId` + canonical payload digest + `execution` + **activation tuple 按原样(含「缺省」这个值本身)**;
- 原始解析出的 run/node/attempt 作为 **receipt 证据**保存,但 exact replay 时**绝不**拿当前 ownership 重新解析(那会把 Key 0 想消除的 current-state 依赖又请回来)。

marker reconciler **也必须在 loopback POST 之前**做同一个 exact-receipt 前置查。命中 receipt 后是否要重 await 告警,**按 outcome 分**(R5 #2 —— 有两种 outcome 本来就不该有告警,无条件要求会把它们永久卡住):

| 命中的 receipt outcome | alert 要求 |
|---|---|
| `marked` / `unknown_head_marked` | `alert_required = true`:必须重新 await 那条 durable alert 被接受后才 unlink |
| `stale_attempt`(`post-ship-finalization.ts:176-189` 在写聚合前就返回)/ `unknown_head_skipped`(`:205-207` 是 consumed no-op) | `alert_required = false`:**直接**从 exact receipt 关闭。现有测试就明确要求 stale 类不发告警(`complete-marker-reconciler.test.ts:434-482`) |
| `declared_blocked` / `declared_blocked_alias` | 按 declaration 自己的告警义务(首次已发过 → 不重发) |

**Key 1 — 按 attempt 的 declaration 事实查**:

| 前置事实 | outcome |
|---|---|
| 本 attempt 已被声明,本次是另一个 `sourceEventId`,**且 execution/activation/node/attempt 身份与原始 fact 完全一致**(R4 #3) | `declared_blocked_alias`:写一条 **immutable per-marker alias 事实**(绑定本 `sourceEventId` + digest),**不**二次 hold、**不**二次告警 → 返回可复核的 closed outcome |
| 本 attempt 已被声明,但身份不一致(不同 owner) | **不得**当 alias 关闭 → `settlement_conflict` |
| current run-node owner 已换代 | `stale_execution_superseded` → 200 closed settlement(`event-route.ts:875-897` 已有映射) |
| session 已是 no-out terminal 且 ≠ `blocked` | 见 A4b 的 `completed` 例外,不能一律 `terminal_status_immune` |
| 以上都不是(真·首次提交) | 走下面的写入 |

**run 状态的确定性处理(R3 #1 + R4 #3)** —— 不得「抛错永久失败」,且**这张表决定下面第 4 步做什么**:

| run 现状 | 动作 |
|---|---|
| `active` | CAS `active→held`;**改到 1 行 = 正常**;**改到 0 行 = 竞态 → 重新分类**(回 Key 0/1 重判),**不抛错、不回滚** |
| 已 `held`(operator 或前次声明所致) | 视为已满足,继续写事实,**跳过 CAS** |
| 已 `terminated` | 合法后续演进,继续写事实,**不动 run 状态** |
| 已 `completed`(真实存在,`StateStore.ts:27853-27856`) | **不动 run 状态**,写事实,返回 closed outcome(run 已结算,声明只作审计) |
| 未知 / 损坏的 run 状态 | fail closed:不写、不删 marker,发 severe 告警 |

> **R2 #2 的关键仍成立**:先认 exact receipt 再看 run 状态。否则「首次 HTTP 已提交但响应丢了」的重放会发现 run 已 `held` → 拒绝自己的幂等重放。

**首次提交,一个事务内**:

1. session 字段 —— **必须写全(R3 #7)**,对齐既有 completion writer(`event-route.ts:1853-1879`、`DirectEventSink.ts:907-920`):`status="blocked"`、`last_error`=summary(`founder-thread-notifier.ts:360,387` 从 summary 取阻塞原因)、`last_activity_at`、`decision_route="blocked"`、`decision_reasoning` / `summary`。下游通知与 UI 直接读这些字段(`event-route.ts:213-229`、hook payload `:2999-3017`),只写 status+last_error 会让阻塞在 Lead 面前显示成空白。
   **外加 canonical session 审计**:generalized 成功路径在 workflow receipt 之后还会写一条 `wfca:` session_events 审计(`event-route.ts:911-919`)。本分支要么原子写等价审计,要么在代码注释里**明确记录** `generalized_declared_blocked` 是所有 session-event 消费者的替代,并由测试锁死该选择。
2. **`applyTerminalTimestamp(execId, prev, "blocked")` —— 强制(R2 #4)。** `StateStore.ts:4127-4139` 的注释是硬要求:「EVERY new sessions status-write path MUST call this…… If you are adding a fourth writer, stamp here or the sweep will eat its asks」。它还建 `terminal_lifecycle_id` 与 settlement intent(`:4140-4203`)。漏掉不会体现为红测试,而是几周后 ask 悄悄消失。
3. 真实状态变化时 `bumpLifecycleRevision`(镜像 `:21415-21418`)。
4. `workflow_run` 状态 —— **完全按上面那张 run-state 表执行**(只有 `active` 才做 CAS;`held`/`terminated`/`completed` 各按表办;CAS 改到 0 行 = 重新分类,**不**回滚)。
5. run event `kind: "generalized_declared_blocked"`,payload **必须**带 `sourceEventId / canonicalSubmissionDigest / executionId / activationId / nodeId / attempt / summary / at` —— attempt 写 payload,因为 `workflow_run_event` 无 attempt 列(R1 #4);digest+sourceEventId 是 A4 settlement 的**唯一**主证据(R2 #2)。
6. **恰一条** durable alert outbox,UID 由同一元组派生(与 receipt 对齐),文案带 runner summary 原文 —— 验收标准 ② 的落点。

**提交成功后:CommDB 投影 + issue-display refresh** —— 镜像 `DirectEventSink.ts:1249-1253` 与 `plugin.ts:4173-4188` 的 `onTransition`。**新方法绕过 `applyTransition`,所以这一步不会自动发生**;漏掉会导致 StateStore 已 `blocked` 而 runner CommDB 仍显示 running,Layer-2 reconcile 有意保留 failed/blocked(`commdb-fsm-reconcile.ts:50-58`)**不会**替你收敛(R2 #4)。

> **🔴 R3 #6 的崩溃窗口 —— v3「事务外、仅首次」的写法是有洞的**:进程在 SQLite 事务提交后、enqueue 之前死掉 → 重放认出 exact receipt 走幂等分支 → **first-commit hook 永远不再触发**。而 `TerminalCommDbSync` 的 pending 队列是**内存**的(`terminal-commdb-sync.ts:84-90`),重启即丢。
>
> **修法(二选一,实施时定)**:(a) 把 projection intent 与主事务同库持久化,由既有 drain 消费;(b) **exact-receipt 幂等重放时也重跑**这些本就幂等的 enqueue,直到存在持久的 enqueue/settlement 证据为止。外部投影本身仍不声称与 SQLite 事务原子。必须有 fault-injection 测试:提交后、enqueue 前抛错 → 重启 + marker replay 后收敛。

#### A3. live HTTP admission(`event-route.ts` generalized 分支,`:861` 之前)

**R1 #2**:legacy 的 FLY-1505 deflect 在 `:1603`,而 generalized 分支 `:696-925` 早就 `return` 了 —— **「保持现有 deflect 在前」不是可执行改动,那条路根本不可达。** 必须在 generalized 分支**内部**显式实现 state-aware 分流,顺序:

```
generalized 分支内:
  1) 会话 status === "approved_to_ship" 且 route ∈ {blocked, ship_attempt_failed}
     → settleShipAttemptFailed 的 settlement(FLY-1505 语义),approved_to_ship 保持不变
        ⇒ 200 { settled: "ship_attempt_deflected", outcome: <具体 settle outcome> }
  2) admitGeneralizedRoute(route, caps).kind === "terminal_failure"
     → commitEnrolledDeclaredBlocked(...)
        ⇒ 200 { generalized: true, settled: "declared_blocked" | "declared_blocked_alias"
                 | "stale_execution_superseded" | "terminal_status_immune" | <completed 的 closed 值> }
  3) 否则 → 现有 commitEnrolledCompletion(一行不改)
```

**⚠️ 0) 在 1) 之前**:A2 的 **Key 0 全局 receipt 前置查**(R4 #1)。同一 `sourceEventId` 一旦已被结算过,**直接返回它原本的 outcome**,不再按当前状态重新分流。

**⚠️ 1.5) 在 1) 与 2) 之间**:**非-approved 的 merged 失败声明 → fail closed**(A4c 收回后的定策),`⇒ 409 非 retryable + severe 告警`,零状态变更。live HTTP 与 marker replay 两侧**一致**。

响应 union 必须**列全每一个 closed outcome**:`declared_blocked` / `declared_blocked_alias` / `stale_execution_superseded` / `terminal_status_immune` / `ship_attempt_deflected` / `settlement_conflict` / `<completed 的 closed 值>`。

**🔴 顺序红线**:1 必须在 2 之前,且**不带任何 landing 限定**(R2 #3)。

> v2 里我给条件 1 加了 `landing ≠ merged`,那是照抄 marker 侧 deflect(`complete-marker-reconciler.ts:534-544` 确实有 `markerLanding !== "merged"`)。**但 live 侧的 legacy 分支 `event-route.ts:1603-1643` 根本不看 landing,`expectedStatusFromMarker:318-320` 也只看 approved + route。** 而 CLI 允许 `--route blocked --merged`(`complete.ts:138-160` 只禁 `no_code` / `phase_design_complete` 配 merge)。所以我加的那个限定会让 `route=blocked` + `landingStatus=merged` 绕过 deflect、掉进 declared-blocked,把 session 写成 `blocked`、run 写成 `held` —— **正好打掉活着的 founder 批准**。我自己加的条件造出了这个洞,已删除。

任何 `await` 之后必须**重新从 StateStore 读** approval / head / questionId(不得沿用 await 前的快照)。

#### A4. marker settlement(`complete-marker-reconciler.ts`)

**R1 #1 —— 我上一版说「reconciler 不改,自动跟随」是错的。** 已核实 `:772-818`:generalized marker 的成功判据只有三种 —— `CLOSED_SETTLED_COMPLETIONS`(只有 `stale_execution_superseded` / `stale_resubmission_escalated`,见 `workflow-completion-settled.ts:1-4`)、`terminal_status_immune` + 状态复核、或**真的存在** `workflow_node_completion` receipt + canonical audit。declared-blocked 三样都不满足 → 返回 `transient_failed` → **marker 永久保留、无限重放**(比 quarantine 更糟)。而且 `:534-544` 的 FLY-1505 marker deflect 明写 `!generalizedBinding`,enrolled marker 不在保护范围。

所以 reconciler **必须进 PR-A**,加两条**服务端复核的** settlement(遵循该文件既有铁律:`Do NOT trust HTTP 2xx`,一律回读 StateStore)。

**关键纠正(R2 #1 / #2):settlement 的主证据必须是「这个 marker 被结算了」的 exact receipt,不能是「当前状态看起来对」。**

| settled 值 | 主证据(exact,必须匹配本 marker) | 附加负向安全断言 |
|---|---|---|
| `declared_blocked` / `declared_blocked_alias` | 存在 `generalized_declared_blocked`(或 alias)run event,其 payload 的 `sourceEventId` **与本 marker 的 event_id 相同**、`canonicalSubmissionDigest` 与本 marker body 的 digest 相同、activation/attempt 相同 | 该 attempt **不存在** `workflow_node_completion` receipt |
| `ship_attempt_deflected` | 存在**新建的、per-source-event 的 immutable FLY-1505 deflection receipt** 且与本 marker 匹配(见下) | preservation 只对照 **receipt 里存的 before/after authority snapshot**;**不得**要求当前 session 仍是 `approved_to_ship`(R4 #4 —— 那会让一次合法的后续 ship / review 重开把老 marker 永久卡死) |

**v2 的两个错误,已改**:

- ❌ v2 的 `declared_blocked` 要求「当前 session 仍 `blocked` ∧ run 仍 `held`」。但 operator 可以合法把 held run 转 `terminated`(`StateStore.ts:21568-21570, 21677-21690`),此后该条件**永远为假 → marker 无限重试**。改为:**认 exact immutable receipt**,允许合法后续演进。
- ❌ v2 的 `ship_attempt_deflected` 只回读 approval 三件事。**一个什么都没写、只返回 200 的错误 handler 也能让这三条成立 → 唯一的 marker 被删。**

**🔴 R3 #2 —— v3 说「用 `session_params.fly1505_ship_attempt_failed` 当主证据」也是错的。** 已核 `post-ship-finalization.ts:191-244`:那个对象只有 `at / PR / head / questionId / summary / attempt_count`,**没有** marker event_id、没有 canonical digest、没有 activation/attempt;它是**单个可变聚合**,会被后续 series 覆盖,同 series 每次调用还会 `attempt_count++`。后果:一个无关的、长得像的早期 attempt 可以**假授权删除**本 marker;4 次响应丢失 + 重放会反复改计数;后来的 attempt 会覆盖旧 marker 需要的证据。

**修法**:在与聚合更新**同一个 StateStore 事务**里,额外写一条 **immutable per-source-event deflection receipt**,携带 `{sourceEventId, payloadDigest, run/node/activation/attempt, head, qid, outcome, authority snapshot(before/after)}`。四种 settle outcome **全部**写 receipt:

| settle outcome | settlement 判据 |
|---|---|
| `marked` / `unknown_head_marked` | 匹配本 marker 的 immutable receipt 存在 |
| `stale_attempt` | receipt 记录了「本 marker 的 head/qid 已被 current authority supersede」 |
| `unknown_head_skipped` | receipt 记录了「已存在 real-head receipt」 |

可变聚合保留作**重试抑制状态**,但**不得**充当 marker 的 settlement 证明。approval preservation 的复核对照的是 receipt 里存的 **authority snapshot**,不是「当前状态必须永远冻结在 approved_to_ship」(否则一次合法的后续 ship/completion 转移又会把老 marker 卡死)。

#### A4b. marker disposition 必须穷尽(R3 #3)

v3 说「任一条不满足 → `transient_failed`」是错的:**有些不满足是永久矛盾,重试一万次也不会好**,那是热循环。

| 情形 | disposition |
|---|---|
| 传输 / DB 读 / 事务 / alert 投递失败 | `transient_failed`(保留 marker,重试)—— **只有这三类算 transient** |
| **任何可读、不可修复的 receipt 身份或内容矛盾**(R4 #4 一般化):declared receipt ∧ 同 attempt 又有 completion receipt;同 sourceEventId 但 deflection digest/身份不符;handler 声称已结算但 receipt 缺失或损坏;同一 source event 出现互斥的 declaration 与 deflection receipt;alias 命中但 owner 身份不符 | **永久矛盾** → 见下方 `settlement_conflict`,**不得**热循环。alias 同样适用本规则 |

**🔴 R5 #3 —— 「不再重试的 conflict/quarantine」目前不是终态,必须新建一个 outcome。** 现有 `ReconcileOutcome.kind="quarantined"` 的契约明写「caller 必须自己挑一个 fallback 状态」(`complete-marker-reconciler.ts:130-156`);boot drain 对该 kind 一律走 `applyQuarantineFallback`(`:1025-1070`),Heartbeat 的每条 marker 路径同样(`HeartbeatService.ts:936-969, 1059-1084, 1128-1155`),死掉的 `running` 会话会被强推成 `blocked`/`failed`(`:877-965`)。对「handler 声称已结算但 receipt 缺失」这类**没有 declaration 事实**的冲突,这会让 run 停在 `active` 并重新落进盲换路径 —— 与「不再重试」自相矛盾。

**修法**:新增一个**独立的、已复核的** `settlement_conflict` outcome(在 severe 告警被 durable 接受**之后**才置),并改 boot drain / Heartbeat 消费者,使它**永不**进入 legacy `applyQuarantineFallback`:

| 冲突类型 | disposition |
|---|---|
| 可信的 generalized 冲突(事实齐全但互斥) | 原子 hold/fence 该 run,或写一条由 dispatcher backstop 消费的 durable conflict 事实 |
| authority 损坏(receipt 缺失/不可读) | **fail closed:不做任何 mutation**,只告警 |

测试:boot-drain 与 Heartbeat 各配一个 dead tmux,断言**没有** fallback 强改状态、**没有**替换重派,且 run 确实被 hold/fence。

**session 已 `completed`(no-out terminal)的例外**:A2 想返回 `terminal_status_immune`,但 reconciler `:777-789` 只在回读状态是 no-out **且 ≠ `completed`** 时才接受该 settlement → 迟到的失败 marker 落在 completed 会话上会**永久重试**。必须二选一:给 `completed` 定义 route-specific、服务端可复核的 closed settlement;或把 `completed` 从 A2 的 `terminal_status_immune` 里排除并返回另一个 closed outcome。**实施时必须显式选一个并测到每一种 no-out 状态。**

**alert 语义必须保住**:marker 侧现路径在删 marker **前 `await`** durable alert、且 sink 缺失直接 throw(`complete-marker-reconciler.ts:567-590`),而 live handler 只 `void` alert(`event-route.ts:1620-1633`)、coordinator 还会吞投递错误(`auto-qa-coordinator.ts:943-960`)。**generalized deflect 的 marker 路径必须沿用 await 语义**:alert 投递失败 → 保留 marker,绝不静默删。


#### A4c. FLY-869 merged-marker preflight 的定序 —— **范围收回(R7)**

`complete-marker-reconciler.ts:600-620` 在 loopback POST **之前**处理 `landingStatus="merged"`,且**没有** `!generalizedBinding` 排除(已核实:门只有 `markerLanding === "merged"` ∧ 无 `merge_block_reason` ∧ 非 no-out terminal)。这是第三条排序义务。

**但 v5/v6 我在这里越界了。** 我当时给「非-approved 的 merged 失败声明」定了 FLY-869 优先,并为此要求补 per-source-event receipt + 原子 fence + 恢复状态机。设计评审 R6/R7 连续两轮的阻塞全部落在这个 fence 子树里 —— 因为它在修的是 **FLY-869 自己对 generalized execution 覆盖不全**(`setMergeBlock` 只写可变 session 列、不写 receipt、不动 `workflow_run`;`claimWorkflowPrFinalization` 拒绝非 `active` run;`held` 对真实 approval writer 不可见)。

**那是 FLY-1581 暴露出来的既有缺陷,不是 FLY-1581 的缺陷。** 本单的题目是「让 generalized node 能正常地失败」,不是「补齐 FLY-869 的 generalized 覆盖」。继续吞下去会把一个契约修复变成一次 merge-block 生命周期重构。

**收回后的定策 —— fail closed,不新增任何机制**:

1. **CLI 层直接拒**:`complete.ts` 对 **enrolled generalized execution** 拒绝 `--route <失败常量>` 与 merge 证据(`--merged` / merged landing)同时出现。语义上它们本就矛盾:合入了就是成功了,不是阻塞。这是一处参数校验,与既有 `no_code` / `phase_design_complete` 的禁配规则(`complete.ts:150-160`)同形。
2. **两个 sink 兜底同样 fail closed**:万一仍有这种 body 到达(旧 marker / 手工构造),live HTTP 与 marker replay **一致**返回 409 非 retryable + severe 告警,**不**尝试结算 —— FLY-1581 没有权限去结算一起未授权合入事故。

   **🔴 但 409 本身不是终态(R8)**:reconciler 对非 429/5xx 的 4xx 一律 `moveToQuarantine`(`complete-marker-reconciler.ts:746-765`),而 `quarantined` 这个 kind 的契约要求 caller 自己挑 fallback 状态,boot drain(`:1025-1070`)与 Heartbeat(`HeartbeatService.ts:936-969, 1059-1084, 1128-1155`)都会调 `applyQuarantineFallback`,把死掉的 `running` 会话强推成 `blocked`/`failed`(`:877-965`)—— **正好是「零状态变更」的反面**。

   所以这条 fail-closed 路径**必须走 A4b 新建的 `settlement_conflict` 终态**(severe 告警被 durable 接受之后才置),按其中的 **authority 损坏行**处理:**零 mutation、不进 legacy `applyQuarantineFallback`、不强改任何状态**。实施时还须**明确钉死**这份 marker 是被 unlink 还是移入 evidence quarantine(两者都行,但必须选一个并测)。

   **⚠️ 保证的边界必须诚实(R9)** —— 我上一版给测试 6e 写了「零状态变更 + 无替换重派」,那句**超出了收回后的范围能保证的**。真实生产里 Heartbeat 一个 liveness tick 内先跑 marker reconciliation,**紧接着**在同一 tick 跑 crash reaper 与 `reapOrphans`(`HeartbeatService.ts:648-704`);而 settled 的 outcome 不会把该 execution 放进 `markerRetryPending`(`:936-945, 1059-1067, 1128-1137`),`reapOrphans` 只压制 monitor-held / zombie-held / retry-pending / 已通知四类(`:2630-2644`),否则就把死掉的 running 会话强转 `failed`(`:2656-2685`);一旦有了这个终态,dispatcher 就可能进 `rollbackDeadWorkflowNodeExecution`(`workflow-engine-dispatcher.ts:1174-1199, 1303-1318`)。

   **要挡住这条后续链路,需要的正是被收回到 F4 的 durable fence。** 所以本单**只保证、也只断言**:

   - ✅ **本 marker 路径**不写任何 declaration / deflection / session / run 状态,且**绝不**调用 `applyQuarantineFallback`;
   - ❌ **不**声称「跨 tick 永久零变更 / 永不被替换」。这条未授权合入 execution 之后被通用 crash/orphan 处理怎么对待,**是 F4 的事**,本单明确列为**已知残留风险**。

   > 若哪天要把「永久零变更 / 无替换」这条保证收回本单,就必须把 durable fence + 恢复契约一起收回来 —— 那等于撤销这次范围收回。
3. **approved-to-ship 的失败 deflect 仍必须绕过/推迟 FLY-869 marker guard**(A3 步骤 1 的红线不变)。这条留在本单,因为它就是 FLY-1505 与本单准入的定序问题。
4. FLY-869 对 generalized execution 的 receipt / fence / 恢复 → **新开 F4**(见 §6),并标注为「若将来要放开非-approved merged 失败声明,F4 是前置」。

测试 6e 相应缩到:live/marker 各覆盖「approved 但 ship-ineligible + merged 证据」(必须落 deflect)与「非-approved + merged 证据」(两 carrier **一致** 409 fail-closed → `settlement_conflict`,断言本路径零写入且不调 fallback),外加 CLI 层拒配的单测。


#### A5. dispatcher 兜底(`workflow-engine-dispatcher.ts:1191-1199` 旁)

A2 已把 run 置 `held`,而 `reconcileDeadExecutions` 只枚举 active run(`:1157-1164`),所以主路径天然不会盲换。此处只加 **invariant backstop**:若发现某 attempt 存在 `generalized_declared_blocked` 事实,`continue`(绝不 `rollbackDeadWorkflowNodeExecution`)。**不作为主提交路径**,因此不依赖 sweep 开关。

#### A6. 模板指对门(**R3 #5:必须与上面同一个 PR,不是可后落的文案 PR**)

> v3 把它当「可后落的文案 PR」是自相矛盾的:测试 2/3 要从**真块**里抽 token,而块是这里才引入的。引擎侧先落就没有块可抽,把抽取退化回旧的无类型 occurrence 又会退回那个无效验收。**所以块 + 分类器 + 语义合同测试全部留在 PR-A 内。每个 merge 边界上,「真 prompt → 真 sink」测试都必须绿。**

1. `Blueprint.ts:2033 / 2042` 的 PIPELINE PREAMBLE (5) —— **分情况(R4 #5,v4 这里和 2b 自相矛盾)**:
   - **generalized 执行**:第 (5) 条**完全不带 `complete --route` 命令**,只指向下面的失败块(集中化);
   - **legacy(非 generalized)执行**:保留命令,字面量 `blocked` → `${WORKFLOW_TERMINAL_FAILURE_ROUTE}`。
2. generalized 分支(`Blueprint.ts:1594-1627`)显式补失败出口,**落在一个带首尾哨兵的块里**:

   ```
   <<<FLYWHEEL_TERMINAL_FAILURE_EXIT>>>
   若你判定这个 bounded task 不该做 / 做不了,不要用你的 completion_route 伪造完成。
   运行 `complete --route <常量> --summary "<原因>"` —— 这是本节点唯一的终态失败出口;
   引擎会记为 blocked、把 run 挂起、通知你的 Lead,不会盲目重派。
   <<</FLYWHEEL_TERMINAL_FAILURE_EXIT>>>
   ```

   合同测试要求每份 generalized prompt **恰有一个**闭合的该块(v3 只有起始标记、没有结束标记,无法界定边界 —— R3 #4)。

2b. **🔴 R3 #4:「块内=失败、块外=正常完成」还不够,因为最终 prompt 里块外本来就有失败命令。** 已核实两个来源:
   - **onboarding preamble** `Blueprint.ts:2022-2045`(第 (5) 条);
   - **`workflowAgentContent`(role .md 原文)**:`Blueprint.ts:2451-2456` 把 `## Agent Role` + role 内容拼在**最前**,`:2516-2518` 才接 `## Baseline Rules`。真实 role 里有多处 `complete --route blocked`,还有跨行的(`prototype-executor.md:184-185`)。

   如果照 v3 的规则,把 generic 的 **onboarding** 失败路由从 `blocked` 改成合法成功路由 `no_code`,它会被判成 normal-completion → 1a 绿;而 1b 根本不扫 Blueprint → 也绿。**同一个无效验收又回来了。**

   **修法 —— 集中化 + 按来源分区,零未分类**:
   - generalized 执行时,onboarding preamble 第 (5) 条**不再自带路由**,改为指向那个块(「按下面 TERMINAL FAILURE EXIT 块执行」);
   - 最终 runner-facing prompt 按 **provenance 分区**:`agentContext` 区(role 原文)/ baseline-rules 区 / 失败块内。分类器对**每一个** occurrence 判定所属区,**不允许任何未分类 occurrence**;
   - `agentContext` 区内的 occurrence 沿用 1b 的严格规则(必须等于失败常量),但现在是在**装配后的真 prompt + 真 role 内容**上强制,不是只扫文件。

3. **同时改掉互相矛盾的旧句(R2 #6)**。`Blueprint.ts:1611-1615` 对带 `workflowSubmissionCredential` 的节点写着绝对句「**Do not run `complete`**;the accepted verdict is this node attempt's terminal fact」。若无条件再加一句 `complete --route blocked`,runner 只能靠猜谁优先。原句改为:
   > 正常 pass/fail **只能**用 `qa-result`,不要用 `complete`。**唯一例外**是 deliberate impasse —— 那时用下面 TERMINAL FAILURE EXIT 块里的路由。
4. `Blueprint.ts:1585-1593` 手写的三值白名单改为消费 registry 的 completion-route 类型守卫(**注意:这是 live registry 侧,与 A1 里明确不动的 pinned snapshot parser 是两回事**)。
5. 静态 role .md(`agents/generic-executor{,.bare,.matt}.md`、`.flywheel/agents/**`)无法插值 → 由合同测试 1b 兜底。

## 3. 合同测试(验收标准 ③④ 的落点)

> **R1 #6 我接受:只调纯函数 `admitGeneralizedRoute` 的测试是空过绿**(event-route 忘了调它、marker 永不 settle,它照样绿)→ 必须穿过真 sink。
>
> **R2 #5 更狠,我也接受 —— v2 的验收自己就是无效的。** 反例:把 generic 节点 prompt 里的**失败**命令从 `blocked` 改成它**合法的成功路由** `no_code`。`admitGeneralizedRoute` 返回 `kind:"completion"` → 1a 的「非 rejected」断言通过;2/3 因为写死提交字面量 `blocked` 也照样通过;7(b) 只变异成「不被接受的值」同样通过。**而真实后果是 runner 把失败写成成功 receipt 并推进 DAG。** 这正是 issue 判据说的无效验收。

**修法:extractor 按 provenance 给每个 occurrence 分区并分类,断言的是语义种类,不是「非 rejected」。**

- **扫描对象必须说清楚(R4 #5)**:`adapter.execute` 拿到的 `prompt`(任务文本)与 `appendSystemPrompt`(引擎装配的系统提示词)是**两个字段**(`Blueprint.ts:2561-2568`)。合同扫描面 = **引擎装配的系统提示词**;任务 `prompt` 作为**第四个非权威区**单独登记(它是 issue 标题/正文,不由引擎生成),不得把「三区穷尽」声称覆盖两个字段。
- **在装配后的系统提示词上分区**(R3 #4),三个权威区:失败块内(首尾哨兵界定)/ `agentContext` 区(role 原文)/ baseline-rules 区。区间边界**从已知装配组件推导**(`Blueprint.ts:2451-2456` 与 `:2516-2518` 的拼接输入),不靠猜标题;并拒绝哨兵字符串冲突。
- 失败块内 → `terminal-failure`;`agentContext` 区 → 必须等于失败常量;baseline-rules 区块外 → `normal-completion`,必须逐字等于该节点 pinned 的 `completion_route`。
- **零未分类**:任何落不进三区的 occurrence = 测试 FAIL。
- 静态 role .md(1b)同规则:**每个 `complete --route <x>` 都必须等于 `WORKFLOW_TERMINAL_FAILURE_ROUTE`**(今天实际全部如此);将来要在 role .md 里写成功路由,必须显式加进带注释的 allowlist,否则测试红。
- **测试必须喂真实生产 role 内容**,不能只用每种 node type 一份合成 `workflowAgentContent`(R3 #4)。

| # | 测试 | 断言 |
|---|---|---|
| 1a | 对 `NODE_TYPE_REGISTRY` 每种 node type:真 `BlueprintContext` + **真实生产 role 内容** → 真 `buildPrompt` → extractor 按 provenance 分区抽取 | 三区规则(见上)全部满足;**恰有一个闭合失败块**;**零未分类 occurrence**;并断言扫描文件数 / occurrence 数 / 全部解析成功,零匹配即 FAIL |
| 1b | 扫 `agents/*.md` + `.flywheel/agents/**/*.md` | 每个 occurrence 等于失败常量(或在带注释 allowlist 里)。**extractor 必须跨空白/换行**(`.flywheel/agents/engineering/prototype-executor.md:184-185` 实测 `--route` 与 `blocked` 分两行)且**剥掉 Markdown 反引号与尾随标点** |
| 1c | 带 `workflowSubmissionCredential` 的真 review/QA prompt(R2 #6) | 语义断言:正常 pass/fail 不得指向 `complete`;无法继续时**有且只有**抽出的失败路由 |
| 2 | **真 `/events` handler 集成**(非 mock 200):真 StateStore + enrolled 节点,对**每种可 dispatch 的 capability**,用**测试 1a 从真 prompt 抽出的那个 terminal-failure token**(不是写死字面量)构造 body | 非 409;session `blocked`;`terminal_at` / `terminal_lifecycle_id` 已 stamp;lifecycle revision 已 bump;`workflow_run` `held`;`generalized_declared_blocked` 事件带 sourceEventId+digest+activation/attempt;**该 attempt 无 `workflow_node_completion` receipt**;alert outbox 恰一条且含 summary;**hook spy 证明 CommDB/display 投影被 enqueue** |
| 3 | **真 loopback marker 重放**,同样喂抽出的 token | marker 被**删除**(不是 quarantine,也不是永久 `transient_failed`);事实同测试 2;**外加 R2 #2 的窗口**:DB 已提交、4 次响应全丢 → 随后 marker replay 必须幂等结算(不重复告警、不再写事实) |
| 4 | dispatcher | 有 declared-blocked 事实的节点不产生 `rollbackDeadWorkflowNodeExecution`;`FLYWHEEL_ENGINE_DEAD_EXEC_SWEEP=0` 下同样不盲换(run 已 `held`);重启后告警仍恰一条 |
| 5 | **FLY-1505 红线回归** | fixture = **enrolled generalized + `approved_to_ship`**;覆盖 `blocked` 的 live/marker × merged/non-merged **四格**(R2 #3),外加 `ship_attempt_failed` 的 non-merged;每格断言:落到 deflect 而**非** `generalized_declared_blocked`,且 status / question binding / head-bound approval 不变;并断言 settle outcome + receipt;**alert 投递失败时 marker 必须保留** |
| 6 | authority + outcome table 穷尽(R1 #4 / R2 #2 / R3 #1 #3) | 多 activation 无 exact activation → fail closed;同 sourceEventId 不同 digest / 不同 activation-attempt → conflict;**两次独立 CLI 调用同一 attempt(不同 sourceEventId)→ alias 结算,不重复 hold/告警**;operator 预先 `held` 的 run;CAS 竞态丢失 → 重新分类而非抛错;superseded owner → `stale_execution_superseded`;**每一种 no-out terminal 状态**(含 `completed`)都有确定 disposition;**declared receipt + completion receipt 的永久矛盾 → severe 告警 + 不再重试**;并断言 stale/terminal marker 的最终去向(deleted / closed) |
| 6b | **崩溃窗口(R3 #6)** | 事务提交后、投影 enqueue 前抛错 → 重启 + marker replay 后 CommDB/display 收敛(不能因为幂等分支跳过而永久漏投影) |
| 6c | **FLY-1505 receipt(R3 #2)** | 两个 summary/head 完全相同的 marker 不得互相假授权;新 series 覆盖聚合后老 marker 重放仍能正确结算;重复丢响应不产生重复语义结算 |
| 6d | **跨 outcome 幂等(R4 #1)** | deflect 已提交 + 响应与告警都丢 + session 合法演进到新 review 轮 → 重放**保留新状态、不写任何 declaration 事实、重新 await 原告警、删除 marker** |
| 6e | **FLY-869 定序(R4 #2,范围收回后)** | live/marker 各覆盖:「approved 但 ship-ineligible + merged 证据」必须落 FLY-1505 deflect(不被 FLY-869 preflight 抢走);「非-approved + merged 证据」两 carrier **一致** 409 fail-closed、发 severe 告警,且**必须走 `settlement_conflict` 终态**:boot-drain 与 Heartbeat 各配 dead tmux,断言**本 marker 路径**不写任何 declaration/deflection/session/run 状态、**绝不**调用 `applyQuarantineFallback`。**不断言跨 tick 无替换**(那需要 F4 的 durable fence,见 A4c)。外加 CLI 层拒配的单测(**CLI 只是纵深防御,不能替代任一 sink 测试** —— 本地 CommDB activation 可以合法缺席,StateStore 侧准入才是权威) |
| 6f | run 状态穷尽(R4 #3) | `workflow_run` 为 `completed` 时的重新分类;同 attempt 但**不同 execution** 的提交**不得**被当 alias 关闭 |
| 6g | **无 activation 的 exact replay(R5 #4)** | 原始 body **不带** `workflowActivation`,且该 execution 后来有了另一个 activation → 重放必须返回**原 outcome**,不得判 conflict、不得按当前 ownership 重新分类 |
| 6h | **per-outcome alert 义务(R5 #2)** | 四种 FLY-1505 outcome 各做一次「响应丢失后重放」;`stale_attempt` / `unknown_head_skipped` 必须**直接关闭且不发告警**(对齐 `complete-marker-reconciler.test.ts:434-482`) |
| 6i | **`settlement_conflict` 不落 legacy fallback(R5 #3)** | boot-drain 与 Heartbeat 各配 dead tmux:无 fallback 强改状态、无替换重派、run 被 hold/fence;authority 损坏时零 mutation |
| 7 | **反向验证** | (a) `admitGeneralizedRoute("phase_design_complete", genericCaps).kind === "rejected"`;(b) 变异①:失败 token 换成引擎不接受的值 → checker 必须红;(c) **变异②(R2 #5 / R3 #4,决定性)**:失败 token 换成该节点**合法的成功路由**(generic → `no_code`)→ 语义 checker 必须红,**且必须遍历每一个被判为失败的 occurrence(含 onboarding 来源与 role 来源)逐个替换**,不是只换块里那一个;(b)(c) 都必须**同时断言替换确实发生、且被 extractor 捕获**,否则变异测试自己就是假绿;(d) `commitEnrolledCompletion` 对 `blocked` **仍**返回 `route_mismatch`(字节兼容哨兵) |

**测试 2/3 是「一处真相」的真正证明面**:模板教什么 token,就把**那个 token** 喂进真 sink 走一遍。测试 1a 只是快速面,单独不足以判绿。**7(c) 是 issue 判据的直接落实。**

> 可行性已核:`complete-marker-reconciler.integration.test.ts:69-239` 已有真 Express listener + 真 StateStore + FSM + marker 文件 fixture 可复用;7(b)(c) 的 in-memory prompt 字符串替换在本仓 Vitest 3 下无需 module mock 或改源码。

## 4. 真机验收(验收标准 ①②)

隔离 QA slot(`test-slot-1`,FLY-529 房),不碰生产 DAG:

1. 起真 `generic` generalized node,指令让它走终态失败路径;
2. **成功落地**:CLI 打印 `session_completed delivered`,不是 `409` / 不是 `FAIL-CLOSE`;
3. **无 quarantine 也无残留**:`~/.flywheel/state/complete-failed-quarantine/` 与 `complete-failed/` 前后 portable file-set 快照,均无新增遗留;
4. **Lead 侧可见**:Lead 收到带 runner `--summary` 原文的阻塞通知(真 Discord E2E);
5. **不盲换**:3 个退避窗口(60s/5min/15min)内该 node 没有被重新派工,且 run 为 `held`;
6. **对照组**(否则会被当「设计如此」):同房跑一个正常完成的 `generic` node,证明成功路径未受影响。

## 5. 明确不做

- ❌ 不放宽 `commitEnrolledCompletion` 的路由校验(测试 7c 作哨兵)
- ❌ 不让 pinned snapshot parser 读 live registry(R1 #8)
- ❌ 不改 `DirectEventSink` / `TeamLeadClient` 的 teardown 语义(§1 carrier authority)
- ❌ 不改 DAG 模板选择逻辑;不加 feature flag
- ❌ 附带观察 ①②③ 不在本单动手(§6)

## 6. 建议单开的四个 follow-up

| # | 标题 | 落点 |
|---|---|---|
| F1 | `ask` 的 nudge 401 信号与真相反向 | `lead-inbox-nudge.ts:81-85` 文案改写(不可被读成「没存下」)+ 连续 nudge 认证失败作为运维信号浮出(它意味着**每一条** Runner→Lead 通知都降级成慢轮询) |
| F2 | progress lock 报错掩盖 ENOENT | `progress.ts:389-406`:`catch (err)` 分流 —— `EEXIST` 才算被占(重试);其它一律按真实 errno 立即失败 |
| F3 | **no-write generalized node 的 PROGRESS LEDGER 自相矛盾** | baseline-rules 要求每步跑会 `git commit` 的 `flywheel-comm progress`(`progress.ts:186-209`),而同一提示词对 no-write node 写着「do not create commits」。对 `gate`/`land`/`generic`/`review` 四种节点全部成立。**与本单同根**:baseline-rules 按 legacy runner 写就,注入 generalized node 时从未按该节点钉死的 capabilities 对过账 |
| **F4** | **FLY-869 merge-block 对 generalized execution 覆盖不全**(本单调查中发现,**范围收回**) | `setMergeBlock`(`StateStore.ts:6831-6853`)只写可变的 head-bound session 列 —— 无 per-source-event receipt、不动 `workflow_run`;preflight 的 `!merge_block_reason` 闸门一旦被首次写入满足就不再能证明「本事件已结算」;对 running 的 generalized 节点会让 run 停在 `active` 而 dead-exec sweep 又跳过它 → DAG 搁浅。真修需要 immutable receipt + 原子 fence + 恢复状态机(而 `claimWorkflowPrFinalization` 拒绝非 `active` run,`held` 对现有 approval writer 不可见)。**这是 FLY-1581 暴露出来的既有缺陷,不是它的缺陷**;若将来要放开「非-approved merged 失败声明」,F4 是前置 |

> F3 值得优先:与 FLY-1581 是同一病灶的两个症状。治本是**让 baseline-rules 的注入按 node capabilities 分流**,而不是逐条打补丁。

## 7. 风险

| 风险 | 缓解 |
|---|---|
| 新分支吃掉 FLY-1505 deflect → 作废活着的 founder 批准 | §2 A3 顺序红线(1 在 2 前,**不带 landing 限定**)+ 测试 5 打 live/marker × merged/non-merged 四格 |
| marker 永久 `transient_failed` 无限重放 | §2 A4 以 **exact receipt** 为主证据(不看当前状态),允许 `held→terminated` 等合法演进 + 测试 3/6 |
| 空 handler 也能骗过 settlement → 删掉唯一 marker | §2 A4:approval preservation 降为负向断言;主证据必须是 `settleShipAttemptFailed` 写下的持久化 receipt |
| 首次已提交但响应丢失 → 幂等重放被自己拒 | §2 A2 outcome table:**先认 exact receipt,再做 `active→held` CAS** + 测试 3 的丢响应窗口 |
| run 停在 `active` 搁浅 / sweep 被关就失效 | §2 A2 在提交事务内按 run-state 表处理(`active` 才 CAS,0 行则重新分类);dispatcher 仅 backstop + 测试 4 覆盖 sweep-off |
| 同一 source event 产生两条互斥 receipt(deflect 后会话合法重开) | §2 A2 **Key 0 全局 receipt 前置查**先于任何当前状态分流;marker 侧同样前置查并重 await 原告警 |
| FLY-869 merged-marker preflight 抢在 deflect 之前 → live 与 replay 语义分叉 | §2 A4c 显式定序;非-approved merged 失败声明**收回为 fail-closed**,不在本单结算(深层修复 → F4) |
| **已知残留(R9,不掩盖)**:未授权合入的 generalized execution 在本单 fail-closed 之后,仍可能被后续 tick 的通用 crash/orphan 处理转 `failed` 并进而被盲换 | 本单**不声称**能挡住;挡它需要 F4 的 durable fence。已在 §2 A4c 明写保证边界 |
| **新 status writer 漏掉 terminal lifecycle → 几周后 ask 悄悄被 sweep 吃掉** | §2 A2 步骤 2/3 强制 `applyTerminalTimestamp` + lifecycle revision(`StateStore.ts:4127-4139` 的硬要求)+ 测试 2 断言 |
| StateStore 已 blocked 而 runner CommDB 仍 running | §2 A2 事务外经既有 hook enqueue 投影(`commdb-fsm-reconcile.ts:50-58` 不会替你收敛)+ 测试 2 hook spy |
| 迟到 marker 阻塞错误的 attempt | §2 A2 复用 completion 的 activation/turn/current-owner 语义 + 测试 6 |
| **合同测试假绿:模板把失败写成节点的合法成功路由** | §3 extractor 分类 + 测试 1a 断言语义种类(非「非 rejected」)+ **测试 7(c) 变异②** |
| 合同测试假绿:extractor 没匹配到也算过 | 测试 1a/1b 强制断言文件数/occurrence 数/全部解析成功;变异测试自身也断言「替换发生且被捕获」 |
| submission-credential 节点收到互相矛盾的终态指令 | §2 A6 #3 同步改写 `Blueprint.ts:1611-1615` 的绝对句 + 测试 1c |
| 节点用 declared-blocked 逃避该做的活 | 它是终态、run 直接 `held`、必然惊动 Lead(带 summary 原文)——比今天「静默 quarantine」可见得多 |


## 8. Codex design review 留下的实施注记(非阻塞,R10)

1. **拆开测试 6i 的两类 fixture**:`settlement_conflict` 有两类,断言不同 ——「事实齐全但互斥」那类要断言 durable hold/fence + 无替换;「authority 损坏 / A4c 那类」只断言 durable alert 被接受、无直接状态写入、不进 legacy fallback,并**继承 A4c 写明的后续 liveness 残留风险**(不得反过来声称永久压制)。
2. **钉死毒 marker 的文件去向与拒绝判别码**:按 A4c 二选一(durable alert 接受后 unlink,或移入 evidence quarantine 且不走 fallback),断言最终位置;并用一个**稳定的 409 reason**,避免 reconciler 把这条分支和别的不可重试拒绝搞混。
3. **CAS 重新分类要保住事务原子性**:若 `active→held` CAS 改到 0 行,必须在**提交任何 session/event/outbox 部分写入之前**重新分类。§2 A2 的「一个事务」不变量是权威的,即使实现内部的字段写入顺序与文中编号不同。

## 9. 评审过程留痕

| 轮次 | findings | 关键收获 |
|---|---|---|
| R1 | 8(3 blocker) | marker 重放不会「自动跟随」;FLY-1505 deflect 在 generalized 分支不可达;run 没真的 `held` |
| R2 | 7(4 blocker) | **验收本身无效**:模板把失败写成节点合法成功路由时测试照绿 |
| R3 | 7(3 blocker) | 每次 CLI 调用新 `sourceEventId` → 幂等表不穷尽;失败命令在块外也存在(role 内容 + onboarding) |
| R4 | 5(2 blocker) | 跨 outcome 幂等;FLY-869 preflight 是第三条排序义务 |
| R5 | 4(3 blocker) | FLY-1505 聚合不是 exact receipt;`quarantined` 不是终态 |
| R6 | 2(2 blocker) | fence 的告警义务与恢复状态机 |
| R7 | 2(2 blocker) | **触发范围收回** —— 两条都在 FLY-869 既有缺口里,不是本单的 |
| R8 | 1 | fail-closed 409 仍会掉进 legacy fallback |
| R9 | 1 | **我的验收句超出了保证范围** → 改为诚实标注残留风险 |
| R10 | 0 blocker | **APPROVED** + 3 条实施注记 |
