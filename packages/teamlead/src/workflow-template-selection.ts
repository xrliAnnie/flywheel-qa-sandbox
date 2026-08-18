import { randomUUID } from "node:crypto";
import { canonicalSubmissionDigest } from "flywheel-config";
import {
	collectRunQuiescenceEvidence,
	type RunExecutionLivenessProbe,
} from "./bridge/run-quiescence.js";
import type { StateStore } from "./StateStore.js";
import {
	buildWorkflowSelectionDigestBody,
	type CategorySource,
	DEFAULT_ENG_TIER,
	type EngTier,
} from "./work-kind.js";
import {
	parseWorkflowRunSnapshot,
	type ResolvedWorkflowNodeV2,
} from "./workflow-run-snapshot.js";
import {
	validateWorkflowManifest,
	type WorkflowTemplateOverride,
} from "./workflow-template.js";

export type WorkflowRequestAuthKind = "master" | "scoped" | "tokenless";

export interface WorkflowTemplateSelectionResult {
	runId: string;
	executionId: string;
	nodeId: string;
	attempt: 1;
	snapshotDigest: string;
	gateCarrierEpoch: 0 | 1;
	selectionSource: "lead" | "binding" | "default";
	idempotencyKey: string;
	node: ResolvedWorkflowNodeV2;
	replayed: boolean;
	taskCategory?: string;
	categorySource?: CategorySource;
	tier?: EngTier;
}

export class WorkKindRouteError extends Error {
	constructor(
		public readonly code:
			| "WORK_KIND_BINDING_MISSING"
			| "TEMPLATE_NOT_FRESH_ELIGIBLE"
			| "TIER_NOT_SUPPORTED",
		message: string,
	) {
		super(message);
		this.name = "WorkKindRouteError";
	}
}

function resolveWorkflowTemplateCandidate(
	store: StateStore,
	input: {
		project: string;
		taskCategory?: string;
		leadTemplateId?: string;
		workKindEnforced?: boolean;
	},
) {
	const category = input.taskCategory?.trim() || "*";
	const binding = input.leadTemplateId
		? undefined
		: store.getWorkflowCategoryBinding(input.project, category);
	const templateId = input.leadTemplateId?.trim() || binding?.template_id;
	if (
		input.workKindEnforced &&
		!input.leadTemplateId &&
		(!binding || binding.task_category !== category)
	) {
		throw new WorkKindRouteError(
			"WORK_KIND_BINDING_MISSING",
			`project ${input.project} has no exact work-kind binding for ${category}`,
		);
	}
	if (!templateId) return null;
	const template = store.getWorkflowTemplate(templateId);
	if (
		input.workKindEnforced &&
		input.leadTemplateId &&
		(!template ||
			template.retired_at != null ||
			!template.current_published_revision)
	) {
		throw new WorkKindRouteError(
			"TEMPLATE_NOT_FRESH_ELIGIBLE",
			`workflow template ${templateId} is not active, published, and fresh-eligible`,
		);
	}
	if (template?.retired_at != null) {
		throw new Error(`workflow template ${templateId} is retired`);
	}
	if (!template?.current_published_revision) {
		throw new Error("workflow template candidate has no published revision");
	}
	const revision = store.getWorkflowTemplateRevision(
		templateId,
		template.current_published_revision,
	);
	if (!revision) throw new Error("workflow template revision not found");
	const schemaVersion = revision.schema_version;
	if (schemaVersion !== 1 && schemaVersion !== 2) {
		throw new Error("workflow template candidate schema is unsupported");
	}
	return {
		category,
		binding,
		templateId,
		revision,
		schemaVersion: schemaVersion as 1 | 2,
	};
}

/** Read-only entry preflight for fresh schema-v2 workflow dispatch. */
export function resolveWorkflowTemplateCandidateSchema(
	store: StateStore,
	input: {
		project: string;
		taskCategory?: string;
		leadTemplateId?: string;
		workKindEnforced?: boolean;
	},
): 1 | 2 | null {
	return resolveWorkflowTemplateCandidate(store, input)?.schemaVersion ?? null;
}

/**
 * Candidate-first selection. Null means the caller must execute the exact
 * legacy start path; a schema-v2 candidate either fully materializes or fails
 * closed without creating a run.
 */
export async function resolveWorkflowTemplateSelection(
	store: StateStore,
	input: {
		project: string;
		issueId: string;
		entryIssueAliases?: string[];
		entryRootKey?: string;
		taskCategory?: string;
		leadTemplateId?: string;
		leadReason?: string;
		selectedBy: string;
		actor: string;
		authKind: WorkflowRequestAuthKind;
		canonicalRoot: string;
		idempotencyKey?: string;
		/** Candidate schema observed before the route's entry-policy await. */
		candidateSchemaAtEntry?: 1 | 2 | null;
		/**
		 * FLY-1372: durable entry provenance, set ONLY by the pipeline.dag
		 * dispatch entry — pinned atomically in the materialize transaction.
		 */
		entryKind?: "pipeline_dag_v1" | "workflow_v2";
		idFactory?: () => string;
		now?: string;
		probeRunExecutionLiveness?: RunExecutionLivenessProbe;
		workKindEnforced?: boolean;
		categorySource?: CategorySource;
		tier?: EngTier;
		/** Canonical, already policy-validated menu node override. */
		override?: WorkflowTemplateOverride;
	},
): Promise<WorkflowTemplateSelectionResult | null> {
	const candidate = resolveWorkflowTemplateCandidate(store, input);
	if (
		Object.hasOwn(input, "candidateSchemaAtEntry") &&
		(candidate?.schemaVersion ?? null) !== input.candidateSchemaAtEntry
	) {
		throw new Error(
			"workflow template candidate changed during entry resolution",
		);
	}
	if (!candidate) return null;
	const { category, binding, templateId, revision, schemaVersion } = candidate;
	// Schema-v1 snapshots remain readable for recovery, but new dispatches have
	// exactly one materialization path: the current schema-v2 DAG.
	if (schemaVersion === 1) return null;
	if (input.authKind !== "master") {
		throw new Error("workflow template selection requires master auth");
	}
	if (!input.idempotencyKey?.trim()) {
		throw new Error("workflow template selection requires idempotencyKey");
	}
	const selectionSource = input.leadTemplateId
		? "lead"
		: binding?.task_category === "*"
			? "default"
			: "binding";
	if (selectionSource === "lead" && !input.leadReason?.trim()) {
		throw new Error("lead template selection reason is required");
	}
	const reason =
		input.leadReason?.trim() ||
		`${selectionSource}:${binding?.task_category ?? category}`;
	const manifest = validateWorkflowManifest(JSON.parse(revision.manifest));
	if (manifest.schema_version !== revision.schema_version) {
		throw new Error("workflow template stored schema does not match manifest");
	}
	let effectiveTier: EngTier | undefined;
	let tierPreset: WorkflowTemplateOverride | undefined;
	if (manifest.tier_presets) {
		effectiveTier = input.tier ?? DEFAULT_ENG_TIER;
		tierPreset = manifest.tier_presets[effectiveTier];
		if (!tierPreset) {
			throw new WorkKindRouteError(
				"TIER_NOT_SUPPORTED",
				`workflow template ${templateId} does not support tier ${effectiveTier}`,
			);
		}
	} else if (input.tier) {
		throw new WorkKindRouteError(
			"TIER_NOT_SUPPORTED",
			`workflow template ${templateId} does not declare tier presets`,
		);
	}
	if (tierPreset && input.override) {
		throw new Error(
			"workflow selection cannot combine tier and menu overrides",
		);
	}
	const reportedCategory = input.leadTemplateId
		? input.taskCategory?.trim() || undefined
		: category;
	const selectionDigestBody = buildWorkflowSelectionDigestBody(
		{
			project: input.project,
			issueId: input.issueId,
			category,
			templateId,
			revision: revision.revision,
			selectionSource,
			selectedBy: input.selectedBy,
			reason,
		},
		input.categorySource
			? { categorySource: input.categorySource, tier: effectiveTier }
			: undefined,
	);
	const selectionDigest = canonicalSubmissionDigest(
		input.override
			? { ...selectionDigestBody, override: input.override }
			: selectionDigestBody,
	);
	const key = input.idempotencyKey.trim();
	const resolveReplay = (
		prior: NonNullable<ReturnType<StateStore["getWorkflowStartReservation"]>>,
	): WorkflowTemplateSelectionResult => {
		if (prior.selection_digest !== selectionDigest) {
			throw new Error("workflow start idempotency key payload mismatch");
		}
		const run = store.getWorkflowRun(prior.run_id);
		if (!run?.snapshot)
			throw new Error("reserved workflow run snapshot missing");
		const snapshot = parseWorkflowRunSnapshot(run.snapshot);
		const node = snapshot.resolved.nodes.find(
			(candidate) => candidate.id === prior.node_id,
		);
		if (!node) throw new Error("reserved workflow start node missing");
		return {
			runId: prior.run_id,
			executionId: prior.execution_id,
			nodeId: prior.node_id,
			attempt: 1,
			snapshotDigest: snapshot.snapshot_digest,
			gateCarrierEpoch: run.gate_carrier_epoch,
			selectionSource,
			idempotencyKey: key,
			node,
			replayed: true,
			...(input.categorySource
				? {
						...(reportedCategory ? { taskCategory: reportedCategory } : {}),
						categorySource: input.categorySource,
						...(effectiveTier ? { tier: effectiveTier } : {}),
					}
				: {}),
		};
	};
	const prior = store.getWorkflowStartReservation(key);
	if (prior) return resolveReplay(prior);
	let supersedeShadow:
		| {
				runId: string;
				evidence: Awaited<ReturnType<typeof collectRunQuiescenceEvidence>>;
				now: string;
		  }
		| undefined;
	const active = store.getActiveWorkflowRunForIssue(input.issueId);
	if (active) {
		if (active.engine_owned !== 0) {
			throw new Error(
				`active workflow run reconciliation hold: ${active.run_id} is not this idempotent start`,
			);
		}
		const evidence = await collectRunQuiescenceEvidence(
			store,
			active.run_id,
			input.probeRunExecutionLiveness,
			input.now ? () => new Date(input.now!) : undefined,
		);
		const racedReservation = store.getWorkflowStartReservation(key);
		if (racedReservation) return resolveReplay(racedReservation);
		const refreshedCandidate = resolveWorkflowTemplateCandidate(store, input);
		const refreshedSelectionSource = input.leadTemplateId
			? "lead"
			: refreshedCandidate?.binding?.task_category === "*"
				? "default"
				: "binding";
		const refreshedReason =
			input.leadReason?.trim() ||
			`${refreshedSelectionSource}:${refreshedCandidate?.binding?.task_category ?? category}`;
		const refreshedSelectionDigestBody = refreshedCandidate
			? buildWorkflowSelectionDigestBody(
					{
						project: input.project,
						issueId: input.issueId,
						category: refreshedCandidate.category,
						templateId: refreshedCandidate.templateId,
						revision: refreshedCandidate.revision.revision,
						selectionSource: refreshedSelectionSource,
						selectedBy: input.selectedBy,
						reason: refreshedReason,
					},
					input.categorySource
						? {
								categorySource: input.categorySource,
								tier: effectiveTier,
							}
						: undefined,
				)
			: undefined;
		const refreshedSelectionDigest = refreshedSelectionDigestBody
			? canonicalSubmissionDigest(
					input.override
						? {
								...refreshedSelectionDigestBody,
								override: input.override,
							}
						: refreshedSelectionDigestBody,
				)
			: undefined;
		if (
			!refreshedCandidate ||
			refreshedCandidate.category !== category ||
			refreshedCandidate.templateId !== templateId ||
			refreshedCandidate.revision.revision !== revision.revision ||
			refreshedCandidate.revision.manifest_digest !==
				revision.manifest_digest ||
			refreshedCandidate.schemaVersion !== schemaVersion ||
			refreshedSelectionSource !== selectionSource ||
			refreshedSelectionDigest !== selectionDigest
		) {
			throw new Error(
				"workflow template candidate changed during shadow supersession probe",
			);
		}
		supersedeShadow = {
			runId: active.run_id,
			evidence,
			now: input.now ?? new Date().toISOString(),
		};
	}

	const incoming = new Map(manifest.nodes.map((node) => [node.id, 0]));
	for (const edge of manifest.edges) {
		incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
	}
	const starts = manifest.nodes.filter((node) => incoming.get(node.id) === 0);
	if (starts.length !== 1)
		throw new Error("workflow manifest start is ambiguous");
	const idFactory = input.idFactory ?? randomUUID;
	const runId = idFactory();
	const executionId = idFactory();
	const now = input.now ?? new Date().toISOString();
	const run = store.materializeWorkflowRun({
		runId,
		issueId: input.issueId,
		entryIssueAliases: input.entryIssueAliases,
		entryRootKey: input.entryRootKey,
		projectName: input.project,
		taskCategory: reportedCategory,
		templateId,
		claimsReadEnrolled: true,
		actor: input.actor,
		canonicalRoot: input.canonicalRoot,
		...(input.entryKind ? { entryKind: input.entryKind } : {}),
		...(supersedeShadow ? { supersedeShadow } : {}),
		selection: {
			source: selectionSource,
			selectedBy: input.selectedBy,
			reason,
		},
		categorySource: input.categorySource,
		tier: effectiveTier,
		override: input.override ?? tierPreset,
		selectionOverride: input.override,
		startReservation: {
			idempotencyKey: key,
			selectionDigest,
			nodeId: starts[0]!.id,
			attempt: 1,
			executionId,
			createdAt: now,
		},
		expectedSelection: {
			templateId,
			revision: revision.revision,
			manifestDigest: revision.manifest_digest,
			schemaVersion,
			selectionSource,
			selectionDigest,
		},
	});
	const snapshot = parseWorkflowRunSnapshot(run.snapshot!);
	const node = snapshot.resolved.nodes.find(
		(candidate) => candidate.id === starts[0]!.id,
	);
	if (!node) throw new Error("materialized workflow start node missing");
	return {
		runId,
		executionId,
		nodeId: node.id,
		attempt: 1,
		snapshotDigest: snapshot.snapshot_digest,
		gateCarrierEpoch: run.gate_carrier_epoch,
		selectionSource,
		idempotencyKey: key,
		node,
		replayed: false,
		...(input.categorySource
			? {
					...(reportedCategory ? { taskCategory: reportedCategory } : {}),
					categorySource: input.categorySource,
					...(effectiveTier ? { tier: effectiveTier } : {}),
				}
			: {}),
	};
}

/**
 * FLY-1372: recover the start selection of an ACTIVE `pipeline_dag_v1` run
 * from its pinned snapshot + start reservation — the keyless re-drive path
 * for a materialized-but-unresponded entry (crash / timeout between
 * materialization and response).
 *
 * Deliberately read-only and CANDIDATE-FREE: it never consults the current
 * binding / template / published revision, so binding deletion, a rebind, a
 * revision advance, an auto-resolved Lead change, or a corrupted current
 * template cannot strand a run that has a perfectly good pinned snapshot
 * (Codex design R2-2a / R3-2). Throws on any inconsistency — the caller maps
 * to a machine-readable 409, never a silent legacy fallback.
 */
export function recoverWorkflowStartSelection(
	store: StateStore,
	input: {
		issueId: string;
		projectName: string;
		authKind: WorkflowRequestAuthKind;
		runId?: string;
	},
): WorkflowTemplateSelectionResult {
	if (input.authKind !== "master") {
		throw new Error("workflow start recovery requires master auth");
	}
	const run = input.runId
		? store.getWorkflowRun(input.runId)
		: store.getActiveWorkflowRunForIssue(input.issueId);
	if (!run || run.status !== "active" || run.engine_owned !== 1) {
		throw new Error(
			"no active engine-owned workflow run to recover for this issue",
		);
	}
	if (run.issue_id !== input.issueId) {
		throw new Error("active workflow run belongs to a different issue");
	}
	if (run.project_name !== input.projectName) {
		throw new Error("active workflow run belongs to a different project");
	}
	if (!run.snapshot) {
		throw new Error("active workflow run has no pinned snapshot");
	}
	const reservation = store.getWorkflowStartReservationForRun(run.run_id);
	if (!reservation) {
		throw new Error("active workflow run has no start reservation");
	}
	const snapshot = parseWorkflowRunSnapshot(run.snapshot);
	const node = snapshot.resolved.nodes.find(
		(candidate) => candidate.id === reservation.node_id,
	);
	if (!node) {
		throw new Error("active workflow run start node missing from snapshot");
	}
	const selectionSource =
		run.selection_source === "lead" || run.selection_source === "binding"
			? run.selection_source
			: "default";
	return {
		runId: run.run_id,
		executionId: reservation.execution_id,
		nodeId: reservation.node_id,
		attempt: 1,
		snapshotDigest: snapshot.snapshot_digest,
		gateCarrierEpoch: run.gate_carrier_epoch,
		selectionSource,
		idempotencyKey: reservation.idempotency_key,
		node,
		replayed: true,
		...(run.category_source === "task_category" ||
		run.category_source === "template_override"
			? {
					...(run.task_category ? { taskCategory: run.task_category } : {}),
					categorySource: run.category_source,
					...(run.tier === "trivial" ||
					run.tier === "light" ||
					run.tier === "heavy"
						? { tier: run.tier }
						: {}),
				}
			: {}),
	};
}
