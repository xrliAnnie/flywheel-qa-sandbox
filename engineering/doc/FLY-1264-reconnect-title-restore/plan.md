# FLY-1264 重连标题自动恢复 — 实施计划
Issue: FLY-1264 (https://linear.app/geoforge3d/issue/FLY-1264/fix-bridge-重启后-thread-标题卡在重连中不恢复-重连完成未改回阶段前缀今日复发-3-次founder-直视)
日期: 2026-07-14
基于: research.md

> **For Implement runner:** 在同一条 Flywheel branch 上逐任务执行；每个行为变更都先用
> `superpowers:test-driven-development` 做 RED → GREEN → REFACTOR。不要使用执行编排 skill，
> 不要改动 FLY-1225 的状态映射。

**Goal:** Bridge-only restart 后，活跃 issue thread 的 `⚠️重连中` 在 unified display
refresher 就绪后立即恢复为 StateStore 推导出的 canonical phase/stage badge；内部
monitor-loss 保护态继续保留，直到真实 runner event、terminal marker 或 tmux death 清除。

**Architecture:** 在 `HeartbeatService` 内把内部 `reconnecting` 与 title-only
`reconnectTitleActive` 拆成两个 set。boot seed 返回本次新进入 title episode 的 exec IDs；
`plugin.ts` 完成 FLY-907 refresher wiring 后，只 settle title set，并按 issue 去重 enqueue
canonical refresh。Discord archived code 50083 归为 quiet `deferred`，由既有 sweep 重试；
429 继续复用 per-thread latest-wins writer。

**Tech stack:** TypeScript、Node.js、Express composition root、Vitest、Discord REST v10、
StateStore、FLY-907 `IssueDisplayRefresher`。

---

## Scope and invariants

- 本单只修 `⚠️重连中 → canonical phase/stage prefix`。
- 不改变 `deriveIssueTitleBadge()` / `derivePhaseDisplayState()`，因此不碰 FLY-1225 的
  awaiting_review / gate-open 映射。
- 不用 heartbeat 证明 event channel 恢复；`isReconnecting()` 仍只由真实 accepted event、
  terminal/death 路径清除。
- 不持久化旧 Discord title；canonical writer 继续 GET 当前标题并保留人工 base title。
- 不新增 timer。boot wiring 后立即 enqueue；FLY-907 active-issue sweep 仅作失败 backstop。
- `FLYWHEEL_ISSUE_DISPLAY_REFRESH=0` 时不执行 boot title settle，保留 FLY-623 legacy
  clear 行为，避免 title-active 被清掉却没有 canonical writer 接手。
- archived thread 不自动 unarchive；Discord `400 / code=50083` quiet defer，解档后由 sweep
  收敛。其他 400/403 仍是可见失败。
- `⚠️重连中` enter 写法、通知事件与 Discord rename rate-limit 策略不在本单重做；一次
  restart 的 enter + restore 正好消耗两次 rename。60 秒是 Discord 接受 PATCH 时的
  fast-path SLO；若服务端因 10 分钟内重复 restart 返回更长 Retry-After，只能保证 writer
  最终收敛，不能声称突破 Discord 限额。真机 QA 分开验证无 burst fast path 与 429 path。
- 极少见的 seed→wiring early-event race 会请求第三次 rename（`⚠️` → legacy 细粒度 badge →
  canonical phase）；latest-wins writer 会合并仍 pending 的 intermediate target，已触达
  Discord 的第三次请求仍受同一 429 eventual-convergence 边界约束。

## File map

| File | Responsibility | Planned change |
|---|---|---|
| `packages/teamlead/src/HeartbeatService.ts` | monitor-loss state owner | 拆分 internal/title 两层状态，boot seed 返回 IDs，新增 title settle API |
| `packages/teamlead/src/__tests__/HeartbeatService.monitor-loss.test.ts` | FLY-623 orchestration regression | 锁定 seed/settle/clear/restart 边界与 suppression 不变量 |
| `packages/teamlead/src/bridge/issue-display-refresher.ts` | canonical issue display | guard 改读 title-only predicate |
| `packages/teamlead/src/bridge/__tests__/issue-display-refresher.test.ts` | FLY-907 convergence regression | 无 stage event 的 defer→canonical restore、fingerprint/retry |
| `packages/teamlead/src/bridge/reconnect-title-restore.ts` | boot composition helper | settle exec IDs、按 issue 去重、enqueue canonical refresh |
| `packages/teamlead/src/bridge/__tests__/reconnect-title-restore.test.ts` | composition helper unit test | 去重、空集和 early-clear 行为 |
| `packages/teamlead/src/bridge/plugin.ts` | Bridge boot ordering | 捕获 seed IDs；refresher wiring 后调用 helper |
| `packages/teamlead/src/bridge/ChatThreadCreator.ts` | coalescing Discord title writer | 精确识别 archived 50083 为 deferred、quiet |
| `packages/teamlead/src/__tests__/ChatThreadCreator.test.ts` | Discord result contract | archived quiet deferred；普通 400/403 仍 failed；429 latest target 不回退 |
| `packages/teamlead/src/__tests__/event-route.stage-emoji.test.ts` | typed reconnect holder harness | 补齐扩展后的 `ReconnectController` mock surface |

## Task 1 — Split internal reconnect protection from title lifetime

**Files:**

- Modify: `packages/teamlead/src/HeartbeatService.ts:185-196`
- Modify: `packages/teamlead/src/HeartbeatService.ts:245-256`
- Modify: `packages/teamlead/src/HeartbeatService.ts:740-815`
- Test: `packages/teamlead/src/__tests__/HeartbeatService.monitor-loss.test.ts:130-270`
- Test harness: `packages/teamlead/src/__tests__/event-route.stage-emoji.test.ts:80-92`

- [ ] **Step 1: write failing state-boundary tests**

在 `HeartbeatService.monitor-loss.test.ts` 的 readopt-ON describe 中加入：

```ts
it("boot seed returns only newly re-adopted execs and activates both layers", async () => {
	store.getActiveSessions.mockReturnValue([sess()]);
	expect(await service.seedReconnecting()).toEqual(["exec-1"]);
	expect(service.isReconnecting("exec-1")).toBe(true);
	expect(service.isReconnectTitleActive("exec-1")).toBe(true);

	// Same process, same episode: no duplicate boot candidate or title stamp.
	expect(await service.seedReconnecting()).toEqual([]);
	expect(notifier.onSessionMonitoringReestablished).toHaveBeenCalledTimes(1);
});

it("settles only the title layer and keeps monitor-loss suppression", async () => {
	const s = sess();
	store.getActiveSessions.mockReturnValue([s]);
	store.getStuckSessions.mockReturnValue([s]);
	const seeded = await service.seedReconnecting();

	expect(service.settleReconnectTitles(seeded)).toEqual([s]);
	expect(service.isReconnectTitleActive("exec-1")).toBe(false);
	expect(service.isReconnecting("exec-1")).toBe(true);
	await service.checkStuck();
	expect(notifier.onSessionStuck).not.toHaveBeenCalled();
	expect(notifier.clearReconnectStamp).not.toHaveBeenCalled();
});

it("accepted-event clear removes both layers but boot settle still returns its issue session", async () => {
	store.getActiveSessions.mockReturnValue([sess()]);
	const seeded = await service.seedReconnecting();

	service.clearReconnecting("exec-1");
	expect(service.isReconnecting("exec-1")).toBe(false);
	expect(service.isReconnectTitleActive("exec-1")).toBe(false);
	expect(service.settleReconnectTitles(seeded)).toEqual([sess()]);
	expect(notifier.clearReconnectStamp).toHaveBeenCalledTimes(1);
});

it("event clear after boot title settle does not issue a stale legacy restamp", async () => {
	store.getActiveSessions.mockReturnValue([sess()]);
	const seeded = await service.seedReconnecting();
	service.settleReconnectTitles(seeded);

	service.clearReconnecting("exec-1");
	expect(service.isReconnecting("exec-1")).toBe(false);
	expect(notifier.clearReconnectStamp).not.toHaveBeenCalled();
});
```

把现有 kill-switch test 的返回值也锁为 `[]`：

```ts
expect(await service.seedReconnecting()).toEqual([]);
```

- [ ] **Step 2: run the focused test and confirm RED**

Run:

```bash
pnpm --filter flywheel-teamlead exec vitest run \
  src/__tests__/HeartbeatService.monitor-loss.test.ts
```

Expected: FAIL，至少报告 `isReconnectTitleActive is not a function`、
`settleReconnectTitles is not a function`，以及 `seedReconnecting()` 返回 `undefined`。

- [ ] **Step 3: add the narrow controller surface and separate set**

在 `ReconnectController` 中使用一致签名：

```ts
export interface ReconnectController {
	isReconnecting(executionId: string): boolean;
	isReconnectTitleActive(executionId: string): boolean;
	clearReconnecting(executionId: string): void;
	settleReconnectTitles(executionIds: readonly string[]): Session[];
}
```

在 `HeartbeatService` 中新增 title-only state：

```ts
private reconnecting = new Set<string>();
private reconnectTitleActive = new Set<string>();
```

注释必须明确：`reconnecting` 继续控制 heartbeat refresh 与 stuck/orphan/idle suppression；
`reconnectTitleActive` 只控制 FLY-907 Face A 是否允许覆盖 `⚠️重连中`。

- [ ] **Step 4: make boot seed return only newly-entered title episodes**

把 `seedReconnecting()` 改成以下状态转换；无 wiring、kill-switch、terminal、dead、marker
reconciled 均返回空数组：

```ts
async seedReconnecting(): Promise<string[]> {
	const deps = this.buildMarkerDeps();
	if (!deps || !this.readoptEnabled()) return [];
	this.markerRetryPending.clear();
	const seeded: string[] = [];
	const running = this.store
		.getActiveSessions()
		.filter((s) => s.status === "running");
	for (const session of running) {
		const execId = session.execution_id;
		const wasTitleActive = this.reconnectTitleActive.has(execId);
		await this.reconcileCandidateReadopt(session, deps);
		if (!wasTitleActive && this.reconnectTitleActive.has(execId)) {
			seeded.push(execId);
		}
	}
	return seeded;
}
```

在 `enterReconnecting()` 的 first-entry 分支同时激活 title state；stay cycle 不重复写：

```ts
if (this.reconnecting.has(execId)) return;
this.reconnecting.add(execId);
this.reconnectTitleActive.add(execId);
```

- [ ] **Step 5: implement title settle without clearing protection**

```ts
isReconnectTitleActive(executionId: string): boolean {
	return this.reconnectTitleActive.has(executionId);
}

settleReconnectTitles(executionIds: readonly string[]): Session[] {
	const affected: Session[] = [];
	for (const executionId of executionIds) {
		this.reconnectTitleActive.delete(executionId);
		const session = this.store.getSession(executionId);
		if (session) affected.push(session);
	}
	return affected;
}
```

`clearReconnecting()` 同时删两层，但仅当 legacy title 当时仍 active 才调用
`clearReconnectStamp`，防止 boot settle 后又写一个 per-session 细粒度 badge：

```ts
clearReconnecting(executionId: string): void {
	const wasReconnecting = this.reconnecting.delete(executionId);
	const wasTitleActive = this.reconnectTitleActive.delete(executionId);
	if (!wasReconnecting && !wasTitleActive) return;
	if (!wasTitleActive) return;
	const session = this.store.getSession(executionId);
	if (session) this.notifier.clearReconnectStamp?.(session);
}
```

- [ ] **Step 6: update the event-route test holder type**

`event-route.stage-emoji.test.ts` 的 `buildApp()` test-only shape 增加新成员，保持与
`ReconnectController` 可赋值：

```ts
current: {
	isReconnecting: (id: string) => boolean;
	isReconnectTitleActive: (id: string) => boolean;
	clearReconnecting: (id: string) => void;
	settleReconnectTitles: (ids: readonly string[]) => Session[];
} | null;
```

现有测试传入的 mock 增加：

```ts
isReconnectTitleActive: () => true,
settleReconnectTitles: () => [],
```

- [ ] **Step 7: run tests and typecheck; confirm GREEN**

```bash
pnpm --filter flywheel-teamlead exec vitest run \
  src/__tests__/HeartbeatService.monitor-loss.test.ts \
  src/__tests__/event-route.stage-emoji.test.ts
pnpm --filter flywheel-teamlead typecheck
```

Expected: both files PASS；typecheck exit 0。重点读断言确认 settle 后
`isReconnecting=true`，不是只看测试进程退出码。

- [ ] **Step 8: commit the state split**

```bash
git add packages/teamlead/src/HeartbeatService.ts \
  packages/teamlead/src/__tests__/HeartbeatService.monitor-loss.test.ts \
  packages/teamlead/src/__tests__/event-route.stage-emoji.test.ts
git commit -m "fix(bridge): separate reconnect title state"
```

## Task 2 — Let FLY-907 restore the canonical badge without a runner event

**Files:**

- Modify: `packages/teamlead/src/bridge/issue-display-refresher.ts:425-436`
- Modify: `packages/teamlead/src/bridge/issue-display-refresher.ts:680-686`
- Test: `packages/teamlead/src/bridge/__tests__/issue-display-refresher.test.ts:120-165`
- Test: `packages/teamlead/src/bridge/__tests__/issue-display-refresher.test.ts:527-570`

- [ ] **Step 1: write the defer→restore regression test**

把 harness option 从 `isReconnecting` 改为 `isReconnectTitleActive`，再加入无需
`stage_changed` 的两次 refresh：

```ts
it("FLY-1264: boot title settle lets the same persisted stage replace ⚠️ without a runner event", async () => {
	seedSession(store, {
		exec: "e-main",
		role: "main",
		status: "running",
		stage: "implement",
	});
	let titleActive = true;
	const { refresher, log } = makeRefresher(store, {
		isReconnectTitleActive: () => titleActive,
		tmux: { "e-main": "runner-proj:@5" },
		windowNames: { "runner-proj:@5": `${IDENT}-runner-x` },
	});

	await refresher.refresh(ISSUE);
	expect(log.title).toEqual([]);
	expect(storedFingerprint(store)).toBeNull();

	titleActive = false; // plugin boot settle; StateStore stage did not change
	await refresher.refresh(ISSUE);
	expect(log.title).toEqual([{ via: "stage", stage: "implement" }]);
	expect(storedFingerprint(store)).not.toBeNull();
});
```

保留原 FLY-623 guard test，但改名并改 seam：

```ts
it("title-active guard defers Face A and withholds the fingerprint", async () => {
	seedSession(store, {
		exec: "e-main",
		role: "main",
		status: "running",
		stage: "implement",
	});
	const { refresher, log } = makeRefresher(store, {
		isReconnectTitleActive: () => true,
		tmux: { "e-main": "runner-proj:@5" },
		windowNames: { "runner-proj:@5": `${IDENT}-runner-x` },
	});
	await refresher.refresh(ISSUE);
	expect(log.title).toEqual([]);
	expect(storedFingerprint(store)).toBeNull();
});
```

- [ ] **Step 2: run the regression and confirm RED**

```bash
pnpm --filter flywheel-teamlead exec vitest run \
  src/bridge/__tests__/issue-display-refresher.test.ts
```

Expected: FAIL，因为 production deps 仍读取 `isReconnecting`，新 seam 不会 defer。

- [ ] **Step 3: rename the dependency to the display-specific predicate**

```ts
isReconnectTitleActive?: (execId: string) => boolean;
```

Face A guard 改为：

```ts
if (this.deps.isReconnectTitleActive?.(badgeSession.execution_id)) {
	resultA = "deferred";
}
```

这是原 `if` 分支的精确替换；它后面的 `else if (badge.kind === "blocked")` 及其余
blocked/completed/phase/stage 分支逐字保留。三段式正确前缀继续由
已有 `deriveIssueTitleBadge()` 测试覆盖：design=`🎨设计`、implement=`🔨实现`、qa=`🧪QA`。

- [ ] **Step 4: add explicit deferred-result fingerprint coverage**

在现有 “failed face keeps issue a sweep candidate” 附近加入：

```ts
it("a deferred canonical title write withholds the success fingerprint", async () => {
	seedSession(store, { exec: "e-design", role: "design", status: "running" });
	const { refresher } = makeRefresher(store, { results: { title: "deferred" } });
	await refresher.refresh(ISSUE);
	expect(storedFingerprint(store)).toBeNull();
});
```

- [ ] **Step 5: run focused tests and commit**

```bash
pnpm --filter flywheel-teamlead exec vitest run \
  src/bridge/__tests__/issue-display-refresher.test.ts \
  src/bridge/__tests__/issue-display.test.ts
git add packages/teamlead/src/bridge/issue-display-refresher.ts \
  packages/teamlead/src/bridge/__tests__/issue-display-refresher.test.ts
git commit -m "fix(bridge): gate reconnect title separately"
```

Expected: PASS；新 regression 的第二次 refresh 在没有任何 StateStore mutation 时写出
`implement` badge 并持久化 fingerprint。

## Task 3 — Settle boot title episodes after refresher wiring

**Files:**

- Create: `packages/teamlead/src/bridge/reconnect-title-restore.ts`
- Create: `packages/teamlead/src/bridge/__tests__/reconnect-title-restore.test.ts`
- Modify: `packages/teamlead/src/bridge/plugin.ts:4892-4907`
- Modify: `packages/teamlead/src/bridge/plugin.ts:5993-6020`

- [ ] **Step 1: write a failing composition-helper test**

```ts
import { describe, expect, it, vi } from "vitest";
import type { ReconnectController } from "../../HeartbeatService.js";
import type { Session } from "../../StateStore.js";
import type { IssueDisplayRefreshHandle } from "../issue-display-refresher.js";
import { settleBootReconnectTitles } from "../reconnect-title-restore.js";

function session(exec: string, issue: string): Session {
	return {
		execution_id: exec,
		issue_id: issue,
		project_name: "flywheel",
		status: "running",
	} as Session;
}

describe("settleBootReconnectTitles", () => {
	it("settles the exact boot execs and enqueues each affected issue once", () => {
		const settleReconnectTitles = vi.fn().mockReturnValue([
			session("e-design", "issue-1"),
			session("e-impl", "issue-1"),
			session("e-other", "issue-2"),
		]);
		const reconnect = { settleReconnectTitles } as unknown as ReconnectController;
		const enqueue = vi.fn();
		const refresher = { enqueue } as unknown as IssueDisplayRefreshHandle;

		expect(
			settleBootReconnectTitles(
				reconnect,
				["e-design", "e-impl", "e-other"],
				refresher,
			),
		).toEqual(["issue-1", "issue-2"]);
		expect(settleReconnectTitles).toHaveBeenCalledWith([
			"e-design",
			"e-impl",
			"e-other",
		]);
		expect(enqueue.mock.calls).toEqual([["issue-1"], ["issue-2"]]);
	});

	it("still enqueues canonical refresh after an early accepted event cleared the title state", () => {
		const reconnect = {
			settleReconnectTitles: vi
				.fn()
				.mockReturnValue([session("e-cleared", "issue-early")]),
		} as unknown as ReconnectController;
		const enqueue = vi.fn();
		const refresher = { enqueue } as unknown as IssueDisplayRefreshHandle;
		expect(
			settleBootReconnectTitles(reconnect, ["e-cleared"], refresher),
		).toEqual(["issue-early"]);
		expect(enqueue).toHaveBeenCalledWith("issue-early");
	});
});
```

- [ ] **Step 2: run the new test and confirm RED**

```bash
pnpm --filter flywheel-teamlead exec vitest run \
  src/bridge/__tests__/reconnect-title-restore.test.ts
```

Expected: FAIL with module-not-found for `reconnect-title-restore.js`。

- [ ] **Step 3: implement the small deduplicating helper**

```ts
import type { ReconnectController } from "../HeartbeatService.js";
import type { IssueDisplayRefreshHandle } from "./issue-display-refresher.js";

export function settleBootReconnectTitles(
	reconnect: ReconnectController,
	executionIds: readonly string[],
	refresher: IssueDisplayRefreshHandle,
): string[] {
	const issueIds = [
		...new Set(
			reconnect
				.settleReconnectTitles(executionIds)
				.map((session) => session.issue_id),
		),
	];
	for (const issueId of issueIds) refresher.enqueue(issueId);
	return issueIds;
}
```

该 helper 不碰 Discord、不读 StateStore、不清 internal reconnecting；它只把 Heartbeat state
transition 和 FLY-907 trigger 接起来。

- [ ] **Step 4: capture the boot candidates in `plugin.ts`**

在现有 seed block 前声明稳定的空数组，异常保持 non-fatal：

```ts
let bootReconnectExecutionIds: string[] = [];
try {
	bootReconnectExecutionIds = await heartbeatService.seedReconnecting();
} catch (err) {
	console.error(
		`[Bridge] FLY-623 reconnect boot-seed failed (non-fatal): ${(err as Error).message}`,
	);
}
```

在文件 import 区加入：

```ts
import { settleBootReconnectTitles } from "./reconnect-title-restore.js";
```

- [ ] **Step 5: bind the title predicate, then settle only after wiring**

避免在赋值表达式里隐藏顺序，先构造 local refresher，再 publish holder，再 settle：

```ts
if (issueDisplayRefreshEnabled && chatThreadCreator) {
	const issueDisplayRefresher = new IssueDisplayRefresher({
		store,
		projects,
		config,
		chatThreadCreator,
		flags: {
			issueStatusEmojiEnabled:
				process.env.FLYWHEEL_ISSUE_STATUS_EMOJI !== "0",
			issueAttachPinEnabled:
				process.env.FLYWHEEL_ISSUE_ATTACH_PIN !== "0",
		},
		keepAliveEnabled: () => threeStageKeepAliveEnabled(),
		isReconnectTitleActive: (execId) =>
			reconnectHolder.current?.isReconnectTitleActive(execId) ?? false,
	});
	issueDisplayRefreshHolder.current = issueDisplayRefresher;
	const restoredIssues = settleBootReconnectTitles(
		heartbeatService,
		bootReconnectExecutionIds,
		issueDisplayRefresher,
	);
	if (restoredIssues.length > 0) {
		console.log(
			`[issue-display] queued reconnect-title restore for ${restoredIssues.length} issue(s)`,
		);
	}
	console.log(
		"[issue-display] FLY-907 unified refresher wired (derive-from-state, all lifecycle triggers)",
	);
}
```

顺序不变量：`seedReconnecting()` 早于 helper；`holder.current = refresher` 早于 settle/enqueue；
`heartbeatService.start()` / idle watchdog 的既有保护顺序不移动。escape hatch 条件为 false 时，
helper 不执行，legacy lifecycle 保持不变。实施时保留 `plugin.ts:5993-5999` 的 FLY-907
escape-hatch / late-bound 注释与 `plugin.ts:6012-6013` 的 FLY-623 interaction 注释，不把
Step 5 snippet 当成删除既有背景注释的整块替换。

- [ ] **Step 6: run helper, heartbeat, display tests and typecheck**

```bash
pnpm --filter flywheel-teamlead exec vitest run \
  src/bridge/__tests__/reconnect-title-restore.test.ts \
  src/__tests__/HeartbeatService.monitor-loss.test.ts \
  src/bridge/__tests__/issue-display-refresher.test.ts
pnpm --filter flywheel-teamlead typecheck
```

Expected: PASS / exit 0。检查 plugin diff，确认没有把 seed 移到 FLY-172 marker drain 或
FLY-324 done-but-running sweep之前。

- [ ] **Step 7: commit the boot convergence path**

```bash
git add packages/teamlead/src/bridge/reconnect-title-restore.ts \
  packages/teamlead/src/bridge/__tests__/reconnect-title-restore.test.ts \
  packages/teamlead/src/bridge/plugin.ts
git commit -m "fix(bridge): restore titles after reconnect seed"
```

## Task 4 — Make archived Discord threads quiet and retryable

**Files:**

- Modify: `packages/teamlead/src/bridge/ChatThreadCreator.ts:79-88`
- Modify: `packages/teamlead/src/bridge/ChatThreadCreator.ts:605-630`
- Modify: `packages/teamlead/src/bridge/ChatThreadCreator.ts:765-779`
- Test: `packages/teamlead/src/__tests__/ChatThreadCreator.test.ts:800-970`

- [ ] **Step 1: write archived-vs-real-failure tests**

```ts
it("returns deferred without warning when Discord says the thread is archived", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	mockFetch
		.mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: () => Promise.resolve({ name: "⚠️重连中 [FLY-560] Discord issue status" }),
		})
		.mockResolvedValueOnce({
			ok: false,
			status: 400,
			text: () => Promise.resolve('{"message":"Thread is archived","code":50083}'),
		});

	await expect(
		creator.stampStatusBadgeResult(ctx(), "thread-1", "🔨实现"),
	).resolves.toBe("deferred");
	expect(warn).not.toHaveBeenCalled();
});

it("keeps an ordinary Discord 403 visible as a failed write", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	mockFetch
		.mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: () => Promise.resolve({ name: "⚠️重连中 [FLY-560] Discord issue status" }),
		})
		.mockResolvedValueOnce({
			ok: false,
			status: 403,
			text: () => Promise.resolve('{"message":"Missing Permissions","code":50013}'),
		});

	await expect(
		creator.stampStatusBadgeResult(ctx(), "thread-1", "🔨实现"),
	).resolves.toBe("failed");
	expect(warn).toHaveBeenCalledWith(
		expect.stringContaining("stage-emoji PATCH failed: 403"),
	);
});
```

- [ ] **Step 2: run the tests and confirm RED**

```bash
pnpm --filter flywheel-teamlead exec vitest run \
  src/__tests__/ChatThreadCreator.test.ts \
  -t "archived|ordinary Discord 403"
```

Expected: archived case returns `failed` and calls `console.warn`。

- [ ] **Step 3: add an exact Discord archived classifier**

```ts
function isArchivedThreadError(status: number, body: string): boolean {
	if (status !== 400) return false;
	try {
		const parsed = JSON.parse(body) as { code?: unknown };
		return parsed.code === 50083;
	} catch {
		return false;
	}
}

type TitleWriteResult =
	| { status: "ok" }
	| { status: "noop" }
	| { status: "error" }
	| { status: "deferred" }
	| { status: "rate_limited"; retryAfterMs: number };
```

PATCH 非 429 分支先读 body，再精确识别；不要对所有 400 静音：

```ts
const body = await patchRes.text().catch(() => "");
if (isArchivedThreadError(patchRes.status, body)) {
	return { status: "deferred" };
}
console.warn(
	`[ChatThreadCreator] stage-emoji PATCH failed: ${patchRes.status} ${body.slice(0, 200)}`,
);
return { status: "error" };
```

- [ ] **Step 4: preserve deferred through the result contract**

`enqueueTitleWriteResult()` 增加显式 mapping：

```ts
case "rate_limited":
case "deferred":
	return "deferred";
```

`drainTitleWrites()` 对 `deferred` 与 `error` 一样停止本轮，不 busy-loop；后续
`IssueDisplayRefresher` 不写 success fingerprint，active issue sweep 才是重试入口。

- [ ] **Step 5: re-run all writer regressions**

```bash
pnpm --filter flywheel-teamlead exec vitest run \
  src/__tests__/ChatThreadCreator.test.ts \
  src/bridge/__tests__/issue-display-refresher.test.ts
```

Expected: PASS。既有 429 test 仍证明 Retry-After 后落地；既有 coalescing test 仍证明
latest canonical target 获胜，不能出现旧 `⚠️重连中` 在稍后反写回来。

- [ ] **Step 6: commit the quiet retry classification**

```bash
git add packages/teamlead/src/bridge/ChatThreadCreator.ts \
  packages/teamlead/src/__tests__/ChatThreadCreator.test.ts
git commit -m "fix(bridge): defer archived thread title writes"
```

## Task 5 — Full regression and real bridge-only acceptance

**Files:**

- No new production files
- Runtime evidence: `/private/tmp/flywheel-bridge.log`

- [ ] **Step 1: run the complete targeted regression set**

```bash
pnpm --filter flywheel-teamlead exec vitest run \
  src/__tests__/HeartbeatService.monitor-loss.test.ts \
  src/__tests__/event-route.stage-emoji.test.ts \
  src/__tests__/ChatThreadCreator.test.ts \
  src/bridge/__tests__/issue-display.test.ts \
  src/bridge/__tests__/issue-display-refresher.test.ts \
  src/bridge/__tests__/reconnect-title-restore.test.ts
```

Expected: all PASS，0 failed。

- [ ] **Step 2: run package-wide static and test gates**

```bash
pnpm --filter flywheel-teamlead typecheck
pnpm --filter flywheel-teamlead test
pnpm biome check \
  packages/teamlead/src/HeartbeatService.ts \
  packages/teamlead/src/bridge/issue-display-refresher.ts \
  packages/teamlead/src/bridge/reconnect-title-restore.ts \
  packages/teamlead/src/bridge/plugin.ts \
  packages/teamlead/src/bridge/ChatThreadCreator.ts \
  packages/teamlead/src/__tests__/HeartbeatService.monitor-loss.test.ts \
  packages/teamlead/src/__tests__/event-route.stage-emoji.test.ts \
  packages/teamlead/src/__tests__/ChatThreadCreator.test.ts \
  packages/teamlead/src/bridge/__tests__/issue-display-refresher.test.ts \
  packages/teamlead/src/bridge/__tests__/reconnect-title-restore.test.ts
```

Expected: all commands exit 0。若 package-wide test 出现与改动无关的已知失败，保存完整
命令与错误，不能用 focused PASS 替代说明。

- [ ] **Step 3: inspect behavioral invariants in the final diff**

```bash
git diff --check
git diff --stat origin/main...HEAD
git diff origin/main...HEAD -- \
  packages/teamlead/src/HeartbeatService.ts \
  packages/teamlead/src/bridge/plugin.ts \
  packages/teamlead/src/bridge/issue-display-refresher.ts \
  packages/teamlead/src/bridge/ChatThreadCreator.ts
```

人工确认：

1. title settle 不调用 `reconnecting.delete()`；
2. idle/stuck/orphan guards仍读 `isReconnecting()`；
3. canonical guard只读 `isReconnectTitleActive()`；
4. plugin 先 publish refresher，再 settle/enqueue；
5. 50083 不写 success fingerprint，也不每轮 warn；
6. FLY-1225 mapping functions无 diff。

- [ ] **Step 4: perform real bridge-only restart acceptance**

选择一个正在运行、未归档、此前 10 分钟没有 title rename burst 的 active issue thread：

```bash
date -u +%FT%TZ
./scripts/restart-services.sh --bridge-only
```

用只读 Discord GET / founder thread 观察并记录 UTC timestamps：

1. restart 期间 title 出现 `⚠️重连中`；
2. Bridge listening 后，无需 runner 发送新 `stage_changed`；
3. 60 秒内恢复 StateStore 当前 canonical prefix；
4. design / implement / QA 分别应是 `🎨设计` / `🔨实现` / `🧪QA`；实际本轮只需对所选
   active phase 验收，另两种由 table tests 覆盖；
5. `/private/tmp/flywheel-bridge.log` 出现 restore enqueue 记录，无 uncaught error。

这里的 60 秒断言只适用于 Discord 接受 rename PATCH 的 fast path。另做一次连续 restart /
mock 429 验证时，应记录 Retry-After 并断言 eventual canonical convergence，不把服务端明确
要求等待的时长伪装成 fast-path PASS。

随后只在专用 QA/staging thread 上临时 archive 并做一次 restore trigger；不得拿 founder
正在使用的 active issue thread 做破坏性 archive。确认：

- Bridge 不 crash；
- log 不重复刷 `code 50083` warning；
- 解档后下一轮 active issue sweep 能恢复 canonical prefix。

- [ ] **Step 5: final commit if formatting or QA-only test corrections were needed**

```bash
git add packages/teamlead/src
git commit -m "test(bridge): cover reconnect title recovery"
```

仅在 Step 1–4 确实产生跟踪文件改动时创建该 commit；没有改动则跳过，不能制造空 commit。

## Acceptance traceability

| Acceptance / risk | Evidence task |
|---|---|
| restart 后 ≤1 分钟自动恢复 | Task 3 immediate enqueue + Task 5 writable-Discord fast-path stopwatch |
| 无新 stage event 也恢复 | Task 2 defer→settle test |
| 正确阶段前缀 | Task 2 canonical FLY-907 tests + Task 5 live check |
| internal suppression 不提前清除 | Task 1 state-boundary tests |
| repeated restart | Task 1 per-process episode test；新进程 set 重新 seed |
| early accepted event race | Task 1 + Task 3 canonical-enqueue-after-clear tests |
| 429 / transient failure 可重试 | 既有 latest-wins/429 tests + Task 2 no-fingerprint test |
| archived 50083 quiet/retryable | Task 4 classifier tests + Task 5 archive QA |
| ordinary Discord failure remains visible | Task 4 403 test |
| FLY-1225 boundary | Task 2 no mapping diff + full issue-display tests |

## Rollback

若真机验证发现 canonical enqueue 造成意外 title churn，只回退 Task 3 的 plugin/helper
wiring；Task 1 的两层状态若没有 consumer 不改变现有显示行为，Task 4 的 archived quiet
classification也可独立保留。不要用“清 internal reconnecting”作为回滚或热修，它会恢复
FLY-623 已阻止的 false stuck/orphan/idle alerts。

## Design review

Round 1（question `d05101cf-abba-43d3-a00c-4b17c5715991`）结论为 APPROVED，并提出三项
非阻塞 finding。本版已全部吸收：明确两次 rename 与 60 秒 fast-path SLO 的边界；让
early-event-cleared boot candidate 仍 enqueue canonical refresh；要求实施保留 plugin 原有
FLY-907 / FLY-623 注释。因为第二项改变了 settle 的返回语义，本版须再走一次 design review。

Round 2（question `8f1e2d81-9f26-4e0a-83f2-c6ad2a4d1ae4`）再次 APPROVED。唯一 LOW
finding 是 early-event race 可能请求第三次 rename；上方 Scope / rate-limit 说明已补充，
实现方案与测试矩阵无需再改。
