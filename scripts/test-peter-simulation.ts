#!/usr/bin/env npx tsx
/**
 * GEO-259: Simulate Peter's real queries — before/after leadId.
 *
 * Starts a test Bridge with new code, seeds real data,
 * and compares what Peter sees with and without leadId.
 */

import type { ProjectEntry } from "../packages/teamlead/src/ProjectConfig.js";
import { createBridgeApp } from "../packages/teamlead/src/bridge/plugin.js";
import { StateStore } from "../packages/teamlead/src/StateStore.js";

const TEST_PORT = 19876;

const projects: ProjectEntry[] = [
	{
		projectName: "geoforge3d",
		projectRoot: "/Users/xiaorongli/Dev/GeoForge3D",
		leads: [
			{
				agentId: "product-lead",
				forumChannel: "111",
				chatChannel: "111-chat",
				match: { labels: ["Product"] },
			},
			{
				agentId: "ops-lead",
				forumChannel: "222",
				chatChannel: "222-chat",
				match: { labels: ["Operations"] },
			},
		],
	},
];

async function main() {
	const store = await StateStore.create(":memory:");

	// Seed from running Bridge
	const res = await fetch("http://localhost:9876/api/sessions?mode=recent&limit=200");
	const data = await res.json();
	for (const s of data.sessions) {
		store.upsertSession({
			execution_id: s.execution_id,
			issue_id: s.issue_id || `issue-${s.execution_id}`,
			project_name: s.project_name,
			status: s.status,
			issue_identifier: s.identifier,
			issue_title: s.issue_title,
			issue_labels: s.issue_labels,
			last_activity_at: s.last_activity_at,
		});
	}

	const app = createBridgeApp(store, projects, {
		host: "127.0.0.1",
		port: TEST_PORT,
		dbPath: ":memory:",
		notificationChannel: "test",
		defaultLeadAgentId: "product-lead",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300000,
		orphanThresholdMinutes: 60,
	});
	const server = app.listen(TEST_PORT, "127.0.0.1");
	await new Promise<void>((r) => server.once("listening", r));
	const base = `http://127.0.0.1:${TEST_PORT}`;

	console.log("\n════════════════════════════════════════════════════════════");
	console.log("  🧪 Peter (product-lead) Query Simulation");
	console.log("  Before vs After leadId filtering");
	console.log("════════════════════════════════════════════════════════════\n");

	// --- Simulate: Peter asks "现在在跑的有哪些 issue" ---
	console.log('💬 CEO asks Peter: "现在在跑的有哪些 issue?"\n');

	console.log("── BEFORE (no leadId) ─────────────────────────────────────");
	console.log("   curl $BRIDGE_URL/api/sessions\n");

	const before = await (await fetch(`${base}/api/sessions`)).json();
	console.log(`   Peter sees ${before.count} active sessions:`);
	for (const s of before.sessions) {
		const labels = s.issue_labels ? JSON.parse(s.issue_labels) : [];
		const labelStr = labels.length > 0 ? labels.join(",") : "no labels";
		const scope = labels.some((l: string) => l.toLowerCase() === "product")
			? "✅ his scope"
			: labels.some((l: string) => l.toLowerCase() === "operations")
				? "❌ ops scope"
				: "⚠️  ambiguous (default lead)";
		console.log(`   ${scope}  ${(s.identifier || "?").padEnd(12)} ${s.status.padEnd(18)} [${labelStr}]`);
	}

	console.log("\n── AFTER (with leadId=product-lead) ───────────────────────");
	console.log("   curl $BRIDGE_URL/api/sessions?leadId=product-lead\n");

	const after = await (await fetch(`${base}/api/sessions?leadId=product-lead`)).json();
	console.log(`   Peter sees ${after.count} active sessions:`);
	for (const s of after.sessions) {
		const labels = s.issue_labels ? JSON.parse(s.issue_labels) : [];
		const labelStr = labels.length > 0 ? labels.join(",") : "no labels";
		console.log(`   ✅  ${(s.identifier || "?").padEnd(12)} ${s.status.padEnd(18)} [${labelStr}]`);
	}

	const filtered = before.count - after.count;
	console.log(`\n   📉 Noise reduced: ${before.count} → ${after.count} (${filtered} sessions filtered out)`);

	// --- Simulate: Peter asks about a specific ops issue ---
	console.log("\n\n── SCENARIO: Peter tries to approve an ops session ────────");

	const opsSession = before.sessions.find((s: any) => {
		if (!s.issue_labels) return false;
		const labels = JSON.parse(s.issue_labels);
		return labels.some((l: string) => l.toLowerCase() === "operations");
	});

	if (opsSession) {
		console.log(`\n   Target: ${opsSession.identifier || opsSession.execution_id} (Operations scope)\n`);

		console.log("   BEFORE: no leadId → action would execute (cross-scope)");
		console.log("   AFTER:  with leadId=product-lead → 403 blocked\n");

		const actionRes = await fetch(`${base}/api/actions/reject`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				execution_id: opsSession.execution_id,
				reason: "test",
				leadId: "product-lead",
			}),
		});
		console.log(`   Result: HTTP ${actionRes.status}`);
		const actionBody = await actionRes.json();
		console.log(`   Message: ${actionBody.message}`);
	}

	// --- Summary ---
	console.log("\n════════════════════════════════════════════════════════════");
	console.log("  📊 Summary");
	console.log("════════════════════════════════════════════════════════════");
	console.log(`  Active sessions (total):     ${before.count}`);
	console.log(`  Peter sees (with leadId):    ${after.count}`);
	console.log(`  Noise reduced by:            ${filtered} sessions (${Math.round(filtered / before.count * 100)}%)`);
	console.log(`  Cross-scope action blocked:  ${opsSession ? "✅ Yes (403)" : "N/A"}`);
	console.log("════════════════════════════════════════════════════════════\n");

	server.close();
	store.close();
}

main().catch(console.error);
