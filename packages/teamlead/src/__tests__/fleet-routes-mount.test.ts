import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAllFlags } from "flywheel-config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanonicalRequest } from "../bridge/fleet-admin.js";
import { FleetConsole } from "../bridge/fleet-console.js";
import { ManagementChangeCoordinator } from "../bridge/management-change-coordinator.js";
import { buildTargetId } from "../bridge/management-console-contract.js";
import { buildTopologyView } from "../bridge/management-topology-source.js";
import {
	type ManagementWriter,
	ManagementWriterRegistry,
	preparedChange,
} from "../bridge/management-writer.js";
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

const MANAGEMENT_TARGET = buildTargetId("runner", [
	"geo",
	"default",
	"dispatch",
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
	let manualSpawnQa: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "fleet-mount-"));
		const projectsJsonPath = join(dir, "projects.json");
		writeFileSync(projectsJsonPath, PROJECTS_JSON);
		const stub = join(dir, "stub-fleet.sh");
		writeFileSync(stub, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
		const dagFlags = resolveAllFlags({
			env: {},
			envFile: { status: "readable", content: "" },
		});
		console_ = new FleetConsole({
			projectsJsonPath,
			txnDir: join(dir, "fleet-txns"),
			auditDbPath: join(dir, "audit.db"),
			fleetScriptPath: stub,
			logDir: join(dir, "fleet-logs"),
			liveProjects: () => testProjects,
			legacyBackendOf: () => undefined,
			featureFlags: () => dagFlags,
			managementSnapshotProviders: () => [
				{
					id: "topology",
					sourceKind: "projects_json",
					read: () => ({
						revision: "file:test-projects",
						fragment: buildTopologyView({
							projects: testProjects,
							configs: new Map(
								testProjects.map((project) => [
									project.projectName,
									{ revision: `file:${project.projectName}` },
								]),
							),
							projectsRevision: "file:test-projects",
						}),
					}),
				},
				{
					id: "flags",
					sourceKind: "flag_registry",
					read: () => ({
						revision: "registry:test-flags",
						fragment: {
							flags: [],
						},
					}),
				},
			],
		});
		let managementValue = "old";
		const managementWriter: ManagementWriter = {
			id: "mount-test-runner",
			kind: "runner",
			resolve: (targetId) =>
				targetId === MANAGEMENT_TARGET
					? {
							targetId,
							kind: "runner",
							currentValue: managementValue,
							sourceRevision: "file:runner-v1",
							writeCapability: {
								writable: true,
								consequence: "new-run",
								requiresAcknowledgement: false,
							},
						}
					: null,
			preflight(target, desired, observed) {
				if (observed !== target.sourceRevision || typeof desired !== "string") {
					return { ok: false, code: "stale_source", reason: "invalid" };
				}
				return preparedChange({
					writer: managementWriter,
					target,
					newValue: desired,
				});
			},
			apply(change) {
				managementValue = change.newValue as string;
				return { status: "applied" };
			},
		};
		console_.setManagementCoordinator(
			new ManagementChangeCoordinator({
				registry: new ManagementWriterRegistry([managementWriter]),
				tokens: console_.tokens,
				audit: console_.audit,
				journalDir: join(dir, "fleet-txns"),
				snapshotRevision: () => "snapshot:mount-test",
			}),
		);
		store = await StateStore.create(":memory:");
		manualSpawnQa = vi.fn(async () => ({
			status: "spawned" as const,
			qaExecutionId: "qa-server-owned",
		}));
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
			{
				fleetConsole: console_,
				autoQaCoordinator: {
					current: { manualSpawnQa } as never,
				},
			},
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

	it("GET /api/fleet/snapshot returns the versioned secret-free aggregate with NO Bearer", async () => {
		const res = await fetch(`${baseUrl}/api/fleet/snapshot`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			schemaVersion: number;
			projects: Array<{ leads: Array<Record<string, unknown>> }>;
		};
		expect(body.schemaVersion).toBe(1);
		expect(
			body.projects
				.flatMap((project) => project.leads)
				.map((lead) => lead.leadId)
				.sort(),
		).toEqual(["oliver", "peter"]);
		// Secret canary: the bot token must NEVER appear anywhere in the payload.
		const raw = JSON.stringify(body);
		expect(raw).not.toContain("super-secret-bot-token");
		expect(raw).not.toContain("botToken");
	});

	it("GET /api/fleet/flag-report.html?interactive=1 omits retired workflow rollout controls", async () => {
		const res = await fetch(
			`${baseUrl}/api/fleet/flag-report.html?interactive=1`,
		);
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).not.toContain("DAG 控制");
		expect(html).not.toContain("data-dag-copy");
		expect(html).not.toContain("workflow_claims_write");
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

	it("unified stage/apply routes are loopback + same-origin and persist a canonical item result", async () => {
		const cross = await fetch(`${baseUrl}/api/fleet/changes/stage`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: "http://evil" },
			body: JSON.stringify({ changes: [] }),
		});
		expect(cross.status).toBe(403);

		const forged = await fetch(`${baseUrl}/api/fleet/changes/stage`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: baseUrl },
			body: JSON.stringify({
				changes: [
					{
						targetId: MANAGEMENT_TARGET,
						desiredValue: "new",
						observedRevision: "file:runner-v1",
						projectRoot: "/forged",
					},
				],
			}),
		});
		expect(forged.status).toBe(400);

		const stagedResponse = await fetch(`${baseUrl}/api/fleet/changes/stage`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: baseUrl },
			body: JSON.stringify({
				changes: [
					{
						targetId: MANAGEMENT_TARGET,
						desiredValue: "new",
						observedRevision: "file:runner-v1",
					},
				],
			}),
		});
		expect(stagedResponse.status).toBe(200);
		const staged = (await stagedResponse.json()) as {
			batch: unknown;
			confirmToken: string;
		};
		const applied = await fetch(`${baseUrl}/api/fleet/changes/apply`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: baseUrl },
			body: JSON.stringify(staged),
		});
		expect(applied.status).toBe(200);
		expect(await applied.json()).toMatchObject({
			status: "applied",
			items: [{ targetId: MANAGEMENT_TARGET, status: "applied" }],
		});
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

	it("FLY-1251: manual QA stage→spawn is same-origin, token-bound, and rejects executor injection", async () => {
		const input = { executionId: "main-1", prHeadSha: "a".repeat(40) };
		const rejected = await fetch(`${baseUrl}/api/qa/manual-spawn/stage`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: baseUrl },
			body: JSON.stringify({ ...input, qaExecutionId: "qa-attacker" }),
		});
		expect(rejected.status).toBe(400);

		const stagedResponse = await fetch(`${baseUrl}/api/qa/manual-spawn/stage`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: baseUrl },
			body: JSON.stringify(input),
		});
		expect(stagedResponse.status).toBe(200);
		const staged = (await stagedResponse.json()) as { confirmToken: string };

		const applied = await fetch(`${baseUrl}/api/qa/manual-spawn`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: baseUrl,
				"x-flywheel-confirm-token": staged.confirmToken,
			},
			body: JSON.stringify(input),
		});
		expect(applied.status).toBe(202);
		expect(manualSpawnQa).toHaveBeenCalledWith("main-1", "a".repeat(40));
	});

	it("stage→apply happy path: same-origin, confirmToken, launching+spawn (202)", async () => {
		const sameOrigin = baseUrl; // browser Origin === the host it was served from
		const stageRes = await fetch(`${baseUrl}/api/fleet/stage`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: sameOrigin },
			body: JSON.stringify({
				changes: [{ key: "geo-peter", toModel: "claude-opus-5" }],
			}),
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
			body: JSON.stringify({
				changes: [{ key: "geo-peter", toModel: "claude-opus-5" }],
			}),
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
		expect(html).toContain("<title>Flywheel 管理台</title>");
		expect(html).toContain("/api/fleet/snapshot");
		expect(html).toContain("/api/fleet/changes/stage");
	});

	it("legacy /sse still serves a snapshot (byte-compat, unaffected)", async () => {
		const res = await fetch(`${baseUrl}/sse`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		// Drain the one-shot snapshot so the connection closes.
		await res.text();
	});
});
