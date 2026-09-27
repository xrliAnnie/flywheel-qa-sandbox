import { WORKFLOW_TRANSITIONS, WorkflowFSM } from "flywheel-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplyTransitionOpts } from "../../applyTransition.js";
import { StateStore } from "../../StateStore.js";
import {
	closeoutIssue,
	createIssueMutex,
	type LifecycleCloseoutDeps,
} from "../lifecycle-closeout.js";

const ISSUE = "11111111-1111-4111-8111-111111111111";
const stores: StateStore[] = [];

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});

function observation(verdict: "alive" | "dead" | "unknown") {
	const observedAt = Date.now();
	return {
		identity: {
			executionId: "exec-1",
			activationId: null,
			generation: 1,
			lifecycleRevision: 0,
			adapter: "codex-tmux" as const,
		},
		ownerToken: "owner-1",
		spawnEpoch: 1,
		verdict,
		observedAt: new Date(observedAt).toISOString(),
		expiresAt: new Date(observedAt + 10_000).toISOString(),
		bindingDigest: "a".repeat(64),
		reason: `${verdict}_fixture`,
	};
}

function neverStartedObservation() {
	const observedAt = Date.now();
	return {
		identity: {
			executionId: "exec-1",
			activationId: "activation-1",
			generation: 1,
			lifecycleRevision: 0,
			adapter: "codex-tmux" as const,
		},
		source: {
			origin: "live_preflight" as const,
			projectName: "proj",
			issueId: ISSUE,
			executionRunId: "run-1",
			sourceEventId: "event-1",
			proofDigest: "b".repeat(64),
			launchClaimState: "closed" as const,
			daemonLedger: "missing" as const,
			daemonLedgerShape: "missing" as const,
		},
		ownership: {
			state: "absent" as "absent" | "unknown",
			spawnInflight: false as false | null,
			restartInProgress: false as false | null,
			censusDigest: "c".repeat(64),
		},
		socket: {
			state: "absent" as "absent" | "unknown",
			evidenceDigest: "d".repeat(64),
		},
		lock: {
			state: "absent" as "absent" | "unknown",
			evidenceDigest: "e".repeat(64),
		},
		verdict: "dead" as const,
		observedAt: new Date(observedAt).toISOString(),
		expiresAt: new Date(observedAt + 10_000).toISOString(),
		bindingDigest: "f".repeat(64),
		reason: "trusted_pre_spawn_body_absent",
	};
}

async function fixture(verdicts: Array<"alive" | "dead" | "unknown">) {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	const now = Date.now();
	store.upsertSession({
		execution_id: "exec-1",
		issue_id: ISSUE,
		issue_identifier: "FLY-2778",
		project_name: "proj",
		status: "failed",
		adapter_type: "codex-tmux",
	});
	const operation = store.ensureLandOperation({
		issueId: ISSUE,
		projectName: "proj",
		prNumber: 2778,
		approvedHead: "b".repeat(40),
		now: new Date(now - 60_000).toISOString(),
	});
	const claim = store.claimLandOperation({
		operationId: operation.operation_id,
		ownerId: "land-worker",
		now: new Date(now).toISOString(),
		leaseExpiresAt: new Date(now + 60 * 60_000).toISOString(),
	});
	expect(claim).toBeDefined();
	const closeRunnerFn = vi.fn(async () => ({
		closed: false,
		commDbFinalized: false,
		retiredGateCount: 0,
		preserved: true,
		reason: "crash_preserve" as const,
	}));
	const observe = vi.fn(async () => observation(verdicts.shift() ?? "unknown"));
	const collectCloseoutEvidenceFn = vi.fn(
		async (
			identity: Record<string, unknown>,
			facts: Record<string, unknown>,
		) => {
			const body = facts.bodyObservation as
				| ReturnType<typeof observation>
				| undefined;
			return {
				...identity,
				version: 2 as const,
				observedAt: body?.observedAt ?? new Date(now).toISOString(),
				expiresAt: body?.expiresAt ?? new Date(now + 60_000).toISOString(),
				observations: {},
				negativeReasons:
					!body || body.verdict === "dead"
						? [body ? `body:${body.reason}` : "legacy:close_runner"]
						: [],
				liveVetoes: body?.verdict === "alive" ? [`body:${body.reason}`] : [],
				unknownReasons:
					body?.verdict === "unknown" ? [`body:${body.reason}`] : [],
				commIdentityRevision: "c".repeat(64),
				...(body ? { bodyObservation: body } : {}),
				verdict:
					!body || body.verdict === "dead"
						? ("gone" as const)
						: body.verdict === "alive"
							? ("alive" as const)
							: ("unknown" as const),
			};
		},
	);
	const transitionOpts: ApplyTransitionOpts = {
		store,
		fsm: new WorkflowFSM(WORKFLOW_TRANSITIONS),
	};
	const deps: LifecycleCloseoutDeps = {
		store,
		transitionOpts,
		withIssueMutex: createIssueMutex(),
		closeRunnerFn: closeRunnerFn as never,
		lookupTarget: (() => ({ kind: "gone" }) as const) as never,
		probeLiveness: async () => "absent",
		// The shared observer must suppress this legacy authorization path.
		probeExecutionLiveness: vi.fn(async () => "dead" as const),
		bodyObserver: {
			observe,
			isCurrent: () => true,
		},
		collectCloseoutEvidenceFn: collectCloseoutEvidenceFn as never,
		log: () => undefined,
	};
	const input = {
		issueKey: ISSUE,
		projectName: "proj",
		disposition: "shipped" as const,
		authority: "ship_complete" as const,
		landOperation: {
			operationId: operation.operation_id,
			ownerId: claim!.ownerId,
			generation: claim!.generation,
		},
		deferRecordFinalization: true,
	};
	return {
		store,
		deps,
		input,
		closeRunnerFn,
		observe,
		collectCloseoutEvidenceFn,
	};
}

describe("FLY-2778 shared BodyObservation closeout seam", () => {
	it.each([
		["closed", { closed: true }],
		["already gone", { closed: false, alreadyGone: true }],
	] as const)(
		"keeps legacy %s closeout authoritative when no provider is loaded",
		async (_name, result) => {
			const f = await fixture([]);
			delete f.deps.bodyObserver;
			f.closeRunnerFn.mockResolvedValue({
				...result,
				commDbFinalized: false,
				retiredGateCount: 0,
			});

			const report = await closeoutIssue(f.deps, f.input);

			expect(report.outcome).toBe("complete");
			expect(report.nodes[0]).toMatchObject({ confirmedGone: true });
			expect(f.closeRunnerFn).toHaveBeenCalledOnce();
		},
	);

	it("accepts a current never-started closure without entering the signal path", async () => {
		const f = await fixture([]);
		vi.spyOn(f.store, "getWorkflowExecutionBinding").mockReturnValue({
			activation_id: "activation-1",
			run_id: "run-1",
		} as never);
		const observeNeverStarted = vi.fn(async () => neverStartedObservation());
		f.deps.bodyObserver!.observe = vi.fn(async () => undefined);
		f.deps.bodyObserver!.observeNeverStarted = observeNeverStarted;
		f.deps.bodyObserver!.isCurrentNeverStarted = () => true;

		const report = await closeoutIssue(f.deps, f.input);

		expect(report.outcome).toBe("complete");
		expect(report.nodes[0]).toMatchObject({
			confirmedGone: true,
			communicationsFinalized: true,
			evidenceVerdict: "gone",
		});
		expect(observeNeverStarted).toHaveBeenCalledWith("exec-1");
		expect(f.closeRunnerFn).not.toHaveBeenCalled();
	});

	it.each([
		[
			"source",
			(value: ReturnType<typeof neverStartedObservation>) => {
				value.source.proofDigest = "";
			},
		],
		[
			"ownership",
			(value: ReturnType<typeof neverStartedObservation>) => {
				value.ownership.state = "unknown";
			},
		],
		[
			"socket",
			(value: ReturnType<typeof neverStartedObservation>) => {
				value.socket.state = "unknown";
			},
		],
		[
			"lock",
			(value: ReturnType<typeof neverStartedObservation>) => {
				value.lock.state = "unknown";
			},
		],
	] as const)(
		"refuses a never-started closure missing %s proof",
		async (_name, mutate) => {
			const f = await fixture([]);
			vi.spyOn(f.store, "getWorkflowExecutionBinding").mockReturnValue({
				activation_id: "activation-1",
				run_id: "run-1",
			} as never);
			const value = neverStartedObservation();
			mutate(value);
			f.deps.bodyObserver!.observe = vi.fn(async () => undefined);
			f.deps.bodyObserver!.observeNeverStarted = vi.fn(async () => value);
			f.deps.bodyObserver!.isCurrentNeverStarted = () => true;

			const report = await closeoutIssue(f.deps, f.input);

			expect(report.outcome).toBe("blocked");
			expect(report.nodes[0]).toMatchObject({ confirmedGone: false });
			expect(f.collectCloseoutEvidenceFn).not.toHaveBeenCalled();
		},
	);

	it("uses current dead evidence before any closeRunner signal path", async () => {
		const f = await fixture(["dead"]);
		const report = await closeoutIssue(f.deps, f.input);

		expect(report.outcome).toBe("complete");
		expect(report.nodes[0]).toMatchObject({
			confirmedGone: true,
			communicationsFinalized: true,
			evidenceVerdict: "gone",
		});
		expect(f.closeRunnerFn).not.toHaveBeenCalled();
		expect(f.collectCloseoutEvidenceFn).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				bodyObservation: expect.objectContaining({ verdict: "dead" }),
			}),
		);
	});

	it("re-observes after closing an alive body and accepts only the fresh dead proof", async () => {
		const f = await fixture(["alive", "dead"]);
		const report = await closeoutIssue(f.deps, f.input);

		expect(report.outcome).toBe("complete");
		expect(f.closeRunnerFn).toHaveBeenCalledOnce();
		expect(f.observe).toHaveBeenCalledTimes(2);
		expect(report.nodes[0]).toMatchObject({ confirmedGone: true });
	});

	it("keeps unknown fail-closed and never falls back to the legacy dead probe", async () => {
		const f = await fixture(["unknown", "unknown"]);
		const report = await closeoutIssue(f.deps, f.input);

		expect(report.outcome).toBe("blocked");
		expect(report.nodes[0]).toMatchObject({ confirmedGone: false });
		expect(f.deps.probeExecutionLiveness).not.toHaveBeenCalled();
		expect(f.collectCloseoutEvidenceFn).not.toHaveBeenCalled();
	});

	it("rejects a dead observation when the synchronous owner/epoch check changed", async () => {
		const f = await fixture(["dead", "dead"]);
		f.deps.bodyObserver!.isCurrent = () => false;
		const report = await closeoutIssue(f.deps, f.input);

		expect(report.outcome).toBe("blocked");
		expect(f.closeRunnerFn).toHaveBeenCalledOnce();
		expect(f.deps.probeExecutionLiveness).not.toHaveBeenCalled();
		expect(f.collectCloseoutEvidenceFn).not.toHaveBeenCalled();
	});
});
