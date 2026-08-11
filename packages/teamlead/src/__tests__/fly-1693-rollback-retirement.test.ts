import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { executeRollback } from "../../../../scripts/fly-1693-rollback-retirement.mjs";

const REPO_ROOT = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../../..",
);
const SCRIPT = join(REPO_ROOT, "scripts/fly-1693-rollback-retirement.mjs");
const RETIRED_IDS = [
	"tpl_eng_heavy",
	"tpl_product_v1",
	"tpl_product_designer",
	"tpl_product_prototype",
	"tpl_generic",
	"tpl_eng",
	"tpl_eng_land_v1",
	"tpl_eng_heavy_land_v1",
	"tpl_eng_light",
	"tpl_eng_light_land_v1",
	"tpl_eng_trivial",
	"tpl_eng_trivial_land_v1",
] as const;
const RETIREMENT_ACTOR = "system:FLY-1693-retirement";
const ROLLBACK_ACTOR = "system:FLY-1693-rollback";
const PREVIOUS_OWNER = "system:FLY-1434-land-migration";
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function createFixture(input?: {
	retired?: boolean;
	journalMode?: "delete" | "wal";
}): { root: string; dbPath: string; db: Database.Database } {
	const root = mkdtempSync(join(tmpdir(), "fly1693-rollback-"));
	roots.push(root);
	const dbPath = join(root, "teamlead.db");
	const db = new Database(dbPath);
	db.pragma(`journal_mode = ${input?.journalMode ?? "delete"}`);
	db.exec(`
		CREATE TABLE workflow_template (
			template_id TEXT PRIMARY KEY,
			retired_at TEXT
		);
		CREATE TABLE workflow_category_binding (
			project TEXT NOT NULL,
			task_category TEXT NOT NULL,
			template_id TEXT NOT NULL,
			updated_by TEXT NOT NULL,
			updated_at TEXT NOT NULL DEFAULT (datetime('now')),
			PRIMARY KEY (project, task_category)
		);
		CREATE TABLE workflow_template_audit (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			at TEXT NOT NULL DEFAULT (datetime('now')),
			actor TEXT NOT NULL,
			action TEXT NOT NULL,
			template_id TEXT,
			revision INTEGER,
			run_id TEXT,
			detail JSON
		);
	`);
	const insert = db.prepare(
		"INSERT INTO workflow_template (template_id, retired_at) VALUES (?, ?)",
	);
	for (const templateId of RETIRED_IDS) {
		insert.run(
			templateId,
			input?.retired === false ? null : "2026-08-11T00:00:00.000Z",
		);
	}
	insert.run("tpl_code", null);
	return { root, dbPath, db };
}

function addUnbindAudit(
	db: Database.Database,
	input?: {
		templateId?: string;
		project?: string;
		category?: string;
		owner?: string;
		actor?: string;
		action?: string;
		detail?: unknown;
	},
): number {
	const templateId = input?.templateId ?? "tpl_eng_heavy";
	const detail =
		input && "detail" in input
			? input.detail
			: {
					project: input?.project ?? "geoforge3d",
					task_category: input?.category ?? "*",
					removed_template_id: templateId,
					previous_owner: input?.owner ?? PREVIOUS_OWNER,
				};
	return Number(
		db
			.prepare(
				`INSERT INTO workflow_template_audit
				 (actor, action, template_id, detail) VALUES (?, ?, ?, ?)`,
			)
			.run(
				input?.actor ?? RETIREMENT_ACTOR,
				input?.action ?? "unbind",
				templateId,
				JSON.stringify(detail),
			).lastInsertRowid,
	);
}

function binding(db: Database.Database) {
	return db
		.prepare(
			`SELECT project, task_category, template_id, updated_by
			 FROM workflow_category_binding`,
		)
		.get();
}

function auditCount(db: Database.Database, actor = ROLLBACK_ACTOR): number {
	return Number(
		(
			db
				.prepare(
					"SELECT count(*) AS count FROM workflow_template_audit WHERE actor = ?",
				)
				.get(actor) as { count: number }
		).count,
	);
}

function retiredCount(db: Database.Database): number {
	return Number(
		(
			db
				.prepare(
					"SELECT count(*) AS count FROM workflow_template WHERE retired_at IS NOT NULL",
				)
				.get() as { count: number }
		).count,
	);
}

describe("FLY-1693 retirement rollback", () => {
	it.each([
		["unbind-only", false, "absent"],
		["unbind-only", false, "equal"],
		["unbind-only", false, "different"],
		["mixed", true, "absent"],
		["mixed", true, "equal"],
		["mixed", true, "different"],
	] as const)(
		"handles %s (retired=%s) with a current binding that is %s",
		(_partial, retired, current) => {
			const { dbPath, db } = createFixture({ retired });
			const auditId = addUnbindAudit(db);
			if (current !== "absent") {
				db.prepare(
					`INSERT INTO workflow_category_binding
					 (project, task_category, template_id, updated_by)
					 VALUES ('geoforge3d', '*', ?, ?)`,
				).run(
					current === "equal" ? "tpl_eng_heavy" : "tpl_code",
					current === "equal" ? PREVIOUS_OWNER : "founder:annie",
				);
			}

			if (current === "different") {
				expect(() =>
					executeRollback({ dbPath, auditIds: [auditId], apply: true }),
				).toThrow("binding_conflict");
				expect(retiredCount(db)).toBe(retired ? 12 : 0);
				expect(binding(db)).toMatchObject({
					template_id: "tpl_code",
					updated_by: "founder:annie",
				});
				expect(auditCount(db)).toBe(0);
			} else {
				const report = executeRollback({
					dbPath,
					auditIds: [auditId],
					apply: true,
				});
				expect(report.mode).toBe("apply");
				expect(retiredCount(db)).toBe(0);
				expect(binding(db)).toEqual({
					project: "geoforge3d",
					task_category: "*",
					template_id: "tpl_eng_heavy",
					updated_by: PREVIOUS_OWNER,
				});
				expect(auditCount(db)).toBe(current === "absent" ? 1 : 0);
			}
			db.close();
		},
	);

	it("handles retire-only state with an after-audit high-water selector", () => {
		const { dbPath, db } = createFixture({ retired: true });
		const report = executeRollback({
			dbPath,
			afterAuditId: 0,
			apply: true,
		});
		expect(report.sourceAudits).toHaveLength(0);
		expect(retiredCount(db)).toBe(0);
		expect(binding(db)).toBeUndefined();
		expect(auditCount(db)).toBe(0);
		db.close();
	});

	it("is idempotent and explicit ids disambiguate a later redeploy", () => {
		const { dbPath, db } = createFixture({ retired: true });
		const firstId = addUnbindAudit(db);
		executeRollback({ dbPath, auditIds: [firstId], apply: true });
		executeRollback({ dbPath, auditIds: [firstId], apply: true });
		expect(auditCount(db)).toBe(1);

		db.prepare(
			"UPDATE workflow_template SET retired_at = '2026-08-12' WHERE template_id = 'tpl_eng_heavy'",
		).run();
		db.prepare(
			"DELETE FROM workflow_category_binding WHERE project = 'geoforge3d' AND task_category = '*'",
		).run();
		const secondId = addUnbindAudit(db);
		executeRollback({ dbPath, auditIds: [secondId], apply: true });
		expect(auditCount(db)).toBe(2);
		const details = db
			.prepare(
				"SELECT detail FROM workflow_template_audit WHERE actor = ? ORDER BY id",
			)
			.all(ROLLBACK_ACTOR)
			.map((row) => JSON.parse(String((row as { detail: string }).detail)));
		expect(details.map((detail) => detail.source_unbind_audit_id)).toEqual([
			firstId,
			secondId,
		]);
		db.close();
	});

	it.each([
		["missing id", { missing: true }],
		["foreign action", { action: "rebind" }],
		["foreign actor", { actor: "founder:annie" }],
		["malformed detail", { detail: null }],
		[
			"mismatched template",
			{
				detail: {
					project: "geoforge3d",
					task_category: "*",
					removed_template_id: "tpl_eng",
					previous_owner: PREVIOUS_OWNER,
				},
			},
		],
		["foreign owner", { owner: "founder:annie" }],
		["empty project", { project: "" }],
	] as const)("rejects %s provenance with zero writes", (_label, mutation) => {
		const { dbPath, db } = createFixture({ retired: true });
		const auditId =
			"missing" in mutation
				? 999
				: addUnbindAudit(db, mutation as Parameters<typeof addUnbindAudit>[1]);
		expect(() =>
			executeRollback({ dbPath, auditIds: [auditId], apply: true }),
		).toThrow();
		expect(retiredCount(db)).toBe(12);
		expect(binding(db)).toBeUndefined();
		expect(auditCount(db)).toBe(0);
		db.close();
	});

	it("rejects conflicting expectations for one project/category atomically", () => {
		const { dbPath, db } = createFixture({ retired: true });
		const firstId = addUnbindAudit(db);
		const secondId = addUnbindAudit(db, { templateId: "tpl_eng" });
		expect(() =>
			executeRollback({
				dbPath,
				auditIds: [firstId, secondId],
				apply: true,
			}),
		).toThrow("duplicate_binding_expectation_conflict");
		expect(retiredCount(db)).toBe(12);
		expect(auditCount(db)).toBe(0);
		db.close();
	});

	it("holds a write lock from validation through the first mutation", () => {
		const { dbPath, db } = createFixture({ retired: true });
		const auditId = addUnbindAudit(db);
		let concurrentError: unknown;
		executeRollback({
			dbPath,
			auditIds: [auditId],
			apply: true,
			testHooks: {
				afterBegin() {
					const contender = new Database(dbPath, { fileMustExist: true });
					contender.pragma("busy_timeout = 0");
					try {
						contender
							.prepare(
								"UPDATE workflow_template SET retired_at = NULL WHERE template_id = 'tpl_eng'",
							)
							.run();
					} catch (error) {
						concurrentError = error;
					} finally {
						contender.close();
					}
				},
			},
		});
		expect(String(concurrentError)).toContain("database is locked");
		db.close();
	});

	it("dry-run is physically readonly, including existing WAL/SHM bytes", () => {
		const { dbPath, db } = createFixture({ retired: true, journalMode: "wal" });
		const auditId = addUnbindAudit(db);
		const paths = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
		const before = new Map(
			paths.map((path) => [path, existsSync(path) ? readFileSync(path) : null]),
		);
		const report = executeRollback({ dbPath, auditIds: [auditId] });
		expect(report.mode).toBe("dry-run");
		expect(report.bindings).toMatchObject({
			absent: 1,
			equal: 0,
			different: 0,
		});
		for (const path of paths) {
			expect(existsSync(path)).toBe(before.get(path) !== null);
			if (before.get(path))
				expect(readFileSync(path)).toEqual(before.get(path));
		}
		expect(retiredCount(db)).toBe(12);
		db.close();
	});

	it("the repo-root CLI resolves the package-owned sqlite dependency", () => {
		const { dbPath, db } = createFixture({ retired: true });
		const auditId = addUnbindAudit(db);
		db.close();
		const result = spawnSync(
			process.execPath,
			[SCRIPT, "--db", dbPath, "--audit-ids", String(auditId)],
			{ cwd: REPO_ROOT, encoding: "utf8" },
		);
		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({ mode: "dry-run" });
	});

	it("a typo database path fails closed without creating a file", () => {
		const root = mkdtempSync(join(tmpdir(), "fly1693-missing-"));
		roots.push(root);
		const dbPath = join(root, "typo.db");
		const result = spawnSync(
			process.execPath,
			[SCRIPT, "--db", dbPath, "--after-audit-id", "0"],
			{ cwd: REPO_ROOT, encoding: "utf8" },
		);
		expect(result.status).not.toBe(0);
		expect(existsSync(dbPath)).toBe(false);
	});
});
