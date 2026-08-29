import { describe, expect, it, vi } from "vitest";
import {
	createMergedGateGuard,
	type MergedGateGuardStore,
} from "../merged-gate-guard.js";

function storeHarness() {
	const rows = new Map<string, any>();
	const store: MergedGateGuardStore = {
		ensureMergedGateGuardFailure: vi.fn((input) => {
			const key = `${input.questionId}:${input.source}`;
			if (!rows.has(key)) {
				rows.set(key, {
					question_id: input.questionId,
					source: input.source,
					attempts: 0,
					first_seen_ms: input.nowMs,
					next_retry_ms: 0,
					terminal: false,
				});
			}
			return rows.get(key);
		}),
		recordMergedGateGuardUnknown: vi.fn((input) => {
			const row = rows.get(`${input.questionId}:${input.source}`);
			row.attempts++;
			row.next_retry_ms = input.nextRetryMs;
			row.terminal = input.terminal;
			return row;
		}),
		resolveMergedGateGuardFailure: vi.fn(),
		invalidateMergedGateArtifacts: vi.fn(() => ({
			invalidatedDeferredCount: 1,
			supersededActionCount: 1,
		})),
	};
	return { store, rows };
}

const args = {
	executionId: "exec-1",
	issueId: "FLY-1238",
	questionId: "q-1",
	projectName: "flywheel",
	projectRoot: "/repo",
	prNumber: 588,
	source: "text",
} as const;

describe("merged gate last-mile guard", () => {
	it.each(["open", "closed"] as const)(
		"%s continues without cleanup",
		async (state) => {
			const { store } = storeHarness();
			const retireQuestion = vi.fn();
			const guard = createMergedGateGuard({
				store,
				retireQuestion,
				checkPrMerge: vi.fn(async () => ({ state })),
			});
			expect(await guard(args)).toEqual({ kind: "continue", prState: state });
			expect(retireQuestion).not.toHaveBeenCalled();
			expect(store.invalidateMergedGateArtifacts).not.toHaveBeenCalled();
		},
	);

	it("MERGED suppresses before cleanup and remains suppressed when cleanup throws", async () => {
		const { store } = storeHarness();
		store.invalidateMergedGateArtifacts = vi.fn(() => {
			throw new Error("locked");
		});
		const retireQuestion = vi.fn(() => {
			throw new Error("commdb locked");
		});
		const guard = createMergedGateGuard({
			store,
			retireQuestion,
			checkPrMerge: vi.fn(async () => ({
				state: "merged" as const,
				mergeCommitOid: "deadbeef",
			})),
		});
		expect(await guard(args)).toEqual({
			kind: "suppress_merged",
			cleanupComplete: false,
		});
		expect(retireQuestion).toHaveBeenCalledWith("q-1", "exec-1", "flywheel");
	});

	it("missing PR binding stays retryable and probes once the binding appears", async () => {
		const { store } = storeHarness();
		const checkPrMerge = vi.fn(async () => ({ state: "open" as const }));
		const guard = createMergedGateGuard({
			store,
			retireQuestion: vi.fn(),
			checkPrMerge,
		});
		expect(await guard({ ...args, prNumber: undefined })).toEqual({
			kind: "retry_later",
			reason: "missing_binding",
		});
		expect(checkPrMerge).not.toHaveBeenCalled();
		expect(store.recordMergedGateGuardUnknown).not.toHaveBeenCalled();
		expect(await guard(args)).toEqual({ kind: "continue", prState: "open" });
		expect(checkPrMerge).toHaveBeenCalledTimes(1);
	});

	it("UNKNOWN uses bounded backoff and becomes terminal on the fifth real probe", async () => {
		const { store } = storeHarness();
		let now = 1_000;
		const checkPrMerge = vi.fn(async () => ({ state: "unknown" as const }));
		const guard = createMergedGateGuard({
			store,
			retireQuestion: vi.fn(),
			checkPrMerge,
			now: () => now,
		});
		for (const delay of [30_000, 60_000, 120_000, 240_000]) {
			expect(await guard(args)).toMatchObject({ kind: "retry_later" });
			now += delay;
		}
		expect(await guard(args)).toEqual({
			kind: "terminal_unavailable",
			reason: "unknown_exhausted",
		});
		expect(checkPrMerge).toHaveBeenCalledTimes(5);
	});

	it("shares a single fresh probe and caches OPEN for at most 15 seconds", async () => {
		const { store } = storeHarness();
		let now = 10_000;
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const checkPrMerge = vi.fn(async () => {
			await blocked;
			return { state: "open" as const };
		});
		const guard = createMergedGateGuard({
			store,
			retireQuestion: vi.fn(),
			checkPrMerge,
			now: () => now,
		});
		const a = guard(args);
		const b = guard({ ...args, questionId: "q-2" });
		release();
		await Promise.all([a, b]);
		expect(checkPrMerge).toHaveBeenCalledTimes(1);
		await guard({ ...args, questionId: "q-3" });
		expect(checkPrMerge).toHaveBeenCalledTimes(1);
		expect(store.ensureMergedGateGuardFailure).toHaveBeenCalledTimes(2);
		now += 15_001;
		await guard({ ...args, questionId: "q-4" });
		expect(checkPrMerge).toHaveBeenCalledTimes(2);
		expect(checkPrMerge.mock.calls[0]?.[2]).toBeLessThanOrEqual(2_500);
	});

	it("enforces six fresh probes per project per minute", async () => {
		const { store } = storeHarness();
		const checkPrMerge = vi.fn(async () => ({ state: "open" as const }));
		const guard = createMergedGateGuard({
			store,
			retireQuestion: vi.fn(),
			checkPrMerge,
		});
		for (let i = 0; i < 6; i++) {
			await guard({ ...args, prNumber: 600 + i, questionId: `q-${i}` });
		}
		expect(
			await guard({ ...args, prNumber: 700, questionId: "q-budget" }),
		).toEqual({ kind: "retry_later", reason: "budget" });
		expect(checkPrMerge).toHaveBeenCalledTimes(6);
	});

	it("kill switch bypasses only the network guard", async () => {
		const { store } = storeHarness();
		const checkPrMerge = vi.fn();
		const log = vi.fn();
		const guard = createMergedGateGuard({
			store,
			retireQuestion: vi.fn(),
			checkPrMerge,
			env: { FLYWHEEL_MERGED_GATE_GUARD: "0" },
			log,
		});
		expect(await guard(args)).toEqual({ kind: "continue", prState: "open" });
		expect(checkPrMerge).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledWith(expect.stringContaining("DISABLED"));
	});
});
