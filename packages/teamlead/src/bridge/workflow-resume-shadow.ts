import type {
	WorkflowResumeFailureReason,
	WorkflowResumeShadowOpportunity,
} from "../StateStore.js";
import {
	resolveWorkflowResumeTarget,
	type WorkflowResumeAnchorVerification,
	type WorkflowResumeEnvelopeObservation,
	type WorkflowResumeResolverStore,
} from "./workflow-resume-resolver.js";

export interface WorkflowResumeShadowStore extends WorkflowResumeResolverStore {
	listWorkflowResumeShadowOpportunities(
		limit?: number,
	): WorkflowResumeShadowOpportunity[];
	recordWorkflowResumeProbe(input: {
		runId: string;
		opportunityKey: string;
		proposedNodeId: string;
		proposedAttempt: number;
		verdict: "proposed" | WorkflowResumeFailureReason;
		detail: Record<string, unknown>;
		createdAt: string;
	}): boolean;
	pruneWorkflowResumeProbes(input: { now: string; limit?: number }): number;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error("shadow_probe_timeout")),
			ms,
		);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

/** Observe and ledger at most three eligible targets; failures never escape the rider. */
export async function runWorkflowResumeShadowTick(input: {
	store: WorkflowResumeShadowStore;
	observeEnvelope: (
		opportunity: WorkflowResumeShadowOpportunity,
	) => Promise<WorkflowResumeEnvelopeObservation>;
	verifyAnchor: (input: WorkflowResumeAnchorVerification) => boolean;
	env: Record<string, string | undefined>;
	now: string;
	log?: (message: string) => void;
}): Promise<{ processed: number }> {
	let opportunities: WorkflowResumeShadowOpportunity[];
	try {
		input.store.pruneWorkflowResumeProbes({ now: input.now, limit: 100 });
		opportunities = input.store.listWorkflowResumeShadowOpportunities(3);
	} catch (error) {
		input.log?.(
			`[workflow-resume] shadow scan failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		return { processed: 0 };
	}
	await Promise.all(
		opportunities.map(async (opportunity) => {
			try {
				const observation = await withTimeout(
					input.observeEnvelope(opportunity),
					10_000,
				);
				const resolution = resolveWorkflowResumeTarget(input.store, {
					runId: opportunity.runId,
					envelopeObservation: observation,
					verifyAnchor: input.verifyAnchor,
					env: input.env,
				});
				input.store.recordWorkflowResumeProbe({
					runId: opportunity.runId,
					opportunityKey: opportunity.opportunityKey,
					proposedNodeId: opportunity.attachment.target_node_id,
					proposedAttempt: opportunity.attachment.target_attempt,
					verdict: resolution.ok ? "proposed" : resolution.reason,
					detail: resolution.ok
						? {
								actionKind: resolution.actionKind,
								attachmentId: resolution.attachmentId,
								...(resolution.effectiveAnchor
									? { effectiveAnchor: resolution.effectiveAnchor }
									: {}),
							}
						: resolution.detail,
					createdAt: input.now,
				});
			} catch (error) {
				try {
					input.store.recordWorkflowResumeProbe({
						runId: opportunity.runId,
						opportunityKey: opportunity.opportunityKey,
						proposedNodeId: opportunity.attachment.target_node_id,
						proposedAttempt: opportunity.attachment.target_attempt,
						verdict: "external_drift",
						detail: { cause: "shadow_probe_error" },
						createdAt: input.now,
					});
				} catch {
					// The rider has no authority outside T5; a broken T5 write is log-only.
				}
				input.log?.(
					`[workflow-resume] shadow probe failed for ${opportunity.opportunityKey}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}),
	);
	return { processed: opportunities.length };
}
