import { adapterTypeToFamily } from "flywheel-config";
import type { StateStore } from "../StateStore.js";
import { resolveRequiredReviewModel } from "../workflow-review-routing.js";
import { isReviewableRole } from "./codex-gate.js";
import { reviewModelMatches } from "./review-round-ingest.js";

const FULL_SHA = /^[0-9a-f]{40}$/;

export interface CodexReviewResultEvent {
	event_id: string;
	execution_id: string;
	issue_id: string;
	project_name: string;
	event_type: string;
	payload?: Record<string, unknown>;
}

export interface CodexReviewIngestDeps {
	store: StateStore;
	logger?: { log(message: string): void; warn(message: string): void };
}

/** Records durable Codex evidence only; downstream QA/workflow redrive is not its job. */
export class CodexReviewIngest {
	constructor(private readonly deps: CodexReviewIngestDeps) {}

	async onCodexReviewResult(event: CodexReviewResultEvent): Promise<void> {
		const payload = event.payload ?? {};
		const reviewType = asString(payload.reviewType);
		const status = asString(payload.status);
		const sha = asString(payload.prHeadSha)?.toLowerCase();
		const targetExec =
			asString(payload.targetExecutionId) ?? event.execution_id;
		if (reviewType !== "code" || status !== "APPROVED") return;
		if (!sha || !FULL_SHA.test(sha)) {
			this.deps.logger?.warn?.(
				`[codex-review-ingest] ignored invalid prHeadSha (${sha ?? "none"})`,
			);
			return;
		}
		const session = this.deps.store.getSession(targetExec);
		if (!session || !isReviewableRole(session.session_role)) {
			this.deps.logger?.warn?.(
				`[codex-review-ingest] ignored unknown/non-reviewable execution ${targetExec}`,
			);
			return;
		}
		// FLY-2891: an execution with a Codex reviewer route must carry the
		// verified reviewer model, and it must match; otherwise the approval is
		// not recorded and the existing hold re-queues the review (a gate that
		// predates FLY-2891 sends no model). Unrouted runs keep legacy behavior.
		let required: ReturnType<typeof resolveRequiredReviewModel>;
		try {
			required = resolveRequiredReviewModel(
				this.deps.store,
				targetExec,
				"code",
			);
		} catch (error) {
			this.deps.logger?.warn?.(
				`[codex-review-ingest] not recording ${targetExec} @ ${sha.slice(0, 8)}: required reviewer model unresolved (${error instanceof Error ? error.message : String(error)})`,
			);
			return;
		}
		if (required) {
			const model = asString(payload.reviewerModel);
			const effort = asString(payload.reviewerEffort);
			if (reviewModelMatches({ model, effort }, required) !== true) {
				this.deps.logger?.warn?.(
					`[codex-review-ingest] not recording ${targetExec} @ ${sha.slice(0, 8)}: ${model ? `review ran ${model}/${effort ?? "?"}` : "no reviewer model (gate predates FLY-2891)"}, route requires ${required.reviewerModel}/${required.reviewerEffort}; hold stays`,
				);
				return;
			}
		}
		this.deps.store.recordCodexReviewApproved({
			executionId: targetExec,
			targetPrHeadSha: sha,
			issueId: session.issue_id,
			projectName: session.project_name,
			verdictEventId: event.event_id,
			reviewedTarget: asString(payload.reviewedTarget),
			codexThreadId: asString(payload.codexThreadId),
			rounds: typeof payload.rounds === "number" ? payload.rounds : undefined,
			authorFamily: adapterTypeToFamily(session.adapter_type),
			reviewerFamily: "codex",
		});
		this.deps.logger?.log?.(
			`[codex-review-ingest] APPROVED ${session.issue_id} (${targetExec}) @ ${sha.slice(0, 8)}`,
		);
	}
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}
