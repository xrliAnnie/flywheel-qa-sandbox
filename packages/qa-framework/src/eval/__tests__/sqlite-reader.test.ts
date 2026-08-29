// FLY-616 — better-sqlite3 READ-ONLY reader tests (post FLY-663 migration).
//
// 验证两件事 (Annie 2026-06-30 merge 前要求):
//  1) better-sqlite3 读出的 sessions / auto_qa_record 跟原 sql.js 逐字段一致。
//  2) 真只读铁证：跑完所有读，teamlead.db 文件 sha256 前后逐字节相同
//     (QA·683 的『DB 不被改一个字节』继续成立)。绝不实例化 StateStore。

import { createHash } from "node:crypto";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TaskRunHandle } from "../extract.js";
import { createSqliteReaders, landingPathFor } from "../sqlite-reader.js";

let tmp: string;
let dbPath: string;

const EXEC_ID = "exec-aaa-111";
const HEAD_SHA = "deadbeefcafe";

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

beforeAll(() => {
	tmp = mkdtempSync(join(tmpdir(), "fly616-reader-"));
	dbPath = join(tmp, "teamlead.db");

	// Arrange: build a teamlead-shaped DB exactly like StateStore's columns
	// for the fields the reader SELECTs. Default journal mode → deterministic
	// single-file sha256 (production is WAL, but readonly semantics are
	// strictly weaker — can't write — and 663 already runs better-sqlite3 on
	// the same WAL file). Close cleanly before any reader opens it.
	const db = new BetterSqlite3(dbPath);
	db.exec(`
		CREATE TABLE sessions (
			execution_id TEXT PRIMARY KEY,
			status TEXT,
			pr_number INTEGER,
			pr_head_sha TEXT,
			worktree_path TEXT
		);
		CREATE TABLE auto_qa_record (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			parent_execution_id TEXT,
			target_pr_head_sha TEXT,
			status TEXT
		);
	`);
	db.prepare(
		"INSERT INTO sessions (execution_id, status, pr_number, pr_head_sha, worktree_path) VALUES (?,?,?,?,?)",
	).run(EXEC_ID, "completed", 383, HEAD_SHA, "/tmp/worktrees/fly616");
	// a row with NULL pr_number / pr_head_sha to prove null coercion parity
	db.prepare(
		"INSERT INTO sessions (execution_id, status, pr_number, pr_head_sha, worktree_path) VALUES (?,?,?,?,?)",
	).run("exec-no-pr", "awaiting_review", null, null, null);
	// auto_qa_record: 2 failed + 1 passed for EXEC_ID@HEAD_SHA
	const insQa = db.prepare(
		"INSERT INTO auto_qa_record (parent_execution_id, target_pr_head_sha, status) VALUES (?,?,?)",
	);
	insQa.run(EXEC_ID, HEAD_SHA, "failed");
	insQa.run(EXEC_ID, HEAD_SHA, "failed");
	insQa.run(EXEC_ID, HEAD_SHA, "passed");
	db.close();
});

afterAll(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("createSqliteReaders — field-by-field parity", () => {
	it("readSession returns the row with correct types (INTEGER→number, NULL→null)", async () => {
		const readers = await createSqliteReaders();
		const row = await readers.readSession(dbPath, EXEC_ID);
		expect(row).toEqual({
			status: "completed",
			prNumber: 383,
			prHeadSha: HEAD_SHA,
			worktreePath: "/tmp/worktrees/fly616",
		});
	});

	it("readSession coerces NULL pr_number/pr_head_sha/worktree to null", async () => {
		const readers = await createSqliteReaders();
		const row = await readers.readSession(dbPath, "exec-no-pr");
		expect(row).toEqual({
			status: "awaiting_review",
			prNumber: null,
			prHeadSha: null,
			worktreePath: null,
		});
	});

	it("readSession returns null for an unknown execId", async () => {
		const readers = await createSqliteReaders();
		expect(await readers.readSession(dbPath, "nope")).toBeNull();
	});

	it("readAcceptedQaStatus binds parent_execution_id + target_pr_head_sha", async () => {
		const readers = await createSqliteReaders();
		expect(await readers.readAcceptedQaStatus(dbPath, EXEC_ID, HEAD_SHA)).toBe(
			"failed", // first matching row (no ORDER BY, mirrors prior reader)
		);
	});

	it("readAcceptedQaStatus returns null when head sha is missing", async () => {
		const readers = await createSqliteReaders();
		expect(
			await readers.readAcceptedQaStatus(dbPath, EXEC_ID, null),
		).toBeNull();
	});

	it("readAcceptedQaStatus returns null when head sha does not match", async () => {
		const readers = await createSqliteReaders();
		expect(
			await readers.readAcceptedQaStatus(dbPath, EXEC_ID, "otherhead"),
		).toBeNull();
	});

	it("qaFamilyExists reflects presence of any record for the parent", async () => {
		const readers = await createSqliteReaders();
		expect(await readers.qaFamilyExists(dbPath, EXEC_ID)).toBe(true);
		expect(await readers.qaFamilyExists(dbPath, "exec-no-pr")).toBe(false);
	});

	it("countQaFailLoops counts only status='failed'", async () => {
		const readers = await createSqliteReaders();
		expect(await readers.countQaFailLoops(dbPath, EXEC_ID)).toBe(2);
		expect(await readers.countQaFailLoops(dbPath, "exec-no-pr")).toBe(0);
	});

	it("keeps the v1 mocked external readers (614 token / lagging / diff)", async () => {
		const readers = await createSqliteReaders();
		const handle = { execId: EXEC_ID, dbPath } as unknown as TaskRunHandle;
		expect(await readers.readFly614Tokens(handle)).toBeNull();
		expect(await readers.readDiff(handle)).toBeNull();
		expect((await readers.readLagging(handle))?.laggingStatus).toBe(
			"not_applicable",
		);
	});

	it("overrides replace base readers", async () => {
		const readers = await createSqliteReaders({
			async readFly614Tokens() {
				return { totalTokens: 42 } as never;
			},
		});
		const handle = { execId: EXEC_ID, dbPath } as unknown as TaskRunHandle;
		expect(await readers.readFly614Tokens(handle)).toEqual({ totalTokens: 42 });
	});
});

describe("readLandingRaw (file, not DB)", () => {
	it("reads land-status.json from handle.landStatusPath", async () => {
		const readers = await createSqliteReaders();
		const landPath = join(tmp, "land-status.json");
		writeFileSync(landPath, '{"status":"ready_to_merge"}');
		const handle = {
			execId: EXEC_ID,
			dbPath,
			landStatusPath: landPath,
		} as unknown as TaskRunHandle;
		expect(readers.readLandingRaw(handle, null)).toBe(
			'{"status":"ready_to_merge"}',
		);
	});

	it("returns null when the landing file is absent", async () => {
		const readers = await createSqliteReaders();
		const handle = {
			execId: EXEC_ID,
			dbPath,
			landStatusPath: join(tmp, "does-not-exist.json"),
		} as unknown as TaskRunHandle;
		expect(readers.readLandingRaw(handle, null)).toBeNull();
	});

	it("landingPathFor derives <worktree>/.flywheel/runs/<execId>/land-status.json", () => {
		const handle = { execId: EXEC_ID } as unknown as TaskRunHandle;
		expect(landingPathFor(handle, "/wt")).toBe(
			"/wt/.flywheel/runs/exec-aaa-111/land-status.json",
		);
		expect(landingPathFor(handle, null)).toBeNull();
	});
});

describe("read-only safety (QA·683 byte-identical invariant)", () => {
	it("DB sha256 is byte-identical before and after all reads", async () => {
		const before = sha256(dbPath);
		const readers = await createSqliteReaders();
		// exercise every DB read path
		await readers.readSession(dbPath, EXEC_ID);
		await readers.readSession(dbPath, "exec-no-pr");
		await readers.readAcceptedQaStatus(dbPath, EXEC_ID, HEAD_SHA);
		await readers.qaFamilyExists(dbPath, EXEC_ID);
		await readers.countQaFailLoops(dbPath, EXEC_ID);
		const after = sha256(dbPath);
		expect(after).toBe(before);
	});

	it("fileMustExist: opening a missing DB throws and never creates a file", async () => {
		const readers = await createSqliteReaders();
		const missing = join(tmp, "absent.db");
		await expect(readers.readSession(missing, EXEC_ID)).rejects.toThrow();
		expect(existsSync(missing)).toBe(false);
	});
});
