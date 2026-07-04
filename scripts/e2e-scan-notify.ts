#!/usr/bin/env tsx
/**
 * GEO-270 E2E: Scan-stale with real Discord notification
 *
 * 1. Creates a stale session in StateStore + CommDB + real tmux
 * 2. Starts Bridge with real projects.json
 * 3. Calls POST /api/patrol/scan-stale?notify=true
 * 4. Verifies Discord message sent to Lead's chatChannel
 * 5. Calls POST /api/sessions/:id/close-tmux to close
 * 6. Verifies tmux killed
 *
 * Usage: npx tsx scripts/e2e-scan-notify.ts
 */

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import type http from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { CommDB } from "../packages/flywheel-comm/src/db.js";
import { createBridgeApp } from "../packages/teamlead/src/bridge/plugin.js";
import type { BridgeConfig } from "../packages/teamlead/src/bridge/types.js";
import { loadProjects } from "../packages/teamlead/src/ProjectConfig.js";
import { StateStore } from "../packages/teamlead/src/StateStore.js";

const EXEC_ID = `e2e-notify-${Date.now()}`;
const TMUX_SESSION = `e2e-notify-${Date.now()}`;
const PROJECT_NAME = "geoforge3d";
const ISSUE_ID = "GEO-E2E-270";

function section(title: string) {
	console.log(`\n${"═".repeat(60)}`);
	console.log(`  ${title}`);
	console.log(`${"═".repeat(60)}\n`);
}

function showTmuxSessions() {
	try {
		const out = execFileSync("tmux", ["list-sessions"], {
			encoding: "utf-8",
		});
		console.log("  📺 tmux sessions:");
		for (const line of out.trim().split("\n")) {
			const isOurs = line.startsWith("e2e-notify-");
			console.log(`    ${isOurs ? "👉" : "  "} ${line}`);
		}
	} catch {
		console.log("  📺 tmux: (no server)");
	}
}

async function main() {
	console.log("\n========================================");
	console.log("  GEO-270 E2E: Scan + Discord Notify");
	console.log("========================================\n");

	let server: http.Server | undefined;
	let store: StateStore | undefined;

	// Load real projects config
	let projects: ReturnType<typeof loadProjects> | undefined;
	try {
		projects = loadProjects();
		console.log(`  ✅ Loaded ${projects.length} project(s) from projects.json`);
		for (const p of projects) {
			for (const l of p.leads) {
				const hasToken = !!(
					l.botToken ||
					(l.botTokenEnv && process.env[l.botTokenEnv])
				);
				console.log(
					`     ${p.projectName} → ${l.agentId}: chatChannel=${l.chatChannel}, token=${hasToken ? "✅" : "❌"}`,
				);
			}
		}
	} catch (err) {
		console.error("  ❌ Failed to load projects.json:", (err as Error).message);
		process.exit(1);
	}

	try {
		// ── Step 1: Create tmux session ──
		section("Step 1: 创建 tmux session");
		execFileSync("tmux", ["new-session", "-d", "-s", TMUX_SESSION]);
		showTmuxSessions();

		// ── Step 2: Register in CommDB ──
		section("Step 2: 注册到 CommDB");
		const commDir = join(homedir(), ".flywheel", "comm", PROJECT_NAME);
		mkdirSync(commDir, { recursive: true });
		const commDbPath = join(commDir, "comm.db");
		const commDb = new CommDB(commDbPath);
		commDb.registerSession(
			EXEC_ID,
			`${TMUX_SESSION}:@0`,
			PROJECT_NAME,
			ISSUE_ID,
			"product-lead",
		);
		commDb.updateSessionStatus(EXEC_ID, "completed");
		commDb.close();
		console.log(`  ✅ CommDB: ${EXEC_ID} → ${TMUX_SESSION}:@0 (completed)`);

		// ── Step 3: Start Bridge ──
		section("Step 3: 启动 Bridge");

		const config: BridgeConfig = {
			host: "127.0.0.1",
			port: 0,
			dbPath: ":memory:",
			notificationChannel: "test",
			defaultLeadAgentId: "product-lead",
			stuckThresholdMinutes: 15,
			stuckCheckIntervalMs: 300_000,
			orphanThresholdMinutes: 60,
			maxConcurrentRunners: 3,
			apiToken: "e2e-token",
			discordBotToken: process.env.PETER_BOT_TOKEN,
		};

		store = await StateStore.create(":memory:");

		const twoDaysAgo = new Date(Date.now() - 48 * 3_600_000)
			.toISOString()
			.replace("T", " ")
			.replace(/\.\d+Z$/, "");

		store.upsertSession({
			execution_id: EXEC_ID,
			issue_id: ISSUE_ID,
			project_name: PROJECT_NAME,
			status: "completed",
			issue_identifier: "GEO-E2E-270",
			issue_title: "Stale Session E2E Test",
			started_at: twoDaysAgo,
			last_activity_at: twoDaysAgo,
			issue_labels: '["Product"]',
		});
		console.log(`  ✅ StateStore: ${EXEC_ID}, completed 48h ago`);

		const app = createBridgeApp(store, projects, config);
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((r) => server!.once("listening", r));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		const baseUrl = `http://127.0.0.1:${port}`;
		console.log(`  🌐 Bridge: ${baseUrl}`);

		// ── Step 4: Scan + Notify ──
		section("Step 4: POST /api/patrol/scan-stale (notify=true)");

		const scanRes = await fetch(`${baseUrl}/api/patrol/scan-stale`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer e2e-token",
			},
			body: JSON.stringify({ thresholdHours: 1, notify: true }),
		});
		const scanBody = (await scanRes.json()) as Record<string, unknown>;
		console.log(`  📬 Response: ${scanRes.status}`);
		console.log(
			`     total: ${scanBody.total}, tmux_alive: ${scanBody.tmux_alive}`,
		);

		const sessions = scanBody.sessions as Array<Record<string, unknown>>;
		for (const s of sessions) {
			console.log(
				`     → ${s.issue_identifier ?? s.execution_id}: ${s.status}, ${s.hours_since_activity}h ago, tmux=${s.tmux_alive ? "ALIVE 🟢" : "dead ⚫"}`,
			);
		}

		const notifs = scanBody.notifications as
			| Array<Record<string, unknown>>
			| undefined;
		if (notifs && notifs.length > 0) {
			console.log("\n  📨 Discord notifications:");
			for (const n of notifs) {
				const icon = n.sent ? "✅" : "❌";
				console.log(
					`     ${icon} ${n.leadId}: ${n.sessionCount} session(s) → channel ${n.chatChannel}${n.error ? ` (${n.error})` : ""}`,
				);
			}
			console.log("\n  👀 去 Discord 检查 Lead 的 chatChannel 是否收到通知！");
		} else {
			console.log("\n  ⚠️  没有发送通知（可能没有匹配的 Lead 或 token）");
		}

		// ── Step 5: Close tmux ──
		section("Step 5: POST /api/sessions/:id/close-tmux");

		showTmuxSessions();

		const closeRes = await fetch(
			`${baseUrl}/api/sessions/${EXEC_ID}/close-tmux`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer e2e-token",
				},
				body: JSON.stringify({ leadId: "product-lead" }),
			},
		);
		const closeBody = (await closeRes.json()) as Record<string, unknown>;
		console.log(`  📬 Response: ${closeRes.status}`, JSON.stringify(closeBody));

		// ── Step 6: Verify ──
		section("Step 6: 验证");

		showTmuxSessions();

		try {
			execFileSync("tmux", ["has-session", "-t", `=${TMUX_SESSION}`]);
			console.log("  ❌ tmux session 还在！");
		} catch {
			console.log(`  ✅ tmux session "${TMUX_SESSION}" 已被杀掉`);
		}

		const after = store.getSession(EXEC_ID);
		console.log(`  ✅ StateStore 状态: "${after?.status}" (不变)`);

		section("测试完成");
		console.log("  所有步骤完成 ✅\n");
	} finally {
		if (server) {
			await new Promise<void>((r, j) => server!.close((e) => (e ? j(e) : r())));
		}
		store?.close();
		try {
			execFileSync("tmux", ["kill-session", "-t", `=${TMUX_SESSION}`]);
		} catch {}
	}
}

main();
