import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AlertPayload } from "../LeadAlertNotifier.js";
import {
	computeEventId,
	isIdleHealthyPane,
	isTransientThrottlePane,
	LeadWatchdog,
} from "../LeadWatchdog.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

const FIXTURES_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"fixtures",
	"lead-panes",
);
const loadFixture = (name: string): string =>
	readFileSync(join(FIXTURES_DIR, name), "utf-8");

const singleLeadProjects: ProjectEntry[] = [
	{
		projectName: "geoforge3d",
		projectRoot: "/tmp/geo",
		generalChannel: "core-1",
		leads: [
			{
				agentId: "cos-lead",
				forumChannel: "forum-1",
				chatChannel: "chat-1",
				match: { labels: ["cos"] },
				alertChannel: "alerts-1",
				alertBotTokenEnv: "SIMBA_BOT_TOKEN",
			},
		],
	},
];

const multiLeadProjects: ProjectEntry[] = [
	{
		...singleLeadProjects[0]!,
		leads: [
			...singleLeadProjects[0]!.leads,
			{
				agentId: "product-lead",
				forumChannel: "forum-2",
				chatChannel: "chat-2",
				match: { labels: ["Product"] },
				alertChannel: "alerts-1",
				alertBotTokenEnv: "PETER_BOT_TOKEN",
			},
		],
	},
];

const projects = singleLeadProjects;

interface NotifierStub {
	alert: ReturnType<typeof vi.fn>;
	results: AlertPayload[];
}

function makeNotifier(): NotifierStub {
	const results: AlertPayload[] = [];
	const alert = vi.fn(async (p: AlertPayload) => {
		results.push(p);
		return { sent: true };
	});
	return { alert, results };
}

describe("LeadWatchdog", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	it("stays in AwaitingFirstCapture when tmux window is not found yet", async () => {
		const notifier = makeNotifier();
		const wd = new LeadWatchdog({
			pollIntervalMs: 30_000,
			paneHashStuckCycles: 2,
			paneHashAlertCycles: 3,
			cooldownMs: 300_000,
			projects,
			store,
			notifier: notifier.alert,
			locateWindowFn: async () => null,
			captureFn: async () => {
				throw new Error("should not be called");
			},
			claimsReader: async () => new Set(),
			blockedMarkerReader: async () => [],
			now: () => 0,
		});
		await wd.pollOnce();
		expect(notifier.alert).not.toHaveBeenCalled();
		expect(wd.getState("cos-lead")).toBe("AwaitingFirstCapture");
	});

	it("transitions to Healthy on first successful capture", async () => {
		const notifier = makeNotifier();
		const wd = new LeadWatchdog({
			pollIntervalMs: 30_000,
			paneHashStuckCycles: 2,
			paneHashAlertCycles: 3,
			cooldownMs: 300_000,
			projects,
			store,
			notifier: notifier.alert,
			locateWindowFn: async () => ({
				windowId: "@7",
				windowName: "geoforge3d-cos-lead",
			}),
			captureFn: async () => "some pane content\ncursor: typing",
			claimsReader: async () => new Set(),
			blockedMarkerReader: async () => [],
			now: () => 0,
		});
		await wd.pollOnce();
		expect(wd.getState("cos-lead")).toBe("Healthy");
		expect(notifier.alert).not.toHaveBeenCalled();
	});

	it("Fix 1: pattern-first alert fires at paneHashStuckCycles (2 cycles), not paneHashAlertCycles (3)", async () => {
		const notifier = makeNotifier();
		const stuckContent =
			"rate limit: too many requests. try again at 14:30.\n> ";
		const wd = new LeadWatchdog({
			pollIntervalMs: 30_000,
			paneHashStuckCycles: 2,
			paneHashAlertCycles: 3,
			cooldownMs: 300_000,
			projects,
			store,
			notifier: notifier.alert,
			locateWindowFn: async () => ({
				windowId: "@7",
				windowName: "geoforge3d-cos-lead",
			}),
			captureFn: async () => stuckContent,
			claimsReader: async () => new Set(),
			blockedMarkerReader: async () => [],
			now: () => 1_700_000_000_000,
		});

		// t=0: first capture (baseline)
		await wd.pollOnce();
		expect(wd.getState("cos-lead")).toBe("Healthy");
		expect(notifier.alert).not.toHaveBeenCalled();

		// t=30s: second capture, pane unchanged + pattern matched → alert immediately
		await wd.pollOnce();
		expect(wd.getState("cos-lead")).toBe("Cooldown");
		expect(notifier.alert).toHaveBeenCalledTimes(1);
		const payload = notifier.results[0]!;
		expect(payload.leadId).toBe("cos-lead");
		expect(payload.eventType).toBe("rate_limit");
		// Fix 5: body contains actionable suggestion, not raw pane content.
		expect(payload.body).toContain("rate limit");
		expect(payload.body).not.toContain("14:30");
	});

	it("Fix 5: classifies usage_limit as a separate kind from rate_limit", async () => {
		const notifier = makeNotifier();
		const wd = new LeadWatchdog({
			pollIntervalMs: 30_000,
			paneHashStuckCycles: 2,
			paneHashAlertCycles: 3,
			cooldownMs: 300_000,
			projects,
			store,
			notifier: notifier.alert,
			locateWindowFn: async () => ({
				windowId: "@7",
				windowName: "geoforge3d-cos-lead",
			}),
			captureFn: async () => "claude code: usage limit exceeded.\n> ",
			claimsReader: async () => new Set(),
			blockedMarkerReader: async () => [],
			now: () => 1_700_000_000_000,
		});
		await wd.pollOnce();
		await wd.pollOnce();
		expect(notifier.alert).toHaveBeenCalledTimes(1);
		const p = notifier.results[0]!;
		expect(p.eventType).toBe("usage_limit");
		expect(p.body.toLowerCase()).toContain("billing");
	});

	it("falls back to pane_hash_stuck when unchanged pane has no blocked keywords", async () => {
		const notifier = makeNotifier();
		const wd = new LeadWatchdog({
			pollIntervalMs: 30_000,
			paneHashStuckCycles: 2,
			paneHashAlertCycles: 3,
			cooldownMs: 300_000,
			projects,
			store,
			notifier: notifier.alert,
			locateWindowFn: async () => ({
				windowId: "@7",
				windowName: "geoforge3d-cos-lead",
			}),
			captureFn: async () => "idle working...",
			claimsReader: async () => new Set(),
			blockedMarkerReader: async () => [],
			now: () => 0,
		});
		await wd.pollOnce();
		await wd.pollOnce();
		// Without a recognized pattern, stays in Suspicious until cycle 3.
		expect(wd.getState("cos-lead")).toBe("Suspicious");
		expect(notifier.alert).not.toHaveBeenCalled();
		await wd.pollOnce();
		expect(notifier.alert).toHaveBeenCalledTimes(1);
		expect(notifier.results[0]!.eventType).toBe("pane_hash_stuck");
	});

	it("FLY-182 B3: suppressIdleHealthy=true → does NOT alert on an idle-ready pane", async () => {
		const notifier = makeNotifier();
		const wd = new LeadWatchdog({
			pollIntervalMs: 30_000,
			paneHashStuckCycles: 2,
			paneHashAlertCycles: 3,
			cooldownMs: 300_000,
			projects,
			store,
			notifier: notifier.alert,
			locateWindowFn: async () => ({
				windowId: "@7",
				windowName: "geoforge3d-cos-lead",
			}),
			captureFn: async () =>
				'│ > Try "edit <file>"                    │\n? for shortcuts',
			claimsReader: async () => new Set(),
			blockedMarkerReader: async () => [],
			now: () => 0,
			suppressIdleHealthy: true,
		});
		await wd.pollOnce();
		await wd.pollOnce();
		await wd.pollOnce();
		await wd.pollOnce();
		// Idle-but-alive pane: never escalated to pane_hash_stuck.
		expect(notifier.alert).not.toHaveBeenCalled();
		expect(wd.getState("cos-lead")).toBe("Healthy");
	});

	it("FLY-182 B3: suppressIdleHealthy=true → STILL alerts on a frozen WORKING pane", async () => {
		const notifier = makeNotifier();
		const wd = new LeadWatchdog({
			pollIntervalMs: 30_000,
			paneHashStuckCycles: 2,
			paneHashAlertCycles: 3,
			cooldownMs: 300_000,
			projects,
			store,
			notifier: notifier.alert,
			locateWindowFn: async () => ({
				windowId: "@7",
				windowName: "geoforge3d-cos-lead",
			}),
			// Frozen mid-operation (spinner / esc to interrupt) → a REAL stuck.
			captureFn: async () => "Thinking… (esc to interrupt)",
			claimsReader: async () => new Set(),
			blockedMarkerReader: async () => [],
			now: () => 0,
			suppressIdleHealthy: true,
		});
		await wd.pollOnce();
		await wd.pollOnce();
		await wd.pollOnce();
		expect(notifier.alert).toHaveBeenCalledTimes(1);
		expect(notifier.results[0]!.eventType).toBe("pane_hash_stuck");
	});

	it("FLY-182 B3: suppressIdleHealthy=false (default) → alerts on idle pane (unchanged behavior)", async () => {
		const notifier = makeNotifier();
		const wd = new LeadWatchdog({
			pollIntervalMs: 30_000,
			paneHashStuckCycles: 2,
			paneHashAlertCycles: 3,
			cooldownMs: 300_000,
			projects,
			store,
			notifier: notifier.alert,
			locateWindowFn: async () => ({
				windowId: "@7",
				windowName: "geoforge3d-cos-lead",
			}),
			captureFn: async () => "? for shortcuts",
			claimsReader: async () => new Set(),
			blockedMarkerReader: async () => [],
			now: () => 0,
			// suppressIdleHealthy omitted → default OFF.
		});
		await wd.pollOnce();
		await wd.pollOnce();
		await wd.pollOnce();
		expect(notifier.alert).toHaveBeenCalledTimes(1);
	});

	it("resets stuck counter and stays Healthy when pane changes", async () => {
		const notifier = makeNotifier();
		let tick = 0;
		const captures = ["first", "first", "second", "third"];
		const wd = new LeadWatchdog({
			pollIntervalMs: 30_000,
			paneHashStuckCycles: 2,
			paneHashAlertCycles: 3,
			cooldownMs: 300_000,
			projects,
			store,
			notifier: notifier.alert,
			locateWindowFn: async () => ({
				windowId: "@7",
				windowName: "geoforge3d-cos-lead",
			}),
			captureFn: async () => captures[tick++]!,
			claimsReader: async () => new Set(),
			blockedMarkerReader: async () => [],
			now: () => 0,
		});
		await wd.pollOnce();
		await wd.pollOnce();
		expect(wd.getState("cos-lead")).toBe("Suspicious");
		await wd.pollOnce();
		expect(wd.getState("cos-lead")).toBe("Healthy");
		await wd.pollOnce();
		expect(wd.getState("cos-lead")).toBe("Healthy");
		expect(notifier.alert).not.toHaveBeenCalled();
	});

	it("early-exits to Silent when a blocked marker file is present", async () => {
		const notifier = makeNotifier();
		const wd = new LeadWatchdog({
			pollIntervalMs: 30_000,
			paneHashStuckCycles: 2,
			paneHashAlertCycles: 3,
			cooldownMs: 300_000,
			projects,
			store,
			notifier: notifier.alert,
			locateWindowFn: async () => ({
				windowId: "@7",
				windowName: "geoforge3d-cos-lead",
			}),
			captureFn: async () => "anything",
			claimsReader: async () => new Set(),
			blockedMarkerReader: async (leadId) =>
				leadId === "cos-lead" ? ["permission_blocked"] : [],
			now: () => 0,
		});
		await wd.pollOnce();
		expect(wd.getState("cos-lead")).toBe("Silent");
		expect(notifier.alert).not.toHaveBeenCalled();
	});

	it("goes to Silent when shell already claimed the current eventId", async () => {
		const notifier = makeNotifier();
		const stuckContent = "permission required to write file /tmp/x\n> ";
		const wd = new LeadWatchdog({
			pollIntervalMs: 30_000,
			paneHashStuckCycles: 2,
			paneHashAlertCycles: 3,
			cooldownMs: 300_000,
			projects,
			store,
			notifier: notifier.alert,
			locateWindowFn: async () => ({
				windowId: "@7",
				windowName: "geoforge3d-cos-lead",
			}),
			captureFn: async () => stuckContent,
			claimsReader: async () => new Set(["__any__"]),
			blockedMarkerReader: async () => [],
			now: () => 1_700_000_000_000,
			claimsReaderMatchAll: true,
		});
		// Pattern-first triggers attempt to alert at cycle 2; the wildcard
		// claimsReader rebuffs it.
		await wd.pollOnce();
		await wd.pollOnce();
		expect(wd.getState("cos-lead")).toBe("Silent");
		expect(notifier.alert).not.toHaveBeenCalled();
	});

	it("Fix 4: Cooldown immediately drops to Healthy when pane content changes", async () => {
		const notifier = makeNotifier();
		let tick = 0;
		// poll 1: baseline | poll 2: alert | poll 3: changed → Healthy | poll 4: stay Healthy
		const captures = [
			"rate limit reached, please try again.\n> ",
			"rate limit reached, please try again.\n> ",
			"working on issue FLY-83 step 1...\n> ", // pane recovered
			"working on issue FLY-83 step 1...\n> ",
		];
		let nowMs = 1_700_000_000_000;
		const wd = new LeadWatchdog({
			pollIntervalMs: 30_000,
			paneHashStuckCycles: 2,
			paneHashAlertCycles: 3,
			cooldownMs: 300_000,
			projects,
			store,
			notifier: notifier.alert,
			locateWindowFn: async () => ({
				windowId: "@7",
				windowName: "geoforge3d-cos-lead",
			}),
			captureFn: async () => captures[tick++]!,
			claimsReader: async () => new Set(),
			blockedMarkerReader: async () => [],
			now: () => nowMs,
		});
		await wd.pollOnce();
		await wd.pollOnce();
		expect(wd.getState("cos-lead")).toBe("Cooldown");
		expect(notifier.alert).toHaveBeenCalledTimes(1);

		// Pane changes — Cooldown drops to Healthy WELL BEFORE cooldownMs
		// elapses. (Old behavior would have stayed Cooldown until 5min.)
		nowMs += 30_000;
		await wd.pollOnce();
		expect(wd.getState("cos-lead")).toBe("Healthy");

		// Pane stays new (non-pattern) content — accumulates a stuckCycle but
		// does NOT fire a new alert (no recognizable pattern + only at 2/3
		// cycles → Suspicious, not Cooldown).
		nowMs += 30_000;
		await wd.pollOnce();
		expect(wd.getState("cos-lead")).toBe("Suspicious");
		expect(notifier.alert).toHaveBeenCalledTimes(1);
	});

	it("Fix 4: re-alerts when a NEW stuck pattern appears after recovery", async () => {
		const notifier = makeNotifier();
		let tick = 0;
		const captures = [
			"rate limit reached.\n> ", // baseline
			"rate limit reached.\n> ", // fires rate_limit alert
			"working on FLY-83...\n> ", // recovered
			"login expired, please re-auth.\n> ", // new stuck
			"login expired, please re-auth.\n> ", // fires login_expired alert
		];
		const wd = new LeadWatchdog({
			pollIntervalMs: 30_000,
			paneHashStuckCycles: 2,
			paneHashAlertCycles: 3,
			cooldownMs: 300_000,
			projects,
			store,
			notifier: notifier.alert,
			locateWindowFn: async () => ({
				windowId: "@7",
				windowName: "geoforge3d-cos-lead",
			}),
			captureFn: async () => captures[tick++]!,
			claimsReader: async () => new Set(),
			blockedMarkerReader: async () => [],
			now: () => 1_700_000_000_000,
		});
		for (let i = 0; i < captures.length; i++) {
			await wd.pollOnce();
		}
		expect(notifier.alert).toHaveBeenCalledTimes(2);
		expect(notifier.results[0]!.eventType).toBe("rate_limit");
		expect(notifier.results[1]!.eventType).toBe("login_expired");
		// Fix 3: different signature → different eventId.
		expect(notifier.results[0]!.eventId).not.toBe(notifier.results[1]!.eventId);
	});

	it("Fix 3: eventId stays stable across Bridge restarts on the SAME stuck pane", async () => {
		const stuckContent = "rate limit reached.\n> ";
		const projectName = "geoforge3d";
		const leadId = "cos-lead";

		// Run watchdog #1 and capture the eventId it would alert with.
		const notifier1 = makeNotifier();
		const wd1 = new LeadWatchdog({
			pollIntervalMs: 30_000,
			paneHashStuckCycles: 2,
			paneHashAlertCycles: 3,
			cooldownMs: 300_000,
			projects,
			store,
			notifier: notifier1.alert,
			locateWindowFn: async () => ({
				windowId: "@7",
				windowName: `${projectName}-${leadId}`,
			}),
			captureFn: async () => stuckContent,
			claimsReader: async () => new Set(),
			blockedMarkerReader: async () => [],
			now: () => 1_700_000_000_000,
		});
		await wd1.pollOnce();
		await wd1.pollOnce();
		expect(notifier1.alert).toHaveBeenCalledTimes(1);
		const eventIdFirstRun = notifier1.results[0]!.eventId;

		// Simulate restart: fresh watchdog, fresh state, same pane.
		// (Use a NEW StateStore so the same-process dedup doesn't mask Fix 3.)
		const store2 = await StateStore.create(":memory:");
		const notifier2 = makeNotifier();
		const wd2 = new LeadWatchdog({
			pollIntervalMs: 30_000,
			paneHashStuckCycles: 2,
			paneHashAlertCycles: 3,
			cooldownMs: 300_000,
			projects,
			store: store2,
			notifier: notifier2.alert,
			locateWindowFn: async () => ({
				windowId: "@7",
				windowName: `${projectName}-${leadId}`,
			}),
			captureFn: async () => stuckContent,
			claimsReader: async () => new Set(),
			blockedMarkerReader: async () => [],
			// Different "now" (different 10-min bucket under old formula).
			now: () => 1_700_000_000_000 + 11 * 60 * 1000,
		});
		await wd2.pollOnce();
		await wd2.pollOnce();
		expect(notifier2.alert).toHaveBeenCalledTimes(1);
		const eventIdSecondRun = notifier2.results[0]!.eventId;

		// Same pane signature → same eventId, even across the bucket boundary.
		expect(eventIdSecondRun).toBe(eventIdFirstRun);
	});

	it("Fix 3: computeEventId is signature-bound, not bucket-bound", () => {
		const a = computeEventId("geoforge3d", "cos-lead", "rate_limit", "sigA");
		const b = computeEventId("geoforge3d", "cos-lead", "rate_limit", "sigA");
		const c = computeEventId("geoforge3d", "cos-lead", "rate_limit", "sigB");
		expect(a).toBe(b);
		expect(a).not.toBe(c);
		// Different project → different id.
		const d = computeEventId("flywheel", "cos-lead", "rate_limit", "sigA");
		expect(a).not.toBe(d);
	});

	it("tracks multiple leads independently", async () => {
		const notifier = makeNotifier();
		const wd = new LeadWatchdog({
			pollIntervalMs: 30_000,
			paneHashStuckCycles: 2,
			paneHashAlertCycles: 3,
			cooldownMs: 300_000,
			projects: multiLeadProjects,
			store,
			notifier: notifier.alert,
			locateWindowFn: async (_p, lead) =>
				lead === "cos-lead"
					? { windowId: "@7", windowName: "geoforge3d-cos-lead" }
					: null,
			captureFn: async () => "fresh",
			claimsReader: async () => new Set(),
			blockedMarkerReader: async () => [],
			now: () => 0,
		});
		await wd.pollOnce();
		expect(wd.getState("cos-lead")).toBe("Healthy");
		expect(wd.getState("product-lead")).toBe("AwaitingFirstCapture");
	});

	it("start/stop wires up and tears down the poll timer", async () => {
		vi.useFakeTimers();
		try {
			const notifier = makeNotifier();
			const locateWindowFn = vi.fn(async () => null);
			const wd = new LeadWatchdog({
				pollIntervalMs: 30_000,
				paneHashStuckCycles: 2,
				paneHashAlertCycles: 3,
				cooldownMs: 300_000,
				projects,
				store,
				notifier: notifier.alert,
				locateWindowFn,
				captureFn: async () => "",
				claimsReader: async () => new Set(),
				blockedMarkerReader: async () => [],
				now: () => 0,
			});
			wd.start();
			await vi.advanceTimersByTimeAsync(30_000);
			expect(locateWindowFn).toHaveBeenCalled();
			wd.stop();
			const calls = locateWindowFn.mock.calls.length;
			await vi.advanceTimersByTimeAsync(120_000);
			expect(locateWindowFn.mock.calls.length).toBe(calls);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("isIdleHealthyPane (FLY-182 B3 recognizer)", () => {
	it("returns true for a high-confidence idle-ready pane", () => {
		expect(isIdleHealthyPane("│ > │\n? for shortcuts")).toBe(true);
		expect(isIdleHealthyPane('Try "fix the bug"\nshift+tab to cycle')).toBe(
			true,
		);
	});

	it("returns false when actively working (must not suppress a real freeze)", () => {
		expect(
			isIdleHealthyPane("Thinking… (esc to interrupt)\n? for shortcuts"),
		).toBe(false);
		expect(isIdleHealthyPane("Working… 1234 tokens used")).toBe(false);
	});

	it("returns false for blocked patterns (let them alert as classified)", () => {
		expect(isIdleHealthyPane("usage limit reached\n? for shortcuts")).toBe(
			false,
		);
		expect(isIdleHealthyPane("rate-limit hit\n? for shortcuts")).toBe(false);
	});

	it("returns false on uncertainty (no idle marker) — fail-open to alerting", () => {
		expect(isIdleHealthyPane("")).toBe(false);
		expect(isIdleHealthyPane("some random frozen output")).toBe(false);
	});
});

describe("isIdleHealthyPane — real Lead pane fixtures (FLY-193)", () => {
	// must-SUPPRESS: real captures of healthy, idle Leads (2026-06-02, the
	// production GeoForge3D cos/ops/product Leads). `idle-product-lead-ctx100.txt`
	// is the ctx-100% idle pane from the production incident — proof that a full
	// context window does NOT by itself defeat the recognizer (the leak was stale
	// scrollback, not the `ctx 100%` line).
	it.each([
		["idle-cos-lead.txt"],
		["idle-ops-lead.txt"],
		["idle-product-lead.txt"],
		["idle-product-lead-ctx100.txt"],
	])("suppresses a real healthy-idle Lead pane: %s", (fixture) => {
		expect(isIdleHealthyPane(loadFixture(fixture))).toBe(true);
	});

	// must-NOT-SUPPRESS: genuine freezes / stuck operations. The resume menu is
	// the exact text from the documented production freeze ("Resume from
	// summary?"); the compact PROMPT is the context-limit gate ("esc to cancel");
	// `freeze-compacting.txt` is a real auto-compact in progress (a frozen one is
	// a genuine stuck operation). Suppressing any would HIDE a real problem.
	it.each([
		["freeze-resume-menu.txt"],
		["freeze-compact-prompt.txt"],
		["freeze-compacting.txt"],
	])(
		"does NOT suppress a real freeze / stuck op — still alerts: %s",
		(fixture) => {
			expect(isIdleHealthyPane(loadFixture(fixture))).toBe(false);
		},
	);

	it("ignores STALE working-markers in scrollback — only the live region counts", () => {
		const pane = loadFixture("idle-product-lead.txt");
		// Guard: the fixture genuinely contains the whole-page-scan trap (stale
		// "working"/"thinking"/"tokens used" chatter in history above the box).
		// If a future re-capture loses it, this assertion flags that the fixture
		// no longer exercises the regression.
		expect(/\bworking\b|\bthinking\b|tokens?\b.*\bused\b/i.test(pane)).toBe(
			true,
		);
		// …yet the live render region is a clean idle prompt → suppressed.
		expect(isIdleHealthyPane(pane)).toBe(true);
	});
});

describe("LeadWatchdog — suppression wired through tickLead on real fixtures (FLY-193)", () => {
	let store: StateStore;
	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	const makeWatchdog = (fixture: string, notifier: NotifierStub) =>
		new LeadWatchdog({
			pollIntervalMs: 30_000,
			paneHashStuckCycles: 2,
			paneHashAlertCycles: 3,
			cooldownMs: 300_000,
			projects,
			store,
			notifier: notifier.alert,
			locateWindowFn: async () => ({
				windowId: "@7",
				windowName: "geoforge3d-cos-lead",
			}),
			captureFn: async () => loadFixture(fixture),
			claimsReader: async () => new Set(),
			blockedMarkerReader: async () => [],
			now: () => 0,
			suppressIdleHealthy: true,
		});

	it("does NOT alert across many cycles on a real idle Lead pane", async () => {
		const notifier = makeNotifier();
		const wd = makeWatchdog("idle-product-lead.txt", notifier);
		for (let i = 0; i < 5; i++) await wd.pollOnce();
		expect(notifier.alert).not.toHaveBeenCalled();
		expect(wd.getState("cos-lead")).toBe("Healthy");
	});

	it("STILL alerts on a real resume-menu freeze even with suppression ON", async () => {
		const notifier = makeNotifier();
		const wd = makeWatchdog("freeze-resume-menu.txt", notifier);
		await wd.pollOnce();
		await wd.pollOnce();
		await wd.pollOnce();
		expect(notifier.alert).toHaveBeenCalledTimes(1);
		expect(notifier.results[0]!.eventType).toBe("pane_hash_stuck");
	});
});

describe("isTransientThrottlePane (FLY-218 recognizer)", () => {
	// A live 529 always renders inside the normal TUI, so the status bar (the
	// live-TUI anchor the recognizer requires) is present. These minimal panes
	// append one to stay realistic.
	const STATUS_BAR =
		"\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · ctx 31%";

	it("returns true for the exact production transient-529 wording", () => {
		expect(
			isTransientThrottlePane(
				`Server is temporarily limiting requests (not your usage limit)${STATUS_BAR}`,
			),
		).toBe(true);
	});

	it("returns true on the disclaimer alone (the substring that defeats usage_limit)", () => {
		expect(isTransientThrottlePane(`not your usage limit${STATUS_BAR}`)).toBe(
			true,
		);
	});

	it("returns true for the overloaded_error API error type", () => {
		expect(
			isTransientThrottlePane(
				`API Error: 529 {"type":"overloaded_error"}${STATUS_BAR}`,
			),
		).toBe(true);
	});

	it("returns FALSE for a real usage cap (must still alert)", () => {
		expect(isTransientThrottlePane(`usage limit reached${STATUS_BAR}`)).toBe(
			false,
		);
		expect(
			isTransientThrottlePane(
				`claude code: usage limit exceeded.${STATUS_BAR}`,
			),
		).toBe(false);
	});

	it("returns FALSE without a live-TUI anchor (fail-open to alerting)", () => {
		// A bare throttle line with no status bar / idle hint — e.g. it shares a
		// menu-overlay region — is NOT suppressed (Codex R1 masking guard b).
		expect(
			isTransientThrottlePane(
				"Server is temporarily limiting requests (not your usage limit)\n❯ ",
			),
		).toBe(false);
	});

	it("returns FALSE on empty / idle / unrelated panes", () => {
		expect(isTransientThrottlePane("")).toBe(false);
		expect(isTransientThrottlePane('Try "fix the bug"\n? for shortcuts')).toBe(
			false,
		);
		expect(isTransientThrottlePane("some random frozen output")).toBe(false);
	});

	it("is live-region scoped — a STALE 529 line in scrollback does NOT suppress", () => {
		// The throttle happened earlier and is now far up in scrollback; the live
		// render region at the bottom is a clean idle prompt. Recognizing the stale
		// line would wrongly suppress a later real freeze, so it must return false.
		const pane = loadFixture("throttle-529-stale-scrollback.txt");
		// Guard: the fixture really does carry the stale throttle text up top.
		expect(/not your usage limit/i.test(pane)).toBe(true);
		expect(isTransientThrottlePane(pane)).toBe(false);
	});
});

describe("isTransientThrottlePane — real-frame fixtures (FLY-218)", () => {
	it("suppresses a live transient-529 throttle pane", () => {
		expect(isTransientThrottlePane(loadFixture("throttle-529-live.txt"))).toBe(
			true,
		);
	});

	it("does NOT suppress a genuine usage-limit pane", () => {
		expect(isTransientThrottlePane(loadFixture("usage-limit-real.txt"))).toBe(
			false,
		);
	});

	// Codex R1 HIGH: a stale throttle line must not mask a NEWER must-alert state
	// that shares its live region.
	it("does NOT suppress when a real usage cap shares the live region (masking guard a)", () => {
		expect(
			isTransientThrottlePane(loadFixture("throttle-529-then-usage-cap.txt")),
		).toBe(false);
	});

	it("does NOT suppress when a frozen resume menu shares the live region (masking guard b)", () => {
		expect(
			isTransientThrottlePane(loadFixture("throttle-529-then-resume-menu.txt")),
		).toBe(false);
	});

	it("does NOT suppress when a frozen auto-compact shares the live region (masking guard c)", () => {
		const pane = loadFixture("throttle-529-then-compacting.txt");
		expect(isTransientThrottlePane(pane)).toBe(false);
		// Non-vacuous: the throttle line IS inside the live region — drop only the
		// compacting marker and the SAME pane would suppress, proving the veto (not
		// an out-of-region throttle) is what flips this case.
		const withoutCompact = pane.replace(/✳ Compacting conversation[^\n]*/i, "");
		expect(isTransientThrottlePane(withoutCompact)).toBe(true);
	});

	// Codex R3: distinguish a live 529 retry from a frozen normal turn that
	// merely has a stale throttle line above it.
	it("suppresses a SETTLED 529 error (no esc-to-interrupt, no retry hint)", () => {
		expect(
			isTransientThrottlePane(loadFixture("throttle-529-settled.txt")),
		).toBe(true);
	});

	it("does NOT suppress a frozen normal turn (esc-to-interrupt, NO retry hint) above a stale 529 (masking guard d)", () => {
		const pane = loadFixture("throttle-529-then-frozen-work.txt");
		expect(isTransientThrottlePane(pane)).toBe(false);
		// Non-vacuous: add a retry hint to the in-flight line and the SAME pane
		// suppresses — proving the throttle is in-region and the retry-evidence
		// gate (not an out-of-region throttle) is what flips this case.
		const asLiveRetry = pane.replace(
			/✻ Cooking… \(esc to interrupt\)/i,
			"✻ Cooking… (esc to interrupt · retrying)",
		);
		expect(isTransientThrottlePane(asLiveRetry)).toBe(true);
	});
});

describe("LeadWatchdog — FLY-218 transient-529 suppression wired through tickLead", () => {
	let store: StateStore;
	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	const makeWatchdog = (
		fixture: string,
		notifier: NotifierStub,
		suppressIdleHealthy = false,
	) =>
		new LeadWatchdog({
			pollIntervalMs: 30_000,
			paneHashStuckCycles: 2,
			paneHashAlertCycles: 3,
			cooldownMs: 300_000,
			projects,
			store,
			notifier: notifier.alert,
			locateWindowFn: async () => ({
				windowId: "@7",
				windowName: "geoforge3d-cos-lead",
			}),
			captureFn: async () => loadFixture(fixture),
			claimsReader: async () => new Set(),
			blockedMarkerReader: async () => [],
			now: () => 0,
			suppressIdleHealthy,
		});

	it("PRODUCTION REPLAY: a live transient-529 throttle fires ZERO alerts across many cycles", async () => {
		// The core bug: classify() matched "usage limit" inside "not your usage
		// limit" → usage_limit "Top up billing" false alert; and even un-matched it
		// would fall through to pane_hash_stuck. The transient recognizer must
		// short-circuit BOTH — regardless of suppressIdleHealthy.
		const notifier = makeNotifier();
		const wd = makeWatchdog("throttle-529-live.txt", notifier, false);
		for (let i = 0; i < 6; i++) await wd.pollOnce();
		expect(notifier.alert).not.toHaveBeenCalled();
		expect(wd.getState("cos-lead")).toBe("Healthy");
	});

	it("a genuine usage-limit pane STILL alerts exactly once (usage_limit)", async () => {
		const notifier = makeNotifier();
		const wd = makeWatchdog("usage-limit-real.txt", notifier, false);
		await wd.pollOnce();
		await wd.pollOnce();
		expect(notifier.alert).toHaveBeenCalledTimes(1);
		expect(notifier.results[0]!.eventType).toBe("usage_limit");
	});

	it("regex tightening: a STALE scrollback 529 never classifies as usage_limit", async () => {
		// classify() scans the WHOLE pane, so a stale "not your usage limit" line in
		// scrollback would trip the old loose regex → false usage_limit. With the
		// tightened regex it classifies as pane_hash_stuck instead (and would be
		// idle-suppressed in prod). Run with suppression OFF so any alert surfaces:
		// the only assertion that matters is it is NOT usage_limit.
		const notifier = makeNotifier();
		const wd = makeWatchdog(
			"throttle-529-stale-scrollback.txt",
			notifier,
			false,
		);
		for (let i = 0; i < 4; i++) await wd.pollOnce();
		for (const p of notifier.results) {
			expect(p.eventType).not.toBe("usage_limit");
		}
	});

	// Codex R1 HIGH: the masking scenarios Codex reproduced — a stale throttle
	// line in the same live region as a NEWER must-alert state must NOT be
	// suppressed (the real state still alerts).
	it("MASKING GUARD a: a real cap right below a stale 529 STILL alerts usage_limit", async () => {
		const notifier = makeNotifier();
		const wd = makeWatchdog("throttle-529-then-usage-cap.txt", notifier, true);
		await wd.pollOnce();
		await wd.pollOnce();
		expect(notifier.alert).toHaveBeenCalledTimes(1);
		expect(notifier.results[0]!.eventType).toBe("usage_limit");
	});

	it("MASKING GUARD b: a frozen resume menu above a stale 529 STILL alerts pane_hash_stuck", async () => {
		// suppressIdleHealthy ON (production default) — the menu has no idle anchor,
		// so it is neither throttle-suppressed nor idle-suppressed → it must alert.
		const notifier = makeNotifier();
		const wd = makeWatchdog(
			"throttle-529-then-resume-menu.txt",
			notifier,
			true,
		);
		await wd.pollOnce();
		await wd.pollOnce();
		await wd.pollOnce();
		expect(notifier.alert).toHaveBeenCalledTimes(1);
		expect(notifier.results[0]!.eventType).toBe("pane_hash_stuck");
	});

	it("MASKING GUARD c: a frozen auto-compact above a stale 529 STILL alerts pane_hash_stuck", async () => {
		// "Compacting conversation" is a FLY-193 must-alert and never a 529 retry,
		// so the throttle suppression is vetoed and the freeze still escalates.
		const notifier = makeNotifier();
		const wd = makeWatchdog("throttle-529-then-compacting.txt", notifier, true);
		await wd.pollOnce();
		await wd.pollOnce();
		await wd.pollOnce();
		expect(notifier.alert).toHaveBeenCalledTimes(1);
		expect(notifier.results[0]!.eventType).toBe("pane_hash_stuck");
	});

	it("MASKING GUARD d: a frozen normal turn (no retry hint) above a stale 529 STILL alerts pane_hash_stuck", async () => {
		const notifier = makeNotifier();
		const wd = makeWatchdog(
			"throttle-529-then-frozen-work.txt",
			notifier,
			true,
		);
		await wd.pollOnce();
		await wd.pollOnce();
		await wd.pollOnce();
		expect(notifier.alert).toHaveBeenCalledTimes(1);
		expect(notifier.results[0]!.eventType).toBe("pane_hash_stuck");
	});
});
