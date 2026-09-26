import type { WorkflowRunRow } from "./StateStore.js";
import { parseWorkflowRunSnapshot } from "./workflow-run-snapshot.js";

export interface WorkflowPrefixContext {
	workflow: { runId: string; templateId: string; snapshotDigest: string };
	nodeId: string;
	phase: "design" | "implement" | "qa";
	/** Unknown on old snapshots; never hydrate it from mutable role files. */
	agent: { content: string; digest: string } | null;
}

/**
 * FLY-2913: server-side provenance only, with no profile selection or launch
 * effects. Callers supply the persisted run and its exact dispatch/review node,
 * not an HTTP payload, role display name or inferred issue category. Full
 * snapshot parsing validates both the sealed manifest and pinned agent bytes.
 */
export function resolveWorkflowPrefixContext(input: {
	run:
		| Pick<
				WorkflowRunRow,
				"run_id" | "template_id" | "template_revision" | "snapshot"
		  >
		| undefined;
	nodeId: string;
	expectedSnapshotDigest?: string;
}): WorkflowPrefixContext | undefined {
	const { run, nodeId } = input;
	if (
		!run?.snapshot ||
		(run.template_id !== "tpl_code" && run.template_id !== "tpl_simple_code")
	)
		return undefined;
	let snapshot: ReturnType<typeof parseWorkflowRunSnapshot>;
	try {
		snapshot = parseWorkflowRunSnapshot(run.snapshot);
	} catch {
		// The parser may quote source values; do not echo persisted prompt data.
		throw new Error("workflow_prefix_context: invalid snapshot");
	}
	if (
		snapshot.template.id !== run.template_id ||
		snapshot.template.revision !== run.template_revision
	)
		throw new Error("workflow_prefix_context: template mismatch");
	if (
		input.expectedSnapshotDigest !== undefined &&
		input.expectedSnapshotDigest !== snapshot.snapshot_digest
	)
		throw new Error("workflow_prefix_context: digest mismatch");
	const node = snapshot.resolved.nodes.find(
		(candidate) => candidate.id === nodeId,
	);
	if (!node) throw new Error("workflow_prefix_context: node missing");
	if (node.type !== "design" && node.type !== "implement" && node.type !== "qa")
		return undefined;
	return {
		workflow: {
			runId: run.run_id,
			templateId: snapshot.template.id,
			snapshotDigest: snapshot.snapshot_digest,
		},
		nodeId: node.id,
		phase: node.type,
		agent: node.agent
			? { content: node.agent.content, digest: node.agent.digest }
			: null,
	};
}
