import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import {
	hashCarrierInstanceId,
	LeadLeaseModeStore,
	writeCarrierAuthorizationEvidenceSnapshot,
	writeCarrierReceipt,
} from "flywheel-comm/lead-lease";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLeadLeaseDiagnosticsRouter } from "../bridge/lead-lease-diagnostics.js";
import { tokenAuthMiddleware } from "../bridge/plugin.js";

const NOW = Date.parse("2026-07-16T12:00:00.000Z");
const LEAD_KEY = "flywheel-codex-lead";
const RAW_CLAIM = "must-never-appear-in-diagnostics";
const IDENTITY_DIGEST = "d".repeat(64);

describe("FLY-1309 Bridge lead lease diagnostics endpoint", () => {
	let dir: string;
	let env: NodeJS.ProcessEnv;
	let server: Server;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1309-diagnostics-route-"));
		env = {
			FLYWHEEL_PROJECTS_FILE: join(dir, "projects.json"),
			FLYWHEEL_LEAD_LEASE_DB: join(dir, "lease.db"),
			FLYWHEEL_LEAD_LEASE_MODE_FILE: join(dir, "mode.json"),
			FLYWHEEL_LEAD_CARRIER_ASSERTION_DIR: join(dir, "assertions"),
			FLYWHEEL_LEAD_CARRIER_EVIDENCE_FILE: join(dir, "evidence.json"),
			FLYWHEEL_LEAD_RECEIPT_DIR: join(dir, "receipts"),
			FLYWHEEL_ALERT_QUEUE_DIR: join(dir, "queue"),
			FLYWHEEL_ALERT_DEADLETTER_DIR: join(dir, "dead"),
			FLYWHEEL_LEAD_EPISODE_DB: join(dir, "episodes.db"),
		};
		writeFileSync(
			env.FLYWHEEL_PROJECTS_FILE!,
			JSON.stringify([
				{
					projectName: "flywheel",
					leads: [
						{
							agentId: "codex-lead",
							backend: "codex-app-server",
							summaryRole: "producer",
						},
					],
				},
			]),
		);
		new LeadLeaseModeStore(env.FLYWHEEL_LEAD_LEASE_MODE_FILE!, env).set(
			"audit_only",
			"test",
		);
		writeCarrierAuthorizationEvidenceSnapshot({
			env,
			collectedAt: new Date(NOW).toISOString(),
			leads: {
				[LEAD_KEY]: {
					leadKey: LEAD_KEY,
					backend: "codex-app-server",
					identityDigest: IDENTITY_DIGEST,
					pid: 777,
					lstart: "carrier-start",
					instanceDigest: hashCarrierInstanceId(RAW_CLAIM),
				},
			},
		});
		writeCarrierReceipt(env.FLYWHEEL_LEAD_RECEIPT_DIR!, {
			schemaVersion: 1,
			contractVersion: 1,
			leadKey: LEAD_KEY,
			identityDigest: IDENTITY_DIGEST,
			instanceDigest: hashCarrierInstanceId(RAW_CLAIM),
			pid: 777,
			lstart: "carrier-start",
			checkedAt: new Date(NOW).toISOString(),
			cliDisposition: "carrier_passthrough",
			bridgeDisposition: "carrier_passthrough",
		});
		const app = express();
		app.use(
			"/api/lead-lease/diagnostics",
			tokenAuthMiddleware("token"),
			createLeadLeaseDiagnosticsRouter({
				env,
				authorizationDeps: {
					now: () => NOW,
					processAliveWithStart: (pid, lstart) =>
						pid === 777 && lstart === "carrier-start",
					processEnvHas: () => false,
				},
			}),
		);
		server = createServer(app);
		server.listen(0);
	});

	afterEach(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(dir, { recursive: true, force: true });
	});

	async function get(token?: string) {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("not bound");
		const response = await fetch(
			`http://127.0.0.1:${address.port}/api/lead-lease/diagnostics`,
			{
				headers:
					token === undefined ? {} : { Authorization: `Bearer ${token}` },
			},
		);
		return {
			status: response.status,
			body: (await response.json()) as Record<string, unknown>,
		};
	}

	it("requires the master bearer token", async () => {
		expect((await get()).status).toBe(401);
		expect((await get("wrong")).status).toBe(401);
	});

	it("returns the full secret-free readiness schema", async () => {
		const result = await get("token");
		expect(result.status).toBe(200);
		expect(result.body).toMatchObject({
			schemaVersion: 1,
			healthy: true,
			paths: {
				leaseDb: env.FLYWHEEL_LEAD_LEASE_DB,
				modeFile: env.FLYWHEEL_LEAD_LEASE_MODE_FILE,
				projectsFile: env.FLYWHEEL_PROJECTS_FILE,
				carrierAssertionDir: env.FLYWHEEL_LEAD_CARRIER_ASSERTION_DIR,
				queueDir: env.FLYWHEEL_ALERT_QUEUE_DIR,
				deadLetterDir: env.FLYWHEEL_ALERT_DEADLETTER_DIR,
				episodeDb: env.FLYWHEEL_LEAD_EPISODE_DB,
			},
			mode: { mode: "audit_only", source: "file" },
			resolver: { status: "ok", ambiguousLeadIds: [] },
			audit: { pending: 0, deadLettered: 0, storeHealthy: true },
			episodes: {
				healthy: true,
				active: 0,
				counts: { unmaterialized: 0, queued: 0, dead_lettered: 0 },
			},
			leads: [
				{
					leadKey: LEAD_KEY,
					ready: true,
					processModeOverridePresent: false,
					backendDrift: { drifted: false },
					carrierInstanceReady: {
						ready: true,
						evidencePidAlive: true,
					},
				},
			],
		});
		expect(JSON.stringify(result.body)).not.toContain(RAW_CLAIM);
	});

	it("reports identity source failure without exposing parser internals as a 500", async () => {
		writeFileSync(env.FLYWHEEL_PROJECTS_FILE!, "{broken");
		const result = await get("token");
		expect(result.status).toBe(200);
		expect(result.body).toMatchObject({
			healthy: false,
			resolver: { status: "source_error" },
		});
	});
});
