import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { canonicalSubmissionDigest } from "flywheel-config";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";
import {
	importBundledWorkflowSeeds,
	loadBundledWorkflowSeeds,
} from "../workflow-template.js";

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

describe("StateStore workflow templates", () => {
	it("publishes with CAS and keeps revisions, publications, and audit append-only", async () => {
		const dir = mkdtempSync(join(tmpdir(), "flywheel-template-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const dbPath = join(dir, "state.db");
		const store = await StateStore.create(dbPath);
		const seed = loadBundledWorkflowSeeds()[0]!;
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

	it("imports a changed system seed as a new published revision", async () => {
		const store = await StateStore.create(":memory:");
		const seed = loadBundledWorkflowSeeds()[0]!;
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
		const seed = loadBundledWorkflowSeeds()[0]!;
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
		const seed = loadBundledWorkflowSeeds()[0]!;
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
		const seed = loadBundledWorkflowSeeds()[0]!;
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
		importBundledWorkflowSeeds(store);
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
});
