/**
 * FLY-245 D2 — RetryDispatcher accepts a gateway PRE-BOUND successor execution
 * id (plan §5.2.1 item 1: the dispatcher no longer self-generates a randomUUID
 * for gateway-driven retries, so recovery can reconcile/re-drive by a key that
 * was durably bound BEFORE dispatch). Without a pre-bound id the behavior is
 * byte-identical (randomUUID).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BlueprintContext } from "flywheel-edge-worker/dist/Blueprint.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ProjectRuntime, RetryDispatcher } from "../run-dispatcher.js";

/** preRegisterCommDb writes to the real ~/.flywheel/comm — no-op it in tests. */
class TestRetryDispatcher extends RetryDispatcher {
	protected override preRegisterCommDb(): void {}
	protected override cleanupPreRegistration(): void {}
}

describe("RetryDispatcher pre-bound successor id (D2)", () => {
	let tmpDir: string;
	let captured: BlueprintContext[];
	let resolveRun: (() => void) | undefined;

	function makeRuntime(blockRun = false): ProjectRuntime {
		return {
			blueprint: {
				run: vi.fn(async (_n: unknown, _r: string, ctx: BlueprintContext) => {
					captured.push(ctx);
					if (blockRun) {
						await new Promise<void>((res) => {
							resolveRun = res;
						});
					}
					return { success: true, sessionId: "s" };
				}),
			} as unknown as ProjectRuntime["blueprint"],
			projectRoot: tmpDir,
			tmuxSessionName: "runner-test",
			agentDispatcher: {
				dispatchByName: vi.fn(),
			} as unknown as ProjectRuntime["agentDispatcher"],
		};
	}

	function makeDispatcher(blockRun = false): TestRetryDispatcher {
		return new TestRetryDispatcher(
			new Map([["proj", makeRuntime(blockRun)]]),
			[],
		);
	}

	const baseReq = {
		oldExecutionId: "pred-1",
		issueId: "FLY-245",
		projectName: "proj",
		runAttempt: 1,
	};

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "fly245-d2-dispatch-"));
		captured = [];
		resolveRun = undefined;
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("uses the pre-bound successor id instead of generating one", async () => {
		const d = makeDispatcher();
		const res = await d.dispatch({
			...baseReq,
			successorExecutionId: "succ-9",
		});
		expect(res.newExecutionId).toBe("succ-9");
		await d.drain();
		expect(captured[0]?.executionId).toBe("succ-9");
	});

	it("without a pre-bound id the legacy behavior is unchanged (fresh UUID)", async () => {
		const d = makeDispatcher();
		const res = await d.dispatch({ ...baseReq });
		expect(res.newExecutionId).toMatch(/^[0-9a-f-]{36}$/);
		await d.drain();
	});

	it("converges on an identical in-flight dispatch: same key + same pre-bound id → returns it, no second run", async () => {
		const d = makeDispatcher(true);
		const first = await d.dispatch({
			...baseReq,
			successorExecutionId: "succ-9",
		});
		// replay of the SAME logical dispatch while the first is still in flight
		const second = await d.dispatch({
			...baseReq,
			successorExecutionId: "succ-9",
		});
		expect(second.newExecutionId).toBe(first.newExecutionId);
		expect(captured).toHaveLength(1); // blueprint ran exactly once
		resolveRun?.();
		await d.drain();
	});

	it("a DIFFERENT pre-bound id for an in-flight issue/role still throws (no silent second runner)", async () => {
		const d = makeDispatcher(true);
		await d.dispatch({ ...baseReq, successorExecutionId: "succ-9" });
		await expect(
			d.dispatch({ ...baseReq, successorExecutionId: "succ-OTHER" }),
		).rejects.toThrow(/already in progress/i);
		resolveRun?.();
		await d.drain();
	});

	it("an un-bound replay against an in-flight pre-bound dispatch still throws (legacy guard intact)", async () => {
		const d = makeDispatcher(true);
		await d.dispatch({ ...baseReq, successorExecutionId: "succ-9" });
		await expect(d.dispatch({ ...baseReq })).rejects.toThrow(
			/already in progress/i,
		);
		resolveRun?.();
		await d.drain();
	});
});
