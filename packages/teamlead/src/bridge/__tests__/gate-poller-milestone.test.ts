import { describe, expect, it, vi } from "vitest";
import { GatePoller, type GatePollerConfig } from "../gate-poller.js";

const OWNER = "123456789012345678";

function sqliteAt(ms: number): string {
	return new Date(ms)
		.toISOString()
		.replace("T", " ")
		.replace(/\.\d+Z$/, "");
}

interface FakeEvent {
	event_id: string;
	event_type: string;
	payload?: unknown;
}

function makeStore(recentSessions: Record<string, unknown>[]) {
	const events: FakeEvent[] = [];
	const store = {
		getRecentTerminalSessionsForNotify: vi.fn(
			(projectName: string) =>
				recentSessions.filter((s) => s.project_name === projectName) as never,
		),
		getEventsByExecution: vi.fn(() => events.slice()),
		insertEvent: vi.fn((e: FakeEvent) => {
			events.push({
				event_id: e.event_id,
				event_type: e.event_type,
				payload: e.payload,
			});
			return true;
		}),
		getChatThreadByIssue: vi.fn(() => ({
			thread_id: "T1",
			channel_id: "C1",
			lead_id: null,
			archived_at: null,
		})),
	} as unknown as GatePollerConfig["store"];
	return { store, events };
}

const LEAD = {
	agentId: "test-lead",
	chatChannel: "C1",
	botToken: "bot-token",
	match: { labels: ["x"] },
};
const PROJECT = {
	projectName: "flywheel",
	leads: [LEAD],
} as unknown as GatePollerConfig["projects"][number];
const PROJECTS = [PROJECT] as unknown as GatePollerConfig["projects"];

// FLY-725 v1 (B): default session is a FAILED runner WITH a real last_error
// (ground-truth present so the guard permits the ping).
function makeSession(over: Record<string, unknown> = {}) {
	return {
		execution_id: "exec1",
		issue_id: "FLY-725",
		issue_identifier: "FLY-725",
		issue_title: "milestone",
		project_name: "flywheel",
		status: "failed",
		issue_labels: '["x"]',
		session_role: "main",
		last_error: "npm build exploded",
		last_activity_at: sqliteAt(Date.now() - 60 * 60_000), // 1h ago (past grace)
		...over,
	};
}

type Priv = {
	maybeEmitMilestoneReports(project: unknown): Promise<void>;
};
async function patrol(poller: GatePoller) {
	await (poller as unknown as Priv).maybeEmitMilestoneReports(PROJECT);
}

function makePoller(
	store: GatePollerConfig["store"],
	over: Partial<GatePollerConfig> = {},
) {
	return new GatePoller({
		pollIntervalMs: 3_000,
		projects: PROJECTS,
		store,
		runtimeRegistry: {} as unknown as GatePollerConfig["runtimeRegistry"],
		chatThreadsEnabled: true,
		discordOwnerUserId: OWNER,
		founderMilestoneGraceMs: 1_000,
		founderMilestoneReportByProject: new Map([["flywheel", { enabled: true }]]),
		// Baseline cutoff = now → any already-terminal session (last_activity in the
		// past) counts as pre-boot "history" on the first patrol.
		founderMilestoneBaselineCutoffMs: Date.now(),
		...over,
	});
}

describe("FLY-725 GatePoller milestone patrol (v1 = failed/blocked, B)", () => {
	it("first patrol marker-seeds pre-existing history (no post); 2nd does not reseed; a fresh session then pings", async () => {
		const { store, events } = makeStore([makeSession()]);
		const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
		const poller = makePoller(store, {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});

		await patrol(poller);
		expect(fetchImpl).not.toHaveBeenCalled(); // history is seeded, never posted
		expect(
			events.some((e) => e.event_type === "founder_milestone_baseline_seeded"),
		).toBe(true);
		expect(
			events.some(
				(e) => e.event_id === "founder-milestone-notify-exec1-failed",
			),
		).toBe(true);

		// Second patrol: no reseed, still no post (already marked).
		await patrol(poller);
		expect(fetchImpl).not.toHaveBeenCalled();

		// A brand-new post-cutoff terminal session → pings once.
		store.getRecentTerminalSessionsForNotify = vi.fn(
			() =>
				[
					makeSession(),
					makeSession({
						execution_id: "exec2",
						issue_id: "FLY-726",
						issue_identifier: "FLY-726",
						last_activity_at: sqliteAt(Date.now() - 60_000),
					}),
				] as never,
		);
		await patrol(poller);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
		expect(url).toContain("/channels/T1/messages");
		expect(JSON.parse(init.body as string).content).toContain(`<@${OWNER}>`);
	});

	it("cutoff race: pre-cutoff session marker-only, post-cutoff session posts on the SAME first patrol (Codex R2 #1)", async () => {
		const cutoff = Date.now() - 30 * 60_000;
		const pre = makeSession({
			execution_id: "old",
			last_activity_at: sqliteAt(cutoff - 60_000),
		});
		const post = makeSession({
			execution_id: "new",
			issue_id: "FLY-800",
			issue_identifier: "FLY-800",
			last_activity_at: sqliteAt(cutoff + 60_000),
		});
		const { store } = makeStore([pre, post]);
		const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
		const poller = makePoller(store, {
			fetchImpl: fetchImpl as unknown as typeof fetch,
			founderMilestoneBaselineCutoffMs: cutoff,
		});
		await patrol(poller);
		// Exactly one POST: the post-cutoff session. Pre-cutoff was seeded only.
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url] = fetchImpl.mock.calls[0] as [string];
		expect(url).toContain("/channels/T1/messages");
	});

	it.each([
		["failed", "失败", { last_error: "boom" }],
		// blocked reason lives in summary (complete --route blocked --summary "…").
		["blocked", "受阻", { last_error: "", summary: "等一个产品决定" }],
	])(
		"emits %s once (with ground-truth reason) and is idempotent",
		async (status, zh, extra) => {
			const { store } = makeStore([]);
			const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
			const poller = makePoller(store, {
				fetchImpl: fetchImpl as unknown as typeof fetch,
				// cutoff in the far future → nothing counts as history → normal ping path
				founderMilestoneBaselineCutoffMs: 0,
			});
			store.getRecentTerminalSessionsForNotify = vi.fn(
				() =>
					[
						makeSession({
							status,
							last_activity_at: sqliteAt(Date.now() - 60_000),
							...extra,
						}),
					] as never,
			);
			await patrol(poller);
			expect(fetchImpl).toHaveBeenCalledTimes(1);
			const content = JSON.parse(
				(fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string,
			).content as string;
			expect(content).toContain(zh);
			// The ping carries the real reason (last_error for failed, summary for blocked).
			expect(content).toContain("原因：");
			expect(content).toContain(String(extra.last_error || extra.summary));
			// Idempotent: second patrol does not re-post.
			await patrol(poller);
			expect(fetchImpl).toHaveBeenCalledTimes(1);
		},
	);

	it("ground-truth guard: a route-only blocked with NO reason text is not pinged", async () => {
		const { store } = makeStore([]);
		const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
		const poller = makePoller(store, {
			fetchImpl: fetchImpl as unknown as typeof fetch,
			founderMilestoneBaselineCutoffMs: 0,
		});
		store.getRecentTerminalSessionsForNotify = vi.fn(
			() =>
				[
					makeSession({
						status: "blocked",
						last_error: "",
						summary: "",
						decision_reasoning: "",
						decision_route: "blocked", // route says blocked, but zero reason text
						last_activity_at: sqliteAt(Date.now() - 60_000),
					}),
				] as never,
		);
		await patrol(poller);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("ground-truth guard: a bare failed FSM flip with NO last_error is not pinged (FLY-232/172)", async () => {
		const { store, events } = makeStore([]);
		const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
		const poller = makePoller(store, {
			fetchImpl: fetchImpl as unknown as typeof fetch,
			founderMilestoneBaselineCutoffMs: 0,
		});
		store.getRecentTerminalSessionsForNotify = vi.fn(
			() =>
				[
					makeSession({
						status: "failed",
						last_error: "", // no real evidence → guard skips (no false ping)
						last_activity_at: sqliteAt(Date.now() - 60_000),
					}),
				] as never,
		);
		await patrol(poller);
		expect(fetchImpl).not.toHaveBeenCalled();
		// Skipped WITHOUT a terminal marker → can still ping if evidence lands later.
		expect(
			events.some((e) => e.event_type === "founder_milestone_notify_done"),
		).toBe(false);
	});

	it("no-op when project config or chat threads disable the report", async () => {
		for (const over of [
			{
				founderMilestoneReportByProject: new Map([
					["flywheel", { enabled: false }],
				]),
			},
			{ chatThreadsEnabled: false },
		] as Partial<GatePollerConfig>[]) {
			const { store, events } = makeStore([
				makeSession({ last_activity_at: sqliteAt(Date.now() - 60_000) }),
			]);
			const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
			const poller = makePoller(store, {
				fetchImpl: fetchImpl as unknown as typeof fetch,
				founderMilestoneBaselineCutoffMs: 0,
				...over,
			});
			await patrol(poller);
			expect(fetchImpl).not.toHaveBeenCalled();
			expect(events).toHaveLength(0);
		}
	});

	it("milestones subset only sends the configured kinds", async () => {
		const { store } = makeStore([]);
		const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
		const poller = makePoller(store, {
			fetchImpl: fetchImpl as unknown as typeof fetch,
			founderMilestoneBaselineCutoffMs: 0,
			founderMilestoneReportByProject: new Map([
				["flywheel", { enabled: true, milestones: ["blocked"] }],
			]),
		});
		store.getRecentTerminalSessionsForNotify = vi.fn(
			() =>
				[
					makeSession({
						status: "failed",
						last_error: "boom",
						last_activity_at: sqliteAt(Date.now() - 60_000),
					}),
				] as never,
		);
		await patrol(poller);
		expect(fetchImpl).not.toHaveBeenCalled(); // failed not in the ["blocked"] subset
	});

	it("queries only THIS project's terminal sessions (project boundary, Codex R1 #2)", async () => {
		const { store } = makeStore([]);
		const poller = makePoller(store, { founderMilestoneBaselineCutoffMs: 0 });
		await patrol(poller);
		expect(store.getRecentTerminalSessionsForNotify).toHaveBeenCalledWith(
			"flywheel",
			24,
		);
	});

	it("never silently drops: a permanent (4xx) delivery failure escalates on the alert channel", async () => {
		const { store, events } = makeStore([]);
		const fetchImpl = vi.fn(async () => new Response(null, { status: 403 }));
		const alert = vi.fn(async () => ({ sent: true }));
		const poller = makePoller(store, {
			fetchImpl: fetchImpl as unknown as typeof fetch,
			founderMilestoneBaselineCutoffMs: 0,
			leadAlertSink: {
				alert,
			} as unknown as GatePollerConfig["leadAlertSink"],
		});
		store.getRecentTerminalSessionsForNotify = vi.fn(
			() =>
				[
					makeSession({ last_activity_at: sqliteAt(Date.now() - 60_000) }),
				] as never,
		);
		await patrol(poller);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		// The founder wasn't pinged → an alert-channel escalation fired.
		expect(alert).toHaveBeenCalledTimes(1);
		expect((alert.mock.calls[0]?.[0] as { eventType: string }).eventType).toBe(
			"founder_milestone_undelivered",
		);
		// Terminal marker still written (won't retry a permanent failure).
		expect(
			events.some((e) => e.event_type === "founder_milestone_notify_done"),
		).toBe(true);
	});

	it("transient Discord failure enters retry backoff (no marker until budget or success)", async () => {
		const { store, events } = makeStore([]);
		const fetchImpl = vi.fn(async () => new Response(null, { status: 503 }));
		const poller = makePoller(store, {
			fetchImpl: fetchImpl as unknown as typeof fetch,
			founderMilestoneBaselineCutoffMs: 0,
		});
		store.getRecentTerminalSessionsForNotify = vi.fn(
			() =>
				[
					makeSession({ last_activity_at: sqliteAt(Date.now() - 60_000) }),
				] as never,
		);
		await patrol(poller);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		// No terminal done-marker yet (still retrying).
		expect(
			events.some((e) => e.event_type === "founder_milestone_notify_done"),
		).toBe(false);
	});
});
