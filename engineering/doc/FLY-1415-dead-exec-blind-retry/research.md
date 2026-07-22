# FLY-1415 dead-exec 去判断化 — 调研

Issue: FLY-1415 (https://linear.app/geoforge3d/issue/FLY-1415/engine韧性重构-dead-exec-处理去判断化-option-1bridge-只机械换人盲换3-耗尽升级所属-lead删死因分流)
日期: 2026-07-21
基于: exploration.md

## 1. 调研目标

exploration.md 已核实机械骨架与三个 cause-branch 的位置。本文回答实施前的剩余技术问题:精确删除清单与全部读者面、事件兼容、测试改造清单、告警话术落点、以及两个显式决策项的依据。

## 2. 删除清单与读者面核查(grep 全仓核实)

`design_fallback` / `quota_or_auth_failure` / `non_retryable_execution_failure` / `dead_execution_after_output` / `retry_limit_escalated` / `approved_design_fallback` 的直接出现文件 = 生产码 4 + 测试 3(无 dashboard / DecisionLayer 消费)。**Codex R1 补漏的间接读者面**(plan §3.2.4/§3.4 已收编):StateStore `admitGeneralizedWorkflowExecution` 的 `dispatchResolution.source` 联合(:15140)、`WorkflowEngineAlertPayload.metadata` 独立联合(:20781)、`infra-alert-wiring.ts:77-88`(读 `workflowEngine.executionId/issueId` 做 issue-thread 路由,本单不动这两字段)、`resolveNodeDispatchAtLaunch` 的另两个生产调用方 actions.ts/runs-route.ts(不传 flag,删可选参数零改动):

### 2.1 `workflow-engine-dispatcher.ts`

| 位置 | 内容 | 处置 |
|---|---|---|
| :79-93 | `NON_RETRYABLE_RESOURCE_FAILURE`、`APPROVED_FABLE_UNAVAILABILITY` 两个正则 + 两 helper | 删 |
| :472-481 | `resourceFailure` / `approvedDesignFallback` 判定(读 `session.last_error` 文本) | 删 |
| :483-496 | pacing 门 `!resourceFailure && !approvedDesignFallback && launches.length < 4` | 改为 `launches.length <= MAX_BLIND_REPLACEMENTS`;延迟梯 [60s, 5m, 15m] 原样保留 |
| :553-557 | `disposition` 三元(design_fallback/hold/retry) | 删,恒 retry |
| :561 | `if (disposition !== "hold")` 才采 tripwire baseline | 删条件,恒采集(baseline 采不到→hold this tick 重试,原逻辑保留) |
| :586-590 | `reason` 三元 | 恒 `"terminal_session_and_dead_probe"` |
| :816-838 | launch 侧扫 `execution_dead_rolled_back` 事件找 `retryDisposition==="design_fallback"` | 删整段;`resolveNodeDispatchAtLaunch` 调用不再传 flag |

### 2.2 `StateStore.ts` — `rollbackDeadWorkflowNodeExecution`(:16529)

| 位置 | 内容 | 处置 |
|---|---|---|
| :16538 | 入参 `retryDisposition?: "retry"\|"hold"\|"design_fallback"` | 删入参;event payload 恒写 `retryDisposition:"retry"`(schema 兼容,见 §3) |
| :16661-16683 | `hold` 分支(non_retryable → held + 告警) | 删 |
| :16684-16721 | `dead_after_output` 分支(→ held + 告警) | 删(后果分析见 exploration §2.5;耗尽告警 metadata 增补 `outputExistsForAttempt` 机械事实) |
| :16729 | `launchCount >= 4` | 改 `launchCount >= MAX_BLIND_REPLACEMENTS + 1`(数值不变;常量唯一权威 = `StateStore.ts` 导出,dispatcher 沿现有依赖方向 import,Codex R2 裁定) |
| :16833-16881 | 第 2/3 次盲换时的两条 `repeated_dead_execution_pattern` Discord 告警 | **决策项 B**:删两条告警,保留 run event 行 |
| :16883-16889 | `design_fallback` enqueueAlert | 删 |
| :16015-16050 | `workflowEngineAlertPayload`(held/design_fallback 双形态 + API 细节进 body) | 重写:只剩耗尽形态,人话 body,API/id 细节移 metadata |
| :16052-16089 | `workflowDeadExecutionAlertPayload` 的 `repeated_dead_execution_pattern` 分支 | 随决策项 B 变成死码 → 删(tripwire 的 `dead_execution_activity_after_replacement` 分支保留) |

### 2.3 `workflow-dispatch-resolution.ts`

`approvedDesignFallback` 入参(:46,:59-74)、`APPROVED_FALLBACK_SOURCE_MODEL`/`APPROVED_FALLBACK_TARGET`/`APPROVED_REPLACEMENT_MODELS`(:24-33)、source 联合成员 `"approved_design_fallback"`(:20)→ 全删。生产调用方 3 处(actions.ts / runs-route.ts / dispatcher),仅 dispatcher :833 传该 flag(可选参数),删参后其余两方零改动。

### 2.4 `LeadAlertNotifier.ts`

`AlertMetadata.workflowEngine.disposition` 联合(:355-360)删 `"design_fallback"`、`"repeated_dead_execution_pattern"` 成员(纯类型;metadata 不进 Discord 文本,AutoRepairBot 只读 `runnerStuck`/`accountLimit` 等,不读本 disposition → 无行为面)。

## 3. 事件与回执兼容

- `execution_dead_rolled_back` payload **保留** `retryDisposition:"retry"` 字段:幂等回执比对(:16587)读该字段;新代码只会写/比 `"retry"`。
- 历史 `design_fallback` 回执行:重放不可达 —— sweep 的 `latest.execution_id !== node.execution_id` 守卫(dispatcher:471)保证已换过人的死执行不再进入 rollback;launch 侧扫描删除后,旧事件只剩审计价值。无迁移。
- `non_retryable_execution_failure` / `dead_execution_after_output` / `retry_limit_escalated` 事件 kind:前两者不再产生(历史行保留,append-only);`retry_limit_escalated` 继续产生(payload 不变)。
- `workflow_dead_execution_watch`(FLY-1385 tripwire)结构与写入点完全不动;删 hold 分支后**每次**盲换都带 baseline 建 watch(现状 hold 不建 watch,删后语义更均匀)。

## 4. 两个显式决策项的依据

### 决策项 A:上限数值保持「4 launches = 3 盲换」(✅ 已裁定:Lead 回复 ask `7d9f5e08` 确认「数值不改,显式化常量消歧」,并将给 issue 补勘误)

- Annie 原话「最多换三次」、issue 标题「盲换≤3」、验收 #3「换 3 次后停手」、issue #3 话术样例「换了 3 次仍起不来」、FLY-1411 正文读码结论 —— 五处一致指向 **3 次替换**。
- 现状 `launchCount >= 4` 恰是 3 次替换后升级;issue #2 的「4→3」把 pacing 门 `launches.length < 4` 误读为上限。字面照改会得到「只换 2 次」,违反验收 #3。
- 取向:数值不动,显式常量 `MAX_BLIND_REPLACEMENTS = 3` 同时表达 pacing 门与升级门(告警 metadata/话术亦从该常量插值,plan §3.2.2)。(历史注:曾预留「若裁定总 3 launches 则改常量」的分支,Lead 回复已排除,见上。)

### 决策项 B:删中途 repeated-dead 告警(第 2/3 次盲换各 2 条 Discord)(✅ Codex design review R1/R2 同意,带约束:事件行写入只依赖机械计数,与 alertIdentity 解耦)

- Option 1 的合同是「自愈不打扰、耗尽才升级、升级信号强」。保留中途告警则 3 连死场景 Lead 收 5 条(2×2 中途 + 1 耗尽),信号稀释,且其话术(「Inspect the liveness classifier」)是 FLY-1385 时代的工程判断残留。
- 保留 `repeated_dead_execution_pattern` **事件行**(审计/取证;耗尽告警 metadata 里也带 launchCount,Lead 一眼可见换了几次)。
- 验收 #2「换 1 次自愈不打扰 Lead」现状即满足(首换本无告警);决策项 B 把「不打扰」延展到第 2/3 次,与「耗尽才升级」对齐。

## 5. 行为变化(删分流的直接后果,plan 里如实写)

1. **配额/auth 死**:从「首死即 held + 告警」变为「盲换 3 次(60s/5m/15m pacing,约 21 分钟)后才升级」。代价:真配额死到 Lead 慢约 21 分钟。收益:(a) 文本正则误判(FLY-218 教训:「not your usage limit」类反例)不再把健康 run 插死;(b) FLY-696 账号轮转生效后,盲换给了配额死自愈机会 —— 换人时新账号可能已就位。
2. **Fable 不可用**:删除的仅是「按死因自动换 GPT-5.6」;替补 launch 照常走 dispatch-at-launch policy(config/live-template 漂移仍可改变 vendor/model,与死因无关,是既有 contract)。耗尽后 Lead 判断换模型/等待。
3. **死但有输出**:盲换;替补因 output append-only + 完成回执归属约束**无法完成** —— 若替补随后退出,盲换有界(≤3)后升级 Lead;若替补保持存活,归既有 idle-stuck 路径 + Lead 判断(接受的 live-but-doomed 风险,plan §4.3/§5.2.6)。metadata `outputExistsForAttempt:true` 让 Lead 直接看到「其实活儿可能已经干完了」。

## 6. 测试改造清单

### 6.1 改写(断言现有 cause-branch 的)

| 测试 | 现断言 | 改为 |
|---|---|---|
| fly1385 :640 「holds…after the dead execution wrote output」 | 有 output → held | 有 output → 照样盲换(`ok:true`,新 execution 分配) |
| fly1385 :980 「holds non-retryable quota/auth deaths and durably retries their alert」 | 配额死 → held + 告警重投递 | 配额死 → 盲换;**告警重投递的 durability 覆盖迁移到耗尽告警**(同一 outbox 机制) |
| dispatcher :1375 「holds quota/auth deaths immediately…」 | 同上 dispatcher 层 | 配额 last_error → 走盲换同路径 |
| dispatcher :1426 「uses only the approved design Fable to GPT-5.6 fallback…」 | design fallback 换模型 | 删 |
| dispatcher :1470 「holds a design Fable quota/auth death…」 | 两分支优先级 | 改造成**同路径测试**:quota 文本 / unavailable 文本 / null 三种 `last_error` → 逐字段相同的 rollback 结果与事件(验收 #4 的单测形态) |
| dispatcher :1263 「alerts when the same node needs a second dead-execution replacement」 | 第 2 次换 → 告警 | 第 2 次换 → **无**告警,事件行仍写(决策项 B) |
| dispatch-resolution :220 「…allows only design Fable to GPT-5.6 fallback」 | fallback 白名单 | 删 fallback 段,保留 escape-switch 段 |

### 6.2 保留不动(守卫已在)

fly1385 :670 耗尽升级(3 换后 held)、dispatcher :374 pacing 梯、:599/:786 无死证不修复、:875 终态+死证才换、:908 kill switch、:952 baseline 采不到不换、:1322 unknown×3 告警不动节点、tripwire/TTL 全套。

### 6.3 新增(验收 #5 的守卫/突变)

1. **pane_dead 突变测试**:直接对 `probeRunnerProcessLiveness` 的映射断言 —— 仅 `dead_pin`/`absent` → `"dead"`;`alive`/`indeterminate` → 不产生死判(已有部分覆盖,补突变形态:任一 pane `pane_dead=0` 必须 alive)。
2. **idle 不入死亡路径守卫**:session 状态非终态(working/awaiting_review)+ 无 teardown fact 时,sweep **连探针都不调**(probe spy 断言 0 调用)→ 长任务慢但活着永不被换。
3. **同路径断言**(§6.1 dispatcher :1470 改造)。
4. **耗尽告警形态**:body 人话(含「换了 3 次」,自常量插值)、无 API 端点字样;metadata 含 runId/nodeId/executionId/launchCount/maxBlindReplacements/outputExistsForAttempt/`management.terminate`。

### 6.4 真机验收(implement/QA 阶段执行,plan 只定场景)

隔离房(529 房配方,memory 有 recipe)四场景:①慢但活(pane_dead=0)注入 → 观察 N 分钟零换人零告警;②首死次活 → 恰 1 次换、零告警;③every-spawn-dies → 恰 3 次换 + run held + 所属 Lead 的 Discord 频道收到人话告警;④quota 文本死 vs 普通死 → DB 事件序列逐字段同构。注意 QA 环境需 `FLYWHEEL_DELIVERY_SECRET_PATH` 等隔离 env(memory:529 房配方)。

## 7. 告警话术落点(并入 FLY-1411)

- 重写后唯一的 rollback 告警 = 耗尽告警。规格:
  - title:`【需人工】<issueId> 节点 <nodeId> 盲换 ${MAX_BLIND_REPLACEMENTS} 次仍起不来`(次数自常量插值,plan §3.2.2)
  - body:`<issueId> 的 <nodeId> 节点换了 ${MAX_BLIND_REPLACEMENTS} 次仍起不来,引擎已停手,run 已挂起(held),需要你判断下一步处理。`
  - metadata.workflowEngine:`{ runId, issueId, nodeId, executionId, disposition:"held", launchCount, maxBlindReplacements, outputExistsForAttempt, management:{ terminate:"POST /api/runs/<runId>/terminate" }, leadResolution }`(metadata 不进 Discord 文本,是 bot/取证面;只列已验证合法动作 —— `hold` 对已 held 的 run 返回 `run_not_manageable`,故不列)。
- 收件人链路(已核 + Codex R1 补漏):StateStore outbox → dispatcher claim-before-send → routedAlertSink → LeadAlertNotifier `resolveLead(payload.leadId)` → 所属 Lead 频道。**但 leadId 解析需要动**:现 plugin.ts:5253 在 issue 无 session row 时静默降级全局默认 Lead,而 rowless teardown 是 dead-exec 已支持的恢复形态 —— 修为 `run.selected_by`(durable 权威)→ session labels `resolveLeadForIssue` → loud fallback 三级链(plan §3.1b)。真机验收核对**实际所属 Lead 身份**收到 + Lead 转述 founder-facing(那一跳是 Lead LLM 的职责,不是代码)。
- probe_unknown ×3 告警话术不在本单(非死因分流)。

## 8. 风险与未决

- 决策项 A ✅ Lead 已裁定(§4);决策项 B ✅ Codex R1/R2 同意带约束(§4);决策项 C(absent⇒dead 属合同内)✅ Codex R2 接受(见 plan §1)。
- `FLYWHEEL_ENGINE_DEAD_EXEC_SWEEP=0` kill switch 原样保留(逃生口不动)。
- 实施时本仓测试注意 `FLYWHEEL_RUNNER_BACKEND=codex` 环境污染(memory:跑 teamlead 套件前 unset)。
