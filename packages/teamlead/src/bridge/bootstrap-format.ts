import {
	countCodePoints,
	truncateCodePoints,
} from "flywheel-comm/text-truncate";
import { formatLegacyBootstrap } from "./bootstrap-format-legacy.js";
import type { LeadBootstrap } from "./lead-runtime.js";

const QUESTION_KINDS = {
	pendingGateQuestions: "gate",
	pendingRunnerQuestions: "ask",
	pendingReports: "report",
} as const;
const SECTIONS = [
	"pendingGateQuestions",
	"pendingRunnerQuestions",
	"pendingReports",
	"activeSessions",
	"pendingDecisions",
	"recentFailures",
	"recentEvents",
] as const;

/** Shared transport-independent recovery budget. Never cut an identifier. */
export function formatBootstrap(snapshot: LeadBootstrap): string {
	if (snapshot.tokenSavingsEnabled === false)
		return formatLegacyBootstrap(snapshot);
	const bounded: LeadBootstrap = {
		...snapshot,
		memoryRecall: snapshot.memoryRecall
			? truncateCodePoints(snapshot.memoryRecall, 1500).text
			: null,
	};
	for (const key of SECTIONS) {
		// Each array keeps its existing element type; only whole rows are removed.
		Object.assign(bounded, {
			[key]: (snapshot[key] ?? []).slice(0, key === "pendingReports" ? 3 : 10),
		});
	}
	const base = `/api/bootstrap/${encodeURIComponent(snapshot.leadId)}`;
	for (;;) {
		const pointers = SECTIONS.map((key) => {
			const total = snapshot[key]?.length ?? 0;
			const shown = bounded[key]?.length ?? 0;
			const kind = QUESTION_KINDS[key as keyof typeof QUESTION_KINDS];
			return `${key}: count=${total}, omittedCount=${total - shown}; GET ${base}/${kind ? "questions" : "sections"}?kind=${kind ?? key}&limit=50`;
		});
		pointers.push(
			`memoryRecall: omittedCount=${snapshot.memoryRecall && bounded.memoryRecall !== snapshot.memoryRecall ? 1 : 0}; GET ${base}/sections?kind=memoryRecall&limit=1`,
		);
		pointers.push(
			`Audit history (hot + retained archive, on demand): GET ${base}/audit-events?limit=50; use returned nextCursor.`,
		);
		const text = `${renderBootstrap(bounded)}
Snapshot counts at generation; pages may change as obligations are answered. Use master-token authenticated GET; follow nextCursor until null (questions: URL-encode its JSON; sections: use the returned string).
${pointers.join("\n")}`;
		if (countCodePoints(text) <= 12000) return text;
		if (bounded.memoryRecall) {
			bounded.memoryRecall = null;
			continue;
		}
		const removable = [...SECTIONS]
			.reverse()
			.find((key) => bounded[key]?.length);
		if (!removable)
			throw new Error("bootstrap identifiers exceed recovery budget");
		bounded[removable]!.pop();
	}
}

function renderBootstrap(snapshot: LeadBootstrap): string {
	const sections: string[] = [
		`## Bootstrap — Lead: ${snapshot.leadId}`,
		`Generated at ${new Date().toISOString()}`,
		"",
	];

	if (snapshot.activeSessions.length > 0) {
		sections.push("### Active Sessions");
		for (const s of snapshot.activeSessions) {
			const roleTag =
				s.sessionRole && s.sessionRole !== "main"
					? ` [${s.sessionRole.toUpperCase()}]`
					: "";
			const chatHint = s.chatThreadId
				? ` (Chat-Thread: ${s.chatThreadId})`
				: "";
			sections.push(
				`- ${s.issueIdentifier ?? s.issueId}${roleTag}: ${truncateCodePoints(s.issueTitle ?? "—", 160).text} [${s.status}]${chatHint}`,
			);
		}
		sections.push("");
	}

	if (snapshot.pendingDecisions.length > 0) {
		sections.push("### Pending Decisions");
		for (const d of snapshot.pendingDecisions) {
			const roleTag =
				d.sessionRole && d.sessionRole !== "main"
					? ` [${d.sessionRole.toUpperCase()}]`
					: "";
			sections.push(
				`- ${d.issueIdentifier ?? d.issueId}${roleTag}: ${truncateCodePoints(d.issueTitle ?? "—", 160).text} (${d.decisionRoute ?? "unknown"})`,
			);
		}
		sections.push("");
	}

	if (snapshot.recentFailures.length > 0) {
		sections.push("### Recent Failures");
		for (const f of snapshot.recentFailures) {
			const roleTag =
				f.sessionRole && f.sessionRole !== "main"
					? ` [${f.sessionRole.toUpperCase()}]`
					: "";
			sections.push(
				`- ${f.issueIdentifier ?? f.issueId}${roleTag}: ${truncateCodePoints(f.lastError ?? "—", 160).text}`,
			);
		}
		sections.push("");
	}

	if (snapshot.recentEvents.length > 0) {
		sections.push(
			`### Recent Events (last 5 min — ${snapshot.recentEvents.length} events)`,
		);
		for (const e of snapshot.recentEvents) {
			sections.push(
				`- [#${e.seq}] ${e.event.event_type} — ${e.event.issue_identifier ?? e.event.issue_id ?? "—"}`,
			);
		}
		sections.push("");
	}

	if (snapshot.pendingGateQuestions?.length) {
		sections.push("### Pending Gate Questions");
		for (const gq of snapshot.pendingGateQuestions) {
			const tag = gq.checkpoint.toUpperCase();
			const issue = gq.issueIdentifier ?? gq.executionId;
			// FLY-59: Role label for non-main sessions
			const roleLabel =
				gq.sessionRole && gq.sessionRole !== "main"
					? `[${gq.sessionRole.toUpperCase()}] `
					: "";
			sections.push(
				`- ${roleLabel}[${tag}] ${issue} (ID: ${gq.questionId}, DB: ${gq.commDbPath}): ${truncateCodePoints(gq.content, 160).text}`,
			);
		}
		sections.push(
			'Action: For each, relay to Annie, then: flywheel-comm respond --db <DB path above> --lead <your_id> <question_id> "reply"',
		);
		sections.push("");
	}

	// FLY-161: non-blocking Runner asks (`flywheel-comm ask`). Listed as a
	// separate section so the Lead doesn't conflate them with hard gates.
	if (snapshot.pendingRunnerQuestions?.length) {
		sections.push("### Pending Runner Questions");
		for (const rq of snapshot.pendingRunnerQuestions) {
			const issue = rq.issueIdentifier ?? rq.executionId;
			const roleLabel =
				rq.sessionRole && rq.sessionRole !== "main"
					? `[${rq.sessionRole.toUpperCase()}] `
					: "";
			const threadHint = rq.chatThreadId
				? ` (Chat-Thread: ${rq.chatThreadId})`
				: "";
			sections.push(
				`- ${roleLabel}[ASK] ${issue} (ID: ${rq.questionId}, DB: ${rq.commDbPath})${threadHint}: ${truncateCodePoints(rq.content, 160).text}`,
			);
		}
		sections.push(
			'Action: Surface each to Annie (Runner is continuing work — non-blocking). Reply with: flywheel-comm respond --db <DB path above> --lead <your_id> <question_id> "reply"',
		);
		sections.push("");
	}

	if (snapshot.pendingReports?.length) {
		sections.push("### Pending Reports");
		for (const report of snapshot.pendingReports) {
			sections.push(
				`- [REPORT] ${report.issueIdentifier ?? report.executionId} (ID: ${report.questionId}, DB: ${report.commDbPath}): ${truncateCodePoints(report.content, 160).text}`,
			);
		}
		sections.push(
			"Reports are one-way; review pending actions without requiring a founder reply for each report.",
		);
	}

	if (snapshot.memoryRecall) {
		sections.push("### Memory Recall");
		sections.push(snapshot.memoryRecall);
		sections.push("");
	}

	return sections.join("\n");
}
