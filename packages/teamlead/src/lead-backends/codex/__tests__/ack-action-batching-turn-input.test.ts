import { describe, expect, it, vi } from "vitest";
import {
	CODEX_ACK_ACTION_BATCHING_DIRECTIVE,
	codexMailboxTurnInput,
} from "../ack-action-batching-turn-input.js";
import {
	LeadInputRouter,
	type OutboundSender,
	type TurnExecutor,
} from "../LeadInputRouter.js";
import { InMemoryJournalStore, LeadJournal } from "../LeadJournal.js";
import { LeadTurnStateTracker } from "../LeadTurnStateTracker.js";
import { createCodexLeadInterruptHandler } from "../lead-interrupt-handler.js";

const BATCH_PAYLOAD =
	"[mailbox-batch b-1 | 2 messages | from runner-x]\nYou must ack this batch with lead_actions.ack_batch promptly so the sender can see you received it; unacked batches are redelivered and eventually dead-lettered.\n\nfirst\n\nsecond";

describe("FLY-2909 Codex mailbox turn input", () => {
	it("restates the ACK timing after a mailbox batch only when the launch receipt is on", () => {
		expect(codexMailboxTurnInput(BATCH_PAYLOAD, true)).toBe(
			`${BATCH_PAYLOAD}\n\n${CODEX_ACK_ACTION_BATCHING_DIRECTIVE}`,
		);
		expect(codexMailboxTurnInput(BATCH_PAYLOAD, false)).toBe(BATCH_PAYLOAD);
		expect(codexMailboxTurnInput(BATCH_PAYLOAD, undefined)).toBe(BATCH_PAYLOAD);
	});

	it("leaves headerless input byte-identical even when on", () => {
		for (const payload of [
			"founder: status?",
			` ${BATCH_PAYLOAD}`,
			"[mailbox-batch malformed]",
		])
			expect(codexMailboxTurnInput(payload, true)).toBe(payload);
	});

	it("names the Codex ACK tool, same-step pairing, and every retained guard", () => {
		const text = CODEX_ACK_ACTION_BATCHING_DIRECTIVE.replace(/\s+/g, " ");
		for (const phrase of [
			"`ack_batch` from `lead_actions`",
			"same model step as the first handling action",
			"inside the same `exec` script",
			"Status-only input",
			"call it alone right away; never skip it",
			"Never ACK before handling begins",
			"do not delay urgent founder input",
			"transport only",
			'older "process every message, then acknowledge" wording',
		])
			expect(text).toContain(phrase);
	});
});

class RecordingExecutor implements TurnExecutor {
	inputs: string[] = [];
	private seq = 0;
	async startTurn(args: { input: string }): Promise<string> {
		this.inputs.push(args.input);
		return `turn-${++this.seq}`;
	}
	async awaitCompletion(): Promise<{ output: string }> {
		return { output: "" };
	}
	async reconcile() {
		return { exists: false, completed: false };
	}
}

const sender: OutboundSender = {
	enqueue: async () => "outbox",
	deliver: async () => {},
};

function router(ackActionBatchingEnabled?: boolean) {
	const store = new InMemoryJournalStore();
	const executor = new RecordingExecutor();
	const r = new LeadInputRouter({
		leadId: "lead-x",
		threadId: "thread-1",
		journal: new LeadJournal({ store }),
		executor,
		sender,
		logger: { warn: vi.fn(), error: vi.fn() },
		...(ackActionBatchingEnabled === undefined
			? {}
			: { ackActionBatchingEnabled }),
	});
	return { r, executor, store };
}

describe("FLY-2909 LeadInputRouter mailbox turns", () => {
	it("sends the directive with the batch turn but keeps the durable payload unchanged", async () => {
		const { r, executor, store } = router(true);
		const { entryId } = r.submitBatch({
			batchId: "b-1",
			memberIds: ["d-1", "d-2"],
			payload: BATCH_PAYLOAD,
		});
		await r.whenIdle();
		expect(executor.inputs).toEqual([
			`${BATCH_PAYLOAD}\n\n${CODEX_ACK_ACTION_BATCHING_DIRECTIVE}`,
		]);
		expect(store.getById(entryId)?.payload).toBe(BATCH_PAYLOAD);
	});

	it("keeps batch turn input byte-identical when the receipt is off or absent", async () => {
		for (const flag of [false, undefined]) {
			const { r, executor } = router(flag);
			r.submitBatch({
				batchId: "b-1",
				memberIds: ["d-1"],
				payload: BATCH_PAYLOAD,
			});
			await r.whenIdle();
			expect(executor.inputs).toEqual([BATCH_PAYLOAD]);
		}
	});

	it("never adds the directive to a Discord input, even one that looks like a header", async () => {
		const { r, executor } = router(true);
		r.submit({
			source: "discord",
			payload: BATCH_PAYLOAD,
			idempotencyKey: "discord-1",
		});
		await r.whenIdle();
		expect(executor.inputs).toEqual([BATCH_PAYLOAD]);
	});
});

describe("FLY-2909 steered interrupt batches", () => {
	function steerHarness(ackActionBatchingEnabled?: boolean) {
		const tracker = new LeadTurnStateTracker({
			binding: { findEntryIdsByTurnId: () => [], listMemberIds: () => [] },
			now: () => Date.parse("2099-07-19T12:00:00.000Z"),
		});
		tracker.bindThread("thread-1");
		tracker.observeLifecycle("turn/started", {
			threadId: "thread-1",
			turn: { id: "turn-a", status: "inProgress", startedAt: 4_070_000_000 },
		});
		tracker.setOrigin("turn-a", "message");
		const steer = vi.fn(async () => {});
		const handler = createCodexLeadInterruptHandler({
			threadId: "thread-1",
			tracker,
			router: {
				submitBatch: vi.fn(() => ({
					status: "accepted_new" as const,
					entryId: "entry-1",
				})),
				isPaused: () => false,
			},
			steer,
			journal: new LeadJournal({ store: new InMemoryJournalStore() }),
			...(ackActionBatchingEnabled === undefined
				? {}
				: { ackActionBatchingEnabled }),
		});
		return { handler, steer };
	}
	const batch = {
		batchId: "b-1#r0",
		memberIds: ["d-1#r0"],
		payload: BATCH_PAYLOAD,
	};

	it("steers the directive into the live turn when on", async () => {
		const h = steerHarness(true);
		expect(await h.handler.submit(batch)).toEqual({ outcome: "steered" });
		expect(h.steer.mock.calls[0]?.[0]).toMatchObject({
			input: [
				{
					type: "text",
					text: `${BATCH_PAYLOAD}\n\n${CODEX_ACK_ACTION_BATCHING_DIRECTIVE}`,
				},
			],
		});
	});

	it("steers the original bytes when off or absent", async () => {
		for (const flag of [false, undefined]) {
			const h = steerHarness(flag);
			await h.handler.submit(batch);
			expect(h.steer.mock.calls[0]?.[0]).toMatchObject({
				input: [{ type: "text", text: BATCH_PAYLOAD }],
			});
		}
	});
});
