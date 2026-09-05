# FLY-2313 pending 占位窗口收账 — 实施计划
Issue: FLY-2313 (https://linear.app/geoforge3d/issue/FLY-2313/病根-closeout-只在杀窗成功时才收-commdb-账而-pending-占位窗口按设计永远杀不掉-merge-后-thread)
日期: 2026-09-03
基于: research.md

> **For agentic workers:** execute inline under the injected DAG TURN. Follow strict
> test-driven development, commit each green behavior batch, and do not delegate or
> advance successor nodes.

**Goal:** 只在 kill 成功、现有 strictState 判据证明 `absent | dead_pin`、或 CommDB
session 已带终态结束证据时收通信账;保留 pending 安全拒绝并让所有 skipped
finalization 可诊断。

**验收边界:** Lead 已裁定本单不改 `post-merge.ts` / `post-ship-finalization.ts`,因此标题所述
post-merge 自动收尾仍只会从新 cause 获得可诊断性,不会在本单直接解除 held;close-runner
路径的收账解耦与 post-merge 判据对齐需分开验证。

**Architecture:** `closeRunnerInner` 继续用 `res.killed` 单独控制 `closed`、UI/detection 清理
与 thread archive。通信 finalization 使用三路独立证据:`res.killed`、复用
`cleanupTmuxTarget` strictState 已采用的 `probeRunnerProcessLiveness` 及其
`absent | dead_pin` 判据（只对非 pending 目标）、或 CommDB session 的
`ended_at + completed|timeout|failed`。pending 占位目标不运行 liveness probe,避免把
“占位名不存在”误作真实窗口死亡。没有任一证据时设置
`commdb_finalize_skipped:<raw kill error>`;pending 原话由 cause classifier 映射成
`window_identity_pending`。

**Tech Stack:** TypeScript, Vitest, pnpm monorepo, better-sqlite3 CommDB, sql.js-backed
in-memory `StateStore`.

---

## 文件边界

- Modify: `packages/teamlead/src/bridge/close-runner.ts`
- Modify: `packages/teamlead/src/__tests__/close-runner.test.ts`
- Modify: `packages/teamlead/src/bridge/lifecycle-closeout.ts`
- Modify: `packages/teamlead/src/bridge/__tests__/lifecycle-closeout.test.ts`
- Modify comment only: `packages/teamlead/src/bridge/post-merge.ts`
- Modify: `packages/teamlead/src/bridge/land-closeout-cause.ts`
- Modify: `packages/teamlead/src/bridge/__tests__/land-closeout-cause.test.ts`
- Create: `engineering/doc/FLY-2313-pending-closeout-finalization/{exploration,research,plan,progress}.md`
- Create last: `engineering/doc/milestones/FLY-2313.md`

不修改 `tmux-lookup.ts` 的 pending guard、不修上游窗口注册、不修改 `post-merge.ts` 的任何
行为（仅按 `[lead-instruction 2313-ruling-5]` 补同名字段语义注释）,不修改
`post-ship-finalization.ts`、`land-retry-policy.ts` 或任何 authority/gate/claim/approval 文件。

## Task 1: 用终态 CommDB 证据解除 pending 死结

**Files:**

- Modify: `packages/teamlead/src/bridge/close-runner.ts`
- Test: `packages/teamlead/src/__tests__/close-runner.test.ts`

- [ ] **Step 1: 在既有全局隔离下建立真实 CommDB fixture**

`packages/teamlead/vitest.setup.ts` 已为每个测试建立唯一 `FLYWHEEL_COMM_DIR`,并明确禁止
afterEach 删除仍可能被异步任务使用的目录。测试文件只引入 `mkdirSync`、`dirname`、
`CommDB` 和 `commDbPathForProject`;fixture helper 在该隔离根下注册
`runner-flywheel:pending`,然后通过 `updateSessionStatus` 或
`markSessionTerminalStatus` 写真实 `status + ended_at`:

```ts
function seedCommSession(status: "running" | "completed" | "timeout" | "failed") {
  const path = commDbPathForProject("flywheel");
  mkdirSync(dirname(path), { recursive: true });
  const db = new CommDB(path);
  db.registerSession(
    "exec-1",
    "runner-flywheel:pending",
    "flywheel",
    "FLY-102",
    "lead-a",
  );
  if (status === "completed" || status === "timeout") {
    db.updateSessionStatus("exec-1", status);
  } else if (status === "failed") {
    db.markSessionTerminalStatus("exec-1", "failed");
  }
  db.close();
}
```

- [ ] **Step 2: 写 completed + ended_at pending 的 RED 测试**

```ts
it("FLY-2313: finalizes a terminal pending session without claiming the window was killed", async () => {
  seedSession(store, "completed");
  seedCommSession("completed");
  mockGetTmuxTarget.mockReturnValue({
    tmuxWindow: "runner-flywheel:pending",
    sessionName: "runner-flywheel",
  });
  mockKillTmuxWindow.mockResolvedValue({
    killed: false,
    error: "tmux window identity is still pending",
  });
  const archiveFn = vi.fn();

  const result = await closeRunner(
    makeOpts({ archive: { projects: [], archiveFn } }),
    store,
  );

expect(result).toEqual({
  closed: false,
  physicalGone: false,
  commDbFinalized: true,
    retiredGateCount: 2,
    error: "tmux window identity is still pending",
  });
  expect(mockFinalizeCommDbSession).toHaveBeenCalledTimes(1);
  expect(mockProbeRunnerProcessLiveness).not.toHaveBeenCalled();
  expect(mockCloseRunnerTerminalView).not.toHaveBeenCalled();
  expect(archiveFn).not.toHaveBeenCalled();
});
```

Run:

```bash
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/close-runner.test.ts -t "FLY-2313: finalizes a terminal pending session"
```

Expected RED: `commDbFinalized` is false and finalizer call count is zero。

- [ ] **Step 3: 添加只读 CommDB terminal evidence helper**

在 `close-runner.ts` 内新增窄集合和 fail-closed helper。复用
`commdb-session-prune.ts` 已导出的 `resolveCommDbPath`,DB 缺失、readonly open 或 query
失败均返回 false;始终 close handle。close-runner 测试对该模块的 mock 改为
`importOriginal` 后只覆盖 `finalizeCommDbSession`,确保 resolver 仍是真实实现:

```ts
const COMM_DB_ENDED_STATUSES = new Set(["completed", "timeout", "failed"]);

function hasEndedCommDbSession(executionId: string, projectName: string): boolean {
  const dbPath = resolveCommDbPath(projectName);
  if (!dbPath) return false;
  let db: CommDB | undefined;
  try {
    db = CommDB.openReadonly(dbPath);
    const session = db.getSession(executionId);
    return Boolean(
      session?.ended_at && COMM_DB_ENDED_STATUSES.has(session.status),
    );
  } catch (error) {
    console.warn(
      `[close-runner] CommDB terminal evidence unavailable for ${executionId}: ${(error as Error).message}`,
    );
    return false;
  } finally {
    db?.close();
  }
}
```

- [ ] **Step 4: 实现最小三路判据**

为现有 tmux mock 增加 `probeRunnerProcessLiveness` seam,默认 `indeterminate`。生产代码只在
`res.killed === false` 且 target 不是 `:pending` 时 probe,并严格复用
`cleanupTmuxTarget` strictState 的 `absent | dead_pin` 集合。pending 只禁用针对占位串的
无效探测,它本身不是 finalization 证据。代码注释原样保留 Lead 指定的防回归句:
“The name is used only to reject invalid liveness evidence, never as death evidence.”

```ts
const runnerLiveness = res.killed || target.tmuxWindow.endsWith(":pending")
  ? undefined
  : await probeRunnerProcessLiveness(target.tmuxWindow);
const terminalCommDbEvidence = hasEndedCommDbSession(
  opts.executionId,
  opts.projectName,
);
const commDbCanFinalize =
  res.killed ||
  runnerLiveness === "absent" ||
  runnerLiveness === "dead_pin" ||
  (runnerLiveness !== "alive" && terminalCommDbEvidence);
```

把原 finalization block 的 gate 改成 `if (commDbCanFinalize)`,但所有 UI、detection、archive
的 `if (res.killed)` 不动,最终 `closed: res.killed` 不动。在 `killed:false` 的最终结果
显式返回 `physicalGone = runnerLiveness === "absent" || runnerLiveness === "dead_pin"`;
`killed:true` 不带该字段,保持序列化逐字节不变。`CloseRunnerResult` 接口字段必须写清三态
及每态可能被误读的条件:

- undefined = killed/early 路径未评估;缺字段不等于 false,若用 falsy 判断会把正常 killed
  路径误作未 gone;
- false = 已评估但未证 gone（alive/indeterminate/terminal-only）;它不证明进程 alive,
  因为 indeterminate 或终态记录也可能对应已死进程;
- true = 非 pending probe 证实 `absent | dead_pin`;stale 的非 pending 映射仍可能对一个已迁移
  的活体旧目标返回 absent,所以它不是身份 authority。

判据旁另写三条 evidence failure mode:`res.killed` 只证明目标 teardown/已不存在,不验证
映射来源永远新鲜;process probe 对 stale target 会错误返回 absent,且 pending 已专门否决;
terminal row 可能先于进程退出,所以明确 alive 必须否决。两处接口都注明它与
`post-merge.ts` 的 `CleanupTmuxTargetResult.physicalGone` 不是同一谓词;后者是必填 cleanup
outcome 且 killed=true 时为 true,本字段 killed=true 时反而 undefined。若
`commDbCanFinalize && !res.killed`,在破坏性 finalizer 前重新调用现有
`authorityLostReason()`。该调用只读现有 `opts.authorityCheck`,只能收紧:返回 false 或抛出时
立即 `abortAuthorityLost("pre_commdb_finalize", lost)`,不收账并走既有 authority-lost audit;
它不写 authority/gate/approval/claim,不更改批准判据,也不会让任何原本被拒路径获准。
⛔ 此子步骤只有在 Lead 明确看过并批准口径后才可实现;该 checkpoint 已由
`[lead-instruction 2313-approved]` 满足。

- [ ] **Step 5: 写 authority 中途失效的 RED→GREEN 测试**

让 `authorityCheck` 在 preflight/pre-kill 阶段返回 ok,在未杀窗的 terminal evidence 成立后
返回 `authority_reopened`。断言结果包含
`authority_lost:pre_commdb_finalize:authority_reopened`,且 finalizer 零调用。
该实现 checkpoint 已由 `[lead-instruction 2313-approved]` 明确放行。

- [ ] **Step 6: 确认 focused 与完整文件 GREEN**

```bash
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/close-runner.test.ts -t "FLY-2313"
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/close-runner.test.ts
```

- [ ] **Step 7: 提交第一批行为**

```bash
git add packages/teamlead/src/bridge/close-runner.ts packages/teamlead/src/__tests__/close-runner.test.ts
git commit -m "fix(teamlead): finalize provably ended runner communications"
```

## Task 2: 锁死 pending + running 负向路径并记录 skipped 原因

**Files:**

- Modify: `packages/teamlead/src/bridge/close-runner.ts`
- Test: `packages/teamlead/src/__tests__/close-runner.test.ts`

- [ ] **Step 1: 写最危险组合的负向测试**

StateStore status=`running` 时传 `issueTerminalOverride: true`,CommDB 保持 register 后的
`running + ended_at null`,target 为 pending,并把 probe seam 预设成 `absent`。断言 finalizer
与 liveness probe 都未调用:

```ts
mockProbeRunnerProcessLiveness.mockResolvedValue("absent");
expect(result).toEqual({
  closed: false,
  physicalGone: false,
  commDbFinalized: false,
  retiredGateCount: 0,
  error: "commdb_finalize_skipped:tmux window identity is still pending",
});
expect(mockFinalizeCommDbSession).not.toHaveBeenCalled();
expect(mockProbeRunnerProcessLiveness).not.toHaveBeenCalled();
```

Run focused。Expected RED:旧结果仍返回 raw pending error,没有 structured skipped prefix。

- [ ] **Step 2: 无条件记录每次 skipped finalization**

在 `commDbCanFinalize` false 分支设置:

```ts
finalizeError = `commdb_finalize_skipped:${res.error ?? `tmux_window_${runnerLiveness ?? "indeterminate"}`}`;
```

最终结果改为 `error: finalizeError ?? res.error`。这条逻辑不按 pending/权限/超时分类;
只要没有收账证据就必定留下理由。

- [ ] **Step 3: 参数化终态与 liveness 控制**

添加以下独立断言:

- CommDB `completed|timeout|failed` 各自带 `ended_at` + pending ⇒ no probe + finalizer once;
- pending + running + probe preset absent ⇒ no probe + finalizer zero;
- 非终态 + kill false + liveness absent/dead_pin ⇒ finalizer once;
- 非终态 + kill false + liveness alive/indeterminate ⇒ finalizer zero;
- 终态 + 非 pending + kill false + liveness alive ⇒ finalizer zero + `physicalGone:false` +
  structured skipped error;
- pending finalizer 自身失败 ⇒ `commdb_finalize_failed:<db error>`,不被 raw tmux error 覆盖;
- 所有 `res.killed:false` 结果仍是 `closed:false`,且 archive/UI/detection 不运行。
- 所有 `res.killed:false` 最终结果带显式 `physicalGone`;只有非 pending
  `absent | dead_pin` 为 true,terminal-only、alive、indeterminate 均为 false。

- [ ] **Step 4: 验证并提交**

```bash
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/close-runner.test.ts -t "FLY-2313"
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/close-runner.test.ts
git add packages/teamlead/src/bridge/close-runner.ts packages/teamlead/src/__tests__/close-runner.test.ts
git commit -m "fix(teamlead): explain skipped communication finalization"
```

## Task 3: 把 physical-gone 事实传给 lifecycle,阻止误归档

**Files:**

- Modify: `packages/teamlead/src/bridge/lifecycle-closeout.ts`
- Test: `packages/teamlead/src/bridge/__tests__/lifecycle-closeout.test.ts`

- [ ] **Step 1: 写 pending terminal teardown-failed 的 RED 测试**

构造一个 closeout node,让 `closeRunnerFn` 返回
`{ closed:false, physicalGone:false, commDbFinalized:true, error:<pending raw> }`,并让后续
`lookupTarget` 返回 gone（模拟 finalizer 已删 CommDB row）。断言 report outcome=blocked、
node teardown=failed、`confirmedGone=false`,且 `archiveThreads` / `linearConsistency` 零调用。
当前代码会把 lookup gone 当 confirmedGone=true 并运行 issue-level cleanup,所以必须 RED。

- [ ] **Step 2: 最小消费显式 false,保留 undefined 老路径**

`closeoutOneNode` 在 closeRunner 返回后,若 `closeRes.physicalGone === false`,跳过
post-finalize lookup 并保持 `result.confirmedGone=false`。严格使用 `=== false`,不能用 falsy,
确保 killed=true 老结果的 undefined 不被误当 false。补控制测试:`closed:true` 且字段缺失
仍按原路径 complete。同步只编辑 `post-merge.ts` 的 `CleanupTmuxTargetResult.physicalGone`
注释,写明它是必填 cleanup outcome、killed=true 时为 true,与 close-runner optional 三态字段
不同;不改变任何 post-merge 行为。

- [ ] **Step 3: GREEN、mutation 与提交**

临时删除显式 false 分支,运行 focused test,Expected FAIL:archive 被调用/outcome partial。恢复后:

```bash
pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/lifecycle-closeout.test.ts -t "FLY-2313"
git add packages/teamlead/src/bridge/lifecycle-closeout.ts packages/teamlead/src/bridge/__tests__/lifecycle-closeout.test.ts
git commit -m "fix(teamlead): preserve physical closeout evidence"
```

## Task 4: 给 pending 拒绝一个稳定 cause

**Files:**

- Modify: `packages/teamlead/src/bridge/land-closeout-cause.ts`
- Test: `packages/teamlead/src/bridge/__tests__/land-closeout-cause.test.ts`

- [ ] **Step 1: 写 cause RED 测试**

```ts
expect(
  inferLandCloseoutCause([
    "commdb_finalize_skipped:tmux window identity is still pending",
  ]),
).toBe("window_identity_pending");
```

Run:

```bash
pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/land-closeout-cause.test.ts
```

Expected RED:实际得到 `unknown`。

- [ ] **Step 2: 最小实现 enum、matcher 与中文说明**

在 `LAND_CLOSEOUT_CAUSES` 中把 `window_identity_pending` 放在
`commdb_finalize_failed` 之后,保证同一报告同时含 DB finalizer 故障与 pending 原话时仍优先
暴露 DB 故障;matcher 匹配完整稳定原话 `tmux window identity is still pending`;
`describeLandCloseoutCause` 返回“Runner 窗口身份仍未完成注册”。补一条多错误优先级测试。
不修改 retry policy,且现有 cause 之间的相对次序不变。

- [ ] **Step 3: GREEN 并提交**

```bash
pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/land-closeout-cause.test.ts
git add packages/teamlead/src/bridge/land-closeout-cause.ts packages/teamlead/src/bridge/__tests__/land-closeout-cause.test.ts
git commit -m "fix(teamlead): classify pending window closeout"
```

## Task 5: 正常路径、真实 guard 与 mutation 证明

**Files:**

- Test: `packages/teamlead/src/__tests__/close-runner.test.ts`
- Temporary mutation only: `packages/teamlead/src/bridge/close-runner.ts`

- [ ] **Step 1: 锁定 killed=true 的既有序列化结果**

在现有 successful-kill case 保持 full object equality,并补:

```ts
expect(JSON.stringify(result)).toBe(
  '{"closed":true,"commDbFinalized":true,"retiredGateCount":2}',
);
expect(mockProbeRunnerProcessLiveness).not.toHaveBeenCalled();
expect(mockFinalizeCommDbSession).toHaveBeenCalledTimes(1);
```

- [ ] **Step 2: 运行真实 pending kill guard**

```bash
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/tmux-lookup.exec-identity.test.ts -t "pending"
```

Expected:仍返回 killed false + 原始 pending error,底层 audit/exec 未调用。

- [ ] **Step 3: 运行两条 mutation 阳照**

临时把 `commDbCanFinalize` 变异回只读 `res.killed`,运行 terminal-pending focused test。
Expected FAIL: `commDbFinalized` false/finalizer zero。立即用 `apply_patch` 恢复三路判据,
运行 `git diff --check` 与 focused test 确认 GREEN。

再临时删除 `target.tmuxWindow.endsWith(":pending")` 的 probe 跳过条件,运行
pending-running focused test（probe seam 预设 `absent`）。Expected FAIL:错误调用 probe 与
finalizer。恢复后,再临时删除 terminal evidence 上的 `runnerLiveness !== "alive"` veto,
运行 terminal + non-pending + alive focused test。Expected FAIL:活体被收账。立即恢复并确认
GREEN;三次 mutation 都不提交。

- [ ] **Step 4: 运行组合控制并提交测试强化**

```bash
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/close-runner.test.ts -t "FLY-2313|successful kill"
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/tmux-lookup.exec-identity.test.ts -t "pending"
git add packages/teamlead/src/__tests__/close-runner.test.ts
git commit -m "test(teamlead): guard pending closeout evidence"
```

## Task 6: 全仓验证、代码审查与 PR

- [ ] **Step 1: 核边界与静态差异**

```bash
git diff origin/main...HEAD -- packages/teamlead/src/bridge/close-runner.ts packages/teamlead/src/bridge/lifecycle-closeout.ts packages/teamlead/src/bridge/post-merge.ts packages/teamlead/src/bridge/land-closeout-cause.ts packages/teamlead/src/__tests__/close-runner.test.ts packages/teamlead/src/bridge/__tests__/lifecycle-closeout.test.ts packages/teamlead/src/bridge/__tests__/land-closeout-cause.test.ts
git diff --check
git status --short
```

- [ ] **Step 2: 运行精确全仓 gates**

```bash
pnpm lint
pnpm -r build
pnpm test:packages:run
```

再发现并逐一执行所有 `scripts/__tests__/*.test.sh`。

- [ ] **Step 3: 通过 codex:rescue 审查并注册正式 code-review gate**

从仓库脚本解析 `codex:rescue` 当前入口,禁止 raw `codex exec`。修复 blocking findings并
重跑验证。随后 `stage set code_review`,用必填 message 打开 `review_code --no-block`,把返回的
questionId 传给 `request-review --type code`,持续 `check` 到 APPROVED;每轮 CHANGES 都新开 gate。

- [ ] **Step 4: push 与建 PR 前重查 inbox**

处理所有新 Lead instruction,然后 push feature branch并创建 PR;不 merge、不请求 ship approval。
PR body 原样写入 “The name is used only to reject invalid liveness evidence, never as death
evidence.”,并分别披露:

- close-runner 比 post-ship non-strict `physicalGone` 多认非 pending 的 `absent | dead_pin`;
- `cleanupTmuxTarget` 的 `strictState` 对 pending 占位串执行 process probe 时也可能误收
  `absent`；位置为 `packages/teamlead/src/bridge/post-merge.ts`,本单因锁定范围与独立验证要求
  不修改,Lead 已登记后续单。
- 本单按 `[lead-instruction 2313-ruling-4]` 额外修改 `lifecycle-closeout.ts`:若不一起消费
  上游显式 `physicalGone:false`,finalization 删除 row 后会被误反推为 gone,导致 teardown
  failed 的 thread 被归档。

- [ ] **Step 5: milestone 作为 literal last commit**

创建 `engineering/doc/milestones/FLY-2313.md`,写实际 PR 号、验证与 review 事实,只提交该
文件并 push。此后不运行会创建 progress commit 的命令。

- [ ] **Step 6: 报告与 bounded completion**

`ask --report` 的 DONE 同时引用完整 `[lead-instruction 2313-scope-and-boundary]`、
`[lead-instruction 2313-ruling]`、`[lead-instruction 2313-ruling-2]` 与
`[lead-instruction 2313-ruling-3]`、`[lead-instruction 2313-gate-approved]` 与
`[lead-instruction 2313-ruling-4]`、`[lead-instruction 2313-approved]`、
`[lead-instruction 2313-ruling-5]`,列出 commits/PR。最后运行
`complete --route needs_review --pr <实际 PR 号>`;不 dispatch QA,不 merge,不 deploy。

## 计划自审

- Spec coverage:三路死亡/终态证据、pending-running 负向格、closed 不变、所有 skipped
  有原因、typed cause、真实 guard、mutation 阳照、全仓 gates/review/PR 均有步骤。
- Placeholder scan:运行时 gate/PR 标识由命令真实输出提供;没有未定设计或省略实现。
- Type consistency:使用既有 `RunnerLiveness`、CommDB `Session.status/ended_at`,并给
  `CloseRunnerResult` 新增 optional `physicalGone`;undefined 与 false 有显式不同语义。
- Scope check:不修 pending 注册来源,不触碰相邻 FLY-2115 文件或 post-ship 文件。
- PR body 明示已知判据差异:close-runner 会认 `absent | dead_pin`,post-ship 当前 non-strict
  `physicalGone` 只认 `killed`;本单因范围与独立验证要求不联改,后续应专单对齐。
