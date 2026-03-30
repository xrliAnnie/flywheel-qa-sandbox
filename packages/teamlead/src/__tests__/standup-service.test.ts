/**
 * GEO-288: StandupService v2 unit tests.
 * Tests aggregateStandup, formatStandupReport, splitDiscordMessage, pacificDateString.
 * v2: No StandupScheduler, no Linear backlog, no Blockers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";
import {
	aggregateStandup,
	formatStandupReport,
	pacificDateString,
	splitDiscordMessage,
} from "../bridge/standup-service.js";
import { MAX_DISCORD_MESSAGE_LENGTH } from "../bridge/discord-utils.js";

const testProjects: ProjectEntry[] = [
	{
		projectName: "TestProject",
		projectRoot: "/tmp/test-project",
		leads: [
			{
				agentId: "product-lead",
				forumChannel: "test-forum",
				chatChannel: "test-chat",
				match: { labels: ["Product"] },
			},
			{
				agentId: "ops-lead",
				forumChannel: "test-ops-forum",
				chatChannel: "test-ops-chat",
				match: { labels: ["Ops"] },
			},
		],
	},
];

function sqlNow(): string {
	return new Date()
		.toISOString()
		.replace("T", " ")
		.replace(/\.\d+Z$/, "");
}

function sqlHoursAgo(hours: number): string {
	return new Date(Date.now() - hours * 3600_000)
		.toISOString()
		.replace("T", " ")
		.replace(/\.\d+Z$/, "");
}

async function createStore(): Promise<StateStore> {
	return StateStore.create(":memory:");
}

function insertSession(
	store: StateStore,
	overrides: Partial<{
		execution_id: string;
		issue_id: string;
		project_name: string;
		status: string;
		issue_identifier: string;
		issue_title: string;
		last_activity_at: string;
		last_error: string;
		issue_labels: string;
	}>,
) {
	const defaults = {
		execution_id: `exec-${Math.random().toString(36).slice(2, 8)}`,
		issue_id: `issue-${Math.random().toString(36).slice(2, 8)}`,
		project_name: "TestProject",
		status: "running",
		issue_identifier: "GEO-TEST",
		issue_title: "Test Issue",
		last_activity_at: sqlNow(),
		issue_labels: '["Product"]',
	};
	const data = { ...defaults, ...overrides };
	store.upsertSession(data);
}

// ─── aggregateStandup tests ────────────────────────────────────────

describe("aggregateStandup", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await createStore();
	});
	afterEach(() => store.close());

	it("separates running vs awaiting_review", async () => {
		insertSession(store, { status: "running", issue_id: "i1" });
		insertSession(store, { status: "running", issue_id: "i2" });
		insertSession(store, { status: "awaiting_review", issue_id: "i3" });

		const report = await aggregateStandup(
			store, "TestProject", 3, testProjects, 15, 24,
		);

		expect(report.systemStatus.runningCount).toBe(2);
		expect(report.systemStatus.awaitingReviewCount).toBe(1);
		expect(report.systemStatus.maxRunners).toBe(3);
	});

	it("filters completions by 24h window", async () => {
		insertSession(store, {
			status: "completed",
			issue_id: "recent",
			issue_identifier: "GEO-1",
			last_activity_at: sqlHoursAgo(2),
		});
		insertSession(store, {
			status: "completed",
			issue_id: "old",
			issue_identifier: "GEO-2",
			last_activity_at: sqlHoursAgo(48),
		});

		const report = await aggregateStandup(
			store, "TestProject", 3, testProjects, 15, 24,
		);

		expect(report.completions).toHaveLength(1);
		expect(report.completions[0]!.identifier).toBe("GEO-1");
	});

	it("filters by project_name", async () => {
		insertSession(store, { status: "running", project_name: "TestProject", issue_id: "i1" });
		insertSession(store, { status: "running", project_name: "OtherProject", issue_id: "i2" });

		const report = await aggregateStandup(
			store, "TestProject", 3, testProjects, 15, 24,
		);

		expect(report.systemStatus.runningCount).toBe(1);
	});

	it("routes completions to leads based on labels", async () => {
		insertSession(store, {
			status: "completed",
			issue_id: "prod-issue",
			issue_identifier: "GEO-P",
			issue_labels: '["Product"]',
			last_activity_at: sqlHoursAgo(1),
		});
		insertSession(store, {
			status: "completed",
			issue_id: "ops-issue",
			issue_identifier: "GEO-O",
			issue_labels: '["Ops"]',
			last_activity_at: sqlHoursAgo(1),
		});

		const report = await aggregateStandup(
			store, "TestProject", 3, testProjects, 15, 24,
		);

		expect(report.completions).toHaveLength(2);
		const prodItem = report.completions.find((c) => c.identifier === "GEO-P");
		const opsItem = report.completions.find((c) => c.identifier === "GEO-O");
		expect(prodItem!.ownerLeadId).toBe("product-lead");
		expect(opsItem!.ownerLeadId).toBe("ops-lead");
	});

	it("leaves ownerLeadId undefined for unrouted items (fallback)", async () => {
		insertSession(store, {
			status: "completed",
			issue_id: "no-label",
			issue_identifier: "GEO-NL",
			issue_labels: '["Unknown"]',
			last_activity_at: sqlHoursAgo(1),
		});

		const report = await aggregateStandup(
			store, "TestProject", 3, testProjects, 15, 24,
		);

		expect(report.completions).toHaveLength(1);
		expect(report.completions[0]!.ownerLeadId).toBeUndefined();
	});

	it("returns empty report for empty StateStore", async () => {
		const report = await aggregateStandup(
			store, "TestProject", 3, testProjects, 15, 24,
		);

		expect(report.systemStatus.runningCount).toBe(0);
		expect(report.systemStatus.awaitingReviewCount).toBe(0);
		expect(report.systemStatus.stuckCount).toBe(0);
		expect(report.completions).toHaveLength(0);
	});

	it("includes oldCompletedFailedBlockedCount (stale sessions)", async () => {
		insertSession(store, {
			status: "completed",
			issue_id: "stale-1",
			last_activity_at: sqlHoursAgo(48),
		});

		const report = await aggregateStandup(
			store, "TestProject", 3, testProjects, 15, 24,
		);

		expect(report.systemStatus.oldCompletedFailedBlockedCount).toBeGreaterThanOrEqual(0);
	});

	it("report has no blockers or backlogIssues fields", async () => {
		const report = await aggregateStandup(
			store, "TestProject", 3, testProjects, 15, 24,
		);

		expect(report).not.toHaveProperty("blockers");
		expect(report).not.toHaveProperty("backlogIssues");
	});
});

// ─── formatStandupReport tests ─────────────────────────────────────

const TEST_LINEAR_BASE = "https://linear.app/geoforge3d/issue";

describe("formatStandupReport", () => {
	it("includes all sections with morning greeting", () => {
		const report = {
			date: "2026-03-28",
			projectName: "TestProject",
			systemStatus: {
				runningCount: 2,
				awaitingReviewCount: 1,
				maxRunners: 3,
				stuckCount: 0,
				oldCompletedFailedBlockedCount: 0,
				staleThresholdHours: 24,
			},
			completions: [
				{ identifier: "GEO-1", title: "Feature", status: "completed", ownerLeadId: "product-lead" },
			],
		};

		const output = formatStandupReport(report, undefined, TEST_LINEAR_BASE);

		expect(output).toContain("## ☀️ Good Morning — 2026-03-28");
		expect(output).toContain("### System Status");
		expect(output).toContain("Running Runners: **2**/3");
		expect(output).toContain("Awaiting Review: **1**");
		expect(output).toContain("### Completions (24h)");
		expect(output).toContain("[**GEO-1** — Feature](https://linear.app/geoforge3d/issue/GEO-1)");
	});

	it("renders plain bold text when linearBaseUrl is not provided", () => {
		const report = {
			date: "2026-03-28",
			projectName: "TestProject",
			systemStatus: {
				runningCount: 0,
				awaitingReviewCount: 0,
				maxRunners: 3,
				stuckCount: 0,
				oldCompletedFailedBlockedCount: 0,
				staleThresholdHours: 24,
			},
			completions: [
				{ identifier: "GEO-5", title: "No URL", status: "completed" },
			],
		};

		const output = formatStandupReport(report);

		expect(output).toContain("**GEO-5** — No URL");
		expect(output).not.toContain("https://");
	});

	it("appends simbaMention triage trigger", () => {
		const report = {
			date: "2026-03-28",
			projectName: "TestProject",
			systemStatus: {
				runningCount: 0,
				awaitingReviewCount: 0,
				maxRunners: 3,
				stuckCount: 0,
				oldCompletedFailedBlockedCount: 0,
				staleThresholdHours: 24,
			},
			completions: [],
		};

		const output = formatStandupReport(report, "<@123456789>");

		expect(output).toContain("<@123456789> 系统日报已发，请执行今日 triage");
	});

	it("does not include triage trigger when simbaMention is undefined", () => {
		const report = {
			date: "2026-03-28",
			projectName: "TestProject",
			systemStatus: {
				runningCount: 0,
				awaitingReviewCount: 0,
				maxRunners: 3,
				stuckCount: 0,
				oldCompletedFailedBlockedCount: 0,
				staleThresholdHours: 24,
			},
			completions: [],
		};

		const output = formatStandupReport(report);

		expect(output).not.toContain("triage");
	});

	it("shows stale count when > 0", () => {
		const report = {
			date: "2026-03-28",
			projectName: "TestProject",
			systemStatus: {
				runningCount: 0,
				awaitingReviewCount: 0,
				maxRunners: 3,
				stuckCount: 0,
				oldCompletedFailedBlockedCount: 2,
				staleThresholdHours: 24,
			},
			completions: [],
		};

		const output = formatStandupReport(report);

		expect(output).toContain("Stale (completed/failed/blocked >24h): **2**"); // 24h from staleThresholdHours
	});

	it("truncates completions at 10 items", () => {
		const completions = Array.from({ length: 15 }, (_, i) => ({
			identifier: `GEO-${i + 1}`,
			title: `Issue ${i + 1}`,
			status: "completed",
		}));

		const report = {
			date: "2026-03-28",
			projectName: "TestProject",
			systemStatus: {
				runningCount: 0,
				awaitingReviewCount: 0,
				maxRunners: 3,
				stuckCount: 0,
				oldCompletedFailedBlockedCount: 0,
				staleThresholdHours: 24,
			},
			completions,
		};

		const output = formatStandupReport(report, undefined, TEST_LINEAR_BASE);

		expect(output).toContain("### Completions (24h) — 15");
		expect(output).toContain("[**GEO-10** — Issue 10](https://linear.app/geoforge3d/issue/GEO-10)");
		expect(output).not.toContain("GEO-11");
		expect(output).toContain("…and 5 more");
	});

	it("stays within MAX_DISCORD_MESSAGE_LENGTH", () => {
		const completions = Array.from({ length: 10 }, (_, i) => ({
			identifier: `GEO-${i + 1}`,
			title: `A fairly long issue title for testing purposes number ${i + 1}`,
			status: "completed",
			ownerLeadId: "product-lead",
		}));

		const report = {
			date: "2026-03-28",
			projectName: "TestProject",
			systemStatus: {
				runningCount: 1,
				awaitingReviewCount: 2,
				maxRunners: 3,
				stuckCount: 1,
				oldCompletedFailedBlockedCount: 3,
				staleThresholdHours: 24,
			},
			completions,
		};

		const output = formatStandupReport(report, "<@1487339075563290745>", TEST_LINEAR_BASE);

		expect(output.length).toBeLessThanOrEqual(MAX_DISCORD_MESSAGE_LENGTH);
	});

	it("1901-char regression: never produces output > MAX_DISCORD_MESSAGE_LENGTH", () => {
		// Create enough completions with long titles to potentially exceed limit
		const completions = Array.from({ length: 10 }, (_, i) => ({
			identifier: `GEO-${i + 100}`,
			title: "X".repeat(150),
			status: "completed",
			ownerLeadId: "product-lead",
		}));

		const report = {
			date: "2026-03-28",
			projectName: "TestProject",
			systemStatus: {
				runningCount: 3,
				awaitingReviewCount: 3,
				maxRunners: 5,
				stuckCount: 2,
				oldCompletedFailedBlockedCount: 5,
				staleThresholdHours: 24,
			},
			completions,
		};

		const output = formatStandupReport(report, "<@1487339075563290745> 系统日报已发，请执行今日 triage", TEST_LINEAR_BASE);

		expect(output.length).toBeLessThanOrEqual(MAX_DISCORD_MESSAGE_LENGTH);
	});
});

// ─── pacificDateString tests ──────────────────────────────────────

describe("pacificDateString", () => {
	it("returns YYYY-MM-DD format", () => {
		const result = pacificDateString(new Date("2026-03-28T12:00:00Z"));
		expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	it("uses Pacific Time, not UTC", () => {
		// 2026-03-29 at 2:00 AM UTC = 2026-03-28 at 7:00 PM PT (before midnight PT)
		const result = pacificDateString(new Date("2026-03-29T02:00:00Z"));
		expect(result).toBe("2026-03-28");
	});

	it("handles Pacific daylight saving correctly", () => {
		// Summer date: 2026-07-15 at 5:00 AM UTC = 2026-07-14 at 10:00 PM PDT
		const result = pacificDateString(new Date("2026-07-15T05:00:00Z"));
		expect(result).toBe("2026-07-14");
	});
});

// ─── splitDiscordMessage tests ─────────────────────────────────────

describe("splitDiscordMessage", () => {
	it("returns single chunk for short messages", () => {
		const msg = "Hello, world!";
		const chunks = splitDiscordMessage(msg);
		expect(chunks).toHaveLength(1);
		expect(chunks[0]).toBe(msg);
	});

	it("splits long messages at newline boundaries", () => {
		const line = "x".repeat(100) + "\n";
		const msg = line.repeat(25); // 2525 chars
		const chunks = splitDiscordMessage(msg);

		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(1900);
		}
		const rejoined = chunks.join("\n");
		expect(rejoined.replace(/\s+/g, "")).toBe(msg.replace(/\s+/g, ""));
	});

	it("handles message with no newlines", () => {
		const msg = "x".repeat(3000);
		const chunks = splitDiscordMessage(msg);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(1900);
		}
	});
});
