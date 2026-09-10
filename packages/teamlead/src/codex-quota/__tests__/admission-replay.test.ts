import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { createCodexQuotaDisabledAdmissionReplay } from "../admission-replay.js";

let store: StateStore;
beforeEach(async () => {
	store = await StateStore.create(":memory:");
});
afterEach(() => store.close());
function enqueue(key = "key") {
	store.codexQuota.reserveLegacyStart({
		startKey: key,
		executionId: key,
		projectName: "project",
		issueId: key,
		requestDigest: key,
		requestContext: JSON.stringify({
			idempotencyKey: key,
			projectName: "project",
			issueId: key,
			role: "implement",
			dispatchModel: "gpt-6-astra",
			agentName: "worker",
			freshStart: { reason: "requested" },
		}),
	});
	store.codexQuota.enqueueLegacyAdmissionWait({
		startKey: key,
		rootKey: "root",
		generation: 1,
	});
}
function running(key = "key") {
	store.upsertSession({
		execution_id: key,
		project_name: "project",
		issue_id: key,
		status: "running",
	});
}
it("OFF replays a persisted legacy reservation and releases only after matching running and live proof", async () => {
	enqueue();
	const post = vi.fn(async () => {
		running();
		return { status: 200, body: { success: true, executionId: "key" } };
	});
	const replay = createCodexQuotaDisabledAdmissionReplay({
		store,
		enabled: () => false,
		post,
		liveness: async () => "alive",
	});
	await replay();
	expect(post).toHaveBeenCalledWith("/api/runs/start", {
		idempotencyKey: "key",
		projectName: "project",
		issueId: "key",
		sessionRole: "implement",
		model: "gpt-6-astra",
		agentName: "worker",
		freshStart: true,
		freshStartReason: "requested",
	});
	expect(store.codexQuota.getAdmissionWait("key")?.state).toBe("released");
	await replay();
	expect(post).toHaveBeenCalledTimes(1);
});
it.each(["queued", "wrong-exec", "not-running", "not-live", "reenabled"])(
	"keeps %s replay pending",
	async (mode) => {
		enqueue();
		let enabled = false;
		const replay = createCodexQuotaDisabledAdmissionReplay({
			store,
			enabled: () => enabled,
			post: async () => {
				if (mode !== "not-running") running();
				if (mode === "reenabled") enabled = true;
				return {
					status: mode === "queued" ? 202 : 200,
					body: {
						success: true,
						executionId: mode === "wrong-exec" ? "other" : "key",
					},
				};
			},
			liveness: async () => (mode === "not-live" ? "unknown" : "alive"),
		});
		await replay();
		expect(store.codexQuota.getAdmissionWait("key")?.state).not.toBe(
			"released",
		);
	},
);
it("ON has no effects; OFF skips cancelled starts and continues after transport failure", async () => {
	enqueue("cancelled");
	enqueue("failed");
	enqueue("good");
	store.upsertSession({
		execution_id: "cancelled",
		project_name: "project",
		issue_id: "cancelled",
		status: "cancelled",
	});
	let enabled = true;
	const post = vi.fn(async (_path: string, body: Record<string, unknown>) => {
		if (body.idempotencyKey === "failed") throw new Error("transport");
		running("good");
		return { status: 200, body: { success: true, executionId: "good" } };
	});
	const replay = createCodexQuotaDisabledAdmissionReplay({
		store,
		enabled: () => enabled,
		post,
		liveness: async () => "alive",
	});
	await replay();
	expect(post).not.toHaveBeenCalled();
	enabled = false;
	await replay();
	expect(post).toHaveBeenCalledTimes(2);
	expect(store.codexQuota.getAdmissionWait("cancelled")?.state).toBe(
		"abandoned",
	);
	expect(store.codexQuota.getAdmissionWait("failed")?.state).not.toBe(
		"released",
	);
	expect(store.codexQuota.getAdmissionWait("good")?.state).toBe("released");
});
it("202 stays queued until a later pass proves 200 running; concurrent passes do not duplicate replay", async () => {
	enqueue();
	let resolvePost!: (value: {
		status: number;
		body: Record<string, unknown>;
	}) => void;
	const post = vi
		.fn()
		.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolvePost = resolve;
				}),
		)
		.mockImplementationOnce(async () => {
			running();
			return { status: 200, body: { success: true, executionId: "key" } };
		});
	const replay = createCodexQuotaDisabledAdmissionReplay({
		store,
		enabled: () => false,
		post,
		liveness: async () => "alive",
	});
	const first = replay();
	await replay();
	expect(post).toHaveBeenCalledTimes(1);
	resolvePost({ status: 202, body: { success: false, status: "queued" } });
	await first;
	expect(store.codexQuota.getAdmissionWait("key")?.state).toBe("resuming");
	await replay();
	expect(post).toHaveBeenCalledTimes(2);
	expect(store.codexQuota.getAdmissionWait("key")?.state).toBe("released");
});
it.each(["enabled", "cancelled"])(
	"does not release after %s changes during liveness",
	async (mode) => {
		enqueue();
		let enabled = false;
		const replay = createCodexQuotaDisabledAdmissionReplay({
			store,
			enabled: () => enabled,
			post: async () => {
				running();
				return { status: 200, body: { success: true, executionId: "key" } };
			},
			liveness: async () => {
				if (mode === "enabled") enabled = true;
				else
					store.upsertSession({
						execution_id: "key",
						project_name: "project",
						issue_id: "key",
						status: "cancelled",
					});
				return "alive";
			},
		});
		await replay();
		expect(store.codexQuota.getAdmissionWait("key")?.state).toBe(
			mode === "cancelled" ? "abandoned" : "resuming",
		);
	},
);
it("reports a replay failure code and cause while retaining the waiter", async () => {
	enqueue();
	const report = vi.fn();
	await createCodexQuotaDisabledAdmissionReplay({
		store,
		enabled: () => false,
		post: async () => {
			throw new Error("bridge transport unavailable");
		},
		liveness: async () => "unknown",
		report,
	})();
	expect(report).toHaveBeenCalledWith(
		"quota_admission_replay_unavailable",
		"bridge transport unavailable",
	);
	expect(store.codexQuota.getAdmissionWait("key")?.state).toBe("resuming");
});
it.each(["alive", "dead", "unknown"] as const)(
	"lost response then Bridge reconstruction reconciles %s without replaying the started execution",
	async (alive) => {
		enqueue();
		const lostResponse = vi.fn(async () => {
			running();
			throw new Error("response lost after launch");
		});
		await createCodexQuotaDisabledAdmissionReplay({
			store,
			enabled: () => false,
			post: lostResponse,
			liveness: async () => alive,
		})();
		expect(lostResponse).toHaveBeenCalledOnce();
		expect(store.codexQuota.getAdmissionWait("key")?.state).toBe("resuming");
		const post = vi.fn();
		const liveness = vi.fn(async () => alive);
		const reconstructed = createCodexQuotaDisabledAdmissionReplay({
			store,
			enabled: () => false,
			post,
			liveness,
		});
		await reconstructed();
		await reconstructed();
		expect(post).not.toHaveBeenCalled();
		expect(liveness).toHaveBeenCalled();
		expect(store.codexQuota.getAdmissionWait("key")?.state).toBe(
			alive === "alive" ? "released" : "resuming",
		);
	},
);
it.each([undefined, "runner-pane"])(
	"starting session with tmux %s is ambiguous and never grants a second launch",
	async (tmux) => {
		enqueue();
		store.upsertSession({
			execution_id: "key",
			project_name: "project",
			issue_id: "key",
			status: "starting",
			tmux_session: tmux,
		});
		const post = vi.fn();
		const liveness = vi.fn(async () => "dead" as const);
		await createCodexQuotaDisabledAdmissionReplay({
			store,
			enabled: () => false,
			post,
			liveness,
		})();
		expect(post).not.toHaveBeenCalled();
		expect(liveness).toHaveBeenCalledOnce();
		expect(store.codexQuota.getAdmissionWait("key")?.state).not.toBe(
			"released",
		);
	},
);
