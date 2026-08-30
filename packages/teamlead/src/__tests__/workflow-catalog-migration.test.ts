import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";
import {
	FLY2121_REMOVABLE_TEMPLATE_IDS,
	migrateFly2121WorkflowCatalog,
	preflightWorkflowCatalogMigration,
} from "../workflow-catalog-migration.js";
import { loadWorkflowMenuSeeds } from "../workflow-menu.js";
import {
	RETIRED_BUNDLED_TEMPLATE_IDS,
	workflowSeedContentHash,
} from "../workflow-template.js";
import { importLegacyWorkflowSeeds } from "./fixtures/legacy-workflow-manifests.js";

const roots: string[] = [];
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function currentSeeds() {
	return loadWorkflowMenuSeeds();
}

function currentRoleNames(): string[] {
	return [
		...new Set(
			currentSeeds().flatMap((seed) =>
				seed.manifest.schema_version === 2
					? seed.manifest.nodes.flatMap((node) => {
							if (node.role) return [node.role];
							return node.type === "gate" || node.type === "land"
								? []
								: [node.id];
						})
					: [],
			),
		),
	];
}

async function legacyCatalog(dbPath = ":memory:") {
	const store = await StateStore.create(dbPath);
	for (const current of currentSeeds()) {
		const legacy = {
			...current,
			name: `Legacy ${current.name}`,
		};
		store.importWorkflowTemplateSeed({
			...legacy,
			contentHash: workflowSeedContentHash(legacy),
		});
	}
	importLegacyWorkflowSeeds(store);
	for (const templateId of RETIRED_BUNDLED_TEMPLATE_IDS) {
		expect(
			store.retireWorkflowTemplate({
				templateId,
				actor: "system:test",
				reason: "migration fixture",
			}).status,
		).toBe("retired");
	}
	store.bindWorkflowCategory({
		project: "flywheel",
		taskCategory: "design",
		templateId: "tpl_design",
		updatedBy: "system:test",
	});
	return store;
}

function triggerNames(store: StateStore): string[] {
	const raw = (
		store as unknown as {
			db: {
				raw: {
					prepare(sql: string): {
						all(): Array<{ name: string }>;
					};
				};
			};
		}
	).db.raw;
	return raw
		.prepare(
			`SELECT name FROM sqlite_master
			 WHERE type = 'trigger'
			   AND name IN (
			     'workflow_template_revision_no_delete',
			     'workflow_template_publication_no_delete'
			   ) ORDER BY name`,
		)
		.all()
		.map((row) => row.name);
}

function runSql(store: StateStore, sql: string, ...params: unknown[]): void {
	(
		store as unknown as {
			db: {
				raw: { prepare(sql: string): { run(...params: unknown[]): void } };
			};
		}
	).db.raw
		.prepare(sql)
		.run(...params);
}

function foreignKeyViolations(store: StateStore): unknown[] {
	return (
		store as unknown as {
			db: { raw: { pragma(sql: string): unknown[] } };
		}
	).db.raw.pragma("foreign_key_check");
}

describe("FLY-2121 workflow catalog startup migration", () => {
	it("preflights without writes, then renames all bindings, deletes only the zero-use whitelist, and imports all seeds atomically", async () => {
		const store = await legacyCatalog();
		store.bindWorkflowCategory({
			project: "personal-assistant",
			taskCategory: "design",
			templateId: "tpl_design",
			updatedBy: "system:test",
		});

		const plan = preflightWorkflowCatalogMigration(store, currentSeeds());
		expect(plan).toMatchObject({
			requiresMutation: true,
			bindingRows: 2,
			templatesToDelete: [...FLY2121_REMOVABLE_TEMPLATE_IDS],
		});
		expect(plan.seeds).toHaveLength(6);
		expect(plan.seeds.every((seed) => seed.status === "updated")).toBe(true);
		expect(
			store.getWorkflowCategoryBindingExact("flywheel", "design"),
		).toBeDefined();
		expect(store.getWorkflowTemplate("tpl_eng_light")).toBeDefined();
		expect(
			store.getWorkflowTemplate("tpl_code")?.current_published_revision,
		).toBe(1);

		const result = await migrateFly2121WorkflowCatalog(store, currentSeeds());
		expect(result.plan).toEqual(plan);
		expect(result.backupPath).toBeNull();
		expect(
			store.getWorkflowCategoryBindingExact("flywheel", "design"),
		).toBeUndefined();
		expect(
			store.getWorkflowCategoryBindingExact("flywheel", "product_design_flow"),
		).toMatchObject({ template_id: "tpl_design" });
		for (const templateId of FLY2121_REMOVABLE_TEMPLATE_IDS) {
			expect(store.getWorkflowTemplate(templateId)).toBeUndefined();
		}
		expect(store.getWorkflowTemplate("tpl_eng_heavy")).toBeDefined();
		for (const seed of currentSeeds()) {
			expect(store.getWorkflowTemplate(seed.templateId)).toMatchObject({
				current_published_revision: 2,
				seed_content_hash: seed.contentHash,
			});
		}
		expect(triggerNames(store)).toEqual([
			"workflow_template_publication_no_delete",
			"workflow_template_revision_no_delete",
		]);
		expect(
			preflightWorkflowCatalogMigration(store, currentSeeds()),
		).toMatchObject({ requiresMutation: false, bindingRows: 0 });
		store.close();
	});

	it("fails preflight on a category collision with zero writes", async () => {
		const collision = await legacyCatalog();
		collision.bindWorkflowCategory({
			project: "flywheel",
			taskCategory: "product_design_flow",
			templateId: "tpl_design",
			updatedBy: "founder:test",
		});
		expect(() =>
			preflightWorkflowCatalogMigration(collision, currentSeeds()),
		).toThrow("workflow_catalog_category_conflict:flywheel");
		expect(
			collision.getWorkflowCategoryBindingExact("flywheel", "design"),
		).toBeDefined();
		collision.close();
	});

	it("keeps undeletable retired templates, migrates safe rows, and records a visible skip", async () => {
		const referenced = await legacyCatalog();
		runSql(
			referenced,
			"UPDATE workflow_template SET seed_owner = 'founder' WHERE template_id = ?",
			"tpl_eng",
		);
		runSql(
			referenced,
			"UPDATE workflow_template SET retired_at = NULL WHERE template_id = ?",
			"tpl_eng_trivial",
		);
		referenced.createWorkflowRun({
			runId: "historical-run",
			issueId: "FLY-old",
			projectName: "flywheel",
			templateId: "tpl_eng_light",
			templateRevision: 1,
			claimsReadEnrolled: false,
		});
		const before = referenced.getWorkflowTemplate("tpl_eng_light");
		const founderBefore = referenced.getWorkflowTemplate("tpl_eng");
		const activeBefore = referenced.getWorkflowTemplate("tpl_eng_trivial");

		const result = await migrateFly2121WorkflowCatalog(
			referenced,
			currentSeeds(),
		);

		expect(result.plan.templateSkips).toContainEqual(
			expect.objectContaining({
				templateId: "tpl_eng_light",
				reason: "referenced",
			}),
		);
		expect(result.plan.templateSkips).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					templateId: "tpl_eng",
					reason: "founder_owned",
				}),
				expect.objectContaining({
					templateId: "tpl_eng_trivial",
					reason: "not_retired",
				}),
			]),
		);
		expect(referenced.getWorkflowTemplate("tpl_eng_light")).toEqual(before);
		expect(referenced.getWorkflowTemplate("tpl_eng")).toEqual(founderBefore);
		expect(referenced.getWorkflowTemplate("tpl_eng_trivial")).toEqual(
			activeBefore,
		);
		expect(
			referenced.getWorkflowCategoryBindingExact(
				"flywheel",
				"product_design_flow",
			),
		).toBeDefined();
		expect(
			referenced
				.listWorkflowCatalogMigrationAudit()
				.some(
					(row) =>
						row.migration_id === "FLY-2121" && row.item_id === "tpl_eng_light",
				),
		).toBe(true);
		expect(
			preflightWorkflowCatalogMigration(referenced, currentSeeds()),
		).toMatchObject({ requiresMutation: false });
		referenced.close();
	});

	it("boots through founder-owned seed customization and preserves it byte-for-byte", async () => {
		const founderOwned = await legacyCatalog();
		const prdSeed = currentSeeds().find(
			(seed) => seed.templateId === "tpl_prd",
		)!;
		const founderRevision = founderOwned.createWorkflowTemplateRevision({
			templateId: prdSeed.templateId,
			manifest: prdSeed.manifest,
			schemaVersion: prdSeed.manifest.schema_version,
			createdBy: "founder:test",
		});
		founderOwned.publishWorkflowTemplate({
			templateId: prdSeed.templateId,
			revision: founderRevision,
			expectedRevision: 1,
			publishedBy: "founder:test",
		});
		const before = founderOwned.getWorkflowTemplate(prdSeed.templateId);
		const beforeRevisions = founderOwned.listWorkflowTemplateRevisions(
			prdSeed.templateId,
		);

		const result = await migrateFly2121WorkflowCatalog(
			founderOwned,
			currentSeeds(),
		);

		expect(result.plan.seeds).toContainEqual(
			expect.objectContaining({
				templateId: "tpl_prd",
				status: "skipped",
				reason: "founder_owned",
			}),
		);
		expect(founderOwned.getWorkflowTemplate(prdSeed.templateId)).toEqual(
			before,
		);
		expect(
			founderOwned.listWorkflowTemplateRevisions(prdSeed.templateId),
		).toEqual(beforeRevisions);
		expect(
			founderOwned.getWorkflowCategoryBindingExact(
				"flywheel",
				"product_design_flow",
			),
		).toBeDefined();
		expect(
			founderOwned
				.listWorkflowCatalogMigrationAudit()
				.some(
					(row) => row.migration_id === "FLY-2121" && row.item_id === "tpl_prd",
				),
		).toBe(true);
		expect(
			preflightWorkflowCatalogMigration(founderOwned, currentSeeds()),
		).toMatchObject({ requiresMutation: false });
		founderOwned.close();
	});

	it("marks a protected pre-cutover role manifest unrunnable and fails dispatch with an explicit FLY-2121 diagnostic", async () => {
		const founderOwned = await legacyCatalog();
		const productDesignSeed = currentSeeds().find(
			(seed) => seed.templateId === "tpl_design",
		)!;
		if (productDesignSeed.manifest.schema_version !== 2) {
			throw new Error("expected tpl_design schema v2");
		}
		const preCutoverManifest = {
			...productDesignSeed.manifest,
			nodes: productDesignSeed.manifest.nodes.map((node) =>
				node.id === "product_design" ? { ...node, role: "designer" } : node,
			),
		};
		const founderRevision = founderOwned.createWorkflowTemplateRevision({
			templateId: productDesignSeed.templateId,
			manifest: preCutoverManifest,
			schemaVersion: 2,
			createdBy: "founder:test",
		});
		founderOwned.publishWorkflowTemplate({
			templateId: productDesignSeed.templateId,
			revision: founderRevision,
			expectedRevision: 1,
			publishedBy: "founder:test",
		});
		const before = founderOwned.getWorkflowTemplate(
			productDesignSeed.templateId,
		);
		const beforeRevisions = founderOwned.listWorkflowTemplateRevisions(
			productDesignSeed.templateId,
		);

		const result = await migrateFly2121WorkflowCatalog(
			founderOwned,
			currentSeeds(),
			{ resolvableRoleNames: currentRoleNames() },
		);

		expect(result.plan.seeds).toContainEqual(
			expect.objectContaining({
				templateId: "tpl_design",
				status: "skipped",
				reason: "founder_owned",
				unresolvableRoles: ["designer"],
			}),
		);
		expect(
			founderOwned.getWorkflowTemplate(productDesignSeed.templateId),
		).toEqual(before);
		expect(
			founderOwned.listWorkflowTemplateRevisions(productDesignSeed.templateId),
		).toEqual(beforeRevisions);
		const audit = founderOwned
			.listWorkflowCatalogMigrationAudit()
			.find(
				(row) =>
					row.item_kind === "seed_update" &&
					row.item_id === productDesignSeed.templateId,
			);
		expect(JSON.parse(audit?.detail ?? "{}")).toMatchObject({
			dispatchStatus: "unrunnable",
			unresolvableRoles: ["designer"],
		});

		let dispatchError: unknown;
		try {
			founderOwned.materializeWorkflowRun({
				runId: "fly2121-protected-template",
				issueId: "FLY-2121-RISK",
				projectName: "flywheel",
				templateId: productDesignSeed.templateId,
				claimsReadEnrolled: false,
				actor: "lead",
				canonicalRoot: REPO_ROOT,
			});
		} catch (error) {
			dispatchError = error;
		}
		expect(dispatchError).toMatchObject({
			name: "Fly2121PreservedTemplateUnrunnableError",
			code: "FLY2121_PRESERVED_TEMPLATE_UNRUNNABLE",
			templateId: "tpl_design",
			legacyRoles: ["designer"],
		});
		expect(
			founderOwned.getWorkflowRun("fly2121-protected-template"),
		).toBeUndefined();

		const repairedRevision =
			founderOwned.createAndPublishWorkflowTemplateRevision({
				templateId: productDesignSeed.templateId,
				manifest: productDesignSeed.manifest,
				expectedRevision: founderRevision,
				createdBy: "founder:test",
			});
		expect(repairedRevision).toMatchObject({
			status: "published",
			revision: founderRevision + 1,
		});
		await migrateFly2121WorkflowCatalog(founderOwned, currentSeeds(), {
			resolvableRoleNames: currentRoleNames(),
		});
		const repairedRun = founderOwned.materializeWorkflowRun({
			runId: "fly2121-repaired-template",
			issueId: "FLY-2121-REPAIRED",
			projectName: "flywheel",
			templateId: productDesignSeed.templateId,
			claimsReadEnrolled: false,
			actor: "lead",
			canonicalRoot: REPO_ROOT,
		});
		expect(repairedRun.run_id).toBe("fly2121-repaired-template");
		founderOwned.close();
	});

	it("keeps startup preflight available and fails dispatch explicitly when a protected manifest only validates in repair mode", async () => {
		const founderOwned = await legacyCatalog();
		const prdSeed = currentSeeds().find(
			(seed) => seed.templateId === "tpl_prd",
		)!;
		if (prdSeed.manifest.schema_version !== 2) {
			throw new Error("expected tpl_prd schema v2");
		}
		const repairOnlyManifest = {
			...prdSeed.manifest,
			nodes: prdSeed.manifest.nodes.map((node) =>
				node.id === "pm"
					? {
							...node,
							vendor: "claude" as const,
							model: "retired-model-alias-v0",
						}
					: node,
			),
		};
		const published = founderOwned.createAndPublishWorkflowTemplateRevision({
			templateId: prdSeed.templateId,
			manifest: repairOnlyManifest,
			expectedRevision: 1,
			createdBy: "founder:test",
			allowUnsupportedModels: true,
		});
		expect(published).toMatchObject({ status: "published", revision: 2 });

		const result = await migrateFly2121WorkflowCatalog(
			founderOwned,
			currentSeeds(),
			{ resolvableRoleNames: currentRoleNames() },
		);

		expect(result.plan.seeds).toContainEqual(
			expect.objectContaining({
				templateId: "tpl_prd",
				status: "skipped",
				reason: "founder_owned",
				manifestUnreadable: true,
			}),
		);
		const audit = founderOwned
			.listWorkflowCatalogMigrationAudit()
			.find(
				(row) =>
					row.item_kind === "seed_update" && row.item_id === prdSeed.templateId,
			);
		expect(JSON.parse(audit?.detail ?? "{}")).toMatchObject({
			dispatchStatus: "unrunnable",
			manifestStatus: "unreadable",
		});

		let dispatchError: unknown;
		try {
			founderOwned.materializeWorkflowRun({
				runId: "fly2121-repair-only-template",
				issueId: "FLY-2121-REPAIR-ONLY",
				projectName: "flywheel",
				templateId: prdSeed.templateId,
				claimsReadEnrolled: false,
				actor: "lead",
				canonicalRoot: REPO_ROOT,
			});
		} catch (error) {
			dispatchError = error;
		}
		expect(dispatchError).toMatchObject({
			name: "Fly2121PreservedTemplateUnrunnableError",
			code: "FLY2121_PRESERVED_TEMPLATE_UNRUNNABLE",
			templateId: "tpl_prd",
			legacyRoles: [],
		});
		expect(
			founderOwned.getWorkflowRun("fly2121-repair-only-template"),
		).toBeUndefined();
		founderOwned.close();
	});

	it("rolls back renamed bindings, deletions, seed revisions, and trigger DDL when a later seed step throws", async () => {
		const store = await legacyCatalog();
		const beforeTriggers = triggerNames(store);
		const beforeTemplates = store.listWorkflowTemplates();
		const beforeBindings = store.listWorkflowCategoryBindings();
		const beforeRevisions = new Map(
			currentSeeds().map((seed) => [
				seed.templateId,
				store.listWorkflowTemplateRevisions(seed.templateId),
			]),
		);

		await expect(
			migrateFly2121WorkflowCatalog(store, currentSeeds(), {
				onStep(step) {
					if (step === "seed:tpl_prd") throw new Error("injected_seed_fault");
				},
			}),
		).rejects.toThrow("injected_seed_fault");
		expect(store.listWorkflowTemplates()).toEqual(beforeTemplates);
		expect(store.listWorkflowCategoryBindings()).toEqual(beforeBindings);
		for (const [templateId, revisions] of beforeRevisions) {
			expect(store.listWorkflowTemplateRevisions(templateId)).toEqual(
				revisions,
			);
		}
		expect(triggerNames(store)).toEqual(beforeTriggers);
		store.close();
	});

	it("creates and verifies a file backup before applying the batch", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2121-catalog-"));
		roots.push(root);
		const dbPath = join(root, "teamlead.db");
		const backupPath = join(root, "backups", "teamlead.pre-fly2121.db");
		const store = await legacyCatalog(dbPath);

		const result = await migrateFly2121WorkflowCatalog(store, currentSeeds(), {
			backupPath,
		});
		expect(result.backupPath).toBe(backupPath);
		const backup = new Database(backupPath, {
			readonly: true,
			fileMustExist: true,
		});
		expect(backup.pragma("quick_check", { simple: true })).toBe("ok");
		expect(
			backup
				.prepare(
					"SELECT task_category FROM workflow_category_binding WHERE project = 'flywheel'",
				)
				.get(),
		).toEqual({ task_category: "design" });
		backup.close();
		store.close();
	});

	it("preserves the preflight FK baseline through backup and migration", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2121-catalog-fk-baseline-"));
		roots.push(root);
		const dbPath = join(root, "teamlead.db");
		const backupPath = join(root, "backups", "teamlead.pre-fly2121.db");
		const store = await legacyCatalog(dbPath);
		runSql(store, "CREATE TABLE qa_parent (id INTEGER PRIMARY KEY)");
		runSql(
			store,
			"CREATE TABLE qa_child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES qa_parent(id))",
		);
		runSql(store, "PRAGMA foreign_keys = OFF");
		runSql(store, "INSERT INTO qa_child (id, parent_id) VALUES (7, 404)");
		runSql(store, "PRAGMA foreign_keys = ON");

		const preflight = preflightWorkflowCatalogMigration(store, currentSeeds());
		expect(preflight.foreignKeyBaseline.violations).toEqual([
			{
				table: "qa_child",
				rowId: 7,
				parent: "qa_parent",
				foreignKeyId: 0,
			},
		]);
		expect(preflight.foreignKeyBaseline.fingerprint).toMatch(/^[a-f0-9]{64}$/);

		const result = await migrateFly2121WorkflowCatalog(store, currentSeeds(), {
			backupPath,
		});
		expect(result.plan.foreignKeyBaseline).toEqual(
			preflight.foreignKeyBaseline,
		);
		expect(foreignKeyViolations(store)).toHaveLength(1);
		const backup = new Database(backupPath, {
			readonly: true,
			fileMustExist: true,
		});
		expect(backup.pragma("foreign_key_check")).toHaveLength(1);
		backup.close();
		store.close();
	});

	it("rolls back and emits a typed failure for migration-added FK violations", async () => {
		const store = await legacyCatalog();
		runSql(store, "CREATE TABLE qa_parent (id INTEGER PRIMARY KEY)");
		runSql(
			store,
			`CREATE TABLE qa_child (
				id INTEGER PRIMARY KEY,
				parent_id INTEGER,
				FOREIGN KEY (parent_id) REFERENCES qa_parent(id)
					DEFERRABLE INITIALLY DEFERRED
			)`,
		);

		let failure: unknown;
		try {
			await migrateFly2121WorkflowCatalog(store, currentSeeds(), {
				onStep(step) {
					if (step === "bindings") {
						runSql(
							store,
							"INSERT INTO qa_child (id, parent_id) VALUES (8, 405)",
						);
					}
				},
			});
		} catch (error) {
			failure = error;
		}

		expect(failure).toMatchObject({
			name: "WorkflowCatalogMigrationIntegrityError",
			code: "FLY2121_WORKFLOW_CATALOG_MIGRATION_INTEGRITY_FAILED",
			stage: "apply_foreign_key_violation",
			addedViolations: [
				{
					table: "qa_child",
					rowId: 8,
					parent: "qa_parent",
					foreignKeyId: 0,
				},
			],
		});
		expect(foreignKeyViolations(store)).toEqual([]);
		store.close();
	});

	it("removes a backup and emits a typed failure when its FK set drifts from preflight", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2121-catalog-fk-drift-"));
		roots.push(root);
		const dbPath = join(root, "teamlead.db");
		const backupPath = join(root, "backups", "teamlead.pre-fly2121.db");
		const store = await legacyCatalog(dbPath);
		const baseline = preflightWorkflowCatalogMigration(
			store,
			currentSeeds(),
		).foreignKeyBaseline;
		runSql(store, "CREATE TABLE qa_parent (id INTEGER PRIMARY KEY)");
		runSql(
			store,
			"CREATE TABLE qa_child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES qa_parent(id))",
		);
		runSql(store, "PRAGMA foreign_keys = OFF");
		runSql(store, "INSERT INTO qa_child (id, parent_id) VALUES (9, 406)");
		runSql(store, "PRAGMA foreign_keys = ON");

		await expect(
			store.createVerifiedOnlineBackup(backupPath, baseline),
		).rejects.toMatchObject({
			name: "WorkflowCatalogMigrationIntegrityError",
			code: "FLY2121_WORKFLOW_CATALOG_MIGRATION_INTEGRITY_FAILED",
			stage: "backup_foreign_key_baseline_drift",
			addedViolations: [
				expect.objectContaining({ table: "qa_child", rowId: 9 }),
			],
		});
		expect(existsSync(backupPath)).toBe(false);
		store.close();
	});
});
