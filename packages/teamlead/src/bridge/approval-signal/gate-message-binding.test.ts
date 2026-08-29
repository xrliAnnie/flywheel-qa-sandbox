/**
 * FLY-799 Part A-0b — durable ship-gate message binding (RED first).
 *
 * ReactionSource needs an authoritative `(questionId, prHeadSha) → gateMessageId`
 * binding — the Discord id of the "🚀 Ship gate" message the founder reacts on.
 * These are the pure pieces (Codex R3 #1 / R4 #2): extract the created message
 * id from the notifier's Discord POST response, and select the ONE current
 * binding fail-closed (exactly one match for the current question+head, else
 * null → no approval).
 */

import { describe, expect, it } from "vitest";
import type { GateMessageBinding } from "../approval-signal/gate-message-binding.js";
import {
	bindingEventId,
	extractGateMessageId,
	selectCurrentBinding,
} from "../approval-signal/gate-message-binding.js";

describe("extractGateMessageId", () => {
	it("extracts .id from a Discord create-message response", () => {
		expect(extractGateMessageId({ id: "111", channel_id: "T" })).toBe("111");
	});
	it("null for missing / non-string id or non-object", () => {
		expect(extractGateMessageId({ channel_id: "T" })).toBeNull();
		expect(extractGateMessageId({ id: 111 })).toBeNull();
		expect(extractGateMessageId(null)).toBeNull();
		expect(extractGateMessageId("nope")).toBeNull();
	});
});

describe("bindingEventId — stable + immutable per (question, head) revision (FLY-945 Fix B)", () => {
	const H1 = "a".repeat(40);
	const H2 = "b".repeat(40);
	it("is deterministic per (questionId, prHeadSha)", () => {
		expect(bindingEventId("Q-1", H1)).toBe(bindingEventId("Q-1", H1));
		expect(bindingEventId("Q-1", H1)).not.toBe(bindingEventId("Q-2", H1));
	});
	it("a NEW head for the same question is a NEW revision id (rebind anchor)", () => {
		expect(bindingEventId("Q-1", H1)).not.toBe(bindingEventId("Q-1", H2));
	});
	it("carries the FULL 40-hex head, case-normalized (Codex R2 #4: an 8-char prefix is display-only)", () => {
		expect(bindingEventId("Q-1", H1)).toContain(H1);
		expect(bindingEventId("Q-1", H1.toUpperCase())).toBe(
			bindingEventId("Q-1", H1),
		);
	});
});

const mk = (over: Partial<GateMessageBinding>): GateMessageBinding => ({
	questionId: "Q-1",
	executionId: "E-1",
	issueId: "I-1",
	prHeadSha: "a".repeat(40),
	threadId: "T-1",
	gateMessageId: "GATE-1",
	checkpoint: "approve_to_ship",
	postedAt: "2026-07-02T00:00:00Z",
	...over,
});

describe("selectCurrentBinding — fail-closed exactly-one", () => {
	const head = "a".repeat(40);

	it("returns the single matching binding", () => {
		const b = mk({});
		expect(selectCurrentBinding([b], "Q-1", head)).toEqual(b);
	});

	it("null when no binding matches the question", () => {
		expect(
			selectCurrentBinding([mk({ questionId: "Q-OTHER" })], "Q-1", head),
		).toBeNull();
	});

	it("null when the head mismatches (stale binding)", () => {
		expect(
			selectCurrentBinding([mk({ prHeadSha: "b".repeat(40) })], "Q-1", head),
		).toBeNull();
	});

	it("null when MORE THAN ONE binding matches (ambiguous → fail-closed)", () => {
		expect(
			selectCurrentBinding(
				[mk({ gateMessageId: "G1" }), mk({ gateMessageId: "G2" })],
				"Q-1",
				head,
			),
		).toBeNull();
	});

	it("null on empty binding set", () => {
		expect(selectCurrentBinding([], "Q-1", head)).toBeNull();
	});
});
