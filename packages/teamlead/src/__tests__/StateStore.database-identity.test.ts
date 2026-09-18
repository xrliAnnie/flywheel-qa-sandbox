import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openWithDatabaseIdentity, StateStore } from "../StateStore.js";

describe("StateStore opened database identity", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0))
			rmSync(dir, { recursive: true, force: true });
	});

	function fixturePath(): string {
		const dir = mkdtempSync(join(tmpdir(), "fly2696-db-identity-"));
		dirs.push(dir);
		return join(dir, "teamlead.db");
	}

	it("binds a live StateStore handle to dev/inode and detects path replacement", async () => {
		const dbPath = fixturePath();
		const store = await StateStore.create(dbPath);
		try {
			const opened = store.getOpenedDatabaseIdentity();
			expect(opened).toMatchObject({
				canonicalPath: expect.stringContaining("teamlead.db"),
				device: expect.stringMatching(/^\d+$/),
				inode: expect.stringMatching(/^\d+$/),
			});
			expect(store.assertOpenedDatabaseIdentityCurrent()).toEqual(opened);

			renameSync(dbPath, `${dbPath}.opened`);
			new BetterSqlite3(dbPath).close();
			expect(() => store.assertOpenedDatabaseIdentityCurrent()).toThrow(
				/database_identity_changed_after_open/,
			);
		} finally {
			store.close();
		}
	});

	it("fails closed when the database path is replaced during open", () => {
		const dbPath = fixturePath();
		new BetterSqlite3(dbPath).close();
		expect(() =>
			openWithDatabaseIdentity(dbPath, () => {
				const connection = new BetterSqlite3(dbPath);
				renameSync(dbPath, `${dbPath}.opened`);
				new BetterSqlite3(dbPath).close();
				return connection;
			}),
		).toThrow(/database_identity_changed_during_open/);
	});

	it("does not claim an identity for an in-memory store", async () => {
		const store = await StateStore.create(":memory:");
		try {
			expect(store.getOpenedDatabaseIdentity()).toBeNull();
			expect(() => store.assertOpenedDatabaseIdentityCurrent()).toThrow(
				/database_identity_unavailable/,
			);
		} finally {
			store.close();
		}
	});
});
