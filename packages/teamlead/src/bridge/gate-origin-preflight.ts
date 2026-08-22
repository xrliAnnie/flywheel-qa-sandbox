import type { StateStore, WorkflowEngineAlertIdentity } from "../StateStore.js";
import {
	probeWorkflowPr,
	type WorkflowPrProbeResult,
} from "./workflow-pr-probe.js";

const PROJECT_PROBE_BUDGET = 6;
const PROJECT_PROBE_WINDOW_MS = 60_000;
const BACKOFF_MS = [30_000, 60_000, 120_000, 240_000, 300_000] as const;
const MERGE_BLOCKED_REASON = "workflow_gate_origin_probe_merge_blocked";

export type WorkflowGateOriginPreflightResult =
	| { ok: true }
	| { ok: false; reason: string };

type AlertIdentityResolver =
	| WorkflowEngineAlertIdentity
	| ((input: {
			runId: string;
			projectName: string;
			issueId: string;
	  }) => WorkflowEngineAlertIdentity);

export interface WorkflowGateOriginPreflightDeps {
	store: StateStore;
	prProbe?: (input: {
		prNumber: number;
		probeRepoSlug: string;
	}) => Promise<WorkflowPrProbeResult>;
	alertIdentity?: AlertIdentityResolver;
	now?: () => string;
}

function alertIdentity(
	resolver: AlertIdentityResolver | undefined,
	run: { run_id: string; project_name: string; issue_id: string },
): WorkflowEngineAlertIdentity | undefined {
	return typeof resolver === "function"
		? resolver({
				runId: run.run_id,
				projectName: run.project_name,
				issueId: run.issue_id,
			})
		: resolver;
}

export function createWorkflowGateOriginPreflight(
	deps: WorkflowGateOriginPreflightDeps,
): (questionId: string) => Promise<WorkflowGateOriginPreflightResult> {
	const projectProbeTimes = new Map<string, number[]>();
	const now = deps.now ?? (() => new Date().toISOString());
	const prProbe = deps.prProbe ?? probeWorkflowPr;

	return async (questionId) => {
		const holder =
			deps.store.getCurrentWorkflowGateHolderByQuestionId(questionId);
		if (!holder) {
			return { ok: false, reason: "workflow_gate_holder_not_found" };
		}
		const run = deps.store.getWorkflowRun(holder.run_id);
		if (!run) return { ok: false, reason: "workflow_gate_run_not_found" };
		if (run.status !== "active") {
			return {
				ok: false,
				reason: "workflow_gate_origin_probe_run_not_active",
			};
		}
		if (holder.authority_mode === "engine_terminal") return { ok: true };
		const binding = deps.store.getWorkflowShipTargetBinding(questionId);
		if (!binding && holder.authority_mode === null) return { ok: true };
		if (holder.origin_probe_last_reason === MERGE_BLOCKED_REASON) {
			return { ok: false, reason: MERGE_BLOCKED_REASON };
		}
		const source = deps.store.getSession(holder.source_execution_id);
		if (source?.merge_block_reason) {
			const stopped = deps.store.stopWorkflowGateOriginProbe({
				questionId,
				reason: MERGE_BLOCKED_REASON,
			});
			return stopped.ok
				? { ok: false, reason: MERGE_BLOCKED_REASON }
				: { ok: false, reason: stopped.reason };
		}

		const observedNow = now();
		const observedNowMs = Date.parse(observedNow);
		if (
			holder.origin_probe_next_at &&
			observedNowMs < Date.parse(holder.origin_probe_next_at)
		) {
			return {
				ok: false,
				reason: "workflow_gate_origin_probe_deferred",
			};
		}
		const hold = (reason: string): WorkflowGateOriginPreflightResult => {
			const identity = alertIdentity(deps.alertIdentity, run);
			if (!identity) {
				return {
					ok: false,
					reason: "workflow_gate_origin_probe_alert_identity_missing",
				};
			}
			const held = deps.store.holdWorkflowGateOriginProbeTerminal({
				questionId,
				reason,
				now: observedNow,
				alertIdentity: identity,
			});
			return held.ok
				? { ok: false, reason }
				: { ok: false, reason: held.reason };
		};
		const defer = (
			reason: string,
			delayMs: number = BACKOFF_MS[
				Math.min(holder.origin_probe_attempts, BACKOFF_MS.length - 1)
			]!,
		): WorkflowGateOriginPreflightResult => {
			const deferred = deps.store.deferWorkflowGateOriginProbe({
				questionId,
				reason,
				now: observedNow,
				delayMs,
			});
			return deferred.ok
				? { ok: false, reason }
				: { ok: false, reason: deferred.reason };
		};

		if (!binding) {
			return hold("workflow_gate_origin_probe_binding_missing");
		}
		if (binding.superseded_at) {
			return hold("workflow_gate_origin_probe_binding_superseded");
		}
		if (
			binding.run_id !== holder.run_id ||
			binding.frozen_head_sha !== holder.head_sha
		) {
			return hold("workflow_gate_origin_probe_binding_mismatch");
		}
		const nodeBinding = deps.store.getCurrentWorkflowNodePrBindingForHead(
			holder.run_id,
			holder.head_sha,
		);
		if (!nodeBinding) {
			return defer("workflow_gate_origin_probe_pr_binding_missing");
		}
		if (
			nodeBinding.run_id !== holder.run_id ||
			nodeBinding.head_sha !== holder.head_sha ||
			nodeBinding.target_repo_identity !== binding.target_repo_identity ||
			nodeBinding.probe_repo_slug !== binding.probe_repo_slug
		) {
			return hold("workflow_gate_origin_probe_pr_binding_mismatch");
		}

		const recent = (projectProbeTimes.get(run.project_name) ?? []).filter(
			(timestamp) => observedNowMs - timestamp < PROJECT_PROBE_WINDOW_MS,
		);
		projectProbeTimes.set(run.project_name, recent);
		if (recent.length >= PROJECT_PROBE_BUDGET) {
			const retryIn = Math.max(
				1_000,
				PROJECT_PROBE_WINDOW_MS - (observedNowMs - recent[0]!),
			);
			return defer("workflow_gate_origin_probe_project_budget", retryIn);
		}
		recent.push(observedNowMs);

		let probe: WorkflowPrProbeResult;
		try {
			probe = await prProbe({
				prNumber: nodeBinding.pr_number,
				probeRepoSlug: binding.probe_repo_slug,
			});
		} catch {
			return defer("workflow_gate_origin_probe_unavailable");
		}
		if (
			typeof probe.state !== "string" ||
			typeof probe.isDraft !== "boolean" ||
			typeof probe.isCrossRepository !== "boolean" ||
			typeof probe.headRefOid !== "string" ||
			!/^[0-9a-f]{40}$/i.test(probe.headRefOid)
		) {
			return defer("workflow_gate_origin_probe_payload_invalid");
		}
		if (probe.isCrossRepository) {
			return hold("workflow_gate_origin_probe_cross_repository");
		}
		switch (probe.state.toUpperCase()) {
			case "MERGED":
				return defer("workflow_gate_origin_probe_pr_merged");
			case "CLOSED":
				return hold("workflow_gate_origin_probe_pr_closed");
			case "OPEN":
				break;
			default:
				return defer("workflow_gate_origin_probe_pr_not_open");
		}
		if (probe.isDraft) {
			return defer("workflow_gate_origin_probe_pr_draft");
		}
		if (probe.headRefOid.toLowerCase() !== holder.head_sha) {
			return defer("workflow_gate_origin_probe_head_mismatch");
		}
		const verified = deps.store.markWorkflowGateOriginProbeVerified({
			questionId,
			now: observedNow,
		});
		return verified.ok ? { ok: true } : { ok: false, reason: verified.reason };
	};
}
