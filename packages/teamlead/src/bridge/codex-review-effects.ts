import type { AlertPayload, AlertResult } from "../LeadAlertNotifier.js";
import { type ProjectEntry, resolveLeadForIssue } from "../ProjectConfig.js";
import type { Session } from "../StateStore.js";
import { queueCodexCodeReviewInstructionResult } from "./codex-instruction.js";
import { buildSessionKey } from "./hook-payload.js";

export interface CodexReviewEffectsDeps {
	projects: ProjectEntry[];
	leadAlertNotifier?: {
		alert: (payload: AlertPayload) => Promise<AlertResult>;
	};
	queueInstruction?: typeof queueCodexCodeReviewInstructionResult;
}

/** Neutral transport + alert effects for the permanent Codex review hold. */
export class CodexReviewEffects {
	constructor(private readonly deps: CodexReviewEffectsDeps) {}

	queueCodexInstruction(args: {
		session: Session;
	}): ReturnType<typeof queueCodexCodeReviewInstructionResult> {
		return (
			this.deps.queueInstruction ?? queueCodexCodeReviewInstructionResult
		)(args.session.project_name, args.session.execution_id);
	}

	async alertCodexGateBlocked(args: {
		session: Session;
		sha?: string;
	}): Promise<void> {
		const sha = args.sha?.toLowerCase();
		if (!this.deps.leadAlertNotifier) {
			console.error(
				`[codex-review-effects] gate blocked (no alert sink): ${args.session.issue_id} @ ${sha?.slice(0, 8) ?? "no-head"}`,
			);
			return;
		}
		let leadId: string | undefined;
		try {
			leadId = resolveLeadForIssue(
				this.deps.projects,
				args.session.project_name,
				parseLabels(args.session.issue_labels),
			).lead.agentId;
		} catch {
			// Missing routing is logged below; the review hold itself remains durable.
		}
		if (!leadId) {
			console.error(
				`[codex-review-effects] gate blocked (no lead): ${args.session.issue_id}`,
			);
			return;
		}
		await this.deps.leadAlertNotifier.alert({
			leadId,
			projectName: args.session.project_name,
			eventId: sha
				? `codex-gate:${args.session.execution_id}:${sha}`
				: `codex-gate-missing-head:${args.session.execution_id}`,
			eventType: "codex_gate_blocked",
			title: `Codex code review blocked — ${args.session.issue_identifier ?? args.session.issue_id}`,
			body: sha
				? `PR head \`${sha.slice(0, 8)}\` does not have a Codex APPROVED — merge blocked, founder held.`
				: `Session reached awaiting_review with NO valid PR head binding — the Codex hard gate is holding the founder but a head-specific review cannot run. Ask the runner to re-run \`complete --route needs_review --pr-head <sha> --question-id <id>\` with a valid head.`,
			severity: "warning",
			sessionKey: buildSessionKey(args.session),
		});
	}
}

function parseLabels(raw: string | undefined): string[] {
	if (!raw) return [];
	try {
		const value: unknown = JSON.parse(raw);
		return Array.isArray(value)
			? value.filter((label): label is string => typeof label === "string")
			: [];
	} catch {
		return [];
	}
}
