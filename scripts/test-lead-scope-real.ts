#!/usr/bin/env npx tsx
/**
 * GEO-259: Test lead scope filtering against REAL Bridge data.
 *
 * Starts a temporary Bridge on port 19876, seeds it with sessions
 * from the running Bridge, then tests leadId filtering.
 *
 * Usage: npx tsx scripts/test-lead-scope-real.ts
 */

import type { ProjectEntry } from "../packages/teamlead/src/ProjectConfig.js";
import { createBridgeApp } from "../packages/teamlead/src/bridge/plugin.js";
import { StateStore } from "../packages/teamlead/src/StateStore.js";

const TEST_PORT = 19876;

// Real project config (hardcoded to avoid botTokenEnv validation)
const projects: ProjectEntry[] = [
	{
		projectName: "geoforge3d",
		projectRoot: "/Users/xiaorongli/Dev/GeoForge3D",
		leads: [
			{
				agentId: "product-lead",
				forumChannel: "1485787822119194755",
				chatChannel: "1485787822894878955",
				match: { labels: ["Product"] },
			},
			{
				agentId: "ops-lead",
				forumChannel: "1485789340989915266",
				chatChannel: "1485789342541680661",
				match: { labels: ["Operations"] },
			},
		],
	},
];

async function main() {
	console.log("\n📋 Config: geoforge3d with 2 leads");
	console.log("  - product-lead (labels: Product)");
	console.log("  - ops-lead (labels: Operations)");

	// Fetch real sessions from running Bridge
	const store = await StateStore.create(":memory:");
	let seedCount = 0;
	try {
		const res = await fetch("http://localhost:9876/api/sessions?mode=recent&limit=200");
		const data = await res.json();
		console.log(`\n📦 Fetched ${data.count} sessions from running Bridge (port 9876)`);
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
			seedCount++;
		}
	} catch {
		console.log("\n⚠️  Cannot reach running Bridge — aborting");
		process.exit(1);
	}

	// Start test Bridge with new code
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
	console.log(`\n🔧 Test Bridge (new code) running at ${base}`);
	console.log(`   Seeded ${seedCount} real sessions\n`);

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

	// === Sessions filtering ===
	console.log("═══════════════════════════════════════════════════");
	console.log("  TEST 1: GET /api/sessions — lead scope filtering");
	console.log("═══════════════════════════════════════════════════\n");

	const noFilter = await (await fetch(`${base}/api/sessions?mode=recent&limit=200`)).json();
	const productFilter = await (await fetch(`${base}/api/sessions?mode=recent&limit=200&leadId=product-lead`)).json();
	const opsFilter = await (await fetch(`${base}/api/sessions?mode=recent&limit=200&leadId=ops-lead`)).json();

	console.log(`  Total (no filter):  ${noFilter.count} sessions`);
	console.log(`  product-lead:       ${productFilter.count} sessions`);
	console.log(`  ops-lead:           ${opsFilter.count} sessions`);
	console.log();

	await test("No filter returns >= product-lead count", async () => {
		if (noFilter.count < productFilter.count)
			throw new Error(`${noFilter.count} < ${productFilter.count}`);
	});

	await test("product-lead sessions have correct labels", async () => {
		for (const s of productFilter.sessions) {
			if (!s.issue_labels) continue; // no labels = general match to first lead
			const labels: string[] = JSON.parse(s.issue_labels);
			const hasProduct = labels.some((l) => l.toLowerCase() === "product");
			if (!hasProduct) {
				throw new Error(
					`Session ${s.identifier || s.execution_id} has labels [${labels.join(",")}] — not Product`,
				);
			}
		}
	});

	await test("ops-lead sessions have Operations labels", async () => {
		for (const s of opsFilter.sessions) {
			if (!s.issue_labels) continue;
			const labels: string[] = JSON.parse(s.issue_labels);
			const hasOps = labels.some((l) => l.toLowerCase() === "operations");
			if (!hasOps) {
				throw new Error(
					`Session ${s.identifier || s.execution_id} has labels [${labels.join(",")}] — not Operations`,
				);
			}
		}
	});

	await test("No overlap: ops sessions not in product results", async () => {
		const productIds = new Set(productFilter.sessions.map((s: any) => s.execution_id));
		const opsIds = new Set(opsFilter.sessions.map((s: any) => s.execution_id));
		for (const id of opsIds) {
			if (productIds.has(id)) {
				throw new Error(`Session ${id} appears in both product and ops results`);
			}
		}
	});

	// Show what each Lead sees
	console.log("\n  ┌─────────────────────────────────────────────────");
	console.log("  │ 🧑‍💻 Peter (product-lead) sees:");
	console.log("  ├─────────────────────────────────────────────────");
	for (const s of productFilter.sessions.slice(0, 8)) {
		console.log(`  │  ${(s.identifier || "?").padEnd(12)} ${s.status.padEnd(20)} labels=${s.issue_labels || "N/A"}`);
	}
	if (productFilter.count > 8) console.log(`  │  ... and ${productFilter.count - 8} more`);
	console.log("  └─────────────────────────────────────────────────");

	console.log("\n  ┌─────────────────────────────────────────────────");
	console.log("  │ 🐱 Oliver (ops-lead) sees:");
	console.log("  ├─────────────────────────────────────────────────");
	for (const s of opsFilter.sessions.slice(0, 8)) {
		console.log(`  │  ${(s.identifier || "?").padEnd(12)} ${s.status.padEnd(20)} labels=${s.issue_labels || "N/A"}`);
	}
	if (opsFilter.count > 8) console.log(`  │  ... and ${opsFilter.count - 8} more`);
	if (opsFilter.count === 0) console.log("  │  (no sessions — all routes to product-lead as default)");
	console.log("  └─────────────────────────────────────────────────");

	// === Actions scope check ===
	console.log("\n═══════════════════════════════════════════════════");
	console.log("  TEST 2: POST /api/actions — scope check (403)");
	console.log("═══════════════════════════════════════════════════\n");

	const productAwaiting = productFilter.sessions.find(
		(s: any) => s.status === "awaiting_review",
	);
	if (productAwaiting) {
		await test(`Cross-scope: reject ${productAwaiting.identifier || productAwaiting.execution_id} with ops-lead → 403`, async () => {
			const res = await fetch(`${base}/api/actions/reject`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					execution_id: productAwaiting.execution_id,
					reason: "scope test",
					leadId: "ops-lead",
				}),
			});
			if (res.status !== 403)
				throw new Error(`Expected 403, got ${res.status}`);
			const body = await res.json();
			if (!body.message.includes("outside lead"))
				throw new Error(`Unexpected message: ${body.message}`);
		});
	} else {
		console.log("  ⏭️  No product awaiting_review session — skipping");
	}

	// === resolve-action scope-aware ===
	console.log("\n═══════════════════════════════════════════════════");
	console.log("  TEST 3: resolve-action — scope-aware selection");
	console.log("═══════════════════════════════════════════════════\n");

	const opsActionable = opsFilter.sessions.find((s: any) =>
		["running", "awaiting_review", "failed"].includes(s.status),
	);
	if (opsActionable) {
		await test(`resolve ops issue ${opsActionable.identifier || "?"} with product-lead → can_execute=false`, async () => {
			const res = await fetch(
				`${base}/api/resolve-action?issue_id=${opsActionable.issue_id || `issue-${opsActionable.execution_id}`}&action=reject&leadId=product-lead`,
			);
			const body = await res.json();
			if (body.can_execute !== false)
				throw new Error(`Expected false, got ${JSON.stringify(body)}`);
		});
	} else {
		console.log("  ⏭️  No ops actionable session — skipping");
	}

	// === by_identifier ignores leadId ===
	console.log("\n═══════════════════════════════════════════════════");
	console.log("  TEST 4: by_identifier — ignores leadId");
	console.log("═══════════════════════════════════════════════════\n");

	if (opsFilter.sessions.length > 0 && opsFilter.sessions[0].identifier) {
		const opsIdent = opsFilter.sessions[0].identifier;
		await test(`by_identifier ${opsIdent} with product-lead → still returns it`, async () => {
			const res = await fetch(
				`${base}/api/sessions?mode=by_identifier&identifier=${opsIdent}&leadId=product-lead`,
			);
			const body = await res.json();
			if (body.count !== 1)
				throw new Error(`Expected 1, got ${body.count}`);
		});
	}

	// Summary
	console.log(`\n${"═".repeat(50)}`);
	console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
	console.log(`${"═".repeat(50)}\n`);

	server.close();
	store.close();
	process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
