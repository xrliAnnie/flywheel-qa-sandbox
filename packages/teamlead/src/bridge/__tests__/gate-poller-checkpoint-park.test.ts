/**
 * FLY-927 (Task 3.2): checkpoint-park 1h patrol — 1h gate / evidence gate /
 * two-window escalation / durable dedup / kill-switch OFF byte-compat.
 * `wakeRunnerMailbox` + `CommDB` are mocked (no real comm.db); the founder
 * page rides the mocked Discord fetch through the real issue-thread leg.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatePoller, type GatePollerConfig } from "../gate-poller.js";

const wakeCalls: Array<Record<string, unknown>> = [];
vi.mock("flywheel-comm/wake", () => ({
	wakeRunnerMailbox: vi.fn(async (args: Record<string, unknown>) => {
		wakeCalls.push(args);
		return { ok: true };
	}),
}));
vi.mock("flywheel-comm/db", () => ({
	CommDB: class {},
}));

const OWNER = "123456789012345678";

function sqliteAgo(ms: number): string {
	return new Date(Date.now() - ms)
		.toISOString()
		.replace("T", " ")
		.replace(/\.\d+Z$/, "");
}

interface FakeEvent {
	event_id: string;
	event_type: string;
	payload?: unknown;
}

function makeStore(existingEvents: FakeEvent[] = []) {
	const events: FakeEvent[] = [...existingEvents];
	const leadEvents: string[] = [];
	const store = {
		getChatThreadByIssue: vi.fn(() => ({
			thread_id: "T1",
			channel_id: "C1",
			lead_id: null,
			archived_at: null,
		})),
		getEventsByExecution: vi.fn(() => events.slice()),
		insertEvent: vi.fn((e: FakeEvent) => {
			events.push({
				event_id: e.event_id,
				event_type: e.event_type,
				payload: e.payload,
			});
			return true;
		}),
		appendLeadEvent: vi.fn((leadId: string, eventId: string) => {
			leadEvents.push(`${leadId}:${eventId}`);
			return leadEvents.length;
		}),
		markLeadEventDelivered: vi.fn(),
		recordDeliveryFailure: vi.fn(),
	} as unknown as GatePollerConfig["store"];
	return { store, events, leadEvents };
}

const LEAD = {
	agentId: "test-lead",
	chatChannel: "C1",
	botToken: "bot-token",
	match: { labels: ["x"] },
};
const PROJECTS = [
	{ projectName: "flywheel", leads: [LEAD] },
] as unknown as GatePollerConfig["projects"];

function makeSession(over: Record<string, unknown> = {}) {
	return {
		execution_id: "exec1",
		issue_id: "FLY-912",
		issue_identifier: "FLY-912",
		project_name: "flywheel",
		status: "running",
		issue_labels: '["x"]',
		session_role: "main",
		session_stage: "approve",
		...over,
	};
}

function makeQuestion(over: Record<string, unknown> = {}) {
	return {
		id: "q1",
		from_agent: "exec1",
		content: "PR ready",
		created_at: sqliteAgo(90 * 60_000), // 1.5h ago → past the 1h window
		checkpoint: "approve_to_ship",
		content_type: "text",
		content_ref: null,
		...over,
	};
}

function okFetch() {
	return vi.fn(async () => ({
		ok: true,
		status: 200,
		headers: { get: () => null },
		json: async () => ({ id: "m-1" }),
		text: async () => "",
	})) as unknown as typeof fetch;
}

function makePoller(store: GatePollerConfig["store"], fetchImpl: typeof fetch) {
	return new GatePoller({
		pollIntervalMs: 3_000,
		projects: PROJECTS,
		store,
		runtimeRegistry: {
			getForLead: () => undefined,
		} as unknown as GatePollerConfig["runtimeRegistry"],
		chatThreadsEnabled: true,
		discordOwnerUserId: OWNER,
		fetchImpl,
	});
}

type Priv = {
	maybeEmitCheckpointParkAlert(
		lead: unknown,
		session: unknown,
		question: unknown,
		dbPath: string,
	): Promise<void>;
};

async function patrol(poller: GatePoller, session: unknown, question: unknown) {
	await (poller as unknown as Priv).maybeEmitCheckpointParkAlert(
		LEAD,
		session,
		question,
		"dbpath",
	);
}

describe("FLY-927 checkpoint-park patrol", () => {
	const saved: Record<string, string | undefined> = {};
	beforeEach(() => {
		for (const k of [
			"FLYWHEEL_CHECKPOINT_WATCHDOG",
			"FLYWHEEL_CHECKPOINT_STUCK_MS",
		]) {
			saved[k] = process.env[k];
		}
		process.env.FLYWHEEL_CHECKPOINT_WATCHDOG = "1";
		delete process.env.FLYWHEEL_CHECKPOINT_STUCK_MS;
		wakeCalls.length = 0;
	});
	afterEach(() => {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		vi.clearAllMocks();
	});

	it("KILL-SWITCH unset → whole patrol off (byte-compat)", async () => {
		delete process.env.FLYWHEEL_CHECKPOINT_WATCHDOG;
		const { store, events } = makeStore();
		await patrol(makePoller(store, okFetch()), makeSession(), makeQuestion());
		expect(events).toHaveLength(0);
		expect(wakeCalls).toHaveLength(0);
	});

	it("under the 1h window → silent", async () => {
		const { store, events } = makeStore();
		await patrol(
			makePoller(store, okFetch()),
			makeSession(),
			makeQuestion({ created_at: sqliteAgo(30 * 60_000) }),
		);
		expect(events).toHaveLength(0);
	});

	it("EVIDENCE gate: a successful founder delivery for this gate → silent", async () => {
		const { store, events } = makeStore([
			{
				event_id: "founder_thread_notified-x",
				event_type: "founder_thread_notified",
				payload: { questionId: "q1" },
			},
		]);
		await patrol(makePoller(store, okFetch()), makeSession(), makeQuestion());
		expect(events).toHaveLength(1); // only the pre-existing evidence row
		expect(wakeCalls).toHaveLength(0);
	});

	it("FIRST window, no evidence → owner wake (runner + lead) + durable marker; truthful wording", async () => {
		const { store, events, leadEvents } = makeStore();
		await patrol(makePoller(store, okFetch()), makeSession(), makeQuestion());
		expect(wakeCalls).toHaveLength(1);
		expect(String(wakeCalls[0]!.content)).toContain("停在approve");
		expect(String(wakeCalls[0]!.content)).toContain("待你拍板");
		expect(String(wakeCalls[0]!.content).toLowerCase()).not.toContain(
			"code review",
		);
		expect(leadEvents).toEqual(["test-lead:checkpoint-park-lead-q1"]);
		expect(events.map((e) => e.event_type)).toEqual(["checkpoint_park_nudged"]);
	});

	it("re-run within the second window → dedup (no double nudge, no page yet)", async () => {
		const { store, events } = makeStore([
			{
				event_id: "checkpoint-park-nudged-q1",
				event_type: "checkpoint_park_nudged",
				payload: { questionId: "q1", nudgedAtMs: Date.now() - 10_000 },
			},
		]);
		const fetchImpl = okFetch();
		await patrol(makePoller(store, fetchImpl), makeSession(), makeQuestion());
		expect(wakeCalls).toHaveLength(0);
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(events).toHaveLength(1);
	});

	it("SECOND full window past the nudge, still no evidence → founder page in the ISSUE thread + page marker", async () => {
		const { store, events } = makeStore([
			{
				event_id: "checkpoint-park-nudged-q1",
				event_type: "checkpoint_park_nudged",
				payload: {
					questionId: "q1",
					nudgedAtMs: Date.now() - 70 * 60_000,
				},
			},
		]);
		const fetchImpl = okFetch();
		await patrol(makePoller(store, fetchImpl), makeSession(), makeQuestion());
		const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock
			.calls[0] as [string, RequestInit];
		expect(url).toContain("/channels/T1/messages");
		const body = JSON.parse(init.body as string);
		expect(body.content).toContain("停在approve");
		expect(body.content).toContain("待你拍板");
		expect(body.allowed_mentions).toEqual({ users: [OWNER] });
		expect(events.some((e) => e.event_type === "checkpoint_park_paged")).toBe(
			true,
		);
	});

	it("page dedup: an existing page marker → no second page", async () => {
		const { store } = makeStore([
			{
				event_id: "checkpoint-park-nudged-q1",
				event_type: "checkpoint_park_nudged",
				payload: { questionId: "q1", nudgedAtMs: Date.now() - 70 * 60_000 },
			},
			{
				event_id: "checkpoint-park-paged-q1",
				event_type: "checkpoint_park_paged",
				payload: { questionId: "q1" },
			},
		]);
		const fetchImpl = okFetch();
		await patrol(makePoller(store, fetchImpl), makeSession(), makeQuestion());
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("637 non-overlap: question-checkpoint gates never enter this patrol", async () => {
		const { store, events } = makeStore();
		await patrol(
			makePoller(store, okFetch()),
			makeSession(),
			makeQuestion({ checkpoint: "question" }),
		);
		expect(events).toHaveLength(0);
		expect(wakeCalls).toHaveLength(0);
	});
});
