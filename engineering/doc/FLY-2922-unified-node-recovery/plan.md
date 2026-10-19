# FLY-2922 房间 tmux 探活隔离 — 实施计划
Issue: FLY-2922 (https://linear.app/geoforge3d/issue/FLY-2922/病根修复-8-held-回滚之后有出口只留一个统一恢复口放行必须真铸出派发关死体不连带终结-run9-张-37)
日期: 2026-09-28
基于: research.md

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development, then execute this plan task-by-task. The Implement DAG node owns code changes; the Design node must not implement or dispatch successors.

**Goal:** 让 generalized 529 driver 的所有 runner pane 探活都进入当前测试房间的 tmux server，使 step 4 正确识别已 `ship_parked` 且 QA 已派发的实现体，同时保持错误 target、execution 与 dead pane fail closed。

**Architecture:** 新增一个 library-level `probeRoomPaneAlive` 作为唯一 tmux 探活口。它以 validated absolute `slotDir` 选择 `TMUX_TMPDIR`，清除 client-local 坐标，再复用既有 exact object/execution predicate。driver 的 `probeExecution` 只消费该 helper；产品 workflow/recovery 代码不动。

**Tech Stack:** Node.js ESM、Node test runner、Bash harness、tmux、Git merge、pnpm lint/build、GitHub Actions exact-head CI。

---

## 1. 文件地图与边界

修改：

- `scripts/lib/qa-generalized-e2e-lib.mjs` — room-scoped tmux probe，保持纯边界和可注入 spawn。
- `scripts/qa-529-generalized-e2e.mjs` — 删除内联 `paneAlive`，让 `probeExecution` 传递 slot authority。
- `scripts/__tests__/qa-generalized-e2e-lib.test.mjs` — isolated-socket RED/GREEN、helper contract 和 step-4 classifier 对照。
- `scripts/__tests__/test-deploy-generalized.test.sh` — 单一探活口的静态结构守卫。
- `engineering/doc/milestones/FLY-2922.md` — merge 取舍、根因和定向证据。

只因 merge main 而变更：

- `scripts/test-deploy.sh` — 冲突时保留本单 `--qa-stub-runner` 与 main 的 `--codex-source-home`，不修改两者运行语义。

禁止修改：

- `packages/teamlead/src/StateStore.ts`
- `packages/teamlead/src/bridge/workflow-node-recovery.ts`
- `packages/teamlead/src/bridge/workflow-engine-dispatcher.ts`
- `packages/claude-runner/**`
- `.flywheel/agents/nodes/qa.md`
- review coordinator / evidence judge / product schema

若实现需要触碰禁止面，停止并报告设计假设失效；不要把 harness 的 socket 选择扩成产品协议。

## 2. Task 1：取得 TURN、合 main、记录冲突取舍

**Files:**

- Modify only on conflict: `scripts/test-deploy.sh`
- Inspect: `scripts/qa-529-generalized-e2e.mjs`
- Inspect: `scripts/lib/qa-generalized-e2e-lib.mjs`

- [ ] **Step 1：取得写权限并合 main，不 rebase**

```bash
node "$FLYWHEEL_COMM_CLI" turn
git fetch origin
git merge origin/main
```

Expected: `turn` 输出 `yours`；merge 完成或只留下需要人工处理的冲突。禁止 force-push。

- [ ] **Step 2：解决 `scripts/test-deploy.sh` 冲突**

usage 必须同时表达：

```bash
#        [--generalized [--codex-runner] [--stub-runner|--qa-stub-runner]
#          [--expect-head <full-sha>]
#          [--voice-fixture <public-json>] [--codex-fault-sequence <csv>]
#          [--codex-source-home <prepared-dir>]]
```

保留 main 的 `--codex-source-home` parser/validation/env injection，也保留本单的 `--qa-stub-runner` parser/validation/selector install。不要新增二者互相依赖。

- [ ] **Step 3：核对 merge 后两边语义都在**

```bash
git grep -nF -- '--qa-stub-runner' scripts/test-deploy.sh
git grep -nF -- '--codex-source-home' scripts/test-deploy.sh
git diff --check
git status --short --branch
git log --oneline -10
```

Expected: 两个 literal 都有 usage、parse 和 validation 命中；`git diff --check` 无输出。

- [ ] **Step 4：提交 main sync**

```bash
git add scripts/test-deploy.sh
git commit -m "Merge origin/main into flywheel-FLY-2922"
```

Expected: merge commit message 在正文记录双方合同均保留；若 merge 无冲突，按仓库正常 merge commit 流程提交。

## 3. Task 2：发现所有直接测试，先写 isolated-socket RED

**Files:**

- Modify: `scripts/__tests__/qa-generalized-e2e-lib.test.mjs`
- Inspect: all literal/path matches from the commands below

- [ ] **Step 1：运行强制 test discovery**

```bash
git grep -lF -- 'paneAlive'
git grep -lF -- 'probeRoomPaneAlive'
git grep -lF -- 'tmuxObservationIsAlive'
git grep -lF -- 'TMUX_TMPDIR'
git grep -lF -- 'scripts/qa-529-generalized-e2e.mjs'
git grep -lF -- 'scripts/lib/qa-generalized-e2e-lib.mjs'
git grep -lF -- 'scripts/__tests__/qa-generalized-e2e-lib.test.mjs'
git grep -lF -- 'scripts/__tests__/test-deploy-generalized.test.sh'
```

Expected: 生成 retained/excluded 清单。每个排除项记录「不调用该 driver probe」等具体理由；不能用“看起来无关”代替证据。

- [ ] **Step 2：在 test file 导入 `spawnSync` 与待建 helper**

```js
import { execFileSync, spawnSync } from "node:child_process";
// existing imports...
import { probeRoomPaneAlive } from "../lib/qa-generalized-e2e-lib.mjs";
```

- [ ] **Step 3：写纯注入 contract test**

测试必须捕获 spawn 参数并断言：

```js
const calls = [];
const spawn = (file, args, options) => {
  calls.push({ file, args, env: options.env });
  return { status: 0, stdout: "@5|%7|0|implement-exec\n" };
};
const hostEnv = {
  PATH: "/usr/bin:/bin",
  TMUX: "/private/tmp/tmux-501/default,123,0",
  TMUX_PANE: "%1",
  TMUX_TMPDIR: "/tmp/host-namespace",
};
assert.equal(probeRoomPaneAlive({
  target: "runner-test-slot-4:@5",
  executionId: "implement-exec",
  slotDir: "/tmp/flywheel-test-slot-4",
  env: hostEnv,
  spawn,
}), true);
assert.equal(calls[0].env.TMUX_TMPDIR, "/tmp/flywheel-test-slot-4");
assert.equal("TMUX" in calls[0].env, false);
assert.equal("TMUX_PANE" in calls[0].env, false);
assert.equal(hostEnv.TMUX_TMPDIR, "/tmp/host-namespace");
```

再覆盖 malformed target 不 spawn、tmux non-zero 返回 false，以及 `undefined`、`""`、`"relative/slot"` slotDir 均抛错。

- [ ] **Step 4：写真实隔离 socket RED**

创建两个短路径 temp roots：host 与 room。仅在 room env 里用 tmux `new-session -d` 建 `runner-test-slot-4`，给 window 写 `@flywheel_exec_id=implement-exec`。先用 host env 跑旧式 `display-message`，断言非零；再调用待建 helper，预期 true。

把 helper 返回的 liveness 输入既有 `classifyImplementPark`：

```js
const parked = {
  node: { state: "done", execution_id: "implement-exec" },
  session: { status: "ship_parked", terminal_at: null },
  park: { event: "park_opened", reason: "rework_reachable_wait" },
  processBody: null,
  standbyResumeEnabled: false,
};
assert.equal(classifyImplementPark({
  ...parked,
  liveness: { liveness: "alive" },
}), "rework_reachable_wait");
assert.equal(classifyImplementPark({
  ...parked,
  liveness: { liveness: "dead" },
}), null);
```

cleanup 必须以 exact room socket kill-server，并删除两个 temp roots；tmux 不存在时只 skip 这一条 real-tmux case。

- [ ] **Step 5：运行具体文件，确认 RED 是缺 helper/错误 namespace**

```bash
node --test scripts/__tests__/qa-generalized-e2e-lib.test.mjs
```

Expected: FAIL，原因是 `probeRoomPaneAlive` 尚未导出，或在先原样搬入旧逻辑的中间态下 isolated room pane 被判 false；不得接受 fixture setup 自己失败的假 RED。

- [ ] **Step 6：提交 RED**

```bash
git add scripts/__tests__/qa-generalized-e2e-lib.test.mjs
git commit -m "test(qa): reproduce room tmux pane false death"
```

## 4. Task 3：实现唯一 room-scoped probe

**Files:**

- Modify: `scripts/lib/qa-generalized-e2e-lib.mjs`

- [ ] **Step 1：在现有 target/observation helpers 后新增函数**

```js
export function probeRoomPaneAlive(input) {
  const { target, executionId, slotDir, env, spawn } = input ?? {};
  requiredString(slotDir, "slotDir", "room tmux probe");
  if (!slotDir.startsWith("/")) {
    throw new Error("room tmux probe slotDir must be an absolute path");
  }
  const identity = parseTmuxTargetIdentity(target);
  if (!identity) return false;
  const probeEnv = { ...env, TMUX_TMPDIR: slotDir };
  delete probeEnv.TMUX;
  delete probeEnv.TMUX_PANE;
  const result = spawn(
    "tmux",
    [
      "display-message",
      "-p",
      "-t",
      identity.target,
      "#{window_id}|#{pane_id}|#{pane_dead}|#{@flywheel_exec_id}",
    ],
    { encoding: "utf8", env: probeEnv },
  );
  if (result.status !== 0) return false;
  return tmuxObservationIsAlive(identity.target, result.stdout, executionId);
}
```

不要读取/修改 global env，不要拼 socket path，不要 catch 并吞掉 invalid slot authority。

- [ ] **Step 2：运行具体 Node test，确认 GREEN**

```bash
node --test scripts/__tests__/qa-generalized-e2e-lib.test.mjs
```

Expected: PASS，包括 host miss / room hit、wrong execution、invalid target 与 invalid slotDir。

- [ ] **Step 3：做 mutation 负控**

临时删掉 `TMUX_TMPDIR: slotDir`，重跑同一 concrete file，确认 isolated-socket case 与 env contract case 都红；立即恢复并重跑到绿。不要提交 mutation。

- [ ] **Step 4：提交 helper 与 tests**

```bash
git add scripts/lib/qa-generalized-e2e-lib.mjs scripts/__tests__/qa-generalized-e2e-lib.test.mjs
git commit -m "fix(qa): probe runner panes on the room tmux server"
```

## 5. Task 4：让 driver 只经 helper 探活

**Files:**

- Modify: `scripts/qa-529-generalized-e2e.mjs`
- Modify: `scripts/__tests__/test-deploy-generalized.test.sh`

- [ ] **Step 1：替换 imports 与内联函数**

从 driver import 移除 `parseTmuxTargetIdentity`、`tmuxObservationIsAlive`，加入 `probeRoomPaneAlive`。删除整个内联 `paneAlive`。

- [ ] **Step 2：改写 `probeExecution` 的 pane 分支**

```js
const tmuxAlive = probeRoomPaneAlive({
  target: comm?.tmuxWindow,
  executionId,
  slotDir,
  env: process.env,
  spawn: spawnSync,
});
```

保持返回对象与 `pidAlive || tmuxAlive` 聚合不变。

- [ ] **Step 3：增加 shell 结构守卫**

从 library 截取 `probeRoomPaneAlive` 函数体，断言它含：

```bash
'"#{window_id}|#{pane_id}|#{pane_dead}|#{@flywheel_exec_id}"'
'TMUX_TMPDIR: slotDir'
```

从 driver 截取 `probeExecution`，断言含 `probeRoomPaneAlive({` 与 `slotDir,`。另外用 `rg -q '"tmux"' scripts/qa-529-generalized-e2e.mjs` 作为负向守卫：driver 不得直接 spawn tmux。

- [ ] **Step 4：逐文件运行两个直接测试**

```bash
node --test scripts/__tests__/qa-generalized-e2e-lib.test.mjs
bash scripts/__tests__/test-deploy-generalized.test.sh
```

Expected: 两个具体文件各自 exit 0；shell 输出中无 FAIL。

- [ ] **Step 5：做 bypass mutation 负控**

临时把 driver 改回直接 `spawnSync("tmux", ...)` 或删结构守卫所需 call，运行 `bash scripts/__tests__/test-deploy-generalized.test.sh`，确认红；恢复并重跑到绿。不要提交 mutation。

- [ ] **Step 6：提交 driver wiring**

```bash
git add scripts/qa-529-generalized-e2e.mjs scripts/__tests__/test-deploy-generalized.test.sh
git commit -m "fix(qa): bind generalized liveness to the room socket"
```

## 6. Task 5：运行发现出的相关验证

**Files:** none unless a real failure requires a scoped fix

- [ ] **Step 1：运行所有 retained concrete tests，一次一个文件**

最低集合：

```bash
node --test scripts/__tests__/qa-generalized-e2e-lib.test.mjs
bash scripts/__tests__/test-deploy-generalized.test.sh
```

再逐文件运行 discovery 证明为直接消费者的测试；每个 `scripts/__tests__/*.test.sh` 必须单独 invocation。禁止 bare `vitest`、`pnpm test`、目录、glob、package alias 或枚举全仓文件模拟 full suite。

- [ ] **Step 2：运行 lint 与受影响 build**

```bash
pnpm lint
pnpm --filter "flywheel-teamlead..." build
git diff --check origin/main...HEAD
```

Expected: 命令 exit 0。warning 必须区分 changed-file 与 pre-existing，不能用过滤器掩盖 lint exit code。

- [ ] **Step 3：确认没有 changed TypeScript**

```bash
git diff --name-only origin/main...HEAD -- '*.ts' '*.tsx'
```

Expected: 本轮 harness fix 无输出。若有输出，停止实现并向 Lead 报告设计范围已失效；不要临场扩大到 TypeScript 或对 hub 文件运行宽泛 `related` 图。

- [ ] **Step 4：记录证据与排除理由**

在 milestone/PR body 写出每个命令、测试数、head SHA，以及每个 excluded match 的具体理由。只称“targeted local verification”，不称 full suite。

## 7. Task 6：推送、同头复审与实现节点交接

**Files:**

- Modify: `engineering/doc/milestones/FLY-2922.md`
- Modify: implementation progress ledger

- [ ] **Step 1：写清根因、merge 取舍与边界**

里程碑必须包含：QA@3 pane `@5` 事实、host vs room namespace、`probeRoomPaneAlive` 单口、step-4 正负对照、`scripts/test-deploy.sh` 两边保留、定向测试清单，以及 QA@4 仍需真房的边界。

- [ ] **Step 2：检查 mailbox、cleanliness 与 exact head**

```bash
node "$FLYWHEEL_COMM_CLI" inbox --exec-id "$FLYWHEEL_EXEC_ID"
git status --short --branch
git diff --check
git rev-parse HEAD
```

Expected: 没有未处理 Lead 指令；tree clean；记录 exact SHA。

- [ ] **Step 3：push feature branch**

```bash
git push origin HEAD
```

Expected: fast-forward push；不得 `--no-verify`、force-push 或修改 hook 配置。

- [ ] **Step 4：在 exact pushed head 走新的 code review gate**

按 Implement node 注入的 `gate review_code --no-block` + `request-review --type code` 命令注册 review，把 gate 返回的 UUID 原样保存为 `review_question_id`，跨 turn 运行 `node "$FLYWHEEL_COMM_CLI" check "$review_question_id"`。若 CHANGES_REQUESTED，修 HIGH finding、push 新 head、开全新 gate；若 APPROVED with advisories，向 Lead fire-and-forget 报 advisories。

- [ ] **Step 5：以注入的 completion route 交给 QA**

review APPROVED 且 push/CI 状态满足 Implement node 的精确要求后，运行其注入的 `complete --route needs_review --pr 1374`。不要 merge、ship、dispatch QA 或自行起真房。

## 8. QA@4 验收矩阵

QA@4 不是本计划的本地实现步骤，但必须按以下条件收口：

1. PR #1374 exact head full CI 绿且 mergeable。
2. Lead 用新 head 起 slot 房，包含主 Lead + extra Lead，参数为 `--generalized --codex-runner --qa-stub-runner`。
3. 真实 Claude 完成 design review；QA stub 只接 QA execution。
4. driver 走完全部 steps；step 4 证明房内活 pane 被识别。
5. held 进入唯一 unified recovery door；恢复结果是当前节点的新 dispatch ledger entry，不是只改状态。
6. incomplete carrier close 不终结 run；旧 actor 与新 actor 身份、route revision 和 dispatch reason 可审计。
7. 保存 driver step artifacts、room DB snapshot 与 bridge log；在 teardown 前复制会被销毁的证据。

本地定点测试、lint、build、CI 任一项都不能替代上述真房证据。
