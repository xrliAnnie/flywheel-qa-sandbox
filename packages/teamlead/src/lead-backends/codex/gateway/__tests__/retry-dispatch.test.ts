/**
 * FLY-245 D2 — gateway-side retry reconciler: the §5.2.1 postcondition for the
 * one NON-idempotent lifecycle action. Replaces D-f's fail-closed
 * `needs_reconfirm` placeholder for `retry` rows: recovery reconciles against
 * AUTHORITATIVE started evidence (the Runner's self-registered non-`:pending`
 * live tmux identity — never the intent marker, never an early
 * `session_started` event) and the pre-bound successor execId makes a re-drive
 * idempotent (the Bridge's find-or-create converges to exactly one started
 * execution).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StartedEvidence } from "../../../../bridge/started-evidence.js";
import { LifecycleRequestStore } from "../lifecycle-requests.js";
import { makeRetryDispatchPostcondition } from "../retry-dispatch.js";

const BASE = {
	requestId: "req-1",
	questionId: "q-1",
	action: "retry",
	execId: "pred-1",
	lifecycleRevision: 3,
	nonce: "n1",
	project: "geoforge3d",
	leadId: "product-lead",
	ttlMs: 600_000,
};

let dir: string;
let store: LifecycleRequestStore;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "fly245-d2-gw-"));
	store = new LifecycleRequestStore(join(dir, "lr.db"), () => 1_000_000);
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

function evidence(res: StartedEvidence) {
	return vi.fn(async (_e: string, _p: string) => res);
}

function rowWithSuccessor(successor?: string) {
	store.create(BASE);
	if (successor) {
		expect(store.bindSuccessorExecId("req-1", successor)).toBe(true);
	}
	const row = store.get("req-1");
	if (!row) throw new Error("row missing");
	return row;
}

describe("LifecycleRequestStore.bindSuccessorExecId (D2 pre-binding)", () => {
	it("binds once and persists across reopen (durable BEFORE the HTTP dispatch)", () => {
		rowWithSuccessor("succ-1");
		store.close();
		store = new LifecycleRequestStore(join(dir, "lr.db"), () => 1_000_000);
		expect(store.get("req-1")?.successorExecId).toBe("succ-1");
	});

	it("re-binding the SAME id is idempotent (replay-safe)", () => {
		rowWithSuccessor("succ-1");
		expect(store.bindSuccessorExecId("req-1", "succ-1")).toBe(true);
		expect(store.get("req-1")?.successorExecId).toBe("succ-1");
	});

	it("binding a DIFFERENT id is refused — one successor per request, ever", () => {
		rowWithSuccessor("succ-1");
		expect(store.bindSuccessorExecId("req-1", "succ-OTHER")).toBe(false);
		expect(store.get("req-1")?.successorExecId).toBe("succ-1");
	});

	it("unbound rows read back null", () => {
		rowWithSuccessor();
		expect(store.get("req-1")?.successorExecId).toBeNull();
	});

	it("binding an unknown request id returns false", () => {
		expect(store.bindSuccessorExecId("nope", "succ-1")).toBe(false);
	});
});

describe("makeRetryDispatchPostcondition (D2 recovery verdicts)", () => {
	it("no successor bound → retry_safe (nothing could have started; re-drive binds first)", async () => {
		const row = rowWithSuccessor();
		const check = evidence({ started: true, tmuxWindow: "x:@1" });
		const verdict = await makeRetryDispatchPostcondition({
			checkEvidence: check,
		})(row);
		expect(verdict).toBe("retry_safe");
		expect(check).not.toHaveBeenCalled();
	});

	it("successor bound + AUTHORITATIVE started evidence → reached (never start a second runner)", async () => {
		const row = rowWithSuccessor("succ-1");
		const check = evidence({ started: true, tmuxWindow: "runner:@7" });
		const verdict = await makeRetryDispatchPostcondition({
			checkEvidence: check,
		})(row);
		expect(verdict).toBe("reached");
		// the evidence was consulted for the SUCCESSOR id, not the predecessor
		expect(check).toHaveBeenCalledWith("succ-1", "geoforge3d");
	});

	it("successor bound + no_row/pending/tmux_dead → retry_safe (idempotent re-drive by key)", async () => {
		for (const reason of ["no_row", "pending_only", "tmux_dead"] as const) {
			const verdict = await makeRetryDispatchPostcondition({
				checkEvidence: evidence({ started: false, reason }),
			})(rowWithSuccessor("succ-1"));
			expect(verdict).toBe("retry_safe");
			store.close();
			rmSync(dir, { recursive: true, force: true });
			dir = mkdtempSync(join(tmpdir(), "fly245-d2-gw-"));
			store = new LifecycleRequestStore(join(dir, "lr.db"), () => 1_000_000);
		}
	});

	it("lookup_error → needs_reconfirm (fail-closed: cannot prove, never re-drive blind)", async () => {
		const verdict = await makeRetryDispatchPostcondition({
			checkEvidence: evidence({ started: false, reason: "lookup_error" }),
		})(rowWithSuccessor("succ-1"));
		expect(verdict).toBe("needs_reconfirm");
	});

	it("a THROWN evidence check → needs_reconfirm (fail-closed)", async () => {
		const verdict = await makeRetryDispatchPostcondition({
			checkEvidence: vi.fn(async () => {
				throw new Error("comm db unreadable");
			}),
		})(rowWithSuccessor("succ-1"));
		expect(verdict).toBe("needs_reconfirm");
	});
});
