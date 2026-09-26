import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommDB } from "../db.js";

/**
 * FLY-626: runner self-declared state marker (`park` / `busy`).
 *
 * Timestamps are epoch milliseconds (Codex R2 LOW #3). `getEffectiveDeclaredState`
 * must be readonly-tolerant: a Bridge reader opening a DB whose writer never created
 * the table (openReadonly skips schema) must see "no marker", not throw.
 */
describe("CommDB runner_declared_states (FLY-626)", () => {
	let db: CommDB;
	let tmpDir: string;
	let dbPath: string;
	const T0 = 1_700_000_000_000;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "flywheel-declared-state-"));
		dbPath = join(tmpDir, "comm.db");
		db = new CommDB(dbPath);
	});

	afterEach(() => {
		db.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns null when no marker exists", () => {
		expect(db.getEffectiveDeclaredState("exec-1", T0)).toBeNull();
	});

	it("upserts a parked marker (indefinite) and reads it back as effective", () => {
		db.upsertDeclaredState(
			"exec-1",
			"parked",
			"done, iterating later",
			T0,
			null,
		);
		const s = db.getEffectiveDeclaredState("exec-1", T0 + 10_000_000);
		expect(s).not.toBeNull();
		expect(s!.kind).toBe("parked");
		expect(s!.reason).toBe("done, iterating later");
		expect(s!.expires_at).toBeNull();
		expect(s!.created_at).toBe(T0);
	});

	it("long_task marker is effective before expiry and null after", () => {
		db.upsertDeclaredState(
			"exec-1",
			"long_task",
			"codex review",
			T0,
			T0 + 60_000,
		);
		expect(db.getEffectiveDeclaredState("exec-1", T0 + 30_000)?.kind).toBe(
			"long_task",
		);
		// exactly at expiry → expired (strict)
		expect(db.getEffectiveDeclaredState("exec-1", T0 + 60_000)).toBeNull();
		expect(db.getEffectiveDeclaredState("exec-1", T0 + 90_000)).toBeNull();
	});

	it("upsert replaces an existing marker for the same execution", () => {
		db.upsertDeclaredState("exec-1", "parked", "first", T0, null);
		db.upsertDeclaredState(
			"exec-1",
			"long_task",
			"switched",
			T0 + 5,
			T0 + 1000,
		);
		const s = db.getEffectiveDeclaredState("exec-1", T0 + 100);
		expect(s!.kind).toBe("long_task");
		expect(s!.reason).toBe("switched");
	});

	it("clearDeclaredState removes the marker (unpark)", () => {
		db.upsertDeclaredState("exec-1", "parked", null, T0, null);
		expect(db.getEffectiveDeclaredState("exec-1", T0)).not.toBeNull();
		db.clearDeclaredState("exec-1");
		expect(db.getEffectiveDeclaredState("exec-1", T0)).toBeNull();
	});

	it("markers are scoped per execution_id", () => {
		db.upsertDeclaredState("exec-1", "parked", null, T0, null);
		expect(db.getEffectiveDeclaredState("exec-2", T0)).toBeNull();
	});

	it("renews a bounded park lease without changing question or response rows", () => {
		const questionId = db.insertQuestion("exec-1", "lead-1", "review gate", {
			checkpoint: "review_code",
		});
		db.insertResponse(questionId, "lead-1", "APPROVED");
		const raw = new Database(dbPath);
		const snapshotMessages = () =>
			raw
				.prepare(
					"SELECT id, parent_id, type, content FROM messages ORDER BY created_at, id",
				)
				.all();
		const before = snapshotMessages();

		db.upsertDeclaredState(
			"exec-1",
			"parked",
			"awaiting review",
			T0,
			T0 + 10 * 60_000,
		);
		expect(db.getEffectiveDeclaredState("exec-1", T0 + 5 * 60_000)?.kind).toBe(
			"parked",
		);

		db.upsertDeclaredState(
			"exec-1",
			"parked",
			"awaiting review",
			T0 + 5 * 60_000,
			T0 + 15 * 60_000,
		);
		expect(
			db.getEffectiveDeclaredState("exec-1", T0 + 10 * 60_000)?.expires_at,
		).toBe(T0 + 15 * 60_000);

		db.clearDeclaredState("exec-1");
		expect(db.getEffectiveDeclaredState("exec-1", T0 + 10 * 60_000)).toBeNull();

		db.upsertDeclaredState(
			"exec-1",
			"parked",
			"crash backstop",
			T0 + 20 * 60_000,
			T0 + 30 * 60_000,
		);
		expect(db.getEffectiveDeclaredState("exec-1", T0 + 30 * 60_000)).toBeNull();
		expect(snapshotMessages()).toEqual(before);
		raw.close();
	});

	it("readonly reader tolerates a missing table (returns null, never throws)", () => {
		// A DB created by a writer that never knew the table: simulate by opening a
		// fresh DB readonly BEFORE any writer created the new table. We use a brand
		// new path so the readonly opener (which skips schema) sees no table.
		const roDir = mkdtempSync(join(tmpdir(), "flywheel-declared-ro-"));
		const roPath = join(roDir, "comm.db");
		// seed the file with the legacy schema only (messages/sessions), no declared table
		const seed = new CommDB(roPath);
		seed.close();
		// drop the new table to emulate a pre-FLY-626 DB
		const raw = new Database(roPath);
		raw.exec("DROP TABLE IF EXISTS runner_declared_states");
		raw.close();
		const ro = CommDB.openReadonly(roPath);
		expect(ro.getEffectiveDeclaredState("exec-1", T0)).toBeNull();
		ro.close();
		rmSync(roDir, { recursive: true, force: true });
	});
});
