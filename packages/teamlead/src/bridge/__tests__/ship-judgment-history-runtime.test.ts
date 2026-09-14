import { expect, it, vi } from "vitest";
import { bindingFixture } from "../../ship-judgment/__tests__/binding-fixture.js";
import { createShipJudgmentHistoryRuntime } from "../ship-judgment-history-runtime.js";

it("creates a separate history runtime only for configured Flywheel ordinary Blob hosting", async () => {
	const { store } = await bindingFixture();
	try {
		const state = vi.spyOn(store, "getShipJudgmentHistoryState");
		const common = {
			store,
			projects: [{ projectName: "flywheel" }],
			registry: {} as never,
			critical: {} as never,
			onChanged: vi.fn(),
		};
		expect(
			createShipJudgmentHistoryRuntime({ ...common, blob: undefined }),
		).toBeUndefined();
		expect(
			createShipJudgmentHistoryRuntime({
				...common,
				blob: { resumeReport: vi.fn() },
				hostOverride: true,
			}),
		).toBeUndefined();
		expect(
			createShipJudgmentHistoryRuntime({
				...common,
				projects: [{ projectName: "raya" }],
				blob: { resumeReport: vi.fn() },
			}),
		).toBeUndefined();
		expect(state).not.toHaveBeenCalled();
		const runtime = createShipJudgmentHistoryRuntime({
			...common,
			blob: { resumeReport: vi.fn() },
		});
		expect(runtime).toBeDefined();
		expect(state).toHaveBeenCalledOnce();
		await runtime!.stop();
	} finally {
		store.close();
	}
});
