/**
 * FLY-1082 (Tasks 3.1/3.2): the escalation chain close-out — the four-element
 * founder copy for fleet kinds (legacy line byte-compat), and the repeated-
 * escalation runbook-gap auto-issue (window count / dedup / human title).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AlertChannelHub } from "../../bridge/AlertChannelHub.js";
import type { AlertResult } from "../../LeadAlertNotifier.js";
import type { StateStore as StateStoreT } from "../../StateStore.js";
import { StateStore } from "../../StateStore.js";
import { noteTicketEscalated } from "../runbook-gap.js";

type PostTuple = [string, string, { mentionUserId?: string } | undefined];

function makeDiscord() {
	const posts: PostTuple[] = [];
	let n = 0;
	return {
		posts,
		async createThreadFromMessage() {
			return `thread-${++n}`;
		},
		async postToThread(
			threadId: string,
			content: string,
			opts?: { mentionUserId?: string },
		) {
			posts.push([threadId, content, opts]);
		},
		async archiveThread() {},
	};
}

const SENT: AlertResult = Object.freeze({
	sent: true,
	channelId: "UNI",
	messageId: "root-1",
});

describe("FLY-1082 Task 3.1 — four-element escalation copy", () => {
	let store: StateStoreT;
	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	async function escalateOnce(
		eventType: string,
		leadId: string,
	): Promise<PostTuple[]> {
		const discord = makeDiscord();
		const hub = new AlertChannelHub({
			store,
			notifier: { alert: vi.fn(async () => ({ ...SENT })) },
			discord,
			// No bot → ticket stays NEW; the reconcile-driven T2 path escalates.
			ticketPolicy: {
				maxAttempts: 2,
				timeoutMs: 1,
				unclaimedMs: 1,
				retryOnReconcile: false,
			},
		});
		await hub.handle({
			leadId,
			projectName: "machine",
			eventId: `e-${eventType}`,
			eventType: eventType as never,
			title: "T",
			body: "B",
			severity: "severe",
			ticket: {
				ownerUserId: "111111111111111111",
				ownerLabel: "claude bot",
				status: "NEW",
				firstSeenMs: Date.now() - 60_000,
				ownerRef: "infra_bot:claude",
			},
		});
		// Owner configured → the unclaimed fallback escalates on reconcile.
		process.env.FLYWHEEL_CLAUDE_INFRA_BOT_USER_ID = "111111111111111111";
		await hub.reconcile();
		delete process.env.FLYWHEEL_CLAUDE_INFRA_BOT_USER_ID;
		return discord.posts;
	}

	it("fleet kinds render kind · ARC 试了 · 为什么失败 · 一个决定 (no PRD numbers)", async () => {
		for (const [eventType, leadId, labelBit] of [
			["swap_pressure_high", "swap", "内存吃紧"],
			["tmux_server_lost", "tmux-server", "tmux server 丢了"],
			["bridge_abnormal_exit", "bridge", "Bridge 非正常退出"],
			["infra_bot_down", "infra-bot:claude", "infra bot 掉线"],
		] as const) {
			const posts = await escalateOnce(eventType, leadId);
			const line = posts.find(([, c]) => c.includes("🙋"));
			expect(line, eventType).toBeDefined();
			expect(line![1], eventType).toContain(labelBit);
			expect(line![1], eventType).toContain("ARC 试了：");
			expect(line![1], eventType).toContain("为什么失败：");
			expect(line![1], eventType).toContain("你只需拍一个决定：");
			expect(line![1], eventType).not.toMatch(/FLY-9\d\d/); // no PRD number
		}
	});

	it("needs_human at open ALSO renders the four-element template for fleet kinds (Codex R4 MED)", async () => {
		const discord = makeDiscord();
		const escalated: string[] = [];
		const hub = new AlertChannelHub({
			store,
			notifier: { alert: vi.fn(async () => ({ ...SENT })) },
			discord,
			autoRepairBot: {
				canAttempt: () => true,
				attempt: async () => ({
					outcome: "needs_human" as const,
					action: "none",
					detail: "13 个阵亡 runner 只成功迁移了 12 个（其余在静默重试）",
				}),
			} as never,
			onTicketEscalated: async (row) => {
				escalated.push(row.event_type);
			},
		});
		await hub.handle({
			leadId: "tmux-server",
			projectName: "machine",
			eventId: "e-nh",
			eventType: "tmux_server_lost",
			title: "T",
			body: "B",
			severity: "severe",
			ticket: {
				ownerUserId: null,
				ownerLabel: "claude bot",
				status: "NEW",
				firstSeenMs: Date.now(),
				ownerRef: "infra_bot:claude",
			},
		});
		const line = discord.posts.find(([, c]) => c.includes("🙋"));
		expect(line![1]).toContain("tmux server 丢了");
		expect(line![1]).toContain("ARC 试了：");
		// The bot's specific reason slots into the 为什么失败 element as-is.
		expect(line![1]).toContain(
			"为什么失败：13 个阵亡 runner 只成功迁移了 12 个",
		);
		expect(line![1]).toContain("你只需拍一个决定：");
		// needs_human landing feeds the runbook-gap window (R3 MED).
		expect(escalated).toEqual(["tmux_server_lost"]);
	});

	it("legacy kinds keep the pre-FLY-1082 escalate line byte-for-byte", async () => {
		const posts = await escalateOnce("rate_limit", "some-lead");
		const line = posts.find(([, c]) => c.includes("🙋"));
		expect(line![1]).toBe("🙋 Annie 修不掉(T2:重试 0 次 / 超时)— 需要你处理。");
	});
});

describe("FLY-1082 Task 3.2 — runbook-gap auto-issue", () => {
	let store: StateStoreT;
	let created: Array<{ title: string; description: string }>;
	let issueOpen: boolean | null;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		created = [];
		issueOpen = true;
	});

	function deps() {
		return {
			store,
			createIssue: async (input: { title: string; description: string }) => {
				created.push(input);
				return { id: `issue-${created.length}`, identifier: "FLY-2000" };
			},
			isIssueOpen: async () => issueOpen,
			env: {} as NodeJS.ProcessEnv,
			logger: () => {},
		};
	}

	it("below threshold just records; the 3rd escalation in 7 days files ONE issue", async () => {
		expect(await noteTicketEscalated("swap_pressure_high", deps())).toBe(
			"recorded",
		);
		expect(await noteTicketEscalated("swap_pressure_high", deps())).toBe(
			"recorded",
		);
		expect(await noteTicketEscalated("swap_pressure_high", deps())).toBe(
			"created",
		);
		expect(created).toHaveLength(1);
		// Human title, no PRD/issue jargon; carries the human label + count.
		expect(created[0]!.title).toContain("机器内存吃紧");
		expect(created[0]!.title).toContain("3 次");
		expect(created[0]!.title).not.toContain("FLY-915");
	});

	it("an OPEN runbook issue dedups further escalations (at most one per kind)", async () => {
		for (let i = 0; i < 3; i++)
			await noteTicketEscalated("infra_bot_down", deps());
		expect(created).toHaveLength(1);
		expect(await noteTicketEscalated("infra_bot_down", deps())).toBe("deduped");
		expect(created).toHaveLength(1);
	});

	it("a CLOSED runbook issue restarts the window (fresh count from this event)", async () => {
		for (let i = 0; i < 3; i++)
			await noteTicketEscalated("zombie_session_backlog", deps());
		expect(created).toHaveLength(1);
		issueOpen = false; // the filed issue got closed
		expect(await noteTicketEscalated("zombie_session_backlog", deps())).toBe(
			"recorded", // window restarted — count re-seeds at 1
		);
		expect(store.getRunbookIssue("zombie_session_backlog")).toBeUndefined();
		// Two more escalations re-file.
		await noteTicketEscalated("zombie_session_backlog", deps());
		expect(await noteTicketEscalated("zombie_session_backlog", deps())).toBe(
			"created",
		);
		expect(created).toHaveLength(2);
	});

	it("issue-open probe failure (null) keeps the dedup — never double-files", async () => {
		for (let i = 0; i < 3; i++)
			await noteTicketEscalated("infra_bot_down", deps());
		issueOpen = null;
		expect(await noteTicketEscalated("infra_bot_down", deps())).toBe("deduped");
		expect(created).toHaveLength(1);
	});

	it("kinds are counted independently", async () => {
		await noteTicketEscalated("swap_pressure_high", deps());
		await noteTicketEscalated("infra_bot_down", deps());
		await noteTicketEscalated("swap_pressure_high", deps());
		expect(created).toHaveLength(0);
	});
});
