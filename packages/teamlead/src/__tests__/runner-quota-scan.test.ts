/**
 * FLY-696 M1/③ — makeRunnerQuotaScan: the wiring around detectRunnerQuotaCap
 * that the RunnerIdleWatchdog drives per session capture.
 *
 * Verifies the full decision → emit chain: a real cap emits ONE usage_limit
 * alert with accountLimit metadata + runner identity (eventId keyed by
 * generation so repeated polls dedup and a post-switch cap re-alerts); a
 * transient 529 / unprovisioned pool / unresolvable Lead / throwing sink never
 * emits or throws.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeStore } from "../account-heal/account-store.js";
import { makeRunnerQuotaScan } from "../bridge/runner-quota-scan.js";
import type { AlertPayload } from "../LeadAlertNotifier.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { Session } from "../StateStore.js";

const FIXTURES_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"fixtures",
	"lead-panes",
);
const fx = (name: string): string =>
	readFileSync(join(FIXTURES_DIR, name), "utf-8");

const NOW = new Date("2026-07-03T20:00:00Z").getTime();

const projects: ProjectEntry[] = [
	{
		projectName: "flywheel",
		projectRoot: "/tmp/flywheel",
		projectRepo: "xrliAnnie/flywheel",
		leads: [
			{
				agentId: "flywheel-eng-lead",
				forumChannel: "forum",
				chatChannel: "chat",
				match: { labels: ["Flywheel"] },
			},
		],
	},
];

function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		execution_id: "exec-696",
		issue_id: "issue-696",
		project_name: "flywheel",
		status: "running",
		issue_identifier: "FLY-696",
		issue_labels: JSON.stringify(["Flywheel"]),
		...overrides,
	} as Session;
}

let dir: string;
let storePath: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "fly696-scan-"));
	storePath = join(dir, "claude-accounts.json");
	writeStore(
		{
			generation: 3,
			activeAccount: "personal",
			accounts: [
				{ name: "personal", quotaExhaustedUntil: null, weeklyResetAt: null },
			],
		},
		storePath,
	);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("makeRunnerQuotaScan (FLY-696 M1/③)", () => {
	it("real cap → one usage_limit alert with accountLimit metadata + runner identity", async () => {
		const alerts: AlertPayload[] = [];
		const scan = makeRunnerQuotaScan({
			projects,
			alert: async (p) => {
				alerts.push(p);
				return { sent: true };
			},
			isTransient: () => false,
			now: () => NOW,
			storePath,
		});

		await scan(makeSession(), fx("usage-limit-real.txt"));

		expect(alerts).toHaveLength(1);
		const p = alerts[0];
		expect(p).toMatchObject({
			leadId: "flywheel-eng-lead",
			projectName: "flywheel",
			eventType: "usage_limit",
			severity: "warning",
			sessionKey: "exec-696",
			// keyed by (execution, generation): same cap dedups, post-switch re-alerts
			eventId: "runner-quota:exec-696:3",
		});
		expect(p?.metadata?.accountLimit).toMatchObject({
			provider: "claude",
			scope: "5h",
			observedAccount: "personal",
			observedGeneration: 3,
		});
		expect(p?.body).toContain("FLY-696");
	});

	it("transient 529 → no alert (§3.3: retry in place, never switch)", async () => {
		const alert = vi.fn();
		const scan = makeRunnerQuotaScan({
			projects,
			alert,
			isTransient: () => true,
			now: () => NOW,
			storePath,
		});
		await scan(makeSession(), fx("usage-limit-real.txt"));
		expect(alert).not.toHaveBeenCalled();
	});

	it("unprovisioned pool (no active account) → no alert", async () => {
		writeStore({ generation: 0, activeAccount: null, accounts: [] }, storePath);
		const alert = vi.fn();
		const scan = makeRunnerQuotaScan({
			projects,
			alert,
			isTransient: () => false,
			now: () => NOW,
			storePath,
		});
		await scan(makeSession(), fx("usage-limit-real.txt"));
		expect(alert).not.toHaveBeenCalled();
	});

	it("unresolvable owning Lead → skip (logged), no alert, no throw", async () => {
		const alert = vi.fn();
		const log = vi.fn();
		const scan = makeRunnerQuotaScan({
			projects,
			alert,
			isTransient: () => false,
			now: () => NOW,
			storePath,
			log,
		});
		await scan(
			makeSession({ project_name: "unknown-project" }),
			fx("usage-limit-real.txt"),
		);
		expect(alert).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledOnce();
	});

	it("throwing alert sink is contained (never throws out of the scan)", async () => {
		const log = vi.fn();
		const scan = makeRunnerQuotaScan({
			projects,
			alert: async () => {
				throw new Error("notifier down");
			},
			isTransient: () => false,
			now: () => NOW,
			storePath,
			log,
		});
		await expect(
			scan(makeSession(), fx("usage-limit-real.txt")),
		).resolves.toBeUndefined();
		expect(log).toHaveBeenCalledOnce();
	});
});
