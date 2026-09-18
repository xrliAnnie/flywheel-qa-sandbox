import type {
	CoSPorts,
	LeadTransportUnavailable,
	QueueReceipt,
} from "./ports.js";

export type SummaryMaterial = {
	pr: number;
	path: string;
	project: string;
	lead: string;
	facts: string;
	judgment: string;
};

export type SummaryRoundPlan = {
	roundId: string;
	reviewCandidates: SummaryMaterial[];
	pendingQuestions: Array<{
		pr: number;
		lead: string;
		reason: "facts_missing" | "judgment_missing";
		requestId: string;
		revision: number;
		to: { project: string; leadId: string };
		body: string;
		expiresAt: number;
	}>;
};

function expiryForRound(roundId: string): number {
	const timestamp = roundId.slice("summary-absorption:".length);
	const parsed = Date.parse(timestamp);
	if (!roundId.startsWith("summary-absorption:") || !Number.isFinite(parsed)) {
		throw new Error("summary round id is invalid");
	}
	return parsed + 24 * 60 * 60 * 1_000;
}

export async function planSummaryRound(
	input: { roundId: string; summaries: readonly SummaryMaterial[] },
	_ports?: CoSPorts,
): Promise<SummaryRoundPlan> {
	const expiresAt = expiryForRound(input.roundId);
	const reviewCandidates: SummaryMaterial[] = [];
	const pendingQuestions: SummaryRoundPlan["pendingQuestions"] = [];
	for (const summary of input.summaries) {
		const reason = !summary.facts.trim()
			? "facts_missing"
			: !summary.judgment.trim()
				? "judgment_missing"
				: null;
		if (!reason) {
			reviewCandidates.push(summary);
			continue;
		}
		const requestId = `${input.roundId}:pr:${summary.pr}`;

		pendingQuestions.push({
			pr: summary.pr,
			lead: summary.lead,
			reason,
			requestId,
			revision: 1,
			to: { project: summary.project, leadId: summary.lead },
			body: `PR #${summary.pr} (${summary.path}) 缺少可理解的 ${reason === "facts_missing" ? "Facts" : "Judgment"}。`,
			expiresAt,
		});
	}
	return { roundId: input.roundId, reviewCandidates, pendingQuestions };
}

export function isLeadTransportUnavailable(
	receipt: QueueReceipt,
): receipt is LeadTransportUnavailable {
	return receipt.status === "unavailable";
}
