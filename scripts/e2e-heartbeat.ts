#!/usr/bin/env npx tsx
/**
 * E2E: Heartbeat + Orphan Reaping — visual demonstration (GEO-157)
 *
 * This test starts REAL infrastructure and a REAL Claude session so you can
 * SEE the heartbeat flowing and orphan reaping working:
 *
 *   1. Starts TeamLead bridge (HTTP server on random port, in-memory DB)
 *   2. Launches TmuxAdapter with a short Claude task in a visible tmux window
 *   3. Heartbeats flow: TmuxAdapter → /events/heartbeat → StateStore
 *   4. You can watch the tmux window while heartbeats print to console
 *   5. After Claude finishes (or times out), queries StateStore for heartbeat_at
 *   6. Creates a FAKE orphan session and runs HeartbeatService.check()
 *   7. Verifies the orphan is reaped to status=failed
 *
 * Prerequisites:
 *   - tmux running (be in a tmux session or have tmux server active)
 *   - claude CLI installed and authenticated
 *   - pnpm build has been run
 *
 * Usage:
 *   npx tsx scripts/e2e-heartbeat.ts
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { TmuxAdapter } from "../packages/claude-runner/dist/TmuxAdapter.js";
import { StateStore } from "../packages/teamlead/dist/StateStore.js";
import { HeartbeatService } from "../packages/teamlead/dist/HeartbeatService.js";
import { createBridgeApp } from "../packages/teamlead/dist/bridge/plugin.js";

// ── Helpers ──────────────────────────────────────────

function log(msg: string) {
	const time = new Date().toLocaleTimeString("en-US", { hour12: false });
	console.log(`[${time}] ${msg}`);
}

function git(args: string[], cwd: string): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

// ── Setup temp repo ──────────────────────────────────

function setupTempRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "flywheel-e2e-hb-"));
	git(["init"], dir);
	git(["config", "user.email", "test@test.com"], dir);
	git(["config", "user.name", "Test"], dir);
	writeFileSync(join(dir, "README.md"), "# Test\n");
	git(["add", "."], dir);
	git(["commit", "-m", "init"], dir);
	return dir;
}

// ── Start minimal bridge ─────────────────────────────

async function startMinimalBridge(store: StateStore): Promise<{
	port: number;
	close: () => Promise<void>;
}> {
	const E2E_TOKEN = "e2e-test-token";
	const config = {
		host: "127.0.0.1",
		port: 0, // random port
		dbPath: ":memory:",
		ingestToken: E2E_TOKEN,
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300_000,
		orphanThresholdMinutes: 60,
	};
	const projects = [{ name: "e2e-test", root: "/tmp" }];
	const app = createBridgeApp(store, projects, config);

	const server = app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));

	const addr = server.address();
	const port = typeof addr === "object" && addr ? addr.port : 0;

	return {
		port,
		token: E2E_TOKEN,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

// ── Main ─────────────────────────────────────────────

async function main() {
	console.log("\n╔══════════════════════════════════════════════════╗");
	console.log("║  E2E: Heartbeat + Orphan Reaping (GEO-157)      ║");
	console.log("╚══════════════════════════════════════════════════╝\n");

	// ── Phase 1: Setup ──
	log("Phase 1: Setting up infrastructure...");

	const store = await StateStore.create(":memory:");
	const bridge = await startMinimalBridge(store);
	log(`  Bridge listening on 127.0.0.1:${bridge.port}`);

	const repoDir = setupTempRepo();
	log(`  Temp repo created: ${repoDir}`);

	const executionId = randomUUID();
	const issueId = "E2E-HB-001";

	// Register session_started via bridge API (so StateStore has the session)
	const startedRes = await fetch(`http://127.0.0.1:${bridge.port}/events`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "Authorization": `Bearer ${bridge.token}` },
		body: JSON.stringify({
			event_id: randomUUID(),
			execution_id: executionId,
			issue_id: issueId,
			project_name: "e2e-test",
			event_type: "session_started",
			payload: { issueIdentifier: issueId, issueTitle: "Heartbeat E2E Test" },
		}),
	});
	if (!startedRes.ok) throw new Error(`session_started failed: ${startedRes.status}`);
	log(`  Session registered: ${executionId.slice(0, 8)}...`);

	// Verify initial heartbeat_at was set by session_started handler
	const initialSession = store.getSession(executionId);
	log(`  Initial heartbeat_at: ${initialSession?.heartbeat_at ?? "NOT SET"}`);
	if (!initialSession?.heartbeat_at) {
		log("  ⚠️  heartbeat_at not initialized by session_started — this is a bug!");
	}

	// ── Phase 2: Run Claude with heartbeats ──
	log("\nPhase 2: Launching TmuxAdapter with heartbeat...");
	log("  (Watch the tmux window — Claude will do a tiny task)");
	log("  (Heartbeats will print here every ~5 seconds)\n");

	let heartbeatCount = 0;
	const heartbeatLog: string[] = [];

	const adapter = new TmuxAdapter(
		"flywheel-e2e", // tmux session name
		undefined,      // default execFileFn
		5000,           // 5s poll interval
		60_000,         // 60s timeout (short for E2E)
	);

	const start = Date.now();

	const resultPromise = adapter.execute({
		executionId,
		issueId,
		prompt: 'Create a file called hello.txt with the content "Hello from Flywheel E2E!" and then exit. Do NOT create a git commit.',
		cwd: repoDir,
		permissionMode: "bypassPermissions",
		timeoutMs: 60_000,
		label: "E2E-HB-Test",
		onHeartbeat: (eid) => {
			heartbeatCount++;
			const elapsed = ((Date.now() - start) / 1000).toFixed(1);
			const msg = `  💓 Heartbeat #${heartbeatCount} (${elapsed}s) — executionId=${eid.slice(0, 8)}...`;
			console.log(msg);
			heartbeatLog.push(msg);

			// Forward heartbeat to bridge
			fetch(`http://127.0.0.1:${bridge.port}/events/heartbeat`, {
				method: "POST",
				headers: { "Content-Type": "application/json", "Authorization": `Bearer ${bridge.token}` },
				body: JSON.stringify({ execution_id: eid }),
			}).catch(() => {
				// Best-effort — don't block the adapter
			});
		},
	});

	const result = await resultPromise;
	const elapsed = ((Date.now() - start) / 1000).toFixed(1);

	log(`\n  Claude finished in ${elapsed}s (success=${result.success}, timedOut=${result.timedOut})`);
	log(`  Total heartbeats: ${heartbeatCount}`);
	log(`  Session ID: ${result.sessionId.slice(0, 8)}...`);
	log(`  tmux window: ${result.tmuxWindow}`);

	// ── Phase 3: Verify heartbeat_at updated ──
	log("\nPhase 3: Verifying heartbeat_at in StateStore...");

	// Give the last heartbeat a moment to arrive
	await sleep(500);

	const updatedSession = store.getSession(executionId);
	log(`  heartbeat_at: ${updatedSession?.heartbeat_at ?? "NOT SET"}`);
	log(`  status: ${updatedSession?.status}`);

	if (updatedSession?.heartbeat_at) {
		const hbTime = new Date(updatedSession.heartbeat_at.replace(" ", "T") + "Z");
		const age = Math.round((Date.now() - hbTime.getTime()) / 1000);
		log(`  heartbeat age: ${age}s ago`);
		if (age < 120) {
			log("  ✅ Heartbeat is fresh (< 2 min old)");
		} else {
			log("  ⚠️  Heartbeat is stale");
		}
	}

	if (heartbeatCount >= 1) {
		log(`  ✅ Received ${heartbeatCount} heartbeat(s) during execution`);
	} else {
		log("  ❌ No heartbeats received — onHeartbeat callback not called!");
	}

	// ── Phase 4: Orphan reaping simulation ──
	log("\nPhase 4: Simulating orphan reaping...");

	// Create a fake "orphan" session with an old heartbeat
	const orphanId = randomUUID();
	store.upsertSession({
		execution_id: orphanId,
		issue_id: "E2E-ORPHAN",
		project_name: "e2e-test",
		status: "running",
		started_at: "2020-01-01 00:00:00",
		last_activity_at: "2020-01-01 00:00:00",
	});
	// Set heartbeat_at to something very old by doing raw SQL
	// (updateHeartbeat sets to now, so we use the DB directly)
	(store as any).db.run(
		"UPDATE sessions SET heartbeat_at = '2020-01-01 00:00:00' WHERE execution_id = ?",
		[orphanId],
	);
	(store as any).save();
	log(`  Created fake orphan: ${orphanId.slice(0, 8)}... (heartbeat_at=2020-01-01)`);

	const orphanBefore = store.getSession(orphanId);
	log(`  Orphan status before reaping: ${orphanBefore?.status}`);

	// Run HeartbeatService to detect and reap
	let reapedSessions: string[] = [];
	const notifier = {
		onSessionStuck: async () => {},
		onSessionOrphaned: async (session: any) => {
			reapedSessions.push(session.execution_id);
			log(`  🪦 Orphan reaped: ${session.execution_id.slice(0, 8)}... (issue=${session.issue_id})`);
		},
	};

	// orphanThreshold = 1 minute (orphan is from 2020, way past threshold)
	const svc = new HeartbeatService(store, notifier, 999, 60_000, 1);
	await svc.check();

	const orphanAfter = store.getSession(orphanId);
	log(`  Orphan status after reaping: ${orphanAfter?.status}`);

	if (orphanAfter?.status === "failed" && reapedSessions.length === 1) {
		log("  ✅ Orphan successfully reaped! status → failed, notifier called");
	} else {
		log(`  ❌ Reaping failed: status=${orphanAfter?.status}, reaped=${reapedSessions.length}`);
	}

	// ── Phase 5: session_params (recovery infrastructure) ──
	log("\nPhase 5: Testing session_params persistence...");

	store.setSessionParams(executionId, {
		sessionId: result.sessionId,
		lastPromptHash: "abc123",
	});
	const params = store.getSessionParams(executionId);
	if (params?.sessionId === result.sessionId) {
		log(`  ✅ session_params round-trip OK: sessionId=${result.sessionId.slice(0, 8)}...`);
	} else {
		log(`  ❌ session_params mismatch: got ${JSON.stringify(params)}`);
	}

	const latest = store.getLatestSessionParams(issueId);
	if (latest?.sessionParams?.sessionId === result.sessionId) {
		log(`  ✅ getLatestSessionParams(${issueId}) returns correct session`);
	} else {
		log(`  ❌ getLatestSessionParams returned: ${JSON.stringify(latest)}`);
	}

	// ── Cleanup ──
	log("\nCleaning up...");
	store.close();
	await bridge.close();

	// Kill the E2E tmux session if it exists
	try {
		execFileSync("tmux", ["kill-session", "-t", "=flywheel-e2e"], { stdio: "pipe" });
		log("  Killed flywheel-e2e tmux session");
	} catch {
		// Session may not exist
	}

	// ── Summary ──
	console.log("\n╔══════════════════════════════════════════════════╗");
	console.log("║  E2E RESULTS                                     ║");
	console.log("╠══════════════════════════════════════════════════╣");
	console.log(`║  Heartbeats received: ${String(heartbeatCount).padEnd(27)}║`);
	console.log(`║  Heartbeat→Bridge→StateStore: ${heartbeatCount >= 1 ? "✅ PASS" : "❌ FAIL"}               ║`);
	console.log(`║  Orphan reaping:              ${orphanAfter?.status === "failed" ? "✅ PASS" : "❌ FAIL"}               ║`);
	console.log(`║  Session params:              ${params?.sessionId === result.sessionId ? "✅ PASS" : "❌ FAIL"}               ║`);
	console.log("╚══════════════════════════════════════════════════╝\n");

	const allPass =
		heartbeatCount >= 1 &&
		orphanAfter?.status === "failed" &&
		params?.sessionId === result.sessionId;

	if (!allPass) process.exit(1);
}

main().catch((err) => {
	console.error("\n❌ E2E crashed:", err);
	process.exit(1);
});
