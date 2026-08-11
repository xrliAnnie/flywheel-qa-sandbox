import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

function session(status = "running") {
	return {
		execution_id: "exec-terminal",
		issue_id: "FLY-1448",
		project_name: "flywheel",
		status,
	};
}

describe("StateStore terminal lifecycle identity", () => {
	const stores: StateStore[] = [];

	afterEach(() => {
		for (const store of stores.splice(0)) store.close();
	});

	it("preserves one id through terminal rewrites and rotates it after revival", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		const fields = { issue_id: "FLY-1448", project_name: "flywheel" };
		store.upsertSession(session());

		store.persistTransition("exec-terminal", "completed", fields);
		const first = store.getSession("exec-terminal")?.terminal_lifecycle_id;
		expect(first).toMatch(/^[0-9a-f-]{36}$/);

		store.persistTransition("exec-terminal", "failed", fields);
		expect(store.getSession("exec-terminal")?.terminal_lifecycle_id).toBe(
			first,
		);

		store.persistTransition("exec-terminal", "awaiting_review", fields);
		expect(
			store.getSession("exec-terminal")?.terminal_lifecycle_id,
		).toBeUndefined();

		store.persistTransition("exec-terminal", "blocked", fields);
		const second = store.getSession("exec-terminal")?.terminal_lifecycle_id;
		expect(second).toMatch(/^[0-9a-f-]{36}$/);
		expect(second).not.toBe(first);
	});

	it("keeps one terminal lifecycle across recoverable terminal states", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		const fields = { issue_id: "FLY-1448", project_name: "flywheel" };
		store.upsertSession(session());

		store.persistTransition("exec-terminal", "blocked", fields);
		const lifecycleId =
			store.getSession("exec-terminal")?.terminal_lifecycle_id;
		expect(lifecycleId).toMatch(/^[0-9a-f-]{36}$/);

		for (const status of ["deferred", "shelved", "terminated"]) {
			store.persistTransition("exec-terminal", status, fields);
			expect(store.getSession("exec-terminal")?.terminal_lifecycle_id).toBe(
				lifecycleId,
			);
		}
	});

	it("CAS repair mints once only for the exact observed terminal revision", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		store.upsertSession(session());
		store.forceStatus("exec-terminal", "completed", "2026-07-24T00:00:00.000Z");
		const observed = store.getSession("exec-terminal")!;
		const raw = (
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db;
		raw.run(
			"UPDATE sessions SET terminal_lifecycle_id = NULL WHERE execution_id = ?",
			["exec-terminal"],
		);

		const first = store.ensureTerminalLifecycleId(
			"exec-terminal",
			observed.status,
			observed.lifecycle_revision ?? 0,
		);
		const replay = store.ensureTerminalLifecycleId(
			"exec-terminal",
			observed.status,
			observed.lifecycle_revision ?? 0,
		);
		expect(replay).toBe(first);

		expect(
			store.ensureTerminalLifecycleId(
				"exec-terminal",
				"failed",
				observed.lifecycle_revision ?? 0,
			),
		).toBeUndefined();
		expect(
			store.ensureTerminalLifecycleId(
				"exec-terminal",
				observed.status,
				(observed.lifecycle_revision ?? 0) + 1,
			),
		).toBeUndefined();
	});

	it("backfills a stable id when opening a legacy database", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly1448-terminal-lifecycle-"));
		const dbPath = join(dir, "teamlead.db");
		try {
			const initial = await StateStore.create(dbPath);
			initial.upsertSession(session("completed"));
			initial.close();

			const raw = new BetterSqlite3(dbPath);
			raw.exec(`
				ALTER TABLE sessions DROP COLUMN terminal_lifecycle_id;
				CREATE TABLE receipt_settlement_intent (intent_id TEXT PRIMARY KEY);
			`);
			raw.close();

			const migrated = await StateStore.create(dbPath);
			stores.push(migrated);
			const first = migrated.getSession("exec-terminal")?.terminal_lifecycle_id;
			expect(first).toMatch(/^[0-9a-f-]{36}$/);
			migrated.close();
			stores.splice(stores.indexOf(migrated), 1);
			const verify = new BetterSqlite3(dbPath, { readonly: true });
			expect(
				verify
					.prepare(
						"SELECT 1 FROM sqlite_master WHERE name='receipt_settlement_intent'",
					)
					.get(),
			).toBeUndefined();
			verify.close();

			const reopened = await StateStore.create(dbPath);
			stores.push(reopened);
			expect(reopened.getSession("exec-terminal")?.terminal_lifecycle_id).toBe(
				first,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
