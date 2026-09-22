import { expect, it } from "vitest";
import { createResidentHomeEvidence } from "../resident-home-evidence.js";

const request = {
	executionId: "exec-1",
	home: "/fixture/homes/agents/flywheel/implement",
	project: "flywheel",
	role: "implement",
	process: { pid: 123, startIdentity: "start-123" },
	commPresent: true,
};

function deps() {
	return {
		getSession: () => ({
			execution_id: "exec-1",
			project_name: "flywheel",
			status: "running",
			adapter_type: "codex-tmux",
			workflow_node_id: "implement",
		}),
		resolveExecutionHome: () => ({
			kind: "keyed" as const,
			home: request.home,
			project: "flywheel",
			role: "implement",
		}),
		readLaunchSnapshot: () => ({
			schemaVersion: 1 as const,
			executionId: "exec-1",
		}),
		probeDaemonProcessBinding: async () => ({
			bound: true,
			reason: "bound" as const,
		}),
	};
}

it("accepts a no-lease resident only when every durable authority agrees", async () => {
	await expect(createResidentHomeEvidence(deps())(request)).resolves.toEqual({
		verified: true,
		reason: "verified",
	});
});

it.each([
	["CommDB orphan", { commPresent: false }],
	["wrong project", { session: { project_name: "raya" } }],
	["wrong role", { session: { workflow_node_id: "qa" } }],
	["wrong persistent home", { resolution: { home: "/fixture/other" } }],
	["stale launch", { launch: { executionId: "old-exec" } }],
	[
		"PID reuse",
		{ binding: { bound: false, reason: "process_start_mismatch" } },
	],
	[
		"socket holder wrong group",
		{ binding: { bound: false, reason: "process_group_mismatch" } },
	],
])("fails closed for %s", async (_label, mutation) => {
	const base = deps();
	if (mutation.session) {
		const original = base.getSession();
		base.getSession = () => ({ ...original, ...mutation.session });
	}
	if (mutation.resolution) {
		const original = base.resolveExecutionHome();
		base.resolveExecutionHome = () => ({ ...original, ...mutation.resolution });
	}
	if (mutation.launch) {
		const original = base.readLaunchSnapshot();
		base.readLaunchSnapshot = () => ({ ...original, ...mutation.launch });
	}
	if (mutation.binding) {
		base.probeDaemonProcessBinding = async () => mutation.binding as never;
	}
	const result = await createResidentHomeEvidence(base)({
		...request,
		...(mutation.commPresent === false ? { commPresent: false } : {}),
	});
	expect(result.verified).toBe(false);
});
