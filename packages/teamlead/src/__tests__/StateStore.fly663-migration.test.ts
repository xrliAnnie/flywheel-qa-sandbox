import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

/**
 * FLY-663: tests specific to the sql.js → better-sqlite3 engine migration —
 * WAL mode, multi-statement transaction atomicity (§2.8), and cross-process
 * WAL reads by the direct teamlead.db consumers (§2.9: verify-approval etc.).
 */
describe("FLY-663 — StateStore better-sqlite3 migration", () => {
	let dir: string;
	let dbPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly663-mig-"));
		dbPath = join(dir, "teamlead.db");
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("opens a file-backed DB in WAL mode", async () => {
		const store = await StateStore.create(dbPath);
		const mode = (
			store as unknown as { db: { raw: BetterSqlite3.Database } }
		).db.raw.pragma("journal_mode", { simple: true });
		expect(mode).toBe("wal");
		store.close();
	});

	it("close() checkpoints the WAL (TRUNCATE) so the main DB file is authoritative", async () => {
		const store = await StateStore.create(dbPath);
		store.upsertSession({
			execution_id: "ckpt-1",
			issue_id: "FLY-663",
			project_name: "flywheel",
			status: "running",
		});
		store.close();
		// After a clean close, a fresh read-only connection sees the row from the
		// main file even with the -wal truncated.
		const ro = new BetterSqlite3(dbPath, {
			readonly: true,
			fileMustExist: true,
		});
		const row = ro
			.prepare("SELECT status FROM sessions WHERE execution_id = ?")
			.get("ckpt-1") as { status: string } | undefined;
		expect(row?.status).toBe("running");
		ro.close();
	});

	it("save()/flush() are no-ops — no full-DB export on the write path", async () => {
		const store = await StateStore.create(dbPath);
		// Neither throws; writes are already durable under WAL.
		expect(() =>
			(store as unknown as { save: () => void }).save(),
		).not.toThrow();
		expect(() => store.flush()).not.toThrow();
		// The underlying engine has no sql.js export().
		const raw = (store as unknown as { db: { raw: Record<string, unknown> } })
			.db.raw;
		expect((raw as { export?: unknown }).export).toBeUndefined();
		store.close();
	});

	it("adds indexed review fields to a legacy codex_review_job table idempotently", async () => {
		const legacy = new BetterSqlite3(dbPath);
		legacy.exec(`
			CREATE TABLE codex_review_job (
				request_id TEXT PRIMARY KEY,
				execution_id TEXT NOT NULL,
				status TEXT NOT NULL
			)
		`);
		legacy.close();

		for (let attempt = 0; attempt < 2; attempt += 1) {
			const store = await StateStore.create(dbPath);
			const columns = (
				store as unknown as { db: { raw: BetterSqlite3.Database } }
			).db.raw.pragma("table_info(codex_review_job)") as Array<{
				name: string;
				dflt_value: string | null;
			}>;
			expect(columns.map((column) => column.name)).toEqual(
				expect.arrayContaining([
					"failure_raw",
					"question_id",
					"retry_at",
					"auto_retry_count",
					"failure_attempt_count",
				]),
			);
			for (const name of ["auto_retry_count", "failure_attempt_count"]) {
				expect(columns.find((column) => column.name === name)?.dflt_value).toBe(
					"0",
				);
			}
			store.close();
		}
	});

	it("rebuilds a pre-FLY-863 review ledger before selecting the missing stuck column", async () => {
		const legacy = new BetterSqlite3(dbPath);
		legacy.exec(`
			CREATE TABLE codex_review_record (
				execution_id TEXT NOT NULL,
				target_pr_head_sha TEXT NOT NULL,
				issue_id TEXT NOT NULL,
				project_name TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending',
				reviewed_target TEXT,
				codex_thread_id TEXT,
				rounds INTEGER,
				verdict_event_id TEXT,
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				approved_at TEXT,
				hold_notified_at TEXT,
				PRIMARY KEY (execution_id, target_pr_head_sha)
			);
			INSERT INTO codex_review_record (
				execution_id, target_pr_head_sha, issue_id, project_name, status
			) VALUES ('legacy-review', '${"a".repeat(40)}', 'FLY-663', 'flywheel', 'approved');
		`);
		legacy.close();

		const store = await StateStore.create(dbPath);
		expect(
			store.getCodexReviewRecord("legacy-review", "__main__", "a".repeat(40)),
		).toMatchObject({
			status: "approved",
			target_repo_identity: "__main__",
		});
		const columns = (
			store as unknown as { db: { raw: BetterSqlite3.Database } }
		).db.raw.pragma("table_info(codex_review_record)") as Array<{
			name: string;
			pk: number;
		}>;
		expect(
			columns
				.filter((column) => column.pk > 0)
				.sort((left, right) => left.pk - right.pk)
				.map((column) => column.name),
		).toEqual(["execution_id", "target_repo_identity", "target_pr_head_sha"]);
		expect(columns.map((column) => column.name)).toContain("stuck_notified_at");
		store.close();
	});

	describe("§2.8 multi-statement transaction atomicity", () => {
		it("upsertSession rolls back the INSERT if the awaiting_review stamp throws", async () => {
			const store = await StateStore.create(dbPath);
			// Force the second statement of the logical mutation to throw.
			(
				store as unknown as { stampAwaitingReviewEntry: () => void }
			).stampAwaitingReviewEntry = () => {
				throw new Error("boom mid-mutation");
			};
			expect(() =>
				store.upsertSession({
					execution_id: "tx-1",
					issue_id: "FLY-663",
					project_name: "flywheel",
					status: "awaiting_review",
				}),
			).toThrow("boom mid-mutation");
			// The whole transaction rolled back → no durable partial session row.
			store.close();
			const reopened = await StateStore.create(dbPath);
			expect(reopened.getSession("tx-1")).toBeUndefined();
			reopened.close();
		});

		it("upsertChatThread rolls back the DELETE if the INSERT path throws", async () => {
			const store = await StateStore.create(dbPath);
			// Seed an existing thread for the issue/channel.
			store.upsertChatThread("old-thread", "ch-1", "FLY-663", "lead-a");
			// Force the upsert's second statement to throw by monkeypatching the
			// underlying run after the DELETE — simulate a mid-mutation failure.
			const compat = (
				store as unknown as { db: { run: (s: string, p?: unknown[]) => void } }
			).db;
			const realRun = compat.run.bind(compat);
			let calls = 0;
			compat.run = (sql: string, params?: unknown[]) => {
				calls++;
				if (calls === 2) throw new Error("boom on insert");
				return realRun(sql, params);
			};
			expect(() =>
				store.upsertChatThread("new-thread", "ch-1", "FLY-663", "lead-a"),
			).toThrow("boom on insert");
			compat.run = realRun;
			// The DELETE of the old thread must have rolled back → old thread intact.
			store.close();
			const reopened = await StateStore.create(dbPath);
			expect(reopened.getChatThreadByThreadId("old-thread")).toBeTruthy();
			reopened.close();
		});
	});

	describe("§2.9 cross-process WAL reads (verify-approval / verify-lifecycle-consent shape)", () => {
		it("a separate read-only better-sqlite3 connection reads review binding while the store is open", async () => {
			const store = await StateStore.create(dbPath);
			store.upsertSession({
				execution_id: "rev-1",
				issue_id: "FLY-663",
				project_name: "flywheel",
				status: "awaiting_review",
			});
			store.setReviewBinding("rev-1", {
				questionId: "q-1",
				prHeadSha: "deadbeef",
			});

			// Mirror verify-approval.ts: a separate read-only connection + the exact
			// query it runs. Works under WAL while the writer connection is live.
			const ro = new BetterSqlite3(dbPath, {
				readonly: true,
				fileMustExist: true,
			});
			const row = ro
				.prepare(
					"SELECT status, pr_head_sha, review_question_id FROM sessions WHERE execution_id = ?",
				)
				.get("rev-1") as
				| {
						status: string;
						pr_head_sha: string | null;
						review_question_id: string | null;
				  }
				| undefined;
			expect(row?.status).toBe("awaiting_review");
			expect(row?.pr_head_sha).toBe("deadbeef");
			expect(row?.review_question_id).toBe("q-1");
			ro.close();
			store.close();
		});

		it("the read-only reader still sees committed rows after the writer cleanly closes (checkpointed)", async () => {
			const store = await StateStore.create(dbPath);
			store.upsertSession({
				execution_id: "rev-2",
				issue_id: "FLY-663",
				project_name: "flywheel",
				status: "awaiting_review",
			});
			store.setReviewBinding("rev-2", {
				questionId: "q-2",
				prHeadSha: "cafef00d",
			});
			store.close();

			const ro = new BetterSqlite3(dbPath, {
				readonly: true,
				fileMustExist: true,
			});
			const row = ro
				.prepare(
					"SELECT pr_head_sha, review_question_id FROM sessions WHERE execution_id = ?",
				)
				.get("rev-2") as
				| { pr_head_sha: string | null; review_question_id: string | null }
				| undefined;
			expect(row?.pr_head_sha).toBe("cafef00d");
			expect(row?.review_question_id).toBe("q-2");
			ro.close();
		});

		it("dirty shutdown: a readonly reader sees committed frames from the -wal sidecar before any checkpoint", async () => {
			const { existsSync } = await import("node:fs");
			const store = await StateStore.create(dbPath);
			store.upsertSession({
				execution_id: "wal-1",
				issue_id: "FLY-663",
				project_name: "flywheel",
				status: "running",
			});
			// Simulate a dirty shutdown: do NOT close()/checkpoint → committed frames
			// live in the -wal sidecar (not yet folded into the main file).
			expect(existsSync(`${dbPath}-wal`)).toBe(true);
			const ro = new BetterSqlite3(dbPath, {
				readonly: true,
				fileMustExist: true,
			});
			const row = ro
				.prepare("SELECT status FROM sessions WHERE execution_id = ?")
				.get("wal-1") as { status: string } | undefined;
			expect(row?.status).toBe("running");
			ro.close();
			store.close();
		});
	});

	describe("getRowsModified / lastInsertRowid equivalence", () => {
		it("appendLeadEvent returns a positive seq and dedups by (lead,event)", async () => {
			const store = await StateStore.create(dbPath);
			const seq1 = store.appendLeadEvent("lead-1", "evt-1", "t", "{}");
			expect(seq1).toBeGreaterThan(0);
			const seq2 = store.appendLeadEvent("lead-1", "evt-1", "t", "{}"); // dup → existing seq
			expect(seq2).toBe(seq1);
			store.close();
		});
	});
});
