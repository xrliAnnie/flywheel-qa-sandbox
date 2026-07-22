# FLY-1415 dead-exec 去判断化(Option 1 盲换)— 实施计划

Issue: FLY-1415 (https://linear.app/geoforge3d/issue/FLY-1415/engine韧性重构-dead-exec-处理去判断化-option-1bridge-只机械换人盲换3-耗尽升级所属-lead删死因分流)
日期: 2026-07-21
基于: research.md

## 0. 目标与非目标

**目标**:把 dead-exec 处理收敛为纯 Option 1 —— 判死(pane_dead)→ 盲换(不问死因,≤3 次)→ 耗尽 → run held + 人话告警升级**所属 Lead**。删除全部死因分流判断(resourceFailure→hold、approvedDesignFallback、dead_after_output)。并入 FLY-1411 剩余 scope(告警话术人话化 + 端到端到所属 Lead 的真机确认)。

**非目标**:不动 FLY-1385 tripwire(log-only 误判追认)、probe_unknown ×3 告警、`/api/runs` 恢复端点、RunnerIdleWatchdog、`FLYWHEEL_ENGINE_DEAD_EXEC_SWEEP` kill switch。不新建任何判断逻辑。

## 1. 已裁定的决策

| # | 决策 | 状态 |
|---|---|---|
| A | 上限数值**不变**(4 launches = 1 原始 + 3 盲换),显式化 `MAX_BLIND_REPLACEMENTS = 3`;issue #2 的「4→3」是对 pacing 门的误读 | ✅ Lead 已确认(ask `7d9f5e08`,将给 issue 补勘误) |
| B | 删第 2/3 次盲换时的中途 `repeated_dead_execution_pattern` Discord 告警(各 2 条),**保留**其 run event 行;耗尽告警 metadata 带 `launchCount` 补足信息。**实现约束(Codex R1)**:事件行写入条件只依赖机械计数(去掉现 `&& input.alertIdentity` 耦合),无 alertIdentity 也必须落审计事件,配守卫测试 | ✅ Codex R1 同意(带约束) |
| C | **死亡信号的准确定义**(Codex R1 #1 的 push back):issue 原文逐字为「只有进程 exit / **窗口不见** 才判死」—— 即 `dead_pin`(全 pane `pane_dead=1`)**与** `absent`(tmux **证明**窗口/会话已不存在,`isTmuxAbsenceMessage` 白名单)都是合同内的死信号;lookup 失败 / `:pending` / 探针错误一律 `unknown` 不动节点。把 `absent` 改判 unknown 会让真消失的窗口(终端被关、tmux server 重启)永远无法恢复,回退 FLY-1385 的核心价值。stale-target + 真窗口改名导致的 absent 误判是**已接受的窄风险**,由 FLY-1385 tripwire(误判事后追认告警)兜底,并补 §5.2 的三条守卫红测 | ✅ Codex R2 接受(并核实生产无未接受的改名路径) |

## 2. 目标状态

```mermaid
flowchart TD
    A[reconcileDeadExecutions 每秒 sweep] --> B{session 终态<br/>或 teardown fact?}
    B -- 否(慢但活着) --> Z1[跳过,连探针都不调]
    B -- 是 --> C{有完成回执?}
    C -- 有 --> Z2[跳过]
    C -- 无 --> D[死亡探针:pane_dead 全 1 = dead_pin<br/>或 tmux 证明窗口不见 = absent]
    D -- alive(任一 pane 活) --> Z3[跳过 —— 绝不杀活 runner]
    D -- unknown(查无 target/探针错) --> E[×3 → 告警,节点不动]
    D -- dead --> F{已换几次?<br/>MAX_BLIND_REPLACEMENTS=3}
    F -- <3 --> G[盲换:不问死因<br/>新 execution + tripwire watch<br/>60s/5m/15m pacing]
    F -- ≥3 --> H[run held + 人话告警<br/>→ 所属 Lead(selected_by 权威链)<br/>→ Lead 判断下一步]
```

死因(配额/auth/Fable 不可用/有无 output/普通)在此图中**不存在** —— 这就是验收 #4。死亡定义见决策 C(issue 原文合同:进程 exit / 窗口不见)。

## 3. 代码改动(5 个生产文件)

### 3.1 `packages/teamlead/src/bridge/workflow-engine-dispatcher.ts`

1. 使用共享常量(**唯一权威位置 = `StateStore.ts` 导出**,dispatcher 沿现有依赖方向 import —— dispatcher 已 import StateStore 类型,反向会错层;Codex R2 #2 裁定,不留实施时临场决定):
   ```ts
   // StateStore.ts(与 WorkflowEngineAlertIdentity 等导出并排)
   /** Option 1 (FLY-1415): 1 original launch + at most 3 blind replacements. */
   export const MAX_BLIND_REPLACEMENTS = 3;
   ```
2. 删 :79-93 两个正则常量 + `isNonRetryableResourceFailure` + `isApprovedFableUnavailability`。
3. `reconcileDeadExecutions`:
   - 删 `resourceFailure`/`approvedDesignFallback` 判定(:472-481)。
   - pacing 门(:483-496)改:`if (launches.length <= MAX_BLIND_REPLACEMENTS) { …延迟梯不变… }`。
   - 删 `disposition` 三元(:553-557);baseline 采集无条件执行(采不到 → 本 tick hold 重试,注释保留)。
   - `rollbackDeadWorkflowNodeExecution` 调用:去掉 `retryDisposition`,`reason` 恒 `"terminal_session_and_dead_probe"`。
4. `consume`:删 :815-838 的 `approvedDesignFallback` 事件扫描;`resolveNodeDispatchAtLaunch` 不传 flag。

### 3.1b 所属 Lead 权威链(Codex R1 #2,FLY-1411 闭环的真缺口)

现 `resolveRunAlertIdentity`(plugin.ts:5253)在 issue 无 session row 时静默降级为全局 `config.defaultLeadAgentId` —— 而「rowless + durable teardown」正是 dead-exec 已支持的恢复形态,默认 Lead 不是 issue owner 甚至可能不属于该 project。修法(复用既有 durable 权威,不新增判断):

1. 回调签名扩为 `resolveRunAlertIdentity(projectName, issueId, runId)`(dispatcher 三个调用点 probe_unknown/rollback/tripwire 都有 runId;tripwire watch 行含 `run_id`)。
2. plugin.ts 闭包解析链:
   - **① `store.getWorkflowRun(runId).selected_by`**(runs/start 写入的校验过的 leadId,StateStore:13666/runs-route:1376)—— 非空且 ≠`"unassigned"` 且在该 project 的 leads 配置中存在 → `leadResolution:"resolved"`;
   - **② session labels → `resolveLeadForIssue`**(现有路径,session 尚在时);
   - **③ `config.defaultLeadAgentId`** → `leadResolution:"fallback"`(仅当 ①② 都不可得,永不静默 —— fallback 时 log warning)。
3. 集成测试:两个 Lead 的 project、当前 execution 无 session row → 告警 leadId = run.selected_by 的 Lead(非默认 Lead)。真机验收核对**实际所属 Lead 身份**收到告警,不只「某频道有消息」。

### 3.2 `packages/teamlead/src/StateStore.ts`

1. `rollbackDeadWorkflowNodeExecution`:
   - 签名删 `retryDisposition`;幂等比对与 event payload 恒用 `"retry"`(历史 `design_fallback` 回执经 sweep 的 latest-execution 守卫不可重入,无迁移)。
   - 删 hold 分支(:16661-16683)、dead_after_output 分支(:16684-16721)。
   - 耗尽门:`launchCount >= MAX_BLIND_REPLACEMENTS + 1`(常量本文件导出,见 §3.1.1)。
   - 耗尽路径:held + `retry_limit_escalated` 事件(payload 不变)+ 新版人话告警;告警构造时顺带查 `outputExists`(现 dead_after_output 分支里的两条 SELECT 原样挪用,变成纯 metadata 事实)。
   - 决策项 B:删 :16833-16881 两条中途告警的 `enqueueWorkflowEngineAlertTx`(**保留** `repeated_dead_execution_pattern` 的 `appendWorkflowRunEventCheckedTx`,且写入条件改为**只看机械计数** `priorDeadReplacementCount > 0`,去掉 `&& input.alertIdentity` —— 缺通知身份不得丢审计事件);删 :16883-16889 design_fallback 告警。
2. `workflowEngineAlertPayload` 重写为仅耗尽形态(**title/body/metadata 全部从 `MAX_BLIND_REPLACEMENTS` 常量插值,不得裸写 3** —— Codex R3 #1:single authority 覆盖行为、metadata 与话术;测试断言当前渲染值为 3):
   - title:`【需人工】<issueId> 节点 <nodeId> 盲换 ${MAX_BLIND_REPLACEMENTS} 次仍起不来`
   - body:`<issueId> 的 <nodeId> 节点换了 ${MAX_BLIND_REPLACEMENTS} 次仍起不来,引擎已停手,run 已挂起(held),需要你判断下一步处理。`(重试/换模型属 Lead 经 orchestrator 重派的判断,不在 body 列 API)
   - metadata.workflowEngine:`{ runId, issueId, nodeId, executionId, disposition:"held", launchCount, maxBlindReplacements: MAX_BLIND_REPLACEMENTS, outputExistsForAttempt, management: { terminate: "POST /api/runs/<runId>/terminate" }, leadResolution }`。**只列已验证合法的动作**(Codex R1 #6:`hold` 对已 held 的 run 返回 `run_not_manageable`,StateStore:15892-15899;`terminate` 对 active|held 均合法)。
   - eventType/severity/sessionKey/claims 去重机制不动。
3. `workflowDeadExecutionAlertPayload`:删 `repeated_dead_execution_pattern` 分支(随 B 成死码),只剩 tripwire FALSE-POSITIVE 形态(其 `workflow_engine_issue_alert` eventType 仍有 tripwire 生产者 :16263,infra-alert-wiring 的 issue-thread 路由分支不成死码)。
4. **同文件的类型/校验面(Codex R1 #5 补漏)**:
   - `admitGeneralizedWorkflowExecution` 入参 `dispatchResolution.source` 联合(:15140 附近)删 `"approved_design_fallback"` 成员。
   - `WorkflowEngineAlertPayload.metadata.workflowEngine` 独立联合(:20781-20791)删 `"design_fallback"`、`"repeated_dead_execution_pattern"` 成员(`"dead_execution_activity_after_replacement"` 保留),并加新可选字段 `launchCount` / `maxBlindReplacements` / `outputExistsForAttempt` / `management`。

### 3.3 `packages/teamlead/src/workflow-dispatch-resolution.ts`

删 `approvedDesignFallback` 入参与整个 fallback 块、`APPROVED_FALLBACK_*` 三常量、source 联合成员 `"approved_design_fallback"`。调用方共 3 处生产码(actions.ts、runs-route.ts、dispatcher),仅 dispatcher 传该 flag(可选参数),删参后其余两方零改动 —— 实施时逐一确认编译面。

### 3.4 `packages/teamlead/src/LeadAlertNotifier.ts`

`AlertMetadata.workflowEngine` 联合删 `"design_fallback"`、`"repeated_dead_execution_pattern"`;新增可选字段 `launchCount?`, `maxBlindReplacements?`, `outputExistsForAttempt?`, `management?`。注意 metadata **有行为读者**(Codex R1 #5):`infra-alert-wiring.ts:77-88` 读 `workflowEngine.executionId/issueId` 做 `workflow_engine_issue_alert` 的 issue-thread 路由 —— 本单不动这两个字段,新增字段对它无感;改动后跑该 wiring 的既有测试确认。

### 3.5 死码清单(实施后确认删净)

`NON_RETRYABLE_RESOURCE_FAILURE`、`APPROVED_FABLE_UNAVAILABILITY`、`isNonRetryableResourceFailure`、`isApprovedFableUnavailability`、`APPROVED_FALLBACK_SOURCE_MODEL`、`APPROVED_FALLBACK_TARGET`、`APPROVED_REPLACEMENT_MODELS`、`"approved_design_fallback"` source 成员(workflow-dispatch-resolution + StateStore admission 两处)、alert payload 的 design_fallback/repeated 分支。静态 sweep **限定为生产源码(`packages/**/src`,排除 `__tests__` 与 docs)中的已删 symbol / union member 归零** —— 全仓字面 grep 不可能归零(sibling/历史文档合法保留旧事件名);历史事件 kind 字符串(`non_retryable_execution_failure` 等)在 append-only 历史行里继续存在,属预期。

## 4. 行为变化(如实陈述,进 PR 描述)

1. 配额/auth 死:首死即 held → 盲换 3 次(pacing 累计 ~21 分钟)后升级。收益:文本正则误判(FLY-218 教训)不再插死健康 run;FLY-696 账号轮转后盲换有自愈机会。代价:真配额死到 Lead 慢 ~21 分钟 —— Annie 裁定的 Option 1 合同内。
2. Fable 不可用:删除的是「按死因自动换 GPT-5.6」这条 cause-driven fallback。替补 launch 照常走 `resolveNodeDispatchAtLaunch` 的 dispatch-at-launch policy(config/live-template 可读)—— 若外部配置/模板在两次 launch 之间变了,vendor/model 仍会随之变,**这与死因无关,是既有 contract,保留**(Codex R1 #4:不承诺「物理同模型」)。
3. 死但有输出:盲换。替补因 output append-only(`output_already_exists`)+ 完成回执归属(`missing_output`)**无法完成**;**若替补随后退出**,盲换次数有界(≤3)后升级;**若替补保持存活**(重试/等待/求助),按硬不变量 sweep 不会碰它 —— 这类 live-but-doomed 停滞由既有 idle-stuck 升级路径与 Lead 判断兜底,**本单不为此塞新判断回 Bridge**(Codex R1 #3:接受为已知风险,配 §5.2 测试锁行为)。metadata `outputExistsForAttempt:true` 提示 Lead「活儿可能已干完」。触发窗口极窄(见 exploration §2.5)。
4. (决策 B)第 2/3 次盲换不再打扰 Lead;耗尽一次性强信号。

## 5. 测试计划(TDD,先红后绿)

### 5.1 改写既有(research §6.1 全表,7 处)

含三处语义反转:有 output → 照样盲换;配额死 → 盲换;第 2 次换 → 无告警(事件行仍在)。配额死的告警重投 durability 断言迁移到耗尽告警(同 outbox 机制)。

### 5.2 新增守卫/突变(验收 #5)

1. 死亡信号守卫三连(决策 C 的红测,边界按 Codex R2 #3 拆分命名):①任一 pane `pane_dead=0` ⇒ alive ⇒ 0 rollback;②**missing/unregistered target**(DB/row/`tmux_window` 缺失 ⇒ lookup `gone`)/ target `:pending` / 探针错误(indeterminate)⇒ unknown ⇒ 0 rollback、节点不动;③`found`(含 stale-but-populated target)+ 全 pane `pane_dead=1`(dead_pin)**或** tmux 白名单否证(absent)⇒ dead(合同内两形态,突变穷举)。注:`lookupTmuxTarget` 不验证 target 新鲜度 —— 真 stale target 会被 probe 且 tmux 否证 ⇒ dead,这正是决策 C 已接受的窄风险(tripwire 兜底),测试如实锁两条边界,不用 lookup miss 冒充 stale 覆盖。
2. idle 不入死亡路径:working/awaiting_review session + 无 teardown fact ⇒ probe spy 0 调用、0 rollback。
3. 同路径:quota 文本 / fable-unavailable 文本 / null 三种 `last_error` ⇒ rollback 结果、事件 kind、reason、告警行为逐字段相同(验收 #4 单测形态)。
4. 耗尽告警形态:body 含「换了 3 次」且不含 `POST /api`;metadata 全字段(management 仅 terminate);发往 `resolveRunAlertIdentity` 返回的 leadId。
5. 所属 Lead 权威链(§3.1b):两 Lead project、无 session row ⇒ leadId = `run.selected_by`;selected_by 缺失/无效 ⇒ 走 session 链;都不可得才 fallback(带 warning)。
6. dead_after_output 行为锁定:有 output 的 attempt 被盲换后,替补提交 ⇒ `output_already_exists`;替补 completion ⇒ `missing_output`(锁死 live-but-doomed 的边界行为,防未来有人「顺手修好」把判断塞回 Bridge)。
7. 决策 B 守卫:第 2 次盲换、无 alertIdentity ⇒ `repeated_dead_execution_pattern` 事件行仍写入、0 告警。
8. 反回退哨兵:dispatcher 源文件不含 `last_error` 参与死亡决策的引用(结构性:rollback 调用点唯一且无条件分叉)。

### 5.3 真机验收(implement/QA 阶段,隔离房)

research §6.4 四场景:①慢但活永不换;②首死次活换 1 次零告警;③every-spawn-dies 恰 3 换 → held → **核对实际所属 Lead 身份**(该 Lead 的频道/bot,非「某频道有消息」)收到人话告警(端到端,FLY-1411 scope);④配额死 vs 普通死事件序列同构。环境注意:529 房配方 + `FLYWHEEL_DELIVERY_SECRET_PATH`;跑 teamlead 套件前 unset `FLYWHEEL_RUNNER_BACKEND`。

## 6. 兼容与回滚

- 事件 schema:`execution_dead_rolled_back.retryDisposition` 恒 `"retry"`(字段保留);`retry_limit_escalated` 不变;两个 held 类事件 kind 停产、历史行保留。
- 无 DB 迁移、无新 env、无 API 变化;kill switch `FLYWHEEL_ENGINE_DEAD_EXEC_SWEEP=0` 原样。
- 回滚(Codex R1 #7 修正措辞):代码可直接 revert,旧代码能读新产生的 `retry` 事件(比对值恰是旧默认);但启用期间已提交的 replacement / held / 告警 / append-only 事件行**不会也不应被逆转** —— revert 只恢复未来决策。部署窗口内 active run 无需特殊处理(sweep 幂等,回执比对防重放冲突)。
- 部署:Bridge 重启一次生效(遵守 bridge-ship-discipline:先改配置后杀进程;launchd KeepAlive)。

## 7. 交付切分

单 PR(删减为主,**5 个生产文件**:dispatcher / StateStore / workflow-dispatch-resolution / LeadAlertNotifier / plugin.ts(§3.1b 权威链)+ 既有 3 测试文件改写 + 新增守卫测试(§5.2,可独立成文件));docs(本文件夹)随同 PR。实施顺序:先 5.1 红 → 3.x 删码变绿 → 5.2 守卫 → lint/全测 → PR → codex code review → 独立 QA(5.3)→ 报 Lead。
