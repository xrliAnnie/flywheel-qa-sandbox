/**
 * FLY-368: LeadWatchdog additions — public reconcile helpers + onRecovery /
 * onPollComplete hooks. Pure-helper tests use the committed real pane fixtures.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AlertPayload } from "../LeadAlertNotifier.js";
import {
	classifyLeadAlertPane,
	isSafeResumeMenuForEnter,
	LeadWatchdog,
	leadPaneLiveHash,
} from "../LeadWatchdog.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

const FIXTURES_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"fixtures",
	"lead-panes",
);
const fx = (name: string): string =>
	readFileSync(join(FIXTURES_DIR, name), "utf-8");

const projects: ProjectEntry[] = [
	{
		projectName: "geoforge3d",
		projectRoot: "/tmp/geo",
		generalChannel: "core-1",
		leads: [
			{
				agentId: "cos-lead",
				chatChannel: "chat-1",
				match: { labels: ["cos"] },
				alertChannel: "alerts-1",
			},
		],
	},
];

describe("classifyLeadAlertPane (FLY-368 public classifier)", () => {
	it("classifies a real rate-limit pane as rate_limit", () => {
		expect(classifyLeadAlertPane(fx("rate-limit-real.txt"))).toBe("rate_limit");
	});
	it("classifies a real usage-limit pane as usage_limit", () => {
		expect(classifyLeadAlertPane(fx("usage-limit-real.txt"))).toBe(
			"usage_limit",
		);
	});
	it("an idle-healthy pane is not a blocked kind (pane_hash_stuck default)", () => {
		expect(classifyLeadAlertPane(fx("idle-cos-lead.txt"))).toBe(
			"pane_hash_stuck",
		);
	});
});

describe("leadPaneLiveHash (FLY-368 two-capture rule helper)", () => {
	it("is stable for identical panes and differs for different live state", () => {
		const a = fx("idle-cos-lead.txt");
		expect(leadPaneLiveHash(a)).toBe(leadPaneLiveHash(a));
		expect(leadPaneLiveHash(a)).not.toBe(
			leadPaneLiveHash(fx("rate-limit-real.txt")),
		);
	});
});

describe("isSafeResumeMenuForEnter (FLY-368 narrow resume-menu recognizer)", () => {
	it("TRUE only for the exact resume menu", () => {
		expect(isSafeResumeMenuForEnter(fx("freeze-resume-menu.txt"))).toBe(true);
	});
	it("FALSE for the compact prompt (Enter starts compaction — not safe)", () => {
		expect(isSafeResumeMenuForEnter(fx("freeze-compact-prompt.txt"))).toBe(
			false,
		);
	});
	it("FALSE for an in-flight compaction", () => {
		expect(isSafeResumeMenuForEnter(fx("freeze-compacting.txt"))).toBe(false);
	});
	it("FALSE for idle / rate-limit / empty panes", () => {
		expect(isSafeResumeMenuForEnter(fx("idle-cos-lead.txt"))).toBe(false);
		expect(isSafeResumeMenuForEnter(fx("rate-limit-real.txt"))).toBe(false);
		expect(isSafeResumeMenuForEnter("")).toBe(false);
	});
});

function makeWatchdog(
	store: StateStore,
	overrides: {
		capture: () => Promise<string>;
		onRecovery?: (p: string, l: string, k: AlertPayload["eventType"]) => void;
		onPollComplete?: () => void | Promise<void>;
	},
) {
	return new LeadWatchdog({
		pollIntervalMs: 30_000,
		paneHashStuckCycles: 2,
		paneHashAlertCycles: 3,
		cooldownMs: 300_000,
		projects,
		store,
		notifier: async () => ({ sent: true }),
		locateWindowFn: async () => ({
			windowId: "@1",
			windowName: "geoforge3d-cos-lead",
		}),
		captureFn: overrides.capture,
		claimsReader: async () => new Set(),
		blockedMarkerReader: async () => [],
		now: () => 0,
		onRecovery: overrides.onRecovery,
		onPollComplete: overrides.onPollComplete,
	});
}

describe("LeadWatchdog FLY-368 hooks", () => {
	let store: StateStore;
	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	it("onPollComplete fires once per poll", async () => {
		const onPollComplete = vi.fn();
		const wd = makeWatchdog(store, {
			capture: async () => "idle pane\n",
			onPollComplete,
		});
		await wd.pollOnce();
		await wd.pollOnce();
		expect(onPollComplete).toHaveBeenCalledTimes(2);
	});

	it("onPollComplete errors do not wedge the poll loop", async () => {
		const wd = makeWatchdog(store, {
			capture: async () => "idle pane\n",
			onPollComplete: () => {
				throw new Error("boom");
			},
		});
		await expect(wd.pollOnce()).resolves.toBeUndefined();
	});

	it("fires onRecovery with the blocked kind when a rate-limit pane recovers", async () => {
		const onRecovery = vi.fn();
		const stuck = fx("rate-limit-real.txt");
		const healthy = "all good, idle now\n";
		// captures: stuck, stuck (alert fires at cycle 2), then recovered.
		const seq = [stuck, stuck, stuck, healthy];
		let i = 0;
		const wd = makeWatchdog(store, {
			capture: async () => seq[Math.min(i++, seq.length - 1)]!,
			onRecovery,
		});
		await wd.pollOnce(); // baseline
		await wd.pollOnce(); // cycle 2 → alert
		await wd.pollOnce(); // still stuck
		await wd.pollOnce(); // recovered → onRecovery
		expect(onRecovery).toHaveBeenCalledWith(
			"geoforge3d",
			"cos-lead",
			"rate_limit",
		);
	});

	it("fires onRecovery with pane_hash_stuck when an unknown freeze recovers", async () => {
		const onRecovery = vi.fn();
		const frozen = "frozen unknown pane, no markers\n";
		const healthy = "now moving along differently\n";
		const seq = [frozen, frozen, frozen, frozen, healthy];
		let i = 0;
		const wd = makeWatchdog(store, {
			capture: async () => seq[Math.min(i++, seq.length - 1)]!,
			onRecovery,
		});
		// pane_hash_stuck fires at paneHashAlertCycles (3).
		await wd.pollOnce();
		await wd.pollOnce();
		await wd.pollOnce();
		await wd.pollOnce();
		await wd.pollOnce(); // recovered
		expect(onRecovery).toHaveBeenCalledWith(
			"geoforge3d",
			"cos-lead",
			"pane_hash_stuck",
		);
	});

	it("does NOT fire onRecovery when there was never an alert", async () => {
		const onRecovery = vi.fn();
		const seq = ["pane A\n", "pane B\n", "pane C\n"];
		let i = 0;
		const wd = makeWatchdog(store, {
			capture: async () => seq[Math.min(i++, seq.length - 1)]!,
			onRecovery,
		});
		await wd.pollOnce();
		await wd.pollOnce();
		await wd.pollOnce();
		expect(onRecovery).not.toHaveBeenCalled();
	});
});
