import { randomUUID } from "node:crypto";
import { canonicalSubmissionDigest } from "flywheel-config";
import type { StateStore } from "./StateStore.js";
import {
	parseWorkflowRunSnapshot,
	type ResolvedWorkflowNodeV2,
} from "./workflow-run-snapshot.js";
import { validateWorkflowManifest } from "./workflow-template.js";
import {
	isWorkflowTemplateDispatchEnabled,
	workflowTemplateDispatchBlockMessage,
	workflowTemplateDispatchBlockReason,
} from "./workflow-template-dispatch.js";

export type WorkflowRequestAuthKind = "master" | "scoped" | "tokenless";

export interface WorkflowTemplateSelectionResult {
	runId: string;
	executionId: string;
	nodeId: string;
	attempt: 1;
	snapshotDigest: string;
	selectionSource: "lead" | "binding" | "default";
	idempotencyKey: string;
	node: ResolvedWorkflowNodeV2;
	replayed: boolean;
}

function resolveWorkflowTemplateCandidate(
	store: StateStore,
	input: {
		project: string;
		taskCategory?: string;
		leadTemplateId?: string;
	},
) {
	const category = input.taskCategory?.trim() || "*";
	const binding = input.leadTemplateId
		? undefined
		: store.getWorkflowCategoryBinding(input.project, category);
	const templateId = input.leadTemplateId?.trim() || binding?.template_id;
	if (!templateId) return null;
	const template = store.getWorkflowTemplate(templateId);
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

/**
 * Read-only entry preflight. The route uses this to keep schema-v1 behind the
 * three-stage policy without changing the independent schema-v2 entry path.
 */
export function resolveWorkflowTemplateCandidateSchema(
	store: StateStore,
	input: {
		project: string;
		taskCategory?: string;
		leadTemplateId?: string;
	},
): 1 | 2 | null {
	return resolveWorkflowTemplateCandidate(store, input)?.schemaVersion ?? null;
}

/**
 * Candidate-first selection. Null means the caller must execute the exact
 * legacy start path; a schema-v2 candidate either fully materializes or fails
 * closed without creating a run.
 */
export function resolveWorkflowTemplateSelection(
	store: StateStore,
	input: {
		project: string;
		issueId: string;
		taskCategory?: string;
		leadTemplateId?: string;
		leadReason?: string;
		selectedBy: string;
		actor: string;
		authKind: WorkflowRequestAuthKind;
		canonicalRoot: string;
		idempotencyKey?: string;
		/** True only after the trusted three-stage entry policy admits schema v1. */
		allowSchemaV1Dispatch?: boolean;
		/** Candidate schema observed before the route's entry-policy await. */
		candidateSchemaAtEntry?: 1 | 2 | null;
		/**
		 * FLY-1372: durable entry provenance, set ONLY by the pipeline.dag
		 * dispatch entry — pinned atomically in the materialize transaction.
		 */
		entryKind?: "pipeline_dag_v1";
		env?: Record<string, string | undefined>;
		idFactory?: () => string;
		now?: string;
	},
): WorkflowTemplateSelectionResult | null {
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
	const env = input.env ?? process.env;
	// Candidate-first compatibility: v1 remains exact legacy while dispatch is
	// off. A v2 candidate never falls back to legacy.
	if (schemaVersion === 1 && !isWorkflowTemplateDispatchEnabled(env)) {
		return null;
	}
	const blocked = workflowTemplateDispatchBlockReason(schemaVersion, env);
	if (blocked) throw new Error(workflowTemplateDispatchBlockMessage(blocked));
	// Engineering v1 is an engine implementation of the incumbent three-stage
	// workflow, not a parallel entry policy. A policy opt-out or a normal Lead
	// request without a stable start key must stay on today's legacy path. Keep
	// this after the flag block so an explicitly enabled but incomplete flag set
	// still fails closed per the published truth table.
	if (schemaVersion === 1) {
		if (input.allowSchemaV1Dispatch !== true) return null;
		if (!input.idempotencyKey?.trim()) return null;
	}
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
	const selectionDigest = canonicalSubmissionDigest({
		project: input.project,
		issueId: input.issueId,
		category,
		templateId,
		revision: revision.revision,
		selectionSource,
		selectedBy: input.selectedBy,
		reason,
	});
	const key = input.idempotencyKey.trim();
	const prior = store.getWorkflowStartReservation(key);
	if (prior) {
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
			selectionSource,
			idempotencyKey: key,
			node,
			replayed: true,
		};
	}
	const active = store.getActiveWorkflowRunForIssue(input.issueId);
	if (active) {
		throw new Error(
			`active workflow run reconciliation hold: ${active.run_id} is not this idempotent start`,
		);
	}

	const manifest = validateWorkflowManifest(JSON.parse(revision.manifest));
	if (manifest.schema_version !== revision.schema_version) {
		throw new Error("workflow template stored schema does not match manifest");
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
		projectName: input.project,
		taskCategory: category,
		templateId,
		claimsReadEnrolled: true,
		actor: input.actor,
		canonicalRoot: input.canonicalRoot,
		...(input.entryKind ? { entryKind: input.entryKind } : {}),
		selection: {
			source: selectionSource,
			selectedBy: input.selectedBy,
			reason,
		},
		startReservation: {
			idempotencyKey: key,
			selectionDigest,
			nodeId: starts[0]!.id,
			attempt: 1,
			executionId,
			createdAt: now,
		},
		env: input.env,
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
		selectionSource,
		idempotencyKey: key,
		node,
		replayed: false,
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
	},
): WorkflowTemplateSelectionResult {
	if (input.authKind !== "master") {
		throw new Error("workflow start recovery requires master auth");
	}
	const run = store.getActiveWorkflowRunForIssue(input.issueId);
	if (!run || run.entry_kind !== "pipeline_dag_v1") {
		throw new Error("no active pipeline-dag run to recover for this issue");
	}
	if (run.project_name !== input.projectName) {
		throw new Error("active pipeline-dag run belongs to a different project");
	}
	if (!run.snapshot) {
		throw new Error("active pipeline-dag run has no pinned snapshot");
	}
	const reservation = store.getWorkflowStartReservationForRun(run.run_id);
	if (!reservation) {
		throw new Error("active pipeline-dag run has no start reservation");
	}
	const snapshot = parseWorkflowRunSnapshot(run.snapshot);
	const node = snapshot.resolved.nodes.find(
		(candidate) => candidate.id === reservation.node_id,
	);
	if (!node) {
		throw new Error("active pipeline-dag run start node missing from snapshot");
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
		selectionSource,
		idempotencyKey: reservation.idempotency_key,
		node,
		replayed: true,
	};
}
