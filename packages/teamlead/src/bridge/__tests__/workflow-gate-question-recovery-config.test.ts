import { describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { initializeFlagStore } from "../flag-store-runtime.js";
import { workflowGateQuestionRecoveryEnabled } from "../plugin.js";

describe("workflow gate question recovery flag", () => {
	it("FLY-2427 fails closed when the call-time project flag read throws", async () => {
		const store = await StateStore.create(":memory:");
		const flagStore = initializeFlagStore(store, {});
		const log = vi.fn();
		store.getFlagValueRow = vi.fn(() => {
			throw new Error("flag store unavailable");
		}) as typeof store.getFlagValueRow;

		expect(
			workflowGateQuestionRecoveryEnabled({
				flagStore,
				projectName: "flywheel",
				log,
			}),
		).toBe(false);
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("recovery disabled"),
		);
		store.close();
	});
});
