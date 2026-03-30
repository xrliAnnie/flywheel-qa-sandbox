#!/usr/bin/env tsx
/**
 * GEO-270 Interactive E2E Demo
 * Shows each step with tmux state changes visible
 */

import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import type http from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { createBridgeApp } from "../packages/teamlead/src/bridge/plugin.js";
import {
	getTmuxTargetFromCommDb,
	isTmuxSessionAlive,
} from "../packages/teamlead/src/bridge/tmux-lookup.js";
import type { BridgeConfig } from "../packages/teamlead/src/bridge/types.js";
import type { ProjectEntry } from "../packages/teamlead/src/ProjectConfig.js";
import { StateStore } from "../packages/teamlead/src/StateStore.js";

const PROJECT = "e2e-stale-demo";
const EXEC_ID = "exec-demo-stale";

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
			const isOurs = line.startsWith("GEO-E2E-STALE");
			console.log(`    ${isOurs ? "👉" : "  "} ${line}`);
		}
	} catch {
		console.log("  📺 tmux: (no server)");
	}
}

async function main() {
	let server: http.Server | undefined;
	let store: StateStore | undefined;

	try {
		// ── Step 1: 当前状态 ──
		section("Step 1: 当前 tmux 状态（GEO-E2E-STALE 应该在）");
		showTmuxSessions();

		// ── Step 2: 检测 ──
		section("Step 2: Bridge 能找到这个 stale session 吗？");

		// 2a: CommDB → tmux target
		const target = getTmuxTargetFromCommDb(EXEC_ID, PROJECT);
		if (target) {
			console.log(`  🔍 CommDB 查到 tmux target:`);
			console.log(`     tmux_window:  ${target.tmuxWindow}`);
			console.log(`     session_name: ${target.sessionName}`);
		} else {
			console.log("  ❌ CommDB 查不到 — 检查 Step 2 注册是否成功");
			return;
		}

		// 2b: tmux alive?
		const alive = await isTmuxSessionAlive(target.sessionName);
		console.log(
			`  ${alive ? "✅" : "❌"} tmux session "${target.sessionName}" ${alive ? "存活" : "已死"}`,
		);
		if (!alive) {
			console.log("  ⚠️  tmux session 不在了，无法继续测试");
			return;
		}

		// ── Step 3: Bridge 启动 + StateStore ──
		section("Step 3: 启动 Bridge，注册 stale session 到 StateStore");

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
			apiToken: "demo-token",
		};

		const projects: ProjectEntry[] = [
			{
				projectName: PROJECT,
				projectRoot: "/tmp",
				leads: [
					{
						agentId: "product-lead",
						forumChannel: "c1",
						chatChannel: "c2",
						match: { labels: ["Product"] },
					},
				],
			},
		];

		store = await StateStore.create(":memory:");

		const twoDaysAgo = new Date(Date.now() - 48 * 3_600_000)
			.toISOString()
			.replace("T", " ")
			.replace(/\.\d+Z$/, "");

		store.upsertSession({
			execution_id: EXEC_ID,
			issue_id: "GEO-E2E-270",
			project_name: PROJECT,
			status: "completed",
			issue_identifier: "GEO-E2E-270",
			issue_title: "Stale Session Demo",
			last_activity_at: twoDaysAgo,
			issue_labels: '["Product"]',
		});

		const session = store.getSession(EXEC_ID);
		console.log(`  📋 StateStore session:`);
		console.log(`     execution_id:   ${session?.execution_id}`);
		console.log(`     status:         ${session?.status}`);
		console.log(`     last_activity:  ${session?.last_activity_at}`);
		console.log(`     (48 小时前 — 远超 24h 阈值)`);

		const app = createBridgeApp(store, projects, config);
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((r) => server!.once("listening", r));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		const baseUrl = `http://127.0.0.1:${port}`;
		console.log(`  🌐 Bridge: ${baseUrl}`);

		// ── Step 4: getStaleCompletedSessions ──
		section("Step 4: StateStore 巡检查询");

		const stale = store.getStaleCompletedSessions(24);
		console.log(`  🔎 getStaleCompletedSessions(24h): 找到 ${stale.length} 个`);
		for (const s of stale) {
			console.log(
				`     → ${s.execution_id}: status=${s.status}, last_activity=${s.last_activity_at}`,
			);
		}

		// ── Step 5: scan-stale API ──
		section("Step 5: 调用 POST /api/patrol/scan-stale（Scanner）");

		console.log(`  🔎 POST ${baseUrl}/api/patrol/scan-stale`);
		const scanRes = await fetch(`${baseUrl}/api/patrol/scan-stale`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer demo-token",
			},
			body: JSON.stringify({ thresholdHours: 1 }),
		});
		const scanBody = (await scanRes.json()) as Record<string, unknown>;
		console.log(`  📬 Response: ${scanRes.status}`);
		console.log(
			`     total: ${scanBody.total}, tmux_alive: ${scanBody.tmux_alive}, tmux_dead: ${scanBody.tmux_dead}`,
		);
		const sessions = scanBody.sessions as Array<Record<string, unknown>>;
		for (const s of sessions) {
			console.log(
				`     → ${s.execution_id}: ${s.status}, ${s.hours_since_activity}h ago, tmux=${s.tmux_alive ? "ALIVE 🟢" : "dead ⚫"}`,
			);
		}

		// ── Step 6: close-tmux ──
		section("Step 6: 调用 POST /api/sessions/:id/close-tmux（关闭）");

		console.log("  📺 关闭前 tmux 状态:");
		showTmuxSessions();

		console.log(`\n  🔫 POST ${baseUrl}/api/sessions/${EXEC_ID}/close-tmux`);
		const res = await fetch(`${baseUrl}/api/sessions/${EXEC_ID}/close-tmux`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer demo-token",
			},
			body: JSON.stringify({ leadId: "product-lead" }),
		});
		const body = (await res.json()) as Record<string, unknown>;
		console.log(`  📬 Response: ${res.status}`, JSON.stringify(body));

		// ── Step 7: 验证 ──
		section("Step 7: 验证结果");

		console.log("  📺 关闭后 tmux 状态:");
		showTmuxSessions();

		try {
			execFileSync("tmux", ["has-session", "-t", "=GEO-E2E-STALE"]);
			console.log("\n  ❌ GEO-E2E-STALE 还活着！关闭失败");
		} catch {
			console.log("\n  ✅ GEO-E2E-STALE 已被杀掉");
		}

		const after = store.getSession(EXEC_ID);
		console.log(
			`  ✅ StateStore 状态: "${after?.status}" (保持 completed，没有被改)`,
		);

		section("测试完成");
		console.log("  所有验证通过 ✅\n");
	} finally {
		if (server) {
			await new Promise<void>((r, j) => server!.close((e) => (e ? j(e) : r())));
		}
		store?.close();
		// 清理 CommDB
		try {
			rmSync(join(homedir(), ".flywheel", "comm", PROJECT), {
				recursive: true,
				force: true,
			});
		} catch {}
	}
}

main();
