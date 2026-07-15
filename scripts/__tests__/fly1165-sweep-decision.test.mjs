/**
 * FLY-1165 deliverable 1 — safety-core tests for the done-thread sweep script.
 *
 * Covers the pure decision function (decideThreadAction) AND the main-loop
 * orchestration (processThread with fully injected io) so the loop is proven
 * to obey the decision, not just the decision itself (Codex design R2 #1).
 *
 * Run: node --test scripts/__tests__/fly1165-sweep-decision.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	decideThreadAction,
	processThread,
} from "../fly1165-archive-done-threads.mjs";

// ---------------------------------------------------------------------------
// decideThreadAction — pure decision function
// ---------------------------------------------------------------------------

test("1. Done + all dead + mixed statuses → archive; finalizeExecIds only the awaiting_review row", () => {
	const d = decideThreadAction({
		linear: { stateType: "completed", identifier: "FLY-980" },
		sessions: [
			{ execution_id: "exec-husk", status: "awaiting_review", live: false },
			{ execution_id: "exec-done", status: "completed", live: false },
		],
	});
	assert.equal(d.action, "archive");
	assert.deepEqual(d.finalizeExecIds, ["exec-husk"]);
});

test("2. Done + one LIVE awaiting_review → skip live_session, finalizeExecIds empty", () => {
	const d = decideThreadAction({
		linear: { stateType: "completed", identifier: "FLY-111" },
		sessions: [
			{ execution_id: "exec-live", status: "awaiting_review", live: true },
			{ execution_id: "exec-dead", status: "completed", live: false },
		],
	});
	assert.equal(d.action, "skip");
	assert.equal(d.reason, "live_session");
	assert.deepEqual(d.finalizeExecIds, []);
});

test("3. Done + terminal-status (completed) row ALIVE → skip live_session", () => {
	// Terminal DB status does not imply a dead process (HeartbeatService.ts:872
	// production precedent) — a live process on ANY status row vetoes.
	const d = decideThreadAction({
		linear: { stateType: "completed", identifier: "FLY-222" },
		sessions: [{ execution_id: "exec-t", status: "completed", live: true }],
	});
	assert.equal(d.action, "skip");
	assert.equal(d.reason, "live_session");
});

test("4. live:'error' (probe failure) → skip live_session (fail-closed)", () => {
	const d = decideThreadAction({
		linear: { stateType: "completed", identifier: "FLY-333" },
		sessions: [{ execution_id: "exec-e", status: "completed", live: "error" }],
	});
	assert.equal(d.action, "skip");
	assert.equal(d.reason, "live_session");
});

test("5. Linear active (started) → skip active_in_linear", () => {
	const d = decideThreadAction({
		linear: { stateType: "started", identifier: "FLY-1165" },
		sessions: [],
	});
	assert.equal(d.action, "skip");
	assert.equal(d.reason, "active_in_linear");
});

test("5b. Linear unstarted/backlog → skip active_in_linear", () => {
	for (const stateType of ["unstarted", "backlog", "triage"]) {
		const d = decideThreadAction({
			linear: { stateType, identifier: "FLY-1" },
			sessions: [],
		});
		assert.equal(d.action, "skip", stateType);
		assert.equal(d.reason, "active_in_linear", stateType);
	}
});

test("6. Linear null or {error:true} → skip unresolved (fail-closed)", () => {
	for (const linear of [null, { error: true }]) {
		const d = decideThreadAction({ linear, sessions: [] });
		assert.equal(d.action, "skip");
		assert.equal(d.reason, "unresolved");
	}
});

test("7. Canceled + no sessions → archive, no finalize", () => {
	const d = decideThreadAction({
		linear: { stateType: "canceled", identifier: "FLY-444" },
		sessions: [],
	});
	assert.equal(d.action, "archive");
	assert.deepEqual(d.finalizeExecIds, []);
});

test("7b. finalizeExecIds covers every FINALIZE_DONE_SOURCE_STATES status on dead rows", () => {
	const d = decideThreadAction({
		linear: { stateType: "completed", identifier: "FLY-555" },
		sessions: [
			{ execution_id: "e-run", status: "running", live: false },
			{ execution_id: "e-await", status: "awaiting_review", live: false },
			{ execution_id: "e-appr", status: "approved_to_ship", live: false },
			{ execution_id: "e-des", status: "design_done", live: false },
			{ execution_id: "e-block", status: "blocked", live: false },
			{ execution_id: "e-fail", status: "failed", live: false },
		],
	});
	assert.equal(d.action, "archive");
	assert.deepEqual(d.finalizeExecIds.sort(), [
		"e-appr",
		"e-await",
		"e-des",
		"e-run",
	]);
});

// ---------------------------------------------------------------------------
// processThread — main-loop orchestration obeys the decision (injected io)
// ---------------------------------------------------------------------------

function makeIo(overrides = {}) {
	const calls = { closeRunner: [], archiveThread: [], records: [] };
	const io = {
		fetchLinear: async () => ({ stateType: "completed", identifier: "FLY-9" }),
		listSessions: () => [],
		probeTmux: async () => false,
		closeRunner: async (execId) => {
			calls.closeRunner.push(execId);
			return { closed: true, alreadyGone: false };
		},
		archiveThread: async (row) => {
			calls.archiveThread.push(row);
			return { archived: true, reason: "archived" };
		},
		record: (category, row, detail) => {
			calls.records.push({ category, row, detail });
		},
		...overrides,
	};
	return { io, calls };
}

const ROW = { thread_id: "t-1", issue_id: "FLY-9", channel_id: "c-1" };

test("8. skip decision (live session) → closeRunner and archiveThread never called", async () => {
	const { io, calls } = makeIo({
		listSessions: () => [{ execution_id: "e-1", status: "awaiting_review" }],
		probeTmux: async () => true,
	});
	const out = await processThread(ROW, io);
	assert.equal(out.outcome, "live_session");
	assert.equal(calls.closeRunner.length, 0);
	assert.equal(calls.archiveThread.length, 0);
	assert.equal(calls.records[0].category, "skipped_live_session");
});

test("9. archive decision but finalize returns closed:false → husk_finalize_failed, archiveThread NOT called", async () => {
	const { io, calls } = makeIo({
		listSessions: () => [
			{ execution_id: "e-bad", status: "awaiting_review" },
			{ execution_id: "e-ok", status: "running" },
		],
		closeRunner: async (execId) => {
			calls.closeRunner.push(execId);
			return execId === "e-bad"
				? { closed: false, alreadyGone: false }
				: { closed: true, alreadyGone: false };
		},
	});
	// Bypass the makeIo default closeRunner push (we replaced it wholesale).
	const out = await processThread(ROW, io);
	assert.equal(out.outcome, "husk_finalize_failed");
	assert.equal(calls.archiveThread.length, 0);
	assert.ok(
		calls.records.some((r) => r.category === "husk_finalize_failed"),
		"must record husk_finalize_failed",
	);
});

test("9b. finalize throwing → husk_finalize_failed, archiveThread NOT called", async () => {
	const { io, calls } = makeIo({
		listSessions: () => [{ execution_id: "e-x", status: "running" }],
		closeRunner: async () => {
			throw new Error("network down");
		},
	});
	const out = await processThread(ROW, io);
	assert.equal(out.outcome, "husk_finalize_failed");
	assert.equal(calls.archiveThread.length, 0);
});

test("10. archive decision + finalize all closed||alreadyGone → archiveThread exactly once", async () => {
	const { io, calls } = makeIo({
		listSessions: () => [
			{ execution_id: "e-1", status: "awaiting_review" },
			{ execution_id: "e-2", status: "approved_to_ship" },
		],
		closeRunner: async (execId) => {
			calls.closeRunner.push(execId);
			return execId === "e-1"
				? { closed: true, alreadyGone: false }
				: { closed: false, alreadyGone: true };
		},
	});
	const out = await processThread(ROW, io);
	assert.equal(out.outcome, "archived");
	assert.equal(calls.archiveThread.length, 1);
	assert.equal(calls.closeRunner.length, 2);
	assert.equal(
		calls.records.filter((r) => r.category === "husk_finalized").length,
		2,
	);
});

test("10b. already_archived response counts as archived (FLY-980 idempotent re-sweep)", async () => {
	const { io, calls } = makeIo({
		archiveThread: async (row) => {
			calls.archiveThread.push(row);
			return { archived: true, reason: "already_archived" };
		},
	});
	const out = await processThread(ROW, io);
	assert.equal(out.outcome, "archived");
});

test("10c. archive endpoint failure (archived:false) → archive_failed recorded", async () => {
	const { io, calls } = makeIo({
		archiveThread: async (row) => {
			calls.archiveThread.push(row);
			return { archived: false, reason: "missing", error: "404" };
		},
	});
	const out = await processThread(ROW, io);
	assert.equal(out.outcome, "archive_failed");
	assert.ok(calls.records.some((r) => r.category === "archive_failed"));
});

test("10d. TOCTOU during closeRunner: live session appears mid-finalize → re-veto blocks the archive (Codex R1 #1)", async () => {
	let liveNow = false;
	const { io, calls } = makeIo({
		listSessions: () =>
			liveNow
				? [
						{ execution_id: "e-husk", status: "awaiting_review" },
						{ execution_id: "e-new", status: "running" },
					]
				: [{ execution_id: "e-husk", status: "awaiting_review" }],
		probeTmux: async () => liveNow,
		closeRunner: async (execId) => {
			calls.closeRunner.push(execId);
			// A new run starts while the finalize awaits cmux/tmux teardown.
			liveNow = true;
			return { closed: true, alreadyGone: false };
		},
	});
	const out = await processThread(ROW, io);
	assert.equal(out.outcome, "live_session");
	assert.equal(calls.archiveThread.length, 0);
	assert.ok(
		calls.records.some((r) => r.category === "skipped_live_session"),
		"must record the re-veto skip",
	);
});

test("10e. no finalize needed → single gather, no redundant re-check calls", async () => {
	let linearCalls = 0;
	const { io, calls } = makeIo({
		fetchLinear: async () => {
			linearCalls++;
			return { stateType: "completed", identifier: "FLY-9" };
		},
	});
	const out = await processThread(ROW, io);
	assert.equal(out.outcome, "archived");
	assert.equal(linearCalls, 1);
	assert.equal(calls.archiveThread.length, 1);
});

test("11. unresolved Linear → skip, zero session/liveness side effects reach write io", async () => {
	const { io, calls } = makeIo({
		fetchLinear: async () => ({ error: true }),
		listSessions: () => [{ execution_id: "e-1", status: "awaiting_review" }],
	});
	const out = await processThread(ROW, io);
	assert.equal(out.outcome, "unresolved");
	assert.equal(calls.closeRunner.length, 0);
	assert.equal(calls.archiveThread.length, 0);
});
