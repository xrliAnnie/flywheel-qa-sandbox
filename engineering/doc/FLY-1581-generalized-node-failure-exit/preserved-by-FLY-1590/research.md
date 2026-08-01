# FLY-1581 generalized node 无法「正常地失败」— 调研

Issue: FLY-1581 (https://linear.app/geoforge3d/issue/GEO/issue/FLY-1581)
日期: 2026-07-31
基于: exploration.md

> 本文只写**本仓源码里核实过的事实**,每条带 `file:line`。推论与方案在 exploration.md / plan.md。
> 核实基线:`flywheel-FLY-1581` worktree,HEAD `ab2ec6b2`,`doc/VERSION = v1.55.0`。

---

## 1. 模板侧 — 谁教了 `complete --route blocked`

| 位置 | 内容 | 注入条件 |
|---|---|---|
| `packages/edge-worker/src/Blueprint.ts:2042` | PIPELINE PREAMBLE (5)(Claude runner)`complete --route blocked --summary "onboard_failed: <short reason>"` | `ctx.projectName` 存在且非 resume-suppressed。**不区分 generalized** |
| `packages/edge-worker/src/Blueprint.ts:2033` | 同上,Codex runner 版本 | 同上 |
| `agents/generic-executor.md:67, 81, 158` | fallback agent role 三处教 `complete --route blocked` | 无 `agent.md` 的项目(FLY-217) |
| `.flywheel/agents/engineering/pm-executor.md:116`、`prototype-executor.md:156` | 部门 executor role | 按 label 路由 |
| `packages/claude-runner/src/CodexTmuxAdapter.ts:1318` | gate 超时 fail-close 提示词 | Codex gate 超时 |

**关键事实:`Blueprint.ts:2022` 的注入条件只看 `ctx.projectName` 与 resume 抑制,完全不看 `isGeneralizedExecution`(该布尔量在同文件 `:1449` 就已算出并在 `:1559 / :1576 / :2164 / :2186` 被反复使用)。** 也就是说 generalized node 拿到的失败出口指令,和 legacy runner 逐字相同。

## 2. 引擎侧 — 合法路由集(scope ① 的答案)

### 2.1 类型层单一真相

`packages/config/src/node-type-registry.ts:10-13`

```ts
export type WorkflowCompletionRoute =
  | "phase_design_complete"
  | "needs_review"
  | "no_code";
```

`blocked` **不在其中**。

### 2.2 每种 node type 钉死一条(`node-type-registry.ts:62-142`)

| node type | completion_route | shared_branch_writer | creates_pr | 是否 no-write |
|---|---|---|---|---|
| design | `phase_design_complete` | true | false | 否 |
| implement | `needs_review` | true | true | 否 |
| qa | `no_code` | true | false | 否 |
| gate | `needs_review` | false | false | **是** |
| land | `no_code` | false | false | **是** |
| **generic** | **`no_code`** | false | false | **是** |
| review | `needs_review` | false | false | **是** |

### 2.3 快照层重复校验

`packages/teamlead/src/workflow-run-snapshot.ts:470-474` —— 解析 run snapshot 时同样只认这三个,否则 `throw new Error(...completion_route is unknown)`。

### 2.4 Blueprint 侧第三次重复

`packages/edge-worker/src/Blueprint.ts:1585-1593` —— generalized 分支再手写一遍三值白名单,不匹配就 `throw unsupported generalized completion route`。

> **三处独立硬编码同一组三值**(`node-type-registry.ts` / `workflow-run-snapshot.ts` / `Blueprint.ts`)。这本身就是「两边各写各的」的现成隐患,合同测试要把它们收成一处。

## 3. 409 是怎么发生的 — 逐行

1. `packages/flywheel-comm/src/commands/complete.ts:42-51` — CLI 的 `VALID_ROUTES` **含 `blocked`**,所以 CLI 层放行,不报错。
2. 发 `POST {bridge}/events`,`event_type=session_completed`,`source=flywheel-comm`,`payload.decision.route="blocked"`。
3. `packages/teamlead/src/bridge/event-route.ts:696-697` — `session_completed` + `source === "flywheel-comm"` 进入 generalized 前置分支。
4. `event-route.ts:729-732` — 用 `getGeneralizedWorkflowNodeForActivation`(带 activation)或 `getGeneralizedWorkflowNodeForExecution`(不带)取 `generalizedContext`。**FLY-7 那次 `runner_workflow_activation` 表查不到行(scrollback:165-166),所以走的是 execution 查法,一样命中 enrolled。**
5. `event-route.ts:861` — `store.commitEnrolledCompletion({ route: decision.route })`。
6. `packages/teamlead/src/StateStore.ts:24830-24832` —
   ```ts
   if (input.route !== context.node.capabilities.completion_route) {
       return { ok: false, reason: "route_mismatch" };
   }
   ```
7. `event-route.ts:899-909` — 非白名单 reason → `res.status(409).json({ error: "workflow_completion_rejected", reason: "route_mismatch" })`。**注意:`retryable` 字段只在 completion 结果自带时才透传,`route_mismatch` 不带 → 响应无 `retryable`。**
8. `complete.ts:387-393` — 4xx、非 429、`retryable !== true` → **立即 `break`,不再重试**。故终端只看到 `attempt 1/4 failed`(与 scrollback:110 逐字吻合)。
9. `complete.ts:408-419` — 写 marker,打印 `FAIL-CLOSE`。

## 4. marker 重放为什么也落不了地(scope ③)

- `packages/teamlead/src/bridge/complete-marker-reconciler.ts:95-110` — reconciler 的 `VALID_ROUTES` **含 `blocked`**,所以 marker **不是**因为「路由不认识」被 quarantine。
- `complete-marker-reconciler.ts:728` — 重放走的是**同一个** `POST {bridgeBaseUrl}/events`。
- 于是重放拿到同一个 409 `route_mismatch`。
- `complete-marker-reconciler.ts:746-765` — `!res.ok` 且不是 `missing_output`+`retryable` 的特例 → `moveToQuarantine(...)` → `{ kind: "quarantined", reason: "rejected" }`。

> **单一入口是设计意图(所以修好 `/events` 的准入,重放自动跟着好)——但也正因为单一入口,`/events` 拒绝什么,marker 就必然被 quarantine 什么。**「失败这件事本身留不下正常痕迹」的机制被完整证实。

## 5. 对照组:legacy runner 的同一条命令是好用的

`packages/teamlead/src/bridge/event-route.ts:1603, 1654`

```ts
} else if (route === "blocked" || route === "ship_attempt_failed") {
    ...
    status = "blocked";
```

legacy(未 enroll)执行走到这里,`route=blocked` → 会话终态 `blocked`,Lead 收到 `session_completed`。

**enrolled execution 在 `:696` 就短路进 generalized 分支并 `return`,永远到不了 `:1603`。**

> 这是本单最硬的判据:**同一个词、同一条命令,在 legacy 侧有正常终态,在 generalized 侧恒被拒。** 不是「模板发明了一个不存在的东西」,是「generalized 引擎没继承已有的终态」。

## 6. 引擎那条「看起来像失败」的入口,为什么不是

### 6.1 它存在

`event-route.ts:956-988` — `event_type === "session_failed"` 且 enrolled → `store.recordEnrolledTerminalSignal({ signal: "failed", failureKind, lastError })` → 200 `{ teardown: "held_recorded" }`。

`StateStore.ts:21321-21326` — `failureKind === "goal_blocked"` → 会话 status 落 `blocked`,否则 `failed`;并写 `generalized_teardown_recorded` run 事件(`:21420-21436`)。

### 6.2 但 runner 发不出来

`packages/flywheel-comm/src/commands/` 下 44 个命令(`index.ts:200-345` 的 dispatch 表)**没有任何一个发 `session_failed`**。全仓 `session_failed` 的发射点只有两处:

- `packages/edge-worker/src/ExecutionEventEmitter.ts:220`(edge-worker 在 adapter 返回失败后发)
- `packages/teamlead/src/DirectEventSink.ts:1265`

### 6.3 `goal_blocked` 是 Codex 专属

全仓产 `failureKind: "goal_blocked"` 的**唯一**源头:`packages/claude-runner/src/CodexTmuxAdapter.ts:1041-1046` —— 条件是 codex resident goal 自报 `outcome.result.status === "blocked"`。

`packages/core/src/adapter-types.ts:394` — `TerminalFailureKind = "goal_blocked" | "worktree_takeover_failed"`,是 **adapter 层**概念,不是 runner 可声明的东西。

**⇒ Claude tmux runner(generalized node 的常态)没有任何途径产生 `goal_blocked`。**

### 6.4 就算发出来,DAG 也会把它当「崩了」重派

- `StateStore.ts:299-307` — `ZOMBIE_IRREVERSIBLE_TERMINAL_STATUSES` **含 `blocked`**。
- `packages/teamlead/src/bridge/workflow-engine-dispatcher.ts:1157-1327 reconcileDeadExecutions()`:
  - `:1181-1190` — session 是 zombie-terminal **或**有 teardown fact → 进入回收流程;
  - `:1191-1199` — 若该 attempt 已有 completion receipt 则跳过(失败没有 receipt,所以不跳);
  - `:1216-1226` — `MAX_BLIND_REPLACEMENTS = 3`(`StateStore.ts:87`)内按 60s / 5min / 15min 退避;
  - `:1227-1239` — 探活,`dead` 才动手;
  - `:1303-1318` — `rollbackDeadWorkflowNodeExecution(reason: "terminal_session_and_dead_probe")` → **换新 execution id 重派**。
- `StateStore.ts:22263-22273` — 超过上限才发 severe 告警:「【需人工】<issue> 节点 <node> 盲换 3 次仍起不来 …… run 已挂起(held)」。

**⇒ 引擎对 generalized node 的「失败」模型只有一种:进程崩了 → 重试 3 次 → 叫人。没有「想清楚了故意停」。**

## 7. 三个 completion sink(任何修法必须三处一致)

| sink | 文件 | enrolled 分支 |
|---|---|---|
| HTTP `/events` | `packages/teamlead/src/bridge/event-route.ts:861` | `commitEnrolledCompletion` |
| 进程内 | `packages/teamlead/src/DirectEventSink.ts:534-562` | `recordEnrolledTerminalSignal({signal:"completed"})`;`creates_pr` 节点直接拒绝(`:540-545`) |
| marker 重放 | `packages/teamlead/src/bridge/complete-marker-reconciler.ts:728` | 复用 HTTP sink |

FLY-1505 已经建立了「三 sink 对某个 route 一致 deflect」的先例(`event-route.ts:1603` / `DirectEventSink.ts:751` 的 `ship_attempt_failed`),**本单的修法应当照抄这个形状**。

## 8. 两个附带观察的定位结论

### ① `ask` 401(信号与真相反向)

`packages/flywheel-comm/src/lead-inbox-nudge.ts:34-90`

- 401 来自 `POST {bridge}/api/lead-inbox/nudge` —— 函数 doc 自述:「Best-effort doorbell … **The queue row is the authority**; this request only shortens the next adaptive poll interval.」(`:30-33`)
- `:69-79` 已有一次 token 刷新重试(从 `~/.flywheel/.env` 读 `TEAMLEAD_API_TOKEN`);两次都 401 才打印。
- `:81-85` 的文案 `lead inbox nudge returned 401; durable queue row retained` —— **后半句说了真话,但 `401` 三个字符的权重压过了它**。
- 真实后果:消息在,但 Lead 的通知从「门铃即时」降级为「下一次自适应轮询」。这是**运维告警级**的事实(每一条 Runner→Lead 通知都在降级),现在却只是一行 stderr。

### ② progress lock 掩盖 ENOENT

`packages/flywheel-comm/src/commands/progress.ts:387-406`

```ts
const lockPath = `${absPath}.lock`;
for (let attempt = 0; attempt < 50 && fd === undefined; attempt++) {
    try { fd = openSync(lockPath, "wx"); }
    catch {                       // ← 不看 err.code
        try { const age = ...; if (age > 30_000) rmSync(lockPath, ...); } catch {}
        sleepMs(100);
    }
}
if (fd === undefined) throw new Error(`could not acquire progress lock ${lockPath} after bounded retry (another writer holds it)`);
```

父目录不存在 → `openSync` 抛 `ENOENT` → 被同一个瞎 `catch` 吞掉 → 自旋 5 秒 → 报「另一个 writer 占着锁」。**`EEXIST`(真被占)与 `ENOENT`/`EACCES`(结构性错误)被合并成同一个错误面。**

### ③ 本 node 撞到的第三条(新)

`progress.ts:186-209` —— `flywheel-comm progress` 会 `git add` + `git commit --only -- <progress.md>`。而 baseline-rules 的 **PROGRESS LEDGER** 段要求「每个有意义的步骤后」都跑它;同一份提示词的 generalized 段(`Blueprint.ts:1602-1604`)对 no-write node 又写着 `do not modify the shared branch, create commits, push, or open a PR`。

**两条硬规则对 `gate` / `land` / `generic` / `review` 四种 no-write node 直接冲突**,根因与主线同源:baseline-rules 按 legacy runner 写就,注入 generalized node 时没有按该 node 钉死的 capabilities 做对账。
