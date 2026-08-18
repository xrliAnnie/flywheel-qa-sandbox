import { describe, expect, it, vi } from "vitest";
import {
	drainWorkflowSourceEvents,
	startWorkflowSourceProjector,
} from "../founder-approval-projector.js";

const EVENT = {
	row_id: 1,
	project: "flywheel",
	source_event_id: "founder-approval:Q-1",
	kind: "founder_approval" as const,
	payload: JSON.stringify({
		schema_version: 1,
		run_id: "run-1",
		issue_id: "FLY-1772",
		question_id: "question-1",
	}),
	payload_digest: "digest-1",
	schema_version: 1,
	at: "2026-07-14T00:00:00.000Z",
};

function harness(events = [EVENT]) {
	const deadletters = new Set<string>();
	const cursors = new Map<string, number>();
	const db = {
		listWorkflowSourceEventsAfter: vi.fn((afterRowId: number, limit: number) =>
			events.filter((event) => event.row_id > afterRowId).slice(0, limit),
		),
		close: vi.fn(),
	};
	const store = {
		applyWorkflowSourceEvent: vi.fn().mockReturnValue({
			kind: "founder_claim",
			status: "applied",
			claimId: 1,
		}),
		getWorkflowSourceDeadletter: vi.fn((project: string, id: string) =>
			deadletters.has(`${project}:${id}`)
				? { project, source_event_id: id }
				: undefined,
		),
		getWorkflowRun: vi.fn(() => ({
			run_id: "run-1",
			issue_id: "FLY-1772",
			project_name: "flywheel",
		})),
		recordWorkflowSourceDeadletter: vi.fn(
			(input: { project: string; sourceEventId: string }) => {
				deadletters.add(`${input.project}:${input.sourceEventId}`);
			},
		),
		getWorkflowSourceCursor: vi.fn(
			(project: string) => cursors.get(project) ?? 0,
		),
		advanceWorkflowSourceCursor: vi.fn((project: string, rowId: number) => {
			cursors.set(project, rowId);
		}),
	};
	return { db, store };
}

describe("workflow source projector", () => {
	it("drains immutable source rows into the destination using frozen bytes", async () => {
		const { db, store } = harness();
		const result = await drainWorkflowSourceEvents({
			projects: ["flywheel"],
			openCommDb: () => db,
			store,
		});

		expect(result).toEqual({
			applied: 1,
			replayed: 0,
			deadlettered: 0,
			skipped: 0,
		});
		expect(store.applyWorkflowSourceEvent).toHaveBeenCalledWith({
			project: "flywheel",
			sourceEventId: EVENT.source_event_id,
			kind: "founder_approval",
			payloadJson: EVENT.payload,
			payloadDigest: EVENT.payload_digest,
			schemaVersion: 1,
			sourceRowId: EVENT.row_id,
			at: EVENT.at,
		});
		expect(db.close).toHaveBeenCalledOnce();
	});

	it("forwards the immutable CommDB rowid for a land departure cutoff", async () => {
		const cutoff = {
			...EVENT,
			row_id: 42,
			source_event_id: "land-departure-cutoff:receipt-1",
			kind: "land_departure_cutoff" as const,
		};
		const { db, store } = harness([cutoff]);
		store.applyWorkflowSourceEvent.mockReturnValue({
			kind: "land_departure_cutoff",
			status: "applied",
		});

		await drainWorkflowSourceEvents({
			projects: ["flywheel"],
			openCommDb: () => db,
			store,
		});

		expect(store.applyWorkflowSourceEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "land_departure_cutoff",
				sourceRowId: 42,
			}),
		);
	});

	it("replays safely when destination commit wins but durable cursor advance fails", async () => {
		const { db, store } = harness();
		store.advanceWorkflowSourceCursor.mockImplementationOnce(() => {
			throw new Error("cursor database is busy");
		});
		store.applyWorkflowSourceEvent
			.mockReturnValueOnce({
				kind: "founder_claim",
				status: "applied",
				claimId: 1,
			})
			.mockReturnValue({
				kind: "founder_claim",
				status: "replayed",
				claimId: 1,
			});

		await drainWorkflowSourceEvents({
			projects: ["flywheel"],
			openCommDb: () => db,
			store,
		});
		const replay = await drainWorkflowSourceEvents({
			projects: ["flywheel"],
			openCommDb: () => db,
			store,
		});

		expect(replay.replayed).toBe(1);
		expect(store.applyWorkflowSourceEvent).toHaveBeenCalledTimes(2);
		expect(store.getWorkflowSourceCursor("flywheel")).toBe(1);
	});

	it("deadletters malformed/poison rows once instead of retrying forever", async () => {
		const { db, store } = harness();
		store.applyWorkflowSourceEvent.mockImplementation(() => {
			throw new Error("workflow source payload digest mismatch (poison)");
		});

		const first = await drainWorkflowSourceEvents({
			projects: ["flywheel"],
			openCommDb: () => db,
			store,
			resolveAlertIdentity: () => ({
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			}),
		});
		const second = await drainWorkflowSourceEvents({
			projects: ["flywheel"],
			openCommDb: () => db,
			store,
			resolveAlertIdentity: () => ({
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			}),
		});

		expect(first.deadlettered).toBe(1);
		expect(second.skipped).toBe(0);
		expect(store.applyWorkflowSourceEvent).toHaveBeenCalledOnce();
		expect(store.recordWorkflowSourceDeadletter).toHaveBeenCalledOnce();
	});

	it("leaves transient destination failures retryable", async () => {
		const { db, store } = harness();
		store.applyWorkflowSourceEvent
			.mockImplementationOnce(() => {
				throw new Error("database is busy");
			})
			.mockReturnValue({
				kind: "founder_claim",
				status: "applied",
				claimId: 1,
			});

		const first = await drainWorkflowSourceEvents({
			projects: ["flywheel"],
			openCommDb: () => db,
			store,
		});
		const second = await drainWorkflowSourceEvents({
			projects: ["flywheel"],
			openCommDb: () => db,
			store,
		});

		expect(first.deadlettered).toBe(0);
		expect(store.recordWorkflowSourceDeadletter).not.toHaveBeenCalled();
		expect(second.applied).toBe(1);
	});

	it("drops an invalid advisory identity without pinning founder feedback", async () => {
		const event = { ...EVENT, kind: "founder_feedback" as const };
		const { db, store } = harness([event]);
		const log = vi.fn();

		const result = await drainWorkflowSourceEvents({
			projects: ["flywheel"],
			openCommDb: () => db,
			store,
			resolveAlertIdentity: () =>
				({
					leadId: " ",
					projectName: "flywheel",
					leadResolution: "resolved",
				}) as never,
			log,
		});

		expect(result.applied).toBe(1);
		expect(store.getWorkflowSourceCursor("flywheel")).toBe(1);
		expect(store.applyWorkflowSourceEvent).toHaveBeenCalledWith(
			expect.not.objectContaining({ alertIdentity: expect.anything() }),
		);
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("founder rework alert identity invalid"),
		);
	});

	it("retries source events whose workflow run has not arrived yet", async () => {
		const { db, store } = harness();
		store.applyWorkflowSourceEvent
			.mockImplementationOnce(() => {
				throw new Error("workflow source run unavailable: run-1");
			})
			.mockReturnValue({
				kind: "founder_claim",
				status: "applied",
				claimId: 1,
			});

		const first = await drainWorkflowSourceEvents({
			projects: ["flywheel"],
			openCommDb: () => db,
			store,
		});
		const second = await drainWorkflowSourceEvents({
			projects: ["flywheel"],
			openCommDb: () => db,
			store,
		});

		expect(first.deadlettered).toBe(0);
		expect(store.recordWorkflowSourceDeadletter).not.toHaveBeenCalled();
		expect(second.applied).toBe(1);
	});

	it("runs a startup drain and periodic drains, and stop cancels the timer", async () => {
		vi.useFakeTimers();
		try {
			const { db, store } = harness([]);
			const handle = startWorkflowSourceProjector({
				projects: () => ["flywheel"],
				openCommDb: () => db,
				store,
				intervalMs: 1_000,
			});
			await handle.whenIdle();
			expect(db.listWorkflowSourceEventsAfter).toHaveBeenCalledTimes(1);

			await vi.advanceTimersByTimeAsync(2_000);
			expect(db.listWorkflowSourceEventsAfter).toHaveBeenCalledTimes(3);
			handle.stop();
			await vi.advanceTimersByTimeAsync(2_000);
			expect(db.listWorkflowSourceEventsAfter).toHaveBeenCalledTimes(3);
		} finally {
			vi.useRealTimers();
		}
	});

	it("re-reads the project roster on every tick", async () => {
		vi.useFakeTimers();
		try {
			const flywheel = harness([]);
			const added = harness([]);
			let projects = ["flywheel"];
			const handle = startWorkflowSourceProjector({
				projects: () => projects,
				openCommDb: (project) =>
					project === "flywheel" ? flywheel.db : added.db,
				store: flywheel.store,
				intervalMs: 1_000,
			});
			await handle.whenIdle();
			expect(added.db.listWorkflowSourceEventsAfter).not.toHaveBeenCalled();
			projects = ["flywheel", "new-project"];
			await vi.advanceTimersByTimeAsync(1_000);
			expect(added.db.listWorkflowSourceEventsAfter).toHaveBeenCalledOnce();
			handle.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	it("binds a terminal founder input to its run and records the alert atomically", async () => {
		const event = {
			...EVENT,
			payload: JSON.stringify({
				schema_version: 1,
				run_id: "run-1",
				issue_id: "FLY-1772",
				question_id: "question-1",
			}),
		};
		const { db, store } = harness([event]);
		store.applyWorkflowSourceEvent.mockImplementation(() => {
			throw new Error("founder feedback source payload invalid: run state");
		});
		Object.assign(store, {
			getWorkflowRun: vi.fn(() => ({
				run_id: "run-1",
				issue_id: "FLY-1772",
				project_name: "flywheel",
			})),
		});
		const alertFallback = vi.fn();

		const result = await drainWorkflowSourceEvents({
			projects: ["flywheel"],
			openCommDb: () => db,
			store,
			resolveAlertIdentity: () => ({
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			}),
			alertFallback,
		});

		expect(result.deadlettered).toBe(1);
		expect(store.recordWorkflowSourceDeadletter).toHaveBeenCalledWith({
			project: "flywheel",
			sourceEventId: event.source_event_id,
			reason: "founder feedback source payload invalid: run state",
			founderOrigin: {
				kind: "founder_approval",
				payloadJson: event.payload,
				alertIdentity: {
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				},
			},
		});
		expect(alertFallback).not.toHaveBeenCalled();
	});

	it("deadletters a mismatched source-row project under the drained project without pinning the cursor", async () => {
		const event = { ...EVENT, project: "wrong-project" };
		const { db, store } = harness([event]);
		store.applyWorkflowSourceEvent.mockImplementation(() => {
			throw new Error(
				"workflow source project mismatch: expected flywheel, got wrong-project",
			);
		});
		store.recordWorkflowSourceDeadletter.mockImplementation((input) => {
			if (input.project !== "flywheel") {
				throw new Error("workflow source deadletter founder binding invalid");
			}
		});

		const result = await drainWorkflowSourceEvents({
			projects: ["flywheel"],
			openCommDb: () => db,
			store,
			resolveAlertIdentity: () => ({
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			}),
		});

		expect(result.deadlettered).toBe(1);
		expect(store.recordWorkflowSourceDeadletter).toHaveBeenCalledWith(
			expect.objectContaining({ project: "flywheel" }),
		);
		expect(store.getWorkflowSourceCursor("flywheel")).toBe(1);
	});

	it("pins the project cursor when an unbindable founder alert is not durably accepted", async () => {
		const poison = {
			...EVENT,
			payload: "{malformed",
		};
		const valid = {
			...EVENT,
			row_id: 2,
			source_event_id: "founder-approval:Q-2",
		};
		const { db, store } = harness([poison, valid]);
		store.applyWorkflowSourceEvent.mockImplementation(() => {
			throw new Error("workflow source payload malformed");
		});
		Object.assign(store, { getWorkflowRun: vi.fn(() => undefined) });
		const alertFallback = vi.fn().mockResolvedValue({ accepted: false });

		const result = await drainWorkflowSourceEvents({
			projects: ["flywheel"],
			openCommDb: () => db,
			store,
			resolveAlertIdentity: () => ({
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "fallback",
			}),
			alertFallback,
		});

		expect(result.deadlettered).toBe(0);
		expect(alertFallback).toHaveBeenCalledOnce();
		expect(store.recordWorkflowSourceDeadletter).not.toHaveBeenCalled();
		expect(store.applyWorkflowSourceEvent).toHaveBeenCalledOnce();
		expect(store.getWorkflowSourceCursor("flywheel")).toBe(0);
	});

	it("deadletters an unbindable founder input only after the durable fallback accepts it", async () => {
		const poison = { ...EVENT, payload: "{malformed" };
		const { db, store } = harness([poison]);
		store.applyWorkflowSourceEvent.mockImplementation(() => {
			throw new Error("workflow source payload malformed");
		});
		store.getWorkflowRun.mockReturnValue(undefined);
		const alertFallback = vi.fn().mockResolvedValue({ accepted: true });

		const result = await drainWorkflowSourceEvents({
			projects: ["flywheel"],
			openCommDb: () => db,
			store,
			resolveAlertIdentity: () => ({
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "fallback",
			}),
			alertFallback,
		});

		expect(result.deadlettered).toBe(1);
		expect(alertFallback).toHaveBeenCalledWith(
			expect.objectContaining({
				eventId: `founder_input_deadletter:${poison.source_event_id}`,
			}),
		);
		expect(store.recordWorkflowSourceDeadletter).toHaveBeenCalledWith({
			project: "flywheel",
			sourceEventId: poison.source_event_id,
			reason: "workflow source payload malformed",
		});
		expect(store.getWorkflowSourceCursor("flywheel")).toBe(1);
	});

	it("keeps periodic drains single-flight while a durable fallback is pending", async () => {
		vi.useFakeTimers();
		try {
			const poison = { ...EVENT, payload: "{malformed" };
			const { db, store } = harness([poison]);
			store.applyWorkflowSourceEvent.mockImplementation(() => {
				throw new Error("workflow source payload malformed");
			});
			store.getWorkflowRun.mockReturnValue(undefined);
			let release!: (value: { accepted: boolean }) => void;
			const pending = new Promise<{ accepted: boolean }>((resolve) => {
				release = resolve;
			});
			const alertFallback = vi.fn(() => pending);
			const handle = startWorkflowSourceProjector({
				projects: ["flywheel"],
				openCommDb: () => db,
				store,
				resolveAlertIdentity: () => ({
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "fallback",
				}),
				alertFallback,
				intervalMs: 1_000,
			});
			await Promise.resolve();
			expect(alertFallback).toHaveBeenCalledOnce();

			await vi.advanceTimersByTimeAsync(5_000);
			expect(db.listWorkflowSourceEventsAfter).toHaveBeenCalledOnce();
			release({ accepted: false });
			await handle.whenIdle();
			await vi.advanceTimersByTimeAsync(1_000);
			expect(db.listWorkflowSourceEventsAfter).toHaveBeenCalledTimes(2);
			handle.stop();
		} finally {
			vi.useRealTimers();
		}
	});
});
