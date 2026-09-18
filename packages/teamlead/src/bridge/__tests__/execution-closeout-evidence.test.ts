import { describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import {
	type CloseoutObservations,
	collectCloseoutEvidence,
	collectExecutionCloseoutEvidence,
	decideCloseoutEvidence,
	type Observation,
} from "../execution-closeout-evidence.js";
import { collectIssueCloseoutNodes } from "../lifecycle-closeout.js";

const observedAt = "2026-09-16T05:00:00.000Z";

function observation(state: Observation["state"], source: string): Observation {
	return {
		state,
		observedAt,
		source,
		identity: "execution-1",
		reason: `${source}_${state}`,
	};
}

function allCovered(
	overrides: Partial<
		Record<keyof CloseoutObservations, Observation["state"]>
	> = {},
): CloseoutObservations {
	const states: Record<keyof CloseoutObservations, Observation["state"]> = {
		stateSession: "absent",
		commSession: "absent",
		window: "absent",
		hostProcess: "absent",
		daemon: "absent",
		heartbeat: "not_applicable",
		launch: "absent",
		...overrides,
	};
	return Object.fromEntries(
		Object.entries(states).map(([source, state]) => [
			source,
			observation(state, source),
		]),
	) as unknown as CloseoutObservations;
}

describe("execution closeout evidence", () => {
	for (const [source, state] of [
		["stateSession", "absent"],
		["commSession", "absent"],
		["window", "absent"],
		["hostProcess", "absent"],
		["heartbeat", "stale"],
	] as const) {
		it(`accepts ${source} ${state} as a negative fact when every live probe is covered`, () => {
			const evidence = allCovered({
				stateSession: "present",
				commSession: "present",
				[source]: state,
			});

			expect(decideCloseoutEvidence(evidence)).toBe("gone");
		});

		it(`lets a live daemon veto ${source} ${state}`, () => {
			expect(
				decideCloseoutEvidence(allCovered({ [source]: state, daemon: "live" })),
			).toBe("alive");
		});

		it(`fails closed when another required probe is unknown beside ${source} ${state}`, () => {
			expect(
				decideCloseoutEvidence(
					allCovered({ [source]: state, hostProcess: "unknown" }),
				),
			).toBe("unknown");
		});
	}

	it("does not treat a session row as execution liveness", () => {
		expect(
			decideCloseoutEvidence(
				allCovered({ stateSession: "present", commSession: "present" }),
			),
		).toBe("gone");
	});

	it("refuses gone while a launch or revival can still create a runner", () => {
		expect(decideCloseoutEvidence(allCovered({ launch: "present" }))).toBe(
			"unknown",
		);
	});

	it("requires an actual negative fact instead of terminal or parked text", () => {
		expect(
			decideCloseoutEvidence(
				allCovered({
					stateSession: "present",
					commSession: "present",
					window: "not_applicable",
					hostProcess: "not_applicable",
					daemon: "not_applicable",
				}),
			),
		).toBe("unknown");
	});

	it("keeps a workflow-attributed execution after its session row was deleted", () => {
		const nodes = collectIssueCloseoutNodes(
			{
				getSessionsForIssueAliases: () => [],
				findAutoQaRecordsByParentIssueKeys: () => [],
				listOpenLaunchClaims: () => [],
				getSession: () => undefined,
				getWorktreeBinding: () => undefined,
				listRunAttributedExecutions: () => [
					"implement-deleted",
					`mat:${"f".repeat(64)}`,
				],
			} as never,
			{
				rootKey: "issue-1",
				aliasKeys: ["issue-1", "FLY-2616"],
				projectName: "flywheel",
				runIds: ["run-1"],
				landManaged: true,
			} as never,
		);

		expect(nodes).toContainEqual({
			executionId: "implement-deleted",
			issueKey: "issue-1",
			projectName: "flywheel",
			role: "workflow",
		});
		expect(nodes).toHaveLength(1);
	});

	it("does not expand run-attributed sessionless nodes for non-land closeout", () => {
		const listRunAttributedExecutions = vi.fn(() => ["missing-session"]);
		const nodes = collectIssueCloseoutNodes(
			{
				getSessionsForIssueAliases: () => [],
				findAutoQaRecordsByParentIssueKeys: () => [],
				listOpenLaunchClaims: () => [],
				getSession: () => undefined,
				getWorktreeBinding: () => undefined,
				listRunAttributedExecutions,
			} as never,
			{
				rootKey: "issue-1",
				aliasKeys: ["issue-1"],
				projectName: "flywheel",
				runIds: ["run-1"],
				landManaged: false,
			},
		);

		expect(nodes).toEqual([]);
		expect(listRunAttributedExecutions).not.toHaveBeenCalled();
	});

	it("persists append-only evidence under the exact land claim generation", async () => {
		const store = await StateStore.create(":memory:");
		try {
			const operation = store.ensureLandOperation({
				runId: "run-1",
				issueId: "issue-1",
				projectName: "flywheel",
				prNumber: 2616,
				approvedHead: "a".repeat(40),
				now: "2026-09-16T05:00:00.000Z",
			});
			const claim = store.claimLandOperation({
				operationId: operation.operation_id,
				ownerId: "land-worker:1",
				ownerInstanceId: "instance-current",
				ownerPid: 123,
				ownerProcessStart: "process-start-current",
				ownerHostBootId: "host-boot-current",
				now: "2026-09-16T05:00:01.000Z",
				leaseExpiresAt: "2026-09-16T05:01:01.000Z",
			});
			expect(claim).toBeDefined();

			const input = {
				evidenceId: "11111111-1111-4111-8111-111111111111",
				operationId: operation.operation_id,
				ownerId: "land-worker:1",
				ownerInstanceId: "instance-current",
				operationGeneration: claim!.generation,
				probeSequence: 1,
				projectName: "flywheel",
				issueId: "issue-1",
				runId: "run-1",
				executionId: "implement-deleted",
				activationId: "activation-1",
				lifecycleRevision: null,
				attributionDigest: "b".repeat(64),
				commIdentityRevision: null,
				observedStartedAt: "2026-09-16T05:00:02.000Z",
				observedAt: "2026-09-16T05:00:03.000Z",
				expiresAt: "2026-09-16T05:00:33.000Z",
				evidence: {
					version: 1,
					observations: allCovered(),
					verdict: "gone",
				},
			};
			expect(
				store.recordCloseoutExecutionEvidence({
					...input,
					ownerInstanceId: "instance-stale",
				}),
			).toEqual({ ok: false, reason: "stale_land_generation" });
			expect(store.recordCloseoutExecutionEvidence(input)).toEqual({
				ok: true,
				idempotentReplay: false,
			});
			expect(store.recordCloseoutExecutionEvidence(input)).toEqual({
				ok: true,
				idempotentReplay: true,
			});
			expect(
				store.listCloseoutExecutionEvidence(operation.operation_id),
			).toMatchObject([
				{
					evidence_id: input.evidenceId,
					execution_id: "implement-deleted",
					operation_generation: claim!.generation,
					verdict: "gone",
				},
			]);
			expect(
				store.recordCloseoutExecutionEvidence({
					...input,
					evidenceId: "22222222-2222-4222-8222-222222222222",
					operationGeneration: claim!.generation + 1,
				}),
			).toEqual({ ok: false, reason: "stale_land_generation" });
		} finally {
			store.close();
		}
	});

	it("collects independently timestamped source facts and derives their reasons", async () => {
		let nowMs = Date.parse("2026-09-16T05:10:00.000Z");
		const evidence = await collectCloseoutEvidence(
			{
				evidenceId: "33333333-3333-4333-8333-333333333333",
				project: "flywheel",
				issueUuid: "issue-1",
				runId: "run-1",
				executionId: "implement-deleted",
				activationId: "activation-1",
				operationId: "land:1",
				operationGeneration: 2,
				lifecycleRevision: null,
				attributionDigest: "c".repeat(64),
				commIdentityRevision: null,
				windowIdentity: null,
				controllerGeneration: null,
				adapter: "unknown",
			},
			{
				stateSession: async () => ({ state: "absent", reason: "row_missing" }),
				commSession: async () => ({ state: "absent", reason: "row_missing" }),
				window: async () => ({ state: "absent", reason: "marker_missing" }),
				hostProcess: async () => ({ state: "absent", reason: "pid_missing" }),
				daemon: async () => ({ state: "absent", reason: "socket_missing" }),
				heartbeat: async () => ({
					state: "not_applicable",
					reason: "no_heartbeat_capability",
				}),
				launch: async () => ({ state: "absent", reason: "launch_settled" }),
				now: () => new Date(nowMs++),
			},
		);

		expect(evidence.verdict).toBe("gone");
		expect(evidence.negativeReasons).toEqual(
			expect.arrayContaining([
				"stateSession:row_missing",
				"window:marker_missing",
				"hostProcess:pid_missing",
			]),
		);
		expect(
			new Set(
				Object.values(evidence.observations).map((fact) => fact.observedAt),
			).size,
		).toBeGreaterThan(1);
		expect(
			Date.parse(evidence.expiresAt) - Date.parse(evidence.observedAt),
		).toBe(30_000);
	});

	it("turns a timed-out source into unknown instead of manufacturing absence", async () => {
		const evidence = await collectCloseoutEvidence(
			{
				evidenceId: "44444444-4444-4444-8444-444444444444",
				project: "flywheel",
				issueUuid: "issue-1",
				runId: null,
				executionId: "exec-1",
				activationId: null,
				operationId: "land:1",
				operationGeneration: 2,
				lifecycleRevision: null,
				attributionDigest: "d".repeat(64),
				commIdentityRevision: null,
				windowIdentity: null,
				controllerGeneration: null,
				adapter: "unknown",
			},
			{
				stateSession: async () => ({ state: "absent", reason: "row_missing" }),
				commSession: async () => ({ state: "absent", reason: "row_missing" }),
				window: async () => new Promise(() => undefined),
				hostProcess: async () => ({ state: "absent", reason: "pid_missing" }),
				daemon: async () => ({ state: "absent", reason: "socket_missing" }),
				heartbeat: async () => ({ state: "stale", reason: "lease_expired" }),
				launch: async () => ({ state: "absent", reason: "launch_settled" }),
				sourceTimeoutMs: 1,
				totalTimeoutMs: 50,
			},
		);

		expect(evidence.observations.window).toMatchObject({
			state: "unknown",
			reason: "probe_timeout",
		});
		expect(evidence.verdict).toBe("unknown");
	});

	it.each([
		["absent", "gone"],
		["alive", "alive"],
	] as const)(
		"probes a sessionless workflow execution and lets daemon %s decide %s",
		async (daemon, expected) => {
			const evidence = await collectExecutionCloseoutEvidence(
				{
					evidenceId: "55555555-5555-4555-8555-555555555555",
					project: "flywheel",
					issueUuid: "issue-1",
					runId: "run-1",
					executionId: "retired-implement",
					activationId: "activation-1",
					operationId: "land:1",
					operationGeneration: 3,
					lifecycleRevision: null,
					attributionDigest: "e".repeat(64),
					commIdentityRevision: null,
					windowIdentity: null,
					controllerGeneration: null,
					adapter: "unknown",
				},
				{ session: undefined, launchClaimState: undefined },
				{
					readCommSession: () => "absent",
					lookupTarget: () => ({ kind: "gone" }),
					listWindows: async () => ({ kind: "ok", windows: [] }),
					hasHostProcess: async () => false,
					probeCodexDaemon: async () => daemon,
				},
			);

			expect(evidence.verdict).toBe(expected);
			expect(evidence.observations.stateSession.state).toBe("absent");
			expect(evidence.observations.commSession.state).toBe("absent");
		},
	);

	it("treats a missing Codex heartbeat as stale after every physical probe proves absence", async () => {
		const evidence = await collectExecutionCloseoutEvidence(
			{
				evidenceId: "66666666-6666-4666-8666-666666666666",
				project: "flywheel",
				issueUuid: "issue-1",
				runId: "run-1",
				executionId: "retired-codex",
				activationId: "activation-1",
				operationId: "land:1",
				operationGeneration: 3,
				lifecycleRevision: 4,
				attributionDigest: "f".repeat(64),
				commIdentityRevision: null,
				windowIdentity: null,
				controllerGeneration: null,
				adapter: "codex-tmux",
			},
			{
				session: {
					status: "running",
					adapter_type: "codex-tmux",
					heartbeat_at: undefined,
					lifecycle_revision: 4,
				},
				launchClaimState: undefined,
			},
			{
				readCommSession: () => "absent",
				lookupTarget: () => ({ kind: "gone" }),
				listWindows: async () => ({ kind: "ok", windows: [] }),
				hasHostProcess: async () => false,
				probeCodexDaemonEvidence: async () => ({
					liveness: "unknown",
					ledger: "missing",
					socketLive: false,
					spawnLock: "absent",
				}),
			},
		);

		expect(evidence.observations.heartbeat).toMatchObject({
			state: "stale",
			reason: "controller_heartbeat_missing",
		});
		expect(evidence.verdict).toBe("gone");
	});

	it("treats an active launch claim as stale after its terminal session and every physical probe are gone", async () => {
		const evidence = await collectExecutionCloseoutEvidence(
			{
				evidenceId: "88888888-8888-4888-8888-888888888888",
				project: "flywheel",
				issueUuid: "issue-1",
				runId: "run-1",
				executionId: "completed-codex",
				activationId: "activation-1",
				operationId: "land:1",
				operationGeneration: 3,
				lifecycleRevision: 5,
				attributionDigest: "f".repeat(64),
				commIdentityRevision: null,
				windowIdentity: null,
				controllerGeneration: null,
				adapter: "codex-tmux",
			},
			{
				session: {
					status: "completed",
					adapter_type: "codex-tmux",
					heartbeat_at: undefined,
					lifecycle_revision: 5,
				},
				launchClaimState: "active",
			},
			{
				readCommSession: () => "absent",
				lookupTarget: () => ({ kind: "gone" }),
				listWindows: async () => ({ kind: "ok", windows: [] }),
				hasHostProcess: async () => false,
				probeCodexDaemon: async () => "absent",
			},
		);

		expect(evidence.observations.launch).toMatchObject({
			state: "not_applicable",
			reason: "terminal_session_launch_claim_stale",
		});
		expect(evidence.verdict).toBe("gone");
	});

	it("keeps closeout unknown while a missing-ledger Codex daemon has a live spawn lock", async () => {
		const evidence = await collectExecutionCloseoutEvidence(
			{
				evidenceId: "77777777-7777-4777-8777-777777777777",
				project: "flywheel",
				issueUuid: "issue-1",
				runId: "run-1",
				executionId: "starting-codex",
				activationId: "activation-1",
				operationId: "land:1",
				operationGeneration: 3,
				lifecycleRevision: 4,
				attributionDigest: "e".repeat(64),
				commIdentityRevision: null,
				windowIdentity: null,
				controllerGeneration: null,
				adapter: "codex-tmux",
			},
			{
				session: {
					status: "running",
					adapter_type: "codex-tmux",
					heartbeat_at: undefined,
					lifecycle_revision: 4,
				},
				launchClaimState: undefined,
			},
			{
				readCommSession: () => "absent",
				lookupTarget: () => ({ kind: "gone" }),
				listWindows: async () => ({ kind: "ok", windows: [] }),
				hasHostProcess: async () => false,
				probeCodexDaemonEvidence: async () => ({
					liveness: "unknown",
					ledger: "missing",
					socketLive: false,
					spawnLock: "live",
				}),
			},
		);

		expect(evidence.observations.daemon).toMatchObject({
			state: "unknown",
			reason: "codex_daemon_unknown",
		});
		expect(evidence.verdict).toBe("unknown");
	});

	it("finds every exec-marker window when the CommDB target is still pending", async () => {
		const probes: string[] = [];
		const evidence = await collectExecutionCloseoutEvidence(
			{
				evidenceId: "99999999-9999-4999-8999-999999999999",
				project: "flywheel",
				issueUuid: "issue-1",
				runId: "run-1",
				executionId: "pending-codex",
				activationId: "activation-1",
				operationId: "land:1",
				operationGeneration: 3,
				lifecycleRevision: 4,
				attributionDigest: "9".repeat(64),
				commIdentityRevision: null,
				windowIdentity: "flywheel:pending",
				controllerGeneration: null,
				adapter: "codex-tmux",
			},
			{
				session: {
					status: "running",
					adapter_type: "codex-tmux",
					heartbeat_at: undefined,
					lifecycle_revision: 4,
				},
				launchClaimState: undefined,
			},
			{
				readCommSession: () => "present",
				lookupTarget: () => ({
					kind: "found",
					target: { tmuxWindow: "flywheel:pending", sessionName: "flywheel" },
				}),
				listWindows: async () => ({
					kind: "ok",
					windows: [
						{
							windowId: "@42",
							windowName: "FLY-2662-implement",
							sessions: ["flywheel", "cmux-FLY-2662-implement"],
						},
						{
							windowId: "@43",
							windowName: "FLY-2662-watch",
							sessions: ["flywheel"],
						},
					],
				}),
				probeWindow: async (target) => {
					probes.push(target);
					return target.endsWith("@43") ? "alive" : "dead_pin";
				},
				probeHostProcess: async () => ({ verdict: "absent", source: "pgrep" }),
				probeCodexDaemon: async () => "absent",
			},
		);

		expect(probes).toEqual(["flywheel:@42", "flywheel:@43"]);
		expect(evidence.observations.window).toMatchObject({ state: "live" });
		expect(evidence.verdict).toBe("alive");
	});

	it("keeps a host sensor error unknown instead of calling it live", async () => {
		const evidence = await collectExecutionCloseoutEvidence(
			{
				evidenceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
				project: "flywheel",
				issueUuid: "issue-1",
				runId: "run-1",
				executionId: "sensor-error",
				activationId: "activation-1",
				operationId: "land:1",
				operationGeneration: 3,
				lifecycleRevision: null,
				attributionDigest: "a".repeat(64),
				commIdentityRevision: null,
				windowIdentity: null,
				controllerGeneration: null,
				adapter: "claude-tmux",
			},
			{ session: undefined, launchClaimState: undefined },
			{
				readCommSession: () => "absent",
				lookupTarget: () => ({ kind: "gone" }),
				listWindows: async () => ({ kind: "ok", windows: [] }),
				probeHostProcess: async () => ({
					verdict: "unknown",
					source: "pgrep",
					reason: "pgrep_failed:ETIMEDOUT",
				}),
			},
		);

		expect(evidence.observations.hostProcess).toMatchObject({
			state: "unknown",
			reason: "execution_process_probe_error:pgrep_failed:ETIMEDOUT",
		});
		expect(evidence.liveVetoes).not.toContainEqual(
			expect.stringContaining("hostProcess"),
		);
		expect(evidence.verdict).toBe("unknown");
	});
});
