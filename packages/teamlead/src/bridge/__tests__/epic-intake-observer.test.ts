import { expect, it, vi } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import { createEpicIntakeObserver } from "../epic-intake-observer.js";
import type { EpicIntakeRecord } from "../epic-intake-store.js";

const at = "2026-09-14T20:00:00.000Z";
const row = {
	issueUuid: "uuid",
	identifier: "TEST-1",
	startedAt: at,
	eventUid: `epic_intake:uuid:${at}`,
	projectName: "test",
	leadId: "lead",
} as EpicIntakeRecord;
const project: ProjectEntry = {
	projectName: "test",
	projectRoot: "/tmp/test",
	linear: { team: "TEST" },
	leads: [
		{
			agentId: "lead",
			chatChannel: "123456789012345678",
			botUserId: "bot",
			botToken: "fixture",
			match: { labels: ["Engineering"] },
		},
	],
};
const root = {
	id: "uuid",
	identifier: "TEST-1",
	title: "test",
	url: "https://example.test",
	updatedAt: at,
	team: { key: "TEST" },
	project: null,
	labels: ["Engineering"],
	parent: null,
	state: { type: "started", name: "In Progress" },
	hasChildIssues: false,
	episodes: [
		{
			eventUid: row.eventUid,
			startedAt: at,
			endedAt: null,
			sourceSpanIds: ["span"],
			active: true,
		},
	],
};
const evidence = {
	outcome: "complete" as const,
	childIssueIds: [],
	firstBatchIssueIds: [],
	ledgerObservedAt: at,
	threadId: "223456789012345678",
	messageId: "323456789012345678",
	founderQuestion: null,
};
it("observes current segment, project dispatch and canonical thread before reading the receipt", async () => {
	const collect = vi.fn().mockResolvedValue({
		fetchedAt: at,
		candidates: [root],
		missingIssueIds: [],
		historyFailures: [
			{
				issueUuid: "unrelated",
				identifier: "TEST-2",
				reason: "intake_history_unavailable",
			},
		],
	});
	const snapshot = vi.fn().mockResolvedValue({
		items: [
			{ id: "direct", parent: { id: "uuid" } },
			{ id: "nested", parent: { id: "direct" } },
		],
	});
	const readMessage = vi.fn().mockResolvedValue({
		id: evidence.messageId,
		channelId: evidence.threadId,
		authorId: "bot",
	});
	const store = {
		hasEpicDispatchRecord: vi.fn(() => false),
		getChatThreadByIssue: vi.fn(() => ({
			thread_id: evidence.threadId,
			channel_id: project.leads[0]!.chatChannel,
			lead_id: "lead",
			archived_at: null,
		})),
	};
	const observe = createEpicIntakeObserver({
		projects: [project],
		store,
		apiKey: "fixture",
		collect,
		snapshot,
		readMessage,
		patrolIntervalMs: () => 60000,
		now: () => new Date(at),
	});
	expect(await observe(row, evidence)).toMatchObject({
		active: true,
		directChildIds: ["direct"],
		leadBotUserId: "bot",
	});
	store.hasEpicDispatchRecord.mockReturnValue(true);
	expect(
		await observe(row, { ...evidence, outcome: "superseded" }),
	).toMatchObject({ active: false, directChildIds: [] });
	collect.mockResolvedValue({
		fetchedAt: at,
		candidates: [],
		missingIssueIds: [],
	});
	await expect(observe(row, evidence)).rejects.toThrow();
	collect.mockResolvedValue({
		fetchedAt: at,
		candidates: [],
		missingIssueIds: ["uuid"],
	});
	expect(
		await observe(row, { ...evidence, outcome: "superseded" }),
	).toMatchObject({ active: false });
	store.getChatThreadByIssue.mockReturnValue({
		...store.getChatThreadByIssue(),
		thread_id: "wrong",
	});
	const calls = readMessage.mock.calls.length;
	await expect(observe(row, evidence)).rejects.toThrow();
	expect(readMessage).toHaveBeenCalledTimes(calls);
});

it("FLY-2597: verifies a quiet intake without Discord credentials, thread creation or message reads", async () => {
	const quietProject = {
		...project,
		leads: project.leads.map((l) => ({
			...l,
			botToken: undefined,
			botUserId: undefined,
		})),
	};
	const readMessage = vi.fn();
	const observe = createEpicIntakeObserver({
		projects: [quietProject],
		store: {
			hasEpicDispatchRecord: () => false,
			getChatThreadByIssue: () => undefined,
		},
		apiKey: "fixture",
		collect: vi.fn().mockResolvedValue({
			fetchedAt: at,
			candidates: [root],
			missingIssueIds: [],
			historyFailures: [],
		}),
		snapshot: vi.fn().mockResolvedValue({ items: [] }),
		readMessage,
		patrolIntervalMs: () => 60000,
		now: () => new Date(at),
	});
	const { threadId: _t, messageId: _m, ...quiet } = evidence;
	const truth = await observe(row, quiet);
	expect(truth).toMatchObject({
		active: true,
		message: null,
		canonicalThreadId: null,
	});
	expect(readMessage).not.toHaveBeenCalled();
});
