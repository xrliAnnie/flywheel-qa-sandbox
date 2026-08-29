/**
 * FLY-598: founder-ux gate — sign-off record + Layer B stage-guard unit tests.
 * Pure StateStore-backed logic (no Discord/HTTP), so exhaustively testable.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../../../StateStore.js";
import {
	type FounderUxSignoff,
	readSignoff,
	signoffSatisfies,
	writeSignoff,
} from "../signoff.js";
import {
	evaluateFounderUxStageGuard,
	FOUNDER_UX_SIGNOFF_REQUIRED,
} from "../stage-guard.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

async function storeWithSession(
	overrides: Partial<{ founder_facing_ux: number }> = {},
): Promise<StateStore> {
	const store = await StateStore.create(":memory:");
	store.upsertSession({
		execution_id: "exec-1",
		issue_id: "ISSUE-1",
		project_name: "proj",
		status: "running",
	});
	// founder_facing_ux is set post-creation in production (runs-route label
	// snapshot / declare-founder-ux), via patchSessionMetadata — not upsertSession.
	if (overrides.founder_facing_ux !== undefined) {
		store.patchSessionMetadata("exec-1", {
			founder_facing_ux: overrides.founder_facing_ux,
		});
	}
	return store;
}

const validSignoff = (uxHash: string): FounderUxSignoff => ({
	uxHash,
	annieMsgId: "msg-1",
	fetchedExcerpt: "可以",
	ts: new Date().toISOString(),
	auditId: "audit-1",
});

describe("FLY-598 sign-off record", () => {
	let store: StateStore;
	beforeEach(async () => {
		store = await storeWithSession();
	});

	it("readSignoff returns null when none recorded", () => {
		expect(readSignoff(store, "exec-1")).toBeNull();
	});

	it("writeSignoff persists the record and marks the run founder-facing", () => {
		writeSignoff(store, "exec-1", validSignoff(HASH_A));
		const got = readSignoff(store, "exec-1");
		expect(got?.uxHash).toBe(HASH_A);
		expect(got?.annieMsgId).toBe("msg-1");
		expect(store.getSession("exec-1")?.founder_facing_ux).toBe(true);
	});

	it("readSignoff returns null on malformed JSON", () => {
		store.patchSessionMetadata("exec-1", {
			founder_ux_signoff_json: "{not json",
		});
		expect(readSignoff(store, "exec-1")).toBeNull();
	});

	it("signoffSatisfies is true only for the exact bound uxHash", () => {
		writeSignoff(store, "exec-1", validSignoff(HASH_A));
		expect(signoffSatisfies(store, "exec-1", HASH_A)).toBe(true);
		expect(signoffSatisfies(store, "exec-1", HASH_B)).toBe(false); // stale brief
		expect(signoffSatisfies(store, "exec-1", "")).toBe(false); // fail-closed
	});

	it("signoffSatisfies is false when no sign-off exists", () => {
		expect(signoffSatisfies(store, "exec-1", HASH_A)).toBe(false);
	});
});

describe("FLY-598 stage guard (Layer B)", () => {
	it("passes any stage other than implement", async () => {
		const store = await storeWithSession({ founder_facing_ux: 1 });
		expect(
			evaluateFounderUxStageGuard(store, "enforce", {
				executionId: "exec-1",
				incomingStage: "test",
			}).decision,
		).toBe("pass");
	});

	it("passes when mode is off (byte-compatible no-op)", async () => {
		const store = await storeWithSession({ founder_facing_ux: 1 });
		expect(
			evaluateFounderUxStageGuard(store, "off", {
				executionId: "exec-1",
				incomingStage: "implement",
				uxHash: HASH_A,
			}).decision,
		).toBe("pass");
	});

	it("passes a non-founder-facing run", async () => {
		const store = await storeWithSession({ founder_facing_ux: 0 });
		expect(
			evaluateFounderUxStageGuard(store, "enforce", {
				executionId: "exec-1",
				incomingStage: "implement",
				uxHash: HASH_A,
			}).decision,
		).toBe("pass");
	});

	it("passes a founder-facing run with a verified sign-off for the current uxHash", async () => {
		const store = await storeWithSession({ founder_facing_ux: 1 });
		writeSignoff(store, "exec-1", validSignoff(HASH_A));
		expect(
			evaluateFounderUxStageGuard(store, "enforce", {
				executionId: "exec-1",
				incomingStage: "implement",
				uxHash: HASH_A,
			}).decision,
		).toBe("pass");
	});

	it("audits (does not block) in audit_only when sign-off missing", async () => {
		const store = await storeWithSession({ founder_facing_ux: 1 });
		const d = evaluateFounderUxStageGuard(store, "audit_only", {
			executionId: "exec-1",
			incomingStage: "implement",
			uxHash: HASH_A,
		});
		expect(d.decision).toBe("audit");
	});

	it("BLOCKS in enforce when founder-facing run has no sign-off", async () => {
		const store = await storeWithSession({ founder_facing_ux: 1 });
		const d = evaluateFounderUxStageGuard(store, "enforce", {
			executionId: "exec-1",
			incomingStage: "implement",
			uxHash: HASH_A,
		});
		expect(d.decision).toBe("block");
		if (d.decision === "block")
			expect(d.code).toBe(FOUNDER_UX_SIGNOFF_REQUIRED);
	});

	it("BLOCKS in enforce on a STALE sign-off (signed for a different brief)", async () => {
		const store = await storeWithSession({ founder_facing_ux: 1 });
		writeSignoff(store, "exec-1", validSignoff(HASH_B)); // old brief
		const d = evaluateFounderUxStageGuard(store, "enforce", {
			executionId: "exec-1",
			incomingStage: "implement",
			uxHash: HASH_A, // current brief
		});
		expect(d.decision).toBe("block");
	});

	it("BLOCKS in enforce when a founder-facing implement carries NO ux_hash (fail-closed)", async () => {
		const store = await storeWithSession({ founder_facing_ux: 1 });
		writeSignoff(store, "exec-1", validSignoff(HASH_A));
		const d = evaluateFounderUxStageGuard(store, "enforce", {
			executionId: "exec-1",
			incomingStage: "implement",
			// no uxHash
		});
		expect(d.decision).toBe("block");
	});
});
