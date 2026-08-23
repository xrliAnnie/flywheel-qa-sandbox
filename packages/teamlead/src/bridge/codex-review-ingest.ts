import { adapterTypeToFamily } from "flywheel-config";
import type { StateStore } from "../StateStore.js";
import { isReviewableRole } from "./codex-gate.js";

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
