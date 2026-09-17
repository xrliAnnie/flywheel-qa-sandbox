import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { openWriteLedger } from "../migrations.js";

const roots: string[] = [];
const connections: Database.Database[] = [];
function path() {
	const root = mkdtempSync(join(tmpdir(), "xhs-ledger-"));
	roots.push(root);
	return join(root, "ledger.db");
}
afterEach(() => {
	for (const db of connections.splice(0)) if (db.open) db.close();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
it("requires explicit provisioning and never recreates a missing authority ledger", () => {
	expect(() => openWriteLedger(path())).toThrow();
});
it("reopens with effective FULL durability and all authority tables", () => {
	const file = path();
	const db = openWriteLedger(file, { provision: true });
	connections.push(db);
	for (const [key, value] of Object.entries({
		journal_mode: "wal",
		synchronous: 2,
		foreign_keys: 1,
		busy_timeout: 5000,
		fullfsync: 1,
		checkpoint_fullfsync: 1,
	})) {
		expect(db.pragma(key, { simple: true })).toBe(value);
	}
	expect(
		db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'xhs_%'",
			)
			.all(),
	).toHaveLength(7);
	db.close();
	const reopened = openWriteLedger(file);
	connections.push(reopened);
	expect(reopened.pragma("user_version", { simple: true })).toBe(1);
});
it("rejects an empty existing database rather than initializing at runtime", () => {
	const file = path();
	new Database(file).close();
	expect(() => openWriteLedger(file)).toThrow("durability_unavailable");
});
it("rejects future schema versions without mutating them", () => {
	const file = path();
	const db = new Database(file);
	db.pragma("user_version = 99");
	db.close();
	expect(() => openWriteLedger(file, { provision: true })).toThrow(
		"durability_unavailable",
	);
	const check = new Database(file);
	connections.push(check);
	expect(check.pragma("user_version", { simple: true })).toBe(99);
});
it("rolls back proposal inserts on failure and preserves uniqueness after reopen", () => {
	const file = path();
	const db = openWriteLedger(file, { provision: true });
	connections.push(db);
	const insert = db.prepare(`INSERT INTO xhs_write_proposal
 (proposal_id,project_id,lead_id,prepare_request_id,frozen_json,content_digest,account_user_id,account_epoch,provider_generation,expires_at,state)
 VALUES (?, 'project', 'lead', ?, '{}', ?, 'account', 1, 'generation', 1000, ?)`);
	expect(() =>
		db
			.transaction(() => {
				insert.run("one", "request", "a".repeat(64), "preparing");
				throw new Error("injected failure");
			})
			.immediate(),
	).toThrow("injected failure");
	db.close();
	const reopened = openWriteLedger(file);
	connections.push(reopened);
	expect(reopened.prepare("SELECT * FROM xhs_write_proposal").all()).toEqual(
		[],
	);
	const fresh = reopened.prepare(insert.source);
	fresh.run("one", "request", "a".repeat(64), "preparing");
	expect(() =>
		fresh.run("two", "request", "a".repeat(64), "preparing"),
	).toThrow();
	expect(() =>
		fresh.run("three", "other", "a".repeat(64), "forged-approved"),
	).toThrow();
});
it("refuses a ledger whose version survives but authority tables are missing", () => {
	const file = path();
	const db = openWriteLedger(file, { provision: true });
	db.exec("DROP TABLE xhs_write_media_ref");
	db.close();
	expect(() => openWriteLedger(file)).toThrow("durability_unavailable");
});
