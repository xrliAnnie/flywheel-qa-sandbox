import type {
	StateStore,
	WorkflowDeliveryContractUnboundAlertPayload,
	WorkflowDeliveryContractUnboundAlertReceipt,
	WorkflowEngineAlertIdentity,
} from "../../StateStore.js";
import { classifyDeliveryAttempt } from "./classify.js";

export class DeliveryContractWatch {
	constructor(
		private readonly deps: {
			store: StateStore;
			projectName?: string;
			resolveAlertIdentity(input: {
				projectName: string;
				issueId: string;
				runId: string | null;
			}): WorkflowEngineAlertIdentity;
			enqueueUnboundAlert(
				payload: WorkflowDeliveryContractUnboundAlertPayload,
			): WorkflowDeliveryContractUnboundAlertReceipt;
		},
	) {}

	runPass(_now: string): {
		observed: number;
		opened: number;
		closed: number;
		alerted: number;
	} {
		const result = { observed: 0, opened: 0, closed: 0, alerted: 0 };
		for (const attempt of this.deps.store.listLiveWorkflowDeliveryAttempts()) {
			try {
				const ref = JSON.parse(attempt.contract_ref_json) as {
					runId?: string;
					projectName?: string;
					issueId?: string;
				};
				const projectName =
					ref.projectName ?? attempt.root_id.split(":")[0] ?? "unknown";
				if (this.deps.projectName && projectName !== this.deps.projectName)
					continue;
				result.observed++;
				const classification = classifyDeliveryAttempt(attempt, _now);
				const issueId =
					ref.issueId ?? attempt.root_id.split(":")[1] ?? "unknown";
				const candidateRun = ref.runId
					? this.deps.store.getWorkflowRun(ref.runId)
					: this.deps.store.getActiveWorkflowRunForIssue(issueId);
				const activeRun =
					candidateRun?.status === "active" &&
					candidateRun.project_name === projectName &&
					candidateRun.issue_id === issueId
						? candidateRun
						: undefined;
				const runId =
					activeRun?.project_name === projectName ? activeRun.run_id : null;
				const observed = this.deps.store.observeWorkflowDeliveryContract({
					attempt,
					classification,
					runId,
					projectName,
					issueId,
					now: _now,
					alertIdentity: this.deps.resolveAlertIdentity({
						projectName,
						issueId,
						runId,
					}),
					enqueueUnboundAlert: this.deps.enqueueUnboundAlert,
				});
				result.opened += observed.opened;
				result.closed += observed.closed;
				result.alerted += observed.alerted;
			} catch (error) {
				console.warn(
					`[delivery-contract] attempt ${attempt.attempt_id} failed closed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		}
		return result;
	}
}
