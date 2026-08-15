import { afterEach, describe, expect, it, vi } from "vitest";
import { arbitrateFreshLinearState } from "../land-linear-arbitration.js";

describe("arbitrateFreshLinearState", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("accepts a fresh non-canceled Linear state", async () => {
		await expect(
			arbitrateFreshLinearState({
				persistedStateType: "started",
				readFreshStateType: vi.fn().mockResolvedValue("completed"),
			}),
		).resolves.toEqual({ ok: true });
	});

	it("refuses a fresh canceled Linear state", async () => {
		await expect(
			arbitrateFreshLinearState({
				readFreshStateType: vi.fn().mockResolvedValue("canceled"),
			}),
		).resolves.toEqual({
			ok: false,
			reason: "canceled_fresh_linear",
		});
	});

	it("audits degraded cleanup when a durable completed observation backs a failed fresh read", async () => {
		await expect(
			arbitrateFreshLinearState({
				persistedStateType: "completed",
				readFreshStateType: vi.fn().mockRejectedValue(new Error("offline")),
			}),
		).resolves.toEqual({ ok: true, degraded: "linear_unreachable" });
	});

	it("degrades safely when Linear is unreachable without a completed observation", async () => {
		await expect(
			arbitrateFreshLinearState({
				persistedStateType: "started",
				readFreshStateType: vi.fn().mockRejectedValue(new Error("offline")),
			}),
		).resolves.toEqual({ ok: true, degraded: "linear_unreachable" });
	});

	it("bounds a fresh read that never settles", async () => {
		vi.useFakeTimers();
		const decision = arbitrateFreshLinearState({
			readFreshStateType: vi.fn().mockReturnValue(new Promise(() => undefined)),
			timeoutMs: 10_000,
		});

		await vi.advanceTimersByTimeAsync(10_000);
		await expect(decision).resolves.toEqual({
			ok: true,
			degraded: "linear_unreachable",
		});
	});
});
