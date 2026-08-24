# FLY-2018 writer_replacement 重生体连环夭折与静默停摆 — 实施计划

Issue: FLY-2018 (https://linear.app/geoforge3d/issue/FLY-2018/enginebug-writer-replacement-重生体-spawn-与同名窗清理竞速ensure-heldstatusnull)
日期: 2026-08-23
基于: research.md
版本: R8(已折入 Codex design review R1(7)/R2(6)/R3(5)/R4(4)/R5(3)/R6(3)/R7(1)全部反馈)

## 0. 计划总览

审计(research.md)裁定:真凶是 codex 账号 refresh token 撤销(每具重生体继承同一份死凭据 → turn 秒败 `unauthorized` → goal blocked → 引擎再铸 → 再死),issue 原三修点重定位为四个 Fix:

| Fix | 一句话 | 治的层 | 包 |
|-----|--------|--------|-----|
| A | turn error 上抛:结构化 `failureCode` + 净化后的错误文本,从 daemon 通知流一路落到 sessions.last_error 与告警 | 诊断信号全链丢失 | claude-runner + core + edge-worker + teamlead |
| B | 环境类失败断路器:同 node+attempt **紧邻前一具**尸体同 `failureCode` 且属环境类 → 提前 held + 真因告警,不烧完盲换配额 | 换体治不了的死因空转 30 分钟 | claude-runner 分类 + teamlead 引擎 |
| C | ensure 包装 provenance(修点①):close signal/终止来源落日志;成功 stdout + 退出异常 → 共享 deadline 内 re-verify 后按成功;自家 abort 打 cancelled 不打 held | 误导性日志(本次把整条诊断链带偏的那条) | claude-runner |
| D | 退避可见性(修点②残余+③):generalized-terminal 时经既有 Lead-event 通道告知「最早 ~T 重新检查替换资格」;kill「窗不存在」与真失败分开(kill-first,失败后 re-list 取证);purge 不死锁回归测试 | 退避窗外观像死机 | teamlead + claude-runner |

**明确不做**:同名窗竞速收敛机制(证据裁定竞速不存在,FLY-1239 purge 已提供 ≤1 窗可证不变量);auth 轴自愈(凭据预检/rotation-on-unauthorized,属 FLY-513 相邻账号族,报 Lead 分诊);恢复 run 8bfa33b2(现 held + 【需人工】已送达,属 operator/Lead 决策);新增退避状态表(R1-4 裁定改由既有 ledger 派生,零新状态)。

## 1. Fix A — turn error 上抛(诊断链)

现状:`codex-daemon-client.ts` 的 `onNotification` 只提取 turnId(:728-735),turn 终态 error 被丢弃;下游 `sessions.last_error` 管道存在且工作(生产尸体 last_error = 固定文案「goal ended non-complete: blocked」为证)。

### 1.1 结构化失败元数据的端到端契约(R1-1)

单一 typed 契约,贯穿全链,任何一环缺失即编译红:

- `packages/core/src/adapter-types.ts` `TerminalFailureInfo`(:416)增加两个可选字段:
  - `failureClass?: "environment"` — 分类枚举(v1 仅此一值);
  - `failureCode?: string` — 稳定机器码,形如 `codex:unauthorized`(vendor 前缀 + allowlisted code);
  - 诊断自由文本继续走既有 `failureReason`(有界,见 §1.4 净化);**不新增 `failureDetail`**(无消费者,R1-1 裁定删除);
- `packages/edge-worker/src/ExecutionEventEmitter.ts`:failure 对象原样携带新字段;
- `packages/teamlead/src/bridge/event-route.ts` `asTerminalFailureInfo`(:208):解析并校验新字段(class 仅接受枚举值、code 仅接受 `^[a-z][a-z0-9-]*:[a-z][a-z0-9_-]*$`,不符即丢弃该字段、保留其余);`DirectEventSink` 同步;
- `StateStore.recordEnrolledTerminalSignal`(:29155;计划 R1 稿误写为 `recordGeneralizedTeardown`,已更正):输入增加两字段;teardown 事件 payload(:29291-29300)**仅在分类存在时 spread 写入**两字段——无分类时省略,payload 与现状逐字节一致(R2-5:不写 null 占位);replay 比较把 absent 规范化为同一缺省;**replay equality/conflict 判定纳入两新字段**——同 event UID、不同 failure 元数据必须 conflict,不得静默接受;
- **原子 pair 校验(R2-2)**:两条 ingest 共用一个 runtime normalizer,对 (failureClass, failureCode) **成对**校验:v1 唯一合法组合 = `("environment", "codex:unauthorized")`;任何其他组合(含 regex 合法但未 review 的 `foo:anything`)→ **两字段一并丢弃**(不得只丢一个),其余 failure 字段保留。引擎侧永远见不到未 review 的分类;
- **per-execution 分类权威(R2-2 + R4-3 收紧)**:同一 execution 可能因不同 `sourceEventId`(DirectEventSink 每次调用 `randomUUID()`,DirectEventSink.ts:1204-1213)落多条 teardown 事件。canonical 冻结点 = **该 execution 第一条 attributable failed teardown 事件——含分类缺席的情形**:首条无分类 → 该 execution **永久 unclassifiable**,后到的合法分类只进 audit,不得升级 breaker/disposition(否则 first-write-wins 的 Lead-event payload 会与后升级的 canonical 漂移,`appendLeadEvent` 对 duplicate id 只返回旧 seq 不更新 payload,StateStore.ts:12039-12047);不同 source UID 的后续元数据一律不得改变 canonical——后到差异(含「矛盾」)只 audit + loud log,canonical 保持首条 pair/absence(R6-2 归一,两个方向 classified-first→later-absent 与 absent-first→later-classified 均 zero-drift)。断路器只读这个 canonical projection;
- **canonical finality = 单一 freeze 规则(R3-5 + R5-3 归一)**:首条 attributable failed teardown 的 normalized pair **或 absence** 即为该 execution 的最终 canonical——**任何**不同 source UID 的后到差异(含「矛盾」)一律只写 audit + loud log,永不改变 canonical/breaker/disposition(删除 R3 稿的 contradiction-before-breaker canonical mutation——v1 单一合法 pair 下该输入本不可达,保留会造成双向 payload drift);同 source UID 异 payload 仍走 replay conflict 拒绝;`environment_failure_escalated` receipt 一旦提交即为终局,不存在追溯撤销;
- 端到端测试:HTTP 路径(event-route)与 DirectEventSink 路径各一条,从 emitter 输入到 teardown 事件 payload 逐字段断言;同 source UID 异元数据 → conflict;同 execution 异 source UID 异元数据 → canonical zero-drift(classified-first→later-absent 与 absent-first→later-classified 双向);任意 regex 合法未知 code → 不入账不熔断;无分类 → payload 字节回归。

### 1.2 client 捕获与 goal-generation 绑定(R1-2 + R2-1)

- `runGoalToTerminal`(codex-daemon-client.ts)内部新增 `lastTurnError: { message: string; code?: string; turnId: string } | undefined`;
- **归属权威不得自证(R2-1)**:现有 `turnIds` 集合对 `turn/started` **和** `turn/completed` 都执行 add(:728-735)——旧 goal 的迟到 `turn/completed` 会先把自己注册进集合再通过成员检查,是自证循环,**不能**用作归属权威。合法权威按优先序:
  1. `startTurn` RPC result 中 daemon 确认的 turn id(现 `startTurn` 返回 `Promise<void>` 丢弃 result,:509-530——若实测 result 携带 turn id,改为返回并登记);
  2. 仅由 **post-arm 的 `turn/started`** 通知登记 ownership(error/completed 类通知永不自行注册);并须实测确认 stale prior-goal 的 completed 不会伴随 post-arm started 到达;
- **pre-response 握手(R3-1)**:daemon 允许在 `turn/start` RPC response 返回前就发出终态通知(既有测试 codex-daemon-client.test.ts:2324-2350 与生产排序 :1193-1197 明确保留该窗口)——秒败 unauthorized 恰好最容易落进这个窗口。选 RPC-result 权威时必须仿照仓库既有 `TurnDemux` 模式:每次 owned `turn/start` 前 `beginDispatch()` 建立有界 pending buffer 暂存事件,response 返回后 `claimTurn(turnId)` 只按序 replay 归属该 id 的事件(其余进 diagnostics),RPC failure/timeout/close → `abortDispatch()` 丢弃;契约覆盖**两个** `startTurn` 调用点(initial + phase wake :875);native `goal/set(active)` auto-resume 无 `turn/start` result——该类 turn 或改用 harness 证明安全的 `turn/started` 权威,或**禁用 error capture**;
- error 只在其 turnId ∈ 上述权威集合时记录;**无法归属一律不记录**;
- **同 generation 后续 turn 成功完成 → 清除已记录的 lastTurnError**(旧错误不得跨过成功 turn 存活);
- goal 以非 complete 终态 resolve 时,`GoalRunResult` 带出可选 `lastTurnError`(additive);
- 真 daemon harness 硬前置(§5)扩展为**三问**:(a) turn 终态 error 的方法名与字段路径;(b) 上述两种归属权威哪种实际可用;(c) stale prior-goal completed 的到达形态。**若两种权威均不可证:Fix A/B 整链搁置——不产 class/code,也不做 thread-only 的「真因」文本追加(同样有被旧 goal 污染的风险),保持现状并如实上报 Lead**;
- 五组归属测试(§5)的 fixture 明确绑定到选定的独立权威,不得用 turnIds 自证。

### 1.3 adapter 传播

`CodexTmuxAdapter` `result.failure`(:1218-1222):

- `failureReason`:`goal ended non-complete: blocked — last turn error: <净化文本> [<code>]`(无 lastTurnError 时保持原文案,兼容回归钉死);
- `failureCode`:lastTurnError.code ∈ vendor allowlist(v1:`{"unauthorized"}`)时产出 `codex:unauthorized`;否则不产;
- `failureClass`:仅当 failureCode 产出且属环境类映射(v1:`codex:unauthorized → environment`)。

### 1.4 外部文本净化(R1-7)

daemon error 是外部输入,升级为持久字段与 Lead/LLM 可见文本前必须净化,净化函数单独可测:

- code 与文本分离:分类**只**用 allowlisted code,自由文本永不参与判定;
- message:Unicode code-point 安全截断(500)、折叠为单行、剥离控制字符、转义/去除 Discord mention 样式(`@everyone`/`<@…>`)与反引号栅栏;
- malformed payload(code 非字符串、message 非字符串等)→ 整体不记录,行为退回现状;
- 兼容测试:无 error 时 failure 对象/事件/告警逐字节与现状一致;「byte-compatible」声明仅限这些明确边界。

### 1.5 告警文案

【需人工】告警(`workflowBlindReplacementExhaustedAlertPayload`,StateStore.ts:31727-31750)body 追加死 exec 的 `sessions.last_error`(净化后,截断 300 code points):从「盲换 3 次仍起不来」升级为「盲换 3 次仍起不来,最后死因: <真因>」。

## 2. Fix B — 环境类失败断路器

### 2.1 分类(vendor 知识放 adapter)

见 §1.3:`failureClass = "environment"` 仅由 allowlisted `failureCode` 映射产生。fail-safe 铁律:**分类缺席/未知 → 与现行为字节等价**(继续盲换)。

### 2.2 引擎断路(StateStore.rollbackDeadWorkflowNodeExecution,:32640-33062)

置于 retry_limit 判定(:32768)**之后**、铸体之前(retry_limit 优先级更高,先到先收口):

- **谓词(R1-3 修正)——「连续」必须可证**:
  1. 本次 dead exec 的 **canonical 分类**(§1.1 per-execution 权威)为 `("environment", <code>)`;
  2. 同 run+node+attempt 的**紧邻前一具**尸体(按 launch ordinal 取上一个 dispatch 的 execution,查其 canonical 分类)携带**相同 `failureCode`**;
  3. 两者缺一 → 照常盲换。「先有一具非环境尸体、再有第一具认证尸体」不熔断(前一具 code 不同);canonical 判为不可分类的 execution 永不参与熔断;
- **收口动作 = 复用 retry_limit 的同一段收口代码**(参数化 reason):`run → held`(仅 active 时)+ 事件 kind `environment_failure_escalated`(稳定 UID `env_failure:{runId}:{nodeId}:{attempt}:{failureCode}`,payload 含 failureCode/failureClass/deadExecutionId/priorDeadExecutionId/lastError(净化)/launchCount)+ 告警(复用 blind-replacement alert 管道,标题「【需人工】…环境类失败(<code>),盲换无法治愈」);
- **重放与冲突语义(R1-3)**:同 UID 重复调用 → idempotent replay 返回既有结果;同 UID 异 payload → conflict 拒绝;断路分支**不 mint replacement、不写 capability mutation、不推进 launch ordinal**(测试逐项断言);
- **恢复契约(R2-3 修正——按源码真实能力收窄)**:`openOperatorRework` 的 held eligibility **不含** `retry_limit_escalated`(StateStore.ts:31199-31208 返回 `run_not_reworkable`),既有 exhaustion alert 只暴露 terminate(:31750-31752)。因此:**held 后唯一入口 = 告警中的 terminate 收口;凭据修复后由既有外部流程另起 run/attempt**。告警 body 如实写这条路径,**不承诺 rework/restart**;本单不扩展 held allowlist/恢复面。测试断言 environment hold 与 retry_limit hold 都被 `openOperatorRework` 以 `run_not_reworkable` 拒绝;
- 跨 attempt/rework 不继承:谓词按 (run, node, attempt) 域取「紧邻前一具」,attempt 边界天然隔离(测试钉死);
- `repeated_dead_execution_pattern`(:33041-33057)保持纯事件不变;`alertIdentity` 缺席时事件照写 + loud console log(不静默)。

### 2.3 显式非目标

不改 `MAX_BLIND_REPLACEMENTS`、`retryDelaysMs`;不做 auth 自愈(报 Lead 另立 issue,FLY-513 相邻)。

## 3. Fix C — ensure 包装 provenance(修点①)

### 3.1 spawnCommandAsync(codex-runner-tui-window.ts:373-450)

- 结果类型 `EnsureSessionSpawnResult` 增加:`signal: string | null`(close 事件第二参数)、`terminated: "timeout" | "abort" | null`(内部终止来源:timer 先触发记 timeout,onAbort 先触发记 abort;未终止为 null);
- `status` 折叠语义不变(terminationRequested → null),provenance 字段让消费者区分三种 null:内部 timeout / 内部 abort / 外部信号杀(terminated=null ∧ signal 非 null)。

### 3.2 ensureSessionWithRetry{,Async}(:242-354)

status !== 0 时:

1. 解析 stdout JSON:`action ∈ TMUX_ENSURE_SUCCESS_ACTIONS ∧ Number.isSafeInteger(reachablePid) ∧ reachablePid > 0` 记为 helper-success(把 `TMUX_ENSURE_SUCCESS_ACTIONS` 从 TmuxAdapter.ts:1785 提为共享导出,两包装对齐);
2. **helper-success ∧ 非 abort 退出异常**(外部信号杀/内部 timeout):补一发轻量 re-verify(注入 seam,生产 = `tmux -S <socket> has-session -t =<session>`)。**预算 = `min(5s, 共享 deadline 剩余)`,贯穿同一 AbortSignal,返回 success 前再检一次 abort——取消必须胜出**(R1-6)。verify 通过 → 返回 true,日志 `ensure attempt N succeeded despite exit anomaly (signal=…, termination=…) — helper reported <action>, re-verified`;verify 不过/预算不足/中途 abort → 维持 held/cancel 语义;
3. **abort 导致的退出**:日志改为 `ensure attempt N cancelled (<signal.reason>) after helper output <action|none>` ——不再打「held」;返回语义不变(false → 外层既有 cancellation 分支);
4. 其余 held 日志追加 `signal=…, termination=…`;argv、deadline、1 秒退避、attemptCap 全部字节不变。

sync 版 `ensureSessionWithRetry` 的对齐**限定为**(R2-6):helper-success stdout 解析、deadline 受限的 re-verify、provenance 日志——`EnsureSessionWithRetryOptions` 没有 `signal`(:201-219),同步 `spawn` 也无法在执行中响应取消,**cancellation-wins 语义只属于 async 生产路径**;sync 测试只覆盖非 abort 的 anomaly,不宣称两者行为完全相同。

### 3.3 killRunnerTuiWindow 取证顺序(R1-5 修正:kill-first,不做 probe-before-kill)

保持现有「先 kill」行为逐字节不变;**仅当 kill 返回非 ok 后**,以不可变 windowId(无 id 时用精确名 `=session:=name`)做一次有界 re-list 取证:

- 证明不存在 → `kill skipped — window already gone (<windowName>)`(info,常态);
- 查询失败或窗仍存在 → 保留现有 non-ok warning(真失败/不可判);
- 三类测试:已不存在 / probe 失败 / 仍存在。

## 4. Fix D — 退避可见性(R1-4 重设计:零新状态、死亡即告知)

### 4.1 派生而非物化

**不建 `workflow_replacement_backoff` 表**(R1 稿方案作废:60 分钟 patrol tick 罩不住 1/5/15 分钟退避窗;新表还要进 FLY-2006 schema registry + prune 契约,成本大于价值)。`next_retry_at` 完全可派生:`workflow_side_effect_ledger` 最新 dispatch 的 `created_at` + 共享退避表(把 `retryDelaysMs = [60s, 5min, 15min]` 从 workflow-engine-dispatcher.ts:1928 提为共享导出,dispatcher 与派生逻辑同源)。

### 4.2 死亡时经既有 Lead-event 通道告知下一步(R2-4 修正)

R2 稿假设的「每尸体既有 session_failed 通知」在 generalized workflow 路径**不存在**:HTTP ingest 在 `recordEnrolledTerminalSignal` 后于 event-route.ts:1131-1138 直接 return,DirectEventSink 的 generalized 分支于 :1204-1232 return,均绕过普通 session 的通知逻辑。修正设计:

- 在 generalized-terminal 分支(**HTTP 与 Direct 两条 ingest 都要**)新增一次向**既有 Lead-event 通道**(`lead_events` / 既有投递面)的写入——不是新 channel、不是新 timer,但如实承认这是**新的通知写入点**;
- **唯一 crash 模型 = 原子 outbox(R4-1,替换 R3 稿的矛盾混合)**:调用方在事务外**只**预解析/冻结 owning-Lead identity(其余 eligibility 全是可变量,不得事务外预判);`recordEnrolledTerminalSignalWithLeadIntent` 在**同一事务**内:先写/重放 terminal fact → **事务内重新读取并验证** run active、current node/execution、latest launch、无 completion、canonical facts、limit 与 `nextCheckDisposition` → 条件式 append `lead_events` 行。原子性保证不存在「terminal 已 commit、通知行缺失」的状态,**不设 backfill 路径**(全新写入点,无历史数据要兼容);投递在 commit 之后;transport 失败/throw 不得伪写 `delivered_at`,由既有 durable inbox/receipt 路径接管重投;
- **稳定 id 带命名空间 + 冻结收件人(R3-3)**:`lead_events` 唯一索引是 `(lead_id, event_id)`(StateStore.ts:3333),Lead resolution 漂移会把同 id 写给两个 Lead。event id = `workflow-replacement-eligibility:{runId}:{nodeId}:{attempt}:{executionId}:{launchOrdinal}`;recipient 复用 workflow-engine alert 的 owning-Lead authority(validated `run.selected_by` → 既有 fallback),resolved lead/routing snapshot 随事件冻结;replay 复用冻结收件人,不重新路由;
- **crash-recovery projector(R5-1 + R6-1 duplicate-quiet)**:`StateStore.listUndeliveredLeadEvents()`(:12248-12273)在生产**无调用者**,`LeadInboxLoop` 只消费 comm.db——原子提交的 undelivered row 若在 enqueue 前 crash,现网没有组件会重投。新增**作用域受限的 outbox redrive projector**:挂在既有 `LeadInboxLoop.admit`/启动 reconciliation 上(零新 timer),每个 Lead loop 只扫描**自身 project/lead** 的 undelivered `workflow-replacement-eligibility` rows。**duplicate-quiet ensure seam**:现有 `enqueueLeadEvent` 无条件 `nudge()`(lead-inbox-runtime.ts:451-462),在 admit 内调用会 `nudgePending` → 无 timer 立刻再跑一轮 → row 仍 undelivered 时形成 hot loop。因此 fast path 与 redrive 统一走 `ensureWorkflowReplacementLeadEventQueued(row)`:按 `seq` 重读同一 journal row → 共用 `leadEventEnvelopeFromJournalRow` 构造 envelope(**字节权威 = journal row**,fast path 不得用 in-memory timestamp/payload——否则 `MailboxQueue` 的完整 projection hash 对同 id 会报 `mailbox identity conflict`,mailbox-queue.ts:434-515)→ 底层返回 `inserted | active | archived`,**仅 inserted 时 nudge**,duplicate 纯 no-op。这是 outbox redrive,不是 terminal→Lead backfill;
- **投递语义如实标注 at-least-once **processing**(R4-2 + R5-2 收窄)**:queue-enabled 路径的 lease retry 会把 batch/member id 改写为 `#r{attempt}`(lead-inbox-loop.ts:457-466),Codex `LeadJournal` 以 transport batch id 为幂等键(LeadJournal.ts:240-273)——跨 transport retry 的接收端 exactly-once **在现协议下不可达**,本单不动共享投递协议(信息性通知不值得改 FLY-1573/1795 机器)。契约如实降为 **at-least-once processing**:重复投递可能产生重复的 Lead turn;通知本体零副作用(纯信息、无任何状态 mutation),payload 携带稳定 `workflow-replacement-eligibility:*` id 供 Lead/人识别重复。测试断言重复投递的通知内容逐字相同且无状态副作用,不承诺「无第二次 Lead turn」;
- **文案按 disposition 分档,绝不宣称已断路(R3-4)**:terminal-signal 时点既无死亡证明也无 escalation receipt(closeout 只在 pacing 结束 + liveness 证死后执行,dispatcher :1928-1991)。共享投影显式返回 `nextCheckDisposition ∈ {replacement_candidate, environment_hold_candidate, retry_limit_hold_candidate}`,通知统一措辞:「引擎最早于 ~<time> 重新检查(盲换 N/3);若死亡确认与 current-execution fencing 成立,将执行 <X:铸替换体 / 环境类收口 / 配额收口>」;
- 已有 escalation receipt(断路/配额已收口)后:既有【需人工】告警即终态通知(Fix A.5/B.2 已带真因),不再附 nextRetryAt;
- **渲染面绑定 stable id(R6-3)**:generic formatter 只显示 `[Event #<seq>]` 等,不渲染 `env.eventId`(mailbox-lead-runtime.ts:333-355 / commdb-lead-runtime.ts:203-225)——「靠 stable id 识别重复」必须落进实际渲染文本。新增共享 `formatWorkflowReplacementEligibility`(两 runtime parity-by-construction),渲染 stable event id、conditional disposition 文案与 frozen timestamp;测试断言两 runtime 输出逐字相同、含完整 stable id,transport retry 输出字节不变。

`next_retry_at` 派生同 §4.1(ledger `created_at` + 共享退避表)。

端到端测试:两条 ingest 各一条形状断言;duplicate replay 不重复送达;stale execution(非 current/非 latest dispatch)零提示;unknown liveness 情形不产生虚假承诺文案。

### 4.3 purge 不死锁回归测试(修点②的收尾)

mock tmux seams 下:同名窗存在 ∧ kill 失败 → `purgeSameNameWindowsAsync` 返回 false → attempt 返回 `stale_window_unproven`(retryable,不 create、不死锁);后续 attempt kill 成功 → created。钉死既有 FLY-1239 不变量,证明「kill 非 ok → 重生撞死」的机制不存在。

## 5. TDD 顺序(实现节点执行,RED → GREEN → REFACTOR)

### 硬前置:真 daemon 通知流取证(§1.2 三问)

用真 codex daemon harness(memory: `reference_real_codex_daemon_qa_harness`,dist 拼真 app-server,不开 529 房)钉死:(a) turn 终态 error 方法名/字段路径;(b) 归属权威哪种可用(startTurn result turn id / post-arm turn-started 登记);(c) stale prior-goal completed 的到达形态。两种权威均不可证 → **Fix A/B 整链搁置**(含文本追加),保持现状并上报 Lead。

### claude-runner(vitest)

1. `spawnCommandAsync` provenance:真子进程外部 SIGTERM → `{status:null, signal:"SIGTERM", terminated:null}`;内部 timeout → `terminated:"timeout"`;abort → `terminated:"abort"`;
2. `ensureSessionWithRetryAsync`:helper 打完成功 JSON 后被杀 + re-verify 通过 → true(RED:现返 held);re-verify 失败 → held;**deadline 剩余不足 → 不 verify 维持 held;abort during reverify → false(取消胜出);成功 stdout 后 SIGTERM → provenance 正确**(R1-6 三测);abort 中飞 → 日志 cancelled 不含 held;垃圾 stdout + 非零退出 → held(现行为回归);
3. `runGoalToTerminal` lastTurnError 归属测试(R1-2/R2-1/R3-1,fixture 绑定选定的独立权威,不用 turnIds 自证):foreign thread 不记录;pre-arm 不记录;post-arm 同 thread stale prior-goal completed(无 post-arm started)不记录;failed-then-success 清除;终态 turn 错误正确带出;**pending-dispatch 五测:response 前 started+error 被 claim 后正确 replay;错误 id 进 diagnostics;RPC rejection → abortDispatch 丢弃;phase-wake startTurn 同契约;auto-resume turn 按选定权威或禁 capture**;
4. `CodexTmuxAdapter`:blocked + lastTurnError(unauthorized)→ failureReason 含净化真因 + failureCode=`codex:unauthorized` + failureClass=environment;blocked 无 error → 原文案、无 code/class(兼容回归);非 allowlist code → 只追加文本不产 code/class;
5. 净化函数(§1.4):控制字符/换行/mention/超长/非法 code 各一测;
6. `killRunnerTuiWindow` 三测(§3.3);
7. §4.3 purge 回归。

### core / edge-worker / teamlead(vitest)

8. `TerminalFailureInfo` 新字段经 HTTP(event-route)与 DirectEventSink 两路端到端落 teardown 事件 payload;pair 原子校验(非法组合两字段一并丢);同 source UID 异元数据 → conflict;同 execution 异 source UID 后到差异 → canonical zero-drift(双向:classified-first→later-absent / absent-first→later-classified,仅 audit + loud log);无分类 → payload 字节回归(R1-1/R2-2/R2-5/R6-2);
9. 断路谓词(R1-3/R2-2/R2-3/R5-3):non-env→env 不熔断;env→env 同 code 熔断;env→env 异 code 不熔断;任意 regex 合法未知 code 不熔断;canonical 不可分类(含 absent-first)不熔断;**后到差异(任何不同 source UID)只 audit、canonical/disposition 零漂移;receipt 提交后到达的冲突只追加 audit 不回滚**;跨 attempt 不继承;熔断重放 idempotent;同 source UID 异 payload conflict;断路分支零 mint/零 ordinal 推进/零 capability mutation;retry_limit 先到时 retry_limit 胜出;environment hold 与 retry_limit hold 均被 `openOperatorRework` 拒(`run_not_reworkable`);alertIdentity 缺席 → 事件照写 + loud log;
10. 【需人工】alert body 含净化 last_error(Fix A.5);
11. generalized-terminal Lead-event 通知(Fix D.2/R3-2..4/R4-1..3/R5-1..2):两条 ingest 各一形状断言;**原子性三测:(a) terminal insert 后、Lead insert 前注入异常 → 两行均不存在;(b) 重试后两行各恰一;(c) commit 后、dispatch 前 crash → terminal 与 undelivered Lead row 均在,重启由 projector 只投递既有行**;**projector 测试(R5-1/R6-1):post-commit enqueue 抛错不重启 → 下一既有 tick 收敛;反复扫描只产生一个 comm.db row;冻结 recipient/payload 从 journal row 读取而非重新解析当前 run;active duplicate + undelivered 时零 nudge、loop 按既有 cadence 调度(不 hot-spin);offline/unknown recipient 不 hot-spin;fast-path 与 redrive 产生逐字节相同的 comm.db projection hash;两个 Lead loop 不交叉扫描/唤醒**;**渲染 parity:两 runtime formatter 输出逐字相同、含 stable id,retry 输出字节不变(R6-3)**;**at-least-once processing:dispatch 已接收、`markLeadEventDelivered` 前 crash → 合法重投,重复通知内容逐字相同且零状态副作用(不承诺无第二次 Lead turn)**;transport 失败不伪写 delivered_at;stale execution 零提示;unknown liveness 无虚假承诺;三种 `nextCheckDisposition` 时序各一测;**unclassified-first → classified-later 不熔断且通知 payload 不漂移**;**Lead resolution 在 replay 前变化仍只写冻结收件人**。

### 真机验证(实现节点)

- 硬前置取证(上);
- 真 daemon harness 重放「unauthorized 秒死」:注入撤销态 auth.json → failureReason 带真因 → 第 2 具同 code 后 run held + 告警带真因(对照本事故 00:13→00:44 的 31 分钟空转)。

### 全仓门(engineer-executor 标准)

`pnpm lint`(全仓)+ `pnpm -r build` + `pnpm test:packages:run` + 相关 shell harness;canonical aggregate 的既有宿主项(headless Terminal.app 等)照实披露不伪报。

## 6. 兼容与风险

| 风险 | 缓解 |
|------|------|
| 环境类误报 → 早停伤可自愈场景 | pair 原子校验仅认 `("environment","codex:unauthorized")`;canonical 权威 + 「连续同 code」谓词;第 1 具仍铸体探测;归属不可证不分类 |
| 通知流字段/linkage 假设错 | 硬前置真 daemon 三问取证;权威不可证则 Fix A/B 整链搁置上报 |
| 迟到的旧 goal turn 错误污染新 goal | 归属权威独立于通知自注册(startTurn result / post-arm started);completed/error 永不自行注册;成功 turn 清除 |
| 信任被杀 helper 的 stdout | 成功裁定必须过 re-verify;预算受共享 deadline 钳制;abort 胜出 |
| failureClass 中途被裁掉 | typed 契约贯穿 core/edge-worker/两条 ingest;端到端逐字段测试;replay conflict 纳入新字段 |
| 外部错误文本进告警/LLM 面 | §1.4 净化 + code/文本分离;malformed 整体退回现状 |
| 引擎路径回归 | 断路复用 retry_limit 收口代码;所有改动 additive + fail-safe 缺省;既有盲换/retry_limit 测试全保 |
| kill 行为漂移 | kill-first 保持逐字节;取证仅在非 ok 后追加只读 re-list |

## 7. 交付物与顺序

1. PR 单个(core + edge-worker + claude-runner + teamlead 同 PR,Fix A 是跨包 typed 数据流);分支 `flywheel-FLY-2018`(现有);
2. 文档随分支:本文件夹三份 + 设计 HTML(design 节点交付);
3. codex code review(`codex:rescue`)loop 至 approved;PR 走正常流,merge founder-gated(FLY-1959:merge 永不即时重启,部署等班车);
4. 给 Lead 的分诊上报(随 DESIGN-HTML 报告附带):auth 轴自愈(凭据快照预检 / unauthorized 触发 rotation / AUTH_EXPIRED 上报)建议另立 issue;run 8bfa33b2 现 held + implement attempt 2 running+死 exec 09932cda,等 operator 决策。
