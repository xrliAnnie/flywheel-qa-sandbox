import { describe, expect, it, vi } from "vitest";
import type {
	LandOperationClaim,
	LandOperationRow,
	Session,
} from "../../StateStore.js";
import {
	evaluateShippedHuskEvidence,
	forceShippedHusks,
	shippedHuskForceEnabled,
} from "../shipped-husk-escalation.js";

const NOW = Date.parse("2026-08-22T18:00:00.000Z");

function session(overrides: Partial<Session> = {}): Session {
	return {
		execution_id: "implement-1",
		issue_id: "issue-1",
		project_name: "flywheel",
		status: "awaiting_review",
		adapter_type: "codex-tmux",
		chat_thread_role: "implement",
		heartbeat_at: "2026-08-22 17:50:00",
		...overrides,
	};
}

function operation(
	overrides: Partial<LandOperationRow> = {},
): LandOperationRow {
	return {
		operation_id: "land-1",
		run_id: "run-1",
		issue_id: "issue-1",
		project_name: "flywheel",
		pr_number: 923,
		approved_head: "a".repeat(40),
		state: "running",
		owner_id: "land-worker",
		lease_expires_at: "2026-08-22T18:10:00.000Z",
		generation: 4,
		ship_attempt: 0,
		resume_generation: 0,
		current_step: "cleanup_requested",
		merge_confirmed_at: "2026-08-22T17:40:00.000Z",
		finalization_completed_at: null,
		retry_count: 1,
		retry_epoch_key: "4:cleanup_requested",
		next_attempt_at: null,
		carryover_receipt_id: null,
		superseded_at: null,
		superseded_by_operation_id: null,
		linear_done_disposition: null,
		linear_done_deferred_at: null,
		linear_done_settled_at: null,
		linear_done_last_reason: null,
		linear_done_retry_count: 0,
		linear_done_next_attempt_at: null,
		linear_done_last_attempt_at: null,
		last_error: "issue_closeout_incomplete",
		created_at: "2026-08-22T17:40:00.000Z",
		updated_at: "2026-08-22T17:50:00.000Z",
		...overrides,
	};
}

const CLAIM: LandOperationClaim = {
	operationId: "land-1",
	ownerId: "land-worker",
	generation: 4,
};

function eligibleInput() {
	return {
		session: session(),
		issueId: "issue-1",
		nowMs: NOW,
		pane: { kind: "alive" as const, tmuxWindow: "flywheel:@1" },
		control: {
			execution_id: "implement-1",
			request_id: "land-1:implement-1",
			state: "requested" as const,
			requested_at: NOW - 60_000,
			finished_at: null,
			error: null,
		},
		operation: operation(),
		claim: CLAIM,
		currentRetryEpochKey: "4:cleanup_requested",
		runIsLandTerminal: true,
		sessionBelongsToRun: true,
	};
}

describe("shipped husk evidence", () => {
	it("requires the complete shipped-terminal evidence set", () => {
		expect(evaluateShippedHuskEvidence(eligibleInput())).toMatchObject({
			eligible: true,
			tmuxWindow: "flywheel:@1",
		});
	});

	it("applies the same evidence gates to every workflow-node adapter", () => {
		expect(
			evaluateShippedHuskEvidence({
				...eligibleInput(),
				session: session({ adapter_type: "claude-tmux" }),
			}),
		).toMatchObject({ eligible: true });
		expect(
			evaluateShippedHuskEvidence({
				...eligibleInput(),
				session: session({ adapter_type: "future-runner" }),
			}),
		).toMatchObject({ eligible: true });
	});

	it("does not mistake a Bridge-refreshed heartbeat for runner activity", () => {
		expect(
			evaluateShippedHuskEvidence({
				...eligibleInput(),
				session: session({ heartbeat_at: "2026-08-22 18:00:00" }),
			}),
		).toMatchObject({ eligible: true });
	});

	it.each([
		["non-phase", { session: session({ chat_thread_role: "main" }) }],
		["wrong issue", { session: session({ issue_id: "issue-2" }) }],
		["pane gone", { pane: { kind: "gone" as const } }],
		["pane indeterminate", { pane: { kind: "indeterminate" as const } }],
		["missing control", { control: null }],
		[
			"acked control",
			{ control: { ...eligibleInput().control, state: "acked" as const } },
		],
		[
			"failed control",
			{ control: { ...eligibleInput().control, state: "failed" as const } },
		],
		[
			"young control",
			{ control: { ...eligibleInput().control, requested_at: NOW - 1_000 } },
		],
		["first closeout pass", { operation: operation({ retry_count: 0 }) }],
		[
			"old retry epoch",
			{ operation: operation({ retry_epoch_key: "3:merge_confirmed" }) },
		],
		[
			"superseded",
			{ operation: operation({ superseded_at: "2026-08-22T17:55:00.000Z" }) },
		],
		["wrong generation", { operation: operation({ generation: 5 }) }],
		[
			"merge unconfirmed",
			{ operation: operation({ merge_confirmed_at: null }) },
		],
		["run left land", { runIsLandTerminal: false }],
		["session belongs to another run", { sessionBelongsToRun: false }],
	] as const)("refuses %s", (_label, override) => {
		expect(
			evaluateShippedHuskEvidence({ ...eligibleInput(), ...override }),
		).toMatchObject({ eligible: false });
	});

	it("accepts an older pending request but never an older ack", () => {
		const oldPending = eligibleInput();
		oldPending.control.request_id = "older-operation:implement-1";
		expect(evaluateShippedHuskEvidence(oldPending).eligible).toBe(true);
		expect(
			evaluateShippedHuskEvidence({
				...oldPending,
				control: { ...oldPending.control, state: "acked" },
			}).eligible,
		).toBe(false);
	});

	it("observes the default-on kill switch at call time", () => {
		expect(shippedHuskForceEnabled({})).toBe(true);
		expect(shippedHuskForceEnabled({ FLYWHEEL_SHIPPED_HUSK_FORCE: "0" })).toBe(
			false,
		);
		expect(shippedHuskForceEnabled({ FLYWHEEL_SHIPPED_HUSK_FORCE: "1" })).toBe(
			true,
		);
	});
});

describe("forceShippedHusks", () => {
	async function persistedFixture() {
		const { StateStore } = await import("../../StateStore.js");
		const store = await StateStore.create(":memory:");
		store.upsertSession(session());
		store.patchSessionMetadata("implement-1", {
			adapter_type: "codex-tmux",
			chat_thread_role: "implement",
			heartbeat_at: "2026-08-22 17:50:00",
		});
		const operation = store.ensureLandOperation({
			issueId: "issue-1",
			projectName: "flywheel",
			prNumber: 923,
			approvedHead: "a".repeat(40),
			now: "2026-08-22T17:40:00.000Z",
		});
		const firstClaim = store.claimLandOperation({
			operationId: operation.operation_id,
			ownerId: "first-pass",
			now: "2026-08-22T17:40:01.000Z",
			leaseExpiresAt: "2026-08-22T17:50:01.000Z",
		})!;
		for (const step of ["merge_confirmed", "cleanup_requested"]) {
			expect(
				store.recordLandOperationStep({
					operationId: operation.operation_id,
					ownerId: firstClaim.ownerId,
					generation: firstClaim.generation,
					step,
					receipt: { step },
					now: "2026-08-22T17:40:02.000Z",
				}),
			).toMatchObject({ ok: true });
		}
		store.releaseLandOperationWithRetryAccounting({
			operationId: operation.operation_id,
			ownerId: firstClaim.ownerId,
			generation: firstClaim.generation,
			class: "retryable",
			reason: "issue_closeout_incomplete",
			now: "2026-08-22T17:40:03.000Z",
		});
		store.makeLandOperationRetryRunnable(operation.operation_id);
		const claim = store.claimLandOperation({
			operationId: operation.operation_id,
			ownerId: "second-pass",
			now: "2026-08-22T17:59:00.000Z",
			leaseExpiresAt: "2026-08-22T18:10:00.000Z",
		})!;
		return { store, operationId: operation.operation_id, claim };
	}

	function shutdownDb() {
		return {
			getRunnerShutdown: vi.fn(() => ({
				execution_id: "implement-1",
				request_id: "older-land:implement-1",
				state: "requested" as const,
				requested_at: NOW - 60_000,
				finished_at: null,
				error: null,
			})),
			close: vi.fn(),
		};
	}

	it("uses strict window cleanup without signalling execution-tagged process groups", async () => {
		const { store, operationId, claim } = await persistedFixture();
		const order: string[] = [];
		const cleanupTarget = vi.fn(async (input) => {
			order.push("window");
			expect(input.strict.expectedExecutionId).toBe("implement-1");
			expect(await input.strict.authorityCheck()).toBe(true);
			return { tmuxClosed: true, physicalGone: true, errors: [] };
		});
		const result = await forceShippedHusks(
			{ issueId: "issue-1", projectName: "flywheel", operationId, claim },
			store,
			{
				now: () => NOW,
				resolveCommDbPath: () => "/tmp/comm.db",
				openCommDb: shutdownDb,
				lookupTarget: () => ({
					kind: "found",
					target: { tmuxWindow: "flywheel:@1", sessionName: "flywheel" },
				}),
				probe: async () => "alive",
				runIsLandTerminal: () => true,
				sessionBelongsToRun: () => true,
				cleanupTarget,
			},
		);

		expect(order).toEqual(["window"]);
		expect(result).toMatchObject({ cleared: ["implement-1"] });
		expect(
			store
				.listLandOperationSteps(operationId)
				.find((step) =>
					step.step.startsWith("aux:husk_force_cleared:implement-1:"),
				),
		).toBeDefined();
		expect(store.getLandOperation(operationId)).toMatchObject({
			current_step: "cleanup_requested",
			retry_count: 1,
			retry_epoch_key: "2:cleanup_requested",
		});
		expect(store.getEventsByExecution("implement-1")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ event_type: "shipped_husk_force_started" }),
				expect.objectContaining({ event_type: "shipped_husk_force_reaped" }),
			]),
		);
		store.close();
	});

	it("terminalizes an older open intent after the window is already gone", async () => {
		const { store, operationId, claim } = await persistedFixture();
		const intentId = `shipped-husk-force:${operationId}:${claim.generation - 1}:implement-1:recover-me`;
		store.insertEvent({
			event_id: `${intentId}:shipped_husk_force_started`,
			execution_id: "implement-1",
			issue_id: "issue-1",
			project_name: "flywheel",
			event_type: "shipped_husk_force_started",
			source: "bridge.shipped-husk-force",
			payload: { intentId, tmuxWindow: "flywheel:@1" },
		});

		const result = await forceShippedHusks(
			{ issueId: "issue-1", projectName: "flywheel", operationId, claim },
			store,
			{
				now: () => NOW,
				resolveCommDbPath: () => undefined,
				lookupTarget: () => ({
					kind: "found",
					target: { tmuxWindow: "flywheel:@1", sessionName: "flywheel" },
				}),
				probe: async () => "absent",
				runIsLandTerminal: () => true,
				sessionBelongsToRun: () => true,
				cleanupTarget: vi.fn(),
			},
		);

		expect(result.cleared).toEqual([]);
		expect(
			store
				.listLandOperationSteps(operationId)
				.some((step) => step.step.startsWith("aux:husk_force_cleared:")),
		).toBe(false);
		expect(store.getEventsByExecution("implement-1")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					event_type: "shipped_husk_force_aborted",
					payload: expect.objectContaining({
						intentId,
						reason: "window_gone_after_force_intent",
					}),
				}),
			]),
		);
		store.close();
	});

	it("creates a new intent when the same execution later re-wedges", async () => {
		const { store, operationId, claim } = await persistedFixture();
		let tmuxWindow = "flywheel:@1";
		let requestId = "request-1";
		const db = shutdownDb();
		db.getRunnerShutdown.mockImplementation(() => ({
			execution_id: "implement-1",
			request_id: requestId,
			state: "requested",
			requested_at: NOW - 60_000,
			finished_at: null,
			error: null,
		}));
		const deps = {
			now: () => NOW,
			resolveCommDbPath: () => "/tmp/comm.db",
			openCommDb: () => db,
			lookupTarget: () => ({
				kind: "found" as const,
				target: { tmuxWindow, sessionName: "flywheel" },
			}),
			probe: async () => "alive" as const,
			runIsLandTerminal: () => true,
			sessionBelongsToRun: () => true,
			cleanupTarget: async () => ({
				tmuxClosed: true,
				physicalGone: true,
				errors: [],
			}),
		};

		await forceShippedHusks(
			{ issueId: "issue-1", projectName: "flywheel", operationId, claim },
			store,
			deps,
		);
		tmuxWindow = "flywheel:@2";
		requestId = "request-2";
		store.patchSessionMetadata("implement-1", {
			heartbeat_at: "2026-08-22 17:49:00",
		});
		await forceShippedHusks(
			{ issueId: "issue-1", projectName: "flywheel", operationId, claim },
			store,
			deps,
		);

		expect(
			store
				.listLandOperationSteps(operationId)
				.filter((step) => step.step.startsWith("aux:husk_force_cleared:")),
		).toHaveLength(2);
		const intents = store
			.getEventsByExecution("implement-1")
			.filter((entry) => entry.event_type === "shipped_husk_force_started")
			.map((entry) => (entry.payload as { intentId: string }).intentId);
		expect(new Set(intents).size).toBe(2);
		store.close();
	});

	it("does not reuse a terminal force intent after a released retry", async () => {
		const { store, operationId, claim } = await persistedFixture();
		const deps = {
			now: () => NOW,
			resolveCommDbPath: () => "/tmp/comm.db",
			openCommDb: shutdownDb,
			lookupTarget: () => ({
				kind: "found" as const,
				target: { tmuxWindow: "flywheel:@1", sessionName: "flywheel" },
			}),
			probe: async () => "alive" as const,
			runIsLandTerminal: () => true,
			sessionBelongsToRun: () => true,
			cleanupTarget: async () => ({
				tmuxClosed: false,
				physicalGone: false,
				errors: ["still alive"],
			}),
		};

		expect(
			await forceShippedHusks(
				{ issueId: "issue-1", projectName: "flywheel", operationId, claim },
				store,
				deps,
			),
		).toMatchObject({ cause: "window_cleanup_failed" });
		expect(
			await forceShippedHusks(
				{ issueId: "issue-1", projectName: "flywheel", operationId, claim },
				store,
				deps,
			),
		).toEqual({ cleared: [] });
		store.releaseLandOperationWithRetryAccounting({
			operationId,
			ownerId: claim.ownerId,
			generation: claim.generation,
			class: "retryable",
			reason: "issue_closeout_incomplete",
			now: "2026-08-22T18:00:01.000Z",
		});
		store.makeLandOperationRetryRunnable(operationId);
		const nextClaim = store.claimLandOperation({
			operationId,
			ownerId: "third-pass",
			now: "2026-08-22T18:00:02.000Z",
			leaseExpiresAt: "2026-08-22T18:10:00.000Z",
		})!;
		expect(
			await forceShippedHusks(
				{
					issueId: "issue-1",
					projectName: "flywheel",
					operationId,
					claim: nextClaim,
				},
				store,
				deps,
			),
		).toMatchObject({ cause: "window_cleanup_failed" });

		const events = store.getEventsByExecution("implement-1");
		const started = events
			.filter((entry) => entry.event_type === "shipped_husk_force_started")
			.map((entry) => (entry.payload as { intentId: string }).intentId);
		expect(new Set(started).size).toBe(2);
		expect(
			events.filter(
				(entry) => entry.event_type === "shipped_husk_force_failed",
			),
		).toHaveLength(2);
		store.close();
	});

	it("does no evidence reads or effects when the kill switch is off", async () => {
		const { store, operationId, claim } = await persistedFixture();
		const lookupTarget = vi.fn();
		expect(
			await forceShippedHusks(
				{ issueId: "issue-1", projectName: "flywheel", operationId, claim },
				store,
				{ forceEnabled: () => false, lookupTarget },
			),
		).toEqual({ cleared: [] });
		expect(lookupTarget).not.toHaveBeenCalled();
		store.close();
	});
});
