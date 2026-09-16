import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkflowTemplateRouter } from "../bridge/workflow-template-routes.js";
import { StateStore } from "../StateStore.js";
import { migrateFly2121WorkflowCatalog } from "../workflow-catalog-migration.js";
import { migrateFly2602WorkflowEffort } from "../workflow-effort-migration.js";
import { loadWorkflowMenuSeeds } from "../workflow-menu.js";
import { legacyWorkflowSeeds } from "./fixtures/legacy-workflow-manifests.js";

const baseline = JSON.parse(
	readFileSync(
		new URL(
			"../../../../engineering/doc/FLY-2602-lead-effort-update/published-template-baseline.json",
			import.meta.url,
		),
		"utf8",
	),
);
const stores: StateStore[] = [];
const roots: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const s of stores.splice(0)) s.close();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

async function fixture(path = ":memory:") {
	const store = await StateStore.create(path);
	stores.push(store);
	store.importWorkflowTemplateSeed(
		legacyWorkflowSeeds().find((s) => s.templateId === "tpl_eng_heavy")!,
	);
	for (const seed of loadWorkflowMenuSeeds())
		store.importWorkflowTemplateSeed(seed);
	for (const row of baseline.filter(
		(r: { id: string }) => r.id !== "tpl_eng_heavy",
	)) {
		const result = store.createAndPublishWorkflowTemplateRevision({
			templateId: row.id,
			manifest: row.current_revision.manifest,
			expectedRevision: store.getWorkflowTemplate(row.id)!
				.current_published_revision,
			createdBy: "founder-management-console",
			allowUnsupportedModels: true,
		});
		expect(result.status).toBe("published");
	}
	return store;
}
function current(store: StateStore, id: string) {
	const t = store.getWorkflowTemplate(id)!;
	return store.getWorkflowTemplateRevision(id, t.current_published_revision!)!;
}

describe("FLY-2602 published workflow effort", () => {
	it("backs up before writing, persists its receipt across reopen, and retains historical runs", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2602-effort-"));
		roots.push(root);
		const path = join(root, "teamlead.db");
		const store = await fixture(path);
		const old = current(store, "tpl_code");
		const heavy = current(store, "tpl_eng_heavy");
		store.materializeWorkflowRun({
			canonicalRoot: new URL("../../../../", import.meta.url).pathname,
			runId: "historical",
			issueId: "FLY-2602",
			projectName: "fixture",
			templateId: "tpl_code",
			actor: "test",
			claimsReadEnrolled: false,
		});
		const run = store.getWorkflowRun("historical");
		expect(run?.snapshot).toContain("gpt-6-astra");
		const backupPath = join(root, "before.db");
		await migrateFly2602WorkflowEffort(store, { backupPath });
		expect(existsSync(backupPath)).toBe(true);
		expect(store.getWorkflowRun("historical")).toEqual(run);
		expect(current(store, "tpl_eng_heavy")).toEqual(heavy);
		const after = current(store, "tpl_code");
		stores.splice(stores.indexOf(store), 1);
		store.close();
		const reopened = await StateStore.create(path);
		stores.push(reopened);
		expect(
			(await migrateFly2602WorkflowEffort(reopened)).every(
				(r) => r.reason === "already_applied",
			),
		).toBe(true);
		expect(current(reopened, "tpl_code")).toEqual(after);
		const backup = await StateStore.create(backupPath);
		stores.push(backup);
		expect(current(backup, "tpl_code")).toEqual(old);
		expect(
			backup
				.listWorkflowCatalogMigrationAudit()
				.filter((r) => r.migration_id === "FLY-2602"),
		).toEqual([]);
	});
	it("leaves absent and retired templates inactive", async () => {
		const empty = await StateStore.create(":memory:");
		stores.push(empty);
		expect(
			(await migrateFly2602WorkflowEffort(empty)).every(
				(r) => r.reason === "inactive",
			),
		).toBe(true);
		const store = await fixture();
		store.retireWorkflowTemplate({
			templateId: "tpl_code",
			actor: "founder",
			reason: "test",
		});
		const before = store.getWorkflowTemplate("tpl_code");
		expect((await migrateFly2602WorkflowEffort(store))[0].reason).toBe(
			"inactive",
		);
		expect(store.getWorkflowTemplate("tpl_code")).toEqual(before);
	});
	it("does not mutate or prevent boot when the pre-mutation backup fails", async () => {
		const store = await fixture();
		const before = store.listWorkflowTemplateRevisions("tpl_code");
		const audit = store.listWorkflowCatalogMigrationAudit();
		vi.spyOn(store, "getDbPath").mockReturnValue("/isolated/teamlead.db");
		vi.spyOn(store, "createVerifiedOnlineBackup").mockRejectedValue(
			new Error("disk full"),
		);
		const result = await migrateFly2602WorkflowEffort(store, {
			backupPath: "/isolated/backup.db",
			warn: vi.fn(),
		});
		expect(result.map((r) => r.status)).toEqual(["failed", "skipped"]);
		expect(store.listWorkflowTemplateRevisions("tpl_code")).toEqual(before);
		expect(store.listWorkflowCatalogMigrationAudit()).toEqual(audit);
	});
	it("rolls back the revision and publication when its success audit fails", async () => {
		const store = await fixture();
		const before = current(store, "tpl_code");
		const revisions = store.listWorkflowTemplateRevisions("tpl_code");
		const publications = store.listWorkflowTemplatePublications("tpl_code");
		const record = store.recordFly2602EffortResult.bind(store);
		vi.spyOn(store, "recordFly2602EffortResult").mockImplementation(
			(id, reason, detail) => {
				if (id === "tpl_code") throw new Error("audit unavailable");
				record(id, reason, detail);
			},
		);
		await expect(
			migrateFly2602WorkflowEffort(store, { warn: vi.fn() }),
		).resolves.toBeDefined();
		expect(current(store, "tpl_code")).toEqual(before);
		expect(store.listWorkflowTemplateRevisions("tpl_code")).toEqual(revisions);
		expect(store.listWorkflowTemplatePublications("tpl_code")).toEqual(
			publications,
		);
	});
	it("contains CAS conflicts without leaving an orphan revision", async () => {
		const store = await fixture();
		const before = store.listWorkflowTemplateRevisions("tpl_code");
		const publish = store.createAndPublishWorkflowTemplateRevision.bind(store);
		vi.spyOn(
			store,
			"createAndPublishWorkflowTemplateRevision",
		).mockImplementation((input) =>
			publish({ ...input, expectedRevision: -1 }),
		);
		const result = await migrateFly2602WorkflowEffort(store, { warn: vi.fn() });
		expect(result.every((r) => r.status === "failed")).toBe(true);
		expect(store.listWorkflowTemplateRevisions("tpl_code")).toEqual(before);
	});
	it.each(["custom", "wrong-vendor", "missing", "duplicate", "invalid-graph"])(
		"preserves %s manifests instead of crashing boot",
		async (kind) => {
			const store = await fixture();
			const original = store.getWorkflowTemplateRevision.bind(store);
			const before = current(store, "tpl_code");
			vi.spyOn(store, "getWorkflowTemplateRevision").mockImplementation(
				(id, revision) => {
					const row = original(id, revision);
					if (id !== "tpl_code" || !row) return row;
					const manifest = JSON.parse(row.manifest);
					const node = manifest.nodes.find(
						(n: { id: string }) => n.id === "implement",
					);
					if (kind === "custom") node.effort = "high";
					if (kind === "wrong-vendor") node.vendor = "claude";
					if (kind === "missing")
						manifest.nodes = manifest.nodes.filter(
							(n: { id: string }) => n.id !== "implement",
						);
					if (kind === "duplicate") manifest.nodes.push({ ...node });
					if (kind === "invalid-graph") manifest.edges[0].to = "absent";
					return { ...row, manifest: JSON.stringify(manifest) };
				},
			);
			const result = await migrateFly2602WorkflowEffort(store, {
				warn: vi.fn(),
			});
			expect(result[0].status).toBe(
				kind === "invalid-graph" ? "failed" : "skipped",
			);
			expect(original("tpl_code", before.revision)).toEqual(before);
			expect(
				store.getWorkflowTemplate("tpl_code")!.current_published_revision,
			).toBe(before.revision);
		},
	);
	it("updates founder publications through the read API, preserving customizations and immutable history", async () => {
		const store = await fixture();
		await migrateFly2121WorkflowCatalog(store, loadWorkflowMenuSeeds());
		const ids = ["tpl_code", "tpl_simple_code"];
		const before = ids.map((id) => current(store, id));
		expect(
			JSON.parse(before[0].manifest).nodes.find(
				(n: { id: string }) => n.id === "implement",
			).effort,
		).toBe("medium");
		const result = await migrateFly2602WorkflowEffort(store);
		expect(result.map((r) => r.status)).toEqual(["published", "published"]);
		const app = express();
		app.use("/api/workflow", createWorkflowTemplateRouter(store));
		const server = createServer(app);
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		try {
			for (const [i, id] of ids.entries()) {
				const expected = JSON.parse(before[i].manifest);
				Object.assign(
					expected.nodes.find((n: { id: string }) => n.id === "implement"),
					{ model: "gpt-5.6-sol", effort: "xhigh" },
				);
				const response = await fetch(
					`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workflow/templates/${id}`,
				);
				const body = await response.json();
				expect(body.current_revision.manifest).toEqual(expected);
				expect(body.template.seed_owner).toBe("founder");
				expect(
					store.getWorkflowTemplateRevision(id, before[i].revision),
				).toEqual(before[i]);
			}
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
		const audit = store.listWorkflowCatalogMigrationAudit();
		const revisions = ids.map((id) => store.listWorkflowTemplateRevisions(id));
		await migrateFly2602WorkflowEffort(store);
		expect(store.listWorkflowCatalogMigrationAudit()).toEqual(audit);
		expect(ids.map((id) => store.listWorkflowTemplateRevisions(id))).toEqual(
			revisions,
		);
	});
	it("does not reapply after a later founder reversion", async () => {
		const store = await fixture();
		const old = current(store, "tpl_code");
		await migrateFly2602WorkflowEffort(store);
		store.createAndPublishWorkflowTemplateRevision({
			templateId: "tpl_code",
			manifest: JSON.parse(old.manifest),
			expectedRevision: current(store, "tpl_code").revision,
			createdBy: "founder",
			allowUnsupportedModels: true,
		});
		const reverted = current(store, "tpl_code");
		await migrateFly2602WorkflowEffort(store);
		expect(current(store, "tpl_code")).toEqual(reverted);
	});
	it("contains publication failures and continues with the other template", async () => {
		const store = await fixture();
		const before = current(store, "tpl_code");
		const publish = store.createAndPublishWorkflowTemplateRevision.bind(store);
		vi.spyOn(
			store,
			"createAndPublishWorkflowTemplateRevision",
		).mockImplementation((input) => {
			if (input.templateId === "tpl_code")
				throw new Error("injected publication failure");
			return publish(input);
		});
		const warn = vi.fn();
		const result = await migrateFly2602WorkflowEffort(store, { warn });
		expect(result.map((r) => r.status)).toEqual(["failed", "published"]);
		expect(current(store, "tpl_code")).toEqual(before);
		expect(warn).toHaveBeenCalled();
	});
});
