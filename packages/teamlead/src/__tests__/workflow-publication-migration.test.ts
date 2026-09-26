import { randomUUID } from "node:crypto";
import {
	canonicalSubmissionDigest,
	getModelConfigSnapshot,
} from "flywheel-config";
import { afterEach, expect, it } from "vitest";
import { ConfirmTokenStore } from "../bridge/fleet-admin.js";
import { StateStore } from "../StateStore.js";
import {
	isFly2602WorkflowEffortPending,
	migrateFly2602WorkflowEffort,
} from "../workflow-effort-migration.js";
import { loadWorkflowMenuSeeds } from "../workflow-menu.js";
import { WorkflowTemplatePublicationService } from "../workflow-template-publication.js";

const stores: StateStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});
async function fixture() {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	store.importWorkflowTemplateSeed(
		loadWorkflowMenuSeeds().find((s) => s.templateId === "tpl_simple_code")!,
	);
	return store;
}
function publish(store: StateStore, managed: boolean) {
	const template = store.getWorkflowTemplate("tpl_simple_code")!;
	const before = store.getWorkflowTemplateRevision(
		template.template_id,
		template.current_published_revision!,
	)!;
	const manifest = JSON.parse(before.manifest);
	Object.assign(
		manifest.nodes.find((n: { id: string }) => n.id === "implement"),
		{ vendor: "codex", model: "gpt-6-astra", effort: "medium" },
	);
	const published = store.createAndPublishWorkflowTemplateRevision({
		templateId: template.template_id,
		manifest,
		expectedRevision: before.revision,
		createdBy: "bridge-local-operator",
	});
	if (!managed || published.status !== "published") return published;
	const historical = store.getWorkflowTemplateRevision(
		template.template_id,
		published.revision,
	)!;
	const next = store.createAndPublishWorkflowTemplateRevision({
		templateId: template.template_id,
		manifest: JSON.parse(before.manifest),
		expectedRevision: published.revision,
		createdBy: "bridge-local-operator",
	});
	if (next.status !== "published")
		throw new Error("fixture publication failed");
	const current = store.getWorkflowTemplateRevision(
		template.template_id,
		next.revision,
	)!;
	return store.publishHistoricalWorkflowTemplateRevision({
		templateId: template.template_id,
		revision: historical.revision,
		manifest: JSON.parse(historical.manifest),
		expectedRevision: next.revision,
		createdBy: "bridge-local-operator",
		modelSnapshot: getModelConfigSnapshot(),
		publication: {
			operationId: randomUUID(),
			requestDigest: canonicalSubmissionDigest({
				revision: historical.revision,
			}),
			reason: "restore historical profile",
			sourceKind: "rollback",
			sourceDigest: historical.manifest_digest,
			registryRevision: getModelConfigSnapshot().revision,
			runtimeBuildSha: "test",
			expectedDigest: current.manifest_digest,
		},
	});
}
it("blocks unresolved matching migration sources but allows seeds the migration preserves", async () => {
	const store = await fixture();
	expect(isFly2602WorkflowEffortPending(store, "tpl_simple_code")).toBe(false);
	publish(store, false);
	expect(isFly2602WorkflowEffortPending(store, "tpl_simple_code")).toBe(true);
	await migrateFly2602WorkflowEffort(store);
	expect(isFly2602WorkflowEffortPending(store, "tpl_simple_code")).toBe(false);
});
it("preserves a managed historical-profile publication even without a prior 2602 success marker", async () => {
	const store = await fixture();
	publish(store, true);
	const before = store.getWorkflowTemplate("tpl_simple_code");
	const result = await migrateFly2602WorkflowEffort(store);
	expect(result).toContainEqual({
		templateId: "tpl_simple_code",
		status: "skipped",
		reason: "managed_publication_preserved",
	});
	expect(store.getWorkflowTemplate("tpl_simple_code")).toEqual(before);
	expect(isFly2602WorkflowEffortPending(store, "tpl_simple_code")).toBe(false);
});

it("checks migration readiness at both stage and apply", async () => {
	const store = await fixture();
	const service = new WorkflowTemplatePublicationService({
		store,
		tokens: new ConfirmTokenStore(),
		modelSnapshot: getModelConfigSnapshot,
		runtimeBuildSha: "test",
		assertMigrationReady: () => {},
	});
	const staged = service.stage({
		templateId: "tpl_simple_code",
		from: "seed",
		reason: "publish reviewed seed",
	});
	publish(store, false);
	expect(() =>
		service.stage({
			templateId: "tpl_simple_code",
			from: "seed",
			reason: "publish reviewed seed",
		}),
	).toThrow("catalog_migration_pending");
	expect(() => service.apply(staged)).toThrow("catalog_migration_pending");
});
