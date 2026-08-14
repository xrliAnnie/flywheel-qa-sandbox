import { describe, expect, it, vi } from "vitest";
import { runLeadReconcilePass } from "../lead-reconcile-pass.js";

const STEP_NAMES = ["lease", "identity", "outbox", "sensors", "hub"];

function makeDeps(events: string[], failing?: string) {
	const step = (name: string) => async () => {
		events.push(name);
		if (name === failing) throw new Error(`${name} failed`);
	};
	return {
		reconcileLeaseEpisodes: step("lease"),
		scanLeadIdentities: step("identity"),
		materializeLeaseAudit: step("outbox"),
		tickFleetSensors: step("sensors"),
		reconcileAlerts: step("hub"),
		logger: vi.fn(),
	};
}

describe("runLeadReconcilePass", () => {
	it("runs the five riders once in their dependency order", async () => {
		const events: string[] = [];
		await runLeadReconcilePass(makeDeps(events));
		expect(events).toEqual(STEP_NAMES);
	});

	it.each(STEP_NAMES.slice(0, -1))(
		"isolates a %s failure and still runs every later rider",
		async (failing) => {
			const events: string[] = [];
			const deps = makeDeps(events, failing);
			await expect(runLeadReconcilePass(deps)).resolves.toBeUndefined();
			expect(events).toEqual(STEP_NAMES);
			expect(deps.logger).toHaveBeenCalledOnce();
		},
	);
});
