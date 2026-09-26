import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";
import { buildWorkflowRunSnapshotV2 } from "../workflow-run-snapshot.js";

const cleanups: string[] = [];

afterEach(() => {
	for (const root of cleanups.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

const workflowEnv = {
	FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
};

function createEnrolledExecution(store: StateStore) {
	const root = mkdtempSync(join(tmpdir(), "fly2778-pre-spawn-"));
	cleanups.push(root);
	mkdirSync(join(root, "agents"));
	writeFileSync(join(root, "agents", "generic.md"), "Execute safely.\n");
	const snapshot = buildWorkflowRunSnapshotV2({
		template: { id: "tpl-fly2778", revision: 1 },
		canonicalRoot: root,
		manifest: {
			schema_version: 2,
			nodes: [
				{
					id: "implement",
					type: "generic",
					vendor: "codex",
					model: "gpt-5.6-sol",
					effort: "low",
					agent_file: "agents/generic.md",
				},
				{ id: "founder_gate", type: "gate" },
			],
			edges: [
				{
					id: "done",
					from: "implement",
					to: "founder_gate",
					condition: "node_done",
				},
			],
			loops: [],
			terminal_gate: {
				node: "founder_gate",
				predicate: "founder_approved",
			},
			ship_claims: ["founder_approved"],
		},
	});
	store.createWorkflowRun({
		runId: "run-fly2778",
		issueId: "FLY-2778",
		projectName: "flywheel",
		snapshotJson: JSON.stringify(snapshot),
		claimsReadEnrolled: false,
	});
	const admission = store.admitGeneralizedWorkflowExecution({
		runId: "run-fly2778",
		nodeId: "implement",
		executionId: "exec-fly2778",
		activationId: "activation-fly2778",
		attempt: 1,
		now: "2026-09-26T20:00:00.000Z",
		expiresAt: "2026-09-26T21:00:00.000Z",
		absoluteDeadlineAt: "2026-09-27T20:00:00.000Z",
		env: workflowEnv,
	});
	expect(admission).toMatchObject({ ok: true });
	store.upsertSession({
		execution_id: "exec-fly2778",
		issue_id: "FLY-2778",
		project_name: "flywheel",
		status: "running",
		workflow_node_id: "implement",
		session_stage: "started",
	});
	return {
		executionId: "exec-fly2778",
		activationId: "activation-fly2778",
		executionRunId: "run-fly2778",
	};
}

function typedFailure(
	executionId: string,
	activationId: string,
	sourceEventId: string,
) {
	return {
		executionId,
		sourceEventId,
		signal: "failed" as const,
		failureKind: "codex_auth_pre_spawn_failed",
		failureCode: "auth_preflight_failed",
		lastError: "Codex source auth is unavailable",
		source: "direct-event-sink",
		now: "2026-09-26T20:01:00.000Z",
		trustedPreSpawnFailure: {
			activationId,
			failureCode: "auth_preflight_failed" as const,
		},
	};
}

describe("FLY-2778 Codex pre-spawn source receipt", () => {
	it("freezes the legacy compatibility cutoff across reopen", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2778-policy-"));
		cleanups.push(root);
		const dbPath = join(root, "teamlead.db");
		const first = await StateStore.create(dbPath);
		const policy = first.getCodexPreSpawnCompatPolicy();
		expect(policy).toMatchObject({ singleton: 1 });
		first.close();

		const reopened = await StateStore.create(dbPath);
		expect(reopened.getCodexPreSpawnCompatPolicy()).toEqual(policy);
		reopened.close();
	});

	it("commits terminal event, source receipt, and teardown atomically", async () => {
		const store = await StateStore.create(":memory:");
		const { executionId, activationId, executionRunId } =
			createEnrolledExecution(store);
		const result = store.recordEnrolledTerminalSignal(
			typedFailure(executionId, activationId, "event-fly2778-live"),
		);

		expect(result).toMatchObject({
			ok: true,
			idempotentReplay: false,
			effectiveStatus: "failed",
			statusPreserved: false,
		});
		expect(store.getSession(executionId)).toMatchObject({ status: "failed" });
		expect(store.getCodexPreSpawnFailureReceipt(executionId)).toMatchObject({
			executionId,
			projectName: "flywheel",
			issueId: "FLY-2778",
			executionRunId,
			activationId,
			lifecycleRevision: 1,
			sourceEventId: "event-fly2778-live",
			failureCode: "auth_preflight_failed",
			origin: "live_preflight",
			terminalAt: "2026-09-26T20:01:00.000Z",
			invalidatedAt: null,
		});
		expect(
			store
				.listWorkflowRunEvents(executionRunId)
				.find((event) => event.kind === "generalized_teardown_recorded")
				?.payload,
		).toMatchObject({
			sourceEventId: "event-fly2778-live",
			preSpawnReceipt: { disposition: "recorded" },
		});
		store.close();
	});

	it.each([
		[
			"receipt",
			`CREATE TRIGGER fly2778_fail_receipt BEFORE INSERT ON codex_pre_spawn_failure_receipt
			 BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END`,
		],
		[
			"teardown",
			`CREATE TRIGGER fly2778_fail_teardown BEFORE INSERT ON workflow_run_event
			 WHEN NEW.kind = 'generalized_teardown_recorded'
			 BEGIN SELECT RAISE(ABORT, 'injected teardown failure'); END`,
		],
	] as const)(
		"rolls back the complete terminal write set on %s failure",
		async (_label, trigger) => {
			const store = await StateStore.create(":memory:");
			const { executionId, activationId, executionRunId } =
				createEnrolledExecution(store);
			const raw = (
				store as unknown as { db: { raw: { exec(sql: string): void } } }
			).db.raw;
			raw.exec(trigger);

			expect(() =>
				store.recordEnrolledTerminalSignal(
					typedFailure(executionId, activationId, "event-fly2778-rollback"),
				),
			).toThrow(/injected/);
			expect(store.getSession(executionId)).toMatchObject({
				status: "running",
				lifecycle_revision: 0,
			});
			expect(
				store.getEventPayloadById("event-fly2778-rollback"),
			).toBeUndefined();
			expect(store.getCodexPreSpawnFailureReceipt(executionId)).toBeUndefined();
			expect(
				store
					.listWorkflowRunEvents(executionRunId)
					.filter((event) => event.kind === "generalized_teardown_recorded"),
			).toHaveLength(0);
			store.close();
		},
	);

	it("never backfills a receipt on an idempotent terminal replay", async () => {
		const store = await StateStore.create(":memory:");
		const { executionId, activationId } = createEnrolledExecution(store);
		const ordinary = {
			...typedFailure(executionId, activationId, "event-fly2778-replay"),
			trustedPreSpawnFailure: undefined,
		};
		expect(store.recordEnrolledTerminalSignal(ordinary)).toMatchObject({
			ok: true,
			idempotentReplay: false,
		});
		expect(store.getCodexPreSpawnFailureReceipt(executionId)).toBeUndefined();

		expect(
			store.recordEnrolledTerminalSignal(
				typedFailure(executionId, activationId, "event-fly2778-replay"),
			),
		).toMatchObject({ ok: true, idempotentReplay: true });
		expect(store.getCodexPreSpawnFailureReceipt(executionId)).toBeUndefined();
		store.close();
	});

	it("keeps the terminal chain but rejects a mismatched activation", async () => {
		const store = await StateStore.create(":memory:");
		const { executionId, activationId, executionRunId } =
			createEnrolledExecution(store);
		const result = store.recordEnrolledTerminalSignal({
			...typedFailure(
				executionId,
				activationId,
				"event-fly2778-wrong-activation",
			),
			trustedPreSpawnFailure: {
				activationId: "activation-does-not-exist",
				failureCode: "auth_preflight_failed",
			},
		});

		expect(result).toMatchObject({ ok: true, idempotentReplay: false });
		expect(store.getSession(executionId)?.status).toBe("failed");
		expect(store.getCodexPreSpawnFailureReceipt(executionId)).toBeUndefined();
		expect(
			store
				.listWorkflowRunEvents(executionRunId)
				.find((event) => event.kind === "generalized_teardown_recorded")
				?.payload,
		).toMatchObject({
			preSpawnReceipt: {
				disposition: "skipped",
				reason: "activation_mismatch",
			},
		});
		store.close();
	});

	it.each(["launch_claim", "launch_owner"] as const)(
		"invalidates a valid receipt atomically at a new %s entrance",
		async (entrance) => {
			const store = await StateStore.create(":memory:");
			const { executionId, activationId } = createEnrolledExecution(store);
			expect(
				store.recordEnrolledTerminalSignal(
					typedFailure(executionId, activationId, "event-fly2778-invalidate"),
				),
			).toMatchObject({ ok: true });
			expect(store.getCodexPreSpawnFailureReceipt(executionId)).toBeDefined();

			if (entrance === "launch_claim") {
				store.insertLaunchClaim({
					executionId,
					rootUuid: "FLY-2778",
					project: "flywheel",
					role: "implement",
				});
			} else {
				const root = mkdtempSync(join(tmpdir(), "fly2778-marker-"));
				cleanups.push(root);
				expect(
					store.recoverOrAcquireWorkflowLaunch({
						executionId,
						ownerId: "owner-2",
						now: "2026-09-26T20:03:00.000Z",
						leaseExpiresAt: "2026-09-26T20:04:00.000Z",
						markerPath: join(root, "missing-marker.json"),
					}),
				).toMatchObject({ status: "acquired", generation: 1 });
			}

			expect(store.getCodexPreSpawnFailureReceipt(executionId)).toBeUndefined();
			expect(store.getCodexPreSpawnFailureReceipts(executionId)).toMatchObject([
				{
					sourceEventId: "event-fly2778-invalidate",
					invalidatedAt: expect.any(String),
				},
			]);
			store.close();
		},
	);
});
