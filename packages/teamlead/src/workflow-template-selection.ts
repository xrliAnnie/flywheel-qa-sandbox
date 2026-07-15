import { randomUUID } from "node:crypto";
import { canonicalSubmissionDigest } from "flywheel-config";
import type { StateStore } from "./StateStore.js";
import {
	parseWorkflowRunSnapshot,
	type ResolvedWorkflowNodeV2,
} from "./workflow-run-snapshot.js";
import { validateWorkflowManifest } from "./workflow-template.js";

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
		env?: Record<string, string | undefined>;
		idFactory?: () => string;
		now?: string;
	},
): WorkflowTemplateSelectionResult | null {
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
	// C connects only schema-v2 starts. Stored v1 templates remain B substrate.
	if (revision.schema_version === 1) return null;
	if (revision.schema_version !== 2) {
		throw new Error("workflow template candidate schema is unsupported");
	}
	if (input.authKind !== "master") {
		throw new Error("schema-v2 workflow selection requires master auth");
	}
	if (!input.idempotencyKey?.trim()) {
		throw new Error("schema-v2 workflow selection requires idempotencyKey");
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
	if (manifest.schema_version !== 2) {
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
		claimsReadEnrolled: false,
		actor: input.actor,
		canonicalRoot: input.canonicalRoot,
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
