import { describe, it, expect } from "vitest";
import {
	PromptAssembler,
	escapeXml,
	buildAgentStatus,
	buildIssueDetail,
	buildIssueHistory,
} from "../PromptAssembler.js";
import type { Session } from "../StateStore.js";

function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		execution_id: "exec-1",
		issue_id: "GEO-95",
		project_name: "geoforge3d",
		status: "running",
		issue_identifier: "GEO-95",
		issue_title: "Refactor auth middleware",
		started_at: "2024-01-01 10:00:00",
		last_activity_at: "2024-01-01 10:30:00",
		commit_count: 3,
		files_changed: 6,
		lines_added: 120,
		lines_removed: 45,
		summary: "Refactored JWT verification",
		decision_route: "needs_review",
		decision_reasoning: "Auth changes need human review",
		last_error: undefined,
		...overrides,
	};
}

describe("PromptAssembler", () => {
	const assembler = new PromptAssembler();

	it("assemble includes system prompt", () => {
		const result = assembler.assemble("what's running?", []);
		expect(result.system).toContain("You are TeamLead");
		expect(result.system).toContain("CEO");
	});

	it("buildAgentStatus formats multiple sessions correctly", () => {
		const sessions = [
			makeSession({ issue_identifier: "GEO-95", status: "awaiting_review" }),
			makeSession({ execution_id: "e2", issue_id: "GEO-96", issue_identifier: "GEO-96", status: "running", issue_title: "Add payment API" }),
		];
		const result = buildAgentStatus(sessions);
		expect(result).toContain("<agent_status>");
		expect(result).toContain("GEO-95");
		expect(result).toContain("awaiting_review");
		expect(result).toContain("GEO-96");
		expect(result).toContain("running");
		expect(result).toContain("</agent_status>");
	});

	it("buildAgentStatus handles empty sessions", () => {
		const result = buildAgentStatus([]);
		expect(result).toContain("<agent_status>");
		expect(result).toContain("No active sessions");
		expect(result).toContain("</agent_status>");
	});

	it("buildIssueDetail includes all fields", () => {
		const session = makeSession();
		const result = buildIssueDetail(session);
		expect(result).toContain('<issue_detail issue="GEO-95">');
		expect(result).not.toContain("awaiting_review"); // status is running
		expect(result).toContain("running");
		expect(result).toContain("Refactor auth middleware");
		expect(result).toContain("Refactored JWT verification");
		expect(result).toContain("3"); // commits
		expect(result).toContain("6"); // files
		expect(result).toContain("needs_review");
		expect(result).toContain("</issue_detail>");
	});

	it("buildIssueDetail truncates long summary", () => {
		const longSummary = "A".repeat(300);
		const session = makeSession({ summary: longSummary });
		const result = buildIssueDetail(session);
		expect(result.length).toBeLessThan(longSummary.length + 200);
		expect(result).toContain("...");
	});

	it("buildIssueHistory formats multiple executions", () => {
		const history = [
			makeSession({ execution_id: "e1", status: "failed", last_error: "npm test timeout", started_at: "2024-01-01 08:00:00" }),
			makeSession({ execution_id: "e2", status: "awaiting_review", started_at: "2024-01-01 10:00:00" }),
		];
		const result = buildIssueHistory(history);
		expect(result).toContain('<issue_history issue="GEO-95">');
		expect(result).toContain("failed");
		expect(result).toContain("npm test timeout");
		expect(result).toContain("awaiting_review");
		expect(result).toContain("</issue_history>");
	});

	it("assemble with focusSession includes issue_detail", () => {
		const sessions = [makeSession()];
		const focusSession = makeSession();
		const result = assembler.assemble("how is GEO-95?", sessions, focusSession);
		expect(result.userContent).toContain("<issue_detail");
		expect(result.userContent).toContain("how is GEO-95?");
	});

	it("assemble without focusSession omits issue_detail", () => {
		const sessions = [makeSession()];
		const result = assembler.assemble("what's running?", sessions);
		expect(result.userContent).not.toContain("<issue_detail");
		expect(result.userContent).toContain("<agent_status>");
	});

	it("escapeXml handles angle brackets and ampersands", () => {
		expect(escapeXml("<script>alert('xss')</script>")).toBe(
			"&lt;script&gt;alert('xss')&lt;/script&gt;",
		);
		expect(escapeXml("a & b")).toBe("a &amp; b");
		expect(escapeXml('say "hello"')).toBe("say &quot;hello&quot;");
	});

	it("buildIssueDetail with summary containing <script> tag escapes properly", () => {
		const session = makeSession({ summary: '<script>alert("xss")</script>' });
		const result = buildIssueDetail(session);
		expect(result).not.toContain("<script>");
		expect(result).toContain("&lt;script&gt;");
	});
});
