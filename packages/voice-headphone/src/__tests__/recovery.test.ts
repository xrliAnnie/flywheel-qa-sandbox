/**
 * Boot recovery normalization (plan B2-2.2 ③) — the three crash points:
 * crash AFTER sendReply / postReceipt / submitApproval but BEFORE the state
 * advanced. Restart must resume/suppress from the recorded side-effect ids
 * and NEVER re-send a relay, receipt, or approval.
 */
import {
	HeadphoneQueue,
	type PersistedTurnState,
	type QueueItem,
} from "flywheel-voice-core";
import { describe, expect, it } from "vitest";
import { adoptOrSend, normalizeRestoredTurn } from "../recovery.js";

const item = (over: Partial<QueueItem> = {}): QueueItem => ({
	id: "item-1",
	messageId: "msg-1",
	channelId: "thread-1",
	agentId: "tadashi",
	kind: "normal",
	headline: { agentDisplay: "Tadashi", issueRef: "FLY-901" },
	body: "正文",
	enqueuedAt: "2026-07-07T00:00:00.000Z",
	...over,
});

const sendingTurn = (i: QueueItem): PersistedTurnState => ({
	state: "sending",
	currentItem: i,
	processed: 1,
	unclearCount: 0,
	denyCount: 0,
	dictated: "回话内容",
});

describe("adoptOrSend — the hardest crash window (Discord accepted, id not persisted)", () => {
	it("adopts an existing marked message instead of re-sending", async () => {
		let sent = 0;
		const res = await adoptOrSend({
			marker: "〔hp:item-1〕",
			scanRecent: async () => [
				{ id: "m-9", content: "🎧 Annie(语音):回话内容 〔hp:item-1〕" },
			],
			send: async () => {
				sent++;
				return "m-new";
			},
		});
		expect(res).toEqual({ adopted: true, messageId: "m-9" });
		expect(sent).toBe(0);
	});

	it("sends (once) when no marked message exists", async () => {
		let sent = 0;
		const res = await adoptOrSend({
			marker: "〔hp:item-1〕",
			scanRecent: async () => [{ id: "m-8", content: "unrelated" }],
			send: async () => {
				sent++;
				return "m-new";
			},
		});
		expect(res).toEqual({ adopted: false, messageId: "m-new" });
		expect(sent).toBe(1);
	});
});

describe("normalizeRestoredTurn — three crash points", () => {
	it("crash point 1: sendReply done + ledger recorded → item completes, NO re-send", async () => {
		const q = new HeadphoneQueue();
		const sends: string[] = [];
		const turn = sendingTurn(
			item({ sideEffects: { sentMessageId: "sent-1" } }),
		);
		const normalized = await normalizeRestoredTurn(turn, q, {
			adoptSend: async () => {
				sends.push("scan");
				return undefined;
			},
		});
		expect(sends).toEqual([]); // ledger already has the id — no scan, no send
		expect(normalized.state).toBe("idle");
		expect(normalized.currentItem).toBeUndefined();
		expect(q.size()).toBe(0);
	});

	it("crash point 1b: send in flight, NO ledger id → marker scan adopts; unadopted → requeue front, never re-send", async () => {
		// adopted
		const q1 = new HeadphoneQueue();
		const n1 = await normalizeRestoredTurn(sendingTurn(item()), q1, {
			adoptSend: async () => "m-adopted",
		});
		expect(n1.state).toBe("idle");
		expect(q1.size()).toBe(0);
		// not adopted → the item returns to the queue head for a fresh turn
		const q2 = new HeadphoneQueue();
		const n2 = await normalizeRestoredTurn(sendingTurn(item()), q2, {
			adoptSend: async () => undefined,
		});
		expect(n2.state).toBe("idle");
		expect(q2.peek()?.id).toBe("item-1");
	});

	it("crash point 2: receipt posted, approval NOT yet submitted → requeue as a FRESH ship_gate turn (no auto-approval on boot)", async () => {
		const q = new HeadphoneQueue();
		const shipItem = item({
			kind: "ship_gate",
			gate: {
				gateMessageId: "g-1",
				questionId: "q-1",
				prHeadSha: "sha",
				issueId: "FLY-901",
			},
			sideEffects: { receiptMessageId: "receipt-1" },
		});
		const normalized = await normalizeRestoredTurn(sendingTurn(shipItem), q, {
			adoptSend: async () => undefined,
		});
		expect(normalized.state).toBe("idle");
		expect(q.peek()?.id).toBe("item-1");
		expect(q.peek()?.kind).toBe("ship_gate");
	});

	it("crash point 3: submitApproval was invoked (attempt id recorded) → SUPPRESS, never resubmit, item done", async () => {
		const q = new HeadphoneQueue();
		const shipItem = item({
			kind: "ship_gate",
			gate: {
				gateMessageId: "g-1",
				questionId: "q-1",
				prHeadSha: "sha",
				issueId: "FLY-901",
			},
			sideEffects: {
				receiptMessageId: "receipt-1",
				approvalAttemptId: "item-1",
			},
		});
		const normalized = await normalizeRestoredTurn(sendingTurn(shipItem), q, {
			adoptSend: async () => undefined,
		});
		expect(normalized.state).toBe("idle");
		expect(q.size()).toBe(0); // not requeued — outcome must be checked on screen, not re-written
	});

	it("non-sending states pass through unchanged", async () => {
		const q = new HeadphoneQueue();
		const turn: PersistedTurnState = {
			state: "disconnect_grace",
			currentItem: item(),
			processed: 0,
			unclearCount: 0,
			denyCount: 0,
			grace: {
				previousState: "awaiting_disposition",
				currentItemId: "item-1",
				itemPhase: "ask",
				enteredAtMs: 1,
			},
		};
		const normalized = await normalizeRestoredTurn(turn, q, {
			adoptSend: async () => undefined,
		});
		expect(normalized).toEqual(turn);
	});
});
