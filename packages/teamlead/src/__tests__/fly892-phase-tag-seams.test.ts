/**
 * FLY-892 Step 3: the message-level phase tag is injected at the founder-facing
 * Discord-post seams. A three-stage phase session's messages carry `[设计·Fable] `
 * etc.; the shared automation marker remains the outermost prefix.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutoQaEffects } from "../bridge/auto-qa-effects.js";
import { AUTOMATED_MESSAGE_PREFIX } from "../bridge/automated-message.js";
import {
	emitFounderMilestoneNotification,
	emitFounderStuckNotification,
	emitFounderThreadNotification,
} from "../bridge/founder-thread-notifier.js";
import type { Session } from "../StateStore.js";
import { StateStore } from "../StateStore.js";

const OWNER = "123456789012345678"; // a valid Discord snowflake

function okPost() {
	return {
		ok: true,
		status: 200,
		json: () => Promise.resolve({ id: "msg-1" }),
		text: () => Promise.resolve(""),
	};
}

describe("FLY-892 Step 3: founder-thread-notifier phase prefix", () => {
	let store: StateStore;
	let posted: string[];
	let fetchImpl: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		posted = [];
		fetchImpl = vi.fn(async (_url: string, init: { body?: string }) => {
			posted.push(JSON.parse(init.body as string).content as string);
			return okPost();
		});
	});
	afterEach(() => store.close());

	const thread = {
		thread_id: "t-1",
		channel_id: "ch-1",
		lead_id: null,
		archived_at: null,
	};

	it("gate notification: a phase session tags the header, main does not", async () => {
		await emitFounderThreadNotification(
			{
				questionId: "q1",
				checkpoint: "approve_to_ship",
				executionId: "e-impl",
				issueId: "FLY-892",
				projectName: "flywheel",
				summary: "ready",
				ageMinutes: 5,
				thread,
				botToken: "bot",
				ownerUserId: OWNER,
				phasePrefix: "[实现·Opus] ",
			},
			{ store, fetchImpl },
		);
		expect(
			posted[0]?.startsWith(`${AUTOMATED_MESSAGE_PREFIX}[实现·Opus] 🚀`),
		).toBe(true);

		posted.length = 0;
		await emitFounderThreadNotification(
			{
				questionId: "q2",
				checkpoint: "brainstorm",
				executionId: "e-main",
				issueId: "FLY-500",
				projectName: "geoforge3d",
				summary: "confirm",
				ageMinutes: 5,
				thread,
				botToken: "bot",
				ownerUserId: OWNER,
				phasePrefix: "",
			},
			{ store, fetchImpl },
		);
		expect(posted[0]?.startsWith(`${AUTOMATED_MESSAGE_PREFIX}🧠`)).toBe(true);
	});

	it("milestone notification: phase session tags the header", async () => {
		await emitFounderMilestoneNotification(
			{
				executionId: "e-qa",
				issueId: "FLY-892",
				projectName: "flywheel",
				milestone: "completed",
				thread,
				botToken: "bot",
				ownerUserId: OWNER,
				phasePrefix: "[QA·Sonnet] ",
			},
			{ store, fetchImpl },
		);
		expect(
			posted[0]?.startsWith(`${AUTOMATED_MESSAGE_PREFIX}[QA·Sonnet] `),
		).toBe(true);
	});

	it("stuck notification: phase session tags the header", async () => {
		await emitFounderStuckNotification(
			{
				executionId: "e-impl",
				issueId: "FLY-892",
				projectName: "flywheel",
				leadAgentId: "flywheel-eng-lead",
				stuckMinutes: 30,
				thread,
				botToken: "bot",
				ownerUserId: OWNER,
				phasePrefix: "[实现·Opus] ",
			},
			{ store, fetchImpl },
		);
		expect(
			posted[0]?.startsWith(`${AUTOMATED_MESSAGE_PREFIX}[实现·Opus] 🚨`),
		).toBe(true);
	});
});

describe("FLY-892 Step 3: AutoQaEffects.postThread phase prefix", () => {
	let store: StateStore;
	let posted: string[];
	let fetchImpl: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		store.upsertChatThread("t-1", "chan-1", "FLY-892");
		posted = [];
		fetchImpl = vi.fn(async (_url: string, init: { body?: string }) => {
			posted.push(JSON.parse(init.body as string).content as string);
			return okPost();
		});
	});
	afterEach(() => store.close());

	const projects = [
		{
			projectName: "proj",
			projectRoot: "/x",
			leads: [
				{
					agentId: "lead-1",
					chatChannel: "chan-1",
					botToken: "bot",
					match: { labels: ["engineer"] },
				},
			],
		},
	] as never;

	function makeEffects() {
		return new AutoQaEffects({
			store,
			projects,
			config: { discordBotToken: "bot" },
			fetchImpl: fetchImpl as unknown as typeof fetch,
		} as never);
	}

	function session(over: Partial<Session>): Session {
		return {
			execution_id: "e",
			issue_id: "FLY-892",
			project_name: "proj",
			issue_labels: JSON.stringify(["engineer"]),
			status: "running",
			chat_thread_role: "main",
			...over,
		} as Session;
	}

	it("a three-stage QA phase session prepends the tag", async () => {
		await makeEffects().postThread({
			session: session({
				chat_thread_role: "qa",
				runner_model: "claude-sonnet-5",
			}),
			text: "QA PASS 🎉",
		});
		expect(posted[0]).toBe(`${AUTOMATED_MESSAGE_PREFIX}[QA·Sonnet] QA PASS 🎉`);
	});

	it("a main (standalone auto-QA) session has no phase tag", async () => {
		await makeEffects().postThread({
			session: session({ chat_thread_role: "main" }),
			text: "QA PASS 🎉",
		});
		expect(posted[0]).toBe(`${AUTOMATED_MESSAGE_PREFIX}QA PASS 🎉`);
	});
});
