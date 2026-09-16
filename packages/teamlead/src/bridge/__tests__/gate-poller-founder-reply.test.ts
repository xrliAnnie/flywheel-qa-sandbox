import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, describe, expect, it, vi } from "vitest";

const { emitSpy } = vi.hoisted(() => ({
	emitSpy: vi.fn(async (ctx: { threadId: string }) => ({
		threadId: ctx.threadId,
		result: "noop" as const,
	})),
}));
vi.mock("../founder-reply-deliverer.js", async () => {
	const actual = await vi.importActual<
		typeof import("../founder-reply-deliverer.js")
	>("../founder-reply-deliverer.js");
	return {
		...actual,
		emitFounderReplyDeliveryForThread: (...args: unknown[]) =>
			emitSpy(...(args as [{ threadId: string }])),
	};
});

import { GatePoller, type GatePollerConfig } from "../gate-poller.js";

const OWNER = "123456789012345678";

function makePoller(over: Partial<GatePollerConfig> = {}) {
	return new GatePoller({
		pollIntervalMs: 3_000,
		projects: [], // empty → poll() skips the relay loop; the Part B pass runs over nothing
		store: {} as unknown as GatePollerConfig["store"],
		runtimeRegistry: {} as unknown as GatePollerConfig["runtimeRegistry"],
		chatThreadsEnabled: true,
		discordOwnerUserId: OWNER,
		founderReplyDeliverEveryNTicks: 3,
		...over,
	});
}

type Priv = {
	poll(): Promise<void>;
	founderReplyDeliverPass(): Promise<void>;
	config: { projects: unknown };
};
async function tick(poller: GatePoller, n: number) {
	for (let i = 0; i < n; i++) await (poller as unknown as Priv).poll();
}

describe("FLY-605 GatePoller founder-reply deliver pass wiring (Part B)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("slow sub-cadence: pass fires on tickCount % N === 1, not every 3s tick", async () => {
		const poller = makePoller();
		const spy = vi
			.spyOn(poller as unknown as Priv, "founderReplyDeliverPass")
			.mockResolvedValue(undefined);
		await tick(poller, 7); // fires at ticks 1, 4, 7
		expect(spy).toHaveBeenCalledTimes(3);
	});

	it("missing owner / chatThreadsEnabled=false → pass early-returns (no project iteration)", async () => {
		for (const over of [
			{ discordOwnerUserId: undefined },
			{ chatThreadsEnabled: false },
			{ discordOwnerUserId: "not-a-snowflake" },
		]) {
			const projects = vi.fn(() => []);
			const poller = makePoller(over);
			// founderReplyDeliverPass should bail before touching projects.
			Object.defineProperty(poller, "config", {
				value: {
					...(poller as unknown as Priv).config,
					get projects() {
						return projects();
					},
				},
			});
			await (poller as unknown as Priv).founderReplyDeliverPass();
			expect(projects).not.toHaveBeenCalled();
		}
	});

	it("isolation: a throwing pass never breaks the poll loop", async () => {
		const poller = makePoller();
		vi.spyOn(
			poller as unknown as Priv,
			"founderReplyDeliverPass",
		).mockRejectedValue(new Error("boom"));
		await expect(tick(poller, 4)).resolves.toBeUndefined();
	});
});

import { InMemoryInboundCursorStore } from "../../lead-backends/codex/InboundCursorStore.js";

type PrivHandoff = {
	defaultReplyCursor: unknown;
	makeAmbiguousHandoff(
		lead: unknown,
		projectName: string,
	): (eventId: string, payload: Record<string, unknown>) => Promise<boolean>;
};

describe("FLY-605 ambiguous handoff durability + in-memory cursor (Codex code-review #2/#3)", () => {
	it("rejects a new founder handoff without a source thread", async () => {
		const appendLeadEvent = vi.fn(() => 42);
		const store = {
			isLeadEventDelivered: vi.fn(() => false),
			appendLeadEvent,
		} as unknown as GatePollerConfig["store"];
		const poller = makePoller({ store });
		const handoff = (poller as unknown as PrivHandoff).makeAmbiguousHandoff(
			{ agentId: "test-lead" },
			"flywheel",
		);

		await expect(
			handoff("founder-reply-missing-thread", {
				issueId: "FLY-1645",
				msgId: "m1",
				answer: "answer",
				commDbPath: "/tmp/flywheel-comm.db",
			}),
		).rejects.toThrow("founder_reply_source_thread_missing");
		expect(appendLeadEvent).not.toHaveBeenCalled();
	});

	it("passes the founder text to Lead unchanged without an attribution hint", async () => {
		const appendLeadEvent = vi.fn(() => 42);
		const store = {
			isLeadEventDelivered: vi.fn(() => false),
			appendLeadEvent,
			markLeadEventDelivered: vi.fn(),
			recordDeliveryFailure: vi.fn(),
			flush: vi.fn(),
		} as unknown as GatePollerConfig["store"];
		const deliver = vi.fn(async () => ({ delivered: true }));
		const runtimeRegistry = {
			getForLead: vi.fn(() => ({
				deliver,
			})),
		} as unknown as GatePollerConfig["runtimeRegistry"];
		const poller = makePoller({ store, runtimeRegistry });
		const handoff = (poller as unknown as PrivHandoff).makeAmbiguousHandoff(
			{ agentId: "test-lead" },
			"flywheel",
		);
		const founderText = `原样-${"x".repeat(1_200)}-结束`;

		await handoff("founder-reply-T1-m1", {
			issueId: "FLY-1392",
			threadId: "T1",
			msgId: "m1",
			answer: founderText,
			commDbPath: "/tmp/flywheel-comm.db",
		});

		expect(appendLeadEvent).toHaveBeenCalledWith(
			"test-lead",
			"founder-reply-T1-m1",
			"founder_reply",
			expect.any(String),
			"FLY-1392",
		);
		const encoded = appendLeadEvent.mock.calls[0]?.[3];
		const hookPayload = JSON.parse(encoded ?? "{}") as { action: string };
		expect(hookPayload).toMatchObject({
			event_type: "founder_reply",
			status: "founder_reply",
			summary: founderText,
			chat_thread_id: "T1",
			founder_message_id: "m1",
			comm_db_path: "/tmp/flywheel-comm.db",
			action: expect.stringContaining(
				'flywheel-comm respond <qid> "<founder-answer>"',
			),
		});
		expect(hookPayload.action).toContain("--source-thread T1");
		expect(hookPayload.action).toContain("non-approve_to_ship");
		expect(hookPayload.action).toContain("Discord ship card");
		expect(hookPayload.action).not.toContain("receipt");
		expect(hookPayload.action).not.toContain("route-founder-reply");
		expect(deliver).not.toHaveBeenCalled();
	});

	it("🔴 makeAmbiguousHandoff flushes lead_events to disk before returning true (Codex #2)", async () => {
		const flush = vi.fn();
		const store = {
			isLeadEventDelivered: vi.fn(() => false),
			appendLeadEvent: vi.fn(() => 42),
			markLeadEventDelivered: vi.fn(),
			recordDeliveryFailure: vi.fn(),
			flush,
		} as unknown as GatePollerConfig["store"];
		const runtimeRegistry = {
			getForLead: vi.fn(() => ({
				deliver: vi.fn(async () => ({ delivered: true })),
			})),
		} as unknown as GatePollerConfig["runtimeRegistry"];
		const poller = makePoller({ store, runtimeRegistry });
		const handoff = (poller as unknown as PrivHandoff).makeAmbiguousHandoff(
			{ agentId: "test-lead" },
			"flywheel",
		);
		const ok = await handoff("founder-reply-ambiguous-T1-m1", {
			issueId: "FLY-605",
			threadId: "T1",
			answer: "do X",
		});
		expect(ok).toBe(true);
		// flush MUST be called after markLeadEventDelivered, before the deliverer
		// advances + persists the thread cursor.
		expect(flush).toHaveBeenCalledTimes(1);
	});

	it("🔴 short-circuit (already delivered in memory) STILL flushes before returning true (Codex R2 #1)", async () => {
		// A prior pass may have set the in-memory delivered mark and then had
		// flush() throw — the cursor was NOT advanced that pass. The next pass hits
		// the isLeadEventDelivered() short-circuit, which must re-flush so the
		// cursor can never advance past a marker that never reached disk.
		const flush = vi.fn();
		const appendLeadEvent = vi.fn(() => 42);
		const store = {
			isLeadEventDelivered: vi.fn(() => true), // already delivered in memory
			appendLeadEvent,
			markLeadEventDelivered: vi.fn(),
			recordDeliveryFailure: vi.fn(),
			flush,
		} as unknown as GatePollerConfig["store"];
		const poller = makePoller({ store });
		const handoff = (poller as unknown as PrivHandoff).makeAmbiguousHandoff(
			{ agentId: "test-lead" },
			"flywheel",
		);
		const ok = await handoff("founder-reply-ambiguous-T1-m1", {
			issueId: "FLY-605",
			threadId: "T1",
			answer: "do X",
		});
		expect(ok).toBe(true);
		// re-flush on the short-circuit, and no duplicate append (we did NOT re-emit).
		expect(flush).toHaveBeenCalledTimes(1);
		expect(appendLeadEvent).not.toHaveBeenCalled();
	});

	it("🔴 short-circuit flush() failure propagates (cursor stays un-advanced) (Codex R2 #1)", async () => {
		const store = {
			isLeadEventDelivered: vi.fn(() => true),
			appendLeadEvent: vi.fn(() => 42),
			markLeadEventDelivered: vi.fn(),
			recordDeliveryFailure: vi.fn(),
			flush: vi.fn(() => {
				throw new Error("disk full");
			}),
		} as unknown as GatePollerConfig["store"];
		const poller = makePoller({ store });
		const handoff = (poller as unknown as PrivHandoff).makeAmbiguousHandoff(
			{ agentId: "test-lead" },
			"flywheel",
		);
		// flush throwing must propagate — the deliverer's per-thread catch then
		// leaves the cursor un-advanced so the message is retried.
		await expect(
			handoff("founder-reply-ambiguous-T1-m1", {
				issueId: "FLY-605",
				threadId: "T1",
				answer: "do X",
			}),
		).rejects.toThrow("disk full");
	});

	it("in-memory processed-through cursor exists when no file cursor is wired (Codex #3)", () => {
		const poller = makePoller(); // no cursorStore configured
		expect(
			(poller as unknown as PrivHandoff).defaultReplyCursor,
		).toBeInstanceOf(InMemoryInboundCursorStore);
	});
});

describe("FLY-2608 registered Raya thread ingress", () => {
	const roots: string[] = [];

	afterEach(() => {
		delete process.env.FLYWHEEL_COMM_DIR;
		for (const root of roots.splice(0))
			rmSync(root, { recursive: true, force: true });
		emitSpy.mockClear();
	});

	it("leaves same-thread tasks for unrelated Leads unchanged while Raya rollout is active", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2608-unrelated-leads-"));
		roots.push(root);
		process.env.FLYWHEEL_COMM_DIR = root;
		for (const project of ["alpha", "beta"])
			new CommDB(join(root, project, "comm.db")).close();
		const threadId = "1549573426547658793";
		const sessions = ["alpha", "beta"].map((projectName) => ({
			execution_id: `exec-${projectName}`,
			issue_id: `${projectName.toUpperCase()}-1`,
			project_name: projectName,
			issue_labels: "[]",
		}));
		const store = {
			listNonTerminalSessions: vi.fn(() => sessions),
			getChatThreadByIssue: vi.fn(() => ({ thread_id: threadId })),
			getUnarchivedIssueChatThreads: vi.fn(() => []),
			getUnarchivedPhaseChatThreads: vi.fn(() => []),
		} as unknown as GatePollerConfig["store"];
		const poller = makePoller({
			projects: ["alpha", "beta"].map((projectName, index) => ({
				projectName,
				leads: [
					{
						agentId: projectName,
						botToken: `${projectName}-token`,
						chatChannel: `15420790999280599${index}`,
						match: { labels: [] },
					},
				],
			})) as GatePollerConfig["projects"],
			store,
			founderThreadIngressRollout: {
				kind: "active",
				rolloutAfter: "1549500000000000000",
				markerSha256: "a".repeat(64),
				owners: [
					{
						projectName: "raya",
						leadId: "raya",
						chatChannelId: "1542079099928059987",
					},
				],
			},
		});

		await (poller as unknown as Priv).founderReplyDeliverPass();

		expect(emitSpy).toHaveBeenCalledTimes(2);
		expect(
			emitSpy.mock.calls
				.map((call) => call[0])
				.map(({ projectName }) => projectName),
		).toEqual(["alpha", "beta"]);
	});

	it("uses registered lead and parent ownership instead of the issue session project", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2608-poller-"));
		roots.push(root);
		process.env.FLYWHEEL_COMM_DIR = root;
		new CommDB(join(root, "flywheel", "comm.db")).close();
		new CommDB(join(root, "raya", "comm.db")).close();
		const threadId = "1549573426547658793";
		const channelId = "1542079099928059987";
		const nudgeLeadInbox = vi.fn(() => true);
		const store = {
			listNonTerminalSessions: vi.fn(() => [
				{
					execution_id: "exec-flywheel",
					issue_id: "FLY-2131",
					project_name: "flywheel",
					issue_labels: "[]",
				},
			]),
			getChatThreadByIssue: vi.fn(
				(_issueId: string, parentChannelId: string) =>
					parentChannelId === channelId ? { thread_id: threadId } : undefined,
			),
			getUnarchivedIssueChatThreads: vi.fn(() => [
				{
					thread_id: threadId,
					channel_id: channelId,
					issue_id: "FLY-2131",
					lead_id: null,
				},
			]),
			getUnarchivedPhaseChatThreads: vi.fn(() => [
				{
					thread_id: threadId,
					channel_id: channelId,
					issue_id: "FLY-2131",
					lead_id: null,
					session_role: "implement",
				},
			]),
		} as unknown as GatePollerConfig["store"];
		const poller = makePoller({
			projects: [
				{
					projectName: "flywheel",
					leads: [
						{
							agentId: "flywheel-eng-lead",
							botToken: "flywheel-token",
							chatChannel: "1530000000000000000",
							match: { labels: [] },
						},
					],
				},
				{
					projectName: "raya",
					leads: [
						{
							agentId: "raya",
							botToken: "raya-token",
							chatChannel: channelId,
							match: { labels: [] },
						},
					],
				},
			] as GatePollerConfig["projects"],
			store,
			runtimeRegistry: {
				nudgeLeadInbox,
			} as unknown as GatePollerConfig["runtimeRegistry"],
			founderThreadIngressRollout: {
				kind: "active",
				rolloutAfter: "1549500000000000000",
				markerSha256: "a".repeat(64),
				owners: [
					{ projectName: "raya", leadId: "raya", chatChannelId: channelId },
				],
			},
			listLeadSubscriptions: vi.fn(async () => []),
		});

		await (poller as unknown as Priv).founderReplyDeliverPass();

		expect(emitSpy).toHaveBeenCalledOnce();
		expect(emitSpy.mock.calls[0]?.[0]).toMatchObject({
			issueId: "FLY-2131",
			projectName: "raya",
			leadId: "raya",
			threadId,
			ingestOnly: true,
			rolloutAfter: "1549500000000000000",
			replyChannelId: threadId,
		});
		expect(emitSpy.mock.calls[0]?.[1]).toEqual([]);
		const deps = emitSpy.mock.calls[0]?.[2] as {
			nudgeLeadInbox?: () => void;
		};
		deps.nudgeLeadInbox?.();
		expect(nudgeLeadInbox).toHaveBeenCalledWith("raya", "raya");
	});

	it("rediscovers a locally archived registered thread from the owner's active guild threads", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2608-active-thread-"));
		roots.push(root);
		process.env.FLYWHEEL_COMM_DIR = root;
		new CommDB(join(root, "raya", "comm.db")).close();
		const threadId = "1549573438937767977";
		const channelId = "1542079099928059987";
		const fetchImpl = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({
				threads: [
					{ id: threadId, parent_id: channelId },
					{ id: "1549573438937767999", parent_id: "1542079099928059999" },
				],
			}),
		})) as unknown as typeof fetch;
		const store = {
			listNonTerminalSessions: vi.fn(() => []),
			getUnarchivedIssueChatThreads: vi.fn(() => []),
			getUnarchivedPhaseChatThreads: vi.fn(() => []),
			getChatThreadByThreadId: vi.fn((id: string) =>
				id === threadId
					? {
							thread_id: threadId,
							channel_id: channelId,
							issue_id: "FLY-2382",
							lead_id: "raya",
							session_role: "main",
						}
					: undefined,
			),
		} as unknown as GatePollerConfig["store"];
		const poller = makePoller({
			projects: [
				{
					projectName: "raya",
					leads: [
						{
							agentId: "raya",
							botToken: "raya-token",
							chatChannel: channelId,
							match: { labels: [] },
						},
					],
				},
			] as GatePollerConfig["projects"],
			store,
			fetchImpl,
			discordGuildId: "1542000000000000000",
			founderThreadIngressRollout: {
				kind: "active",
				rolloutAfter: "1549500000000000000",
				markerSha256: "a".repeat(64),
				owners: [
					{ projectName: "raya", leadId: "raya", chatChannelId: channelId },
				],
			},
			listLeadSubscriptions: vi.fn(async () => []),
		});

		await (poller as unknown as Priv).founderReplyDeliverPass();

		expect(fetchImpl).toHaveBeenCalledOnce();
		expect(store.getChatThreadByThreadId).toHaveBeenCalledOnce();
		expect(emitSpy).toHaveBeenCalledOnce();
		expect(emitSpy.mock.calls[0]?.[0]).toMatchObject({
			issueId: "FLY-2382",
			threadId,
			ingestOnly: true,
			replyChannelId: threadId,
		});
	});

	it("keeps a pending-question thread on the existing non-ingest-only path", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2608-pending-"));
		roots.push(root);
		process.env.FLYWHEEL_COMM_DIR = root;
		const db = new CommDB(join(root, "raya", "comm.db"));
		const questionId = db.insertQuestion("exec-1", "raya", "question");
		db.close();
		const threadId = "1549573426547658793";
		const channelId = "1542079099928059987";
		const store = {
			listNonTerminalSessions: vi.fn(() => []),
			getSession: vi.fn(() => ({
				execution_id: "exec-1",
				issue_id: "FLY-2131",
				project_name: "flywheel",
			})),
			getChatThreadByIssue: vi.fn(() => ({ thread_id: threadId })),
			getUnarchivedIssueChatThreads: vi.fn(() => [
				{
					thread_id: threadId,
					channel_id: channelId,
					issue_id: "FLY-2131",
					lead_id: "raya",
				},
			]),
			getUnarchivedPhaseChatThreads: vi.fn(() => []),
		} as unknown as GatePollerConfig["store"];
		const poller = makePoller({
			projects: [
				{
					projectName: "raya",
					leads: [
						{
							agentId: "raya",
							botToken: "raya-token",
							chatChannel: channelId,
							match: { labels: [] },
						},
					],
				},
			] as GatePollerConfig["projects"],
			store,
			founderThreadIngressRollout: {
				kind: "active",
				rolloutAfter: "1549500000000000000",
				markerSha256: "a".repeat(64),
				owners: [
					{ projectName: "raya", leadId: "raya", chatChannelId: channelId },
				],
			},
			listLeadSubscriptions: vi.fn(async () => []),
		});

		await (poller as unknown as Priv).founderReplyDeliverPass();

		expect(emitSpy).toHaveBeenCalledOnce();
		expect(emitSpy.mock.calls[0]?.[0]).toMatchObject({
			threadId,
			replyChannelId: threadId,
		});
		expect(emitSpy.mock.calls[0]?.[0]).not.toHaveProperty("ingestOnly");
		expect(emitSpy.mock.calls[0]?.[1]).toEqual([
			expect.objectContaining({ questionId }),
		]);
	});

	it("does not deliver an unowned or ambiguously owned registered thread", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2608-owner-negative-"));
		roots.push(root);
		process.env.FLYWHEEL_COMM_DIR = root;
		for (const project of ["raya", "other"])
			new CommDB(join(root, project, "comm.db")).close();
		const channelId = "1542079099928059987";
		const listLeadSubscriptions = vi.fn(async () => []);
		const store = {
			listNonTerminalSessions: vi.fn(() => []),
			getUnarchivedIssueChatThreads: vi.fn(() => [
				{
					thread_id: "1549573426547658793",
					channel_id: channelId,
					issue_id: "FLY-2131",
					lead_id: null,
				},
			]),
			getUnarchivedPhaseChatThreads: vi.fn(() => []),
		} as unknown as GatePollerConfig["store"];
		const poller = makePoller({
			projects: ["raya", "other"].map((projectName) => ({
				projectName,
				leads: [
					{
						agentId: projectName,
						botToken: `${projectName}-token`,
						chatChannel: channelId,
						match: { labels: [] },
					},
				],
			})) as GatePollerConfig["projects"],
			store,
			founderThreadIngressRollout: {
				kind: "active",
				rolloutAfter: "1549500000000000000",
				markerSha256: "a".repeat(64),
				owners: [
					{ projectName: "raya", leadId: "raya", chatChannelId: channelId },
				],
			},
			listLeadSubscriptions,
		});

		await (poller as unknown as Priv).founderReplyDeliverPass();

		expect(emitSpy).not.toHaveBeenCalled();
		expect(listLeadSubscriptions).not.toHaveBeenCalled();
	});
});
