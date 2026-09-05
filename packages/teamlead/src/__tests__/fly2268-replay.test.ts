import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { RESIDENT_GRACE_MS } from "../bridge/resident-hold.js";
import { StateStore } from "../StateStore.js";

const T0 = Date.parse("2026-09-04T00:00:00.000Z");

function rawDb(store: StateStore): Database.Database {
	return (store as unknown as { db: { raw: Database.Database } }).db.raw;
}

async function residentStore(
	options: { withSession?: boolean } = {},
): Promise<StateStore> {
	const store = await StateStore.create(":memory:");
	store.createWorkflowRun({
		runId: "run-1",
		issueId: "FLY-2268",
		projectName: "flywheel",
		claimsReadEnrolled: false,
	});
	const admitted = store.admitWorkflowExecution({
		runId: "run-1",
		nodeId: "repair-any-name",
		executionId: "exec-1",
		attempt: 1,
		family: "review_verdict",
		expiresAt: "2026-09-04T01:00:00.000Z",
		absoluteDeadlineAt: "2026-09-04T02:00:00.000Z",
		now: "2026-09-04T00:00:00.000Z",
	});
	if (!admitted.ok) throw new Error(admitted.reason);
	if (options.withSession !== false) {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "FLY-2268",
			project_name: "flywheel",
			status: "running",
			adapter_type: "codex-tmux",
		});
	}
	return store;
}

describe("FLY-2268 resident hold replay", () => {
	let store: StateStore | undefined;
	afterEach(() => store?.close());

	it("enters revision one with the fixed grace and idempotently adopts it", async () => {
		store = await residentStore();
		const input = {
			executionId: "exec-1",
			activationId: "activation:exec-1:run-1:repair-any-name:1",
			nodeId: "repair-any-name",
			boundarySeq: 1,
			nowMs: T0,
		};
		const first = store.enterResidentHold(input);
		expect(first).toMatchObject({ ok: true, revision: 1 });
		if (!first.ok) return;
		expect(Date.parse(first.graceExpiresAt) - T0).toBe(RESIDENT_GRACE_MS);
		expect(store.enterResidentHold(input)).toEqual(first);
	});

	it("wakes by exact revision and re-enters at the next boundary with revision two", async () => {
		store = await residentStore();
		const first = store.enterResidentHold({
			executionId: "exec-1",
			activationId: "activation:exec-1:run-1:repair-any-name:1",
			nodeId: "repair-any-name",
			boundarySeq: 1,
			nowMs: T0,
		});
		if (!first.ok) throw new Error(first.reason);
		expect(store.wakeResidentHold("exec-1", first.revision, T0 + 1)).toBe(true);
		expect(store.wakeResidentHold("exec-1", first.revision, T0 + 2)).toBe(
			false,
		);

		const second = store.enterResidentHold({
			executionId: "exec-1",
			activationId: "activation:exec-1:run-1:repair-any-name:1",
			nodeId: "repair-any-name",
			boundarySeq: 2,
			nowMs: T0 + 3,
		});
		expect(second).toMatchObject({ ok: true, revision: 2 });
		if (!second.ok) throw new Error(second.reason);
		expect(Date.parse(second.graceExpiresAt) - (T0 + 3)).toBe(
			RESIDENT_GRACE_MS,
		);
	});

	it("rejects stale activation and boundary replays without mutating the hold", async () => {
		store = await residentStore();
		const first = store.enterResidentHold({
			executionId: "exec-1",
			activationId: "activation:exec-1:run-1:repair-any-name:1",
			nodeId: "repair-any-name",
			boundarySeq: 1,
			nowMs: T0,
		});
		if (!first.ok) throw new Error(first.reason);

		expect(
			store.enterResidentHold({
				executionId: "exec-1",
				activationId: "wrong",
				nodeId: "repair-any-name",
				boundarySeq: 2,
				nowMs: T0 + 1,
			}),
		).toEqual({ ok: false, reason: "activation_mismatch" });
		expect(store.getResidentHold("exec-1")).toMatchObject({
			revision: 1,
			state: "resident",
		});
	});

	it("rejects a hold when the runtime vendor binding is absent", async () => {
		store = await residentStore({ withSession: false });

		expect(
			store.enterResidentHold({
				executionId: "exec-1",
				activationId: "activation:exec-1:run-1:repair-any-name:1",
				nodeId: "repair-any-name",
				boundarySeq: 1,
				nowMs: T0,
			}),
		).toEqual({ ok: false, reason: "invalid_input" });
		expect(store.getResidentHold("exec-1")).toBeUndefined();
	});

	it("closes only the current resident revision", async () => {
		store = await residentStore();
		const entered = store.enterResidentHold({
			executionId: "exec-1",
			activationId: "activation:exec-1:run-1:repair-any-name:1",
			nodeId: "repair-any-name",
			boundarySeq: 1,
			nowMs: T0,
		});
		if (!entered.ok) throw new Error(entered.reason);

		expect(
			store.closeResidentHold({
				executionId: "exec-1",
				revision: entered.revision + 1,
				reason: "local_hold_failed",
				nowMs: T0 + 1,
			}),
		).toBe(false);
		expect(
			store.closeResidentHold({
				executionId: "exec-1",
				revision: entered.revision,
				reason: "local_hold_failed",
				nowMs: T0 + 2,
			}),
		).toBe(true);
		expect(store.getResidentHold("exec-1")).toMatchObject({
			state: "closed",
			closed_reason: "local_hold_failed",
		});
		expect(
			store.closeResidentHold({
				executionId: "exec-1",
				revision: entered.revision,
				reason: "terminal",
				nowMs: T0 + 3,
			}),
		).toBe(false);
	});

	it("closes a woken revision when its active lifecycle terminates", async () => {
		store = await residentStore();
		const entered = store.enterResidentHold({
			executionId: "exec-1",
			activationId: "activation:exec-1:run-1:repair-any-name:1",
			nodeId: "repair-any-name",
			boundarySeq: 1,
			nowMs: T0,
		});
		if (!entered.ok) throw new Error(entered.reason);
		expect(store.wakeResidentHold("exec-1", entered.revision, T0 + 1)).toBe(
			true,
		);

		expect(
			store.closeResidentHold({
				executionId: "exec-1",
				revision: entered.revision,
				reason: "run_terminated",
				nowMs: T0 + 2,
			}),
		).toBe(true);
		expect(store.getResidentHold("exec-1")).toMatchObject({
			state: "closed",
			closed_reason: "run_terminated",
		});
	});

	it("atomically stages one deterministic expiry only after the grace deadline", async () => {
		store = await residentStore();
		const entered = store.enterResidentHold({
			executionId: "exec-1",
			activationId: "activation:exec-1:run-1:repair-any-name:1",
			nodeId: "repair-any-name",
			boundarySeq: 1,
			nowMs: T0,
		});
		if (!entered.ok) throw new Error(entered.reason);

		expect(
			store.expireResidentHoldsTx(
				new Date(T0 + RESIDENT_GRACE_MS).toISOString(),
			),
		).toEqual([]);
		expect(store.getResidentHold("exec-1")?.state).toBe("resident");

		const requestId = "resident-expiry:exec-1:r1";
		expect(
			store.expireResidentHoldsTx(
				new Date(T0 + RESIDENT_GRACE_MS + 1).toISOString(),
			),
		).toEqual([requestId]);
		expect(store.getResidentHold("exec-1")?.state).toBe("expired");
		expect(store.listPendingResidentExpiryOperations()).toEqual([
			expect.objectContaining({
				operationId: requestId,
				executionId: "exec-1",
				runId: "run-1",
				activationId: "activation:exec-1:run-1:repair-any-name:1",
				nodeId: "repair-any-name",
				attempt: 1,
				revision: 1,
				vendor: "codex",
				state: "staged",
			}),
		]);
		expect(
			store.expireResidentHoldsTx(
				new Date(T0 + RESIDENT_GRACE_MS + 2).toISOString(),
			),
		).toEqual([]);
		expect(store.listPendingResidentExpiryOperations()).toHaveLength(1);
	});

	it("does not expire a live woken hold while its actor is still active", async () => {
		store = await residentStore();
		const entered = store.enterResidentHold({
			executionId: "exec-1",
			activationId: "activation:exec-1:run-1:repair-any-name:1",
			nodeId: "repair-any-name",
			boundarySeq: 1,
			nowMs: T0,
		});
		if (!entered.ok) throw new Error(entered.reason);
		expect(store.wakeResidentHold("exec-1", entered.revision, T0 + 1)).toBe(
			true,
		);

		expect(
			store.expireResidentHoldsTx(
				new Date(T0 + RESIDENT_GRACE_MS + 1).toISOString(),
			),
		).toEqual([]);
		expect(store.getResidentHold("exec-1")?.state).toBe("woken");
		expect(store.listPendingResidentExpiryOperations()).toEqual([]);
	});

	it.each(["completed", "failed"])(
		"closes a woken hold when its actor becomes %s",
		async (status) => {
			store = await residentStore();
			const entered = store.enterResidentHold({
				executionId: "exec-1",
				activationId: "activation:exec-1:run-1:repair-any-name:1",
				nodeId: "repair-any-name",
				boundarySeq: 1,
				nowMs: T0,
			});
			if (!entered.ok) throw new Error(entered.reason);
			expect(store.wakeResidentHold("exec-1", entered.revision, T0 + 1)).toBe(
				true,
			);

			store.forceStatus("exec-1", status, new Date(T0 + 2).toISOString());
			expect(store.getResidentHold("exec-1")).toMatchObject({
				state: "closed",
				closed_reason: "terminal",
			});
		},
	);

	it("rolls back expiry when its deterministic operation id is poisoned", async () => {
		store = await residentStore();
		const entered = store.enterResidentHold({
			executionId: "exec-1",
			activationId: "activation:exec-1:run-1:repair-any-name:1",
			nodeId: "repair-any-name",
			boundarySeq: 1,
			nowMs: T0,
		});
		if (!entered.ok) throw new Error(entered.reason);
		const requestId = "resident-expiry:exec-1:r1";
		rawDb(store)
			.prepare(
				`INSERT INTO workflow_delivery_operation (
				   operation_id, kind, run_id, family, root_id, generation,
				   shape_id, target_activation_id, client_request_id,
				   canonical_digest, state, created_at, updated_at
				 ) VALUES (?, 'resident_expiry', 'run-1', 'claude', 'exec-1', 1,
				           'repair-any-name', ?, ?, 'poison', 'staged', ?, ?)`,
			)
			.run(
				requestId,
				"activation:exec-1:run-1:repair-any-name:1",
				requestId,
				new Date(T0).toISOString(),
				new Date(T0).toISOString(),
			);

		expect(() =>
			store!.expireResidentHoldsTx(
				new Date(T0 + RESIDENT_GRACE_MS + 1).toISOString(),
			),
		).toThrow(`resident_expiry_operation_poison:${requestId}`);
		expect(store.getResidentHold("exec-1")?.state).toBe("resident");
	});

	it("projects expiry only after the exact operation crosses every barrier", async () => {
		store = await residentStore();
		const entered = store.enterResidentHold({
			executionId: "exec-1",
			activationId: "activation:exec-1:run-1:repair-any-name:1",
			nodeId: "repair-any-name",
			boundarySeq: 1,
			nowMs: T0,
		});
		if (!entered.ok) throw new Error(entered.reason);
		const expiredAt = new Date(T0 + RESIDENT_GRACE_MS + 1).toISOString();
		const [operationId] = store.expireResidentHoldsTx(expiredAt);
		if (!operationId) throw new Error("expiry_not_staged");

		expect(
			store.markResidentExpirySent({ operationId, now: expiredAt }),
		).toEqual({ ok: false, reason: "resident_expiry_not_applied" });
		expect(store.applyResidentExpiry({ operationId, now: expiredAt })).toEqual({
			ok: true,
			idempotentReplay: false,
		});
		expect(store.applyResidentExpiry({ operationId, now: expiredAt })).toEqual({
			ok: true,
			idempotentReplay: true,
		});
		expect(
			store.projectResidentExpiry({ operationId, now: expiredAt }),
		).toEqual({ ok: false, reason: "resident_expiry_not_sent" });
		expect(
			store.markResidentExpirySent({ operationId, now: expiredAt }),
		).toEqual({ ok: true, idempotentReplay: false });
		expect(
			store.projectResidentExpiry({ operationId, now: expiredAt }),
		).toEqual({ ok: true, idempotentReplay: false });
		expect(
			store.projectResidentExpiry({ operationId, now: expiredAt }),
		).toEqual({ ok: true, idempotentReplay: true });
		expect(store.getResidentHold("exec-1")).toMatchObject({
			state: "closed",
			closed_reason: "expired",
		});
		expect(store.listPendingResidentExpiryOperations()).toEqual([]);

		const events = rawDb(store)
			.prepare(
				`SELECT event_uid, kind FROM workflow_run_event
				  WHERE event_uid = ?`,
			)
			.all(operationId) as Array<{ event_uid: string; kind: string }>;
		expect(events).toEqual([
			{ event_uid: operationId, kind: "resident_hold_expired" },
		]);
	});

	it("fails an expiry once and reuses the delivery-operation alert identity", async () => {
		store = await residentStore();
		const entered = store.enterResidentHold({
			executionId: "exec-1",
			activationId: "activation:exec-1:run-1:repair-any-name:1",
			nodeId: "repair-any-name",
			boundarySeq: 1,
			nowMs: T0,
		});
		if (!entered.ok) throw new Error(entered.reason);
		const now = new Date(T0 + RESIDENT_GRACE_MS + 1).toISOString();
		const [operationId] = store.expireResidentHoldsTx(now);
		if (!operationId) throw new Error("expiry_not_staged");
		const input = {
			operationId,
			now,
			error: "commdb unavailable",
			alertIdentity: {
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved" as const,
			},
		};

		expect(store.markResidentExpiryFailed(input)).toEqual({
			ok: true,
			idempotentReplay: false,
		});
		expect(store.markResidentExpiryFailed(input)).toEqual({
			ok: true,
			idempotentReplay: true,
		});
		expect(
			rawDb(store)
				.prepare(
					"SELECT state, last_error FROM workflow_delivery_operation WHERE operation_id = ?",
				)
				.get(operationId),
		).toMatchObject({ state: "failed", last_error: "commdb unavailable" });
		expect(
			rawDb(store)
				.prepare(
					"SELECT escalation_uid FROM workflow_alert_outbox WHERE escalation_uid = ?",
				)
				.all(`delivery_operation_stalled:${operationId}`),
		).toHaveLength(1);
	});
});
