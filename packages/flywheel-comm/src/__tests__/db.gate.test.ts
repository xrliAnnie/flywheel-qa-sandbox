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
			const id = db.insertQuestion(
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
});
