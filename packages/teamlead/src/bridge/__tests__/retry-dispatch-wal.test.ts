/**
 * FLY-245 D2 — gateway-retry reconcile against the durable intent WAL
 * (plan §5.2.1, R3/R4-HIGH). The §8 D2 crash-window matrix at the decision
 * layer:
 *   ① crash after gateway binding / before the Bridge intent → no intent row →
 *     first-attempt: record intent (the WAL commit is BEFORE dispatch).
 *   ② crash after intent commit / before blueprint.run() → intent row, no
 *     started evidence → idempotent re-drive with the SAME successor id.
 *   ③ partial startup (run() begun, no self-registration) → pending-only
 *     evidence → same-execId re-drive (find-or-create converges).
 *   ⑤ same request id replay after success → converged: return the successor,
 *     persist lineage, NEVER a second dispatch.
 *   conflict: one request id can never bind a second successor id.
 *   fail-closed: unprovable evidence (lookup_error / throw) never re-drives.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { reconcileGatewayRetry } from "../retry-dispatch-wal.js";
import type { StartedEvidence } from "../started-evidence.js";

const ARGS = {
	gatewayRequestId: "gwreq-1",
	successorExecutionId: "succ-1",
	predecessorExecutionId: "pred-1",
	projectName: "geoforge3d",
};

function evidence(res: StartedEvidence) {
	return vi.fn(async (_e: string, _p: string) => res);
}

describe("reconcileGatewayRetry (D2)", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		store.upsertSession({
			execution_id: "pred-1",
			issue_id: "FLY-1",
			project_name: "geoforge3d",
			status: "failed",
		});
	});

	it("① first attempt: records the intent WAL and proceeds (binding committed BEFORE dispatch)", async () => {
		const check = evidence({ started: false, reason: "no_row" });
		const verdict = await reconcileGatewayRetry(store, ARGS, {
			checkEvidence: check,
		});
		expect(verdict).toEqual({ kind: "proceed", firstAttempt: true });
		// the WAL row is durable NOW — a crash before dispatch leaves the binding
		const intent = store.getRetryDispatchIntent("gwreq-1");
		expect(intent?.successor_execution_id).toBe("succ-1");
		expect(intent?.predecessor_execution_id).toBe("pred-1");
		expect(intent?.state).toBe("intent");
		// evidence is NOT consulted on a first attempt — nothing can have started
		expect(check).not.toHaveBeenCalled();
	});

	it("② replay with intent + no started evidence → proceed (re-drive, same successor id)", async () => {
		store.recordRetryDispatchIntent("gwreq-1", "succ-1", "pred-1");
		const verdict = await reconcileGatewayRetry(store, ARGS, {
			checkEvidence: evidence({ started: false, reason: "no_row" }),
		});
		expect(verdict).toEqual({ kind: "proceed", firstAttempt: false });
		// still exactly one binding
		expect(
			store.getRetryDispatchIntent("gwreq-1")?.successor_execution_id,
		).toBe("succ-1");
	});

	it("③ replay with pending-only evidence → proceed (partial startup converges by execId)", async () => {
		store.recordRetryDispatchIntent("gwreq-1", "succ-1", "pred-1");
		const verdict = await reconcileGatewayRetry(store, ARGS, {
			checkEvidence: evidence({ started: false, reason: "pending_only" }),
		});
		expect(verdict).toEqual({ kind: "proceed", firstAttempt: false });
	});

	it("⑤ replay with AUTHORITATIVE started evidence → converged: lineage persisted, no re-dispatch", async () => {
		store.recordRetryDispatchIntent("gwreq-1", "succ-1", "pred-1");
		const verdict = await reconcileGatewayRetry(store, ARGS, {
			checkEvidence: evidence({ started: true, tmuxWindow: "runner:@7" }),
		});
		expect(verdict).toEqual({
			kind: "converged",
			successorExecutionId: "succ-1",
		});
		// the crash-window production bug: dispatch-before-setRetrySuccessor —
		// convergence must repair the lineage
		expect(store.getSession("pred-1")?.retry_successor).toBe("succ-1");
		expect(store.getRetryDispatchIntent("gwreq-1")?.state).toBe("dispatched");
	});

	it("conflict: a request id can NEVER bind a second successor id", async () => {
		store.recordRetryDispatchIntent("gwreq-1", "succ-1", "pred-1");
		const check = evidence({ started: false, reason: "no_row" });
		const verdict = await reconcileGatewayRetry(
			store,
			{ ...ARGS, successorExecutionId: "succ-OTHER" },
			{ checkEvidence: check },
		);
		expect(verdict).toEqual({
			kind: "conflict",
			boundSuccessorExecutionId: "succ-1",
		});
		// no dispatch decision, no evidence consult, binding unchanged
		expect(check).not.toHaveBeenCalled();
		expect(
			store.getRetryDispatchIntent("gwreq-1")?.successor_execution_id,
		).toBe("succ-1");
	});

	it("fail-closed: lookup_error evidence never re-drives (could start a SECOND runner)", async () => {
		store.recordRetryDispatchIntent("gwreq-1", "succ-1", "pred-1");
		const verdict = await reconcileGatewayRetry(store, ARGS, {
			checkEvidence: evidence({ started: false, reason: "lookup_error" }),
		});
		expect(verdict.kind).toBe("fail_closed");
	});

	it("fail-closed: a THROWN evidence check never re-drives", async () => {
		store.recordRetryDispatchIntent("gwreq-1", "succ-1", "pred-1");
		const verdict = await reconcileGatewayRetry(store, ARGS, {
			checkEvidence: vi.fn(async () => {
				throw new Error("comm db gone");
			}),
		});
		expect(verdict.kind).toBe("fail_closed");
	});

	it("fail-closed on missing/blank identifiers (boundary discipline)", async () => {
		const verdict = await reconcileGatewayRetry(
			store,
			{ ...ARGS, gatewayRequestId: "" },
			{ checkEvidence: evidence({ started: false, reason: "no_row" }) },
		);
		expect(verdict.kind).toBe("fail_closed");
	});
});

describe("StateStore.retry_dispatch_intents (D2 WAL)", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	it("record → get roundtrip, state=intent", () => {
		store.recordRetryDispatchIntent("gw-1", "succ-1", "pred-1");
		const row = store.getRetryDispatchIntent("gw-1");
		expect(row?.request_id).toBe("gw-1");
		expect(row?.successor_execution_id).toBe("succ-1");
		expect(row?.predecessor_execution_id).toBe("pred-1");
		expect(row?.state).toBe("intent");
	});

	it("unknown request id → undefined", () => {
		expect(store.getRetryDispatchIntent("nope")).toBeUndefined();
	});

	it("duplicate record for the same request id throws (PK — exactly one binding)", () => {
		store.recordRetryDispatchIntent("gw-1", "succ-1", "pred-1");
		expect(() =>
			store.recordRetryDispatchIntent("gw-1", "succ-2", "pred-1"),
		).toThrow();
	});

	it("markRetryDispatchDispatched flips state (informational — evidence stays authoritative)", () => {
		store.recordRetryDispatchIntent("gw-1", "succ-1", "pred-1");
		store.markRetryDispatchDispatched("gw-1");
		expect(store.getRetryDispatchIntent("gw-1")?.state).toBe("dispatched");
	});

	it("WAL survives a reopen (④ Bridge restart wipes in-memory inflight, not the WAL)", async () => {
		const { mkdtempSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "fly245-d2-wal-"));
		try {
			const path = join(dir, "teamlead.db");
			const s1 = await StateStore.create(path);
			s1.recordRetryDispatchIntent("gw-1", "succ-1", "pred-1");
			s1.close();
			const s2 = await StateStore.create(path);
			expect(s2.getRetryDispatchIntent("gw-1")?.successor_execution_id).toBe(
				"succ-1",
			);
			s2.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
