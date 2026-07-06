import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CanonicalRequest } from "../bridge/fleet-admin.js";
import { FleetConsole } from "../bridge/fleet-console.js";
import { createBridgeApp } from "../bridge/plugin.js";
import type { BridgeConfig } from "../bridge/types.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

const testProjects: ProjectEntry[] = [
	{
		projectName: "geo",
		projectRoot: "/tmp/geo",
		leads: [
			{
				agentId: "peter",
				chatChannel: "c1",
				match: { labels: ["product"] },
				model: "claude-fable-5",
			},
			{
				agentId: "oliver",
				chatChannel: "c2",
				match: { labels: ["ops"] },
				botTokenEnv: "SECRET_TOKEN_VAR",
				botToken: "super-secret-bot-token",
			},
		],
	},
];

const PROJECTS_JSON = JSON.stringify([
	{
		projectName: "geo",
		projectRoot: "/tmp/geo",
		leads: [
			{
				agentId: "peter",
				chatChannel: "c1",
				match: { labels: ["product"] },
				model: "claude-fable-5",
			},
			{ agentId: "oliver", chatChannel: "c2", match: { labels: ["ops"] } },
		],
	},
]);

function makeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
	return {
		host: "127.0.0.1",
		port: 0,
		dbPath: ":memory:",
		ingestToken: "ingest-secret",
		apiToken: "api-secret", // Bearer-gated /api/* — fleet routes must bypass it.
		notificationChannel: "test-channel",
		defaultLeadAgentId: "peter",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300000,
		orphanThresholdMinutes: 60,
		...overrides,
	};
}

describe("FLY-247 inc2a — fleet console route mounting", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;
	let dir: string;
	let console_: FleetConsole;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "fleet-mount-"));
		const projectsJsonPath = join(dir, "projects.json");
		writeFileSync(projectsJsonPath, PROJECTS_JSON);
		const stub = join(dir, "stub-fleet.sh");
		writeFileSync(stub, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
		console_ = new FleetConsole({
			projectsJsonPath,
			txnDir: join(dir, "fleet-txns"),
			auditDbPath: join(dir, "audit.db"),
			fleetScriptPath: stub,
			logDir: join(dir, "fleet-logs"),
			liveProjects: () => testProjects,
			legacyBackendOf: () => undefined,
		});
		store = await StateStore.create(":memory:");
		const app = createBridgeApp(
			store,
			testProjects,
			makeConfig(),
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{ fleetConsole: console_ },
		);
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		baseUrl = `http://127.0.0.1:${port}`;
	});

	afterEach(async () => {
		await new Promise<void>((resolve, reject) =>
			server.close((err) => (err ? reject(err) : resolve())),
		);
		store.close();
		console_.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("GET /api/fleet/snapshot returns the secret-free DTO with NO Bearer", async () => {
		const res = await fetch(`${baseUrl}/api/fleet/snapshot`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			leads: Array<Record<string, unknown>>;
		};
		expect(body.leads.map((l) => l.leadId).sort()).toEqual(["oliver", "peter"]);
		// Secret canary: the bot token must NEVER appear anywhere in the payload.
		const raw = JSON.stringify(body);
		expect(raw).not.toContain("super-secret-bot-token");
		expect(raw).not.toContain("botToken");
	});

	it("POST /api/fleet/stage rejects cross-origin (anti-CSRF)", async () => {
		const res = await fetch(`${baseUrl}/api/fleet/stage`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: "http://evil.test",
			},
			body: JSON.stringify({ changes: [{ key: "geo-peter", toModel: null }] }),
		});
		expect(res.status).toBe(403);
	});

	it("FLY-709: flag stage/apply routes are mounted (cross-origin 403; unknown flag 400)", async () => {
		// cross-origin rejected (anti-CSRF), same guard as the fleet routes
		const cross = await fetch(`${baseUrl}/api/fleet/flag/stage`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: "http://evil.test",
			},
			body: JSON.stringify({ name: "auto_qa_killswitch", to: false }),
		});
		expect(cross.status).toBe(403);
		// same-origin + unknown flag → 400 (reaches the handler; rejected before any
		// .env read, so this proves the mount without touching ~/.flywheel/.env)
		const unknown = await fetch(`${baseUrl}/api/fleet/flag/stage`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: baseUrl },
			body: JSON.stringify({ name: "totally-not-a-flag", to: false }),
		});
		expect(unknown.status).toBe(400);
		// apply requires canonical + confirmToken
		const badApply = await fetch(`${baseUrl}/api/fleet/flag/apply`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: baseUrl },
			body: JSON.stringify({}),
		});
		expect(badApply.status).toBe(400);
	});

	it("stage→apply happy path: same-origin, confirmToken, launching+spawn (202)", async () => {
		const sameOrigin = baseUrl; // browser Origin === the host it was served from
		const stageRes = await fetch(`${baseUrl}/api/fleet/stage`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: sameOrigin },
			body: JSON.stringify({ changes: [{ key: "geo-peter", toModel: null }] }),
		});
		expect(stageRes.status).toBe(200);
		const staged = (await stageRes.json()) as {
			batchId: string;
			canonicalRequest: CanonicalRequest;
			confirmToken: string;
		};
		expect(staged.confirmToken).toBeTruthy();
		expect(staged.canonicalRequest.changes[0].from.model).toBe(
			"claude-fable-5",
		);

		const applyRes = await fetch(`${baseUrl}/api/fleet/apply`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: sameOrigin },
			body: JSON.stringify({
				batch: staged.canonicalRequest,
				confirmToken: staged.confirmToken,
			}),
		});
		expect(applyRes.status).toBe(202);
		const applied = (await applyRes.json()) as { accepted: boolean };
		expect(applied.accepted).toBe(true);
		// audit recorded staged + apply-requested.
		const rows = console_.audit.forBatch(staged.batchId);
		expect(rows.some((r) => r.event === "staged")).toBe(true);
		expect(rows.some((r) => r.event === "apply-requested")).toBe(true);
	});

	it("apply with a replayed/forged token → 401 + denied audit", async () => {
		const sameOrigin = baseUrl;
		const stageRes = await fetch(`${baseUrl}/api/fleet/stage`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: sameOrigin },
			body: JSON.stringify({ changes: [{ key: "geo-peter", toModel: null }] }),
		});
		const staged = (await stageRes.json()) as {
			batchId: string;
			canonicalRequest: CanonicalRequest;
			confirmToken: string;
		};
		const res = await fetch(`${baseUrl}/api/fleet/apply`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: sameOrigin },
			body: JSON.stringify({
				batch: staged.canonicalRequest,
				confirmToken: "forged-token",
			}),
		});
		expect(res.status).toBe(401);
		const denied = console_.audit
			.forBatch(staged.batchId)
			.filter((r) => r.event === "denied");
		expect(denied.length).toBeGreaterThanOrEqual(1);
	});

	it("GET / renders the Fleet console (not the legacy dashboard) when wired", async () => {
		const res = await fetch(`${baseUrl}/`);
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("Flywheel Fleet");
		expect(html).toContain("/api/fleet/snapshot");
	});

	it("legacy /sse still serves a snapshot (byte-compat, unaffected)", async () => {
		const res = await fetch(`${baseUrl}/sse`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		// Drain the one-shot snapshot so the connection closes.
		await res.text();
	});
});
