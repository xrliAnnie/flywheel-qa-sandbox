import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AlertPayload } from "../LeadAlertNotifier.js";
import {
	computeEventId,
	isIdleHealthyPane,
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
