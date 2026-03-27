/**
 * GEO-259: Quick E2E verification script for lead data isolation.
 *
 * Usage: npx tsx scripts/test-lead-scope.ts
 *
 * Starts a temporary Bridge with multi-lead config, seeds test data,
 * and verifies leadId filtering works on all endpoints.
 */

import { createBridgeApp } from "../packages/teamlead/src/bridge/plugin.js";
import { StateStore } from "../packages/teamlead/src/StateStore.js";
import type { ProjectEntry } from "../packages/teamlead/src/ProjectConfig.js";

const projects: ProjectEntry[] = [
	{
		projectName: "geoforge3d",
		projectRoot: "/tmp/geoforge3d",
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
	const app = createBridgeApp(store, projects, {
		host: "127.0.0.1",
		port: 0,
		dbPath: ":memory:",
		notificationChannel: "test",
		defaultLeadAgentId: "product-lead",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300000,
		orphanThresholdMinutes: 60,
	});

	const server = app.listen(0, "127.0.0.1");
	await new Promise<void>((r) => server.once("listening", r));
	const addr = server.address();
	const port = typeof addr === "object" && addr ? addr.port : 0;
	const base = `http://127.0.0.1:${port}`;

	// Seed data: 2 product sessions, 1 ops session
	store.upsertSession({
		execution_id: "prod-1",
		issue_id: "i1",
		project_name: "geoforge3d",
		status: "running",
		issue_identifier: "GEO-100",
		issue_title: "Product Feature A",
		issue_labels: JSON.stringify(["Product"]),
	});
	store.upsertSession({
		execution_id: "prod-2",
		issue_id: "i2",
		project_name: "geoforge3d",
		status: "awaiting_review",
		issue_identifier: "GEO-101",
		issue_title: "Product Feature B",
		issue_labels: JSON.stringify(["Product"]),
	});
	store.upsertSession({
		execution_id: "ops-1",
		issue_id: "i3",
		project_name: "geoforge3d",
		status: "running",
		issue_identifier: "GEO-102",
		issue_title: "Ops Task",
		issue_labels: JSON.stringify(["Operations"]),
	});

	let passed = 0;
	let failed = 0;

	async function test(name: string, fn: () => Promise<void>) {
		try {
			await fn();
			console.log(`  ✅ ${name}`);
			passed++;
		} catch (err) {
			console.log(`  ❌ ${name}: ${(err as Error).message}`);
			failed++;
		}
	}

	function assert(condition: boolean, msg: string) {
		if (!condition) throw new Error(msg);
	}

	console.log("\n🧪 GEO-259 Lead Data Isolation — E2E Verification\n");
	console.log(`Bridge running at ${base}\n`);

	// --- GET /api/sessions ---
	console.log("📋 GET /api/sessions");

	await test("No leadId → returns all 3 sessions", async () => {
		const res = await fetch(`${base}/api/sessions`);
		const body = await res.json();
		assert(body.count === 3, `Expected 3, got ${body.count}`);
	});

	await test("leadId=product-lead → returns 2 sessions", async () => {
		const res = await fetch(`${base}/api/sessions?leadId=product-lead`);
		const body = await res.json();
		assert(body.count === 2, `Expected 2, got ${body.count}`);
		const ids = body.sessions.map((s: any) => s.execution_id).sort();
		assert(
			JSON.stringify(ids) === '["prod-1","prod-2"]',
			`Got ${JSON.stringify(ids)}`,
		);
	});

	await test("leadId=ops-lead → returns 1 session", async () => {
		const res = await fetch(`${base}/api/sessions?leadId=ops-lead`);
		const body = await res.json();
		assert(body.count === 1, `Expected 1, got ${body.count}`);
		assert(body.sessions[0].execution_id === "ops-1", "Wrong session");
	});

	await test("leadId=unknown → returns 0 sessions", async () => {
		const res = await fetch(`${base}/api/sessions?leadId=unknown`);
		const body = await res.json();
		assert(body.count === 0, `Expected 0, got ${body.count}`);
	});

	await test("mode=by_identifier ignores leadId", async () => {
		const res = await fetch(
			`${base}/api/sessions?mode=by_identifier&identifier=GEO-102&leadId=product-lead`,
		);
		const body = await res.json();
		assert(body.count === 1, `Expected 1, got ${body.count}`);
		assert(body.sessions[0].execution_id === "ops-1", "Should return ops session despite product-lead filter");
	});

	// --- GET /api/resolve-action ---
	console.log("\n📋 GET /api/resolve-action");

	await test("No leadId → finds ops session for terminate", async () => {
		const res = await fetch(
			`${base}/api/resolve-action?issue_id=i3&action=terminate`,
		);
		const body = await res.json();
		assert(body.can_execute === true, `Expected can_execute=true`);
	});

	await test("leadId=product-lead on ops issue → can_execute=false", async () => {
		const res = await fetch(
			`${base}/api/resolve-action?issue_id=i3&action=terminate&leadId=product-lead`,
		);
		const body = await res.json();
		assert(body.can_execute === false, `Expected can_execute=false`);
	});

	await test("leadId=product-lead on product issue → can_execute=true", async () => {
		const res = await fetch(
			`${base}/api/resolve-action?issue_id=i2&action=approve&leadId=product-lead`,
		);
		const body = await res.json();
		assert(body.can_execute === true, `Expected can_execute=true`);
	});

	// --- POST /api/actions ---
	console.log("\n📋 POST /api/actions (scope check)");

	await test("reject without leadId → succeeds", async () => {
		// Use ops session which is awaiting_review
		// Actually prod-2 is awaiting_review, ops-1 is running. Let's use prod-2.
		// But we need a session we haven't rejected yet. Let's create one.
		store.upsertSession({
			execution_id: "action-test-1",
			issue_id: "i-action",
			project_name: "geoforge3d",
			status: "awaiting_review",
			issue_labels: JSON.stringify(["Product"]),
		});
		const res = await fetch(`${base}/api/actions/reject`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ execution_id: "action-test-1", reason: "test" }),
		});
		const body = await res.json();
		assert(body.success === true, `Expected success, got: ${body.message}`);
	});

	await test("reject with matching leadId → succeeds", async () => {
		store.upsertSession({
			execution_id: "action-test-2",
			issue_id: "i-action-2",
			project_name: "geoforge3d",
			status: "awaiting_review",
			issue_labels: JSON.stringify(["Product"]),
		});
		const res = await fetch(`${base}/api/actions/reject`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				execution_id: "action-test-2",
				reason: "test",
				leadId: "product-lead",
			}),
		});
		const body = await res.json();
		assert(body.success === true, `Expected success, got: ${body.message}`);
	});

	await test("reject with mismatching leadId → 403", async () => {
		store.upsertSession({
			execution_id: "action-test-3",
			issue_id: "i-action-3",
			project_name: "geoforge3d",
			status: "awaiting_review",
			issue_labels: JSON.stringify(["Operations"]),
		});
		const res = await fetch(`${base}/api/actions/reject`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				execution_id: "action-test-3",
				reason: "test",
				leadId: "product-lead",
			}),
		});
		assert(res.status === 403, `Expected 403, got ${res.status}`);
		const body = await res.json();
		assert(body.success === false, "Expected failure");
	});

	// Summary
	console.log(`\n${"=".repeat(50)}`);
	console.log(`Results: ${passed} passed, ${failed} failed`);
	console.log(`${"=".repeat(50)}\n`);

	server.close();
	store.close();
	process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
