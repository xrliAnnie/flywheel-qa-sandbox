import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";
import { loadWorkflowMenuSeeds } from "../workflow-menu.js";

const stores: StateStore[] = [];
const roots: string[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

async function fixture(path = ":memory:") {
	const store = await StateStore.create(path);
	stores.push(store);
	const seed = loadWorkflowMenuSeeds().find(
		(s) => s.templateId === "tpl_simple_code",
	)!;
	store.importWorkflowTemplateSeed(seed);
	const before = store.getWorkflowTemplateRevision(seed.templateId, 1)!;
	const manifest = JSON.parse(before.manifest);
	manifest.nodes.find((n: { id: string }) => n.id === "implement").effort =
		"high";
	const input = {
		templateId: seed.templateId,
		manifest,
		expectedRevision: 1,
		createdBy: "bridge-local-operator",
		publication: {
			operationId: randomUUID(),
			requestDigest: "a".repeat(64),
			reason: "Raise implement effort",
			sourceKind: "file" as const,
			sourceDigest: "b".repeat(64),
			registryRevision: "generation-1",
			runtimeBuildSha: "test-build",
			expectedDigest: before.manifest_digest,
		},
	};
	return { store, input };
}

describe("managed workflow publication transaction", () => {
	it("keeps receipt and manual ownership across database reopen and seed import", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2606-publication-"));
		roots.push(root);
		const path = join(root, "teamlead.db");
		const { store, input } = await fixture(path);
		store.createAndPublishWorkflowTemplateRevision(input);
		const receipt = store.getWorkflowTemplatePublishReceipt(
			input.publication.operationId,
		);
		store.close();
		stores.splice(stores.indexOf(store), 1);
		const reopened = await StateStore.create(path);
		stores.push(reopened);
		const seed = loadWorkflowMenuSeeds().find(
			(s) => s.templateId === input.templateId,
		)!;
		reopened.importWorkflowTemplateSeed(seed);
		expect(
			reopened.getWorkflowTemplatePublishReceipt(input.publication.operationId),
		).toEqual(receipt);
		expect(reopened.getWorkflowTemplate(input.templateId)).toMatchObject({
			current_published_revision: 2,
			seed_owner: "founder",
		});
	});

	it.each(["active", "held"])(
		"rejects a %s run with an unverifiable snapshot without writing",
		async (status) => {
			const { store, input } = await fixture();
			const db = (
				store as unknown as {
					db: { run(sql: string, params: unknown[]): void };
				}
			).db;
			db.run(
				"INSERT INTO workflow_run (run_id, issue_id, project_name, template_id, status, snapshot) VALUES (?, ?, ?, ?, ?, ?)",
				["old-run", "FLY-test", "flywheel", input.templateId, status, "{}"],
			);
			expect(() =>
				store.createAndPublishWorkflowTemplateRevision(input),
			).toThrow("active_run_not_pinned");
			expect(
				store.getWorkflowTemplateRevision(input.templateId, 2),
			).toBeUndefined();
		},
	);

	it("refuses publication to a retired template", async () => {
		const { store, input } = await fixture();
		store.retireWorkflowTemplate({
			templateId: input.templateId,
			actor: "test",
			reason: "retired",
		});
		expect(() => store.createAndPublishWorkflowTemplateRevision(input)).toThrow(
			"template_retired",
		);
	});

	it("keeps the receipt append-only, including SQL replacement", async () => {
		const { store, input } = await fixture();
		store.createAndPublishWorkflowTemplateRevision(input);
		const db = (store as unknown as { db: { run(sql: string): void } }).db;
		expect(() =>
			db.run("DELETE FROM workflow_template_publish_receipt"),
		).toThrow("append-only");
		expect(() =>
			db.run(
				"UPDATE workflow_template_publish_receipt SET reason = 'rewritten'",
			),
		).toThrow("append-only");
		expect(() =>
			db.run(
				"INSERT OR REPLACE INTO workflow_template_publish_receipt SELECT * FROM workflow_template_publish_receipt",
			),
		).toThrow("append-only");
	});

	it("binds a durable receipt to one revision and replays without another write", async () => {
		const { store, input } = await fixture();
		expect(store.createAndPublishWorkflowTemplateRevision(input)).toEqual({
			status: "published",
			revision: 2,
		});
		expect(
			store.getWorkflowTemplatePublishReceipt(input.publication.operationId),
		).toMatchObject({
			request_digest: input.publication.requestDigest,
			published_revision: 2,
			before_digest: input.publication.expectedDigest,
			reason: input.publication.reason,
		});
		expect(store.createAndPublishWorkflowTemplateRevision(input)).toEqual({
			status: "published",
			revision: 2,
		});
		expect(
			store.getWorkflowTemplateRevision(input.templateId, 3),
		).toBeUndefined();
	});

	it("rejects reuse of an operation ID with different frozen content", async () => {
		const { store, input } = await fixture();
		store.createAndPublishWorkflowTemplateRevision(input);
		expect(() =>
			store.createAndPublishWorkflowTemplateRevision({
				...input,
				publication: { ...input.publication, requestDigest: "c".repeat(64) },
			}),
		).toThrow("operation_id_conflict");
	});

	it("checks the expected digest as well as revision before any write", async () => {
		const { store, input } = await fixture();
		expect(
			store.createAndPublishWorkflowTemplateRevision({
				...input,
				publication: { ...input.publication, expectedDigest: "0".repeat(64) },
			}),
		).toEqual({ status: "conflict", currentRevision: 1 });
		expect(
			store.getWorkflowTemplateRevision(input.templateId, 2),
		).toBeUndefined();
	});

	it("rolls back pointer, revision and audits if receipt insertion fails", async () => {
		const { store, input } = await fixture();
		const db = (store as unknown as { db: { run(sql: string): void } }).db;
		db.run(
			"CREATE TRIGGER reject_receipt BEFORE INSERT ON workflow_template_publish_receipt BEGIN SELECT RAISE(ABORT, 'receipt_failed'); END",
		);
		expect(() => store.createAndPublishWorkflowTemplateRevision(input)).toThrow(
			"receipt_failed",
		);
		expect(
			store.getWorkflowTemplate(input.templateId)?.current_published_revision,
		).toBe(1);
		expect(
			store.getWorkflowTemplateRevision(input.templateId, 2),
		).toBeUndefined();
		expect(
			store.getWorkflowTemplatePublishReceipt(input.publication.operationId),
		).toBeNull();
	});
});
