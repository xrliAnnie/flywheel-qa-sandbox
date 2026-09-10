# FLY-2352 Codex 体重启恢复结构性必败 — 探索
Issue: FLY-2352 (https://linear.app/geoforge3d/issue/FLY-2352/病根-bridge-重启后-codex-体的引擎恢复结构性必败buildcodexrecoverycontext-撞-launch)
日期: 2026-09-08
基于: 无

## 1. 一句话

Bridge 重启后,任何**被 rework 唤醒过**(同一 execution 上挂了第二条 activation)的 Codex 体,恢复路径必定抛 `workflow capability drift`,两次即 exhausted,整体被判死换体。病根不在「布尔漂了」,而在恢复侧用了一把 FLY-1423 明确标注「只在单 activation 下有定义」的老钥匙(`getWorkflowExecutionBinding`),多于一条 activation 就返回 undefined,于是把一个 workflow 体算成了「非 workflow 体」。

## 2. Issue 原述(摘要)

- 形状:Bridge 重启 → daemon 随旧 Bridge 死 → reown 判 unhealthy → `beginRecovery` → 重建 `AdapterExecutionContext` 时 `buildCodexRecoveryContext` 断言 snapshot 的两个布尔 == 现算布尔 → 抛 → `episode_attempts` 打到 2 → `episode_exhausted` → session failed(`reown_exhausted`)→ 引擎铸替身。
- 登记实例 ×2:FLY-2337 的 `fcd30fc2`(04:53Z)与 `7c64f6cc`(06:10–06:20Z),2026-09-05。
- Issue 给出的修法方向:「恢复上下文对 capability 漂移应重算而非抛错,或恢复失败时先尝试同 socket 重拉 daemon 再判死」。

## 3. 生产实证(2026-09-08,只读查询 `~/.flywheel/teamlead.db`,未拷库)

### 3.1 两个登记实例的快照与绑定

| execution | snapshot `workflowSubmissionExpected` | snapshot `founderReviewRequired` | `workflow_execution_binding` 行 | `codex_recovery_capabilities_prepared` 事件 |
|---|---|---|---|---|
| `fcd30fc2` | true | false | 2 行:`spawn`(implement@1)+ `wake`(`activation:rework:6822…`,implement@2) | **0 条** |
| `7c64f6cc` | true | false | 2 行:`replacement`(implement@2)+ `wake`(`activation:rework:27fa…`,implement@3) | **0 条** |

`session_events`(source=`bridge.codex-session-reown`)对 `7c64f6cc`:
```
reown_revive_started  attempt=1 liveness=alive  gateHeld=true
reown_revive_failed   reason="workflow capability drift for 7c64f6cc…" attempt=1
reown_revive_started  attempt=2 liveness=absent gateHeld=true
reown_revive_failed   reason="workflow capability drift for 7c64f6cc…" attempt=2
reown_revive_failed   reason=episode_exhausted attempts=2
```
sessions 行:`status=failed`,`last_error='Codex recovery exhausted after 2 attempts'`,`terminal_at=2026-09-05 06:20:01`。与 issue 描述逐字吻合。

`codex_recovery_capabilities_prepared` 事件为 0 条,说明 `prepareCodexRecoveryCapabilities` 走的是 `generalizedExecutionContext(...) === undefined` 的「未 enrolled」分支(该分支不写事件、不轮换凭据、直接返回 `workflowSubmissionExpected:false`)。

### 3.2 规模:不是 ×2,是 15 体 / 10 张 issue

```
drift 事件:30 条,首见 2026-09-03 21:07:53,末见 2026-09-08 05:06:16
涉及 execution:15 个;涉及 issue:FLY-2140 2142 2148 2268 2283 2284 2301 2337 2341 2403
15 个 drift 体在 drift 时的 binding 行数:[2 ×13, 3 ×2] —— 100% 多 activation
其中 14 个 last_error = 'Codex recovery exhausted after 2 attempts',1 个被 founder 授权清理(terminated)
```

对照组(相反方向同样 100%):
```
reown_revive_succeeded 的 execution:54 个
其中 37 个至今只有 1 条 binding;
另 17 个后来有 2–4 条 binding,但 17/17 的成功时刻都早于第 2 条 binding 的 bound_at
⇒ 没有任何一次「多 activation 状态下」的成功恢复
```

在本次探索时刻(2026-09-08 19:xx Z),生产中 `codex-tmux` 在飞体 5 个,其中多 activation 的 0 个;但任意一次 rework wake 就会把一个在飞体推进这个必败集合。FLY-2403 一张单在 09-07/09-08 就连续烧掉 3 个体(`b6a94485`、`61bcdb48`、`0cc63973`)。

### 3.3 时间线(git)

| 日期 | 提交 | 事件 |
|---|---|---|
| 2026-07-22 | `6b42de3f4` FLY-1423 (#674) | `getWorkflowExecutionBinding` 改为 `rows.length !== 1 ⇒ undefined`,并注释「this legacy getter is only well-defined for a single activation. Callers that can observe re-entry must use an exact activation API」 |
| 2026-09-01 | `e3554c812` FLY-2211 (#1016) | 新增 `prepareCodexRecoveryCapabilities`(经 `generalizedExecutionContext` → 老 getter)与 `buildCodexRecoveryContext` 的 drift 断言 |
| 2026-09-03 21:07 | — | 首条 drift 事件(FLY-2283 / FLY-2140) |
| 2026-09-05 | — | issue 登记的两例(FLY-2337) |
| 2026-09-08 05:01 | — | 最近一例(FLY-2403 `0cc63973`),Bridge 日志 `/tmp/flywheel-bridge.log.2:8669,12975,17276` |

即:FLY-2211 上线的第一天起,恢复路径对 re-entry 体就是结构性必败;它从未在多 activation 下成功过一次。

## 4. 病根链条(逐行)

```
codex-session-reown.ts:659  prepareCodexRecoveryCapabilities(exec, claimToken, rev, now)
  StateStore.ts:8808          const context = this.generalizedExecutionContext(executionId)
  StateStore.ts:34584           → this.getWorkflowExecutionBinding(executionId)
  StateStore.ts:31682             rows.length !== 1 ⇒ return undefined     ← 病根(FLY-1423 老钥匙)
  StateStore.ts:8810-8815       context 为空 ⇒ { enrolled:false, workflowSubmissionExpected:false, founderReviewRequired:false }
codex-session-reown.ts:209-216  raw.workflowSubmissionExpected(true) !== capabilities.workflowSubmissionExpected(false)
                               ⇒ throw "workflow capability drift for <exec>"
codex-session-reown.ts:751-753  catch ⇒ failPrecommit ⇒ abortCodexRecovery(不退还 attempt)⇒ alert
(下一 pass 同样)⇒ claimCodexRecovery attempts>=2 ⇒ episode_exhausted ⇒ onRecoveryExhausted ⇒ runtime.failExhausted ⇒ session failed
```

三处细节值得写进设计:

1. **同一个 revive 里,精确 API 已经在用了。** `plugin.ts:7861` 在 build 之前先调 `store.resolveCurrentWorkflowActivation(session.execution_id)`,ambiguous 才抛;生产两例的 revive 都走到了 drift 那一行而没有在这里抛,说明精确 API 当时能唯一解析出 current activation(rework 的 wake activation)。也就是说,**同一次 revive 里两把钥匙给出了矛盾答案**:精确 API 说「你是 implement@3 的 rework activation」,老 getter 说「你不是 workflow 体」。
2. **两个布尔本身没有漂。** implement 节点的 `founder_review` 在 pinned manifest 里是常量,`nodeRequiresFounderReview` 与 launch 侧 `workflow-engine-dispatcher.ts:2857` 用的是同一函数;`workflowSubmissionExpected` 对 enrolled 体恒为 true。issue 说「attempt 推进/角色变化后这两个布尔会漂」是对现象的合理猜测,但实证是:**现算根本没算出来**,不是算出了不同的值。
3. **第一次 attempt 是 alive+gateHeld 进的 recovery。** `7c64f6cc` attempt=1 时 daemon 还活着(gate 在手、in-process owner 随旧 Bridge 丢了),reown 先 `reap` 再重建 context,重建才抛。所以「先 reap 再证明能重建」的顺序把一个本来活着的 daemon 也杀了。这是次生伤害,不是病根;见 §6 方案 C 的取舍。

## 5. 对 issue 处置建议的回应(push back)

| issue 建议 | 结论 | 理由 |
|---|---|---|
| 「恢复上下文对 capability 漂移应重算而非抛错」 | **部分采纳:重算「现算侧」,守卫保留** | 真正该重算的是 `prepareCodexRecoveryCapabilities` 的 activation 解析;快照侧两个布尔已经烘进 kick prompt 与 daemon env(`CodexTmuxAdapter.ts:2388-2392`),若真与现算不一致则用哪一边都不对,fail-closed 比覆盖安全。修好解析后,合法 re-entry 不再触发守卫。 |
| 「恢复失败时先尝试同 socket 重拉 daemon 再判死」 | **不需要新路径** | `runtime.resume(...)` 本身就是「按原 execution/thread/socket 重拉 daemon」;它没机会跑是因为 context 在它之前就抛了。修好 context,这条路径自然通。 |
| 规模 ×2 | **更正为 15 体 / 10 issue** | §3.2 |

## 6. 候选方案

### A. `prepareCodexRecoveryCapabilities` 改用精确 activation API(推荐)

- 把 `this.generalizedExecutionContext(executionId)` 换成 `this.resolveCurrentWorkflowActivation(executionId)`:
  - `kind:"current"` ⇒ 沿用现有 enrolled 分支(轮换凭据、写事件、算两个布尔),`context.binding` 即 current activation(rework 时是 wake activation,attempt 为最新)。
  - `kind:"none"` ⇒ 沿用现有「未 enrolled」分支(legacy 体)。
  - `kind:"ambiguous"` ⇒ 新增 `ok:false, reason:"activation_ambiguous"`,reown 侧走既有 `capabilities_<reason>` abort,不 spawn、不轮换。
- 与 `plugin.ts` revive 里 `workflowActivationId` 的来源(同一 API)对齐 ⇒ **一个来源**,不再有两把钥匙。
- 凭据轮换语义不变:revoke 按 `execution_id` 全撤,新凭据挂在 current activation 的 `activation_id/attempt` 上。runner 侧 `complete` 用 `currentWorkflowCompletionActivationFromEnv` 报同一个 activation,Bridge 校验按 activation 查凭据,链路一致。
- 风险:`resolveCurrentWorkflowActivation` 内部 `generalizedExecutionContextForActivation` 可能抛 `WorkflowAdmissionClassificationError`(快照损坏);`prepareCodexRecoveryCapabilities` 目前在事务内不捕获,`beginRecovery` 第 659 行也没 try ⇒ 异常会炸掉整个 reown pass,claim 留到 TTL 60s 才可再抢。方案里把这一类转成 `ok:false, reason:"activation_invalid"`,保持 fail-closed 且分类可见。

### B. `buildCodexRecoveryContext` 用现算布尔覆盖快照布尔(issue 原提法,拒绝)

- 快照布尔已烘进 prompt/env;覆盖只是把矛盾藏到 runner 运行期(`complete` 需要凭据但 env 说不需要,或反之)。
- A 之后,守卫在合法 re-entry 下不再触发;它剩下的职责是抓「真的不一致」,那正是该 fail-closed 的场景。
- 保留守卫,但错误文案带上两边的值(`snapshot=true/false current=false/false`),让下次巡检不用猜是哪个布尔。

### C. 把 drift 检查前移到 reap 之前 / 不消耗 attempt(讨论后不做)

- 前移需要一个「无副作用的 capability 预览」,因为 `prepareCodexRecoveryCapabilities` 会轮换凭据、写事件,不能在 claim 之前跑。
- 不消耗 attempt 会让一个确定性失败的体永远留在 limbo(daemon 已丢 in-process owner,gate 没人应),比换体更糟。
- A 修好后这个场景不再出现;记为已知限制,不在本单展开。

### D. 改 `getWorkflowExecutionBinding` 本身(拒绝)

- FLY-1423 有意把它做成 fail-closed;另有 9 处消费者(`invalidateWorkflowResumeAttachment`、`prepareWorkflowIssueDelivery`、`rotateGeneralizedWorkflow*Credential*` ×4、`markWorkflowReworkReplacementLaunched`、`getGeneralizedWorkflowNodeForExecution` 及其 8 个调用点),改语义是另一张单的范围;本单只换恢复路径这一处。

## 7. 边界

做:
- StateStore `prepareCodexRecoveryCapabilities` 的 activation 解析 + 两个新 reason(`activation_ambiguous`、`activation_invalid`)。
- `buildCodexRecoveryContext` drift 文案带值。
- 回归测试:真实 sqlite 内存库复现「spawn + wake 两条 binding」的生产形状,改动前红、改动后绿。

不做:
- 不改 `getWorkflowExecutionBinding` 及其他 9 处消费者。
- 不改 reown 的 reap/claim 顺序、attempt 上限、exhausted 后的换体行为。
- 不回填已经被换体的 14 个 session(它们的替身已经在跑或已完成)。
- 不处理 `737f81ba`(FLY-2403)那类 `recovery owner failed before commit` 的另一种 exhausted,它不是 drift。

## 8. 给 Lead 的非阻塞问题

无阻塞项。一处需要 Lead 知情:本单登记规模由 ×2 更正为 15 体 / 10 issue(§3.2),巡检 class_key 不变。
