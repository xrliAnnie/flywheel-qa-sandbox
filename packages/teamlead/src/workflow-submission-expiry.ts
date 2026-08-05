import { getNodeTypeRegistryEntry } from "flywheel-config";
import {
	resolveWorkflowDecisionContract,
	type WorkflowRunSnapshot,
} from "./workflow-run-snapshot.js";

export function computeSubmissionExpiry(
	nowMs: number,
	windowMinutes: number,
	absoluteDeadlineMs: number,
): number {
	if (!Number.isFinite(nowMs) || !Number.isFinite(absoluteDeadlineMs)) {
		throw new TypeError("submission expiry timestamps must be finite");
	}
	if (!Number.isInteger(windowMinutes) || windowMinutes <= 0) {
		throw new TypeError("submission window must be a positive integer");
	}
	return Math.min(nowMs + windowMinutes * 60_000, absoluteDeadlineMs);
}

/**
 * Resolve credential lifetime at issuance time. The manifest remains the
 * pinned authority when it declares a window; otherwise a verdict-topology
 * decision node may consume its type's live operating default. This policy is
 * deliberately outside snapshot capabilities so existing pinned runs receive
 * safer newly-issued credentials without changing their digest.
 */
export function credentialWindowForNode(
	snapshot: WorkflowRunSnapshot,
	nodeId: string,
	now: Date,
): { expiresAt: string; absoluteDeadlineAt: string } {
	const absoluteDeadlineMs = now.getTime() + 24 * 60 * 60_000;
	const decisionContract = resolveWorkflowDecisionContract(snapshot, nodeId);
	const manifestNode = snapshot.manifest.nodes.find(
		(node) => node.id === nodeId,
	);
	const resolvedNode = snapshot.resolved.nodes.find(
		(node) => node.id === nodeId,
	);
	const registryWindow =
		decisionContract && resolvedNode
			? getNodeTypeRegistryEntry(resolvedNode.type).submissionWindowMinutes
			: undefined;
	const windowMinutes = decisionContract
		? (manifestNode?.submissionWindowMinutes ?? registryWindow ?? 60)
		: 60;
	return {
		expiresAt: new Date(
			computeSubmissionExpiry(now.getTime(), windowMinutes, absoluteDeadlineMs),
		).toISOString(),
		absoluteDeadlineAt: new Date(absoluteDeadlineMs).toISOString(),
	};
}
