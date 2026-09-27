import { describe, expect, it, vi } from "vitest";
import {
	observePatrolProcessLiveness,
	probePatrolProcessLiveness,
} from "../patrol-process-liveness.js";

describe("FLY-2919 patrol process liveness", () => {
	it("reports body alive and window missing as separate facts", async () => {
		const observeBody = vi.fn(async () => "alive" as const);
		await expect(
			observePatrolProcessLiveness("exec-live", "flywheel", {
				observeBody,
				lookup: () => ({ kind: "gone" }),
				discover: async () => ({ kind: "missing" }),
			}),
		).resolves.toEqual({ body: "alive", window: "missing" });
		expect(observeBody).toHaveBeenCalledWith("exec-live", "flywheel");
	});

	it.each(["alive", "dead_pin", "absent", "indeterminate"] as const)(
		"does not let window verdict %s change an alive body verdict",
		async (windowVerdict) => {
			await expect(
				probePatrolProcessLiveness("exec-live", "flywheel", {
					observeBody: async () => "alive",
					lookup: () => ({
						kind: "found",
						target: {
							tmuxWindow: "FLY-2919:@1",
							sessionName: "FLY-2919",
						},
					}),
					probe: async () => windowVerdict,
				}),
			).resolves.toBe("alive");
		},
	);

	it("reports a dead body despite a live window", async () => {
		await expect(
			observePatrolProcessLiveness("exec-dead", "flywheel", {
				observeBody: async () => "dead",
				lookup: () => ({
					kind: "found",
					target: {
						tmuxWindow: "FLY-2919:@1",
						sessionName: "FLY-2919",
					},
				}),
				probe: async () => "alive",
			}),
		).resolves.toEqual({ body: "dead", window: "present" });
	});

	it("keeps a pending target diagnostic without using it as body truth", async () => {
		await expect(
			observePatrolProcessLiveness("exec-pending", "flywheel", {
				observeBody: async () => "alive",
				lookup: () => ({
					kind: "found",
					target: {
						tmuxWindow: "runner-flywheel:pending",
						sessionName: "runner-flywheel",
					},
				}),
				discover: async () => ({ kind: "missing" }),
			}),
		).resolves.toEqual({ body: "alive", window: "pending" });
	});

	it("fails body truth closed when its shared observer throws", async () => {
		await expect(
			observePatrolProcessLiveness("exec-unknown", "flywheel", {
				observeBody: async () => {
					throw new Error("reader unavailable");
				},
				lookup: () => ({ kind: "error", error: "locked" }),
			}),
		).resolves.toEqual({ body: "unknown", window: "unknown" });
	});
});
