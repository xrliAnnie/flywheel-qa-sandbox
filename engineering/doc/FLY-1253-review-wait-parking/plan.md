# FLY-1253 审查等待 park 重试 — 实施计划
Issue: FLY-1253 (https://linear.app/geoforge3d/issue/FLY-1253/fix-flywheel-land-30min-硬杀-改-park定期重试审查等待不该被切)
日期: 2026-07-14
基于: research.md

> 在 assigned three-stage Implement session 内按顺序执行；不要 dispatch nested
> agents。交付两个**正交** PR：PR-B（flywheel-skills）是当前事故真修，可独立优先
> 发布；PR-A（flywheel）是 dormant direct adapter hardening + production compatibility
> evidence，不是 PR-B prerequisite。

**Goal:** bound checkpointed review/gate 等待超过 30m 时，`flywheel-land` 保持
pending、bounded park、低频 `check`，response 后同 runner 继续；同时为 founder
指定的 dormant `ClaudeCodeAdapter` 补 future wait-aware lifetime contract。

**Architecture:** PR-B 修改 canonical skill v0.4.0，只救有 exact `QUESTION_ID` 的
checkpoint wait；live `TmuxAdapter`/`CodexTmuxAdapter` 不改 runtime semantics，只补
characterization/QA evidence。PR-A 的 direct supervisor用累计 active budget、per-wait
cap、absolute outer cap；FLY-1253 不注册 bare `claude` backend。

**Tech Stack:** TypeScript · Node `child_process` · better-sqlite3/CommDB · Vitest fake
timers · Bash/Markdown skill guard · pnpm monorepo。

## 0. Delivery Invariants

1. **事故因果**：FLY-1225=`codex-tmux + flywheel-land policy stop`；PR-B 是真修。
   PR-A 不得写成 current production prerequisite。
2. **reachability**：direct `ClaudeCodeAdapter.type="claude"` 继续不注册、不接线；
   `ExecutorBackend` union 不增加 bare `claude`。
3. **bound wait**：skill 只在当前 execution 已捕获 exact `QUESTION_ID`，或通过
   Lead pending JSON 唯一恢复出 checkpoint question，且 `check` 仍 pending 时
   park；GitHub-only/unbound/ambiguous review fail-closed 为 `review_wait_unbound`。
4. **普通语义不变**：CI 30m `ci_timeout`、max fix attempts、active reviewer cap、
   approval/head/question binding全部不动。
5. **pending signal**：合法 park 期间 `land-status.json` 保持 pending；真实
   ready/failure 才 terminal。
6. **live adapter boundary**：不把 direct predicate冒充全局标准；
   `TmuxAdapter` 的 legacy broad question predicate本单不改。
7. **direct budget**：单 child；累计 active budget；每段 wait 49h cap；有限 outer
   cap；gate close 恢复剩余 budget，不刷新 full budget。
8. **acceptance split**：production regression看 claude-tmux/codex-tmux smoke；direct
   fake-clock tests只证明 dormant future contract。
9. **rollout independence**：B0→B1 安全且优先；A0/A1 正交。PR-B 可独立回滚。
10. **model lock**：Design/Implement=`gpt-5.6-sol` xhigh，Design 仍走
    `FLYWHEEL_THREE_STAGE_CODEX_DESIGN`，QA=Claude Opus；不改 model/config/effort。

## Task 1: PR-B RED — create isolated skill worktree and strengthen the guard

**Files:**

- Modify: `/private/tmp/flyview-skills-FLY-1253/scripts/skill-guard.sh`
- Verify: `/private/tmp/flyview-skills-FLY-1253/skills/flywheel/flywheel-land/SKILL.md`

- [ ] **Step 1: Create/reuse the external repo worktree**

```bash
git -C /Users/xiaorongli/Dev/flyview-skills fetch origin
git -C /Users/xiaorongli/Dev/flyview-skills worktree add \
  /private/tmp/flyview-skills-FLY-1253 -b flywheel-FLY-1253-skill origin/main
```

如果 worktree/branch 已存在，先 `git worktree list` 和 `git status`，只复用无冲突的
同 issue worktree；不要编辑 `~/.agents/skills/...` 安装副本。

- [ ] **Step 2: Add byte-exact v0.4.0 contract checks**

在现有 `skill-guard.sh` 的 flywheel-land section 中加入：

```bash
LAND="skills/flywheel/flywheel-land/SKILL.md"

for must in \
  'park --until 10m --reason "flywheel-land awaiting review gate"' \
  'five sequential `sleep 60` Bash tool calls' \
  'Give each call a 90s tool timeout.' \
  'rerun the park command from step 4 and repeat from step 5' \
  'node "$FLYWHEEL_COMM_CLI" check "$QUESTION_ID"' \
  'pending --lead "$FLYWHEEL_LEAD_ID" --json' \
  'node "$FLYWHEEL_COMM_CLI" unpark' \
  'review_wait_unbound' \
  'review_gate_expired' \
  'review_wait_poll_error' \
  'ci_timeout' \
  '"status":"pending"'; do
  grep -qF "$must" "$LAND" || err "$LAND: missing $must"
done

check_count=$(grep -cF 'node "$FLYWHEEL_COMM_CLI" check "$QUESTION_ID"' "$LAND" || true)
test "$check_count" -ge 2 || \
  err "$LAND: expiry branch must race-safe re-check the bound question id"

grep -Eq 'Review wait timeout \(30min\).*review_timeout' "$LAND" && \
  err "$LAND: bound review wait must park/retry, not terminal review_timeout"
```

不要用 bare `5m` token；guard 同时锁定 five-slice mechanism、每 slice tool timeout、
check、explicit loop-back、expiry-aware pending revalidation和 terminal reasons。

- [ ] **Step 3: Run guard and confirm RED**

```bash
cd /private/tmp/flyview-skills-FLY-1253
bash scripts/skill-guard.sh
```

Expected: FAIL，明确报告缺少 binding/park/bounded-wait/check/unpark/expiry/error
contract，并命中旧 `review_timeout`。

## Task 2: PR-B GREEN — implement flywheel-land v0.4.0 bound park/retry

**Files:**

- Modify: `/private/tmp/flyview-skills-FLY-1253/skills/flywheel/flywheel-land/SKILL.md`
- Modify: `/private/tmp/flyview-skills-FLY-1253/scripts/skill-guard.sh`

- [ ] **Step 1: Bump version and state the binding precondition**

把 `skill-version` 从 `0.3.0` 改为 `0.4.0`。在 review monitoring 之前加入 exact
contract（文案可整理，但语义/命令不变）：

```markdown
### Bound Flywheel review/gate wait

This long-wait path applies only when the current execution already opened a
checkpointed gate with `--no-block` and captured its returned question id:

The flywheel-land skill MUST NOT open another gate. The upstream review/gate
flow supplies its previously returned question id as `QUESTION_ID`.

If that shell variable is unavailable, run
`node "$FLYWHEEL_COMM_CLI" pending --lead "$FLYWHEEL_LEAD_ID" --json`, filter to
`from_agent == $FLYWHEEL_EXEC_ID && checkpoint != null`, and accept it only when
there is exactly one row. Before parking, confirm `check "$QUESTION_ID"` is still
pending. Never infer a question id from GitHub review state or the most recent ask.
```

skill 文案不得包含一个可直接复制执行的 `gate --no-block` 命令；它消费 upstream
flow 已创建的 binding。首选 caller-provided id；跨
tool/shell 丢失变量时，用 `pending --lead --json` 做 current execution + checkpoint
unique recovery。成功查询的零个或多个 match 都 fail-closed为
`review_wait_unbound`；命令非零/JSON不可解析为 `review_wait_poll_error`。当前
three-stage code/design review contract 已满足该前置条件，且 recovery 不依赖 PR-A。

- [ ] **Step 2: Split CI and review timers**

保留 CI branch 原样：

```markdown
- If CI makes no progress for 30min: write failed `ci_timeout`, escalate, stop.
```

把 bound review/gate 30m branch 改成：

```markdown
- If review/gate is still pending at 30min:
  1. If `QUESTION_ID` is absent/null, recover it from
     `node "$FLYWHEEL_COMM_CLI" pending --lead "$FLYWHEEL_LEAD_ID" --json` only
     when exactly one open checkpoint belongs to `$FLYWHEEL_EXEC_ID`. A non-zero
     or unparseable recovery is `review_wait_poll_error`, not zero matches.
  2. If successful recovery has zero/multiple matches, or `check "$QUESTION_ID"` cannot prove
     the same open checkpoint wait, write failed `review_wait_unbound`, escalate, stop.
  3. Keep land-status.json as `{"status":"pending"}`.
  4. Run `node "$FLYWHEEL_COMM_CLI" park --until 10m --reason "flywheel-land awaiting review gate"`.
  5. Wait 5m as five sequential `sleep 60` Bash tool calls. Give each call a 90s tool timeout.
     Never use one unbounded/default-timeout `sleep 300` call.
  6. If any sleep call errors, do not tight-spin: run
     `node "$FLYWHEEL_COMM_CLI" unpark`, write failed `review_wait_poll_error`,
     escalate, and stop.
  7. Run `node "$FLYWHEEL_COMM_CLI" check "$QUESTION_ID"`. A non-zero or
     unparseable result is not pending/absent: unpark, write failed
     `review_wait_poll_error`, escalate, and stop.
  8. If answered, run `node "$FLYWHEEL_COMM_CLI" unpark` before handling the
     verdict/response (including a Codex synthetic timeout response).
  9. If `check` is still pending, query `pending --lead "$FLYWHEEL_LEAD_ID" --json`
     again. A non-zero or unparseable result routes to `review_wait_poll_error`,
     never to expiry. If successful and the exact bound id still belongs to
     `$FLYWHEEL_EXEC_ID` with a non-null checkpoint, rerun the park command from step 4 and repeat from step 5.
  10. If that exact id is absent, run
      `node "$FLYWHEEL_COMM_CLI" check "$QUESTION_ID"` once more to close the race
      where a response landed between Step 7 and Step 9. If answered, unpark and
      handle it. Only if the second check is still pending may the skill classify
      expired/resolved-without-response: run `unpark`, write failed
      `review_gate_expired`, escalate, and stop.
```

`check` 本身不读 `expires_at`；Step 9/loop-back 不能省略。只有成功、可解析的 pending
JSON 才能证明 qid present/absent；command error不是 absence。Codex watcher可写 synthetic timeout
response，Claude no-block path不会，因此 exact-qid pending revalidation是跨 adapter
退出条件。Step 10 second check是 response race guard；Claude bare expiry无法恢复
timeout behavior metadata，必须 fail-closed。在 shell examples 中用 best-effort
cleanup/trap 确保正常 error/exit 也执行 unpark；10m lease是 crash backstop。

- [ ] **Step 3: Correct the real Do NOT line**

canonical v0.3.0 的原文是：

```markdown
- Keep retrying indefinitely — max 2 CI fix attempts, 30min wait timeouts
```

改为：unbound waits不得无限 retry；bound gate wait由 gate TTL、adapter wait ceiling、
bounded park lease共同限制。CI max attempts/timeout仍保留。

- [ ] **Step 4: Run GREEN guard and inspect diff**

```bash
cd /private/tmp/flyview-skills-FLY-1253
bash scripts/skill-guard.sh
git diff --check
git diff -- skills/flywheel/flywheel-land/SKILL.md scripts/skill-guard.sh
```

Expected: PASS；diff 中 unique pending recovery、per-cycle exact-qid revalidation、
explicit loop-back、bounded sleep mechanism、poll-error distinction、`ci_timeout` 仍在、
旧 bound `review_timeout` 消失、三个明确 terminal reasons都存在。

- [ ] **Step 5: Commit PR-B independently**

```bash
git add skills/flywheel/flywheel-land/SKILL.md scripts/skill-guard.sh
git commit -m "fix(flywheel-land): park while bound reviews are pending"
git push -u origin flywheel-FLY-1253-skill
```

PR-B 描述必须写明：这是 FLY-1225 current incident fix；不依赖 flywheel PR-A；
GitHub-only review没有 bound question 时仍 fail-closed。

## Task 3: PR-A characterization — prove live adapters tolerate the new skill loop

**Files:**

- Modify: `packages/claude-runner/test/TmuxAdapter.test.ts`
- Modify: `packages/claude-runner/test/codex-daemon-client.test.ts`
- Modify: `packages/flywheel-comm/src/__tests__/runner-declared-states.test.ts`

这些是 production compatibility tests；不应要求 runtime code delta。如果 test 暴露
真实 incompatibility，先停下并重新 design review，不能顺手改变 live timeout contract。

- [ ] **Step 1: Add a claude-tmux wait characterization**

用临时 CommDB + fake timers/exec seam 驱动现有 `TmuxAdapter.execute()` poll loop：

1. 当前 execution 插入 checkpointed `review_code` question；
2. pane保持 alive，推进超过缩短的 active timeout；
3. 断言 adapter 没 kill pane且 heartbeat继续；
4. 插入 response，推进 poll；
5. 断言同一 window id继续并能正常 settle；
6. negative control无 question时仍 timeout。

测试名称显式写 `characterizes production claude-tmux across bound review wait`；不要把
park marker当 timeout authority。

- [ ] **Step 2: Pin codex open→close behavior**

在已有 `runGoalToTerminal` MED-7 tests旁补/加强一个组合场景：

- `isWaiting` open跨过 active deadline；
- 同一 daemon/thread 不重新 `thread/goal/set`；
- gate close 后 deadline不回缩到过去；
- 最终 original goal完成；
- never-waiting negative control仍 active timeout。

这是对现有 gate-marker runtime的 characterization，不新增 QUESTION_ID discovery。

- [ ] **Step 3: Pin bounded park lease semantics**

在 `runner-declared-states.test.ts` 加 fake-clock sequence：

1. `park --until 10m` 可读为 parked；
2. 5m续租后原 expiry向后移动；
3. `unpark` 后立即 null；
4. 不续租时 10m 后自动 null；
5. park/unpark不修改 CommDB question/response rows。

- [ ] **Step 4: Run focused suites**

```bash
pnpm --filter flywheel-claude-runner exec vitest run \
  test/TmuxAdapter.test.ts test/codex-daemon-client.test.ts
pnpm --filter flywheel-comm exec vitest run \
  src/__tests__/runner-declared-states.test.ts
```

Expected: PASS。若 characterization test本来就 green，这是正确结果；它证明 PR-B
可以独立上线，而不是 TDD implementation RED。

## Task 4: PR-A RED — specify the dormant direct supervisor

**Files:**

- Create: `packages/claude-runner/test/wait-aware-exec.test.ts`
- Create: `packages/claude-runner/src/wait-aware-exec.ts` only after RED

- [ ] **Step 1: Write injectable fake child/clock fixture**

fixture 暴露：

```ts
const proc = fakeExec();
const run = runWaitAwareExec({
	file: "claude",
	argv: ["--print"],
	options: { cwd: "/repo" },
	activeTimeoutMs: 1_000,
	waitingTimeoutMs: 10_000,
	waitRetryMs: 100,
	outerTimeoutMs: 30_000,
	isWaiting: probe,
	execFile: proc.execFile,
	now: Date.now,
});
```

fake `kill()` 必须触发原 callback，模拟 Node child termination；fixture记录
spawn/kill/callback count。

- [ ] **Step 2: Write RED matrix**

至少写这些 tests：

```ts
it("kills at cumulative active timeout when never waiting", async () => {});
it("pauses active accounting while one blocking gate is open", async () => {});
it("continues the same child with remaining active budget after response", async () => {});
it("does not grant wait time to a checkpoint-less ask", async () => {});
it("fails closed when the wait probe throws", async () => {});
it("kills when one wait period exceeds waitingTimeoutMs", async () => {});
it("does not refresh active budget across repeated open-close cycles", async () => {});
it("kills at the absolute outer cap across many gates", async () => {});
it("clears timers and settles once after child success", async () => {});
```

repeated cycle test：active 400ms → wait 300ms → active 400ms → wait 300ms → active
201ms 必须 timeout；若每次 gate close发新 1000ms budget，该 test会错误存活。

- [ ] **Step 3: Confirm RED**

```bash
pnpm --filter flywheel-claude-runner exec vitest run test/wait-aware-exec.test.ts
```

Expected: FAIL because module/API不存在。

## Task 5: PR-A GREEN — implement cumulative ACTIVE/WAITING supervisor

**Files:**

- Create: `packages/claude-runner/src/wait-aware-exec.ts`
- Modify: `packages/claude-runner/test/wait-aware-exec.test.ts`

- [ ] **Step 1: Define narrow process seam and timeout error**

```ts
import type { ExecFileOptions } from "node:child_process";

export interface KillableChild {
	kill(signal?: NodeJS.Signals | number): boolean;
}

export type ExecFileLike = (
	file: string,
	argv: readonly string[],
	options: ExecFileOptions,
	callback: (error: Error | null, stdout: string, stderr: string) => void,
) => KillableChild;

export class WaitAwareExecTimeoutError extends Error {
	readonly timedOut = true;
}
```

- [ ] **Step 2: Implement budget accounting before process wiring**

state 必须包含：

```ts
const startedAt = now();
let totalWaitingMs = 0;
let waitingSince: number | null = null;

function activeElapsed(at: number): number {
	const currentWait = waitingSince === null ? 0 : at - waitingSince;
	return at - startedAt - totalWaitingMs - currentWait;
}
```

transition 规则：

- ACTIVE 每 `waitRetryMs` probe，一旦 pending gate出现就记录 `waitingSince`；
- ACTIVE timer 始终取 `min(nextProbe, remainingActive, remainingOuter)`，所以无 gate 的
  timeout不会被 polling interval延迟；
- WAITING still pending时检查 current wait cap与 outer cap；
- gate close时把 `now-waitingSince` 加入 `totalWaitingMs`，清空 `waitingSince`，恢复
  remaining active budget；
- probe exception调用 warning hook并视为 not waiting；
- child callback/timeout都经 single `settled` guard；
- timeout只 kill原 child，不 respawn。

默认 outer cap：

```ts
Math.min(
	2_147_483_647,
	Math.max(activeTimeoutMs, waitingTimeoutMs * 7),
)
```

`7 * 49h` 与 TmuxAdapter现有多 gate ultra-safety precedent一致；允许显式
`outerTimeoutMs` 注入测试。

- [ ] **Step 3: Run focused GREEN and typecheck**

```bash
pnpm --filter flywheel-claude-runner exec vitest run test/wait-aware-exec.test.ts
pnpm --filter flywheel-claude-runner typecheck
```

Expected: all supervisor tests PASS；ordinary timeout精确、same child spawn count=1、
repeated gates不刷新 active budget。

- [ ] **Step 4: Commit the isolated supervisor**

```bash
git add packages/claude-runner/src/wait-aware-exec.ts \
  packages/claude-runner/test/wait-aware-exec.test.ts
git commit -m "feat(runner): add bounded wait-aware process supervisor"
```

## Task 6: PR-A RED/GREEN — wire only the dormant `ClaudeCodeAdapter`

**Files:**

- Create: `packages/claude-runner/test/ClaudeCodeAdapter.test.ts`
- Modify: `packages/claude-runner/src/ClaudeCodeAdapter.ts`

- [ ] **Step 1: Add a backward-compatible dependency seam**

保持 `new ClaudeCodeAdapter(logger?)` callers可用；第二参数新增：

```ts
export interface ClaudeCodeAdapterOptions {
	execFile?: ExecFileLike;
	waitRetryMs?: number;
	now?: () => number;
	resolveCommCli?: () => string | undefined;
}
```

- [ ] **Step 2: RED with real hermetic CommDB**

测试用临时 CommDB 创建当前 execution 的 `review_code` question，运行显式短
`timeoutMs`：

- question在 active deadline前出现；
- 推进超过 deadline，fake child kill=0；
- 插入 response后 original fake child success；
- result保留相同 `sessionId/sessionParams`；
- `execFile` count=1。

negative cases：checkpoint-null ask、wrong execution、no DB、invalid DB/probe error都按
active timeout kill；另外 `checkpoint:"question"` 证明 generic gate同样适用。

先运行并确认旧 adapter RED：

```bash
pnpm --filter flywheel-claude-runner exec vitest run test/ClaudeCodeAdapter.test.ts
```

- [ ] **Step 3: GREEN with precise direct-only probe**

```ts
function hasPendingBlockingGate(ctx: AdapterExecutionContext): boolean {
	if (!ctx.commDbPath) return false;
	const db = CommDB.openReadonly(ctx.commDbPath);
	try {
		return db.hasPendingBlockingGateFrom(ctx.executionId);
	} finally {
		db.close();
	}
}
```

`execute()` 调 `runWaitAwareExec`；不要传 Node `options.timeout`。defaults：

```ts
const DEFAULT_TIMEOUT_MS = 30 * 60_000;       // standalone/direct fallback
const DEFAULT_WAITING_TIMEOUT_MS = 176_400_000;
const DEFAULT_WAIT_RETRY_MS = 5 * 60_000;
```

注释必须诚实：production Blueprint当前显式传24h且不注册此 adapter；30m default只
覆盖 standalone/future direct caller。

timeout catch返回 `timedOut:true`；spawn/nonzero/parse failure不标 timedOut。

- [ ] **Step 4: Add minimal future direct env parity**

捕获 `execFile.options.env` 并测试：

| ctx/input | env |
|---|---|
| `commDbPath` | `FLYWHEEL_COMM_DB` |
| `executionId` | `FLYWHEEL_EXEC_ID` |
| `projectName` | `FLYWHEEL_PROJECT_NAME` |
| `issueId` | `FLYWHEEL_ISSUE_ID` |
| `sentinelPath` | `FLYWHEEL_LAND_STATUS_PATH` |
| resolved CLI | `FLYWHEEL_COMM_CLI` |
| waiting cap | `BASH_MAX_TIMEOUT_MS` |

仍删除 `CLAUDECODE`。不要新增 `FLYWHEEL_GATE_MARKER_DIR`，不要改 transport identity。

- [ ] **Step 5: Prove no production registration was added**

```bash
rg -n 'registerFactory\("claude"|new ClaudeCodeAdapter' \
  packages/teamlead/src packages/edge-worker/src packages/config/src
git diff -- packages/teamlead/src/bridge/run-infra.ts \
  packages/config/src/types.ts \
  packages/edge-worker/src/Blueprint.ts
```

Expected: first command无 production match；三个 routing files无 diff。

- [ ] **Step 6: Run GREEN**

```bash
pnpm --filter flywheel-claude-runner exec vitest run \
  test/wait-aware-exec.test.ts \
  test/ClaudeCodeAdapter.test.ts \
  test/TmuxAdapter.test.ts \
  test/codex-daemon-client.test.ts
pnpm --filter flywheel-claude-runner typecheck
```

## Task 7: PR-A full verification and commit

**Files:**

- Verify: `packages/teamlead/src/bridge/claude-review-runner.ts` unchanged
- Verify: `packages/teamlead/src/bridge/run-infra.ts` unchanged
- Verify: `packages/config/src/types.ts` backend union unchanged
- Verify: all PR-A source/tests

- [ ] **Step 1: Run package suites**

```bash
pnpm --filter flywheel-claude-runner test
pnpm --filter flywheel-claude-runner typecheck
pnpm --filter flywheel-comm test
pnpm --filter flywheel-comm typecheck
```

- [ ] **Step 2: Run scope audit**

```bash
git diff --check
git diff -- packages/teamlead/src/bridge/claude-review-runner.ts
git diff -- packages/teamlead/src/bridge/run-infra.ts packages/config/src/types.ts
git diff --stat origin/main...HEAD
```

Expected: reviewer active cap、registry、backend union无 diff；live adapter source无
timeout semantic delta；changes只含 tests、direct adapter/supervisor和本 issue docs。

- [ ] **Step 3: Commit PR-A remainder**

```bash
git add packages/claude-runner/src/ClaudeCodeAdapter.ts \
  packages/claude-runner/test/ClaudeCodeAdapter.test.ts \
  packages/claude-runner/test/TmuxAdapter.test.ts \
  packages/claude-runner/test/codex-daemon-client.test.ts \
  packages/flywheel-comm/src/__tests__/runner-declared-states.test.ts
git commit -m "fix(runner): preserve bound review waits in direct Claude runs"
```

PR-A 描述必须写 `dormant/not production-registered`，并把 live adapter tests标为
PR-B compatibility evidence，不声称 direct adapter修复了 FLY-1225。

## Task 8: Two-repo acceptance and independent release notes

**Files:**

- Verify PR-A head in flywheel repo
- Verify PR-B head in flywheel-skills repo
- Create evidence in PR descriptions/check outputs；不新增 model/config files

- [ ] **Step 1: Record corrected compatibility matrix**

```text
A0/B0 baseline: bound review wait can terminal-stop at 30m.
A1/B0 safe dormant: current production unchanged; future direct supervisor exists.
A0/B1 safe current target: live tmux adapters run v0.4.0 park/retry; incident fixed.
A1/B1 full issue delivery: current fix plus future direct hardening.
Rollback: B independently for skill-policy issues; A only matters after future direct activation.
```

PR descriptions不得再写“deploy A before B”。

- [ ] **Step 2: Run a scaled claude-tmux smoke**

在 sandbox execution 用测试配置缩短 active/retry duration：

1. 创建 bound `review_code` gate并保存 `QUESTION_ID`；
2. land signal写 pending，执行 bounded park/check；
3. 跨过缩短的旧 review timeout，确认 pane/heartbeat仍活、signal仍 pending；
4. 写 response，确认同 tmux window继续，执行 unpark；
5. 完成到 ready/failure的真实 terminal result。

再跑 abandoned-gate分支：让 Claude no-block question expire且不写 response；下一轮
`check` 即使仍显示 pending，pending JSON必须已不含 exact qid，race-safe second
check仍 pending后，skill应 unpark、写 failed `review_gate_expired`，不得继续续租或
留下 pending signal。另加 race case：response落在第一次 check与 pending query之间，
second check必须消费 response，不能误报 expired。

记录 execution id、window id、question id、timeout前后 timestamp和 land status，不在
文档中泄露 token。

- [ ] **Step 3: Run a scaled codex-tmux smoke**

同样创建 question-bound gate marker：

1. park/check跨过缩短 deadline；
2. original goal/thread仍 active；
3. response 后同 thread继续、marker/park清理；
4. land signal从 pending到真实 terminal。

- [ ] **Step 4: Run negative controls**

- GitHub-only/unbound或多个 open checkpoint的 ambiguous review：30m fixture到点 →
  `review_wait_unbound`；不 park；
- claude-tmux abandoned/expired bound gate：`review_gate_expired` + unpark；
- 任一 60s slice tool error或 `check/pending` 非零/不可解析：
  `review_wait_poll_error`，不得 tight-spin或误报 expiry；
- checkpoint-less ask：不进入 skill bound branch；
- CI no-progress：仍 `ci_timeout`；
- direct fake probe error/no DB：仍 `timedOut:true`；
- repeated direct gates：outer/cumulative budget最终 timeout。

- [ ] **Step 5: Open two independent PRs**

PR-B（flywheel-skills）可先 review/land；PR-A（flywheel）单独 review。每个 PR 都引用
另一个作为 related，不设 merge dependency。若只允许先交一个，优先 PR-B，因为它是
current production fix。

## Final Verification Commands

### PR-B / flywheel-skills

```bash
cd /private/tmp/flyview-skills-FLY-1253
bash scripts/skill-guard.sh
git diff --check
git status --short
```

### PR-A / flywheel

```bash
cd /Users/xiaorongli/Dev/flywheel-FLY-1253
pnpm --filter flywheel-claude-runner test
pnpm --filter flywheel-claude-runner typecheck
pnpm --filter flywheel-comm test
pnpm --filter flywheel-comm typecheck
git diff --check
git status --short
```

## Completion Evidence

Implement handoff完成需同时提供：

- PR-B guard PASS；v0.4.0 exact-or-unique binding + bounded park/retry；每轮 exact-qid
  expiry revalidation；CI/unbound/ambiguous/expired/poll-error negative controls；
- PR-A direct fake-clock matrix PASS；same child；cumulative/outer caps；
- reachability audit证明没有新增 bare `claude` production registration；
- claude-tmux/codex-tmux scaled smoke证明 wait > old timeout仍存活，response后同
  pane/thread继续；
- park期间 land signal pending；response、synthetic timeout、bare expiry或 poll error后
  unpark并产生明确 continuation/terminal result；
- `claude-review-runner.ts` active cap、model/config/effort routing无 diff；
- 两 PR 独立 release/rollback notes，不再声明 A→B prerequisite。
