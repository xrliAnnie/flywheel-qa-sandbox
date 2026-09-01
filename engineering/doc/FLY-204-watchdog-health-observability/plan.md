# FLY-204 看门狗健康可观测性 — 实施计划
Issue: FLY-204 (https://linear.app/geoforge3d/issue/FLY-204/bridge-watchdog-observability-idle-heartbeat-health-exposure-fly-195)
日期: 2026-08-30
基于: research.md

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Follow the assigned Flywheel implementation node; do not dispatch successor nodes or merge.

**Goal:** 在现有 `/health` 中暴露可验证的 `RunnerIdleWatchdog` 进程内健康快照，使成功空轮、执行中、失败轮和 stale loop 可区分。

**Architecture:** `RunnerIdleWatchdog` 是唯一快照 owner，提供窄的只读 `health()` provider。`startBridge()` 创建 late-bound holder 并在 watchdog 实例化后绑定；早先创建的 `/health` route 每次请求读取 holder。保留现有 timer、cadence、检测与告警行为，新增字段仅为 additive telemetry。

**Tech Stack:** TypeScript、Express 5、Vitest 3、pnpm workspace。

---

## 文件结构

- Modify: `packages/teamlead/src/RunnerIdleWatchdog.ts` — 定义健康快照契约并记录 timer/poll 生命周期。
- Modify: `packages/teamlead/src/__tests__/runner-idle-watchdog.test.ts` — 用真实 watchdog + mocked store/query 验证成功空轮、in-flight、重叠 skip 和 error 轮。
- Modify: `packages/teamlead/src/bridge/plugin.ts` — 为 `/health` 增加固定形状与 late-bound provider holder。
- Modify: `packages/teamlead/src/__tests__/bridge.test.ts` — 验证 standalone fallback 与 provider 逐字段透传。
- Create last: `engineering/doc/milestones/FLY-204.md` — PR 前的 literal last commit，记录交付和验证证据。

不新增模块、数据库字段、环境变量、日志 heartbeat 或 `scripts/__tests__` 文件。

### Task 1: Watchdog 成功空轮与 in-flight 快照

**Files:**
- Modify: `packages/teamlead/src/__tests__/runner-idle-watchdog.test.ts`
- Modify: `packages/teamlead/src/RunnerIdleWatchdog.ts`

- [ ] **Step 1: 写失败测试，锁定空闲成功、timer 和 in-flight 语义**

在 `RunnerIdleWatchdog` 主 describe 内新增：

```typescript
it("health distinguishes an armed idle loop from an in-flight poll", async () => {
	vi.setSystemTime(new Date("2026-08-30T10:00:00.000Z"));
	const { watchdog, store, mockQuery } = createTestWatchdog({ sessions: [] });

	expect(watchdog.health()).toEqual({
		timerRunning: false,
		pollIntervalMs: 30_000,
		pollInProgress: false,
		lastPollAt: null,
		lastPollResult: null,
		activeRunningSessions: null,
	});

	watchdog.start();
	expect(watchdog.health().timerRunning).toBe(true);

	await watchdog.pollOnce();
	expect(watchdog.health()).toEqual({
		timerRunning: true,
		pollIntervalMs: 30_000,
		pollInProgress: false,
		lastPollAt: "2026-08-30T10:00:00.000Z",
		lastPollResult: "ok",
		activeRunningSessions: 0,
	});

	store.getActiveSessions.mockReturnValue([makeSession()]);
	let resolveQuery: (() => void) | undefined;
	mockQuery.mockImplementationOnce(
		() =>
			new Promise<StatusResponse>((resolve) => {
				resolveQuery = () =>
					resolve({ result: { status: "executing", reason: "active" } });
			}),
	);
	vi.setSystemTime(new Date("2026-08-30T10:01:00.000Z"));
	const inFlight = watchdog.pollOnce();
	expect(watchdog.health().pollInProgress).toBe(true);
	expect(watchdog.health().lastPollAt).toBe("2026-08-30T10:00:00.000Z");
	await watchdog.pollOnce();
	expect(mockQuery).toHaveBeenCalledTimes(1);

	resolveQuery?.();
	await inFlight;
	expect(watchdog.health()).toMatchObject({
		pollInProgress: false,
		lastPollAt: "2026-08-30T10:01:00.000Z",
		lastPollResult: "ok",
		activeRunningSessions: 1,
	});

	watchdog.stop();
	expect(watchdog.health().timerRunning).toBe(false);
});
```

- [ ] **Step 2: 运行单测并确认正确 RED**

Run:

```bash
cd packages/teamlead
pnpm exec vitest run src/__tests__/runner-idle-watchdog.test.ts -t "health distinguishes an armed idle loop"
```

Expected: FAIL，`watchdog.health is not a function`。测试不得因 fixture、timer 泄漏或 TypeScript 语法错误失败。

- [ ] **Step 3: 增加最小健康契约和成功轮记录**

在 `RunnerIdleWatchdog.ts` 的 config 后定义并导出：

```typescript
export type IdleWatchdogPollResult = "ok" | "error";

export interface IdleWatchdogHealth {
	timerRunning: boolean;
	pollIntervalMs: number | null;
	pollInProgress: boolean;
	lastPollAt: string | null;
	lastPollResult: IdleWatchdogPollResult | null;
	activeRunningSessions: number | null;
}

export interface IdleWatchdogHealthProvider {
	health(): IdleWatchdogHealth;
}
```

在 class 中增加私有字段：

```typescript
private lastPollAt: string | null = null;
private lastPollResult: IdleWatchdogPollResult | null = null;
private activeRunningSessions: number | null = null;
```

增加只读快照：

```typescript
health(): IdleWatchdogHealth {
	return {
		timerRunning: this.timerHandle !== null,
		pollIntervalMs: this.config.pollIntervalMs,
		pollInProgress: this.polling,
		lastPollAt: this.lastPollAt,
		lastPollResult: this.lastPollResult,
		activeRunningSessions: this.activeRunningSessions,
	};
}
```

在 `poll()` 成功读取并过滤 sessions 后立即写 `activeRunningSessions = sessions.length`；在正常 try 尾端写 `lastPollResult = "ok"`；在现有 `finally` 中、释放 `polling` 前写：

```typescript
this.lastPollAt = new Date().toISOString();
this.polling = false;
```

重叠的早退保持在 `polling=true` 判定前后不改任何完成字段。

- [ ] **Step 4: 运行目标测试确认 GREEN，再跑完整 watchdog 文件**

Run:

```bash
cd packages/teamlead
pnpm exec vitest run src/__tests__/runner-idle-watchdog.test.ts -t "health distinguishes an armed idle loop"
pnpm exec vitest run src/__tests__/runner-idle-watchdog.test.ts
```

Expected: 新测试 PASS；watchdog 文件 28 tests PASS。

### Task 2: Poll containment 的 error 健康语义

**Files:**
- Modify: `packages/teamlead/src/__tests__/runner-idle-watchdog.test.ts`
- Modify: `packages/teamlead/src/RunnerIdleWatchdog.ts`

- [ ] **Step 1: 在 FLY-639 containment describe 写失败断言**

把现有 `getActiveSessions throwing...` 测试在第一次 failed poll 后扩展：

```typescript
expect(watchdog.health()).toMatchObject({
	pollInProgress: false,
	lastPollResult: "error",
	activeRunningSessions: null,
});
expect(watchdog.health().lastPollAt).not.toBeNull();
```

并在第二次成功空轮后断言：

```typescript
expect(watchdog.health()).toMatchObject({
	lastPollResult: "ok",
	activeRunningSessions: 0,
});
```

- [ ] **Step 2: 运行该测试并确认正确 RED**

Run:

```bash
cd packages/teamlead
pnpm exec vitest run src/__tests__/runner-idle-watchdog.test.ts -t "getActiveSessions throwing"
```

Expected: FAIL，实际 `lastPollResult` 不是 `error`。

- [ ] **Step 3: 在现有 catch 中记录 error，不改 containment 行为**

在 `poll()` 顶层 catch 的 warning/self-heal 之前设置：

```typescript
this.lastPollResult = "error";
this.activeRunningSessions = null;
```

保留 `recoverFromCorruption(err)`、warning 和 resolve-without-reject 合同。后续成功轮覆盖为 `ok` 和真实 count。

- [ ] **Step 4: 运行 containment 与完整 watchdog tests 确认 GREEN**

Run:

```bash
cd packages/teamlead
pnpm exec vitest run src/__tests__/runner-idle-watchdog.test.ts -t "getActiveSessions throwing"
pnpm exec vitest run src/__tests__/runner-idle-watchdog.test.ts
```

Expected: containment test PASS；watchdog 文件 28 tests PASS；warning 被原测试 spy containment。

- [ ] **Step 5: 提交 watchdog owner 批次**

```bash
git add packages/teamlead/src/RunnerIdleWatchdog.ts packages/teamlead/src/__tests__/runner-idle-watchdog.test.ts
git commit -m "feat(FLY-204): expose idle watchdog poll health"
```

### Task 3: `/health` additive contract 与 live holder 接线

**Files:**
- Modify: `packages/teamlead/src/__tests__/bridge.test.ts`
- Modify: `packages/teamlead/src/bridge/plugin.ts`

- [ ] **Step 1: 写 standalone fallback 的失败断言**

在现有 `GET /health returns 200...` 测试加入：

```typescript
expect(body.watchdog).toEqual({
	timerRunning: false,
	pollIntervalMs: null,
	pollInProgress: false,
	lastPollAt: null,
	lastPollResult: null,
	activeRunningSessions: null,
});
```

- [ ] **Step 2: 写 provider 透传的失败测试**

复用 `createBridgeApp` 长参数形式，传入：

```typescript
const watchdogHealth = {
	timerRunning: true,
	pollIntervalMs: 30_000,
	pollInProgress: false,
	lastPollAt: "2026-08-30T10:00:00.000Z",
	lastPollResult: "ok" as const,
	activeRunningSessions: 0,
};
const holder = { current: { health: () => ({ ...watchdogHealth }) } };
```

并断言 `/health` response 的 `watchdog` 严格等于 `watchdogHealth`。该测试与 shutdown holder 测试并列，opts 同时只传 `idleWatchdogHealthHolder: holder`。

- [ ] **Step 3: 运行 Bridge health tests 并确认正确 RED**

Run:

```bash
cd packages/teamlead
pnpm exec vitest run src/__tests__/bridge.test.ts -t "GET /health"
```

Expected: 两个新增断言 FAIL，因为 response 尚无 `watchdog`。

- [ ] **Step 4: 增加窄 provider option 与固定 fallback**

从 `RunnerIdleWatchdog.ts` import type：

```typescript
import type {
	IdleWatchdogHealth,
	IdleWatchdogHealthProvider,
} from "../RunnerIdleWatchdog.js";
```

`BridgeAppOptions` 增加：

```typescript
idleWatchdogHealthHolder?: {
	current: IdleWatchdogHealthProvider | null;
};
```

在 route 附近定义固定 fallback（`Object.freeze` 可选但不要求）：

```typescript
const UNWIRED_IDLE_WATCHDOG_HEALTH: IdleWatchdogHealth = {
	timerRunning: false,
	pollIntervalMs: null,
	pollInProgress: false,
	lastPollAt: null,
	lastPollResult: null,
	activeRunningSessions: null,
};
```

为使 fallback 类型合法，将 `IdleWatchdogHealth.pollIntervalMs` 定义为 `number | null`；live provider 始终返回 number。

在 `/health` request time 读取：

```typescript
const watchdog =
	opts?.idleWatchdogHealthHolder?.current?.health() ??
	UNWIRED_IDLE_WATCHDOG_HEALTH;
```

并在 JSON 中 additive 加入 `watchdog`，不改 `ok`、status code、`sessions_count`。

- [ ] **Step 5: 创建 holder、传给 app、绑定 live provider**

在 `startBridge()` 的 `stuckDetectorHolder`/`shutdownStateHolder` 附近新增：

```typescript
const idleWatchdogHealthHolder: {
	current: IdleWatchdogHealthProvider | null;
} = { current: null };
```

传入 `createBridgeApp(..., opts)`；watchdog 构造完成后、`start()` 前绑定：

```typescript
idleWatchdogHealthHolder.current = idleWatchdog;
idleWatchdog.start();
```

绑定必须发生在 `start()` 前，避免 timer 已 armed 但 route 仍显示 unwired 的竞态。

- [ ] **Step 6: 运行 Bridge health tests 确认 GREEN**

Run:

```bash
cd packages/teamlead
pnpm exec vitest run src/__tests__/bridge.test.ts -t "GET /health"
pnpm exec vitest run src/__tests__/bridge.test.ts
```

Expected: health subset PASS；bridge 文件 22 tests PASS。

- [ ] **Step 7: 运行组合 focused suite 和 build**

```bash
cd packages/teamlead
pnpm exec vitest run src/__tests__/runner-idle-watchdog.test.ts src/__tests__/bridge.test.ts
pnpm run typecheck
cd ../..
pnpm -r build
```

Expected: 2 files、50 tests PASS；typecheck exit 0；22 workspace packages build exit 0。

- [ ] **Step 8: 提交 Bridge 接线批次**

```bash
git add packages/teamlead/src/bridge/plugin.ts packages/teamlead/src/__tests__/bridge.test.ts
git commit -m "feat(FLY-204): publish watchdog state on health"
```

### Task 4: 回归、评审与修复循环

**Files:**
- Modify only files named by blocking review findings.

- [ ] **Step 1: 运行精确全仓 gates**

```bash
pnpm lint
pnpm -r build
pnpm test:packages:run
for test_file in scripts/__tests__/*.test.sh; do bash "$test_file"; done
```

Expected: 每条命令 exit 0。若已知环境失败，必须先复现、归因、确认与本 diff 无关，并通过 Lead report 明示；不得把 partial package execution 当全仓通过。

- [ ] **Step 2: 检查 Lead inbox 后运行 code review**

```bash
node /Users/xiaorongli/Dev/flywheel-FLY-2182/packages/flywheel-comm/dist/index.js inbox --exec-id c09a5a21-1cbb-453b-8f4d-86a7b3cb44a9
node /Users/xiaorongli/Dev/flywheel-FLY-2182/packages/flywheel-comm/dist/index.js stage set code_review
```

随后按 runner contract 使用 `codex:rescue` 形状进行独立 review，并注册：

```bash
node /Users/xiaorongli/Dev/flywheel-FLY-2182/packages/flywheel-comm/dist/index.js gate review_code --lead flywheel-test-2 --exec-id c09a5a21-1cbb-453b-8f4d-86a7b3cb44a9 --no-block "Code review requested for FLY-204"
node /Users/xiaorongli/Dev/flywheel-FLY-2182/packages/flywheel-comm/dist/index.js request-review --type code --question-id <captured-question-id>
```

轮询 `check <captured-question-id>`；`CHANGES_REQUESTED` 时按 findingKey 做新的 RED→GREEN fix、提交、推送并开全新 review gate。`APPROVED` 才进入 PR。

### Task 5: PR 前 final commit 与完成路由

**Files:**
- Create: `engineering/doc/milestones/FLY-204.md`

- [ ] **Step 1: 生成 milestone 内容并作为 literal last commit**

Milestone 必须包含：问题、交付字段、没有改变的行为、focused/full gate 结果、review verdict、commit SHA。创建后：

```bash
git add engineering/doc/milestones/FLY-204.md
git commit -m "docs(FLY-204): record watchdog observability milestone"
```

此后不再运行会提交 `progress.md` 的 ledger 命令，不再改任何文件；若必须修代码，milestone commit 不再是 last commit，修完后必须更新 milestone 并重新作为最后提交。

- [ ] **Step 2: re-run final lightweight invariants without writes**

```bash
git status --short
git log -1 --format='%s'
git diff origin/main...HEAD --check
```

Expected: clean status；last subject 为 milestone；diff check exit 0。

- [ ] **Step 3: push、开 PR、报告并完成 bounded node**

```bash
git push -u origin project-slot-2-FLY-204
gh pr create --base main --head project-slot-2-FLY-204 --title "feat(FLY-204): expose idle watchdog health" --body-file <prepared-pr-body>
node /Users/xiaorongli/Dev/flywheel-FLY-2182/packages/flywheel-comm/dist/index.js ask --lead flywheel-test-2 --exec-id c09a5a21-1cbb-453b-8f4d-86a7b3cb44a9 --report 'DONE: FLY-204 implementation complete; watchdog health snapshot is exposed; full verification and code review evidence are in the PR; PR: <url>'
node /Users/xiaorongli/Dev/flywheel-FLY-2182/packages/flywheel-comm/dist/index.js complete --route needs_review --pr <number>
```

不请求 ship approval，不 merge，不 dispatch QA。

## Plan self-review

- Spec coverage: 覆盖成功空轮、in-flight、重叠 skip、error、cadence、active-running 计数、standalone fallback、live holder、shutdown compatibility。
- Scope: 只改 watchdog owner、Bridge health route/wiring 和对应 tests；不碰检测/告警/cadence。
- Type consistency: `IdleWatchdogHealthProvider.health()`、`IdleWatchdogHealth` 与 holder 字段名在所有 task 中一致。
- Reverse compatibility: `/health` status、顶层字段和消费者不变；嵌套 `watchdog` 为 additive。
- TDD: 每个生产行为都有先失败、后最小实现、再完整 focused suite 的显式步骤。
- Placeholders: 执行期动态 id、PR URL/number 和 PR body path 由命令返回后替换；代码与测试步骤无未定义实现占位。
