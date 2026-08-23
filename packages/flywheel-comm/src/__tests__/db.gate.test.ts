import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommDB } from "../db.js";

type RawDatabase = {
	prepare: (sql: string) => { run: (...args: unknown[]) => unknown };
};

function seedHistoricalFounderConsentResponse(
	db: CommDB,
	questionId: string,
): string {
	const raw = (db as unknown as { db: RawDatabase }).db;
	const responseId = `historical-response:${questionId}`;
	const deliveryId = `historical-delivery:${questionId}`;
	raw
		.prepare(
			"INSERT INTO mailbox_identity (id, delivery_id, insert_projection_hash) VALUES (?, ?, ?)",
		)
		.run(responseId, deliveryId, "historical-test-fixture");
	raw
		.prepare(
			`INSERT INTO mailbox
			 (id, delivery_id, from_agent, to_agent, recipient_kind, type, content,
			  ref_id, created_at, expires_at, relay_state)
			 VALUES (?, ?, 'bridge-founder-consent', 'exec-1', 'runner', 'response',
			         '{"approved":true}', ?, '2026-08-22T00:00:00.000Z',
			         '2026-08-25T00:00:00.000Z', 'terminal_disposed')`,
		)
		.run(responseId, deliveryId, questionId);
	raw
		.prepare(
			"UPDATE mailbox SET relay_state = 'terminal_disposed' WHERE id = ?",
		)
		.run(questionId);
	return responseId;
}

describe("CommDB gate methods", () => {
	let db: CommDB;
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "flywheel-gate-db-test-"));
		db = new CommDB(join(tmpDir, "comm.db"));
	});

	afterEach(() => {
		db.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	describe("insertQuestion with gate options", () => {
		it("should insert with checkpoint column", () => {
			const id = db.insertQuestion("runner-1", "lead-1", "brainstorm content", {
				checkpoint: "brainstorm",
			});
			const pending = db.getPendingQuestions("lead-1");
			expect(pending.length).toBe(1);
			expect(pending[0].checkpoint).toBe("brainstorm");
			expect(pending[0].id).toBe(id);
		});

		it("should insert with content_ref", () => {
			const _id = db.insertQuestion(
				"runner-1",
				"lead-1",
				"[content_ref: /path/to/file]",
				{
					checkpoint: "brainstorm",
					contentRef: "/path/to/file.md",
					contentType: "ref",
				},
			);
			const pending = db.getPendingQuestions("lead-1");
			expect(pending[0].content_ref).toBe("/path/to/file.md");
			expect(pending[0].content_type).toBe("ref");
		});

		it("should default content_type to text", () => {
			db.insertQuestion("runner-1", "lead-1", "plain question");
			const pending = db.getPendingQuestions("lead-1");
			expect(pending[0].content_type).toBe("text");
			expect(pending[0].checkpoint).toBeNull();
		});

		it("should be backward compatible without opts", () => {
			const id = db.insertQuestion("runner-1", "lead-1", "normal question");
			expect(id).toBeTruthy();
			const pending = db.getPendingQuestions("lead-1");
			expect(pending.length).toBe(1);
			expect(pending[0].checkpoint).toBeNull();
		});
	});

	describe("pending gates by runner", () => {
		it("returns only this runner's unresolved checkpoint questions", () => {
			const gateId = db.insertQuestion("exec-1", "lead-1", "review", {
				checkpoint: "review_code",
			});
			db.insertQuestion("exec-1", "lead-1", "ordinary ask");
			db.insertQuestion("other-exec", "lead-1", "other gate", {
				checkpoint: "brainstorm",
			});

			expect(db.getPendingGatesByRunner("exec-1").map((q) => q.id)).toEqual([
				gateId,
			]);

			db.insertResponse(gateId, "lead-1", "done");
			expect(db.getPendingGatesByRunner("exec-1")).toEqual([]);
		});

		// FLY-1257 QA (independent): a gate whose FLY-159 deadline watcher has
		// already timed it out must NOT keep counting as pending. This is the
		// authority `complete --route blocked` consults (M1-c): once the watcher
		// resolves a gate by deadline, the runner has to be free to complete —
		// the timeout resolution must never leave it permanently refused. Locks
		// the query's `expires_at > datetime('now')` clause the M1-c guard leans on.
		it("excludes a gate whose deadline has already passed (timeout passthrough)", () => {
			const gateId = db.insertQuestion("exec-1", "lead-1", "review", {
				checkpoint: "review_code",
			});
			expect(db.getPendingGatesByRunner("exec-1").map((q) => q.id)).toEqual([
				gateId,
			]);
			// Force the deadline past without waiting — same raw rewind the other
			// expiry tests use — to stand in for the watcher having timed it out.
			(
				db as unknown as {
					db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } };
				}
			).db
				.prepare(
					"UPDATE mailbox SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour') WHERE id = ?",
				)
				.run(gateId);
			expect(db.getPendingGatesByRunner("exec-1")).toEqual([]);
		});
	});

	describe("resolveGate", () => {
		it("should mark question as resolved", () => {
			const id = db.insertQuestion("runner-1", "lead-1", "content", {
				checkpoint: "brainstorm",
			});
			db.insertResponse(id, "lead-1", "approved");
			db.resolveGate(id, 24);

			// Should no longer be pending
			const pending = db.getPendingQuestions("lead-1");
			expect(pending.length).toBe(0);
		});
	});

	describe("migration", () => {
		it("should add checkpoint column via migration", () => {
			// The CommDB constructor runs migrations. If we can insert with checkpoint, it worked.
			const id = db.insertQuestion("r", "l", "c", { checkpoint: "test" });
			expect(id).toBeTruthy();
		});

		it("should add content_ref column via migration", () => {
			const id = db.insertQuestion("r", "l", "c", {
				contentRef: "/path",
				contentType: "ref",
			});
			expect(id).toBeTruthy();
		});
	});

	describe("purgeExpiredWithRefs", () => {
		it("should purge expired messages", () => {
			// Insert a question
			db.insertQuestion("r", "l", "expired content");
			// Can't easily test expiration without manipulating time,
			// but we can verify the method doesn't throw
			const purged = db.purgeExpiredWithRefs();
			expect(purged).toBe(0); // nothing expired yet
		});
	});

	describe("hasPendingQuestionsFrom", () => {
		it("should include gate questions", () => {
			db.insertQuestion("runner-1", "lead-1", "content", {
				checkpoint: "brainstorm",
			});
			expect(db.hasPendingQuestionsFrom("runner-1")).toBe(true);
		});
	});

	// FLY-818 (Codex code review R1 #2): the armer must NOT treat a non-blocking
	// `flywheel-comm ask` (checkpoint NULL) as a blocking gate — only a checkpointed
	// `gate` blocks. hasPendingBlockingGateFrom filters on `checkpoint IS NOT NULL`.
	describe("hasPendingBlockingGateFrom (blocking gate only, not ask)", () => {
		it("false for a non-blocking ask (checkpoint NULL) — runner stays armable", () => {
			db.insertQuestion("runner-1", "lead-1", "just an ask"); // no checkpoint
			expect(db.hasPendingQuestionsFrom("runner-1")).toBe(true); // broad predicate sees it
			expect(db.hasPendingBlockingGateFrom("runner-1")).toBe(false); // but it is NOT a blocking gate
		});

		it("true for a checkpointed blocking gate", () => {
			db.insertQuestion("runner-1", "lead-1", "brainstorm gate", {
				checkpoint: "brainstorm",
			});
			expect(db.hasPendingBlockingGateFrom("runner-1")).toBe(true);
		});

		it("false when the blocking gate has been answered", () => {
			const id = db.insertQuestion("runner-1", "lead-1", "q", {
				checkpoint: "question",
			});
			db.insertResponse(id, "lead-1", "answered");
			expect(db.hasPendingBlockingGateFrom("runner-1")).toBe(false);
		});
	});

	// ── FLY-1188 §7.1 (Codex R16): atomic answer-iff-still-open ──────────
	describe("insertResponseIfGateOpen", () => {
		function openReviewGate(): string {
			return db.insertQuestion("exec-1", "bridge", "review my code", {
				checkpoint: "review_code",
			});
		}
		const args = (questionId: string) => ({
			questionId,
			fromAgent: "bridge",
			content: '{"reviewVerdict":"APPROVED"}',
			expectedOwner: "exec-1",
			expectedCheckpoint: "review_code",
		});

		it("open gate → response written exactly once", () => {
			const id = openReviewGate();
			expect(db.insertResponseIfGateOpen(args(id))).toBe(true);
			expect(db.getResponse(id)?.from_agent).toBe("bridge");
			// second write is a no-op (already answered)
			expect(db.insertResponseIfGateOpen(args(id))).toBe(false);
		});

		it("resolved gate → no-op false (the R16 TOCTOU window)", () => {
			const id = openReviewGate();
			db.resolveGate(id, 24);
			expect(db.insertResponseIfGateOpen(args(id))).toBe(false);
			expect(db.getResponse(id)).toBeUndefined();
		});

		it("wrong owner / wrong checkpoint / missing question → false", () => {
			const id = openReviewGate();
			expect(
				db.insertResponseIfGateOpen({ ...args(id), expectedOwner: "other" }),
			).toBe(false);
			expect(
				db.insertResponseIfGateOpen({
					...args(id),
					expectedCheckpoint: "review_design",
				}),
			).toBe(false);
			expect(
				db.insertResponseIfGateOpen({ ...args(id), questionId: "nope" }),
			).toBe(false);
			expect(db.getResponse(id)).toBeUndefined();
		});

		it("expired unanswered gate remains answerable while H2 protection is on", () => {
			const id = db.insertQuestion("exec-1", "bridge", "review my code", {
				checkpoint: "review_code",
				ttlSeconds: 1,
			});
			// force expiry without waiting: rewind expires_at (raw db access)
			(
				db as unknown as {
					db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } };
				}
			).db
				.prepare(
					"UPDATE mailbox SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour') WHERE id = ?",
				)
				.run(id);
			expect(db.insertResponseIfGateOpen(args(id))).toBe(true);
		});

		it("rejects bridge-founder-consent as a fresh approve_to_ship writer", () => {
			const id = db.insertQuestion("exec-1", "bridge", "ship?", {
				checkpoint: "approve_to_ship",
			});

			expect(() =>
				db.insertResponseIfGateOpen({
					questionId: id,
					fromAgent: "bridge-founder-consent",
					content: '{"approved":true}',
					expectedOwner: "exec-1",
					expectedCheckpoint: "approve_to_ship",
				}),
			).toThrow(/historical-only/i);
			expect(db.getResponse(id)).toBeUndefined();
		});
	});

	describe("historical founder-consent primitive boundary", () => {
		it("insertResponse rejects fresh approve_to_ship writes", () => {
			const id = db.insertQuestion("exec-1", "bridge", "ship?", {
				checkpoint: "approve_to_ship",
			});

			expect(() =>
				db.insertResponse(id, "bridge-founder-consent", '{"approved":true}'),
			).toThrow(/historical-only/i);
			expect(db.getResponse(id)).toBeUndefined();
		});

		it("preserves existing historical approve_to_ship rows idempotently", () => {
			const id = db.insertQuestion("exec-1", "bridge", "ship?", {
				checkpoint: "approve_to_ship",
			});
			const responseId = seedHistoricalFounderConsentResponse(db, id);

			expect(
				db.insertResponse(id, "bridge-founder-consent", '{"approved":true}'),
			).toEqual({ written: false, reason: "gate_not_open" });
			expect(
				db.insertResponseIfGateOpen({
					questionId: id,
					fromAgent: "bridge-founder-consent",
					content: '{"approved":true}',
					expectedOwner: "exec-1",
					expectedCheckpoint: "approve_to_ship",
				}),
			).toBe(false);
			expect(db.getResponse(id)?.id).toBe(responseId);
		});

		it("does not reject the actor for an unrelated checkpoint", () => {
			const directId = db.insertQuestion("exec-1", "bridge", "review?", {
				checkpoint: "review_code",
			});
			expect(
				db.insertResponse(
					directId,
					"bridge-founder-consent",
					'{"reviewVerdict":"APPROVED"}',
				),
			).toEqual({ written: true });

			const atomicId = db.insertQuestion("exec-1", "bridge", "review?", {
				checkpoint: "review_code",
			});
			expect(
				db.insertResponseIfGateOpen({
					questionId: atomicId,
					fromAgent: "bridge-founder-consent",
					content: '{"reviewVerdict":"APPROVED"}',
					expectedOwner: "exec-1",
					expectedCheckpoint: "review_code",
				}),
			).toBe(true);
		});
	});

	describe("insertFounderReviewResponseIfGateOpen", () => {
		const founderId = "123456789012345678";
		const artifactDigest = "a".repeat(64);

		function openFounderReview(): string {
			return db.insertQuestion(
				"exec-1",
				"lead-1",
				JSON.stringify({
					version: 1,
					round: 1,
					runId: "run-1",
					artifactDigest,
					hostedUrl: "https://reports.example/founder-review",
					paths: ["product/doc/FLY-1/review.html"],
				}),
				{ checkpoint: "founder_review" },
			);
		}

		it("writes a founder-attributed pass bound to the question artifact", () => {
			const id = openFounderReview();
			expect(
				db.insertFounderReviewResponseIfGateOpen({
					questionId: id,
					fromAgent: founderId,
					founderId,
					expectedOwner: "exec-1",
					passed: true,
				}),
			).toBe(true);
			expect(JSON.parse(db.getResponse(id)?.content ?? "null")).toEqual({
				version: 1,
				passed: true,
				artifactDigest,
			});
		});

		it("rejects a Lead-attributed response without writing", () => {
			const id = openFounderReview();
			expect(() =>
				db.insertFounderReviewResponseIfGateOpen({
					questionId: id,
					fromAgent: "flywheel-product-lead",
					founderId,
					expectedOwner: "exec-1",
					passed: false,
					feedback: "revise section two",
				}),
			).toThrow(/trusted founder attribution/);
			expect(db.getResponse(id)).toBeUndefined();
		});
	});

	describe("insertGuardedResponse", () => {
		beforeEach(() => {
			db.registerSession(
				"exec-guarded",
				"runner",
				"flywheel",
				"FLY-1645",
				"lead-1",
			);
		});

		it("answers an ordinary question only for its bound Lead and owner", () => {
			const id = db.insertQuestion("exec-guarded", "lead-1", "answer me");
			expect(
				db.insertGuardedResponse({
					questionId: id,
					authenticatedLead: "lead-1",
					content: "done",
					expectedOwner: "exec-guarded",
					expectedCheckpoint: null,
					now: "2026-08-11T12:00:00.000Z",
				}),
			).toMatchObject({ responseId: expect.any(String) });
			expect(db.getResponse(id)).toMatchObject({
				from_agent: "lead-1",
				content: "done",
			});
		});

		it("rejects founder_review at the guarded DB write boundary", () => {
			const id = db.insertQuestion(
				"exec-guarded",
				"lead-1",
				"review the staged artifact",
				{ checkpoint: "founder_review" },
			);
			expect(() =>
				db.insertGuardedResponse({
					questionId: id,
					authenticatedLead: "lead-1",
					content: "looks good",
					expectedOwner: "exec-guarded",
					expectedCheckpoint: "founder_review",
					now: "2026-08-14T12:00:00.000Z",
				}),
			).toThrow(/not Lead-routable/);
			expect(db.getResponse(id)).toBeUndefined();
		});

		it("rejects cross-Lead, checkpoint, and already-answered writes", () => {
			const id = db.insertQuestion("exec-guarded", "lead-1", "answer me");
			expect(() =>
				db.insertGuardedResponse({
					questionId: id,
					authenticatedLead: "lead-2",
					content: "stolen",
					now: "2026-08-11T12:00:00.000Z",
				}),
			).toThrow(/scope mismatch/);
			expect(() =>
				db.insertGuardedResponse({
					questionId: id,
					authenticatedLead: "lead-1",
					content: "wrong shape",
					expectedCheckpoint: "brainstorm",
					now: "2026-08-11T12:00:00.000Z",
				}),
			).toThrow(/scope mismatch/);
			db.insertGuardedResponse({
				questionId: id,
				authenticatedLead: "lead-1",
				content: "winner",
				now: "2026-08-11T12:00:00.000Z",
			});
			expect(() =>
				db.insertGuardedResponse({
					questionId: id,
					authenticatedLead: "lead-1",
					content: "loser",
					now: "2026-08-11T12:00:01.000Z",
				}),
			).toThrow(/already answered/);
		});

		it("keeps ordinary asks answerable after their Runner session completes", () => {
			const id = db.insertQuestion(
				"exec-guarded",
				"lead-1",
				"DONE: PR is ready",
			);
			db.updateSessionStatusIfRunning("exec-guarded", "completed");

			expect(
				db.insertGuardedResponse({
					questionId: id,
					authenticatedLead: "lead-1",
					content: "please address one follow-up",
					now: "2026-08-11T12:00:00.000Z",
				}),
			).toMatchObject({ responseId: expect.any(String) });
		});

		it("routes checkpoint-less asks by their explicit target Lead", () => {
			const id = db.insertQuestion(
				"exec-guarded",
				"lead-2",
				"need cross-department help",
			);

			expect(
				db.insertGuardedResponse({
					questionId: id,
					authenticatedLead: "lead-2",
					content: "here is the answer",
					now: "2026-08-11T12:00:00.000Z",
				}),
			).toMatchObject({ responseId: expect.any(String) });
		});

		it("allows a Lead to reply to a fire-and-forget report", () => {
			const id = db.insertQuestion("exec-guarded", "lead-1", "DONE: QA", {
				kind: "report",
			});

			expect(
				db.insertGuardedResponse({
					questionId: id,
					authenticatedLead: "lead-1",
					content: "acknowledged",
					now: "2026-08-11T12:00:00.000Z",
				}),
			).toMatchObject({ responseId: expect.any(String) });
		});

		it("expired unanswered ask remains answerable while H2 protection is on", () => {
			const id = db.insertQuestion("exec-guarded", "lead-1", "slow question");
			(
				db as unknown as {
					db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } };
				}
			).db
				.prepare(
					"UPDATE mailbox SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour') WHERE id = ?",
				)
				.run(id);

			expect(
				db.insertGuardedResponse({
					questionId: id,
					authenticatedLead: "lead-1",
					content: "late but retained",
					now: new Date().toISOString(),
				}),
			).toMatchObject({ responseId: expect.any(String) });
			expect(db.getResponse(id)?.content).toBe("late but retained");
		});
	});

	// ── FLY-1188 HIGH-2 (Codex full-PR review): a gate-timeout synthetic response
	// must SURVIVE the runner's next `check`. The gate deadline ≈ the question's
	// own expires_at, so when the timeout watcher fires the question is already
	// expired: `insertResponseIfGateOpen` refuses (unexpired guard) AND
	// `resolveGate(_,0)` + the next RW-open purge would delete the response before
	// the runner reads it. `insertTimeoutResponse` writes the response WITHOUT the
	// unexpired guard and atomically pushes the question's expires_at to a grace
	// window so the purge cascade cannot remove it. ────────────────────────────
	describe("insertTimeoutResponse (HIGH-2 — timeout response survives purge)", () => {
		const rawExpire = (id: string) =>
			(
				db as unknown as {
					db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } };
				}
			).db
				.prepare(
					"UPDATE mailbox SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour') WHERE id = ?",
				)
				.run(id);

		const timeoutArgs = (questionId: string) => ({
			questionId,
			fromAgent: "codex-tmux-adapter",
			content: "GATE TIMEOUT (fail-open) — continue on best judgment.",
			expectedOwner: "exec-1",
			expectedCheckpoint: "brainstorm",
		});

		function openExpiredGate(): string {
			const id = db.insertQuestion("exec-1", "lead-1", "brainstorm gate", {
				checkpoint: "brainstorm",
			});
			rawExpire(id); // gate deadline passed — the question is already expired
			return id;
		}

		it("writes to an expired gate and preserves the timeout response", () => {
			const id = openExpiredGate();
			expect(db.insertTimeoutResponse(timeoutArgs(id))).toBe(true);
			expect(db.getResponse(id)?.content).toContain("GATE TIMEOUT");
		});

		it("the response SURVIVES the runner's next `check` (fresh RW open purges)", () => {
			const dbPath = join(tmpDir, "comm.db");
			const id = openExpiredGate();
			expect(db.insertTimeoutResponse(timeoutArgs(id))).toBe(true);
			// Simulate `flywheel-comm check`: a brand-new RW CommDB whose constructor
			// runs purgeExpired(). With the OLD resolveGate(_,0) path this deletes the
			// question + its response; with the grace bump both survive.
			const checkDb = new CommDB(dbPath);
			try {
				expect(checkDb.getResponse(id)?.content).toContain("GATE TIMEOUT");
			} finally {
				checkDb.close();
			}
		});

		it("never clobbers a REAL Lead answer that landed first (race → false)", () => {
			const id = db.insertQuestion("exec-1", "lead-1", "brainstorm gate", {
				checkpoint: "brainstorm",
			});
			db.insertResponse(id, "lead-1", "APPROVED — go");
			expect(db.insertTimeoutResponse(timeoutArgs(id))).toBe(false);
			// the real answer is intact, not overwritten by the timeout text
			expect(db.getResponse(id)?.content).toBe("APPROVED — go");
		});

		it("rejects bridge-founder-consent as a fresh approve_to_ship timeout writer", () => {
			const id = db.insertQuestion("exec-1", "lead-1", "ship gate", {
				checkpoint: "approve_to_ship",
			});
			rawExpire(id);

			expect(() =>
				db.insertTimeoutResponse({
					...timeoutArgs(id),
					fromAgent: "bridge-founder-consent",
					expectedCheckpoint: "approve_to_ship",
				}),
			).toThrow(/historical-only/i);
			expect(db.getResponse(id)).toBeUndefined();
		});

		it("returns false for an existing historical approve_to_ship timeout row", () => {
			const id = db.insertQuestion("exec-1", "lead-1", "ship gate", {
				checkpoint: "approve_to_ship",
			});
			const responseId = seedHistoricalFounderConsentResponse(db, id);
			// Keep the question synthetically answerable so this proves the existing-row
			// check wins before the historical-actor fresh-write guard.
			(db as unknown as { db: RawDatabase }).db
				.prepare(
					"UPDATE mailbox SET relay_state = 'protected', resolved_at = NULL WHERE id = ?",
				)
				.run(id);

			expect(
				db.insertTimeoutResponse({
					...timeoutArgs(id),
					fromAgent: "bridge-founder-consent",
					expectedCheckpoint: "approve_to_ship",
				}),
			).toBe(false);
			expect(db.getResponse(id)?.id).toBe(responseId);
		});

		it("allows bridge-founder-consent timeout responses on unrelated checkpoints", () => {
			const id = openExpiredGate();

			expect(
				db.insertTimeoutResponse({
					...timeoutArgs(id),
					fromAgent: "bridge-founder-consent",
				}),
			).toBe(true);
			expect(db.getResponse(id)?.from_agent).toBe("bridge-founder-consent");
		});

		it("wrong owner / wrong checkpoint / missing question → false", () => {
			const id = openExpiredGate();
			expect(
				db.insertTimeoutResponse({
					...timeoutArgs(id),
					expectedOwner: "other",
				}),
			).toBe(false);
			expect(
				db.insertTimeoutResponse({
					...timeoutArgs(id),
					expectedCheckpoint: "review_code",
				}),
			).toBe(false);
			expect(
				db.insertTimeoutResponse({ ...timeoutArgs(id), questionId: "nope" }),
			).toBe(false);
			expect(db.getResponse(id)).toBeUndefined();
		});

		it("resolves the gate so it drops out of the Lead's pending list", () => {
			const id = openExpiredGate();
			expect(db.insertTimeoutResponse(timeoutArgs(id))).toBe(true);
			expect(db.getPendingQuestions("lead-1").length).toBe(0);
		});
	});
});
