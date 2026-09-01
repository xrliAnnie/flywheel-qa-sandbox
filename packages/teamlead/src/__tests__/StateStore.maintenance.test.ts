import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

describe("StateStore maintenance boundary", () => {
	it("opens an existing database readonly without migration or WAL checkpoint", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly1648-maint-ro-"));
		const dbPath = join(root, "teamlead.db");
		let writer: StateStore | undefined;
		let maintenance: StateStore | undefined;
		try {
			writer = await StateStore.create(dbPath);
			writer.upsertSession({
				execution_id: "maintenance-fixture",
				issue_id: "FLY-1648",
				project_name: "flywheel",
				status: "running",
			});
			const walPath = `${dbPath}-wal`;
			expect(existsSync(walPath)).toBe(true);
			const walSizeBefore = statSync(walPath).size;

			maintenance = await StateStore.openForMaintenance(dbPath, {
				readonly: true,
			});
			expect(maintenance.maintenanceDiagnostics()).toEqual({
				readonly: true,
				journalMode: "wal",
				foreignKeys: 1,
				busyTimeoutMs: 5000,
			});
			await expect(
				maintenance.backupTo(join(root, "forbidden.db")),
			).rejects.toThrow("maintenance_writable_mode_required");
			maintenance.close();
			maintenance = undefined;
			expect(statSync(walPath).size).toBe(walSizeBefore);
		} finally {
			maintenance?.close();
			writer?.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails closed for a missing file and for schema drift", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly1648-maint-drift-"));
		try {
			const missing = join(root, "missing.db");
			await expect(
				StateStore.openForMaintenance(missing, { readonly: true }),
			).rejects.toThrow("maintenance_database_missing");
			expect(existsSync(missing)).toBe(false);

			const drifted = join(root, "drifted.db");
			const raw = new Database(drifted);
			raw.pragma("journal_mode = WAL");
			raw.exec("CREATE TABLE workflow_run (run_id TEXT PRIMARY KEY)");
			raw.close();
			await expect(
				StateStore.openForMaintenance(drifted, { readonly: true }),
			).rejects.toThrow("maintenance_schema_mismatch");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps feature-specific dwell migration out of the shared maintenance boundary", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2210-maint-pre-migration-"));
		const dbPath = join(root, "teamlead.db");
		let maintenance: StateStore | undefined;
		try {
			const writer = await StateStore.create(dbPath);
			writer.close();
			const raw = new Database(dbPath);
			raw.exec("DROP TABLE node_dwell_review");
			raw.close();

			maintenance = await StateStore.openForMaintenance(dbPath, {
				readonly: true,
			});
			expect(maintenance.maintenanceDiagnostics().readonly).toBe(true);
			const proof = new Database(dbPath, { readonly: true });
			expect(
				proof
					.prepare(
						"SELECT 1 FROM sqlite_master WHERE type='table' AND name='node_dwell_review'",
					)
					.get(),
			).toBeUndefined();
			proof.close();
		} finally {
			maintenance?.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("enables apply-connection safety and creates a verified online backup", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly1648-maint-apply-"));
		const dbPath = join(root, "teamlead.db");
		const backupPath = join(root, "backups", "teamlead-pre-fly1648.db");
		let maintenance: StateStore | undefined;
		try {
			const store = await StateStore.create(dbPath);
			store.close();
			maintenance = await StateStore.openForMaintenance(dbPath, {
				readonly: false,
			});
			expect(maintenance.maintenanceDiagnostics()).toEqual({
				readonly: false,
				journalMode: "wal",
				foreignKeys: 1,
				busyTimeoutMs: 5000,
			});
			await maintenance.backupTo(backupPath);
			expect(existsSync(backupPath)).toBe(true);
			expect(maintenance.maintenanceIntegrityCheck()).toEqual({
				quickCheck: [{ quick_check: "ok" }],
				foreignKeyViolations: [],
			});
			const backup = new Database(backupPath, { readonly: true });
			expect(
				backup
					.prepare(
						"SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'workflow_rework_delivery'",
					)
					.get(),
			).toEqual({ present: 1 });
			backup.close();
		} finally {
			maintenance?.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
