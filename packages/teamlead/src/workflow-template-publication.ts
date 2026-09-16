import { randomUUID } from "node:crypto";
import {
	canonicalSubmissionDigest,
	type ModelConfigSnapshot,
} from "flywheel-config";
import type { ConfirmTokenStore } from "./bridge/fleet-admin.js";
import type {
	StateStore,
	WorkflowTemplatePublishReceipt,
} from "./StateStore.js";
import { isFly2602WorkflowEffortPending } from "./workflow-effort-migration.js";
import { loadWorkflowMenuSeeds } from "./workflow-menu.js";
import { validateWorkflowManifest } from "./workflow-template.js";

export class WorkflowPublicationError extends Error {
	constructor(
		readonly code: string,
		readonly status = 400,
	) {
		super(code);
	}
}
function fail(code: string, status = 400): never {
	throw new WorkflowPublicationError(code, status);
}
function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		fail("invalid_request");
	return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
	if (Object.keys(value).some((key) => !allowed.includes(key)))
		fail("unknown_field");
}
function text(value: unknown, name: string, max = 1000): string {
	if (
		typeof value !== "string" ||
		!value.trim() ||
		value.length > max ||
		Array.from(value).some(
			(char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
		)
	)
		fail(`invalid_${name}`);
	return value;
}
function operationId(value: unknown): string {
	const id = text(value, "operation_id", 36);
	if (
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
	)
		fail("invalid_operation_id");
	return id;
}
function templateId(value: unknown): string {
	const id = text(value, "template_id", 128);
	if (!/^[a-zA-Z0-9_-]+$/.test(id)) fail("invalid_template_id");
	return id;
}
function digest(value: unknown): string {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
		fail("invalid_digest");
	return value;
}
function revision(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1)
		fail("invalid_revision");
	return value as number;
}

export interface WorkflowPublicationCanonical {
	operationId: string;
	templateId: string;
	actor: "bridge-local-operator";
	reason: string;
	sourceKind: "seed" | "file" | "rollback";
	sourceRevision: number | null;
	sourceDigest: string;
	manifest: unknown;
	expectedRevision: number | null;
	expectedDigest: string | null;
	registryRevision: string;
	runtimeBuildSha: string;
}
export interface StagedWorkflowPublication {
	canonical: WorkflowPublicationCanonical;
	requestDigest: string;
	confirmToken: string;
}

/** Auth is enforced by the hosting route before calling any method, including status/replay. */
export class WorkflowTemplatePublicationService {
	constructor(
		private readonly deps: {
			store: StateStore;
			tokens: Pick<ConfirmTokenStore, "issue" | "verifyAndConsume" | "prune">;
			modelSnapshot: () => ModelConfigSnapshot;
			runtimeBuildSha: string;
			/** Must reject an unresolved migration that can overwrite this target. */
			assertMigrationReady: (templateId: string) => void;
		},
	) {}

	private assertMigrationReady(templateId: string): void {
		if (isFly2602WorkflowEffortPending(this.deps.store, templateId))
			fail("catalog_migration_pending", 409);
		this.deps.assertMigrationReady(templateId);
	}

	stage(input: unknown): StagedWorkflowPublication {
		const raw = record(input);
		if (Buffer.byteLength(JSON.stringify(raw), "utf8") > 512 * 1024)
			fail("request_too_large", 413);
		keys(raw, [
			"templateId",
			"from",
			"reason",
			"operationId",
			"manifest",
			"revision",
			"expectedRevision",
			"expectedDigest",
		]);
		const id = templateId(raw.templateId);
		const reason = text(raw.reason, "reason");
		const op =
			raw.operationId === undefined
				? randomUUID()
				: operationId(raw.operationId);
		if (!["seed", "file", "rollback"].includes(String(raw.from)))
			fail("invalid_source");
		const sourceKind = raw.from as WorkflowPublicationCanonical["sourceKind"];
		if (sourceKind !== "file" && raw.manifest !== undefined)
			fail("unexpected_manifest");
		if (sourceKind !== "rollback" && raw.revision !== undefined)
			fail("unexpected_revision");
		const template = this.deps.store.getWorkflowTemplate(id);
		if (!template) fail("template_not_found", 404);
		if (template.retired_at) fail("template_retired", 409);
		this.assertMigrationReady(id);
		const current =
			template.current_published_revision === null
				? null
				: this.deps.store.getWorkflowTemplateRevision(
						id,
						template.current_published_revision,
					);
		if (template.current_published_revision !== null && !current)
			fail("published_revision_missing", 409);
		if (
			(raw.expectedRevision === undefined) !==
			(raw.expectedDigest === undefined)
		)
			fail("expected_pair_required");
		const expectedRevision =
			raw.expectedRevision === undefined
				? template.current_published_revision
				: raw.expectedRevision === null
					? null
					: revision(raw.expectedRevision);
		const expectedDigest =
			raw.expectedDigest === undefined
				? (current?.manifest_digest ?? null)
				: raw.expectedDigest === null
					? null
					: digest(raw.expectedDigest);
		if (
			expectedRevision !== template.current_published_revision ||
			expectedDigest !== (current?.manifest_digest ?? null)
		)
			fail("publication_conflict", 409);
		const snapshot = this.deps.modelSnapshot();
		const sourceRevision =
			sourceKind === "rollback" ? revision(raw.revision) : null;
		let candidate: unknown;
		if (sourceKind === "seed") {
			candidate = loadWorkflowMenuSeeds(snapshot).find(
				(seed) => seed.templateId === id,
			)?.manifest;
			if (!candidate) fail("seed_not_found", 404);
		} else if (sourceKind === "rollback") {
			const historical = this.deps.store.getWorkflowTemplateRevision(
				id,
				sourceRevision!,
			);
			if (!historical) fail("revision_not_found", 404);
			candidate = JSON.parse(historical.manifest);
		} else candidate = raw.manifest;
		if (Buffer.byteLength(JSON.stringify(candidate) ?? "", "utf8") > 512 * 1024)
			fail("manifest_too_large", 413);
		let manifest: ReturnType<typeof validateWorkflowManifest>;
		try {
			manifest = validateWorkflowManifest(candidate, {
				modelSnapshot: snapshot,
			});
		} catch {
			fail("invalid_manifest");
		}
		const canonical: WorkflowPublicationCanonical = {
			operationId: op,
			templateId: id,
			actor: "bridge-local-operator",
			reason,
			sourceKind,
			sourceRevision,
			sourceDigest: canonicalSubmissionDigest(manifest),
			manifest,
			expectedRevision,
			expectedDigest,
			registryRevision: snapshot.revision,
			runtimeBuildSha: this.deps.runtimeBuildSha,
		};
		const requestDigest = canonicalSubmissionDigest(canonical);
		const prior = this.status(op);
		if (prior && prior.request_digest !== requestDigest)
			fail("operation_id_conflict", 409);
		this.deps.tokens.prune();
		return {
			canonical,
			requestDigest,
			confirmToken: this.deps.tokens.issue(requestDigest),
		};
	}

	apply(input: unknown): WorkflowTemplatePublishReceipt {
		const raw = record(input);
		if (Buffer.byteLength(JSON.stringify(raw), "utf8") > 512 * 1024)
			fail("request_too_large", 413);
		keys(raw, ["canonical", "requestDigest", "confirmToken"]);
		const c = record(raw.canonical);
		keys(c, [
			"operationId",
			"templateId",
			"actor",
			"reason",
			"sourceKind",
			"sourceRevision",
			"sourceDigest",
			"manifest",
			"expectedRevision",
			"expectedDigest",
			"registryRevision",
			"runtimeBuildSha",
		]);
		const op = operationId(c.operationId);
		templateId(c.templateId);
		if (c.actor !== "bridge-local-operator") fail("invalid_actor");
		const requestDigest = canonicalSubmissionDigest(c);
		if (digest(raw.requestDigest) !== requestDigest)
			fail("request_digest_mismatch");
		const prior = this.status(op);
		if (prior) {
			if (prior.request_digest !== requestDigest)
				fail("operation_id_conflict", 409);
			return prior;
		}
		const token = text(raw.confirmToken, "confirm_token", 128);
		const verdict = this.deps.tokens.verifyAndConsume(token, requestDigest);
		if (!verdict.ok) fail("confirmation_rejected", 403);
		// Only a server-issued token can reach this cast: it binds every field,
		// including source, actor, manifest and the captured CAS preimage.
		const canonical = c as unknown as WorkflowPublicationCanonical;
		const snapshot = this.deps.modelSnapshot();
		if (snapshot.revision !== canonical.registryRevision)
			fail("model_registry_changed", 409);
		this.assertMigrationReady(canonical.templateId);
		const result = this.deps.store.createAndPublishWorkflowTemplateRevision({
			templateId: canonical.templateId,
			manifest: canonical.manifest,
			expectedRevision: canonical.expectedRevision,
			createdBy: canonical.actor,
			modelSnapshot: snapshot,
			publication: { ...canonical, requestDigest },
		});
		if (result.status === "conflict") fail("publication_conflict", 409);
		if (result.status === "not_found") fail("template_not_found", 404);
		const receipt = this.status(op);
		if (!receipt) throw new Error("publication_receipt_missing");
		return receipt;
	}

	status(id: unknown): WorkflowTemplatePublishReceipt | null {
		return this.deps.store.getWorkflowTemplatePublishReceipt(operationId(id));
	}
}
