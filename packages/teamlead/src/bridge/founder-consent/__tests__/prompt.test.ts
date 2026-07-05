import { describe, expect, it } from "vitest";
import {
	assembledPromptHash,
	buildUserMessage,
	FEW_SHOT,
	SYSTEM_PROMPT,
} from "../prompt.js";

describe("prompt assembly", () => {
	const input = {
		action: "approve",
		issueIdentifier: "FLY-175",
		executionId: "exec-1",
		sessionRole: "main",
		nowTs: "2026-05-28T10:00:00Z",
		windowHours: 24,
		messages: [
			{
				id: "m-f",
				authorId: "F",
				content: "approve FLY-175",
				ts: "2026-05-28T09:59:00Z",
				isBot: false,
				role: "founder" as const,
			},
		],
	};

	it("renders header + role-annotated messages", () => {
		const u = buildUserMessage(input);
		expect(u).toContain("action: approve");
		expect(u).toContain("issue_identifier: FLY-175");
		expect(u).toContain("[founder]");
		expect(u).toContain("approve FLY-175");
	});

	it("renders (none) when no messages", () => {
		expect(buildUserMessage({ ...input, messages: [] })).toContain("(none)");
	});

	it("hash is deterministic for identical input and sensitive to content", () => {
		const u1 = buildUserMessage(input);
		const h1 = assembledPromptHash(u1);
		expect(h1).toBe(assembledPromptHash(buildUserMessage(input)));
		const u2 = buildUserMessage({ ...input, action: "terminate" });
		expect(assembledPromptHash(u2)).not.toBe(h1);
	});

	it("system prompt forbids non-founder evidence", () => {
		expect(SYSTEM_PROMPT).toContain('role == "founder"');
		expect(FEW_SHOT).toContain("DENY");
	});
});
