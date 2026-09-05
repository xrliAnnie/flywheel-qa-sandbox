import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { CommDB, CommDbPreflightStaleError } from "flywheel-comm/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareBridgeCommDbRebuilds } from "../bridge/commdb-fly2268-preflight.js";

describe("FLY-2268 Bridge CommDB preflight", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("prepares a source-bound receipt for every legacy project before warmup", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2268-bridge-preflight-"));
		roots.push(root);
		const dbPath = join(root, "flywheel", "comm.db");
		const seeded = new CommDB(dbPath);
		seeded.requestRunnerShutdown("exec-1", "old-request", 1);
		seeded.close();
		const raw = new Database(dbPath);
		raw.exec(`
			DROP VIEW IF EXISTS messages;
			DROP VIEW IF EXISTS lead_inbox;
			DROP INDEX IF EXISTS idx_rsc_pending;
			ALTER TABLE runner_shutdown_controls RENAME TO runner_shutdown_controls_new;
			CREATE TABLE runner_shutdown_controls (
				execution_id TEXT PRIMARY KEY,
				request_id TEXT NOT NULL UNIQUE,
				state TEXT NOT NULL CHECK(state IN ('requested','acked','failed')),
				requested_at INTEGER NOT NULL,
				finished_at INTEGER,
				error TEXT
			);
			INSERT INTO runner_shutdown_controls
				(execution_id, request_id, state, requested_at, finished_at, error)
			SELECT execution_id, request_id, state, requested_at, finished_at, error
			FROM runner_shutdown_controls_new;
			DROP TABLE runner_shutdown_controls_new;
		`);
		raw.pragma("wal_checkpoint(TRUNCATE)");
		raw.close();

		const receipts = await prepareBridgeCommDbRebuilds(
			[{ projectName: "flywheel" }, { projectName: "missing" }],
			(projectName) => join(root, projectName, "comm.db"),
		);

		expect(receipts).toHaveLength(1);
		expect(receipts[0]?.projectName).toBe("flywheel");
		expect(existsSync(`${dbPath}.fly2268-rebuild-receipt.json`)).toBe(true);
	});

	it("logs and defers an unstable source binding without aborting Bridge boot", async () => {
		const log = vi.fn();
		const prepare = vi
			.fn()
			.mockRejectedValueOnce(
				new CommDbPreflightStaleError("source did not stabilize"),
			)
			.mockResolvedValueOnce(null);

		await expect(
			prepareBridgeCommDbRebuilds(
				[{ projectName: "busy" }, { projectName: "healthy" }],
				(projectName) => `/tmp/${projectName}/comm.db`,
				{ prepare, log },
			),
		).resolves.toEqual([]);
		expect(prepare).toHaveBeenCalledTimes(2);
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("commdb_schema_preflight_stale"),
		);
	});

	it("keeps non-stale preflight failures fail-loud", async () => {
		await expect(
			prepareBridgeCommDbRebuilds(
				[{ projectName: "corrupt" }],
				() => "/tmp/corrupt/comm.db",
				{
					prepare: vi
						.fn()
						.mockRejectedValue(
							new Error("commdb_schema_preflight_required: backup corrupt"),
						),
					log: vi.fn(),
				},
			),
		).rejects.toThrow("commdb_schema_preflight_required");
	});
});
