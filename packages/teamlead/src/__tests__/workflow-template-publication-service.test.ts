import {
	canonicalSubmissionDigest,
	getModelConfigSnapshot,
} from "flywheel-config";
import { afterEach, describe, expect, it } from "vitest";
import { ConfirmTokenStore } from "../bridge/fleet-admin.js";
import { StateStore } from "../StateStore.js";
import { loadWorkflowMenuSeeds } from "../workflow-menu.js";
import { WorkflowTemplatePublicationService } from "../workflow-template-publication.js";

const stores: StateStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});
async function fixture(tokens = new ConfirmTokenStore()) {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	const seed = loadWorkflowMenuSeeds().find(
		(s) => s.templateId === "tpl_simple_code",
	)!;
	store.importWorkflowTemplateSeed(seed);
	let snapshot = getModelConfigSnapshot();
	const service = new WorkflowTemplatePublicationService({
		store,
		tokens,
		modelSnapshot: () => snapshot,
		runtimeBuildSha: "test-build",
		assertMigrationReady: () => {},
	});
	return {
		store,
		service,
		changeGeneration: () => {
			snapshot = { ...snapshot, revision: "changed" };
		},
	};
}
const request = {
	templateId: "tpl_simple_code",
	from: "seed",
	reason: "Publish reviewed seed",
};
describe("workflow publication stage and apply", () => {
	it("expires a staged token without publishing", async () => {
		let now = 0;
		const { service, store } = await fixture(
			new ConfirmTokenStore(100, () => now),
		);
		const stage = service.stage(request);
		now = 101;
		expect(() => service.apply(stage)).toThrow("confirmation_rejected");
		expect(
			store.getWorkflowTemplate(request.templateId)?.current_published_revision,
		).toBe(1);
	});

	it("rejects a recomputed digest when the caller changes a signed request", async () => {
		const { service } = await fixture();
		const stage = service.stage(request);
		const canonical = { ...stage.canonical, reason: "changed after staging" };
		expect(() =>
			service.apply({
				...stage,
				canonical,
				requestDigest: canonicalSubmissionDigest(canonical),
			}),
		).toThrow("confirmation_rejected");
	});

	it("replays a committed operation after model generation changes", async () => {
		const { service, changeGeneration } = await fixture();
		const stage = service.stage(request);
		const receipt = service.apply(stage);
		changeGeneration();
		expect(service.apply({ ...stage, confirmToken: "consumed" })).toEqual(
			receipt,
		);
	});
	it("stages without writing, then publishes and replays after response loss", async () => {
		const { store, service } = await fixture();
		const stage = service.stage(request);
		expect(
			store.getWorkflowTemplate(request.templateId)?.current_published_revision,
		).toBe(1);
		const receipt = service.apply(stage);
		expect(receipt).toMatchObject({
			published_revision: 2,
			actor: "bridge-local-operator",
			reason: request.reason,
		});
		expect(service.apply(stage)).toEqual(receipt);
	});
	it("rejects changed content under a staged token without writing", async () => {
		const { store, service } = await fixture();
		const stage = service.stage(request);
		expect(() =>
			service.apply({
				...stage,
				canonical: { ...stage.canonical, reason: "different" },
			}),
		).toThrow();
		expect(
			store.getWorkflowTemplate(request.templateId)?.current_published_revision,
		).toBe(1);
	});
	it("requires a new stage after registry generation changes", async () => {
		const { service, changeGeneration } = await fixture();
		const stage = service.stage(request);
		changeGeneration();
		expect(() => service.apply(stage)).toThrow("model_registry_changed");
	});
	it("rejects stale concurrent stages by CAS", async () => {
		const { service } = await fixture();
		const first = service.stage(request);
		const second = service.stage(request);
		service.apply(first);
		expect(() => service.apply(second)).toThrow("publication_conflict");
	});
	it.each([
		{ actor: "founder" },
		{ reason: "" },
		{ reason: "a\ncontrol" },
		{ expectedRevision: 1 },
		{ from: "file", file: "/etc/passwd" },
	])("rejects invalid stage input %j", async (override) => {
		const { service } = await fixture();
		expect(() => service.stage({ ...request, ...override })).toThrow();
	});
	it("rolls back by publishing historical contents as a new revision", async () => {
		const { store, service } = await fixture();
		const original = store.getWorkflowTemplateRevision(request.templateId, 1)!;
		const manifest = JSON.parse(original.manifest);
		manifest.nodes.find((n: { id: string }) => n.id === "implement").effort =
			"low";
		service.apply(service.stage({ ...request, from: "file", manifest }));
		const receipt = service.apply(
			service.stage({ ...request, from: "rollback", revision: 1 }),
		);
		expect(receipt).toMatchObject({
			published_revision: 3,
			after_digest: original.manifest_digest,
			source_kind: "rollback",
		});
	});
});
