import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatePoller, type GatePollerConfig } from "../gate-poller.js";
import type { LeadNudgeRow } from "../lead-pending-escalation.js";

/**
 * FLY-637-ext: GatePoller.maybeEmitLeadPendingNudge — a runner blocked on a
 * BLOCKING `question` gate the Lead hasn't answered → exponential-backoff nudge
 * the Lead → after K rounds page Annie ONCE. Non-blocking asks + founder-facing
 * gates are excluded; the kill-switch reverts to no-nudge.
 */

const CREATED_AT = "2026-01-01 00:00:00";
const CREATED_MS = Date.parse("2026-01-01T00:00:00Z");
const MIN = 60_000;

function makeStore() {
	const rows = new Map<string, LeadNudgeRow>();
	const delivered = new Set<string>();
	const appended: { eventType: string; eventId: string; payload: string }[] =
		[];
	const key = (e: string, q: string) => `${e}|${q}`;
	const store = {
		// lead-event delivery surface
		appendLeadEvent: vi.fn(
			(_lead: string, eventId: string, eventType: string, payload: string) => {
				appended.push({ eventType, eventId, payload });
				return appended.length;
			},
		),
		isLeadEventDelivered: vi.fn((_l: string, eventId: string) =>
			delivered.has(eventId),
		),
		markLeadEventDelivered: vi.fn(),
		recordDeliveryFailure: vi.fn(),
		// lead_pending_escalation surface (Map-backed so backoff really progresses)
		getLeadPendingEscalation: vi.fn((e: string, q: string) =>
			rows.get(key(e, q)),
		),
		upsertLeadPendingEscalation: vi.fn(
			(e: string, q: string, r: LeadNudgeRow) => {
				rows.set(key(e, q), r);
			},
		),
		clearLeadPendingEscalation: vi.fn((e: string, q?: string) => {
			if (q) rows.delete(key(e, q));
			else
				for (const k of [...rows.keys()])
					if (k.startsWith(`${e}|`)) rows.delete(k);
		}),
		pruneLeadPendingEscalationNotIn: vi.fn(),
		recoverFromCorruption: vi.fn(),
	} as unknown as GatePollerConfig["store"];
	return { store, rows, appended, delivered };
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
		issue_id: "FLY-637",
		issue_identifier: "FLY-637",
		project_name: "flywheel",
		status: "running",
		issue_labels: '["x"]',
		session_role: "main",
		session_stage: "implement",
		...over,
	};
}

function makeQuestion(over: Record<string, unknown> = {}) {
	return {
		id: "q1",
		from_agent: "exec1",
		content: "Should I use approach A or B?",
		created_at: CREATED_AT,
		checkpoint: "question", // blocking lead-facing gate
		content_type: "text",
		content_ref: null,
		...over,
	};
}

const deliverOk = { deliver: vi.fn(async () => ({ delivered: true })) };

function makePoller(over: Partial<GatePollerConfig> = {}) {
	const { store, ...rest } = over as { store?: GatePollerConfig["store"] };
	const built = makeStore();
	const alertSink = { alert: vi.fn(async () => ({ sent: true })) };
	const poller = new GatePoller({
		pollIntervalMs: 3_000,
		projects: PROJECTS,
		store: store ?? built.store,
		runtimeRegistry: {
			getForLead: vi.fn(() => deliverOk),
		} as unknown as GatePollerConfig["runtimeRegistry"],
		chatThreadsEnabled: false,
		leadAlertSink: alertSink,
		...(rest as Partial<GatePollerConfig>),
	});
	return { poller, ...built, alertSink };
}

type Priv = {
	maybeEmitLeadPendingNudge(l: unknown, s: unknown, q: unknown): Promise<void>;
};
const nudge = (p: GatePoller, s: unknown, q: unknown) =>
	(p as unknown as Priv).maybeEmitLeadPendingNudge(LEAD, s, q);

describe("GatePoller.maybeEmitLeadPendingNudge (FLY-637-ext)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		process.env.FLYWHEEL_LEAD_NUDGE_GRACE_MS = String(20 * MIN);
		process.env.FLYWHEEL_LEAD_NUDGE_CAP_MS = String(120 * MIN);
		process.env.FLYWHEEL_LEAD_NUDGE_PAGE_ANNIE_ROUNDS = "3";
	});
	afterEach(() => {
		vi.useRealTimers();
		delete process.env.FLYWHEEL_LEAD_NUDGE_GRACE_MS;
		delete process.env.FLYWHEEL_LEAD_NUDGE_CAP_MS;
		delete process.env.FLYWHEEL_LEAD_NUDGE_PAGE_ANNIE_ROUNDS;
		delete process.env.FLYWHEEL_LEAD_PENDING_ESCALATION;
	});

	it("does NOT nudge before grace (20min)", async () => {
		const { poller, appended } = makePoller();
		vi.setSystemTime(CREATED_MS + 19 * MIN);
		await nudge(poller, makeSession(), makeQuestion());
		expect(appended).toHaveLength(0);
	});

	it("nudges the Lead once grace has elapsed (runner_lead_pending_escalation)", async () => {
		const { poller, appended, rows } = makePoller();
		vi.setSystemTime(CREATED_MS + 20 * MIN);
		await nudge(poller, makeSession(), makeQuestion());
		expect(appended).toHaveLength(1);
		expect(appended[0]?.eventType).toBe("runner_lead_pending_escalation");
		expect(rows.get("exec1|q1")?.nudge_count).toBe(1);
	});

	it("does NOT nudge a founder-facing (brainstorm/approve_to_ship) gate", async () => {
		const { poller, appended, alertSink } = makePoller();
		vi.setSystemTime(CREATED_MS + 60 * MIN);
		await nudge(
			poller,
			makeSession(),
			makeQuestion({ checkpoint: "brainstorm" }),
		);
		await nudge(
			poller,
			makeSession(),
			makeQuestion({ checkpoint: "approve_to_ship" }),
		);
		expect(appended).toHaveLength(0);
		expect(alertSink.alert).not.toHaveBeenCalled();
	});

	it("does NOT nudge a non-blocking ask (checkpoint=null)", async () => {
		const { poller, appended } = makePoller();
		vi.setSystemTime(CREATED_MS + 60 * MIN);
		await nudge(poller, makeSession(), makeQuestion({ checkpoint: null }));
		expect(appended).toHaveLength(0);
	});

	it("exponential backoff: nudge #2 only after the grown interval", async () => {
		const { poller, appended } = makePoller();
		const s = makeSession();
		const q = makeQuestion();
		vi.setSystemTime(CREATED_MS + 20 * MIN); // nudge #1
		await nudge(poller, s, q);
		vi.setSystemTime(CREATED_MS + 50 * MIN); // next_eligible = 20+40=60 → not yet
		await nudge(poller, s, q);
		expect(appended).toHaveLength(1);
		vi.setSystemTime(CREATED_MS + 60 * MIN); // eligible → nudge #2
		await nudge(poller, s, q);
		expect(appended).toHaveLength(2);
	});

	it("after 3 nudges, pages Annie ONCE via runner_lead_pending_unhandled (no runnerStuck metadata)", async () => {
		const { poller, appended, alertSink } = makePoller();
		const s = makeSession();
		const q = makeQuestion();
		// nudge #1 @20, #2 @60, #3 @140, page @260
		for (const t of [20, 60, 140]) {
			vi.setSystemTime(CREATED_MS + t * MIN);
			await nudge(poller, s, q);
		}
		expect(appended).toHaveLength(3);
		expect(alertSink.alert).not.toHaveBeenCalled();
		vi.setSystemTime(CREATED_MS + 260 * MIN);
		await nudge(poller, s, q);
		expect(alertSink.alert).toHaveBeenCalledTimes(1);
		const payload = alertSink.alert.mock.calls[0]![0] as Record<
			string,
			unknown
		>;
		expect(payload.eventType).toBe("runner_lead_pending_unhandled");
		expect(payload.metadata).toBeUndefined(); // no runnerStuck → AutoRepairBot stays out
		// page-once: a later eligible tick keeps nudging the Lead, does not re-page
		const before = appended.length;
		vi.setSystemTime(CREATED_MS + 500 * MIN);
		await nudge(poller, s, q);
		expect(alertSink.alert).toHaveBeenCalledTimes(1);
		expect(appended.length).toBe(before + 1);
	});

	it("kill-switch FLYWHEEL_LEAD_PENDING_ESCALATION=0 → never nudges", async () => {
		process.env.FLYWHEEL_LEAD_PENDING_ESCALATION = "0";
		const { poller, appended } = makePoller();
		vi.setSystemTime(CREATED_MS + 60 * MIN);
		await nudge(poller, makeSession(), makeQuestion());
		expect(appended).toHaveLength(0);
	});

	it("a non-running session is skipped (liveness gate)", async () => {
		const { poller, appended } = makePoller();
		vi.setSystemTime(CREATED_MS + 60 * MIN);
		await nudge(poller, makeSession({ status: "completed" }), makeQuestion());
		expect(appended).toHaveLength(0);
	});

	it("a page that is NOT accepted leaves paged_annie false and re-attempts (R1 #1)", async () => {
		const { poller, rows, alertSink } = makePoller();
		alertSink.alert.mockResolvedValue({ skipped: "unknown-lead" }); // not accepted
		const s = makeSession();
		const q = makeQuestion();
		for (const t of [20, 60, 140, 260]) {
			vi.setSystemTime(CREATED_MS + t * MIN);
			await nudge(poller, s, q);
		}
		// page attempted but not accepted → row advanced, paged_annie still false
		expect(alertSink.alert).toHaveBeenCalledTimes(1);
		expect(rows.get("exec1|q1")?.paged_annie).toBe(false);
		// next eligible tick re-attempts the page (>= policy)
		vi.setSystemTime(CREATED_MS + 600 * MIN);
		await nudge(poller, s, q);
		expect(alertSink.alert).toHaveBeenCalledTimes(2);
		expect(rows.get("exec1|q1")?.paged_annie).toBe(false);
	});

	it("never accepts skipped:duplicate, and uses a per-attempt eventId so a stale claim can't masquerade as a page (R2 #1)", async () => {
		const { poller, rows, alertSink } = makePoller();
		// LeadAlertNotifier claims BEFORE sending — a failed first attempt would make
		// a STABLE-eventId retry report `duplicate`. We must never accept that.
		alertSink.alert.mockResolvedValue({ skipped: "duplicate" });
		const s = makeSession();
		const q = makeQuestion();
		for (const t of [20, 60, 140, 260, 600]) {
			vi.setSystemTime(CREATED_MS + t * MIN);
			await nudge(poller, s, q);
		}
		// two page attempts (260 + 600), both duplicate → NEVER marked paged
		expect(rows.get("exec1|q1")?.paged_annie).toBe(false);
		const pageCalls = alertSink.alert.mock.calls.filter(
			(c) =>
				(c[0] as { eventType: string }).eventType ===
				"runner_lead_pending_unhandled",
		);
		expect(pageCalls.length).toBe(2);
		const eventIds = pageCalls.map(
			(c) => (c[0] as { eventId: string }).eventId,
		);
		expect(new Set(eventIds).size).toBe(2); // per-attempt eventId (distinct)
	});

	it("a stuck_key change (old created_at) resets with a fresh grace — no immediate nudge (R1 #2)", async () => {
		const { poller, rows, appended } = makePoller();
		// seed a persisted row with a DIFFERENT stuck_key + already-nudged count
		rows.set("exec1|q1", {
			stuck_key: "STALE-DIFFERENT",
			nudge_count: 2,
			last_nudge_at_ms: CREATED_MS,
			next_eligible_at_ms: CREATED_MS,
			paged_annie: false,
		});
		// question is long past grace, but the stage (=stuck_key) just changed
		vi.setSystemTime(CREATED_MS + 600 * MIN);
		await nudge(poller, makeSession(), makeQuestion());
		// reset → NO nudge this tick; row reseeded count=0 with a fresh +grace clock
		expect(appended).toHaveLength(0);
		const row = rows.get("exec1|q1");
		expect(row?.nudge_count).toBe(0);
		expect(row?.next_eligible_at_ms).toBe(CREATED_MS + 600 * MIN + 20 * MIN);
	});

	it("getPendingQuestions signals onReadFailure for an existing-but-unopenable comm.db, not a missing one (R1 #3)", async () => {
		const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "fly637ext-cdb-"));
		try {
			const { poller } = makePoller();
			const priv = poller as unknown as {
				getPendingQuestions(p: string, l: string, cb?: () => void): unknown[];
			};
			// missing file → benign (no comm.db yet), callback NOT fired
			let missingFired = false;
			priv.getPendingQuestions(join(dir, "nope.db"), "test-lead", () => {
				missingFired = true;
			});
			expect(missingFired).toBe(false);
			// path EXISTS but openReadonly throws (a directory can't be opened as a
			// db) → genuine open failure → callback fires, returns [] (no throw).
			const unopenable = join(dir, "isdir.db");
			mkdirSync(unopenable);
			let badFired = false;
			const result = priv.getPendingQuestions(unopenable, "test-lead", () => {
				badFired = true;
			});
			expect(badFired).toBe(true);
			expect(result).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
