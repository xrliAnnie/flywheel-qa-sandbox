import { describe, expect, it, vi } from "vitest";
import { probeRegisteredPhaseActor } from "../phase-actor-probe.js";

const session = {
	execution_id: "implement-exec",
	issue_id: "FLY-1462",
	project_name: "flywheel",
	status: "terminated",
};

describe("probeRegisteredPhaseActor", () => {
	it("treats a CommDB read error as indeterminate without probing a target", async () => {
		const probeTarget = vi.fn(async () => "alive" as const);

		await expect(
			probeRegisteredPhaseActor({
				session,
				lookupTarget: vi.fn(() => ({
					kind: "error",
					error: "database locked",
				})),
				probeTarget,
			}),
		).resolves.toBe("indeterminate");
		expect(probeTarget).not.toHaveBeenCalled();
	});

	it("treats a missing CommDB registration as absent", async () => {
		const probeTarget = vi.fn(async () => "alive" as const);

		await expect(
			probeRegisteredPhaseActor({
				session,
				lookupTarget: vi.fn(() => ({ kind: "gone" })),
				probeTarget,
			}),
		).resolves.toBe("absent");
		expect(probeTarget).not.toHaveBeenCalled();
	});

	it("probes the registered target when CommDB resolves it", async () => {
		const probeTarget = vi.fn(async () => "dead_pin" as const);

		await expect(
			probeRegisteredPhaseActor({
				session,
				lookupTarget: vi.fn(() => ({
					kind: "found",
					target: {
						tmuxWindow: "flywheel:@42",
						sessionName: "flywheel",
					},
				})),
				probeTarget,
			}),
		).resolves.toBe("dead_pin");
		expect(probeTarget).toHaveBeenCalledWith("flywheel:@42");
	});
});
