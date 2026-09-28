import { describe, expect, it, vi } from "vitest";
import { CodexLeadProcessError } from "../CodexLeadProcess.js";
import { InMemoryJournalStore, LeadJournal } from "../LeadJournal.js";
import { LeadTurnStateTracker } from "../LeadTurnStateTracker.js";
import { createCodexLeadInterruptHandler } from "../lead-interrupt-handler.js";

const THREAD = "thread-1";
const BATCH = {
	batchId: "batch-1#r0",
	memberIds: ["lead-interrupt:li_00000000-0000-4000-8000-000000000001#r0"],
	payload: "[加急 · 语音代 founder 转问] 打断 id: li_…",
};

function tracker() {
	const t = new LeadTurnStateTracker({
		binding: { findEntryIdsByTurnId: () => [], listMemberIds: () => [] },
		now: () => Date.parse("2099-07-19T12:00:00.000Z"),
	});
	t.bindThread(THREAD);
	return t;
}

function started(t: LeadTurnStateTracker, turnId: string, startedAt: number) {
	t.observeLifecycle("turn/started", {
		threadId: THREAD,
		turn: { id: turnId, status: "inProgress", startedAt },
	});
}

function harness(
	overrides: {
		tracker?: LeadTurnStateTracker;
		paused?: boolean;
		steer?: (args: unknown) => Promise<void>;
	} = {},
) {
	const journal = new LeadJournal({ store: new InMemoryJournalStore() });
	const t = overrides.tracker ?? tracker();
	const submitBatch = vi.fn(() => ({
		status: "accepted_new" as const,
		entryId: "entry-1",
	}));
	const steer = vi.fn(overrides.steer ?? (async () => {}));
	const handler = createCodexLeadInterruptHandler({
		threadId: THREAD,
		tracker: t,
		router: { submitBatch, isPaused: () => overrides.paused ?? false },
		steer,
		journal,
	});
	return { handler, submitBatch, steer, journal, tracker: t };
}

describe("FLY-2883 Codex interrupt handler (plan §6.1)", () => {
	it("steers the machine-owned active turn and never starts a new one", async () => {
		const h = harness();
		started(h.tracker, "turn-a", 4_070_000_000);
		h.tracker.setOrigin("turn-a", "message");
		expect(await h.handler.submit(BATCH)).toEqual({ outcome: "steered" });
		expect(h.steer).toHaveBeenCalledWith({
			threadId: THREAD,
			expectedTurnId: "turn-a",
			input: [{ type: "text", text: BATCH.payload }],
			clientUserMessageId: BATCH.batchId,
		});
		expect(h.submitBatch).not.toHaveBeenCalled();
	});

	it("steers a founder-terminal turn too", async () => {
		const h = harness();
		started(h.tracker, "turn-f", 4_070_000_000);
		h.tracker.setOrigin("turn-f", "founder_terminal");
		expect(await h.handler.submit(BATCH)).toEqual({ outcome: "steered" });
		expect(h.steer.mock.calls[0]?.[0]).toMatchObject({
			expectedTurnId: "turn-f",
		});
	});

	it("steers the earliest turn when more than one looks active", async () => {
		const h = harness();
		started(h.tracker, "turn-late", 4_070_000_100);
		started(h.tracker, "turn-early", 4_070_000_000);
		await h.handler.submit(BATCH);
		expect(h.steer.mock.calls[0]?.[0]).toMatchObject({
			expectedTurnId: "turn-early",
		});
	});

	it("starts a turn through the router when the Lead is idle", async () => {
		const h = harness();
		started(h.tracker, "turn-a", 4_070_000_000);
		h.tracker.observeLifecycle("turn/completed", {
			threadId: THREAD,
			turn: { id: "turn-a", status: "completed" },
		});
		expect(await h.handler.submit(BATCH)).toEqual({ outcome: "queued_turn" });
		expect(h.submitBatch).toHaveBeenCalledWith(BATCH);
		expect(h.steer).not.toHaveBeenCalled();
	});

	it.each([
		["never seeded", (t: LeadTurnStateTracker) => t],
		[
			"disconnected",
			(t: LeadTurnStateTracker) => {
				t.markDisconnected();
				return t;
			},
		],
	])(
		"refuses to act when the turn state is %s (R2#3)",
		async (_label, prep) => {
			const t = new LeadTurnStateTracker({
				binding: { findEntryIdsByTurnId: () => [], listMemberIds: () => [] },
			});
			t.bindThread(THREAD);
			const h = harness({ tracker: prep(t) });
			expect(await h.handler.submit(BATCH)).toEqual({
				outcome: "steer_failed",
				detail: "turn_state_unknown",
			});
			expect(h.submitBatch).not.toHaveBeenCalled();
			expect(h.steer).not.toHaveBeenCalled();
		},
	);

	it("refuses while the router is paused for rotation", async () => {
		const h = harness({ paused: true });
		started(h.tracker, "turn-a", 4_070_000_000);
		expect(await h.handler.submit(BATCH)).toEqual({
			outcome: "steer_failed",
			detail: "router_paused",
		});
		expect(h.steer).not.toHaveBeenCalled();
		expect(h.submitBatch).not.toHaveBeenCalled();
	});

	it.each([
		[
			new CodexLeadProcessError("turn already finished", "protocol", -32600),
			"stale_turn",
		],
		[
			new CodexLeadProcessError("timed out", "timeout"),
			"steer_outcome_unknown",
		],
		[new CodexLeadProcessError("gone", "exited"), "steer_outcome_unknown"],
		[new Error("socket reset"), "steer_outcome_unknown"],
	])(
		"classifies a steer failure %s as %s, never falling back to a new turn (R2#5)",
		async (error, detail) => {
			const h = harness({
				steer: async () => {
					throw error;
				},
			});
			started(h.tracker, "turn-a", 4_070_000_000);
			expect(await h.handler.submit(BATCH)).toEqual({
				outcome: "steer_failed",
				detail,
			});
			expect(h.submitBatch).not.toHaveBeenCalled();
			// Nothing recorded: the Bridge re-judges on the next attempt.
			expect(
				h.journal.getByIdempotencyKey(`interrupt-result:${BATCH.batchId}`),
			).toBeUndefined();
		},
	);

	it("replays a recorded result without any side effect (R1#4)", async () => {
		const h = harness();
		started(h.tracker, "turn-a", 4_070_000_000);
		await h.handler.submit(BATCH);
		h.tracker.observeLifecycle("turn/completed", {
			threadId: THREAD,
			turn: { id: "turn-a", status: "completed" },
		});
		expect(await h.handler.submit(BATCH)).toEqual({ outcome: "steered" });
		expect(h.steer).toHaveBeenCalledTimes(1);
		expect(h.submitBatch).not.toHaveBeenCalled();
	});

	it("steers again when a crash lost the record between steer and bookkeeping (L3)", async () => {
		const h = harness();
		started(h.tracker, "turn-a", 4_070_000_000);
		const record = vi
			.spyOn(h.journal, "recordObservation")
			.mockImplementationOnce(() => {
				throw new Error("crash after steer");
			});
		expect(await h.handler.submit(BATCH)).toEqual({ outcome: "steered" });
		record.mockRestore();
		expect(await h.handler.submit(BATCH)).toEqual({ outcome: "steered" });
		expect(h.steer).toHaveBeenCalledTimes(2);
	});

	it("does not start a second turn when the queued_turn replay has no record (journal dedupe)", async () => {
		const journal = new LeadJournal({ store: new InMemoryJournalStore() });
		const t = tracker();
		t.observeLifecycle("turn/completed", {
			threadId: THREAD,
			turn: { id: "none", status: "completed" },
		});
		const accepted = new Set<string>();
		const submitBatch = vi.fn((batch: { batchId: string }) => {
			const status = accepted.has(batch.batchId)
				? ("duplicate" as const)
				: ("accepted_new" as const);
			accepted.add(batch.batchId);
			return { status, entryId: "entry-1" };
		});
		const handler = createCodexLeadInterruptHandler({
			threadId: THREAD,
			tracker: t,
			router: { submitBatch, isPaused: () => false },
			steer: vi.fn(),
			journal,
		});
		const record = vi
			.spyOn(journal, "recordObservation")
			.mockImplementationOnce(() => {
				throw new Error("crash after submit");
			});
		expect(await handler.submit(BATCH)).toEqual({ outcome: "queued_turn" });
		record.mockRestore();
		expect(await handler.submit(BATCH)).toEqual({ outcome: "queued_turn" });
		expect(submitBatch.mock.results.map((r) => r.value.status)).toEqual([
			"accepted_new",
			"duplicate",
		]);
	});

	it("decides from a live event that arrived before the call (R3#1)", async () => {
		const h = harness();
		h.tracker.observeLifecycle("turn/completed", {
			threadId: THREAD,
			turn: { id: "old", status: "completed" },
		});
		started(h.tracker, "turn-new", 4_070_000_000);
		expect(await h.handler.submit(BATCH)).toEqual({ outcome: "steered" });
		expect(h.submitBatch).not.toHaveBeenCalled();
	});

	it("issues the idle-path side effect synchronously, before any microtask (R4 advisory 1)", async () => {
		const h = harness();
		h.tracker.observeLifecycle("turn/completed", {
			threadId: THREAD,
			turn: { id: "old", status: "completed" },
		});
		let submittedBeforeMicrotask: boolean | undefined;
		queueMicrotask(() => {
			submittedBeforeMicrotask = h.submitBatch.mock.calls.length === 1;
		});
		const pending = h.handler.submit(BATCH);
		await pending;
		expect(submittedBeforeMicrotask).toBe(true);
	});
});
