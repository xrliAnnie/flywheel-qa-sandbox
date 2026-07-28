# FLY-1505 Runner ship 轮询窗口与假报 blocked — 调研
Issue: FLY-1505 (https://linear.app/geoforge3d/issue/FLY-1505/基建卡点-runner-ship-轮询窗口-10-分钟-ship-job-实际-20-分钟-假报-blocked-并作废活批准)
日期: 2026-07-27
基于: exploration.md

## 1. 改动位点逐一核实(带行号,全部实读)

### 1.1 协议文本(缺陷 A+B 的唯一源头)

`packages/edge-worker/src/Blueprint.ts:2304-2308`(APPROVE GATE step e,`founderDesignHtmlDeliveryLines` 之外的 approve-gate 注入段):

- `:2307` — "Wait for the PR to be merged by the deploy workflow (poll \`gh pr view <NUMBER> --json state -q '.state'\` every 30s until MERGED, max 10 min)"
- `:2308` — 超时善后:"If the PR is still not MERGED after the poll window, do NOT ship: run \`… complete --route blocked --summary "ship workflow did not merge in the poll window"\` and STOP — a human will investigate."

窗口(10 min)与间隔(30s)均为字面量内嵌在模板字符串里,无常数提取。全仓唯一活副本(`grep -rn "max 10 min"` 仅此一处 + FLY-1504 exploration 文档引用)。该段被所有 runner 变体共享(Claude wake-driven / Codex resident poll / three-stage phase keep-alive 的 step c 各有分叉,但 step e 的 ship 循环是同一段)。

### 1.2 ship workflow(窗口值的锚)

`.github/workflows/ship-on-comment.yml`:

- `:29` `timeout-minutes: 30`(FLY-1504,注释实测:setup+build+typecheck+lint 3m08s + 全量 `pnpm test:packages:run` 估 ~18-20 分钟)
- **机器可读 receipt**:job 会在 PR 上留 HTML 注释 `<!-- flywheel-ship-receipt trigger_comment_id=… run_id=… run_url=… head=… status=started|success|failure -->`(started 在 pr-info step、success 在合并后、failure 在失败 step)
- **人读失败评论**:"❌ Ship failed — PR was NOT merged. … Fix the issue and post :cool: again."——**失败后的既定恢复路径就是再发一次 :cool:**,这正是「批准必须保活」的理由:恢复动作在 PR 层,不在会话层
- concurrency group `ship-pr-<PR号>`,不取消在跑的

receipt 已有服务端消费者先例:`packages/teamlead/src/bridge/land-executor.ts`(generalized-workflow 的服务端 ship 路径,`inspectTriggeredWorkflow` 读 receipt 判 pending/failed/succeeded)。本单的 runner 协议属 legacy 路径,与 land-executor 无共享代码,但「用 receipt 判显式失败」的模式一致。

### 1.3 三个 completion sink(缺陷 B 的执行者;sink-agreement 是既有硬约定)

| sink | 位置 | 现状 | 可复用的 deflection 前例(同文件内) |
|---|---|---|---|
| HTTP `/events` | `packages/teamlead/src/bridge/event-route.ts:1601-1606` | `route==="blocked"` → `status="blocked"`,注释明说含 approved_to_ship | `:1412-1421` invalid-route skip(`res.json({ok:true,warning})` 不动状态);`:1429-1445` no_code/pr_handoff non-running skip |
| 进程内 | `packages/teamlead/src/DirectEventSink.ts:749` | 同映射 | `:794-803` terminal-immune 早退(FLY-228 Finding K,warn + return 不写库);`:825-858` evidenceOnly 分支(只 patch metadata 不翻状态) |
| 崩溃重放 | `packages/teamlead/src/bridge/complete-marker-reconciler.ts:295-296` | `route==="blocked"` → 返回 "blocked" | 同文件 `expectedStatus` 映射函数返回 `null` = 不可重放/quarantine 语义已存在 |

`isPostApproveShip` 判定已就位:`event-route.ts:1388-1389`(`existingSession?.status === "approved_to_ship"`,在 strict-route guard 之前查好);DirectEventSink 有 `preExistingSession`;marker-reconciler 的映射函数带 `currentStatus` 参数(`:255`)。**三处 deflection 的条件判断均零新查询。**

### 1.4 FSM(缺陷 C)

`packages/core/src/workflow-fsm.ts`:

- `:175-182` `approved_to_ship: ["awaiting_review","completed","blocked","failed","terminated"]` —— `blocked` 边是 FLY-208 5a 加的,注释指明就是给 event-route 的 route=blocked 分支用的
- `:182` `blocked: ["deferred","shelved","terminated"]` + action `retry`(`:230-234`,→running 整圈重跑)——**无回 approved_to_ship 的边**

**边保留不删**:`approved_to_ship → blocked` 还有第二个合法进入路径——`session_failed` 事件的 `goal_blocked`(`event-route.ts:2180-2181`:runner 崩溃/失败时 `terminalStatus = goalBlocked ? "blocked" : "failed"`)。本单只 deflect **route=blocked 的 session_completed**;真崩溃走 blocked 不在本单范围(honest boundary,见 plan)。

### 1.5 verify-approval(不动,一行都不改)

`packages/flywheel-comm/src/commands/verify-approval.ts:559-566` —— 第 4 步 `row.status !== "approved_to_ship"` → `status_not_approved_to_ship`。这是安全不变量:批准只在 approved_to_ship 状态可执行。deflection 后状态根本不翻,此检查自然通过。

### 1.6 「ship 尝试失败」标记的既有形态(直接仿写)

`packages/teamlead/src/bridge/post-ship-finalization.ts:113-127` `markEvidenceGapCompletion`:

- 存进 `sessions.session_params` JSON 列(key `fly208_evidence_gap`,值 `{at, route, landing_status}`)
- 走 `patchSessionParams` 读-改-写合并,保留列里其他住户(proofshot runs 等)
- 明确教训(Codex design R3 guardrail #1):`patchSessionMetadata` 是列白名单,ad-hoc 字段会静默 no-op——所以必须走 session_params

本单标记仿此:key `fly1505_ship_attempt_failed`,值含 `{at, pr_number, head_sha, summary, attempt_count}`(attempt_count 自增,重复 deflection 幂等累计)。

### 1.7 Lead 告警管道(deflection 的升级出口)

`packages/teamlead/src/bridge/auto-qa-coordinator.ts:915` `alertMergeWithoutApproval(session, text)`——FLY-869 决定③ 的"一条响亮 Discord 告警"。关键可达性:**三个 sink 文件都已引用它**(event-route / DirectEventSink / complete-marker-reconciler 均在非测试代码里调用),即 coordinator holder 在三处都已接线,新加一个姊妹告警方法零新接线。去重前例:FLY-869 用 parkMergeBlock 的 claim("once per head")门住告警;本单用 marker 写入时的首次判定(该 head 首次 deflection 才告警,重复 emission 只累计 attempt_count)。

### 1.8 现有测试对旧契约的 PIN(实现时必须同步改)

- `packages/edge-worker/src/__tests__/Blueprint.fly191-approve-gate.test.ts:213-217` —— **现在正 PIN 着** `expect(prompt).toContain("complete --route blocked")`("reports blocked instead of self-merging")。FLY-248 红线(永不自 merge)保留;"报 blocked" 这半句是本单要撤换的,断言改为 PIN 新善后(报 Lead + 留在 checkpoint + 明确禁止 route blocked)。
- 三 sink 各自的测试文件:`DirectEventSink.test.ts:798-820`(blocked → no finalization,继续有效)、`event-route-dual-session-completed` Scenario E(blocked HTTP)、`complete-marker-reconciler.test.ts` —— **这些 pin 的是 running→blocked 等常规 blocked 路径,不与 deflection 冲突**(deflection 只拦 approved_to_ship 来源);实现时逐个核对补 approved_to_ship 场景。
- `verify-approval.test.ts` —— 补集成场景:deflection 后 verify-approval 仍 `approved:true`。

### 1.9 跨文件一致性测试(Lead 加固 ①)可行性

- 窗口/间隔提为 Blueprint 导出常数(如 `SHIP_MERGE_POLL_WINDOW_MINUTES` / `SHIP_MERGE_POLL_INTERVAL_SECONDS`),模板字符串插值,测试直接 import——不 regex 提示词。
- 测试从 `packages/edge-worker/src/__tests__/` 以 `__dirname` 相对路径读 `../../../../.github/workflows/ship-on-comment.yml`(monorepo 单仓,文件必在;CI checkout 全仓)。
- 解析用一条窄正则 `/timeout-minutes:\s*(\d+)/`(该文件唯一一处 timeout-minutes,不引 yaml 依赖);断言 `WINDOW >= timeout + MARGIN`(余量常数同文件导出,plan 定 5 分钟)。
- 漂移场景演练:有人把 workflow 提到 45 分钟 → 断言 40 >= 45+5 失败 → CI 红,红的位置直指两个数的合同。

## 2. 通知/状态面的副作用核对(deflection 要「不做」哪些事)

route=blocked 现走的副作用,deflection 全部不触发(因为状态不翻):

- CommDB runner 终态同步:`DirectEventSink.ts:889-895` `enqueueTerminalCommDbStatus(...,"blocked",...)` 门在 `status === "blocked"` 上——deflection 分支早退,天然跳过
- FSM applyTransition / Linear 状态联动 / thread badge / Decision Layer 通知——全部由状态翻转驱动,不翻即不触发
- deflection 自己的可见性由两样东西提供:session_params 标记(可查证)+ Lead Discord 告警(人可见)

## 3. FLY-1448 接缝(实现期风险)

FLY-1448(held PR,pending ship)重写 founder-approval/wake/park 链路:durable founder receipt、engine-park authority、`ship_parked` 投影、wake 终态窄化、外部权威(GitHub MERGED)recheck。与本单的物理重叠:`event-route.ts`(同文件不同分支——1448 主要动 wake/receipt/清算,本单动 route=blocked 映射)、`workflow-fsm.ts`(1448 动 ship_parked 相关边,本单不动 FSM)。结论:**冲突是文本级不是语义级**,实现期 rebase 逐块保两边;「merged-while-stalled 自动对账」明确让给 1448 的外部权威 recheck,本单不做。

另注:generalized-workflow 的 DAG ship(land-executor 服务端驱动 :cool:)完全绕过 runner 轮询协议,不受本单影响;本单修的是 legacy 三段式/单段 runner 的 ship step e。

## 4. 调研结论(进 plan 的裁定)

1. **窗口 40 分钟、间隔 60 秒**,均提常数导出;40 = 30(job 上限)+ 10(排队/启动/评论传播余量),满足 issue ≥35。
2. **显式失败早停**用 workflow 的失败信号:轮询循环里每次(60s 一拍)`gh pr view --json state` 之外,追加一条对 "❌ Ship failed" / receipt `status=failure` 评论的检查(gh 一条命令可完成;plan 给出 LLM 可靠执行的最简形态)。失败即报 SHIP-FAILED,不再空等。
3. **善后统一改向**:SHIP-STALLED(窗口耗尽)/ SHIP-FAILED(显式失败)都走 `ask --report` 报 Lead + 留在 checkpoint 等唤醒;明文禁止在 approved_to_ship 之后走 `complete --route blocked`。
4. **服务端 deflection 三 sink 同步**:条件 = `route==="blocked" && 现状态==="approved_to_ship"`;动作 = 不翻状态 + `fly1505_ship_attempt_failed` 标记(session_params,读-改-写)+ 首次告警(auto-qa-coordinator 姊妹方法)+ `ok+warning` 返回。
5. **verify-approval、FSM 边、blocked 其他来源全部不动**。
6. CLI 侧再加一层 complete 拒绝闸——**考虑后否决**(理由进 plan 的 rejected alternatives:服务端已兜底,CLI 层重复且依赖 runner env 里 StateStore 路径的可读性,QA 房间 env 漂移会造成假拒绝;协议文本已明确指路)。
