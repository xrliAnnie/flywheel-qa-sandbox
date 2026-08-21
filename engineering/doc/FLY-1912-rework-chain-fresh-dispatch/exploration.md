# FLY-1912 rework 验证链撞未跑节点 — 探索

Issue: FLY-1912 (https://linear.app/geoforge3d/issue/FLY-1912/引擎rework-verification-链含未跑节点时-completeworkflowrunnode-直接-throw-http)
日期: 2026-08-20
基于: 无

## 1. 问题是什么(一句话)

经 operator rework 恢复的 run,implement 交棒时引擎要把验证链推到下一个节点 qa;qa 从来没跑过、没有"上一任 actor"可唤醒,引擎在这里 `throw` 而不是派个新人,抛出的异常没人接 → Bridge 回 HTTP 500 → runner 重试 4 次全败落盘 marker → Bridge 重启后 marker 回放撞同一异常 → 永远清不掉。

## 2. 实况与模式(来自 issue,已核对)

| 日期 | Issue | run | 现象 |
|---|---|---|---|
| 2026-08-19 18:59Z | FLY-1330 | 56d55a7e | implement attempt 3 `complete --route needs_review` 连 4 次 500,marker 落盘,重启回放同错 |
| 同日 | FLY-1887 | 19e9caef | 同 |
| 同日 | FLY-1855 | 8a4b0b52 | 同(临时修复一次过) |

共同点:**有 operator rework 史**(deadend-⑮ 类恢复:rework 指向 implement,qa 从未跑过)。临时治法三例一致:把 `workflow_rework_verification_path` 与 `workflow_rework_delivery` 置 `completed`,让 complete 改走普通边路由,立刻复通。

后续还有 FLY-1847 / FLY-1859 / FLY-1814 三个 held run 的折入体待降生,交棒时大概率同撞 —— 修复要赶在它们到达 complete 之前。

## 3. 代码审计(先摸真实代码,不当 greenfield)

### 3.1 真正的 throw 点

issue 口头叫 `completeWorkflowRunNode`,实际函数是 **`StateStore.commitWorkflowTransitionTx`**(`packages/teamlead/src/StateStore.ts:36026`),由 `commitEnrolledCompletion`(34611)在 `db.transaction` 内调用。

```ts
// StateStore.ts ~36609
let preferredActorExecutionId: string | undefined;
if (reworkAuthority && reworkRequestId) {
    preferredActorExecutionId = targetAttempts
        .filter((candidate) => candidate.execution_id)
        .sort((left, right) => right.attempt - left.attempt)[0]
        ?.execution_id as string | undefined;
    if (!preferredActorExecutionId) {
        throw new Error("workflow_rework_preferred_actor_missing");   // ← 36616
    }
    ...
```

触发条件链(全部已在代码里逐行核对):

1. `activePathRow`:该 run 存在 `state='active'` 且 `current_node_id/attempt` = 正在完成的 implement 节点的验证路径(= operator rework 已唤醒 implement 并在跑);
2. `edge` 为普通边(`implement_done`),引擎把目标改写为 `activeRoute.invalidation_scope[currentIndex+1]` = `qa`(不是用边的 `to`,虽然在 `code` / `simple_code` 两个生产 shape 里二者相同);
3. `chainedRework = activePath && activeRoute && activeRequest && edge && target.type !== "gate"` → true;`reworkAuthority = activeRequest.authority`(= `operator`);
4. `targetAttempts = listWorkflowRunNodes(runId, "qa")` 为空 → `preferredActorExecutionId` 为 undefined → throw。

### 3.2 这段代码的意图

链式 rework("rework_verification_chained")的设计是:验证链每前进一步,就为下一节点铸一条**新的** rework request,其投递方式是 **wake 上一任 actor**(`preferred_actor_execution_id` 拿 TURN、被唤醒、复用 worktree),见 `workflow-rework-coordinator.ts:reconcile()`。前提是"这个节点以前有人跑过"。qa 从未跑过时这个前提不成立 —— 但"从未跑过的节点进入验证范围"是完全合法的状态(deadend-⑮ 类恢复正是在 run 没走到 qa 时重开 implement)。

### 3.3 对照:operator 侧同名检查是优雅的

```ts
// StateStore.ts ~30621 openOperatorRework
if (!preferredActorExecutionId) {
    result = { ok: false, reason: "target_actor_history_missing" };
    return;
}
```
→ runs-route 映射为 HTTP 409 `REWORK_TARGET_ACTOR_HISTORY_MISSING`。operator 侧的拒绝是**合理合同**(base_revision 取自该 actor 的 pr_head_sha,没有 actor 就没有基准);completion 侧的情形不同 —— 基准来自刚完成的 implement(`input.subjectDigest`),不需要 qa 的历史。

### 3.4 500 是怎么产生、怎么变成死锁的

- `commitEnrolledCompletion` 的 catch 只把 `transitionRefusal`(即 `commitWorkflowTransitionTx` 返回 `{ok:false, reason}`)转成结构化 `{ok:false, reason:"transition_refused", detail}` → event-route 回 409;**裸 `throw` 直接 `throw error` 上抛**,落到 plugin.ts:4155 的 express 错误中间件 → `500 {"error":"internal error"}`。runner 只看到四个字。
- runner 侧 `flywheel-comm complete`:5xx 重试 4 次(指数退避)后 fail-close 写 marker `~/.flywheel/state/complete-failed/<execId>.json` 并 exit 1。
- Bridge 侧 `complete-marker-reconciler.tryReconcileComplete`:回放 POST,`res.status >= 500 || 429` → `{kind:"transient_failed"}`,**不计次、不区分网络故障与确定性 500**;boot drain 对 transient 留到下次;heartbeat pass(`HeartbeatService.reconcileCandidateReadoptV2`)对 transient 直接 `markerRetryPending.add` 然后 **return** —— 连活体探测/僵尸判定都跳过。于是 session 永远 `running`,marker 永远回放、永远 500。

### 3.5 测试覆盖缺口

`grep -rn "verification_chained|verification_superseded|engine:rework_verification" packages/teamlead/src --include='*.test.ts'` → **0 命中**。链式验证的下一跳(implement→qa)在现有 2871 行的 `StateStore.workflow-rework.test.ts` 与 3900 行的 `StateStore.workflow-engine-transition.test.ts` 里没有一条用例走到。这是 bug 能溜到生产的根本原因。

`StateStore.workflow-rework.test.ts:757`("reopens a completed run into one idempotent operator rework attempt")的 fixture 恰好就是 FLY-1330 形态:design→implement done、run completed、**qa 从未跑过**、operator rework 到 implement attempt 2。只要再把 rework 投递到位并 `implement_done`,就能 RED 复现。

## 4. 三件要修的事 → 三层防线

issue 列了三件事,审计后它们天然分成三层、互不替代:

| 层 | 修什么 | 防什么 |
|---|---|---|
| ① 引擎 | 验证链下一跳没有历史 actor → **全新派发**(与首跑一致),链不中断 | 已知的合法状态不再被当 bug |
| ② 边界 | 引擎内部其它 `throw new Error("workflow_…")` 这类**不变量违反**,转成类型化错误 → `commitEnrolledCompletion` 接住 → 409 + reason 码 + 一次 Lead 告警 | 以后再有未预料状态,runner 能看见原因、Lead 立刻知道,而不是 500 盲重试 |
| ③ 回放 | marker 回放对**确定性失败**断路:同错 N 次 → 保留 marker、停止自动回放、Lead 告警一次;换 build 自动再试一次 | 任何其它未知 500 不再无限回放、不再把 session 冻在 running 而无人知道 |

## 5. 候选方案(只讨论第①层,②③形态基本唯一)

### A. 脱链:当场把验证路径置 completed,改走普通边
= 临时修复的机械化。简单,但把"验证链在途"这个不变量提前抹掉:`rework_already_open` / `rework_delivery_inflight` 这类守卫依赖 delivery 仍 open,脱链后 QA 还没跑完就能再开一条 operator rework。

### A′. 不脱链:新派发 + 路径原地前进(**推荐**)
和 A 一样全新派发 qa(`successorExecutionId` + `node_dispatched` intent,与首跑字节一致),但**不新铸 request**,而是把既有验证路径的 `current_node_id/current_attempt` CAS 推到 qa,delivery 保持 `wake_delivered`。qa 完成 → 目标是 gate → 现有的 gate 分支把路径与 delivery 正常结清。零新表、零新状态、一个新分支 + 一个新事件 `rework_verification_fresh_dispatch`。

### B. 链内换新人:复用 replacement 机制
新铸链式 request,但 `preferred_actor_execution_id` 给一个新 uuid、delivery 出生即 `replacement_pending`、side-effect ledger 写 `rework_replacement:<id>`,让 dispatcher 走 FLY-1612/1718 的"已证死 actor 换新"路径。能跑,但那条路径会写 `execution_dead_rolled_back` 事件和 `workflow_dead_execution_watch` 表 —— 给一个从未存在过的 actor 立"死亡证明",账本说谎;还要满足 `base_revision` 40-hex 的门。复杂且不诚实。

**结论**:A′。详见 research.md(证据)与 plan.md(落地)。

## 6. 不做什么(边界)

- 不改 operator 侧 `target_actor_history_missing` 合同(它是对的);
- 不改 runner 侧 `flywheel-comm complete` 的重试/marker 策略(4xx 也落 marker 是既有、可接受的行为);
- 不引入新的 feature flag(Annie 铁律:不加新 flag);
- 不为 FLY-1898(marker 对账器族)/ FLY-1895(rework 授权面)扩 scope;
- 不在本单对已卡住的生产 run 做手术(临时修复已做;修复合入后用 FLY-1847/1859/1814 的折入体做真机验证)。
