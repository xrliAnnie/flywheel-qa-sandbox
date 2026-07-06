import { beforeEach, describe, expect, it } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import { StateStore } from "../../StateStore.js";
import {
	validateAndRegisterChatThread,
	validateChatThreadParams,
} from "../chat-thread-register.js";

const TEST_PROJECT: ProjectEntry = {
	projectName: "TestProject",
	projectRoot: "/tmp/test",
	leads: [
		{
			agentId: "lead-alpha",
			chatChannel: "ch-100",
			match: { labels: ["alpha"] },
		},
		{
			agentId: "lead-beta",
			chatChannel: "ch-200",
			match: { labels: ["beta"] },
		},
	],
};

describe("validateChatThreadParams (pure validation)", () => {
	const projects: ProjectEntry[] = [TEST_PROJECT];

	it("returns ok with project and leadConfig for valid input", () => {
		const result = validateChatThreadParams(
			{ channelId: "ch-100", leadId: "lead-alpha", projectName: "TestProject" },
			projects,
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.project.projectName).toBe("TestProject");
			expect(result.leadConfig.agentId).toBe("lead-alpha");
		}
	});

	it("returns 404 for unknown project", () => {
		const result = validateChatThreadParams(
			{ channelId: "ch-100", leadId: "lead-alpha", projectName: "NonExistent" },
			projects,
		);
		expect(result).toEqual({
			ok: false,
			status: 404,
			error: 'Project "NonExistent" not found',
		});
	});

	it("returns 403 for unknown lead", () => {
		const result = validateChatThreadParams(
			{
				channelId: "ch-100",
				leadId: "lead-unknown",
				projectName: "TestProject",
			},
			projects,
		);
		expect(result).toEqual({
			ok: false,
			status: 403,
			error: 'Lead "lead-unknown" not configured for project "TestProject"',
		});
	});

	it("returns 400 for channel mismatch", () => {
		const result = validateChatThreadParams(
			{ channelId: "ch-999", leadId: "lead-alpha", projectName: "TestProject" },
			projects,
		);
		expect(result).toEqual({
			ok: false,
			status: 400,
			error: 'channelId "ch-999" does not match lead\'s chatChannel "ch-100"',
		});
	});
});

describe("validateAndRegisterChatThread", () => {
	let store: StateStore;
	const projects: ProjectEntry[] = [TEST_PROJECT];

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	it("registers a valid chat thread", async () => {
		const result = await validateAndRegisterChatThread(
			{
				threadId: "t-1",
				channelId: "ch-100",
				issueId: "issue-1",
				leadId: "lead-alpha",
				projectName: "TestProject",
			},
			store,
			projects,
		);
		expect(result).toEqual({ ok: true });

		// Verify it was stored
		const row = store.getChatThreadByIssue("issue-1", "ch-100");
		expect(row).toBeDefined();
		expect(row!.thread_id).toBe("t-1");
	});

	it("returns 404 for unknown project", async () => {
		const result = await validateAndRegisterChatThread(
			{
				threadId: "t-1",
				channelId: "ch-100",
				issueId: "issue-1",
				leadId: "lead-alpha",
				projectName: "NonExistent",
			},
			store,
			projects,
		);
		expect(result).toEqual({
			ok: false,
			status: 404,
			error: 'Project "NonExistent" not found',
		});
	});

	it("returns 403 for unknown lead in project", async () => {
		const result = await validateAndRegisterChatThread(
			{
				threadId: "t-1",
				channelId: "ch-100",
				issueId: "issue-1",
				leadId: "lead-unknown",
				projectName: "TestProject",
			},
			store,
			projects,
		);
		expect(result).toEqual({
			ok: false,
			status: 403,
			error: 'Lead "lead-unknown" not configured for project "TestProject"',
		});
	});

	it("returns 400 when channelId mismatches lead chatChannel", async () => {
		const result = await validateAndRegisterChatThread(
			{
				threadId: "t-1",
				channelId: "ch-999",
				issueId: "issue-1",
				leadId: "lead-alpha",
				projectName: "TestProject",
			},
			store,
			projects,
		);
		expect(result).toEqual({
			ok: false,
			status: 400,
			error: 'channelId "ch-999" does not match lead\'s chatChannel "ch-100"',
		});
	});

	it("returns 409 when thread already mapped to different issue", async () => {
		// Pre-register thread for issue-1
		store.upsertChatThread("t-1", "ch-100", "issue-1", "lead-alpha");

		// Try to register same thread for issue-2
		const result = await validateAndRegisterChatThread(
			{
				threadId: "t-1",
				channelId: "ch-100",
				issueId: "issue-2",
				leadId: "lead-alpha",
				projectName: "TestProject",
			},
			store,
			projects,
		);
		expect(result).toEqual({
			ok: false,
			status: 409,
			error: "Thread t-1 already mapped to issue issue-1",
		});
	});

	it("allows re-registration of same thread for same issue (idempotent)", async () => {
		store.upsertChatThread("t-1", "ch-100", "issue-1", "lead-alpha");

		const result = await validateAndRegisterChatThread(
			{
				threadId: "t-1",
				channelId: "ch-100",
				issueId: "issue-1",
				leadId: "lead-alpha",
				projectName: "TestProject",
			},
			store,
			projects,
		);
		expect(result).toEqual({ ok: true });
	});

	it("allows different leads to register threads in their own channels", async () => {
		const r1 = await validateAndRegisterChatThread(
			{
				threadId: "t-1",
				channelId: "ch-100",
				issueId: "issue-1",
				leadId: "lead-alpha",
				projectName: "TestProject",
			},
			store,
			projects,
		);
		expect(r1.ok).toBe(true);

		const r2 = await validateAndRegisterChatThread(
			{
				threadId: "t-2",
				channelId: "ch-200",
				issueId: "issue-1",
				leadId: "lead-beta",
				projectName: "TestProject",
			},
			store,
			projects,
		);
		expect(r2.ok).toBe(true);
	});
});
