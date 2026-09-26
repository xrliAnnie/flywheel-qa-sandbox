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
	payload: '{"schema_version":1}',
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
	it("drains immutable source rows into the destination using frozen bytes", () => {
		const { db, store } = harness();
		const result = drainWorkflowSourceEvents({
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
			at: EVENT.at,
		});
		expect(db.close).toHaveBeenCalledOnce();
	});

	it("replays safely when destination commit wins but durable cursor advance fails", () => {
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

		drainWorkflowSourceEvents({
			projects: ["flywheel"],
			openCommDb: () => db,
			store,
		});
		const replay = drainWorkflowSourceEvents({
			projects: ["flywheel"],
			openCommDb: () => db,
			store,
		});

		expect(replay.replayed).toBe(1);
		expect(store.applyWorkflowSourceEvent).toHaveBeenCalledTimes(2);
		expect(store.getWorkflowSourceCursor("flywheel")).toBe(1);
	});

	it("deadletters malformed/poison rows once instead of retrying forever", () => {
		const { db, store } = harness();
		store.applyWorkflowSourceEvent.mockImplementation(() => {
			throw new Error("workflow source payload digest mismatch (poison)");
		});

		const first = drainWorkflowSourceEvents({
			projects: ["flywheel"],
			openCommDb: () => db,
			store,
		});
		const second = drainWorkflowSourceEvents({
			projects: ["flywheel"],
			openCommDb: () => db,
			store,
		});

		expect(first.deadlettered).toBe(1);
		expect(second.skipped).toBe(0);
		expect(store.applyWorkflowSourceEvent).toHaveBeenCalledOnce();
		expect(store.recordWorkflowSourceDeadletter).toHaveBeenCalledOnce();
	});

	it("leaves transient destination failures retryable", () => {
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

		const first = drainWorkflowSourceEvents({
			projects: ["flywheel"],
			openCommDb: () => db,
			store,
		});
		const second = drainWorkflowSourceEvents({
			projects: ["flywheel"],
			openCommDb: () => db,
			store,
		});

		expect(first.deadlettered).toBe(0);
		expect(store.recordWorkflowSourceDeadletter).not.toHaveBeenCalled();
		expect(second.applied).toBe(1);
	});

	it("retries source events whose workflow run has not arrived yet", () => {
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

		const first = drainWorkflowSourceEvents({
			projects: ["flywheel"],
			openCommDb: () => db,
			store,
		});
		const second = drainWorkflowSourceEvents({
			projects: ["flywheel"],
			openCommDb: () => db,
			store,
		});

		expect(first.deadlettered).toBe(0);
		expect(store.recordWorkflowSourceDeadletter).not.toHaveBeenCalled();
		expect(second.applied).toBe(1);
	});

	it("runs a startup drain and periodic drains, and stop cancels the timer", () => {
		vi.useFakeTimers();
		try {
			const { db, store } = harness([]);
			const handle = startWorkflowSourceProjector({
				projects: () => ["flywheel"],
				openCommDb: () => db,
				store,
				intervalMs: 1_000,
			});
			expect(db.listWorkflowSourceEventsAfter).toHaveBeenCalledTimes(1);

			vi.advanceTimersByTime(2_000);
			expect(db.listWorkflowSourceEventsAfter).toHaveBeenCalledTimes(3);
			handle.stop();
			vi.advanceTimersByTime(2_000);
			expect(db.listWorkflowSourceEventsAfter).toHaveBeenCalledTimes(3);
		} finally {
			vi.useRealTimers();
		}
	});

	it("re-reads the project roster on every tick", () => {
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
			expect(added.db.listWorkflowSourceEventsAfter).not.toHaveBeenCalled();
			projects = ["flywheel", "new-project"];
			vi.advanceTimersByTime(1_000);
			expect(added.db.listWorkflowSourceEventsAfter).toHaveBeenCalledOnce();
			handle.stop();
		} finally {
			vi.useRealTimers();
		}
	});
});
