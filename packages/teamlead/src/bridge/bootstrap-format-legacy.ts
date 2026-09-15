import type { LeadBootstrap } from "./lead-runtime.js";

export function formatLegacyBootstrap(snapshot: LeadBootstrap): string {
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
				`- ${s.issueIdentifier ?? s.issueId}${roleTag}: ${s.issueTitle ?? "—"} [${s.status}]${chatHint}`,
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
				`- ${d.issueIdentifier ?? d.issueId}${roleTag}: ${d.issueTitle ?? "—"} (${d.decisionRoute ?? "unknown"})`,
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
				`- ${f.issueIdentifier ?? f.issueId}${roleTag}: ${f.lastError?.slice(0, 100) ?? "—"}`,
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
			const roleLabel =
				gq.sessionRole && gq.sessionRole !== "main"
					? `[${gq.sessionRole.toUpperCase()}] `
					: "";
			sections.push(
				`- ${roleLabel}[${tag}] ${issue} (ID: ${gq.questionId}, DB: ${gq.commDbPath}): ${gq.content.slice(0, 200)}${gq.content.length > 200 ? "..." : ""}`,
			);
		}
		sections.push(
			'Action: For each, relay to Annie, then: flywheel-comm respond --db <DB path above> --lead <your_id> <question_id> "reply"',
		);
		sections.push("");
	}

	// FLY-161: non-blocking Runner questions (`flywheel-comm ask`). Lead
	// surfaces these to Annie, but the Runner is NOT blocked — phrase the
	// snapshot text accordingly so the Lead doesn't treat them like gates.
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
				`- ${roleLabel}[ASK] ${issue} (ID: ${rq.questionId}, DB: ${rq.commDbPath})${threadHint}: ${rq.content.slice(0, 200)}${rq.content.length > 200 ? "..." : ""}`,
			);
		}
		sections.push(
			'Action: Surface each to Annie (Runner is continuing work — non-blocking). Reply with: flywheel-comm respond --db <DB path above> --lead <your_id> <question_id> "reply"',
		);
		sections.push("");
	}

	if (snapshot.memoryRecall) {
		sections.push("### Memory Recall");
		sections.push(snapshot.memoryRecall);
		sections.push("");
	}

	return sections.join("\n");
}
