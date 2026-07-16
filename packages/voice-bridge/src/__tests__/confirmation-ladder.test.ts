/**
 * FLY-545 PR-2 P12′ — ConfirmationLadder: a executes+narrates, b readback
 * with silence≠consent, c posts a receipt and STRUCTURALLY cannot execute.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmationLadder } from "../huddle/ConfirmationLadder.js";

function setup(over: { confirmTimeoutMs?: number } = {}) {
	const spoken: string[] = [];
	const receipts: string[] = [];
	const ladder = new ConfirmationLadder({
		speaker: { speak: (t) => spoken.push(t) },
		postReceipt: async (c) => {
			receipts.push(c);
		},
		confirmTimeoutMs: over.confirmTimeoutMs ?? 15_000,
	});
	return { ladder, spoken, receipts };
}

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe("tier a — implicit + narrate", () => {
	it("executes immediately and speaks the returned narration", async () => {
		const { ladder, spoken } = setup();
		const execute = vi.fn(async () => "建好了,FLY-1234。");
		const outcome = await ladder.submitA({
			description: "建立项 issue",
			execute,
		});
		expect(outcome).toBe("executed");
		expect(execute).toHaveBeenCalledOnce();
		expect(spoken).toEqual(["建好了,FLY-1234。"]);
	});
});

describe("tier b — readback, silence ≠ consent", () => {
	it("executes only after an explicit verbal yes", async () => {
		const { ladder, spoken } = setup();
		const execute = vi.fn(async () => {});
		const p = ladder.submitB({
			description: "改优先级",
			readback: "我要把 FLY-1 设成最高优先级,",
			execute,
		});
		expect(spoken[0]).toContain("对吧?");
		expect(execute).not.toHaveBeenCalled();
		ladder.notifyFounderUtterance("对");
		await expect(p).resolves.toBe("executed");
		expect(execute).toHaveBeenCalledOnce();
	});

	it("a timeout means NOT executed, and says so", async () => {
		const { ladder, spoken } = setup({ confirmTimeoutMs: 5000 });
		const execute = vi.fn(async () => {});
		const p = ladder.submitB({ description: "x", readback: "读回", execute });
		await vi.advanceTimersByTimeAsync(5000);
		await expect(p).resolves.toBe("timeout");
		expect(execute).not.toHaveBeenCalled();
		expect(spoken.some((s) => s.includes("先不动"))).toBe(true);
	});

	it("an explicit no cancels", async () => {
		const { ladder } = setup();
		const execute = vi.fn(async () => {});
		const p = ladder.submitB({ description: "x", readback: "读回", execute });
		ladder.notifyFounderUtterance("不对,先别");
		await expect(p).resolves.toBe("declined");
		expect(execute).not.toHaveBeenCalled();
	});

	it("unrelated speech keeps the window open", async () => {
		const { ladder } = setup();
		const execute = vi.fn(async () => {});
		const p = ladder.submitB({ description: "x", readback: "读回", execute });
		ladder.notifyFounderUtterance("我们刚才说到哪了");
		expect(ladder.awaitingConfirmation).toBe(true);
		ladder.notifyFounderUtterance("确认");
		await expect(p).resolves.toBe("executed");
	});

	it("execute failure resolves declined and is spoken, never silent", async () => {
		const { ladder, spoken } = setup();
		const p = ladder.submitB({
			description: "x",
			readback: "读回",
			execute: async () => {
				throw new Error("boom");
			},
		});
		ladder.notifyFounderUtterance("好");
		await expect(p).resolves.toBe("declined");
		expect(spoken.some((s) => s.includes("出错"))).toBe(true);
	});
});

describe("tier c — receipt only, zero execution path", () => {
	it("posts the receipt card and resolves receipt-posted", async () => {
		const { ladder, receipts, spoken } = setup();
		const outcome = await ladder.submitC({
			description: "ship FLY-999 的 PR",
			readback: "你要把 FLY-999 ship 上线,",
		});
		expect(outcome).toBe("receipt-posted");
		expect(receipts[0]).toContain("不授权");
		expect(receipts[0]).toContain("founder gate");
		expect(spoken[0]).toContain("不算数");
		// structural: submitC's input type carries NO execute callback — a
		// voice-side c-tier execution simply has nowhere to live.
	});

	it("a founder yes after a c-tier receipt executes NOTHING", async () => {
		const { ladder } = setup();
		await ladder.submitC({ description: "merge", readback: "readback" });
		expect(ladder.awaitingConfirmation).toBe(false);
		ladder.notifyFounderUtterance("确认,批准"); // no pending b — a no-op
		expect(ladder.awaitingConfirmation).toBe(false);
	});
});
