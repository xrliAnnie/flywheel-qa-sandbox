import { describe, expect, it } from "vitest";
import type { StateStore } from "../../StateStore.js";
import { resolveWorkflowTmuxWindowAuthority } from "../run-infra.js";

function releasedLaunchStore(): StateStore {
	return {
		getSession: () => ({
			session_params: JSON.stringify({
				pane_loss_generation: {
					socket_path: "/tmp/flywheel.sock",
					server_start_time: "123",
					window_id: "@7",
					execution_id: "exec-1",
					launch_generation: 2,
					launch_fingerprint: "fingerprint-2",
				},
			}),
		}),
		getWorkflowLaunchOwner: () => ({ released_generation: 2 }),
	} as unknown as StateStore;
}

describe("resolveWorkflowTmuxWindowAuthority", () => {
	it("prunes a released same-execution window only when its full persisted identity matches", () => {
		const store = releasedLaunchStore();
		expect(
			resolveWorkflowTmuxWindowAuthority(store, "exec-1", {
				windowId: "@7",
				windowName: "design",
				executionId: "exec-1",
				launchGeneration: 2,
				launchFingerprint: "fingerprint-2",
			}),
		).toBe("prune");
	});

	it.each([
		["wrong window id", { windowId: "@8" }],
		["wrong generation", { launchGeneration: 1 }],
		["wrong fingerprint", { launchFingerprint: "stale" }],
		["missing fingerprint", { launchFingerprint: undefined }],
	])("keeps a released same-execution window with %s", (_label, override) => {
		const store = releasedLaunchStore();
		expect(
			resolveWorkflowTmuxWindowAuthority(store, "exec-1", {
				windowId: "@7",
				windowName: "design",
				executionId: "exec-1",
				launchGeneration: 2,
				launchFingerprint: "fingerprint-2",
				...override,
			}),
		).toBe("keep");
	});
});
