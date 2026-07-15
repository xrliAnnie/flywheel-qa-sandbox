/**
 * FLY-799 Part A-0b — durable binding persistence over StateStore (RED first).
 *
 * Persists the ship-gate message binding as a write-once session_event
 * (bindingEventId → insertEvent UNIQUE → immutable) and reads back the ONE
 * current binding fail-closed. Uses a real in-memory StateStore.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../../StateStore.js";
import type { GateMessageBinding } from "../approval-signal/gate-message-binding.js";
import {
	readCurrentGateMessageBinding,
	writeGateMessageBinding,
} from "../approval-signal/gate-message-binding-store.js";

const HEAD = "a".repeat(40);
const binding = (
	over: Partial<GateMessageBinding> = {},
): GateMessageBinding => ({
	questionId: "Q-1",
	executionId: "E-1",
	issueId: "I-1",
	prHeadSha: HEAD,
	threadId: "T-1",
	gateMessageId: "GATE-1",
	checkpoint: "approve_to_ship",
	postedAt: "2026-07-02T00:00:00Z",
	...over,
});

describe("gate-message-binding store", () => {
	let store: StateStore;
	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	it("writes a binding and reads back the current one", () => {
		expect(writeGateMessageBinding(store, binding(), "proj")).toBe(true);
		const got = readCurrentGateMessageBinding(store, "E-1", "Q-1", HEAD);
		expect(got).toMatchObject({ gateMessageId: "GATE-1", questionId: "Q-1" });
	});

	it("is write-once/immutable: a second write for the same question is ignored", () => {
		expect(writeGateMessageBinding(store, binding(), "proj")).toBe(true);
		// second attempt (e.g. a duplicate notification) must NOT overwrite
		expect(
			writeGateMessageBinding(
				store,
				binding({ gateMessageId: "GATE-2" }),
				"proj",
			),
		).toBe(false);
		const got = readCurrentGateMessageBinding(store, "E-1", "Q-1", HEAD);
		expect(got?.gateMessageId).toBe("GATE-1");
	});

	it("read is null when the head mismatches (stale binding)", () => {
		writeGateMessageBinding(store, binding(), "proj");
		expect(
			readCurrentGateMessageBinding(store, "E-1", "Q-1", "b".repeat(40)),
		).toBeNull();
	});

	it("read is null when there is no binding", () => {
		expect(readCurrentGateMessageBinding(store, "E-1", "Q-1", HEAD)).toBeNull();
	});

	// ── FLY-945 Fix B: revision semantics — one write-once row PER (question, head) ──

	it("a NEW head for the same question creates a NEW revision row (rebind anchor)", () => {
		const NEW_HEAD = "b".repeat(40);
		expect(writeGateMessageBinding(store, binding(), "proj")).toBe(true);
		expect(
			writeGateMessageBinding(
				store,
				binding({ prHeadSha: NEW_HEAD, gateMessageId: "GATE-REBOUND" }),
				"proj",
			),
		).toBe(true); // NOT swallowed by the old head's UNIQUE row
		// current head resolves the new anchor; the old head row remains readable
		expect(
			readCurrentGateMessageBinding(store, "E-1", "Q-1", NEW_HEAD)
				?.gateMessageId,
		).toBe("GATE-REBOUND");
		expect(
			readCurrentGateMessageBinding(store, "E-1", "Q-1", HEAD)?.gateMessageId,
		).toBe("GATE-1");
	});

	it("same (question, head) twice stays idempotent after the revision change", () => {
		expect(writeGateMessageBinding(store, binding(), "proj")).toBe(true);
		expect(
			writeGateMessageBinding(
				store,
				binding({ gateMessageId: "GATE-2" }),
				"proj",
			),
		).toBe(false);
		expect(
			readCurrentGateMessageBinding(store, "E-1", "Q-1", HEAD)?.gateMessageId,
		).toBe("GATE-1");
	});
});
