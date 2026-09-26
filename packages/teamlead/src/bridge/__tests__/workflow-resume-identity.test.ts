import { describe, expect, it } from "vitest";
import {
	buildStandbyResumeStartRequest,
	frozenLaunchLeadId,
	observeWorkflowResumeLaunchFailure,
} from "../workflow-resume-identity.js";

describe("workflow resume identity launch race", () => {
	it("keeps waiting for observed identity after launch commit", async () => {
		const launch = observeWorkflowResumeLaunchFailure(
			Promise.resolve({ status: "committed" }),
		)!;
		const observed = await Promise.race([
			launch,
			Promise.resolve({ kind: "identity" as const }),
		]);

		expect(observed).toEqual({ kind: "identity" });
	});

	it("surfaces a proven pre-commit failure", async () => {
		await expect(
			observeWorkflowResumeLaunchFailure(
				Promise.resolve({
					status: "precommit_failed",
					failure: {
						code: "LAUNCH_PRECOMMIT_FAILED",
						reason: "launch_failed",
						physicalEvidence: "absent",
					},
				}),
			),
		).resolves.toMatchObject({
			kind: "launch",
			outcome: { status: "precommit_failed" },
		});
	});
});

describe("standby resume launch request", () => {
	const lifecycle = {
		generation: 2,
		demandId: "rework:demand-1",
		retirementApproved: () => false,
	};

	it("reopens the body with the Lead and node it was first launched with", () => {
		// FLY-2808 QA: the resume request dropped the frozen Lead, so the resumed
		// Codex daemon lost its CommDB writable root (launch_snapshot_mismatch)
		// and a resumed runner lost its Lead mailbox identity.
		const request = buildStandbyResumeStartRequest({
			session: {
				execution_id: "exec-1",
				issue_id: "FLY-2808",
				project_name: "flywheel",
				issue_identifier: "FLY-2808",
				issue_title: "standby",
				chat_thread_role: "implement",
				session_role: "implement",
			},
			runProjectName: "flywheel",
			runtime: {
				vendor: "codex",
				model: "gpt-5.6-sol",
				effort: "xhigh",
				node_id: "implement",
			},
			leadId: frozenLaunchLeadId(
				{ getSession: () => ({ lead_id: "flywheel-eng-lead" }) },
				"exec-1",
			),
			expectedSessionId: "thread-1",
			expectedCwd: "/work/tree",
			currentHead: "abc123",
			lifecycle,
		});

		expect(request).toMatchObject({
			successorExecutionId: "exec-1",
			leadId: "flywheel-eng-lead",
			dispatchVendor: "codex",
			dispatchModel: "gpt-5.6-sol",
			dispatchEffort: "xhigh",
			startPoint: "abc123",
			previousSession: { threadId: "thread-1" },
			processLifecycle: {
				mode: "resume",
				generation: 2,
				demandId: "rework:demand-1",
				nodeId: "implement",
				expectedSessionId: "thread-1",
				expectedModel: "gpt-5.6-sol",
				expectedCwd: "/work/tree",
			},
		});
	});

	it("keeps an unregistered Lead absent instead of inventing one", () => {
		expect(
			frozenLaunchLeadId({ getSession: () => ({ lead_id: null }) }, "exec-1"),
		).toBeUndefined();
		expect(
			frozenLaunchLeadId({ getSession: () => undefined }, "exec-1"),
		).toBeUndefined();
	});
});
