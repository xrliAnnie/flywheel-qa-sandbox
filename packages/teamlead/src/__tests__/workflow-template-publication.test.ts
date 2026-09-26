import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	canonicalSubmissionDigest,
	getModelConfigSnapshot,
} from "flywheel-config";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";
import { loadWorkflowMenuSeeds } from "../workflow-menu.js";
import {
	buildWorkflowRunSnapshotV1,
	parseWorkflowRunSnapshot,
} from "../workflow-run-snapshot.js";
import { legacyEngineeringManifest } from "./fixtures/legacy-workflow-manifests.js";

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

async function rollbackFixture(path = ":memory:") {
	const { store, input } = await fixture(path);
	store.createAndPublishWorkflowTemplateRevision(input);
	const original = store.getWorkflowTemplateRevision(input.templateId, 1)!;
	const current = store.getWorkflowTemplateRevision(input.templateId, 2)!;
	const modelSnapshot = getModelConfigSnapshot();
	const rollback = {
		templateId: input.templateId,
		revision: 1,
		manifest: JSON.parse(original.manifest),
		expectedRevision: 2,
		createdBy: input.createdBy,
		modelSnapshot,
		publication: {
			...input.publication,
			operationId: randomUUID(),
			requestDigest: "c".repeat(64),
			sourceKind: "rollback" as const,
			sourceDigest: original.manifest_digest,
			expectedDigest: current.manifest_digest,
			registryRevision: modelSnapshot.revision,
		},
	};
	return { store, input, rollback };
}

function history(store: StateStore, templateId: string) {
	return {
		template: store.getWorkflowTemplate(templateId),
		revisions: store.listWorkflowTemplateRevisions(templateId),
		publications: store.listWorkflowTemplatePublications(templateId),
		audit: store.listWorkflowTemplateAudit(templateId),
	};
}
function database(store: StateStore) {
	return (
		store as unknown as { db: { run(sql: string, params?: unknown[]): void } }
	).db;
}

describe("managed historical workflow pointer rollback", () => {
	it("keeps revision bytes, records one publication audit and replays without writes", async () => {
		const { store, rollback } = await rollbackFixture();
		const before = history(store, rollback.templateId);
		expect(store.publishHistoricalWorkflowTemplateRevision(rollback)).toEqual({
			status: "published",
			revision: 1,
		});
		expect(store.listWorkflowTemplateRevisions(rollback.templateId)).toEqual(
			before.revisions,
		);
		expect(store.getWorkflowTemplate(rollback.templateId)).toMatchObject({
			current_published_revision: 1,
			seed_owner: "founder",
		});
		expect(
			store.listWorkflowTemplatePublications(rollback.templateId),
		).toHaveLength(before.publications.length + 1);
		const audit = store.listWorkflowTemplateAudit(rollback.templateId);
		expect(audit).toHaveLength(before.audit.length + 1);
		expect(audit.at(-1)).toMatchObject({
			actor: rollback.createdBy,
			action: "publish",
			revision: 1,
		});
		expect(JSON.parse(audit.at(-1)!.detail)).toMatchObject({
			sourceRevision: 1,
			sourceDigest: rollback.publication.sourceDigest,
			beforeDigest: rollback.publication.expectedDigest,
			afterDigest: rollback.publication.sourceDigest,
			operationId: rollback.publication.operationId,
			reason: rollback.publication.reason,
		});
		const receipt = store.getWorkflowTemplatePublishReceipt(
			rollback.publication.operationId,
		);
		expect(receipt).toMatchObject({
			published_revision: 1,
			source_kind: "rollback",
			source_digest: rollback.publication.sourceDigest,
			after_digest: rollback.publication.sourceDigest,
		});
		const after = history(store, rollback.templateId);
		expect(store.publishHistoricalWorkflowTemplateRevision(rollback)).toEqual({
			status: "published",
			revision: 1,
		});
		expect(history(store, rollback.templateId)).toEqual(after);
		expect(
			store.getWorkflowTemplatePublishReceipt(rollback.publication.operationId),
		).toEqual(receipt);
		expect(() =>
			store.publishHistoricalWorkflowTemplateRevision({
				...rollback,
				publication: { ...rollback.publication, requestDigest: "d".repeat(64) },
			}),
		).toThrow("operation_id_conflict");
	});

	it("records a same-target no-op once, then allocates max+1 for a new publication", async () => {
		const { store, input, rollback } = await rollbackFixture();
		store.publishHistoricalWorkflowTemplateRevision(rollback);
		const noop = {
			...rollback,
			expectedRevision: 1,
			publication: {
				...rollback.publication,
				operationId: randomUUID(),
				expectedDigest: rollback.publication.sourceDigest,
			},
		};
		const before = history(store, rollback.templateId);
		expect(store.publishHistoricalWorkflowTemplateRevision(noop)).toEqual({
			status: "published",
			revision: 1,
		});
		store.publishHistoricalWorkflowTemplateRevision(noop);
		expect(store.listWorkflowTemplateRevisions(rollback.templateId)).toEqual(
			before.revisions,
		);
		expect(store.listWorkflowTemplateAudit(rollback.templateId)).toHaveLength(
			before.audit.length + 1,
		);
		expect(
			store.createAndPublishWorkflowTemplateRevision({
				...input,
				publication: { ...input.publication, operationId: randomUUID() },
			}),
		).toEqual({ status: "published", revision: 3 });
	});

	it("retains rollback receipt and managed ownership through reopen and seed import", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2913-rollback-"));
		roots.push(root);
		const path = join(root, "teamlead.db");
		const { store, rollback } = await rollbackFixture(path);
		store.publishHistoricalWorkflowTemplateRevision(rollback);
		const receipt = store.getWorkflowTemplatePublishReceipt(
			rollback.publication.operationId,
		);
		const revisions = store.listWorkflowTemplateRevisions(rollback.templateId);
		store.close();
		stores.splice(stores.indexOf(store), 1);
		const reopened = await StateStore.create(path);
		stores.push(reopened);
		reopened.importWorkflowTemplateSeed(
			loadWorkflowMenuSeeds().find(
				(s) => s.templateId === rollback.templateId,
			)!,
		);
		expect(reopened.getWorkflowTemplate(rollback.templateId)).toMatchObject({
			current_published_revision: 1,
			seed_owner: "founder",
		});
		expect(reopened.listWorkflowTemplateRevisions(rollback.templateId)).toEqual(
			revisions,
		);
		expect(
			reopened.getWorkflowTemplatePublishReceipt(
				rollback.publication.operationId,
			),
		).toEqual(receipt);
		expect(
			reopened.hasManagedWorkflowTemplatePublication(rollback.templateId),
		).toBe(true);
		expect(() =>
			reopened.applyFly2602EffortPublication({
				templateId: rollback.templateId,
				manifest: rollback.manifest,
				expectedRevision: 1,
				modelSnapshot: rollback.modelSnapshot,
			}),
		).toThrow("fly2602_managed_publication_preserved");
	});

	it.each(["template", "revision"])(
		"rejects a missing target %s without writing",
		async (missing) => {
			const { store, rollback } = await rollbackFixture();
			const before = history(store, rollback.templateId);
			expect(
				store.publishHistoricalWorkflowTemplateRevision({
					...rollback,
					...(missing === "template"
						? { templateId: "missing" }
						: { revision: 999 }),
				}),
			).toEqual({ status: "not_found" });
			expect(history(store, rollback.templateId)).toEqual(before);
			expect(
				store.getWorkflowTemplatePublishReceipt(
					rollback.publication.operationId,
				),
			).toBeNull();
		},
	);

	it.each(["source", "canonical", "stored"])(
		"rejects %s digest tampering without writing",
		async (part) => {
			const { store, rollback } = await rollbackFixture();
			if (part === "source") rollback.publication.sourceDigest = "0".repeat(64);
			if (part === "canonical")
				rollback.manifest.nodes.find(
					(n: { id: string }) => n.id === "implement",
				).effort = "low";
			if (part === "stored") {
				database(store).run(
					"DROP TRIGGER workflow_template_revision_no_update",
				);
				database(store).run(
					"UPDATE workflow_template_revision SET manifest_digest = ? WHERE template_id = ? AND revision = 1",
					["0".repeat(64), rollback.templateId],
				);
				rollback.publication.sourceDigest = "0".repeat(64);
			}
			const before = history(store, rollback.templateId);
			expect(() =>
				store.publishHistoricalWorkflowTemplateRevision(rollback),
			).toThrow("historical_revision_digest_mismatch");
			expect(history(store, rollback.templateId)).toEqual(before);
			expect(
				store.getWorkflowTemplatePublishReceipt(
					rollback.publication.operationId,
				),
			).toBeNull();
		},
	);

	it.each(["revision", "digest"])(
		"enforces current %s CAS without half commits",
		async (part) => {
			const { store, rollback } = await rollbackFixture();
			if (part === "revision") rollback.expectedRevision = 1;
			else rollback.publication.expectedDigest = "0".repeat(64);
			const before = history(store, rollback.templateId);
			expect(store.publishHistoricalWorkflowTemplateRevision(rollback)).toEqual(
				{ status: "conflict", currentRevision: 2 },
			);
			expect(history(store, rollback.templateId)).toEqual(before);
			expect(
				store.getWorkflowTemplatePublishReceipt(
					rollback.publication.operationId,
				),
			).toBeNull();
		},
	);

	it.each(["retired", "registry", "invalid-model", "receipt", "audit"])(
		"rejects %s and rolls back every write",
		async (failure) => {
			const { store, rollback } = await rollbackFixture();
			let error = "";
			if (failure === "retired") {
				store.retireWorkflowTemplate({
					templateId: rollback.templateId,
					actor: "test",
					reason: "retired",
				});
				error = "template_retired";
			}
			if (failure === "registry") {
				rollback.publication.registryRevision = "changed";
				error = "model_registry_changed";
			}
			if (failure === "invalid-model") {
				rollback.manifest.nodes.find(
					(n: { id: string }) => n.id === "implement",
				).model = "retired-unavailable-model";
				rollback.publication.sourceDigest = canonicalSubmissionDigest(
					rollback.manifest,
				);
				database(store).run(
					"DROP TRIGGER workflow_template_revision_no_update",
				);
				database(store).run(
					"UPDATE workflow_template_revision SET manifest = ?, manifest_digest = ? WHERE template_id = ? AND revision = 1",
					[
						JSON.stringify(rollback.manifest),
						rollback.publication.sourceDigest,
						rollback.templateId,
					],
				);
				error = "model";
			}
			if (failure === "receipt" || failure === "audit") {
				const table =
					failure === "receipt"
						? "workflow_template_publish_receipt"
						: "workflow_template_audit";
				database(store).run(
					`CREATE TRIGGER reject_rollback BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'write_failed'); END`,
				);
				error = "write_failed";
			}
			const before = history(store, rollback.templateId);
			expect(() =>
				store.publishHistoricalWorkflowTemplateRevision(rollback),
			).toThrow(error);
			expect(history(store, rollback.templateId)).toEqual(before);
			expect(
				store.getWorkflowTemplatePublishReceipt(
					rollback.publication.operationId,
				),
			).toBeNull();
		},
	);

	it.each([
		["active", false],
		["held", false],
		["active", true],
		["held", true],
	] as const)(
		"preserves an unsafe %s run (valid snapshot=%s) and rejects rollback",
		async (status, validSnapshot) => {
			const { store, rollback } = await rollbackFixture();
			const snapshot = validSnapshot
				? JSON.stringify(
						buildWorkflowRunSnapshotV1({
							template: { id: rollback.templateId, revision: 2 },
							manifest: legacyEngineeringManifest(),
						}),
					)
				: "{}";
			if (validSnapshot)
				expect(
					parseWorkflowRunSnapshot(snapshot).resolved.nodes.some(
						(node) => node.type === "implement" && node.dispatchPinned !== true,
					),
				).toBe(true);
			database(store).run(
				"INSERT INTO workflow_run (run_id, issue_id, project_name, template_id, status, snapshot) VALUES (?, ?, ?, ?, ?, ?)",
				[
					"unsafe",
					"FLY-test",
					"flywheel",
					rollback.templateId,
					status,
					snapshot,
				],
			);
			const before = history(store, rollback.templateId);
			const run = store.getWorkflowRun("unsafe");
			expect(() =>
				store.publishHistoricalWorkflowTemplateRevision(rollback),
			).toThrow("active_run_not_pinned");
			expect(history(store, rollback.templateId)).toEqual(before);
			expect(store.getWorkflowRun("unsafe")).toEqual(run);
			expect(
				store.getWorkflowTemplatePublishReceipt(
					rollback.publication.operationId,
				),
			).toBeNull();
		},
	);
	it("leaves safe active and held run bytes pinned while new runs follow the rollback", async () => {
		const { store, rollback } = await rollbackFixture();
		store.bindWorkflowCategory({
			project: "flywheel",
			taskCategory: "simple_code",
			templateId: rollback.templateId,
			updatedBy: "test",
		});
		const materialize = (runId: string) =>
			store.materializeWorkflowRun({
				runId,
				issueId: runId,
				projectName: "flywheel",
				taskCategory: "simple_code",
				claimsReadEnrolled: false,
				actor: "test",
				canonicalRoot: fileURLToPath(new URL("../../../../", import.meta.url)),
			});
		materialize("active-pinned");
		materialize("held-pinned");
		database(store).run(
			"UPDATE workflow_run SET status = 'held' WHERE run_id = ?",
			["held-pinned"],
		);
		const active = store.getWorkflowRun("active-pinned")!;
		const held = store.getWorkflowRun("held-pinned")!;
		expect(JSON.parse(active.snapshot!).template.revision).toBe(2);
		expect(store.publishHistoricalWorkflowTemplateRevision(rollback)).toEqual({
			status: "published",
			revision: 1,
		});
		expect(store.getWorkflowRun("active-pinned")).toEqual(active);
		expect(store.getWorkflowRun("held-pinned")).toEqual(held);
		expect(
			JSON.parse(materialize("after-rollback").snapshot!).template.revision,
		).toBe(1);
	});
});
