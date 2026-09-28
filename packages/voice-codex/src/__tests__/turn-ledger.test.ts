import { describe, expect, it } from "vitest";
import { TurnLedger } from "../codex/TurnLedger.js";

function ledger() {
	let now = 0;
	const turns = new TurnLedger(() => now);
	return {
		turns,
		at: (ms: number) => {
			now = ms;
		},
	};
}

describe("turn ledger (FLY-2885 T5b)", () => {
	it("tracks an assistant turn as open from created to done", () => {
		const h = ledger();
		h.turns.created("a1", "assistant");
		expect(h.turns.openAssistantTurn()).toBe(true);
		h.turns.done("a1", "assistant");
		expect(h.turns.openAssistantTurn()).toBe(false);
		expect(h.turns.isDone("a1")).toBe(true);
	});

	it("clears a pending user turn only with an assistant turn created after it and done", () => {
		const h = ledger();
		h.at(100);
		h.turns.created("old", "assistant");
		h.at(200);
		h.turns.speakerActive();
		h.turns.userEvidence();
		// 2884 s3: the old answer's done arrives after the new user delta.
		h.at(300);
		h.turns.done("old", "assistant");
		expect(h.turns.pendingUserTurn()).toBe(true);
		h.at(400);
		h.turns.created("new", "assistant");
		expect(h.turns.pendingUserTurn()).toBe(true);
		h.at(900);
		h.turns.done("new", "assistant");
		expect(h.turns.pendingUserTurn()).toBe(false);
	});

	it("keeps the user turn pending when the data channel never reports an assistant turn", () => {
		const h = ledger();
		h.turns.speakerActive();
		h.turns.userEvidence();
		expect(h.turns.pendingUserTurn()).toBe(true);
	});

	it("ignores user evidence that trails an answer when nobody spoke since (late transcript)", () => {
		const h = ledger();
		h.at(0);
		h.turns.speakerActive();
		h.turns.userEvidence();
		h.at(10);
		h.turns.created("answer", "assistant");
		// probe-run2: the user's final transcript landed 7 ms after this.
		h.at(17);
		h.turns.userEvidence();
		h.at(500);
		h.turns.done("answer", "assistant");
		expect(h.turns.pendingUserTurn()).toBe(false);
		// Someone speaks again: that evidence counts.
		h.at(600);
		h.turns.speakerActive();
		h.turns.userEvidence();
		expect(h.turns.pendingUserTurn()).toBe(true);
	});

	it("binds the first assistant turn created after a time and never an ended one", () => {
		const h = ledger();
		h.at(0);
		h.turns.created("before", "assistant");
		h.at(50);
		expect(h.turns.firstAssistantCreatedAfter(40)).toBeUndefined();
		h.at(60);
		h.turns.created("after", "assistant");
		expect(h.turns.firstAssistantCreatedAfter(40)).toBe("after");
		h.turns.done("after", "assistant");
		expect(h.turns.firstAssistantCreatedAfter(40)).toBeUndefined();
	});

	it("forgets everything on reset", () => {
		const h = ledger();
		h.turns.created("a", "assistant");
		h.turns.speakerActive();
		h.turns.userEvidence();
		h.turns.reset();
		expect(h.turns.openAssistantTurn()).toBe(false);
		expect(h.turns.pendingUserTurn()).toBe(false);
	});
});
