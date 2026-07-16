/**
 * FLY-1066: the sessions CHECK migration runs in every CommDB process, while
 * Runner CLIs may concurrently write the same file. Exercise the real built
 * CommDB from a second OS process so busy_timeout and transaction rollback are
 * covered rather than inferred from sequential connections.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommDB } from "../db.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const DIST_DB = join(TEST_DIR, "..", "..", "dist", "db.js");

function runWorker(
	workerPath: string,
	dbPath: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [workerPath, dbPath], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
}

function seedBlockedEraSchema(dbPath: string): void {
	const raw = new Database(dbPath);
	raw.pragma("journal_mode = WAL");
	raw.exec(`
		CREATE TABLE sessions (
			execution_id TEXT PRIMARY KEY,
			tmux_window TEXT NOT NULL,
			project_name TEXT NOT NULL,
			issue_id TEXT,
			lead_id TEXT,
			started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			ended_at DATETIME,
			status TEXT DEFAULT 'running' CHECK(status IN ('running','completed','timeout','blocked')),
			vendor TEXT
		);
		CREATE INDEX idx_sessions_project ON sessions(project_name);
		CREATE INDEX idx_sessions_status ON sessions(status);
		INSERT INTO sessions (
			execution_id, tmux_window, project_name, issue_id, lead_id, status, vendor
		) VALUES ('before-lock', '@1', 'flywheel', 'FLY-1066', 'lead', 'blocked', 'codex');
	`);
	raw.close();
}

describe("FLY-1066 sessions migration contention", () => {
	let dir: string;
	let dbPath: string;
	let workerPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1066-migration-race-"));
		dbPath = join(dir, "comm.db");
		workerPath = join(dir, "open-worker.mjs");
		writeFileSync(
			workerPath,
			`import { CommDB } from ${JSON.stringify(DIST_DB)};
try {
  const db = new CommDB(process.argv[2], false);
  db.close();
  process.stdout.write("OK");
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
`,
		);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const maybe = existsSync(DIST_DB) ? it : it.skip;

	maybe(
		"waits for a concurrent writer, then preserves rows, vendor, indexes, and the new CHECK",
		async () => {
			seedBlockedEraSchema(dbPath);
			const locker = new Database(dbPath);
			locker.exec("BEGIN IMMEDIATE");
			locker
				.prepare(
					"INSERT INTO sessions (execution_id, tmux_window, project_name, status, vendor) VALUES (?, ?, ?, ?, ?)",
				)
				.run("during-lock", "@2", "flywheel", "running", "claude-code");

			const childResult = runWorker(workerPath, dbPath);
			await new Promise((resolve) => setTimeout(resolve, 200));
			locker.exec("COMMIT");
			locker.close();

			expect(await childResult).toMatchObject({ code: 0, stdout: "OK" });
			const check = new Database(dbPath, { readonly: true });
			const rows = check
				.prepare(
					"SELECT execution_id, status, vendor FROM sessions ORDER BY execution_id",
				)
				.all();
			expect(rows).toEqual([
				{ execution_id: "before-lock", status: "blocked", vendor: "codex" },
				{
					execution_id: "during-lock",
					status: "running",
					vendor: "claude-code",
				},
			]);
			const schema = check
				.prepare(
					"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'",
				)
				.get() as { sql: string };
			expect(schema.sql).toContain("'failed'");
			expect(
				check
					.prepare(
						"SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'sessions' ORDER BY name",
					)
					.all(),
			).toEqual(
				expect.arrayContaining([
					{ name: "idx_sessions_project" },
					{ name: "idx_sessions_status" },
				]),
			);
			check.close();
		},
		15_000,
	);

	maybe(
		"rolls back cleanly on busy timeout and succeeds on the next open",
		async () => {
			seedBlockedEraSchema(dbPath);
			const locker = new Database(dbPath);
			locker.exec("BEGIN IMMEDIATE");

			const failed = await runWorker(workerPath, dbPath);
			expect(failed.code).toBe(2);
			expect(failed.stderr).toMatch(/locked|busy/i);
			locker.exec("ROLLBACK");
			locker.close();

			const afterFailure = new Database(dbPath, { readonly: true });
			expect(
				afterFailure
					.prepare(
						"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'sessions_fly1066%'",
					)
					.all(),
			).toEqual([]);
			afterFailure.close();

			const retry = new CommDB(dbPath, false);
			retry.markSessionTerminalStatus("before-lock", "failed");
			expect(retry.getSession("before-lock")?.status).toBe("failed");
			retry.close();
		},
		15_000,
	);
});
