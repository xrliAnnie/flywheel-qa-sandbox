import type { Session } from "./StateStore.js";

export interface AssembledPrompt {
	system: string;
	userContent: string;
}

const SYSTEM_PROMPT = `You are TeamLead, an AI engineering manager for the Flywheel autonomous development system.

Your responsibilities:
- Answer the CEO's questions about issue status, agent activity, and execution results
- Provide concise, factual answers based on the data provided
- Highlight potential concerns (stuck agents, failures, related issues)
- Use the issue identifier (e.g., GEO-95) when referring to issues

Rules:
- Only reference data provided in the context tags below. Do not hallucinate.
- Keep responses concise — 2-5 sentences for simple queries, more for complex ones.
- Use Chinese if the CEO writes in Chinese, English if in English.
- If you don't have enough data to answer, say so honestly.
- Never expose internal implementation details (execution IDs, DB schemas, etc.)`;

const SUMMARY_MAX_LENGTH = 200;
const REASONING_MAX_LENGTH = 200;
const ERROR_MAX_LENGTH = 200;
const TITLE_MAX_LENGTH = 50;
const ERROR_INLINE_MAX_LENGTH = 80;
const MAX_CHANGED_FILES = 10;
const MAX_HISTORY_ENTRIES = 5;

export function escapeXml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return text.slice(0, maxLen) + "...";
}

function getDisplayId(session: Session): string {
	return session.issue_identifier ?? session.issue_id;
}

function formatDiffInfo(session: Session): string {
	if (session.lines_added == null || session.lines_removed == null) return "";
	return ` (+${session.lines_added}/-${session.lines_removed})`;
}

function formatSessionLine(session: Session): string {
	const id = getDisplayId(session);
	const title = session.issue_title ? escapeXml(truncate(session.issue_title, TITLE_MAX_LENGTH)) : "untitled";
	const parts = [`- ${escapeXml(id)}: ${session.status} | "${title}"`];

	if (session.commit_count != null && session.files_changed != null) {
		parts.push(`${session.commit_count} commits, ${session.files_changed} files${formatDiffInfo(session)}`);
	}

	if (session.decision_route) {
		parts.push(escapeXml(session.decision_route));
	}

	if (session.last_error) {
		parts.push(`error: ${escapeXml(truncate(session.last_error, ERROR_INLINE_MAX_LENGTH))}`);
	}

	return parts.join(" | ");
}

export function buildAgentStatus(sessions: Session[]): string {
	if (sessions.length === 0) {
		return "<agent_status>\nNo active sessions.\n</agent_status>";
	}
	const lines = sessions.map(formatSessionLine);
	return `<agent_status>\n${lines.join("\n")}\n</agent_status>`;
}

export function buildIssueDetail(session: Session): string {
	const id = getDisplayId(session);
	const lines: string[] = [];
	lines.push(`<issue_detail issue="${escapeXml(id)}">`);
	lines.push(`Status: ${session.status}`);
	if (session.issue_title) {
		lines.push(`Title: ${escapeXml(session.issue_title)}`);
	}
	if (session.summary) {
		lines.push(`Summary: ${escapeXml(truncate(session.summary, SUMMARY_MAX_LENGTH))}`);
	}
	if (session.commit_count != null && session.files_changed != null) {
		lines.push(`Commits: ${session.commit_count} | Files: ${session.files_changed}${formatDiffInfo(session)}`);
	}
	if (session.decision_route) {
		lines.push(`Decision: ${escapeXml(session.decision_route)}`);
	}
	if (session.decision_reasoning) {
		lines.push(`Reasoning: ${escapeXml(truncate(session.decision_reasoning, REASONING_MAX_LENGTH))}`);
	}
	if (session.last_error) {
		lines.push(`Error: ${escapeXml(truncate(session.last_error, ERROR_MAX_LENGTH))}`);
	}
	if (session.changed_file_paths) {
		const files = session.changed_file_paths.split("\n").slice(0, MAX_CHANGED_FILES);
		lines.push(`Changed files: ${files.map(f => escapeXml(f)).join(", ")}`);
	}
	lines.push("</issue_detail>");
	return lines.join("\n");
}

export function buildIssueHistory(history: Session[]): string {
	if (history.length === 0) return "";
	const id = getDisplayId(history[0]!);
	const entries = history.slice(0, MAX_HISTORY_ENTRIES).map((s, i) => {
		const parts = [`- Execution ${i + 1}: ${s.status}`];
		if (s.last_error) {
			parts.push(`error: "${escapeXml(truncate(s.last_error, ERROR_INLINE_MAX_LENGTH))}"`);
		}
		if (s.commit_count != null && s.files_changed != null) {
			parts.push(`${s.commit_count} commits, ${s.files_changed} files`);
		}
		if (s.started_at) {
			parts.push(s.started_at);
		}
		return parts.join(" | ");
	});
	return `<issue_history issue="${escapeXml(id)}">\n${entries.join("\n")}\n</issue_history>`;
}

export class PromptAssembler {
	assemble(
		question: string,
		activeSessions: Session[],
		focusSession?: Session,
		issueHistory?: Session[],
	): AssembledPrompt {
		const contextParts: string[] = [];

		contextParts.push(buildAgentStatus(activeSessions));

		if (focusSession) {
			contextParts.push(buildIssueDetail(focusSession));
		}

		if (issueHistory && issueHistory.length > 0) {
			const historyBlock = buildIssueHistory(issueHistory);
			if (historyBlock) {
				contextParts.push(historyBlock);
			}
		}

		const userContent = `${contextParts.join("\n\n")}\n\nCEO's question: ${escapeXml(question)}`;

		return {
			system: SYSTEM_PROMPT,
			userContent,
		};
	}
}
