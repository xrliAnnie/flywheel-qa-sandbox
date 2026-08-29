/**
 * FLY-1048 Task A4: LeadWatchdog multi-frame overlay (FLYWHEEL_PANE_MULTIFRAME).
 *
 * New fixtures (SYNTHETIC, shaped after the committed real captures — follow-up:
 * swap for real captures when the incidents recur, FLY-218 precedent):
 *  - error-stalled-lead.txt: FN2-lead — "Server error mid-response" frozen above
 *    an EMPTY idle input box. Today isIdleHealthyPane suppresses it forever.
 *  - frozen-extended-thinking.txt: the documented FLY-193 blind spot — a frozen
 *    `(11m 3s · almost done thinking)` spinner with NO interrupt hint. Today
 *    silently suppressed; multi-frame turns it into a quiet suspicious report.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SuspiciousReport } from "../bridge/detection-suspicious.js";
import type { AlertPayload } from "../LeadAlertNotifier.js";
import { LeadWatchdog, type LeadWatchdogConfig } from "../LeadWatchdog.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

const FIXTURES_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"fixtures",
	"lead-panes",
);
const loadFixture = (name: string): string =>
	readFileSync(join(FIXTURES_DIR, name), "utf-8");

const projects: ProjectEntry[] = [
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
				alertBotTokenEnv: "TEST_COS_BOT_TOKEN",
			},
		],
	},
];

interface Harness {
	wd: LeadWatchdog;
	alerts: AlertPayload[];
	suspicious: SuspiciousReport[];
	tick: (pane: string) => Promise<void>;
}

let store: StateStore;

beforeEach(async () => {
	store = await StateStore.create(":memory:");
});

function makeHarness(over: Partial<LeadWatchdogConfig> = {}): Harness {
	const alerts: AlertPayload[] = [];
	const suspicious: SuspiciousReport[] = [];
	let pane = "";
	let now = 1_700_000_000_000;
	const wd = new LeadWatchdog({
		pollIntervalMs: 30_000,
		paneHashStuckCycles: 2,
		paneHashAlertCycles: 3,
		cooldownMs: 300_000,
		projects,
		store,
		notifier: vi.fn(async (p: AlertPayload) => {
			alerts.push(p);
			return { sent: true };
		}),
		locateWindowFn: async () => ({
			windowId: "@7",
			windowName: "geoforge3d-cos-lead",
		}),
		captureFn: async () => pane,
		claimsReader: async () => new Set(),
		blockedMarkerReader: async () => [],
		now: () => now,
		suppressIdleHealthy: true,
		multiFrame: true,
		onSuspicious: (r) => {
			suspicious.push(r);
		},
		...over,
	});
	return {
		wd,
		alerts,
		suspicious,
		tick: async (p: string) => {
			pane = p;
			await wd.pollOnce();
			now += 30_000;
		},
	};
}

describe("A4 veto 1: error signature frozen in an idle-looking pane → pane_error_stalled", () => {
	it("FN2-lead: alerts pane_error_stalled with multiFrame ON (today: suppressed)", async () => {
		const pane = loadFixture("error-stalled-lead.txt");
		const h = makeHarness();
		await h.tick(pane);
		await h.tick(pane);
		await h.tick(pane);
		expect(h.alerts.length).toBe(1);
		expect(h.alerts[0]!.eventType).toBe("pane_error_stalled");
		// Echo immunity: the alert body must never echo the matched pane line.
		expect(h.alerts[0]!.body).not.toContain("Server error mid-response");
	});

	it("emits ONCE per frozen episode (cooldown holds while the pane is static)", async () => {
		const pane = loadFixture("error-stalled-lead.txt");
		const h = makeHarness();
		for (let i = 0; i < 6; i++) await h.tick(pane);
		expect(h.alerts.length).toBe(1);
	});

	it("multiFrame OFF keeps today's suppression byte-for-byte", async () => {
		const pane = loadFixture("error-stalled-lead.txt");
		const h = makeHarness({ multiFrame: false });
		for (let i = 0; i < 5; i++) await h.tick(pane);
		expect(h.alerts.length).toBe(0);
		expect(h.suspicious.length).toBe(0);
	});
});

describe("A4 veto 2: frozen extended-thinking silence → fail-suspicious (never silent)", () => {
	it("static thinking-residue pane fires ONE suspicious report, no alert", async () => {
		const pane = loadFixture("frozen-extended-thinking.txt");
		const h = makeHarness();
		for (let i = 0; i < 5; i++) await h.tick(pane);
		expect(h.alerts.length).toBe(0);
		expect(h.suspicious.length).toBe(1);
		expect(h.suspicious[0]!.targetKind).toBe("lead");
		expect(h.suspicious[0]!.targetKey).toBe("geoforge3d:cos-lead");
		expect(h.suspicious[0]!.reason).toBeTruthy();
		expect(h.suspicious[0]!.paneTail.length).toBeGreaterThan(0);
	});

	it("multiFrame OFF: stays fully silent (the documented FLY-193 blind spot)", async () => {
		const pane = loadFixture("frozen-extended-thinking.txt");
		const h = makeHarness({ multiFrame: false });
		for (let i = 0; i < 5; i++) await h.tick(pane);
		expect(h.alerts.length).toBe(0);
		expect(h.suspicious.length).toBe(0);
	});
});

describe("A4 sentinels: existing suppress/alert behavior survives multiFrame ON", () => {
	const mustSuppress = [
		"idle-cos-lead.txt",
		"idle-ops-lead.txt",
		"idle-product-lead.txt",
		"idle-product-lead-ctx100.txt",
	];
	for (const fixture of mustSuppress) {
		it(`must-suppress fixture ${fixture} stays silent in BOTH env states`, async () => {
			for (const multiFrame of [true, false]) {
				const h = makeHarness({ multiFrame });
				for (let i = 0; i < 5; i++) await h.tick(loadFixture(fixture));
				expect(h.alerts.length).toBe(0);
				expect(h.suspicious.length).toBe(0);
			}
		});
	}

	it("frozen-compact must-alert does not regress with multiFrame ON", async () => {
		const h = makeHarness();
		for (let i = 0; i < 4; i++)
			await h.tick(loadFixture("freeze-compacting.txt"));
		expect(h.alerts.length).toBe(1);
		expect(h.alerts[0]!.eventType).toBe("pane_hash_stuck");
	});

	it("529 transient throttle short-circuit stays ahead of the multi-frame vetoes", async () => {
		const h = makeHarness();
		for (let i = 0; i < 5; i++)
			await h.tick(loadFixture("throttle-529-live.txt"));
		expect(h.alerts.length).toBe(0);
		expect(h.suspicious.length).toBe(0);
	});

	it("echo of a pane_error_stalled alert cannot re-trigger classification (bidirectional)", async () => {
		// An idle pane that RECEIVED the new alert as a Discord echo must stay
		// suppressed — the `(<lead> / pane_error_stalled)` token is derived from
		// ALERT_EVENT_TYPES, so the echo strip covers the new kind automatically.
		const idle = loadFixture("idle-cos-lead.txt");
		const lines = idle.split("\n");
		const boxIdx = lines.findIndex((l) => l.includes("@cos-lead ──"));
		lines.splice(
			boxIdx,
			0,
			"← discord · Cass: ⚠️ **Lead pane error-stalled** (cos-lead / pane_error_stalled)",
		);
		const h = makeHarness();
		for (let i = 0; i < 5; i++) await h.tick(lines.join("\n"));
		expect(h.alerts.length).toBe(0);
	});
});
