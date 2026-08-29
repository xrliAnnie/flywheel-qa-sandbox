import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { executeFly2139MaintenanceVacuum } from "../../../../scripts/lib/fly-2006-retention-engine.mjs";
import { readSealedJson } from "../../../../scripts/lib/fly-2006-retention-evidence.mjs";

function createBloatedDatabase(root: string): string {
	const path = join(root, "teamlead.db");
	const db = new Database(path);
	db.pragma("journal_mode=WAL");
	db.exec(`
		CREATE TABLE vacuum_bloat(payload BLOB);
		WITH RECURSIVE counter(value) AS (
			SELECT 1 UNION ALL SELECT value + 1 FROM counter WHERE value < 400
		)
		INSERT INTO vacuum_bloat SELECT randomblob(4096) FROM counter;
		DELETE FROM vacuum_bloat;
	`);
	db.close();
	return path;
}

describe("FLY-2139 standing database maintenance", () => {
	it("completes checkpoint, compaction, and integrity while separating the SLA verdict", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2139-vacuum-"));
		try {
			const databasePath = createBloatedDatabase(root);
			const evidenceDir = join(root, "evidence");
			const result = await executeFly2139MaintenanceVacuum({
				database: "teamlead",
				databasePath,
				evidenceDir,
				maxDurationMs: 1,
				allowFixturePaths: true,
				testHooks: {
					availableBytes: Number.MAX_SAFE_INTEGER,
					durationMs: 2,
				},
			});
			expect(result).toMatchObject({
				issue: "FLY-2139",
				status: "complete",
				slaStatus: "degraded",
				durationExceeded: true,
				checkpoint: {
					before: { busy: 0 },
					after: { busy: 0 },
				},
				integrity: { quickCheck: "ok", integrityCheck: "ok" },
			});
			expect(result.after.mainBytes).toBeLessThan(result.before.mainBytes);
			expect(readFileSync(result.receiptPath, "utf8")).toContain(
				'"status": "complete"',
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("treats a non-throwing busy checkpoint tuple as a failed safe skip", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2139-vacuum-busy-"));
		try {
			const databasePath = createBloatedDatabase(root);
			const evidenceDir = join(root, "evidence");
			await expect(
				executeFly2139MaintenanceVacuum({
					database: "teamlead",
					databasePath,
					evidenceDir,
					maxDurationMs: 30_000,
					allowFixturePaths: true,
					testHooks: {
						availableBytes: Number.MAX_SAFE_INTEGER,
						checkpointResult: (phase: string) =>
							phase === "before"
								? { busy: 1, log: 7, checkpointed: 3 }
								: undefined,
					},
				}),
			).rejects.toThrow("maintenance_checkpoint_busy:before");
			const failure = readSealedJson(
				join(evidenceDir, "maintenance-teamlead-failure.json"),
				"maintenance_failure",
			);
			expect(failure).toMatchObject({
				issue: "FLY-2139",
				status: "failed",
				reason: "maintenance_checkpoint_busy:before",
				checkpoint: { busy: 1, log: 7, checkpointed: 3 },
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("continues VACUUM when busy only means a fully checkpointed WAL could not truncate", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2139-vacuum-checkpointed-"));
		try {
			const databasePath = createBloatedDatabase(root);
			const evidenceDir = join(root, "evidence");
			const result = await executeFly2139MaintenanceVacuum({
				database: "teamlead",
				databasePath,
				evidenceDir,
				maxDurationMs: 30_000,
				allowFixturePaths: true,
				testHooks: {
					availableBytes: Number.MAX_SAFE_INTEGER,
					checkpointResult: () => ({ busy: 1, log: 46, checkpointed: 46 }),
				},
			});

			expect(result.status).toBe("complete");
			expect(result.checkpoint).toEqual({
				before: { busy: 1, log: 46, checkpointed: 46 },
				after: { busy: 1, log: 46, checkpointed: 46 },
			});
			expect(result.integrity).toEqual({
				quickCheck: "ok",
				integrityCheck: "ok",
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails safely when a writer reopens after the exclusive preflight", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2139-vacuum-race-"));
		let writer: Database.Database | undefined;
		try {
			const databasePath = createBloatedDatabase(root);
			const evidenceDir = join(root, "evidence");
			await expect(
				executeFly2139MaintenanceVacuum({
					database: "teamlead",
					databasePath,
					evidenceDir,
					maxDurationMs: 30_000,
					allowFixturePaths: true,
					testHooks: {
						availableBytes: Number.MAX_SAFE_INTEGER,
						afterStarted: () => {
							writer = new Database(databasePath);
							writer.pragma("busy_timeout=0");
							writer.exec("BEGIN IMMEDIATE");
						},
					},
				}),
			).rejects.toThrow(/maintenance_(checkpoint|vacuum)_busy/);
			expect(
				readSealedJson(
					join(evidenceDir, "maintenance-teamlead-failure.json"),
					"maintenance_failure",
				),
			).toMatchObject({ issue: "FLY-2139", status: "failed" });
		} finally {
			if (writer) {
				if (writer.inTransaction) writer.exec("ROLLBACK");
				writer.close();
			}
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("recovers from a sealed started marker without losing the original before image", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2139-vacuum-recovery-"));
		try {
			const databasePath = createBloatedDatabase(root);
			const evidenceDir = join(root, "evidence");
			await expect(
				executeFly2139MaintenanceVacuum({
					database: "teamlead",
					databasePath,
					evidenceDir,
					maxDurationMs: 30_000,
					allowFixturePaths: true,
					testHooks: {
						availableBytes: Number.MAX_SAFE_INTEGER,
						afterStarted: () => {
							throw new Error("injected_after_started");
						},
					},
				}),
			).rejects.toThrow("injected_after_started");
			const started = readSealedJson(
				join(evidenceDir, "maintenance-teamlead-started.json"),
				"maintenance_started",
			);
			const recovered = await executeFly2139MaintenanceVacuum({
				database: "teamlead",
				databasePath,
				evidenceDir,
				maxDurationMs: 30_000,
				allowFixturePaths: true,
				testHooks: { availableBytes: Number.MAX_SAFE_INTEGER },
			});
			expect(recovered.recoveredFromStartedMarker).toBe(true);
			expect(recovered.before).toEqual(started.before);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects arbitrary database paths before opening them writable", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2139-vacuum-path-"));
		const originalHome = process.env.HOME;
		try {
			const databasePath = createBloatedDatabase(root);
			const emptyHome = join(root, "empty-home");
			mkdirSync(emptyHome);
			process.env.HOME = emptyHome;
			await expect(
				executeFly2139MaintenanceVacuum({
					database: "teamlead",
					databasePath,
					evidenceDir: join(root, "evidence"),
					maxDurationMs: 30_000,
				}),
			).rejects.toThrow("maintenance_database_path_not_canonical");
		} finally {
			if (originalHome === undefined) delete process.env.HOME;
			else process.env.HOME = originalHome;
			rmSync(root, { recursive: true, force: true });
		}
	});
});
