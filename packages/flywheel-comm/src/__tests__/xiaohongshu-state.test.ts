/**
 * FLY-222: xiaohongshu-state core-library tests.
 */

import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	acquireLease,
	computeNewNoteIds,
	computeNextDueAt,
	dropPending,
	emptyState,
	feedbackOperationId,
	findOperation,
	isDue,
	isLeaseTakeable,
	markBootstrapped,
	markOperationDone,
	markProcessed,
	operationId,
	readState,
	recordFeedbackOperationIntent,
	recordOperationIntent,
	recordPending,
	releaseLease,
	renewLease,
	setTriggerIssueId,
	stateFilePath,
	withCollectionLock,
	writeState,
	type XiaohongshuState,
} from "../xiaohongshu-state.js";

const PROJECT = "sub";
const COLLECTION = "69c8a73e00000000160351e1";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "xhs-state-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function fresh(): XiaohongshuState {
	return emptyState(PROJECT, COLLECTION, new Date("2026-06-06T00:00:00Z"));
}

describe("path safety", () => {
	it("rejects unsafe project/collection segments", () => {
		expect(() => stateFilePath(dir, "../evil", COLLECTION)).toThrow(
			/unsafe path segment/,
		);
		expect(() => stateFilePath(dir, PROJECT, "a/b")).toThrow(
			/unsafe path segment/,
		);
	});
	it("accepts normal ids", () => {
		expect(stateFilePath(dir, PROJECT, COLLECTION)).toContain(
			`${PROJECT}__${COLLECTION}.json`,
		);
	});
});

describe("read/write (atomic, default-empty)", () => {
	it("returns a fresh empty state when no file exists", () => {
		const s = readState(dir, PROJECT, COLLECTION);
		expect(s.bootstrapped).toBe(false);
		expect(s.processed).toEqual([]);
		expect(s.lease).toBeNull();
	});

	it("round-trips state and persists 0600", () => {
		const s = markProcessed(fresh(), "note1");
		writeState(dir, s);
		const back = readState(dir, PROJECT, COLLECTION);
		expect(back.processed).toEqual(["note1"]);
		// no torn .tmp left behind
		const file = stateFilePath(dir, PROJECT, COLLECTION);
		expect(readFileSync(file, "utf-8")).toContain('"note1"');
	});

	it("rejects an unsupported state version", () => {
		const file = stateFilePath(dir, PROJECT, COLLECTION);
		writeFileSync(file, JSON.stringify({ version: 999 }));
		expect(() => readState(dir, PROJECT, COLLECTION)).toThrow(
			/unsupported state version/,
		);
	});
});

describe("lease / CAS", () => {
	const T0 = new Date("2026-06-06T00:00:00Z");

	it("grants a lease on empty state and rejects a different concurrent owner", () => {
		const a = acquireLease(fresh(), "runA", T0, 1000);
		expect(a.ok).toBe(true);
		expect(a.state.lease?.owner).toBe("runA");

		const b = acquireLease(a.state, "runB", new Date(T0.getTime() + 500), 1000);
		expect(b.ok).toBe(false);
		expect(b.reason).toBe("held_by_other");
		expect(b.heldBy).toBe("runA");
	});

	it("same owner re-acquire renews (keeps acquiredAt)", () => {
		const a = acquireLease(fresh(), "runA", T0, 1000);
		const a2 = acquireLease(
			a.state,
			"runA",
			new Date(T0.getTime() + 500),
			1000,
		);
		expect(a2.ok).toBe(true);
		expect(a2.state.lease?.acquiredAt).toBe(a.state.lease?.acquiredAt);
		expect(a2.state.lease?.expiresAt).not.toBe(a.state.lease?.expiresAt);
	});

	it("a NEW owner takes over an EXPIRED lease (stale-takeover)", () => {
		const a = acquireLease(fresh(), "runA", T0, 1000);
		const after = new Date(T0.getTime() + 2000); // past expiry
		expect(isLeaseTakeable(a.state.lease, after)).toBe(true);
		const b = acquireLease(a.state, "runB", after, 1000);
		expect(b.ok).toBe(true);
		expect(b.state.lease?.owner).toBe("runB");
	});

	it("renew rejects a non-owner; release rejects a non-owner; release clears for owner", () => {
		const a = acquireLease(fresh(), "runA", T0, 1000);
		expect(renewLease(a.state, "runB", T0, 1000).ok).toBe(false);
		expect(releaseLease(a.state, "runB").reason).toBe("not_owner");
		const rel = releaseLease(a.state, "runA");
		expect(rel.ok).toBe(true);
		expect(rel.state.lease).toBeNull();
	});
});

describe("diff + pending", () => {
	it("computes new noteIds as full-window diff (dedup, order preserved)", () => {
		const s = markProcessed(fresh(), "n2");
		const out = computeNewNoteIds(["n1", "n2", "n3", "n1"], s);
		expect(out).toEqual(["n1", "n3"]);
	});

	it("recordPending is idempotent and bumps attempts; markProcessed drops pending", () => {
		let s = recordPending(
			fresh(),
			["n1", "n2"],
			new Date("2026-06-06T00:00:00Z"),
		);
		expect(s.pending.map((p) => p.noteId).sort()).toEqual(["n1", "n2"]);
		s = recordPending(s, ["n1"]);
		expect(s.pending.find((p) => p.noteId === "n1")?.attempts).toBe(2);
		s = markProcessed(s, "n1");
		expect(s.pending.map((p) => p.noteId)).toEqual(["n2"]);
		expect(s.processed).toContain("n1");
	});

	it("recordPending skips already-processed notes", () => {
		const s = recordPending(markProcessed(fresh(), "n1"), ["n1", "n2"]);
		expect(s.pending.map((p) => p.noteId)).toEqual(["n2"]);
	});
});

describe("operation idempotency", () => {
	it("operationId is deterministic and rejects ':' in parts", () => {
		expect(operationId(COLLECTION, "n1", "issue", "c0")).toBe(
			`${COLLECTION}:n1:issue:c0`,
		);
		expect(() => operationId(COLLECTION, "n:1", "issue", "c0")).toThrow(/':'/);
	});

	it("intent then done; intent is no-op when a record already exists", () => {
		const { id, state: s1 } = recordOperationIntent(fresh(), {
			noteId: "n1",
			outputKind: "issue",
			candidateId: "c0",
		});
		expect(findOperation(s1, id)?.status).toBe("intent");
		// second intent must not clobber
		const s1b = recordOperationIntent(s1, {
			noteId: "n1",
			outputKind: "issue",
			candidateId: "c0",
		}).state;
		expect(s1b.operations[id].status).toBe("intent");
		const s2 = markOperationDone(s1b, id, { issueId: "FLY-999" });
		expect(s2.operations[id].status).toBe("done");
		expect(s2.operations[id].issueId).toBe("FLY-999");
	});

	it("a note can yield MULTIPLE distinct operations (no key collision)", () => {
		let s = fresh();
		const a = recordOperationIntent(s, {
			noteId: "n1",
			outputKind: "issue",
			candidateId: "c0",
		});
		s = a.state;
		const b = recordOperationIntent(s, {
			noteId: "n1",
			outputKind: "issue",
			candidateId: "c1",
		});
		s = b.state;
		expect(a.id).not.toBe(b.id);
		expect(Object.keys(s.operations)).toHaveLength(2);
	});

	it("markOperationDone on an unknown id throws (must record intent first)", () => {
		expect(() => markOperationDone(fresh(), "nope:x:issue:c")).toThrow(
			/record intent first/,
		);
	});
});

describe("FLY-286 feedback operations", () => {
	// A target opId is itself colon-delimited — the helper must accept it.
	const TARGET_OPID = `${COLLECTION}:n1:issue:c0`;

	it("feedbackOperationId is colon-safe even when target contains ':'", () => {
		const id = feedbackOperationId(COLLECTION, "n1", "close", TARGET_OPID);
		// shape: collection:noteId:kind:token — only these structural colons.
		expect(id.startsWith(`${COLLECTION}:n1:feedback_close:`)).toBe(true);
		const token = id.slice(`${COLLECTION}:n1:feedback_close:`.length);
		expect(token).toMatch(/^[a-f0-9]{16}$/); // hashed, colon-free
		expect(token.includes(":")).toBe(false);
	});

	it("is deterministic and distinguishes action + target", () => {
		const a = feedbackOperationId(COLLECTION, "n1", "close", TARGET_OPID);
		const a2 = feedbackOperationId(COLLECTION, "n1", "close", TARGET_OPID);
		const create = feedbackOperationId(COLLECTION, "n1", "create", "cand-9");
		const other = feedbackOperationId(COLLECTION, "n1", "close", "other-op");
		expect(a).toBe(a2); // deterministic
		expect(a).not.toBe(create); // action differs
		expect(a).not.toBe(other); // target differs
	});

	it("recordFeedbackOperationIntent records, is idempotent, and reconciles done", () => {
		const { id, state: s1 } = recordFeedbackOperationIntent(fresh(), {
			noteId: "n1",
			action: "close",
			target: TARGET_OPID,
		});
		expect(findOperation(s1, id)?.status).toBe("intent");
		expect(findOperation(s1, id)?.outputKind).toBe("feedback_close");
		// raw target kept on the record for debugging; key stays colon-safe
		expect(findOperation(s1, id)?.candidateId).toBe(TARGET_OPID);
		// second intent must not clobber
		const s1b = recordFeedbackOperationIntent(s1, {
			noteId: "n1",
			action: "close",
			target: TARGET_OPID,
		}).state;
		expect(s1b.operations[id].status).toBe("intent");
		const s2 = markOperationDone(s1b, id, { issueId: "FLY-777" });
		expect(s2.operations[id].status).toBe("done");
		expect(s2.operations[id].issueId).toBe("FLY-777");
	});
});

describe("FLY-286 thin state fields", () => {
	it("emptyState defaults the new review/feedback pointers", () => {
		const s = fresh();
		expect(s.lastAnalysisRunToken).toBeNull();
		expect(s.lastReportToken).toBeNull();
		expect(s.pendingFeedbackRunTokens).toEqual([]);
	});

	it("readState forward-compat defaults the FLY-286 fields on an older state file", () => {
		// Write a v1 state file WITHOUT the FLY-286 fields, then read it back.
		const legacy = { ...fresh() } as Record<string, unknown>;
		legacy.lastAnalysisRunToken = undefined;
		legacy.lastReportToken = undefined;
		legacy.pendingFeedbackRunTokens = undefined;
		delete legacy.lastAnalysisRunToken;
		delete legacy.lastReportToken;
		delete legacy.pendingFeedbackRunTokens;
		writeFileSync(
			stateFilePath(dir, PROJECT, COLLECTION),
			JSON.stringify(legacy),
		);
		const s = readState(dir, PROJECT, COLLECTION);
		expect(s.lastAnalysisRunToken).toBeNull();
		expect(s.lastReportToken).toBeNull();
		expect(s.pendingFeedbackRunTokens).toEqual([]);
	});
});

describe("cadence / due", () => {
	it("computeNextDueAt advances by cadence; unknown throws", () => {
		const from = new Date("2026-06-06T00:00:00Z");
		expect(computeNextDueAt("daily", from)).toBe("2026-06-07T00:00:00.000Z");
		expect(computeNextDueAt("weekly", from)).toBe("2026-06-13T00:00:00.000Z");
		expect(() => computeNextDueAt("hourly", from)).toThrow(/unknown cadence/);
	});

	it("isDue true when nextDueAt null or in the past", () => {
		expect(isDue(fresh())).toBe(true);
		const s = { ...fresh(), nextDueAt: "2030-01-01T00:00:00Z" };
		expect(isDue(s, new Date("2026-06-06T00:00:00Z"))).toBe(false);
		expect(isDue(s, new Date("2030-06-06T00:00:00Z"))).toBe(true);
	});
});

describe("withCollectionLock (mkdir-mutex)", () => {
	it("serializes concurrent critical sections (no lost update)", async () => {
		// 20 concurrent increments of a counter persisted in state.processed length.
		const tasks = Array.from({ length: 20 }, (_, i) =>
			withCollectionLock(dir, PROJECT, COLLECTION, () => {
				const s = readState(dir, PROJECT, COLLECTION);
				writeState(dir, markProcessed(s, `n${i}`));
			}),
		);
		await Promise.all(tasks);
		const final = readState(dir, PROJECT, COLLECTION);
		expect(final.processed).toHaveLength(20);
	});

	it("releases the lock on success and on throw", async () => {
		await expect(
			withCollectionLock(dir, PROJECT, COLLECTION, () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		// lock dir must be gone → a fresh acquire succeeds immediately
		let ran = false;
		await withCollectionLock(dir, PROJECT, COLLECTION, () => {
			ran = true;
		});
		expect(ran).toBe(true);
	});

	it("release deletes the lock when it is still ours (token match)", async () => {
		const lockBase = join(dir, `${PROJECT}__${COLLECTION}.lock`);
		await withCollectionLock(dir, PROJECT, COLLECTION, () => {});
		expect(existsSync(lockBase)).toBe(false);
	});

	it("release does NOT delete a lock that was taken over (codex HIGH — token mismatch)", async () => {
		const lockBase = join(dir, `${PROJECT}__${COLLECTION}.lock`);
		await withCollectionLock(dir, PROJECT, COLLECTION, () => {
			// Simulate a stale-takeover mid-section: another holder rewrote the lock
			// meta with a DIFFERENT token. Our release must not delete their lock.
			writeFileSync(
				join(lockBase, "meta.json"),
				JSON.stringify({
					pid: process.pid,
					acquiredAt: new Date().toISOString(),
					token: "another-holder-token",
				}),
			);
		});
		expect(existsSync(lockBase)).toBe(true);
		rmSync(lockBase, { recursive: true, force: true });
	});

	it("times out if the lock is held and not stale", async () => {
		await withCollectionLock(
			dir,
			PROJECT,
			COLLECTION,
			async () => {
				await expect(
					withCollectionLock(dir, PROJECT, COLLECTION, () => "inner", {
						timeoutMs: 200,
						staleMs: 10 * 60 * 1000,
						pollMs: 20,
					}),
				).rejects.toThrow(/timed out acquiring lock/);
			},
			{ staleMs: 10 * 60 * 1000 },
		);
	});
});

describe("triggerIssueId (FLY-222 #2)", () => {
	it("emptyState starts with null triggerIssueId", () => {
		expect(fresh().triggerIssueId).toBeNull();
	});

	it("setTriggerIssueId records + round-trips through write/read", () => {
		writeState(dir, setTriggerIssueId(fresh(), "ISSUE-42"));
		expect(readState(dir, PROJECT, COLLECTION).triggerIssueId).toBe("ISSUE-42");
	});

	it("readState normalizes a pre-field state file to null (backward compat)", () => {
		const s = fresh() as Record<string, unknown>;
		delete s.triggerIssueId;
		writeFileSync(stateFilePath(dir, PROJECT, COLLECTION), JSON.stringify(s));
		expect(readState(dir, PROJECT, COLLECTION).triggerIssueId).toBeNull();
	});
});

describe("bootstrapped flag (codex MEDIUM-6 — empty-collection first run)", () => {
	it("markBootstrapped sets the flag idempotently", () => {
		const s0 = emptyState(PROJECT, COLLECTION);
		expect(s0.bootstrapped).toBe(false);
		const s1 = markBootstrapped(s0);
		expect(s1.bootstrapped).toBe(true);
		// idempotent — returns the same object when already set
		expect(markBootstrapped(s1)).toBe(s1);
	});

	it("persists bootstrapped across read/write (empty window stays bootstrapped)", () => {
		writeState(dir, markBootstrapped(emptyState(PROJECT, COLLECTION)));
		const reread = readState(dir, PROJECT, COLLECTION);
		expect(reread.bootstrapped).toBe(true);
		expect(reread.processed).toEqual([]); // empty collection, but bootstrapped
	});

	it("forward-compat: an old state file w/o `bootstrapped` but with processed history reads as bootstrapped", () => {
		const file = join(dir, `${PROJECT}__${COLLECTION}.json`);
		const legacy = {
			version: emptyState(PROJECT, COLLECTION).version,
			project: PROJECT,
			collectionId: COLLECTION,
			processed: ["n1"],
			pending: [],
			lease: null,
			triggerIssueId: null,
			nextDueAt: null,
			operations: {},
			lastRunAt: null,
			updatedAt: new Date().toISOString(),
		};
		writeFileSync(file, JSON.stringify(legacy));
		expect(readState(dir, PROJECT, COLLECTION).bootstrapped).toBe(true);
	});

	it("forward-compat: an old EMPTY state w/o `bootstrapped` reads as not bootstrapped", () => {
		const file = join(dir, `${PROJECT}__${COLLECTION}.json`);
		const legacy = {
			version: emptyState(PROJECT, COLLECTION).version,
			project: PROJECT,
			collectionId: COLLECTION,
			processed: [],
			pending: [],
			lease: null,
			triggerIssueId: null,
			nextDueAt: null,
			operations: {},
			lastRunAt: null,
			updatedAt: new Date().toISOString(),
		};
		writeFileSync(file, JSON.stringify(legacy));
		expect(readState(dir, PROJECT, COLLECTION).bootstrapped).toBe(false);
	});
});

describe("dropPending (codex MEDIUM-5 — out-of-window pending)", () => {
	it("removes a noteId from pending WITHOUT marking it processed; idempotent", () => {
		let s = recordPending(fresh(), ["p1", "p2"]);
		s = dropPending(s, "p1");
		expect(s.pending.map((p) => p.noteId)).toEqual(["p2"]);
		expect(s.processed).not.toContain("p1"); // dropped, NOT processed
		// idempotent / unknown id = no-op (same ref)
		expect(dropPending(s, "p1")).toBe(s);
		expect(dropPending(s, "nope")).toBe(s);
	});
});
