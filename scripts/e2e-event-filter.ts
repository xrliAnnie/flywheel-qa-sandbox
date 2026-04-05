#!/usr/bin/env npx tsx
/**
 * GEO-187 E2E: EventFilter manual verification script.
 *
 * Starts a real Bridge server, then sends a sequence of events through
 * the pipeline. Shows exactly what the EventFilter decides.
 *
 * NOTE (FLY-67): After OpenClaw removal, this script no longer injects a
 * RuntimeRegistry or capture runtime. It verifies event ingestion (HTTP 200)
 * and action endpoints, but does NOT verify notify_agent vs forum_only routing.
 * For full EventFilter coverage, see the unit tests in event-filter-e2e.test.ts.
 *
 * Usage:
 *   pnpm build && npx tsx scripts/e2e-event-filter.ts
 *
 * No external services needed — everything runs locally.
 */

// Import from compiled dist
import { EventFilter } from "../packages/teamlead/dist/bridge/EventFilter.js";
import { ForumTagUpdater } from "../packages/teamlead/dist/bridge/ForumTagUpdater.js";
import { createBridgeApp } from "../packages/teamlead/dist/bridge/plugin.js";
import type { BridgeConfig } from "../packages/teamlead/dist/bridge/types.js";
import { StateStore } from "../packages/teamlead/dist/StateStore.js";

// ── Helpers ──

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const _YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const _MAGENTA = "\x1b[35m";
const RESET = "\x1b[0m";

function log(msg: string) {
	console.log(msg);
}

function header(msg: string) {
	console.log(`\n${BOLD}${CYAN}═══ ${msg} ═══${RESET}\n`);
}

function step(n: number, total: number, desc: string) {
	console.log(`${BOLD}[${n}/${total}]${RESET} ${desc}`);
}

function result(label: string, value: string, color = GREEN) {
	console.log(`  ${DIM}→${RESET} ${label}: ${color}${value}${RESET}`);
}

// ── Tag map (simulated Discord Forum tags) ──

const STATUS_TAG_MAP: Record<string, string[]> = {
	running: ["tag-001-running"],
	awaiting_review: ["tag-002-review"],
	approved: ["tag-003-approved"],
	failed: ["tag-004-failed"],
	blocked: ["tag-005-blocked"],
	terminated: ["tag-006-terminated"],
};

// ── Main ──

async function main() {
	header("GEO-187 E2E: EventFilter Pipeline Verification");
	log("This script starts a Bridge server and sends events through the");
	log("EventFilter pipeline. Watch the routing decisions in real time.\n");

	// 1. Start Bridge
	const store = await StateStore.create(":memory:");
	const config: BridgeConfig = {
		host: "127.0.0.1",
		port: 0,
		dbPath: ":memory:",
		ingestToken: "test-ingest",
		apiToken: "test-api",
		notificationChannel: "test-channel",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300000,
		orphanThresholdMinutes: 60,
		discordBotToken: "mock-bot-token",
		discordGuildId: "mock-guild-123",
		defaultLeadAgentId: "product-lead",
		statusTagMap: STATUS_TAG_MAP,
	};

	const eventFilter = new EventFilter();
	const forumTagUpdater = new ForumTagUpdater(STATUS_TAG_MAP);
	const projects = [
		{
			projectName: "test-project",
			projectRoot: "/tmp/test",
			projectRepo: "test/repo",
			leads: [
				{
					agentId: "product-lead",
					forumChannel: "test-forum",
					chatChannel: "test-chat",
					match: { labels: ["Product"] },
				},
			],
		},
	];
	const app = createBridgeApp(
		store,
		projects,
		config,
		undefined,
		undefined,
		undefined,
		undefined,
		eventFilter,
		forumTagUpdater,
	);
	const server = app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const addr = server.address();
	const port = typeof addr === "object" && addr ? addr.port : 0;
	const baseUrl = `http://127.0.0.1:${port}`;
	log(`${DIM}Bridge server: ${baseUrl}${RESET}`);

	const ingestHeaders = {
		"Content-Type": "application/json",
		Authorization: "Bearer test-ingest",
	};
	const apiHeaders = {
		"Content-Type": "application/json",
		Authorization: "Bearer test-api",
	};

	const wait = (ms = 300) => new Promise((r) => setTimeout(r, ms));

	// Helper to send event and report
	let eventNum = 0;
	async function sendEvent(
		eventType: string,
		overrides: Record<string, unknown> = {},
		desc: string = "",
	) {
		eventNum++;

		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: ingestHeaders,
			body: JSON.stringify({
				event_id: `evt-${eventNum}`,
				execution_id: overrides.execution_id ?? "exec-1",
				issue_id: overrides.issue_id ?? "issue-1",
				project_name: "test-project",
				event_type: eventType,
				payload: overrides.payload ?? {
					issueIdentifier: "GEO-95",
					issueTitle: "Test Issue",
				},
				...overrides,
			}),
		});
		await wait();

		if (desc) log(`\n  ${DIM}${desc}${RESET}`);
		result("HTTP status", String(res.status), res.ok ? GREEN : RED);

		return { status: res.status };
	}

	const totalScenarios = 10;

	// ═══ Scenario 1: session_started without thread ═══
	header("Scenario 1: session_started (no existing thread)");
	step(1, totalScenarios, "Session starts for GEO-95 — no Forum thread exists");
	await sendEvent(
		"session_started",
		{},
		"Agent must create the Forum Post → should be notified",
	);

	// ═══ Scenario 2: session_started with thread ═══
	header("Scenario 2: session_started (thread exists)");
	step(
		2,
		totalScenarios,
		"Another execution for same issue — Forum thread already exists",
	);
	store.upsertThread("thread-123", "channel-1", "issue-2");
	await sendEvent(
		"session_started",
		{
			execution_id: "exec-2",
			issue_id: "issue-2",
			payload: { issueIdentifier: "GEO-96", issueTitle: "Another Issue" },
		},
		"Thread exists → forum_only (silent tag update, no notification)",
	);

	// ═══ Scenario 3: session_completed (needs_review) ═══
	header("Scenario 3: session_completed (needs_review)");
	step(3, totalScenarios, "Session completes with changes needing CEO review");
	await sendEvent(
		"session_completed",
		{
			payload: {
				decision: { route: "needs_review", reasoning: "has PR changes" },
				evidence: { commitCount: 5, linesAdded: 200, linesRemoved: 50 },
				summary: "Refactored auth module",
			},
		},
		"CEO decision required → HIGH priority notification",
	);

	// ═══ Scenario 4: session_completed (approved) ═══
	header("Scenario 4: session_completed (approved/auto-merged)");
	step(4, totalScenarios, "Session completes with already-merged PR");
	store.upsertSession({
		execution_id: "exec-3",
		issue_id: "issue-3",
		project_name: "test-project",
		status: "running",
		issue_identifier: "GEO-97",
	});
	store.upsertThread("thread-456", "channel-1", "issue-3");
	await sendEvent(
		"session_completed",
		{
			execution_id: "exec-3",
			issue_id: "issue-3",
			payload: {
				decision: { route: "auto_approve" },
				evidence: { commitCount: 1, landingStatus: { status: "merged" } },
			},
		},
		"Already merged → forum_only (CEO doesn't need to act)",
	);

	// ═══ Scenario 5: session_failed ═══
	header("Scenario 5: session_failed");
	step(5, totalScenarios, "Session fails with an error");
	store.upsertSession({
		execution_id: "exec-4",
		issue_id: "issue-4",
		project_name: "test-project",
		status: "running",
		issue_identifier: "GEO-98",
	});
	await sendEvent(
		"session_failed",
		{
			execution_id: "exec-4",
			issue_id: "issue-4",
			payload: { error: "Claude Code CLI timeout after 30 minutes" },
		},
		"Failure → HIGH priority notification",
	);

	// ═══ Scenario 6: resolve-action (terminate) ═══
	header("Scenario 6: resolve-action for terminate");
	step(6, totalScenarios, "CEO asks to terminate a running session");
	store.upsertSession({
		execution_id: "exec-5",
		issue_id: "issue-5",
		project_name: "test-project",
		status: "running",
		issue_identifier: "GEO-99",
		tmux_session: "flywheel-GEO-99",
	});
	const resolveRes = await fetch(
		`${baseUrl}/api/resolve-action?issue_id=issue-5&action=terminate`,
		{ headers: apiHeaders },
	);
	const resolveBody = (await resolveRes.json()) as any;
	log(`\n  ${DIM}CEO: "终止 GEO-99"${RESET}`);
	result(
		"can_execute",
		String(resolveBody.can_execute),
		resolveBody.can_execute ? GREEN : RED,
	);
	result("execution_id", resolveBody.execution_id ?? "N/A", DIM);

	// ═══ Scenario 7: terminate action ═══
	header("Scenario 7: execute terminate");
	step(7, totalScenarios, "Actually terminate the session");
	const termRes = await fetch(`${baseUrl}/api/actions/terminate`, {
		method: "POST",
		headers: apiHeaders,
		body: JSON.stringify({ execution_id: "exec-5" }),
	});
	const termBody = (await termRes.json()) as any;
	result("success", String(termBody.success), termBody.success ? GREEN : RED);
	result("message", termBody.message ?? "N/A", DIM);
	const termSession = store.getSession("exec-5");
	result(
		"final status",
		termSession?.status ?? "N/A",
		termSession?.status === "terminated" ? GREEN : RED,
	);

	// ═══ Scenario 8: terminate non-running → error ═══
	header("Scenario 8: terminate non-running session (should fail)");
	step(8, totalScenarios, "Try to terminate an awaiting_review session");
	store.upsertSession({
		execution_id: "exec-6",
		issue_id: "issue-6",
		project_name: "test-project",
		status: "awaiting_review",
		issue_identifier: "GEO-100",
	});
	const term2Res = await fetch(`${baseUrl}/api/actions/terminate`, {
		method: "POST",
		headers: apiHeaders,
		body: JSON.stringify({ execution_id: "exec-6" }),
	});
	const term2Body = (await term2Res.json()) as any;
	result("success", String(term2Body.success), term2Body.success ? RED : GREEN);
	result("message", term2Body.message ?? "N/A", DIM);

	// ═══ Scenario 9: retry with context ═══
	header("Scenario 9: retry with CEO context");
	step(9, totalScenarios, "CEO: '用 library X 重试 GEO-98'");
	const retryRes = await fetch(`${baseUrl}/api/actions/retry`, {
		method: "POST",
		headers: apiHeaders,
		body: JSON.stringify({
			execution_id: "exec-4",
			reason: "try different approach",
			context: "Use library X instead of Y, and add error handling",
		}),
	});
	const retryBody = (await retryRes.json()) as any;
	result("success", String(retryBody.success), retryBody.success ? GREEN : RED);
	result("action", retryBody.action ?? "N/A", DIM);

	// ═══ Scenario 10: guild-id endpoint ═══
	header("Scenario 10: Discord guild ID config");
	step(10, totalScenarios, "Agent queries guild ID for Forum Thread links");
	const guildRes = await fetch(`${baseUrl}/api/config/discord-guild-id`, {
		headers: apiHeaders,
	});
	const guildBody = (await guildRes.json()) as any;
	result(
		"guild_id",
		guildBody.guild_id ?? guildBody.error ?? "N/A",
		guildBody.guild_id ? GREEN : RED,
	);
	if (guildBody.guild_id) {
		const threadLink = `https://discord.com/channels/${guildBody.guild_id}/thread-123`;
		result("example link", threadLink, CYAN);
	}

	// ═══ Summary ═══
	header("Summary");

	log(`Expected routing:`);
	log(
		`  ${GREEN}✓${RESET} session_started (no thread) → notify_agent (normal)`,
	);
	log(
		`  ${GREEN}✓${RESET} session_started (has thread) → forum_only (NO notification)`,
	);
	log(
		`  ${GREEN}✓${RESET} session_completed (needs_review) → notify_agent (${RED}high${RESET})`,
	);
	log(
		`  ${GREEN}✓${RESET} session_completed (approved) → forum_only (NO notification)`,
	);
	log(`  ${GREEN}✓${RESET} session_failed → notify_agent (${RED}high${RESET})`);

	// Cleanup
	await new Promise<void>((resolve, reject) => {
		server.close((err) => (err ? reject(err) : resolve()));
	});
	store.close();

	log(`\n${GREEN}${BOLD}Done!${RESET} All scenarios executed successfully.\n`);
}

main().catch((err) => {
	console.error("E2E script crashed:", err);
	process.exit(1);
});
