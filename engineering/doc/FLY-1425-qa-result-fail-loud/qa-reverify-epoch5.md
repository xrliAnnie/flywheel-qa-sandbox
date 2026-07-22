# FLY-1425 独立复验附录 — qa epoch 5(head da90be94 / PR #673)

Issue: FLY-1425 (https://linear.app/geoforge3d/issue/FLY-1425/enginebug2-qa-result-凭据缺失静默回退-events-假成功-fail-loud-引擎层未消费看门狗)
日期: 2026-07-22
基于: design-correction.md(看门狗已剥除,仅保留 fail-loud)、implementation-e2e.md、commit da90be94

## Verdict: **FAIL**(范围 = E2E harness + 证据完整性;**产品代码本身正确**)

founder-directive re-QA 三项里,item 2(看门狗真没了)、item 3(回归绿)通过;**item 1(重跑隔离 fail-loud E2E)不通过**——committed driver 崩、且实现者贴的 E2E 证据无法从该 driver 复现。

---

## Item 1 — fail-loud E2E:**FAIL(阻塞)**

### 1a. committed driver 崩在 seed,任何断言都跑不到(ground-truth)
`scripts/qa-fly-1425-fail-loud-e2e.mjs` 的 `seedQaAttempt`(line 116)用了
`rawDb(store).prepare(...).get(input.runId, input.executionId)`。实测:

```
TypeError: rawDb(...).prepare(...).get is not a function
    at seedQaAttempt (scripts/qa-fly-1425-fail-loud-e2e.mjs:116)
```

根因:StateStore(FLY-663)的 db 是 `CompatDb`,其 `prepare()` 返回 `CompatStatement`,
**只暴露 sql.js 接口(`getAsObject`/`step`/`bind`/`free`),没有 better-sqlite3 的 `.get()`**。
这是确定性的(CompatStatement 是 StateStore 的固定后端 shim,任何机器都一样),driver 在
自己进程的 seed 阶段就崩,**根本到不了 fail-loud 断言,更到不了 Bridge**。

修法:把 `.get(a,b)` 换成 `.bind([a,b]); .step(); .getAsObject()`(旧 watchdog E2E 是靠
`store.listWorkflowStalledDecisionCandidates(...)` 拿 credential id,不碰 `.get()`,所以旧 driver 能跑),
或改用 StateStore 公有方法。

### 1b. implementation-e2e.md 的 E2E 证据无法从 committed driver 复现
文档写「修正后的可复跑 driver 为 scripts/qa-fly-1425-fail-loud-e2e.mjs」并贴出
`clientFailLoud`(localExit:1/serverExit:1/eventsPersisted:0/…)。但该 driver 崩在 seed、
产不出任何 JSON;贴出的 `clientFailLoud` 字段形状与**剥除前**的 watchdog-era driver
(`qa-fly-1425-engine-watchdog-e2e.mjs`,已删)的输出块一致 → **误植/陈旧证据**,不是本 driver 的真实运行。

### 1c. driver 未覆盖 Annie item 1 的「带凭据→真消费+推进」半
committed driver 只测两条 credential-loss 屏障,完全没测 happy-path(带凭据→/decision 消费+节点推进)。

### 1d. 但产品侧 fail-loud 双闸**确实正确**(QA 独立验,fresh da90be94 dist)
- **客户端闸** CASE A:`FLYWHEEL_WORKFLOW_SUBMISSION_EXPECTED=1` + 空凭据 →
  exit 1,"deterministic rejection" 在任何网络请求前触发(Bridge URL 不可达但无 attempt 重试),
  报错点名缺失的 `FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL` + 反 env -u 提示。
- 阳性对照 CASE B:无 sentinel → 闸不触发,改走 /events(4× fetch failed)= 字节兼容。
- **服务端闸**:`event-route.test.ts:342 "rejects engine-owned qa_result on /events before persisting it"`
  真 router 集成测试通过 → 409 `workflow_submission_required`,事件零落库。

→ 结论:**bug 局限在 QA harness 脚本 + 其证据,不在产品运行时**。修 driver 的一行 `.get()`、
补 happy-path、真跑一遍重新生成诚实证据后即可满足 item 1。

---

## Item 2 — watchdog 真没了:**PASS**(独立复核,非只信 implement 审计)

- **源码零残留**:`grep -rnE '<所有看门狗标识符>' packages/*/src scripts` 全空
  (reconcileStalledDecisions / listWorkflowStalledDecisionCandidates / qa_decision_stalled /
  FLYWHEEL_QA_DECISION_WATCHDOG / FLYWHEEL_QA_DECISION_STALL_SOFT_MS / readRunnerDeclaredParkState / …)。
- **文件删除**:helper 源 `runner-declared-state.ts`、watchdog E2E `qa-fly-1425-engine-watchdog-e2e.mjs`、
  `runner-declared-state.test.ts` 均已删;`workflow-engine-dispatcher.test.ts` 的 651 行看门狗测试移除、保留原有 dead-exec/land 测试。
- **event-route 回退**:`isRunnerDeclaredParked` 回到内联(pre-FLY-1425 形态),不 import 已删 helper;仅保留 409 闸。
- **构建干净**:`pnpm build`(config→comm→teamlead 等)tsc 全绿 → 无悬空引用。
- **净 diff vs main**(production .ts,去 test):只剩 fail-loud(qa-result +189 / event-route +17 / sentinel plumbing / prompt);零看门狗生产代码。
- **运行时行为证明**(fresh dist 驱动,隔离 temp):喂入旧看门狗**确切**触发场景
  (engine-owned qa running + 未消费**已过期**凭据 + CommDB parked = 旧 hard+soft 双触发),
  reconcile 跑 4 次(时钟推进 65min)→ **零告警、零投递**,node 仍 running、凭据未消费;
  且 `store.listWorkflowStalledDecisionCandidates`、`store.hasWorkflowAlert`、
  `dispatcher.reconcileStalledDecisions` 均 = undefined(移除),ruler `listWorkflowAlertOutbox` 仍在(证移除是针对性的)。
- 非阻塞小项:陈旧 git-ignored dist orphan `packages/teamlead/dist/bridge/runner-declared-state.js`(死代码、无人 import、不随 PR ship,干净 `rm -rf dist` 重建即消失)。

---

## Item 3 — delta 回归:**PASS**(da90be94 rebuilt,clean env `env -u FLYWHEEL_RUNNER_BACKEND`)

| 套件 | 结果 |
|---|---|
| flywheel-comm qa-result | 53/53 ✓ |
| teamlead event-route(含 409 闸)+ workflow-engine-dispatcher(去看门狗后回归) | 113/113 ✓ |
| config feature-flags(看门狗 flag 移除后) | 33/33 ✓ |
| claude-runner TmuxAdapter + CodexTmuxAdapter(sentinel 注入) | 178/178 ✓ |
| edge-worker Blueprint.generalized-workflow | 5/5 ✓ |
| biome(7 改动文件,含 E2E 脚本) | 干净 ✓ |

---

## 修复清单(供实现者,ship 前)

1. `scripts/qa-fly-1425-fail-loud-e2e.mjs`:`seedQaAttempt` 的 `.get()` → `.bind([...]);.step();.getAsObject()`(或 StateStore 公有方法)。
2. 补 happy-path:带真凭据 → `/api/workflow/decision` 消费 + 节点推进 + `decision consumed` 诚实日志。
3. 真跑一遍隔离 fail-loud E2E,用**真实运行输出**替换 implementation-e2e.md 的 `clientFailLoud` JSON(去掉误植块)。
4.(可选)`rm -rf dist` 干净重建以清掉 orphan;非阻塞。
