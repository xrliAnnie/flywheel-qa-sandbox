import { afterEach, describe, expect, it, vi } from "vitest";
import type { StateStore } from "../../StateStore.js";
import { buildWorkflowRunSnapshotV1 } from "../../workflow-run-snapshot.js";
import { credentialWindowForNode } from "../../workflow-submission-expiry.js";
import { loadBundledWorkflowSeeds } from "../../workflow-template.js";
import {
	createRunInfraWorkflowClaimsAdmission,
	resolveWorkflowTmuxWindowAuthority,
} from "../run-infra.js";

afterEach(() => {
	vi.useRealTimers();
});

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

describe("createRunInfraWorkflowClaimsAdmission", () => {
	it.each([
		["manifest override", false],
		["registry default", true],
	])("uses credentialWindowForNode for the %s", (_label, removeOverride) => {
		const manifest = structuredClone(
			loadBundledWorkflowSeeds().find(
				(candidate) => candidate.templateId === "tpl_eng_heavy",
			)!.manifest,
		);
		const qa = manifest.nodes.find((node) => node.id === "qa");
		if (!qa) throw new Error("QA node missing");
		if (removeOverride) delete qa.submissionWindowMinutes;
		const snapshot = buildWorkflowRunSnapshotV1({
			template: { id: "legacy-admission-window", revision: 1 },
			manifest,
		});
		const now = new Date("2026-08-05T00:00:00.000Z");
		vi.useFakeTimers({ now });
		const admitWorkflowExecution = vi.fn(() => ({
			ok: true as const,
			credentialId: 1,
			credential: "qa-credential",
		}));
		const store = {
			getActiveWorkflowRun: () => ({
				run_id: "run-1",
				snapshot: JSON.stringify(snapshot),
			}),
			admitWorkflowExecution,
		} as unknown as StateStore;

		expect(
			createRunInfraWorkflowClaimsAdmission(store).admit({
				projectName: "flywheel",
				issueId: "FLY-1655",
				node: "qa",
				executionId: "qa-exec",
				attempt: 1,
			}),
		).toEqual({ credential: "qa-credential" });
		expect(admitWorkflowExecution).toHaveBeenCalledWith({
			runId: "run-1",
			nodeId: "qa",
			executionId: "qa-exec",
			attempt: 1,
			family: "qa_verdict",
			now: now.toISOString(),
			...credentialWindowForNode(snapshot, "qa", now),
		});
	});
});
