import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { canonicalSubmissionDigest } from "flywheel-config";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";
import { parseWorkflowRunSnapshot } from "../workflow-run-snapshot.js";
import { workflowSeedContentHash } from "../workflow-template.js";
import {
	importLegacyWorkflowSeeds,
	legacyWorkflowSeeds,
} from "./fixtures/legacy-workflow-manifests.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function seedHash(seed: {
	templateId: string;
	name: string;
	projectScope: string;
	manifest: unknown;
}): string {
	return canonicalSubmissionDigest({
		templateId: seed.templateId,
		name: seed.name,
		projectScope: seed.projectScope,
		manifest: seed.manifest,
	});
}

function generalizedOpsSeed() {
	const seed = {
		templateId: "tpl_ops_v2_test",
		name: "Ops no-code test",
		projectScope: "global",
		manifest: {
			schema_version: 2 as const,
			nodes: [
				{
					id: "execute",
					type: "generic" as const,
					vendor: "codex" as const,
					model: "gpt-5.6-sol",
					effort: "low" as const,
					agent_file: "agents/generic-executor.md",
				},
				{ id: "founder_gate", type: "gate" as const },
				{ id: "land", type: "land" as const, execution: "engine" as const },
			],
			edges: [
				{
					id: "execute_done",
					from: "execute",
					to: "founder_gate",
					condition: "node_done" as const,
				},
				{
					id: "founder_approved",
					from: "founder_gate",
					to: "land",
					condition: "founder_approved" as const,
				},
			],
			loops: [],
			approval_gate: {
				node: "founder_gate",
				predicate: "founder_approved" as const,
			},
			terminal_node: { node: "land" },
			ship_claims: ["founder_approved" as const],
		},
	};
	return { ...seed, contentHash: workflowSeedContentHash(seed) };
}

const WORKFLOW_ON = {
	FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
};

describe("StateStore workflow templates", () => {
	it.each([
		[1, "FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH", /dispatch.*disabled/i],
		[1, "FLYWHEEL_WORKFLOW_CLAIMS_WRITE", /claims.*write/i],
		[1, "FLYWHEEL_WORKFLOW_CLAIMS_READ", /claims.*read/i],
		[2, "FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH", /dispatch.*disabled/i],
		[2, "FLYWHEEL_WORKFLOW_CLAIMS_WRITE", /claims.*write/i],
		[2, "FLYWHEEL_WORKFLOW_CLAIMS_READ", /claims.*read/i],
		[2, "FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES", /generalized.*disabled/i],
	] as const)(
		"schema v%s materialization rejects without side effects when %s is removed",
		async (schemaVersion, missing, expected) => {
			const store = await StateStore.create(":memory:");
			const root = mkdtempSync(join(tmpdir(), "flywheel-materialize-flags-"));
			cleanups.push(() => rmSync(root, { recursive: true, force: true }));
			mkdirSync(join(root, "agents"));
			writeFileSync(
				join(root, "agents", "generic-executor.md"),
				"Execute the bounded node.\n",
			);
			const seed =
				schemaVersion === 1
					? legacyWorkflowSeeds().find(
							(candidate) => candidate.templateId === "tpl_eng_heavy",
						)!
					: generalizedOpsSeed();
			store.importWorkflowTemplateSeed(seed, WORKFLOW_ON);
			store.bindWorkflowCategory({
				project: "flywheel",
				taskCategory: "matrix",
				templateId: seed.templateId,
				updatedBy: "test",
			});
			const env = { ...WORKFLOW_ON };
			delete env[missing];
			const runId = `matrix-${schemaVersion}-${missing}`;
			const reservationKey = `start-${runId}`;
			expect(() =>
				store.materializeWorkflowRun({
					runId,
					issueId: `FLY-MATRIX-${schemaVersion}`,
					projectName: "flywheel",
					taskCategory: "matrix",
					claimsReadEnrolled: true,
					actor: "test",
					canonicalRoot: root,
					env,
					...(schemaVersion === 1
						? {
								startReservation: {
									idempotencyKey: reservationKey,
									selectionDigest: "selection",
									nodeId: "design",
									attempt: 1 as const,
									executionId: "design-matrix",
									createdAt: "2026-07-16T00:00:00.000Z",
								},
							}
						: {}),
				}),
			).toThrow(expected);
			expect(store.getWorkflowRun(runId)).toBeUndefined();
			expect(store.getWorkflowStartReservation(reservationKey)).toBeUndefined();
			expect(store.countWorkflowClaims(runId)).toBe(0);
			expect(store.listWorkflowSideEffects(runId)).toEqual([]);
			store.close();
		},
	);

	it("atomically pins a typed v1 snapshot and engine ownership only with a start reservation", async () => {
		const store = await StateStore.create(":memory:");
		const seed = legacyWorkflowSeeds().find(
			(candidate) => candidate.templateId === "tpl_eng_heavy",
		)!;
		store.importWorkflowTemplateSeed(seed);
		store.bindWorkflowCategory({
			project: "flywheel",
			taskCategory: "code",
			templateId: seed.templateId,
			updatedBy: "lead",
		});

		const engineRun = store.materializeWorkflowRun({
			runId: "run-engine-v1",
			issueId: "FLY-ENGINE",
			projectName: "flywheel",
			taskCategory: "code",
			claimsReadEnrolled: true,
			actor: "lead",
			env: {
				FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
				FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
				FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
			},
			startReservation: {
				idempotencyKey: "engine-start",
				selectionDigest: "selection-digest",
				nodeId: "design",
				attempt: 1,
				executionId: "design-exec",
				createdAt: "2026-07-16T00:00:00.000Z",
			},
		});
		expect(engineRun.engine_owned).toBe(1);
		expect(parseWorkflowRunSnapshot(engineRun.snapshot!)).toMatchObject({
			schema_version: 1,
			template: { id: "tpl_eng_heavy", revision: 1 },
		});

		const legacyRun = store.materializeWorkflowRun({
			runId: "run-legacy-v1",
			issueId: "FLY-LEGACY",
			projectName: "flywheel",
			taskCategory: "code",
			claimsReadEnrolled: false,
			actor: "lead",
		});
		expect(legacyRun.engine_owned).toBe(0);
		store.close();
	});

	it("freezes the gate carrier flag per run so a live toggle affects only the next materialization", async () => {
		const store = await StateStore.create(":memory:");
		const seed = legacyWorkflowSeeds().find(
			(candidate) => candidate.templateId === "tpl_eng_heavy",
		)!;
		store.importWorkflowTemplateSeed(seed);

		const materialize = (runId: string, issueId: string, enabled: "0" | "1") =>
			store.materializeWorkflowRun({
				runId,
				issueId,
				projectName: "flywheel",
				templateId: seed.templateId,
				claimsReadEnrolled: true,
				actor: "lead",
				env: {
					FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
					FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
					FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
					FLYWHEEL_WORKFLOW_GATE_CARRIER: enabled,
				},
				startReservation: {
					idempotencyKey: `start-${runId}`,
					selectionDigest: `selection-${runId}`,
					nodeId: "design",
					attempt: 1,
					executionId: `design-${runId}`,
					createdAt: "2026-07-23T00:00:00.000Z",
				},
			});

		const legacy = materialize("run-gate-epoch-0", "FLY-EPOCH-0", "0");
		const carrier = materialize("run-gate-epoch-1", "FLY-EPOCH-1", "1");

		expect(legacy.gate_carrier_epoch).toBe(0);
		expect(carrier.gate_carrier_epoch).toBe(1);
		expect(store.getWorkflowRun(legacy.run_id)?.gate_carrier_epoch).toBe(0);
		expect(store.getWorkflowRun(carrier.run_id)?.gate_carrier_epoch).toBe(1);
		store.close();
	});

	it("gates all schema-v2 mutation seams independently and requires the dispatch predicate before materialization", async () => {
		const store = await StateStore.create(":memory:");
		const root = mkdtempSync(join(tmpdir(), "flywheel-v2-agent-"));
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		mkdirSync(join(root, "agents"));
		writeFileSync(
			join(root, "agents", "generic-executor.md"),
			"Execute the bounded ops task.\n",
		);
		const seed = generalizedOpsSeed();
		expect(store.importWorkflowTemplateSeed(seed)).toMatchObject({
			status: "imported",
			revision: 1,
		});

		expect(() =>
			store.createWorkflowTemplateRevision({
				templateId: seed.templateId,
				manifest: seed.manifest,
				schemaVersion: 2,
				createdBy: "founder",
			}),
		).toThrow(/generalized.*disabled|flag/i);
		const revision2 = store.createWorkflowTemplateRevision({
			templateId: seed.templateId,
			manifest: seed.manifest,
			schemaVersion: 2,
			createdBy: "founder",
			env: { FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1" },
		});
		expect(() =>
			store.publishWorkflowTemplate({
				templateId: seed.templateId,
				revision: revision2,
				expectedRevision: 1,
				publishedBy: "founder",
			}),
		).toThrow(/generalized.*disabled|flag/i);
		expect(
			store.publishWorkflowTemplate({
				templateId: seed.templateId,
				revision: revision2,
				expectedRevision: 1,
				publishedBy: "founder",
				env: {
					FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
					FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
					FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
				},
			}),
		).toMatchObject({ status: "published", revision: revision2 });
		store.bindWorkflowCategory({
			project: "flywheel",
			taskCategory: "ops",
			templateId: seed.templateId,
			updatedBy: "lead",
		});
		expect(() =>
			store.materializeWorkflowRun({
				runId: "v2-claims-off",
				issueId: "FLY-X",
				projectName: "flywheel",
				taskCategory: "ops",
				claimsReadEnrolled: false,
				actor: "lead",
				canonicalRoot: root,
				env: {
					FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
					FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
					FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
				},
			}),
		).toThrow(/claims.*write/i);
		expect(store.getWorkflowRun("v2-claims-off")).toBeUndefined();
		const run = store.materializeWorkflowRun({
			runId: "v2-enabled",
			issueId: "FLY-X",
			projectName: "flywheel",
			taskCategory: "ops",
			claimsReadEnrolled: false,
			actor: "lead",
			canonicalRoot: root,
			env: {
				FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
				FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
				FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
				FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
			},
		});
		expect(parseWorkflowRunSnapshot(run.snapshot!).schema_version).toBe(2);
		// PR #748: the automatic `qa_exempt` claim is issued only when EVERY node
		// in the snapshot is non-writing (StateStore "all_nodes_no_write"). This
		// v2 seed contains a generic node, and generic now writes code — so the
		// run is correctly no longer auto-exempted from QA.
		expect(store.countWorkflowClaims(run.run_id)).toBe(0);
		store.close();
	});

	it("publishes with CAS and keeps revisions, publications, and audit append-only", async () => {
		const dir = mkdtempSync(join(tmpdir(), "flywheel-template-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const dbPath = join(dir, "state.db");
		const store = await StateStore.create(dbPath);
		const seed = legacyWorkflowSeeds()[0]!;
		const imported = store.importWorkflowTemplateSeed(seed);
		expect(imported).toMatchObject({ status: "imported", revision: 1 });
		expect(store.importWorkflowTemplateSeed(seed)).toEqual({
			status: "unchanged",
			revision: 1,
		});

		const founderManifest = {
			...seed.manifest,
			nodes: seed.manifest.nodes.map((node) =>
				node.id === "design" ? { ...node, effort: "high" as const } : node,
			),
		};
		const revision2 = store.createWorkflowTemplateRevision({
			templateId: seed.templateId,
			manifest: founderManifest,
			manifestDigest: canonicalSubmissionDigest(founderManifest),
			schemaVersion: 1,
			createdBy: "founder",
		});
		expect(revision2).toBe(2);
		expect(
			store.publishWorkflowTemplate({
				templateId: seed.templateId,
				revision: revision2,
				expectedRevision: 1,
				publishedBy: "founder",
			}),
		).toEqual({ status: "published", revision: 2 });
		expect(
			store.publishWorkflowTemplate({
				templateId: seed.templateId,
				revision: 1,
				expectedRevision: 1,
				publishedBy: "stale-editor",
			}),
		).toEqual({ status: "conflict", currentRevision: 2 });
		expect(
			store.listWorkflowTemplatePublications(seed.templateId),
		).toHaveLength(2);

		store.close();
		const raw = new BetterSqlite3(dbPath);
		expect(
			raw
				.prepare("PRAGMA table_info(workflow_template)")
				.all()
				.map((row) => (row as { name: string }).name),
		).toEqual([
			"template_id",
			"name",
			"project_scope",
			"current_published_revision",
			"created_by",
			"created_at",
			"seed_owner",
			"seed_content_hash",
			"retired_at",
		]);
		expect(
			raw
				.prepare("PRAGMA foreign_key_list(workflow_template)")
				.all()
				.map((row) => (row as { table: string }).table),
		).toContain("workflow_template_revision");
		expect(() =>
			raw.prepare("UPDATE workflow_template_revision SET created_by='x'").run(),
		).toThrow(/append-only/i);
		expect(() =>
			raw.prepare("DELETE FROM workflow_template_publication").run(),
		).toThrow(/append-only/i);
		expect(() =>
			raw.prepare("UPDATE workflow_template_audit SET actor='x'").run(),
		).toThrow(/append-only/i);
		expect(() =>
			raw
				.prepare(
					`INSERT OR REPLACE INTO workflow_template_audit
					 SELECT id, at, 'replacement', action, template_id, revision, run_id, detail
					 FROM workflow_template_audit LIMIT 1`,
				)
				.run(),
		).toThrow(/append-only/i);
		raw.close();
	});

	it("retires only unbound templates and keeps retired or unpublished templates out of bindings", async () => {
		const store = await StateStore.create(":memory:");
		const [boundSeed, retiredSeed, unpublishedSeed] = legacyWorkflowSeeds();
		store.importWorkflowTemplateSeed(boundSeed!);
		store.importWorkflowTemplateSeed(retiredSeed!);
		store.importWorkflowTemplateSeed(unpublishedSeed!);

		expect(
			store.retireWorkflowTemplate({
				templateId: "missing",
				actor: "operator",
				reason: "cleanup",
			}),
		).toEqual({ status: "not_found" });
		expect(() =>
			store.retireWorkflowTemplate({
				templateId: retiredSeed!.templateId,
				actor: "   ",
				reason: "cleanup",
			}),
		).toThrow(/actor.*non-empty/i);
		expect(() =>
			store.retireWorkflowTemplate({
				templateId: retiredSeed!.templateId,
				actor: "operator",
				reason: "   ",
			}),
		).toThrow(/reason.*non-empty/i);

		for (const [project, taskCategory] of [
			["z-project", "*"],
			["a-project", "z-code"],
			["a-project", "a-code"],
		] as const) {
			store.bindWorkflowCategory({
				project,
				taskCategory,
				templateId: boundSeed!.templateId,
				updatedBy: "operator",
			});
		}
		const expectedRefs = [
			{ project: "a-project", taskCategory: "a-code" },
			{ project: "a-project", taskCategory: "z-code" },
			{ project: "z-project", taskCategory: "*" },
		];
		expect(
			store.retireWorkflowTemplate({
				templateId: boundSeed!.templateId,
				actor: "operator",
				reason: "still live",
			}),
		).toEqual({ status: "refused_bound", refs: expectedRefs });

		(
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db.run(
			"UPDATE workflow_template SET retired_at = datetime('now') WHERE template_id = ?",
			[boundSeed!.templateId],
		);
		expect(
			store.retireWorkflowTemplate({
				templateId: boundSeed!.templateId,
				actor: "operator",
				reason: "surface corrupt legacy state",
			}),
		).toEqual({ status: "refused_bound", refs: expectedRefs });

		expect(
			store.retireWorkflowTemplate({
				templateId: retiredSeed!.templateId,
				actor: "  operator  ",
				reason: "  replaced by tpl_eng  ",
			}),
		).toEqual({ status: "retired" });
		expect(
			store.getWorkflowTemplate(retiredSeed!.templateId)?.retired_at,
		).toEqual(expect.any(String));
		expect(
			store.listWorkflowTemplateAudit(retiredSeed!.templateId),
		).toContainEqual(
			expect.objectContaining({
				action: "template_retire",
				actor: "operator",
				detail: JSON.stringify({ reason: "replaced by tpl_eng" }),
			}),
		);
		expect(
			store.retireWorkflowTemplate({
				templateId: retiredSeed!.templateId,
				actor: "operator",
				reason: "repeat",
			}),
		).toEqual({ status: "already_retired" });

		const bindingCount = store.listWorkflowCategoryBindings().length;
		const auditCount = store.listWorkflowTemplateAudit().length;
		expect(() =>
			store.bindWorkflowCategory({
				project: "flywheel",
				taskCategory: "retired",
				templateId: retiredSeed!.templateId,
				updatedBy: "operator",
			}),
		).toThrow(/published and not retired/i);
		expect(store.listWorkflowCategoryBindings()).toHaveLength(bindingCount);
		expect(store.listWorkflowTemplateAudit()).toHaveLength(auditCount);

		(
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db.run(
			"UPDATE workflow_template SET current_published_revision = NULL WHERE template_id = ?",
			[unpublishedSeed!.templateId],
		);
		expect(() =>
			store.bindWorkflowCategory({
				project: "flywheel",
				taskCategory: "unpublished",
				templateId: unpublishedSeed!.templateId,
				updatedBy: "operator",
			}),
		).toThrow(/published and not retired/i);
		store.close();
	});

	it("migrates the audit action check exactly once while preserving rows, triggers, and index", async () => {
		const dir = mkdtempSync(join(tmpdir(), "flywheel-audit-migration-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const dbPath = join(dir, "state.db");
		const legacy = new BetterSqlite3(dbPath);
		legacy.exec(`
			CREATE TABLE workflow_template_audit (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				at TEXT NOT NULL DEFAULT (datetime('now')),
				actor TEXT NOT NULL,
				action TEXT NOT NULL CHECK (
					action IN (
						'seed_import','publish','rebind','create','run_override',
						'template_retire'
					)
				),
				template_id TEXT,
				revision INTEGER,
				run_id TEXT,
				detail JSON
			);
			CREATE TRIGGER workflow_template_audit_no_update
			BEFORE UPDATE ON workflow_template_audit
			BEGIN SELECT RAISE(ABORT, 'workflow_template_audit is append-only'); END;
			CREATE TRIGGER workflow_template_audit_no_delete
			BEFORE DELETE ON workflow_template_audit
			BEGIN SELECT RAISE(ABORT, 'workflow_template_audit is append-only'); END;
			CREATE TRIGGER workflow_template_audit_no_replace
			BEFORE INSERT ON workflow_template_audit
			WHEN NEW.id IS NOT NULL AND EXISTS (
				SELECT 1 FROM workflow_template_audit WHERE id = NEW.id
			)
			BEGIN SELECT RAISE(ABORT, 'workflow_template_audit is append-only'); END;
			CREATE INDEX idx_workflow_template_audit_template
			ON workflow_template_audit(template_id, id);
		`);
		legacy
			.prepare(
				`INSERT INTO workflow_template_audit
				 (id, at, actor, action, template_id, revision, run_id, detail)
				 VALUES (7, '2026-07-21 00:00:00', 'system', 'seed_import',
				         'legacy-template', 1, NULL, '{"status":"imported"}')`,
			)
			.run();
		legacy.close();

		const first = await StateStore.create(dbPath);
		first.close();
		const migrated = new BetterSqlite3(dbPath);
		const table = migrated
			.prepare(
				"SELECT sql, rootpage FROM sqlite_master WHERE type='table' AND name='workflow_template_audit'",
			)
			.get() as { sql: string; rootpage: number };
		expect(table.sql).toContain("template_retire");
		expect(table.sql).toContain("unbind");
		expect(
			migrated
				.prepare(
					`SELECT id, at, actor, action, template_id, revision, run_id, detail
					 FROM workflow_template_audit`,
				)
				.all(),
		).toEqual([
			{
				id: 7,
				at: "2026-07-21 00:00:00",
				actor: "system",
				action: "seed_import",
				template_id: "legacy-template",
				revision: 1,
				run_id: null,
				detail: '{"status":"imported"}',
			},
		]);
		expect(
			migrated
				.prepare(
					`SELECT type, name FROM sqlite_master
					 WHERE name IN (
					   'workflow_template_audit_no_update',
					   'workflow_template_audit_no_delete',
					   'workflow_template_audit_no_replace',
					   'idx_workflow_template_audit_template'
					 ) ORDER BY name`,
				)
				.all(),
		).toEqual([
			{ type: "index", name: "idx_workflow_template_audit_template" },
			{ type: "trigger", name: "workflow_template_audit_no_delete" },
			{ type: "trigger", name: "workflow_template_audit_no_replace" },
			{ type: "trigger", name: "workflow_template_audit_no_update" },
		]);
		expect(() =>
			migrated.prepare("UPDATE workflow_template_audit SET actor='x'").run(),
		).toThrow(/append-only/i);
		expect(() =>
			migrated.prepare("DELETE FROM workflow_template_audit").run(),
		).toThrow(/append-only/i);
		expect(() =>
			migrated
				.prepare(
					`INSERT OR REPLACE INTO workflow_template_audit
					 (id, actor, action) VALUES (7, 'replacement', 'template_retire')`,
				)
				.run(),
		).toThrow(/append-only/i);
		expect(
			migrated
				.prepare("SELECT actor FROM workflow_template_audit WHERE id=7")
				.get(),
		).toEqual({ actor: "system" });
		expect(
			migrated
				.prepare(
					`INSERT INTO workflow_template_audit
					 (actor, action, template_id, detail)
					 VALUES ('system:FLY-1693-retirement', 'unbind',
					         'tpl_eng_heavy', '{"project":"growth"}')`,
				)
				.run().lastInsertRowid,
		).toBe(8);
		const migratedRootpage = table.rootpage;
		migrated.close();

		const second = await StateStore.create(dbPath);
		second.close();
		const reopened = new BetterSqlite3(dbPath);
		expect(
			(
				reopened
					.prepare(
						"SELECT rootpage FROM sqlite_master WHERE type='table' AND name='workflow_template_audit'",
					)
					.get() as { rootpage: number }
			).rootpage,
		).toBe(migratedRootpage);
		expect(
			reopened
				.prepare("SELECT COUNT(*) AS count FROM workflow_template_audit")
				.get(),
		).toEqual({ count: 2 });
		reopened.close();
	});

	it("imports a changed system seed as a new published revision", async () => {
		const store = await StateStore.create(":memory:");
		const seed = legacyWorkflowSeeds()[0]!;
		store.importWorkflowTemplateSeed(seed);
		const revisedManifest = {
			...seed.manifest,
			nodes: seed.manifest.nodes.map((node) =>
				node.id === "design" ? { ...node, effort: "high" as const } : node,
			),
		};
		const revised = {
			...seed,
			manifest: revisedManifest,
			contentHash: seedHash({ ...seed, manifest: revisedManifest }),
		};
		expect(store.importWorkflowTemplateSeed(revised)).toEqual({
			status: "updated",
			revision: 2,
		});
		expect(
			store.getWorkflowTemplate(seed.templateId)?.current_published_revision,
		).toBe(2);
		expect(store.listWorkflowTemplateRevisions(seed.templateId)).toHaveLength(
			2,
		);
		expect(
			store.listWorkflowTemplatePublications(seed.templateId),
		).toHaveLength(2);
		store.close();
	});

	it("refuses to overwrite a founder-owned seed and audits the refusal", async () => {
		const store = await StateStore.create(":memory:");
		const seed = legacyWorkflowSeeds()[0]!;
		store.importWorkflowTemplateSeed(seed);
		const founderManifest = {
			...seed.manifest,
			nodes: seed.manifest.nodes.map((node) =>
				node.id === "design" ? { ...node, effort: "high" as const } : node,
			),
		};
		store.createWorkflowTemplateRevision({
			templateId: seed.templateId,
			manifest: founderManifest,
			manifestDigest: canonicalSubmissionDigest(founderManifest),
			schemaVersion: 1,
			createdBy: "founder",
		});
		const changed = {
			...seed,
			manifest: founderManifest,
			contentHash: seedHash({ ...seed, manifest: founderManifest }),
		};
		expect(store.importWorkflowTemplateSeed(changed)).toEqual({
			status: "refused",
			revision: 1,
		});
		expect(store.listWorkflowTemplateAudit(seed.templateId)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					action: "seed_import",
					detail: expect.stringContaining("founder_owned_seed_mismatch"),
				}),
			]),
		);
		store.close();
	});

	it("treats seed name and project scope as content and enforces the scope at bind/materialize", async () => {
		const store = await StateStore.create(":memory:");
		const seed = legacyWorkflowSeeds()[0]!;
		store.importWorkflowTemplateSeed(seed);
		store.bindWorkflowCategory({
			project: "flywheel",
			taskCategory: "heavy",
			templateId: seed.templateId,
			updatedBy: "lead",
		});

		const narrowed = {
			...seed,
			name: "Engineering heavy for geoforge3d",
			projectScope: "geoforge3d",
		};
		narrowed.contentHash = seedHash(narrowed);
		expect(store.importWorkflowTemplateSeed(narrowed)).toEqual({
			status: "updated",
			revision: 2,
		});
		expect(store.getWorkflowTemplate(seed.templateId)).toMatchObject({
			name: narrowed.name,
			project_scope: "geoforge3d",
		});
		expect(() =>
			store.bindWorkflowCategory({
				project: "flywheel",
				taskCategory: "other",
				templateId: seed.templateId,
				updatedBy: "lead",
			}),
		).toThrow(/project scope/i);
		expect(() =>
			store.materializeWorkflowRun({
				runId: "wrong-project",
				issueId: "issue-2",
				projectName: "flywheel",
				taskCategory: "heavy",
				claimsReadEnrolled: false,
				actor: "lead",
			}),
		).toThrow(/project scope/i);
		store.close();
	});

	it("marks a founder publication pointer as founder-owned before later seed import", async () => {
		const store = await StateStore.create(":memory:");
		const seed = legacyWorkflowSeeds()[0]!;
		store.importWorkflowTemplateSeed(seed);
		const systemManifest = {
			...seed.manifest,
			nodes: seed.manifest.nodes.map((node) =>
				node.id === "design" ? { ...node, effort: "high" as const } : node,
			),
		};
		const revision2 = store.createWorkflowTemplateRevision({
			templateId: seed.templateId,
			manifest: systemManifest,
			schemaVersion: 1,
			createdBy: "system",
		});
		store.publishWorkflowTemplate({
			templateId: seed.templateId,
			revision: revision2,
			expectedRevision: 1,
			publishedBy: "system",
		});
		expect(
			store.publishWorkflowTemplate({
				templateId: seed.templateId,
				revision: 1,
				expectedRevision: revision2,
				publishedBy: "founder",
			}),
		).toEqual({ status: "published", revision: 1 });
		expect(store.getWorkflowTemplate(seed.templateId)?.seed_owner).toBe(
			"founder",
		);
		const futureSeed = {
			...seed,
			name: "Future system seed",
		};
		futureSeed.contentHash = seedHash(futureSeed);
		expect(store.importWorkflowTemplateSeed(futureSeed).status).toBe("refused");
		store.close();
	});

	it("pins the selected published revision plus reasoned override into the run snapshot", async () => {
		const store = await StateStore.create(":memory:");
		importLegacyWorkflowSeeds(store);
		store.bindWorkflowCategory({
			project: "flywheel",
			taskCategory: "small",
			templateId: "tpl_eng_light",
			updatedBy: "lead",
		});
		const run = store.materializeWorkflowRun({
			runId: "run-snapshot",
			issueId: "issue-1",
			projectName: "flywheel",
			taskCategory: "small",
			claimsReadEnrolled: false,
			override: {
				reason: "founder requested a direct implementation pass",
				nodes: { design: { skip: true } },
			},
			actor: "lead",
		});
		expect(run.template_id).toBe("tpl_eng_light");
		expect(run.template_revision).toBe(1);
		const snapshot = JSON.parse(run.snapshot!);
		expect(snapshot.template).toEqual({ id: "tpl_eng_light", revision: 1 });
		expect(snapshot.override.reason).toContain("founder requested");
		expect(
			snapshot.manifest.nodes.some(
				(node: { id: string }) => node.id === "design",
			),
		).toBe(false);
		expect(store.listWorkflowTemplateAudit("tpl_eng_light")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					action: "run_override",
					run_id: "run-snapshot",
				}),
			]),
		);
		store.close();
	});

	it("atomically appends and publishes one revision, with conflict rollback and run pinning", async () => {
		const store = await StateStore.create(":memory:");
		importLegacyWorkflowSeeds(store);
		store.bindWorkflowCategory({
			project: "flywheel",
			taskCategory: "heavy",
			templateId: "tpl_eng_heavy",
			updatedBy: "test",
		});
		const oldRun = store.materializeWorkflowRun({
			runId: "old-run",
			issueId: "issue-old",
			projectName: "flywheel",
			taskCategory: "heavy",
			claimsReadEnrolled: false,
			actor: "test",
		});
		const seed = legacyWorkflowSeeds()[0]!;
		const changed = {
			...seed.manifest,
			nodes: seed.manifest.nodes.map((node) =>
				node.id === "design" ? { ...node, effort: "high" as const } : node,
			),
		};
		const before = {
			revisions: store.listWorkflowTemplateRevisions(seed.templateId).length,
			publications: store.listWorkflowTemplatePublications(seed.templateId)
				.length,
			audit: store.listWorkflowTemplateAudit(seed.templateId).length,
		};
		expect(
			store.createAndPublishWorkflowTemplateRevision({
				templateId: seed.templateId,
				manifest: changed,
				expectedRevision: 1,
				createdBy: "founder",
			}),
		).toEqual({ status: "published", revision: 2 });
		expect(store.listWorkflowTemplateRevisions(seed.templateId)).toHaveLength(
			before.revisions + 1,
		);
		expect(
			store.listWorkflowTemplatePublications(seed.templateId),
		).toHaveLength(before.publications + 1);
		expect(store.listWorkflowTemplateAudit(seed.templateId)).toHaveLength(
			before.audit + 2,
		);

		const afterSuccess = {
			revisions: store.listWorkflowTemplateRevisions(seed.templateId).length,
			publications: store.listWorkflowTemplatePublications(seed.templateId)
				.length,
			audit: store.listWorkflowTemplateAudit(seed.templateId).length,
		};
		expect(
			store.createAndPublishWorkflowTemplateRevision({
				templateId: seed.templateId,
				manifest: changed,
				expectedRevision: 1,
				createdBy: "stale-editor",
			}),
		).toEqual({ status: "conflict", currentRevision: 2 });
		expect({
			revisions: store.listWorkflowTemplateRevisions(seed.templateId).length,
			publications: store.listWorkflowTemplatePublications(seed.templateId)
				.length,
			audit: store.listWorkflowTemplateAudit(seed.templateId).length,
		}).toEqual(afterSuccess);

		expect(
			JSON.parse(store.getWorkflowRun(oldRun.run_id)!.snapshot!).template
				.revision,
		).toBe(1);
		const newRun = store.materializeWorkflowRun({
			runId: "new-run",
			issueId: "issue-new",
			projectName: "flywheel",
			taskCategory: "heavy",
			claimsReadEnrolled: false,
			actor: "test",
		});
		expect(JSON.parse(newRun.snapshot!).template.revision).toBe(2);
		store.close();
	});
});
