import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommDB } from "../db.js";

describe("CommDB open diagnostics", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "fly1649-commdb-open-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it.skipIf(process.platform === "win32")(
		"preserves SQLITE_READONLY while naming the database, failed phase, and readonly sidecar",
		() => {
			const dbPath = join(tmpDir, "comm.db");
			const initialized = new CommDB(dbPath, true, false);
			initialized.close();

			// Model the r2 failure faithfully: a separate writer leaves WAL sidecars
			// behind after an abrupt exit, with the canonical -shm accidentally 0444.
			const child = spawnSync(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					`import { chmodSync, existsSync } from "node:fs";
					 import Database from "better-sqlite3";
					 const path = process.argv[1];
					 const db = new Database(path);
					 db.pragma("journal_mode = WAL");
					 db.pragma("wal_autocheckpoint = 0");
					 db.exec("CREATE TABLE fly1649_abrupt_writer (id INTEGER); INSERT INTO fly1649_abrupt_writer VALUES (1)");
					 const shm = path + "-shm";
					 if (!existsSync(shm)) throw new Error("fixture did not create -shm");
					 chmodSync(shm, 0o444);
					 process.kill(process.pid, "SIGKILL");`,
					dbPath,
				],
				{ cwd: process.cwd(), encoding: "utf8" },
			);
			expect(child.signal).toBe("SIGKILL");
			expect(existsSync(`${dbPath}-shm`)).toBe(true);
			expect(statSync(`${dbPath}-shm`).mode & 0o777).toBe(0o444);

			let thrown: unknown;
			try {
				new CommDB(dbPath, false, false);
			} catch (error) {
				thrown = error;
			}

			expect(thrown).toBeInstanceOf(Error);
			expect((thrown as { code?: string }).code).toBe("SQLITE_READONLY");
			expect((thrown as Error).message).toContain(
				"attempt to write a readonly database",
			);
			expect((thrown as Error).message).toContain(dbPath);
			expect((thrown as Error).message).toContain("phase: schema");
			expect((thrown as Error).message).toContain(`${dbPath}-shm mode=0444`);
			expect((thrown as Error).message).toContain(`chmod 0600 ${dbPath}-shm`);
		},
	);

	it("keeps mailbox-generation failures byte-identical", () => {
		const legacyPath = join(tmpDir, "legacy.db");
		const legacy = new Database(legacyPath);
		legacy.exec("CREATE TABLE legacy_only (id TEXT PRIMARY KEY)");
		legacy.close();

		expect(() => new CommDB(legacyPath, false, false)).toThrowError(
			`Legacy or partial CommDB at ${legacyPath}; run the FLY-1572 mailbox migration before opening it`,
		);
	});
});
