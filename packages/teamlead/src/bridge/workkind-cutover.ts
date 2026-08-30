import { execFileSync } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import { parse } from "yaml";
import type {
	StateStore,
	WorkflowBindingCutoverBinding,
	WorkflowBindingCutoverReceipt,
} from "../StateStore.js";
import { workflowMenuBindings } from "../workflow-menu.js";
import { validateWorkflowManifest } from "../workflow-template.js";
import type { ConfirmTokenStore } from "./fleet-admin.js";
import { loopbackSelfOrigin } from "./loopback-origin.js";
import type { WorkKindConfigResult } from "./pipeline-config-source.js";

const ACTIVATION_ID = "FLY-1436";
const PROJECT = "flywheel";
const ACTOR = "system:fly-1436-cutover";
const SAFE_OPERATION_ID = /^fly-1436-(activate|restore)-[A-Za-z0-9._-]+$/;
const SAFE_ACTIVATION_OPERATION_ID = /^fly-1436-activate-[A-Za-z0-9._-]+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const REQUIRED_MENU_NODES = [
	"eng_design",
	"implement",
	"qa",
	"pm",
	"product_design",
	"proto",
	"general",
] as const;
const REQUIRED_MENU_ADOPTION = {
	"flywheel-eng-lead": ["code", "generic"],
	"flywheel-product-lead": ["prd", "product_design_flow", "prototype"],
} as const;

export const FLY1436_BASELINE_BINDINGS = [
	{ taskCategory: "*", templateId: "tpl_eng_heavy" },
] as const satisfies readonly WorkflowBindingCutoverBinding[];

export const FLY1436_TARGET_BINDINGS =
	workflowMenuBindings() satisfies readonly WorkflowBindingCutoverBinding[];
const WORKFLOW_MENU_SHAPES = FLY1436_TARGET_BINDINGS.map(
	(binding) => binding.taskCategory,
);

export interface Fly1436ActivationEvidence {
	templateDispatch: boolean;
	generalizedTemplates: boolean;
	workKind: boolean;
	prBAssetsReady: boolean;
	deployedSha: string;
	assetsDigest: string;
}

export interface Fly1436Snapshot {
	version: 1;
	activationId: typeof ACTIVATION_ID;
	sourceOperationId: string;
	project: typeof PROJECT;
	bindings: WorkflowBindingCutoverBinding[];
}

export interface WorkKindCutoverCanonical {
	version: 1;
	activationId: typeof ACTIVATION_ID;
	operationId: string;
	kind: "activate" | "restore";
	project: typeof PROJECT;
	actor: typeof ACTOR;
	sourceOperationId?: string;
	before: WorkflowBindingCutoverBinding[];
	after: WorkflowBindingCutoverBinding[];
	snapshotHash: string;
	expected?: Fly1436ActivationEvidence;
}

export interface WorkKindCutoverRouteDeps {
	store: StateStore;
	apiToken?: string;
	tokens: ConfirmTokenStore;
	readActivationEvidence: () => Fly1436ActivationEvidence;
	newOperationId?: (kind: "activate" | "restore") => string;
}

export interface Fly1436ActivationEvidenceOptions {
	projectRoot: string;
	pipelineEnrollment?: () => WorkKindConfigResult;
	readFile?: (path: string) => string;
	gitHead?: (projectRoot: string) => string;
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function parsedYamlRecord(source: string): Record<string, unknown> | undefined {
	try {
		const value = parse(source);
		return value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function menuAssetsReady(
	registrySource: string,
	adoptionSource: string,
): boolean {
	const registry = parsedYamlRecord(registrySource);
	const adoption = parsedYamlRecord(adoptionSource);
	if (!registry || !adoption) return false;
	const nodes = registry.nodes;
	const graphs = registry.graphs;
	if (
		!nodes ||
		typeof nodes !== "object" ||
		Array.isArray(nodes) ||
		!graphs ||
		typeof graphs !== "object" ||
		Array.isArray(graphs)
	) {
		return false;
	}
	const nodeRecord = nodes as Record<string, unknown>;
	const graphRecord = graphs as Record<string, unknown>;
	const nodesReady = REQUIRED_MENU_NODES.every((node) => {
		const value = nodeRecord[node];
		if (!value || typeof value !== "object" || Array.isArray(value))
			return false;
		const entry = value as Record<string, unknown>;
		return (
			typeof entry.file === "string" &&
			entry.file.trim() !== "" &&
			typeof entry.label === "string" &&
			entry.label.trim() !== ""
		);
	});
	const adoptionReady = Object.entries(REQUIRED_MENU_ADOPTION).every(
		([leadId, expected]) => {
			const actual = adoption[leadId];
			return (
				Array.isArray(actual) && expected.every((menu) => actual.includes(menu))
			);
		},
	);
	const graphsReady = WORKFLOW_MENU_SHAPES.every((graph) => {
		const value = graphRecord[graph];
		if (!value || typeof value !== "object" || Array.isArray(value))
			return false;
		const templateId = (value as Record<string, unknown>).templateId;
		return typeof templateId === "string" && templateId.trim() !== "";
	});
	return nodesReady && adoptionReady && graphsReady;
}

function sha256(value: unknown): string {
	return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function normalizeBindings(
	value: unknown,
): WorkflowBindingCutoverBinding[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const seen = new Set<string>();
	const bindings: WorkflowBindingCutoverBinding[] = [];
	for (const raw of value) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
		const record = raw as Record<string, unknown>;
		if (
			Object.keys(record).sort().join(",") !== "taskCategory,templateId" ||
			typeof record.taskCategory !== "string" ||
			typeof record.templateId !== "string"
		) {
			return undefined;
		}
		const taskCategory = record.taskCategory.trim();
		const templateId = record.templateId.trim();
		if (!taskCategory || !templateId || seen.has(taskCategory))
			return undefined;
		seen.add(taskCategory);
		bindings.push({ taskCategory, templateId });
	}
	return bindings;
}

function sameBindings(
	left: readonly WorkflowBindingCutoverBinding[],
	right: readonly WorkflowBindingCutoverBinding[],
): boolean {
	const ordered = (bindings: readonly WorkflowBindingCutoverBinding[]) =>
		[...bindings].sort((a, b) =>
			a.taskCategory < b.taskCategory
				? -1
				: a.taskCategory > b.taskCategory
					? 1
					: 0,
		);
	return JSON.stringify(ordered(left)) === JSON.stringify(ordered(right));
}

function exactBindings(store: StateStore): WorkflowBindingCutoverBinding[] {
	return store
		.listWorkflowCategoryBindings(PROJECT)
		.map((row) => ({
			taskCategory: row.task_category,
			templateId: row.template_id,
		}))
		.sort((a, b) =>
			a.taskCategory < b.taskCategory
				? -1
				: a.taskCategory > b.taskCategory
					? 1
					: 0,
		);
}

function validTargetTemplates(
	store: StateStore,
	bindings: readonly WorkflowBindingCutoverBinding[],
): string[] {
	const invalid: string[] = [];
	for (const binding of bindings) {
		const template = store.getWorkflowTemplate(binding.templateId);
		if (
			!template ||
			template.current_published_revision === null ||
			template.retired_at !== null ||
			(template.project_scope !== "global" &&
				template.project_scope !== PROJECT)
		) {
			invalid.push(binding.templateId);
			continue;
		}
		const revision = store.getWorkflowTemplateRevision(
			binding.templateId,
			template.current_published_revision,
		);
		try {
			if (
				!revision ||
				validateWorkflowManifest(JSON.parse(revision.manifest))
					.schema_version !== revision.schema_version
			) {
				invalid.push(binding.templateId);
			}
		} catch {
			invalid.push(binding.templateId);
		}
	}
	return [...new Set(invalid)].sort();
}

function activationPreflight(
	deps: WorkKindCutoverRouteDeps,
	evidence: Fly1436ActivationEvidence,
	expected?: Fly1436ActivationEvidence,
): {
	blockers: string[];
	releaseState: ReturnType<StateStore["getGeneralizedWorkflowReleaseState"]>;
} {
	const blockers: string[] = [];
	if (!evidence.templateDispatch) blockers.push("TEMPLATE_DISPATCH_OFF");
	if (!evidence.generalizedTemplates) blockers.push("GENERALIZED_OFF");
	if (!evidence.workKind) blockers.push("WORK_KIND_OFF");
	if (!evidence.prBAssetsReady) blockers.push("PR_B_ASSETS_NOT_DEPLOYED");
	if (
		!GIT_SHA.test(evidence.deployedSha) ||
		!SHA256.test(evidence.assetsDigest)
	) {
		blockers.push("DEPLOYMENT_EVIDENCE_UNAVAILABLE");
	}
	if (
		expected &&
		(evidence.deployedSha !== expected.deployedSha ||
			evidence.assetsDigest !== expected.assetsDigest)
	) {
		blockers.push("DEPLOYMENT_EVIDENCE_DRIFT");
	}
	const exactWildcard = deps.store.getWorkflowCategoryBindingExact(
		PROJECT,
		"*",
	);
	if (
		!exactWildcard ||
		exactWildcard.template_id !== FLY1436_BASELINE_BINDINGS[0].templateId ||
		!sameBindings(exactBindings(deps.store), FLY1436_BASELINE_BINDINGS)
	) {
		blockers.push("BINDING_BASELINE_DRIFT");
	}
	for (const templateId of validTargetTemplates(
		deps.store,
		FLY1436_TARGET_BINDINGS,
	)) {
		blockers.push(`TARGET_TEMPLATE_INVALID:${templateId}`);
	}
	const release = deps.store.getGeneralizedWorkflowReleaseState();
	if (!release.releasable) {
		blockers.push("GENERALIZED_RELEASABLE_STATE_NONZERO");
	}
	return { blockers, releaseState: release };
}

function parseReceipt(
	resultJson: string,
): WorkflowBindingCutoverReceipt | undefined {
	try {
		const receipt = JSON.parse(resultJson) as WorkflowBindingCutoverReceipt;
		return receipt &&
			typeof receipt === "object" &&
			!Array.isArray(receipt) &&
			typeof receipt.operationId === "string" &&
			typeof receipt.activationId === "string" &&
			(receipt.kind === "activate" || receipt.kind === "restore") &&
			typeof receipt.canonicalHash === "string" &&
			typeof receipt.snapshotHash === "string" &&
			typeof receipt.project === "string" &&
			Array.isArray(receipt.before) &&
			Array.isArray(receipt.after)
			? receipt
			: undefined;
	} catch {
		return undefined;
	}
}

function activationReceiptForRestore(
	deps: WorkKindCutoverRouteDeps,
	operationId: string,
):
	| {
			source: NonNullable<
				ReturnType<StateStore["getWorkflowBindingCutoverClaim"]>
			>;
			receipt: WorkflowBindingCutoverReceipt;
	  }
	| undefined {
	if (!SAFE_ACTIVATION_OPERATION_ID.test(operationId)) return undefined;
	const source = deps.store.getWorkflowBindingCutoverClaim(operationId);
	const receipt = source && parseReceipt(source.result_json);
	if (
		!source ||
		!receipt ||
		source.operation_id !== operationId ||
		source.activation_id !== ACTIVATION_ID ||
		source.kind !== "activate" ||
		source.source_operation_id !== null ||
		source.status !== "committed" ||
		source.canonical_hash !== receipt.canonicalHash ||
		source.snapshot_hash !== receipt.snapshotHash ||
		receipt.operationId !== operationId ||
		receipt.activationId !== ACTIVATION_ID ||
		receipt.kind !== "activate" ||
		receipt.project !== PROJECT ||
		!sameBindings(receipt.before, FLY1436_BASELINE_BINDINGS)
	) {
		return undefined;
	}
	return { source, receipt };
}

function canonicalSha(canonical: WorkKindCutoverCanonical): string {
	return sha256(canonical);
}

function snapshotHash(snapshot: Fly1436Snapshot): string {
	return sha256(snapshot);
}

function validEvidence(value: unknown): value is Fly1436ActivationEvidence {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		Object.keys(record).sort().join(",") ===
			"assetsDigest,deployedSha,generalizedTemplates,prBAssetsReady,templateDispatch,workKind" &&
		typeof record.templateDispatch === "boolean" &&
		typeof record.generalizedTemplates === "boolean" &&
		typeof record.workKind === "boolean" &&
		typeof record.prBAssetsReady === "boolean" &&
		typeof record.deployedSha === "string" &&
		typeof record.assetsDigest === "string" &&
		GIT_SHA.test(record.deployedSha) &&
		SHA256.test(record.assetsDigest)
	);
}

function parseCanonical(value: unknown): WorkKindCutoverCanonical | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return undefined;
	const record = value as Record<string, unknown>;
	if (
		record.version !== 1 ||
		record.activationId !== ACTIVATION_ID ||
		record.project !== PROJECT ||
		record.actor !== ACTOR ||
		(record.kind !== "activate" && record.kind !== "restore") ||
		typeof record.operationId !== "string" ||
		!SAFE_OPERATION_ID.test(record.operationId) ||
		!record.operationId.startsWith(`fly-1436-${record.kind}-`) ||
		typeof record.snapshotHash !== "string" ||
		!SHA256.test(record.snapshotHash)
	) {
		return undefined;
	}
	const before = normalizeBindings(record.before);
	const after = normalizeBindings(record.after);
	if (!before || !after) return undefined;
	if (record.kind === "activate") {
		if (
			Object.hasOwn(record, "sourceOperationId") ||
			!validEvidence(record.expected) ||
			!sameBindings(before, FLY1436_BASELINE_BINDINGS) ||
			!sameBindings(after, FLY1436_TARGET_BINDINGS)
		) {
			return undefined;
		}
	} else if (
		typeof record.sourceOperationId !== "string" ||
		!SAFE_ACTIVATION_OPERATION_ID.test(record.sourceOperationId) ||
		Object.hasOwn(record, "expected") ||
		!sameBindings(before, FLY1436_TARGET_BINDINGS) ||
		!sameBindings(after, FLY1436_BASELINE_BINDINGS)
	) {
		return undefined;
	}
	return {
		version: 1,
		activationId: ACTIVATION_ID,
		operationId: record.operationId,
		kind: record.kind,
		project: PROJECT,
		actor: ACTOR,
		...(record.kind === "restore"
			? { sourceOperationId: record.sourceOperationId as string }
			: {}),
		before,
		after,
		snapshotHash: record.snapshotHash,
		...(record.kind === "activate"
			? { expected: record.expected as Fly1436ActivationEvidence }
			: {}),
	};
}

function safeBearer(header: string | undefined, token: string): boolean {
	if (!header) return false;
	const actualBuffer = Buffer.from(header);
	const expectedBuffer = Buffer.from(`Bearer ${token}`);
	if (actualBuffer.length !== expectedBuffer.length) return false;
	return timingSafeEqual(actualBuffer, expectedBuffer);
}

function newOperationId(kind: "activate" | "restore"): string {
	return `fly-1436-${kind}-${randomUUID()}`;
}

function resultStatus(result: { status: string }): number {
	switch (result.status) {
		case "committed":
		case "replayed":
			return 200;
		case "invalid_request":
			return 400;
		default:
			return 409;
	}
}

function handleStage(
	deps: WorkKindCutoverRouteDeps,
	input: unknown,
): { code: number; body: unknown } {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return { code: 400, body: { ok: false, reason: "invalid_request" } };
	}
	const body = input as Record<string, unknown>;
	if (body.kind !== "activate" && body.kind !== "restore") {
		return {
			code: 400,
			body: { ok: false, reason: "kind_must_be_activate_or_restore" },
		};
	}
	const operationId =
		typeof body.operationId === "string"
			? body.operationId
			: (deps.newOperationId ?? newOperationId)(body.kind);
	if (
		!SAFE_OPERATION_ID.test(operationId) ||
		!operationId.startsWith(`fly-1436-${body.kind}-`)
	) {
		return {
			code: 400,
			body: { ok: false, reason: "invalid_operation_id" },
		};
	}

	if (body.kind === "activate") {
		const evidence = deps.readActivationEvidence();
		const { blockers, releaseState } = activationPreflight(deps, evidence);
		if (blockers.length > 0) {
			return {
				code: 409,
				body: { ok: false, blockers, releaseState },
			};
		}
		const snapshot: Fly1436Snapshot = {
			version: 1,
			activationId: ACTIVATION_ID,
			sourceOperationId: operationId,
			project: PROJECT,
			bindings: [...FLY1436_BASELINE_BINDINGS],
		};
		const canonical: WorkKindCutoverCanonical = {
			version: 1,
			activationId: ACTIVATION_ID,
			operationId,
			kind: "activate",
			project: PROJECT,
			actor: ACTOR,
			before: [...FLY1436_BASELINE_BINDINGS],
			after: [...FLY1436_TARGET_BINDINGS],
			snapshotHash: snapshotHash(snapshot),
			expected: evidence,
		};
		return {
			code: 200,
			body: {
				ok: true,
				canonical,
				snapshot,
				confirmToken: deps.tokens.issue(canonicalSha(canonical)),
			},
		};
	}

	if (
		typeof body.sourceOperationId !== "string" ||
		!SAFE_ACTIVATION_OPERATION_ID.test(body.sourceOperationId) ||
		!body.snapshot ||
		typeof body.snapshot !== "object" ||
		Array.isArray(body.snapshot)
	) {
		return {
			code: 400,
			body: {
				ok: false,
				reason: "restore_requires_source_operation_and_snapshot",
			},
		};
	}
	const snapshotRecord = body.snapshot as Record<string, unknown>;
	const bindings = normalizeBindings(snapshotRecord.bindings);
	const snapshot: Fly1436Snapshot | undefined =
		snapshotRecord.version === 1 &&
		snapshotRecord.activationId === ACTIVATION_ID &&
		snapshotRecord.sourceOperationId === body.sourceOperationId &&
		snapshotRecord.project === PROJECT &&
		bindings
			? {
					version: 1,
					activationId: ACTIVATION_ID,
					sourceOperationId: body.sourceOperationId,
					project: PROJECT,
					bindings,
				}
			: undefined;
	if (!snapshot) {
		return { code: 400, body: { ok: false, reason: "snapshot_invalid" } };
	}
	const activation = activationReceiptForRestore(deps, body.sourceOperationId);
	const source = activation?.source;
	const receipt = activation?.receipt;
	const digest = snapshotHash(snapshot);
	if (!source || !receipt) {
		return {
			code: 409,
			body: {
				ok: false,
				reason: "restore_preflight_failed",
				causes: ["ACTIVATION_RECEIPT_NOT_FOUND_OR_INVALID"],
			},
		};
	}
	const causes: string[] = [];
	if (source.snapshot_hash !== digest) causes.push("SNAPSHOT_HASH_MISMATCH");
	if (!sameBindings(snapshot.bindings, receipt.before)) {
		causes.push("SNAPSHOT_BINDINGS_MISMATCH");
	}
	// FLY-2121-history: a pre-cutover activation receipt can contain the retired
	// `design` category. It remains auditable, but is never accepted as a restore
	// target or translated through an alias.
	if (!sameBindings(receipt.after, FLY1436_TARGET_BINDINGS)) {
		causes.push("BINDING_TARGET_DRIFT");
	}
	if (!sameBindings(exactBindings(deps.store), receipt.after)) {
		if (!causes.includes("BINDING_TARGET_DRIFT")) {
			causes.push("BINDING_TARGET_DRIFT");
		}
	}
	if (causes.length > 0) {
		return {
			code: 409,
			body: { ok: false, reason: "restore_preflight_failed", causes },
		};
	}
	const invalid = validTargetTemplates(deps.store, receipt.before);
	if (invalid.length > 0) {
		return {
			code: 409,
			body: { ok: false, reason: "restore_target_invalid", invalid },
		};
	}
	const canonical: WorkKindCutoverCanonical = {
		version: 1,
		activationId: ACTIVATION_ID,
		operationId,
		kind: "restore",
		project: PROJECT,
		actor: ACTOR,
		sourceOperationId: body.sourceOperationId,
		before: receipt.after,
		after: receipt.before,
		snapshotHash: digest,
	};
	return {
		code: 200,
		body: {
			ok: true,
			canonical,
			confirmToken: deps.tokens.issue(canonicalSha(canonical)),
		},
	};
}

function handleApply(
	deps: WorkKindCutoverRouteDeps,
	input: unknown,
): { code: number; body: unknown } {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return { code: 400, body: { ok: false, reason: "invalid_request" } };
	}
	const body = input as Record<string, unknown>;
	const canonical = parseCanonical(body.canonical);
	if (!canonical) {
		return { code: 400, body: { ok: false, reason: "canonical_invalid" } };
	}
	const digest = canonicalSha(canonical);

	// Durable claim authority precedes the in-memory token. This is the
	// response-loss/Bridge-restart replay path.
	const existing = deps.store.getWorkflowBindingCutoverClaim(
		canonical.operationId,
	);
	if (existing) {
		if (existing.canonical_hash !== digest) {
			return {
				code: 409,
				body: { ok: false, reason: "operation_conflict" },
			};
		}
		const receipt = parseReceipt(existing.result_json);
		return receipt
			? { code: 200, body: { ok: true, status: "replayed", receipt } }
			: { code: 500, body: { ok: false, reason: "receipt_corrupt" } };
	}

	if (typeof body.confirmToken !== "string") {
		return {
			code: 401,
			body: { ok: false, reason: "confirm_token_required" },
		};
	}
	const verdict = deps.tokens.verifyAndConsume(body.confirmToken, digest);
	if (!verdict.ok) {
		return { code: 401, body: { ok: false, reason: verdict.reason } };
	}

	if (canonical.kind === "activate") {
		const { blockers, releaseState } = activationPreflight(
			deps,
			deps.readActivationEvidence(),
			canonical.expected,
		);
		if (blockers.length > 0) {
			return {
				code: 409,
				body: { ok: false, blockers, releaseState },
			};
		}
	} else {
		const activation = activationReceiptForRestore(
			deps,
			canonical.sourceOperationId!,
		);
		const source = activation?.source;
		const receipt = activation?.receipt;
		if (!source || !receipt) {
			return {
				code: 409,
				body: {
					ok: false,
					reason: "restore_preflight_failed",
					causes: ["ACTIVATION_RECEIPT_NOT_FOUND_OR_INVALID"],
				},
			};
		}
		const causes: string[] = [];
		if (source.snapshot_hash !== canonical.snapshotHash) {
			causes.push("SNAPSHOT_HASH_MISMATCH");
		}
		if (!sameBindings(canonical.before, receipt.after)) {
			causes.push("RESTORE_SOURCE_BINDINGS_MISMATCH");
		}
		if (!sameBindings(canonical.after, receipt.before)) {
			causes.push("RESTORE_TARGET_BINDINGS_MISMATCH");
		}
		if (!sameBindings(receipt.after, FLY1436_TARGET_BINDINGS)) {
			causes.push("BINDING_TARGET_DRIFT");
		}
		if (!sameBindings(exactBindings(deps.store), receipt.after)) {
			if (!causes.includes("BINDING_TARGET_DRIFT")) {
				causes.push("BINDING_TARGET_DRIFT");
			}
		}
		for (const templateId of validTargetTemplates(deps.store, receipt.before)) {
			causes.push(`RESTORE_TARGET_INVALID:${templateId}`);
		}
		if (causes.length > 0) {
			return {
				code: 409,
				body: { ok: false, reason: "restore_preflight_failed", causes },
			};
		}
	}

	const result = deps.store.commitWorkflowBindingCutover({
		operationId: canonical.operationId,
		activationId: ACTIVATION_ID,
		kind: canonical.kind,
		...(canonical.sourceOperationId
			? { sourceOperationId: canonical.sourceOperationId }
			: {}),
		canonicalHash: digest,
		snapshotHash: canonical.snapshotHash,
		project: PROJECT,
		actor: ACTOR,
		expectedBefore: canonical.before,
		targetBindings: canonical.after,
	});
	return result.status === "committed" || result.status === "replayed"
		? {
				code: 200,
				body: {
					ok: true,
					status: result.status,
					receipt: result.receipt,
				},
			}
		: {
				code: resultStatus(result),
				body: { ok: false, reason: result.status },
			};
}

/** Fail-closed, loopback-only, master-token-only mutation router. */
export function createWorkKindCutoverRouter(
	deps: WorkKindCutoverRouteDeps,
): express.Router {
	const router = express.Router();
	router.use((req, res, next) => {
		if (!loopbackSelfOrigin(req.headers.host)) {
			res.status(403).json({ ok: false, reason: "non_loopback_host" });
			return;
		}
		if (!deps.apiToken) {
			res
				.status(503)
				.json({ ok: false, reason: "master_api_token_not_configured" });
			return;
		}
		if (!safeBearer(req.headers.authorization, deps.apiToken)) {
			res.status(401).json({ ok: false, reason: "unauthorized" });
			return;
		}
		next();
	});
	router.post("/stage", (req, res) => {
		const result = handleStage(deps, req.body);
		res.status(result.code).json(result.body);
	});
	router.post("/apply", (req, res) => {
		const result = handleApply(deps, req.body);
		res.status(result.code).json(result.body);
	});
	return router;
}

/**
 * Production evidence reader. It evaluates only the canonical flywheel
 * checkout supplied by ProjectConfig; callers cannot choose paths.
 */
export function readFly1436ActivationEvidence(
	options: Fly1436ActivationEvidenceOptions,
): Fly1436ActivationEvidence {
	const read =
		options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
	const strict = options.pipelineEnrollment?.() ?? {
		ok: true,
		workKind: false,
		dag: false,
	};
	const workKind = strict.ok && strict.workKind;
	const assetPaths = [
		join(options.projectRoot, ".flywheel", "agents", "registry.yaml"),
		join(options.projectRoot, ".flywheel", "menus", "adoption.yaml"),
		join(
			options.projectRoot,
			"packages",
			"gemini-agent",
			"dist",
			"tools",
			"schemas.js",
		),
	];
	let contents: string[] = [];
	try {
		contents = assetPaths.map(read);
	} catch (error) {
		console.warn(
			`[FLY-1436] activation asset evidence unavailable: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		contents = [];
	}
	const [registry = "", adoption = "", gemini = ""] = contents;
	const menuReady = menuAssetsReady(registry, adoption);
	const geminiReady =
		gemini.includes("taskCategory") &&
		WORKFLOW_MENU_SHAPES.every((shape) => gemini.includes(shape)) &&
		/required:\s*\[[^\]]*["']taskCategory["']/s.test(gemini);
	const assetsDigest = createHash("sha256")
		.update(
			contents.length === assetPaths.length
				? contents.join("\n--FLY-1436-ASSET--\n")
				: "",
		)
		.digest("hex");
	let deployedSha = "";
	try {
		deployedSha = (
			options.gitHead ??
			((root: string) =>
				execFileSync(
					"git",
					[
						"-c",
						"core.hooksPath=/dev/null",
						"-c",
						"core.fsmonitor=false",
						"-C",
						root,
						"rev-parse",
						"HEAD",
					],
					{ encoding: "utf8", timeout: 10_000 },
				).trim())
		)(options.projectRoot);
	} catch (error) {
		console.warn(
			`[FLY-1436] deployed SHA evidence unavailable: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		deployedSha = "";
	}
	return {
		templateDispatch: true,
		generalizedTemplates: true,
		workKind,
		prBAssetsReady: menuReady && geminiReady,
		deployedSha,
		assetsDigest,
	};
}
