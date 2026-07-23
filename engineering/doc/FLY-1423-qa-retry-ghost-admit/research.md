# FLY-1423 qa-fail 踢回锁死 — 调研

Issue: FLY-1423 (https://linear.app/geoforge3d/issue/FLY-1423/enginebug4-qa-fail-踢回锁死-attempt2-admit-幽灵-exec-terminal-complete-硬)
日期: 2026-07-22
基于: exploration.md

本文逐条回答 exploration §8 的待研究问题,并把修法方向落到可实现的机制判据上。

## R1. `commitEnrolledCompletion` 逐行核(修 2 可行性)— `StateStore.ts:17795-17951`

判定顺序(全部核实):

1. `not_enrolled` → 落到 legacy 分支(不动)。
2. `route_mismatch`(`:17808`)→ route 必须等于节点 `completion_route`。
3. **receipt 已存在**(`:17821-17842`):三字段全等(execution_id + route + digest)→ `ok:true, idempotentReplay:true`,并重投影 `projectGeneralizedCompletionTx`(幂等);**任一不同 → `completion_conflict`**。← 修 2 的手术点:digest 单独不同不该是冲突。
4. `stale_execution_superseded`(`:17848`)→ 200-settled(已有豁免口)。
5. `missing_output`(`:17851-17862`,retryable)。
6. 事务内:免疫守卫(`:17879-17887`,**排除 completed**)→ receipt INSERT → engine_owned 时 `commitWorkflowTransitionTx`(标 node done、resolve edge、upsert 后继 pending、写 `edge_traversed` + `node_dispatched`)→ 投影。

**结论 a(幂等判据)**:对 1415 场景(同 exec `ec9d3286`、同 route `needs_review`、fix commits 改了 evidence → digest 不同),今天走第 3 步 → `completion_conflict` → 409。修 2 = 在第 3 步把「execution_id + route 相等、仅 digest 不同」改判为语义幂等成功:**不改写 receipt**(append-only 历史,原 digest 保留),按 replay 腿同样重投影,返回可观测区分的成功(如 `idempotentReplay:true` + `evidenceRefreshed:true`)。execution_id 或 route 不同 → 仍 `completion_conflict` 409(真冲突)。

**结论 b(declared-not-landed 补账)**:receipt 缺失 + session 已 `completed` 的分叉,今天**结构上已能走通**——免疫守卫刻意排除 `completed`(FLY-1427 的留口),receipt INSERT + transition 照常提交,节点推进。修 2 不需要为此写新代码,需要的是**把它锁成合同**(集成测试:session 先被 DirectEventSink 腿翻成 completed、receipt 缺失 → 重发 complete → 断言 receipt 落账 + `edge_traversed` 出现 + 后继 `node_dispatched`)。`commitWorkflowTransitionTx` 不写 session status(session 已终态无需再转移),无隐藏拒绝点(`transition_refused` 只来自 transition 自身的边/状态校验,与 session status 无耦合)。

**结论 c(HTTP/reconciler/CLI 对齐)**:
- event-route `:660-721`:幂等成功已是 `ok:true` → 200,无需新 settled 口;若 plan 决定要独立可观测值,镜像 `terminal_status_immune` 的 200 形态加 `settled:"already_completed"`。
- reconciler `complete-marker-reconciler.ts:602-646`:`completion_conflict` 现被定性 quarantine——修 2 后同 exec 重发不再产生 conflict,此腿只剩真冲突,行为保留;`terminal_status_immune` settled 的 unlink 守卫排除 `completed` 的镜像逻辑不动(它对应的是 FLY-1427 的 terminated 类)。
- CLI `complete.ts:263-294`:409 与网络错误同权重盲重试 4×。补 deterministic-reject 分类(镜像 FLY-1425 `classifyQaResultRejection`):`completion_conflict`(修后=真冲突)→ 立停重试、红错报 Lead;`missing_output`(retryable:true)→ 保留 bounded retry;unknown → 保留 retry(安全阀)。

## R2. inflight 顶替口的判据与窗口(修 1a)— `run-dispatcher.ts`

- `inflight` map 定义在 `RetryDispatcher`(`:461-465`),`start()` 守卫 `:1195-1207`,释放在 promise `.finally()` 无条件 `delete(key)`(`:1587-1589`);`:1593` 已有 `this.inflight.get(key) === entry` 的 identity-check 先例。
- **RetryDispatcher/RunDispatcher 无 StateStore 引用**(构造参数核实:blueprintsByProject / cleanupHandles / launchClaims / isCommitted / lifecycleAdmission / lifecycleLaunchGuard / phaseRetryStartPointComputer / skillFrameworkStampLookup)。→ 顶替口需注入可选 seam:`sessionStatusLookup?: (executionId: string) => string | undefined`,`plugin.ts` 装配处接 `store.getSession(id)?.status`。**undefined → 行为字节不变**(项目惯例:可选依赖缺省=legacy)。
- 顶替判据(fail-closed,全部满足才顶替):
  1. `req.generalizedExecution` 存在(引擎车道专属;HTTP/retry/rescue 路径零变化);
  2. 既有条目 exec ≠ 本次 exec(同 exec 已有幂等放行);
  3. `sessionStatusLookup(既有条目 exec)` 返回的 status 满足 `isNoOutEdgeTerminalStatus`(`packages/core` 已导出,`index.ts:292`)。
- **窗口安全性**:前任仍在 launch 中(session 行未建或 `pending`/`running`)→ lookup 返回 undefined/非终态 → `isNoOutEdgeTerminalStatus(undefined)=false`(FLY-1427 合同:不能证明就不免疫)→ 不顶替、照旧 throw。恰好 fail-closed。
- **finally 误删修正**:顶替后老 promise 最终 settle 时,无条件 `delete(key)` 会删掉 successor 的新条目 → 第三个 start 可乘虚而入。改为 identity-check delete(照抄 `:1593` 形态)。此改动对非顶替路径语义等价(条目未被替换时 get(key)===entry 恒真)。
- **生产旁证**:09:05 Bridge 重启(inflight 清空)后,attempt2 与 parked attempt1 共存同 worktree(`/Users/xiaorongli/Dev/flywheel-FLY-1415`)跑完全链(09:38 complete、qa PASS、gate 打开),TURN belt 正常仲裁——顶替放行的运行形态在生产已被完整验证过一次。

## R3. 幽灵腿判据与阈值(修 1b)— probe 合同的关键限制

- **`probeGeneralizedLaunchLiveness` 对幽灵恒返 `unknown`**(`generalized-launch-recovery.ts:22-41`):无 session/CommDB 映射 → `lookup.kind !== "found"` → unknown;FLY-1415 合同里 unknown = 不动节点。**幽灵腿不能借道 dead 探针**。
- 替代判据「**never_born**」(账本自证,无需探针,全部满足才成立):
  1. node `state==='running'` 且最新 ordinal dispatch side-effect `state==='intent_recorded'`(未 committed;`launch_committed` 状态明确归既有 delivery-repair 管);
  2. `getSession(exec)` **无行**(连 pending 都没有);
  3. `getWorkflowLaunchOwner(exec)` 无 `committed_generation`(launch 从未 commit);
  4. intent 年龄 > **60 min**(= launch lease TTL = admission 凭据 expiresAt;凭据都过期了才算名副其实的幽灵——不与 in-flight lease 竞态,不与 60s/5m/15m pacing 冲突)。
- 成立后走既有 `rollbackDeadWorkflowNodeExecution`(`StateStore.ts:17248`,event_uid 幂等、mint 新 exec、`MAX_BLIND_REPLACEMENTS` 收敛、exhausted → run held + 所属 Lead 人话告警)。该原语现校验 `livenessEvidence.liveness==='dead'` — plan 需定:扩 evidence 类型(如 `{ liveness:'dead', basis:'never_launched' }`)或收窄的专用入口,**不得动既有 dead 腿的测试锁**(FLY-1415 plan §5.2 测试 6 锁死 dead_after_output 行为)。
- 收敛形态:若 launch 失败原因 exec-specific → 新 exec 自愈;若环境性(如本事故 inflight 占用,修 1a 后不存在)→ 新 exec 同卡 → 3 次盲换(每次 ≥60min)→ exhausted → held + 告警。全程机械、有界、不判断死因,与 FLY-1415 哲学同构。

## R4. 有界 held 升级(修 1c)— 复用告警基建

- 现状:`consume()` 抛错仅 `this.log(...)`(dispatcher `:260-267`),无升级。事故中 5h × 14034 条相同日志零告警。
- 复用 FLY-1415 基建:`store.enqueueWorkflowEngineAlert`(escalation_uid 主键天然一次一报)+ `reconcileWorkflowEngineAlerts`(claim-before-send 租约投递)+ `resolveRunAlertIdentity`(所属 Lead 三级解析)。dispatcher 内已有同构先例:`probe_unknown ×3` 告警(`:729-765`)。
- 判据:最新 ordinal dispatch intent 停留 `intent_recorded` 超 **15 min**(比幽灵回收早、比 pacing 最长档 15min 对齐)→ enqueue 一次(uid = `launch_held:{run}:{node}:{attempt}:{exec}`),payload 带最近一次 held 原因原文(如 `Run already in progress for issue FLY-1415 role implement`)与 held 起始时间。piggyback 现有 1s reconcile tick,零新 timer。
- **与 FLY-1425 design-correction 的关系**:founder 已裁「不要来一个打一个的看门狗」。本告警不是新扫描器——是 dispatch reconcile 环(launch 的 owner)对**自身**持续失败的 fail-loud,failure 在哪就在哪报;跨节点通用不变量(「节点声称运行但终态事实未入账」类)仍归 FLY-1386,本单不越界。

## R5. 事件去重与幂等重放的交互(修 2 细节)

- `complete.ts` 一次调用构造一个 `event_id`(`:247-255`),4 次 attempt 复用同一 body;**新调用 = 新 event_id**。
- event-route 的 generalized 分支(`:660-721`)在 `insertEvent` **之前**执行并提前 return——event_id 去重(`:805-818`)对该分支不构成前置屏障。因此修 2 的幂等分支必须在 `commitEnrolledCompletion` 内部成立(与 event_id 无关),现设计正是如此。
- quarantine 存量不做 backfill:1415/1364 已由 Bridge 重启 + Lead 人工收尾,残留 quarantine 文件仅是历史证据;修后同形态不再产生。

## R6. E2E 注入手法(验收)

- **自然复现**(首选,隔离房):three-stage keep-alive 是默认行为(`three-stage-policy.ts`)→ 引擎模板 run 里 implement attempt1 complete 后自然 park、占住 inflight key。注入 qa FAIL verdict(`/api/workflow/decision`,走 FLY-1425 的凭据车道)→ 事故形态自动成立。修后断言:attempt2 sessions 行在**不重启 Bridge**的前提下出现(修 1a 生效铁证)、fix 完成 → complete 通过 → qa attempt2 `node_dispatched`(retest 自动派)。
- 修 2 断言:对已 completed 的 attempt1 exec 以刷新 evidence 重发 `flywheel-comm complete --route needs_review` → exit 0(非 409)、无新 quarantine 文件、engine 账本无 conflict。
- 修 1b/1c 用单测+集成测(注入假 held:startDispatcher.start 恒抛)断言 15min 告警 enqueue 与 60min never_born 回滚;真机不必造 60min 等待。
- 隔离房用 QA framework slots(FLY-96/115 基建);qa-result 409 语义见 memory(legacy vs DAG 节点先分车道)。

## R7. 风险与兼容性清单

| 风险 | 缓解 |
|------|------|
| 顶替口误放行双活跑(前任其实还在干活) | 判据只认 no-out-edge 终态;pending/running/undefined 一律不顶替(fail-closed);TURN belt 仍是 worktree 写权仲裁 |
| finally identity-check 改动影响非顶替路径 | 语义等价证明 + 既有 79 测跑绿;新增专测「老 promise settle 不删新条目」 |
| 幽灵回滚与 delivery-repair 抢同一 exec | never_born 判据第 1/3 条显式互斥(`launch_committed`/committed_generation 存在即让位) |
| digest 放宽被滥用(不同内容硬说幂等) | 只放宽 digest;execution_id + route 仍强校验;receipt 原文不改写;audit 事件记录 evidenceRefreshed |
| 新 settled/幂等语义破坏 reverse-compat | `commitEnrolledCompletion` 返回形状只增不改;event-route 200 形态复用现有 ok 腿;byte-compat 测试(sentinel)照项目惯例补 |
| FLY-1415 测试锁(dead 腿行为) | never_born 走独立 basis,不触碰 dead_after_output 与 pane_dead/absent 合同;既有测试必须全绿 |

## R8. 结论(带进 plan 的机制清单)

1. **修 1a**:`RetryDispatcher` 注入 `sessionStatusLookup` seam + 引擎专属终态顶替口 + finally identity-check。
2. **修 1b**:dead-exec sweep 增 never_born 腿(4 条判据,60min),复用 `rollbackDeadWorkflowNodeExecution` 收敛(≤3 盲换→held+告警),evidence basis 扩展不动 dead 腿。
3. **修 1c**:dispatch intent 超 15min 未 committed → `launch_held` 一次性去重告警(带 held 原因原文),piggyback reconcile tick。
4. **修 2**:`commitEnrolledCompletion` receipt 腿放宽 digest(exec+route 相等=幂等成功,不改写 receipt)+ declared-not-landed 补账合同测试 + CLI deterministic-reject 分类 + reconciler 对齐。
5. **E2E**:隔离房自然复现 1415 场景全链(qa-fail → attempt2 真 launch 不重启 → fix → complete 幂等 → qa retest 自动派)。
