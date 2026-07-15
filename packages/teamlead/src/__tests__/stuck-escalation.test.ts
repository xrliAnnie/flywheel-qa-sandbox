/**
 * FLY-195: tests for the Bridge wiring layer (plan §3.2 + §3.6) — the
 * escalation emitter, the Q7 Annie alerter, env knobs, guardrail membership,
 * and the Lead-rules pin (ladder constants must not drift from the prompt).
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	GUARDRAIL_EVENT_TYPES,
	RETRYABLE_LEAD_EVENT_TYPES,
} from "../bridge/lead-runtime.js";
import {
	buildStuckRunnerDetector,
	createStuckEscalationEmitter,
	createStuckUnhandledAlerter,
	DEFAULT_IDLE_POLL_MS,
	idleWatchdogPollMs,
	parseNonNegativeIntEnv,
	probeCommSignalsFromCommDb,
	probeQuietSignals,
	stuckCommActivityMs,
	stuckDetectionEnabled,
	stuckEscalationEventId,
	stuckLatchTtlMs,
	stuckLeadGraceMs,
	stuckThresholdMs,
	stuckUnhandledEventId,
} from "../bridge/stuck-escalation.js";
import { LEAD_GRACE_MS } from "../bridge/stuck-runner-detector.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { Session } from "../StateStore.js";

const testProjects: ProjectEntry[] = [
	{
		projectName: "geo",
		projectRoot: "/tmp/geo",
		leads: [
			{
				agentId: "product-lead",
				forumChannel: "f",
				chatChannel: "c",
				match: { labels: ["Product"] },
			},
		],
	},
] as unknown as ProjectEntry[];

function makeSession(over: Partial<Session> = {}): Session {
	return {
		execution_id: "exec-1",
		issue_id: "FLY-1",
		issue_identifier: "FLY-1",
		project_name: "geo",
		status: "running",
		issue_labels: "Product",
		...over,
	} as Session;
}

const EVIDENCE = {
	stuck_minutes: 12,
	tail: "❯ ",
	stream_error_signature: true,
	input_box_present: true,
};

function escalationPayload() {
	return {
		session: makeSession(),
		evidence: EVIDENCE,
		episodeFingerprint: "abcdef0123456789",
		episodeStartedAt: 1_000,
	};
}

function mockStore() {
	const appended: Array<{
		leadId: string;
		eventId: string;
		eventType: string;
		payload: string;
	}> = [];
	return {
		appended,
		appendLeadEvent: vi.fn(
			(leadId: string, eventId: string, eventType: string, payload: string) => {
				appended.push({ leadId, eventId, eventType, payload });
				return appended.length;
			},
		),
		isLeadEventDelivered: vi.fn(() => false),
		markLeadEventDelivered: vi.fn(),
		recordDeliveryFailure: vi.fn(),
		getStuckDisposition: vi.fn(() => undefined),
	};
}

function mockRegistry(delivered = true) {
	const deliver = vi.fn(async () => ({ delivered }));
	return {
		deliver,
		registry: { getForLead: vi.fn(() => ({ deliver })) },
	};
}

describe("guardrail membership", () => {
	it("runner_stuck_escalation is guardrail + retryable", () => {
		expect(GUARDRAIL_EVENT_TYPES.has("runner_stuck_escalation")).toBe(true);
		expect(RETRYABLE_LEAD_EVENT_TYPES.has("runner_stuck_escalation")).toBe(
			true,
		);
	});
});

describe("createStuckEscalationEmitter", () => {
	it("persists + delivers to the owning Lead with full evidence payload", async () => {
		const store = mockStore();
		const { registry, deliver } = mockRegistry();
		const emit = createStuckEscalationEmitter({
			store: store as never,
			projects: testProjects,
			runtimeRegistry: registry as never,
			log: () => {},
		});
		const ok = await emit(escalationPayload());
		expect(ok).toBe(true);
		expect(store.appendLeadEvent).toHaveBeenCalledTimes(1);
		const row = store.appended[0]!;
		expect(row.leadId).toBe("product-lead");
		expect(row.eventType).toBe("runner_stuck_escalation");
		expect(row.eventId).toBe(
			stuckEscalationEventId("exec-1", "abcdef0123456789", 1_000),
		);
		const payload = JSON.parse(row.payload);
		expect(payload.stuck_minutes).toBe(12);
		expect(payload.episode_fingerprint).toBe("abcdef0123456789");
		expect(payload.stream_error_signature).toBe(true);
		expect(payload.input_box_present).toBe(true);
		expect(payload.terminal_tail).toBe("❯ ");
		// Lead guidance points at the two remanage endpoints + FLY-175 boundary.
		expect(payload.stage_context).toContain("recovery-nudge");
		expect(payload.stage_context).toContain("stuck-disposition");
		expect(payload.stage_context).toContain("FLY-175");
		expect(deliver).toHaveBeenCalledTimes(1);
		expect(store.markLeadEventDelivered).toHaveBeenCalledWith(1);
	});

	it("returns false when no owning Lead resolves (unknown project)", async () => {
		const store = mockStore();
		const { registry } = mockRegistry();
		const emit = createStuckEscalationEmitter({
			store: store as never,
			projects: testProjects,
			runtimeRegistry: registry as never,
			log: () => {},
		});
		const ok = await emit({
			...escalationPayload(),
			session: makeSession({ project_name: "ghost-project" }),
		});
		expect(ok).toBe(false);
		expect(store.appendLeadEvent).not.toHaveBeenCalled();
	});

	it("skips re-append for an already-delivered episode eventId", async () => {
		const store = mockStore();
		store.isLeadEventDelivered.mockReturnValue(true);
		const { registry } = mockRegistry();
		const emit = createStuckEscalationEmitter({
			store: store as never,
			projects: testProjects,
			runtimeRegistry: registry as never,
			log: () => {},
		});
		expect(await emit(escalationPayload())).toBe(true);
		expect(store.appendLeadEvent).not.toHaveBeenCalled();
	});

	it("records the delivery failure (guardrail retry owns redelivery) and still returns true", async () => {
		const store = mockStore();
		const { registry } = mockRegistry(false);
		const emit = createStuckEscalationEmitter({
			store: store as never,
			projects: testProjects,
			runtimeRegistry: registry as never,
			log: () => {},
		});
		expect(await emit(escalationPayload())).toBe(true);
		expect(store.recordDeliveryFailure).toHaveBeenCalledTimes(1);
		expect(store.markLeadEventDelivered).not.toHaveBeenCalled();
	});
});

describe("createStuckUnhandledAlerter (Q7)", () => {
	function unhandledPayload() {
		return {
			session: makeSession(),
			episodeFingerprint: "abcdef0123456789",
			stuckMinutes: 17,
			escalatedAt: 5_000,
		};
	}
	const EVENT_ID = stuckUnhandledEventId("exec-1", "abcdef0123456789", 5_000);
	const FID = "123456789012345678"; // valid Discord snowflake

	it("pages via the notifier with the generation eventId format and no raw pane content", async () => {
		const alert = vi.fn(async () => ({ sent: true }));
		const alerter = createStuckUnhandledAlerter(
			testProjects,
			{ alert },
			{ log: () => {} },
		);
		expect(await alerter(unhandledPayload())).toBe(true);
		expect(alert).toHaveBeenCalledTimes(1);
		const payload = alert.mock.calls[0]![0] as Record<string, unknown>;
		expect(payload.eventType).toBe("runner_stuck_unhandled");
		expect(payload.eventId).toBe(EVENT_ID);
		// FLY-253 (Codex R2 #3): escalatedAt generation salt — a persistent
		// fingerprint-only dedup would swallow the second-generation Q7 after a
		// re-arm / TTL reminder when the Lead stays silent again.
		expect(payload.eventId).toBe(
			"runner-stuck-unhandled:exec-1:abcdef0123456789:5000",
		);
		expect(payload.leadId).toBe("product-lead");
		expect(payload.severity).toBe("warning");
		// privacy: body explains, but carries no terminal capture
		expect(String(payload.body)).not.toContain("❯");
	});

	it("two generations of the same frozen frame produce DISTINCT eventIds (claims dedup must not swallow the second)", () => {
		const g1 = stuckUnhandledEventId("exec-1", "abcdef0123456789", 5_000);
		const g2 = stuckUnhandledEventId("exec-1", "abcdef0123456789", 9_000);
		expect(g1).not.toBe(g2);
	});

	it("Q7 body is honest about the Lead (busy, down, or stuck — §3.3)", async () => {
		const alert = vi.fn(async () => ({ sent: true }));
		const alerter = createStuckUnhandledAlerter(
			testProjects,
			{ alert },
			{ log: () => {} },
		);
		await alerter(unhandledPayload());
		const payload = alert.mock.calls[0]![0] as Record<string, unknown>;
		expect(String(payload.body)).toContain("busy, down, or stuck");
		expect(String(payload.body)).not.toContain("down or stuck too");
	});

	it("treats queued and duplicate outcomes as resolved", async () => {
		for (const result of [
			{ queued: true },
			{ skipped: "duplicate" as const },
		]) {
			const alerter = createStuckUnhandledAlerter(
				testProjects,
				{ alert: vi.fn(async () => result) },
				{ log: () => {} },
			);
			expect(await alerter(unhandledPayload())).toBe(true);
		}
	});

	it("unresolvable lead or hard-skip outcomes are NOT resolved (retry next poll)", async () => {
		const ghost = createStuckUnhandledAlerter(
			testProjects,
			{ alert: vi.fn(async () => ({ sent: true })) },
			{ log: () => {} },
		);
		expect(
			await ghost({
				...unhandledPayload(),
				session: makeSession({ project_name: "ghost" }),
			}),
		).toBe(false);

		const skipped = createStuckUnhandledAlerter(
			testProjects,
			{ alert: vi.fn(async () => ({ skipped: "no-channel" as const })) },
			{ log: () => {} },
		);
		expect(await skipped(unhandledPayload())).toBe(false);
	});

	// ── FLY-818 M3 (Annie's design — issue-thread founder page) ──────────────
	// A genuinely-stuck runner pages the founder with an @founder message posted
	// into its OWN [FLY-XX] issue chat_thread (NOT a DM, NOT the alert channel =
	// the rejected FLY-523 path). Default-ON (kill-switch FLYWHEEL_STUCK_FOUNDER_PAGE=0)
	// but additionally requires an owner id + store; else byte-compat legacy
	// semantics. `annieAlerted` is gated on a GENUINE posted page; the ledger
	// converges so a duplicate never re-pages.
	function founderStore(threadId: string | undefined) {
		const paged = new Map<string, boolean>();
		const events: Array<{ event_type: string }> = [];
		return {
			paged,
			events,
			getFounderPaged: (id: string) =>
				paged.has(id) ? paged.get(id) : undefined,
			recordFounderPaged: (id: string, v: boolean) =>
				paged.set(id, (paged.get(id) ?? false) || v),
			getChatThreadByIssue: vi.fn((_issueId: string, channelId: string) =>
				threadId ? { thread_id: threadId, channel_id: channelId } : undefined,
			),
			insertEvent: vi.fn((e: { event_type: string }) => {
				events.push(e);
				return true;
			}),
		};
	}
	function okFetch() {
		return vi.fn(async () => ({
			ok: true,
			status: 204,
			text: async () => "",
			headers: { get: () => null },
		})) as unknown as typeof fetch;
	}
	// Default-ON: an unset flag enables the page (kill-switch =0 disables).
	const DEFAULT_ON = {} as NodeJS.ProcessEnv;
	const KILL_SWITCH = { FLYWHEEL_STUCK_FOUNDER_PAGE: "0" } as NodeJS.ProcessEnv;

	it("issue-thread page: posts an @founder message into the runner's [FLY-XX] thread with a founder-only mention, and resolves", async () => {
		const store = founderStore("th-1");
		const fetchImpl = okFetch();
		const alerter = createStuckUnhandledAlerter(
			testProjects,
			{ alert: vi.fn(async () => ({ sent: true })) },
			{
				store: store as never,
				discordOwnerUserId: FID,
				discordBotToken: "global-bot",
				fetchImpl,
				env: DEFAULT_ON,
				log: () => {},
			},
		);
		expect(await alerter(unhandledPayload())).toBe(true);
		// Resolved the issue thread by (issue_id, lead.chatChannel).
		expect(store.getChatThreadByIssue).toHaveBeenCalledWith("FLY-1", "c");
		// Posted to THAT thread with a founder-only @-mention.
		const [url, init] = (
			fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }
		).mock.calls[0]!;
		expect(url).toContain("/channels/th-1/messages");
		const body = JSON.parse(init.body as string);
		expect(body.content).toContain(`<@${FID}>`);
		expect(body.allowed_mentions).toEqual({ users: [FID] });
		// Ledger recorded a real page.
		expect(store.paged.get(EVENT_ID)).toBe(true);
	});

	it("no chat thread yet ⇒ NOT resolved (transient; detector retries) and the ledger stays false", async () => {
		const store = founderStore(undefined); // getChatThreadByIssue → undefined
		const fetchImpl = okFetch();
		const alerter = createStuckUnhandledAlerter(
			testProjects,
			{ alert: vi.fn(async () => ({ sent: true })) },
			{
				store: store as never,
				discordOwnerUserId: FID,
				discordBotToken: "global-bot",
				fetchImpl,
				env: DEFAULT_ON,
				log: () => {},
			},
		);
		expect(await alerter(unhandledPayload())).toBe(false);
		expect(fetchImpl).not.toHaveBeenCalled(); // skipped before POST
		expect(store.paged.get(EVENT_ID)).toBe(false);
	});

	it("ledger converge: a prior REAL page ⇒ resolved without re-posting (no spam)", async () => {
		const store = founderStore("th-1");
		store.paged.set(EVENT_ID, true); // already paged this episode
		const fetchImpl = okFetch();
		const alerter = createStuckUnhandledAlerter(
			testProjects,
			{ alert: vi.fn(async () => ({ sent: true })) },
			{
				store: store as never,
				discordOwnerUserId: FID,
				discordBotToken: "global-bot",
				fetchImpl,
				env: DEFAULT_ON,
				log: () => {},
			},
		);
		expect(await alerter(unhandledPayload())).toBe(true);
		expect(fetchImpl).not.toHaveBeenCalled(); // converged → never re-posts
	});

	it("FLY-927 (Task 2.4): FLYWHEEL_ALERT_TICKETS=1 ⇒ the IMMEDIATE page is replaced by T2 (no page here; the reconcile escalation pages later)", async () => {
		const store = founderStore("th-1");
		const fetchImpl = okFetch();
		const alerter = createStuckUnhandledAlerter(
			testProjects,
			{ alert: vi.fn(async () => ({ sent: true })) },
			{
				store: store as never,
				discordOwnerUserId: FID,
				discordBotToken: "global-bot",
				fetchImpl,
				env: { FLYWHEEL_ALERT_TICKETS: "1" } as NodeJS.ProcessEnv,
				log: () => {},
			},
		);
		// The ticket-queue root post is the notification; the alerter resolves on
		// the legacy semantics and never fires the immediate founder page.
		expect(await alerter(unhandledPayload())).toBe(true);
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(store.getChatThreadByIssue).not.toHaveBeenCalled();
	});

	it("kill-switch FLYWHEEL_STUCK_FOUNDER_PAGE=0 ⇒ legacy semantics (sent/duplicate resolve), no founder page", async () => {
		const store = founderStore("th-1");
		const fetchImpl = okFetch();
		const opts = {
			store: store as never,
			discordOwnerUserId: FID,
			fetchImpl,
			env: KILL_SWITCH, // default-on disabled by the kill-switch
			log: () => {},
		};
		const sent = createStuckUnhandledAlerter(
			testProjects,
			{ alert: vi.fn(async () => ({ sent: true })) },
			opts,
		);
		expect(await sent(unhandledPayload())).toBe(true);
		const dup = createStuckUnhandledAlerter(
			testProjects,
			{ alert: vi.fn(async () => ({ skipped: "duplicate" as const })) },
			opts,
		);
		expect(await dup(unhandledPayload())).toBe(true);
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(store.getChatThreadByIssue).not.toHaveBeenCalled();
	});

	it("no owner id ⇒ founder page disabled (degrade to legacy, no retry-storm)", async () => {
		const store = founderStore("th-1");
		const fetchImpl = okFetch();
		const alerter = createStuckUnhandledAlerter(
			testProjects,
			{ alert: vi.fn(async () => ({ sent: true })) },
			{
				store: store as never,
				// discordOwnerUserId omitted
				fetchImpl,
				env: DEFAULT_ON,
				log: () => {},
			},
		);
		expect(await alerter(unhandledPayload())).toBe(true); // legacy (sent)
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});

describe("env knobs (plan §3.7)", () => {
	it("master switch defaults ON; FLYWHEEL_STUCK_DETECT=0 disables", () => {
		expect(stuckDetectionEnabled({} as NodeJS.ProcessEnv)).toBe(true);
		expect(
			stuckDetectionEnabled({
				FLYWHEEL_STUCK_DETECT: "0",
			} as NodeJS.ProcessEnv),
		).toBe(false);
		expect(
			stuckDetectionEnabled({
				FLYWHEEL_STUCK_DETECT: "1",
			} as NodeJS.ProcessEnv),
		).toBe(true);
	});

	it("threshold/grace parse with safe fallbacks", () => {
		expect(stuckThresholdMs({} as NodeJS.ProcessEnv)).toBe(600_000);
		expect(stuckLeadGraceMs({} as NodeJS.ProcessEnv)).toBe(LEAD_GRACE_MS);
		expect(
			stuckThresholdMs({
				FLYWHEEL_STUCK_THRESHOLD_MS: "120000",
			} as NodeJS.ProcessEnv),
		).toBe(120_000);
		expect(
			stuckLeadGraceMs({
				FLYWHEEL_STUCK_LEAD_GRACE_MS: "60000",
			} as NodeJS.ProcessEnv),
		).toBe(60_000);
		for (const bad of ["abc", "-5", "0", ""]) {
			expect(
				stuckThresholdMs({
					FLYWHEEL_STUCK_THRESHOLD_MS: bad,
				} as NodeJS.ProcessEnv),
			).toBe(600_000);
		}
	});

	// FLY-628: idle-watchdog poll cadence — band-aid default stretched to ~1h.
	it("idleWatchdogPollMs defaults to ~1h and honors a valid override", () => {
		expect(DEFAULT_IDLE_POLL_MS).toBe(3_600_000);
		expect(idleWatchdogPollMs({} as NodeJS.ProcessEnv)).toBe(3_600_000);
		expect(
			idleWatchdogPollMs({
				FLYWHEEL_IDLE_POLL_MS: "120000",
			} as NodeJS.ProcessEnv),
		).toBe(120_000);
		// junk / non-positive falls back to the ~1h default (a 0 must not turn
		// the watchdog into a hot 0ms loop).
		for (const bad of ["abc", "-5", "0", ""]) {
			expect(
				idleWatchdogPollMs({
					FLYWHEEL_IDLE_POLL_MS: bad,
				} as NodeJS.ProcessEnv),
			).toBe(3_600_000);
		}
	});

	// FLY-253 knobs — `0` is a VALID value here ("off"), unlike the positive knobs.
	it("parseNonNegativeIntEnv accepts 0 (does not fall back) and rejects junk", () => {
		expect(parseNonNegativeIntEnv("0", 99)).toBe(0);
		expect(parseNonNegativeIntEnv("5", 99)).toBe(5);
		expect(parseNonNegativeIntEnv(undefined, 99)).toBe(99);
		expect(parseNonNegativeIntEnv("", 99)).toBe(99);
		expect(parseNonNegativeIntEnv("abc", 99)).toBe(99);
		expect(parseNonNegativeIntEnv("-5", 99)).toBe(99);
	});

	it("activity window: default 30 min; 0 disables L1", () => {
		expect(stuckCommActivityMs({} as NodeJS.ProcessEnv)).toBe(1_800_000);
		expect(
			stuckCommActivityMs({
				FLYWHEEL_STUCK_COMM_ACTIVITY_MS: "0",
			} as NodeJS.ProcessEnv),
		).toBe(0);
		expect(
			stuckCommActivityMs({
				FLYWHEEL_STUCK_COMM_ACTIVITY_MS: "60000",
			} as NodeJS.ProcessEnv),
		).toBe(60_000);
	});

	it("latch TTL: default 72h; 0 = permanent", () => {
		expect(stuckLatchTtlMs({} as NodeJS.ProcessEnv)).toBe(259_200_000);
		expect(
			stuckLatchTtlMs({
				FLYWHEEL_STUCK_LATCH_TTL_MS: "0",
			} as NodeJS.ProcessEnv),
		).toBe(0);
	});

	it("factory wires decision-time re-read from store.getSession (MEDIUM-2)", async () => {
		const store = mockStore();
		// Live row says awaiting_review even though the caller's snapshot says running.
		const getSession = vi.fn(() => makeSession({ status: "awaiting_review" }));
		(store as Record<string, unknown>).getSession = getSession;
		const { registry } = mockRegistry();
		const detector = buildStuckRunnerDetector({
			store: store as never,
			projects: testProjects,
			runtimeRegistry: registry as never,
			notifier: { alert: vi.fn(async () => ({ sent: true })) },
			env: { FLYWHEEL_STUCK_THRESHOLD_MS: "1000" } as NodeJS.ProcessEnv,
			now: (() => {
				let t = 0;
				return () => {
					t += 2000;
					return t;
				};
			})(),
			log: () => {},
		});
		expect(detector).not.toBeNull();
		const frame = { ok: true as const, output: "frozen frame" };
		await detector!.checkSession(makeSession({ status: "running" }), frame);
		await detector!.checkSession(makeSession({ status: "running" }), frame);
		expect(getSession).toHaveBeenCalledWith("exec-1");
		// stale running snapshot must NOT have escalated
		expect(store.appendLeadEvent).not.toHaveBeenCalled();
	});

	it("buildStuckRunnerDetector returns null when disabled", () => {
		const store = mockStore();
		const { registry } = mockRegistry();
		const detector = buildStuckRunnerDetector({
			store: store as never,
			projects: testProjects,
			runtimeRegistry: registry as never,
			notifier: { alert: vi.fn(async () => ({ sent: true })) },
			env: { FLYWHEEL_STUCK_DETECT: "0" } as NodeJS.ProcessEnv,
			log: () => {},
		});
		expect(detector).toBeNull();
		const enabled = buildStuckRunnerDetector({
			store: store as never,
			projects: testProjects,
			runtimeRegistry: registry as never,
			notifier: { alert: vi.fn(async () => ({ sent: true })) },
			env: {} as NodeJS.ProcessEnv,
			log: () => {},
		});
		expect(enabled).not.toBeNull();
	});
});

// ── Lead rules pin (Codex R2 LOW-R2-1: ladder constants must not drift) ──

describe("stuck-runner-remanage Lead rules pin", () => {
	const rulesPath = join(
		__dirname,
		"..",
		"..",
		"lead-rules-base",
		"stuck-runner-remanage.md",
	);
	const rules = readFileSync(rulesPath, "utf8");

	it("pins the bounded mailbox-wake wait (MAILBOX_WAKE_WAIT_MS = 60s)", () => {
		expect(rules).toContain("MAILBOX_WAKE_WAIT_MS");
		expect(rules).toMatch(/60[\s_]*seconds|60_000 ms/);
	});

	it("pins the nudge allowlist phrase and both endpoint paths", () => {
		expect(rules).toContain("`continue`");
		expect(rules).toContain("/recovery-nudge");
		expect(rules).toContain("/stuck-disposition");
	});

	it("pins the explicit disposition values and the FLY-175 boundary", () => {
		for (const d of [
			"false_positive",
			"legitimate_wait",
			"snooze",
			"needs_founder",
			"handled_remanaged",
		]) {
			expect(rules).toContain(d);
		}
		expect(rules).toContain("FLY-175");
	});

	it("pins the Q6 default cadence (ping on action, silent on false alarm)", () => {
		expect(rules).toMatch(/ping Annie once/i);
		expect(rules).toMatch(/stay silent/i);
	});

	it("claude-lead.sh loads the rules file for dept leads", () => {
		const sh = readFileSync(
			join(__dirname, "..", "..", "scripts", "claude-lead.sh"),
			"utf8",
		);
		expect(sh).toContain("stuck-runner-remanage.md");
	});
});

// ── FLY-253 L1: combined CommDB probe (REAL better-sqlite3 files —
// feedback_mock_tests_need_integration_complement: the SQL-clock-domain
// window comparison must be verified against a real database) ──

describe("probeCommSignalsFromCommDb (FLY-253, real sqlite)", () => {
	let dir: string;
	let oldHome: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly253-probe-"));
		oldHome = process.env.HOME;
		process.env.HOME = dir; // os.homedir() honors $HOME on POSIX
	});

	afterEach(() => {
		process.env.HOME = oldHome;
		rmSync(dir, { recursive: true, force: true });
	});

	function seedCommDb(project: string): CommDB {
		const dbPath = join(dir, ".flywheel", "comm", project, "comm.db");
		return new CommDB(dbPath);
	}

	it("missing comm.db ⇒ both signals false", () => {
		expect(probeCommSignalsFromCommDb("exec-1", "geo", 60_000)).toEqual({
			hasPendingGate: false,
			hasRecentOutbound: false,
		});
	});

	it("a just-sent message ⇒ hasRecentOutbound true; an answered question ⇒ no pending gate", () => {
		const db = seedCommDb("geo");
		const qid = db.insertQuestion("exec-1", "product-lead", "DONE: report");
		db.insertResponse(qid, "product-lead", "ok");
		db.close();
		expect(probeCommSignalsFromCommDb("exec-1", "geo", 60_000)).toEqual({
			hasPendingGate: false,
			hasRecentOutbound: true,
		});
	});

	it("an unanswered question ⇒ BOTH pending gate and recent outbound", () => {
		const db = seedCommDb("geo");
		db.insertQuestion("exec-1", "product-lead", "blocking?");
		db.close();
		expect(probeCommSignalsFromCommDb("exec-1", "geo", 60_000)).toEqual({
			hasPendingGate: true,
			hasRecentOutbound: true,
		});
	});

	it("window=0 short-circuits to hard false BEFORE the activity query (Codex R2 #5)", () => {
		const db = seedCommDb("geo");
		db.insertQuestion("exec-1", "product-lead", "DONE");
		db.close();
		const signals = probeCommSignalsFromCommDb("exec-1", "geo", 0);
		expect(signals.hasRecentOutbound).toBe(false);
	});

	it("path-traversal project names are rejected (both false)", () => {
		expect(probeCommSignalsFromCommDb("exec-1", "../geo", 60_000)).toEqual({
			hasPendingGate: false,
			hasRecentOutbound: false,
		});
	});

	it("other executions' messages do not count", () => {
		const db = seedCommDb("geo");
		db.insertQuestion("other-exec", "product-lead", "noise");
		db.close();
		expect(
			probeCommSignalsFromCommDb("exec-1", "geo", 60_000).hasRecentOutbound,
		).toBe(false);
	});
});

describe("probeQuietSignals isDoneButRunning (FLY-637 #1)", () => {
	let dir: string;
	let oldHome: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly637-probe-"));
		oldHome = process.env.HOME;
		process.env.HOME = dir; // no comm.db ⇒ comm signals default false / null
	});

	afterEach(() => {
		process.env.HOME = oldHome;
		rmSync(dir, { recursive: true, force: true });
	});

	const opts = { activityWindowMs: 60_000, nowMs: 1_000_000 };

	it("stage=completed + no route + no pr ⇒ isDoneButRunning true", () => {
		const signals = probeQuietSignals(
			{
				execution_id: "exec-1",
				project_name: "geo",
				status: "running",
				session_stage: "completed",
				decision_route: null,
				pr_number: null,
			},
			opts,
		);
		expect(signals.isDoneButRunning).toBe(true);
		// the comm side defaults false (no comm.db) — byte-compat passthrough
		expect(signals.status).toBe("running");
		expect(signals.hasPendingGate).toBe(false);
		expect(signals.hasRecentComm).toBe(false);
		expect(signals.declaredKind).toBe(null);
	});

	it("stage=completed but a PR exists ⇒ NOT done-but-running (dev session mid-ship)", () => {
		const signals = probeQuietSignals(
			{
				execution_id: "exec-1",
				project_name: "geo",
				status: "running",
				session_stage: "completed",
				decision_route: null,
				pr_number: 42,
			},
			opts,
		);
		expect(signals.isDoneButRunning).toBe(false);
	});

	it("stage=completed but a decision_route is set ⇒ NOT done-but-running", () => {
		const signals = probeQuietSignals(
			{
				execution_id: "exec-1",
				project_name: "geo",
				status: "running",
				session_stage: "completed",
				decision_route: "needs_review",
				pr_number: null,
			},
			opts,
		);
		expect(signals.isDoneButRunning).toBe(false);
	});

	it("an ordinary running session (no completed stage) ⇒ isDoneButRunning false (byte-compat)", () => {
		const signals = probeQuietSignals(
			{ execution_id: "exec-1", project_name: "geo", status: "running" },
			opts,
		);
		expect(signals.isDoneButRunning).toBe(false);
	});
});

/**
 * FLY-1048 PR-C (C4a + Codex code R1 #6): the factory's unified-ownership
 * guard — exact-fingerprint ownership OR a target-level CLEARING mute (a
 * tearing-down pane mints fresh fingerprints every frame, so the exact check
 * alone would let the old flow page about a corpse). FLY-1243:
 * FLYWHEEL_DETECTION_ESCALATION is retired — the guard is now always
 * consulted regardless of env.
 */
describe("buildStuckRunnerDetector — unified-flow guard wiring (FLY-1048 C4a/R1#6)", () => {
	function detectorWith(
		env: NodeJS.ProcessEnv,
		storeExtras: Record<string, unknown>,
	) {
		const store = mockStore();
		(store as Record<string, unknown>).getSession = vi.fn(() =>
			makeSession({ status: "running" }),
		);
		Object.assign(store, storeExtras);
		const { registry } = mockRegistry();
		const detector = buildStuckRunnerDetector({
			store: store as never,
			projects: testProjects,
			runtimeRegistry: registry as never,
			notifier: { alert: vi.fn(async () => ({ sent: true })) },
			env: { FLYWHEEL_STUCK_THRESHOLD_MS: "1000", ...env } as NodeJS.ProcessEnv,
			now: (() => {
				let t = 0;
				return () => {
					t += 2000;
					return t;
				};
			})(),
			log: () => {},
		});
		return { detector: detector!, store };
	}

	async function stagnateTwice(
		detector: NonNullable<ReturnType<typeof buildStuckRunnerDetector>>,
	) {
		const frame = { ok: true as const, output: "frozen frame" };
		await detector.checkSession(makeSession({ status: "running" }), frame);
		await detector.checkSession(makeSession({ status: "running" }), frame);
	}

	it("CLEARING target suppresses the old emit even for a NEW fingerprint", async () => {
		const { detector, store } = detectorWith(
			{ FLYWHEEL_DETECTION_ESCALATION: "1" },
			{
				hasActiveDetectionEscalationForEpisode: vi.fn(() => false),
				hasClearingDetectionEscalationForTarget: vi.fn(() => true),
			},
		);
		await stagnateTwice(detector);
		expect(store.appendLeadEvent).not.toHaveBeenCalled();
	});

	it("exact-episode ownership suppresses too", async () => {
		const { detector, store } = detectorWith(
			{ FLYWHEEL_DETECTION_ESCALATION: "1" },
			{
				hasActiveDetectionEscalationForEpisode: vi.fn(() => true),
				hasClearingDetectionEscalationForTarget: vi.fn(() => false),
			},
		);
		await stagnateTwice(detector);
		expect(store.appendLeadEvent).not.toHaveBeenCalled();
	});

	// FLY-1243: the `env.FLYWHEEL_DETECTION_ESCALATION === "1" &&` conjunct is
	// removed from unifiedOwnsEpisode's wiring — the guard is consulted
	// unconditionally now, so an empty/unset env no longer bypasses it.
	// Rewritten (was "env unset → guard never consulted, old emit fires") to
	// assert the opposite: with env EMPTY, the guard is still consulted and
	// still suppresses the old emit.
	it("guard is consulted regardless of env (FLY-1243: FLYWHEEL_DETECTION_ESCALATION retired)", async () => {
		const hasActive = vi.fn(() => true);
		const { detector, store } = detectorWith(
			{},
			{
				hasActiveDetectionEscalationForEpisode: hasActive,
				hasClearingDetectionEscalationForTarget: vi.fn(() => false),
			},
		);
		await stagnateTwice(detector);
		expect(hasActive).toHaveBeenCalled();
		expect(store.appendLeadEvent).not.toHaveBeenCalled();
	});
});
