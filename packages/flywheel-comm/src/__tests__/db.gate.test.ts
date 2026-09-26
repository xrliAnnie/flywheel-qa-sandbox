import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommDB } from "../db.js";

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

		it("expired gate → false", () => {
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
					"UPDATE messages SET expires_at = datetime('now','-1 hour') WHERE id = ?",
				)
				.run(id);
			expect(db.insertResponseIfGateOpen(args(id))).toBe(false);
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
					"UPDATE messages SET expires_at = datetime('now','-1 hour') WHERE id = ?",
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

		it("writes to an EXPIRED gate (insertResponseIfGateOpen would refuse)", () => {
			const id = openExpiredGate();
			// The old race-safe write refuses on an expired question…
			expect(db.insertResponseIfGateOpen(timeoutArgs(id))).toBe(false);
			// …but the timeout write succeeds (deadline-passed is the whole point).
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
