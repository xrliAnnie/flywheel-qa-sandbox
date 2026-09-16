import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import type http from "node:http";
import { dirname, join } from "node:path";
import { resolveLeadIdentity } from "flywheel-comm/lead-identity";
import { compileSummaryAssignments } from "flywheel-comm/summary-assignment";
import { readSummaryGranularity } from "flywheel-comm/summary-config";
import { afterEach, expect, it, vi } from "vitest";
import { createProductionLeadConfigService } from "../bridge/lead-config-production.js";
import { createBridgeApp } from "../bridge/plugin.js";
import { RunnerAdmissionController } from "../bridge/runner-admission.js";
import { CodexLeadInboxServer } from "../lead-backends/codex/CodexLeadInboxSocket.js";
import { NativeLeadRuntimeConfig } from "../lead-backends/codex/NativeLeadRuntimeConfig.js";
import * as sourceModule from "../lead-runtime-tuning.js";
import { StateStore } from "../StateStore.js";

const roots: string[] = [];
const stores: StateStore[] = [];
const servers: http.Server[] = [];
const sockets: CodexLeadInboxServer[] = [];
const natives: NativeLeadRuntimeConfig[] = [];
afterEach(async () => {
	for (const s of servers.splice(0))
		await new Promise<void>((resolve) => s.close(() => resolve()));
	for (const s of sockets.splice(0)) await s.close();
	for (const n of natives.splice(0)) n.close();
	for (const s of stores.splice(0)) s.close();
	vi.restoreAllMocks();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
it("publishes, converges same-value readback, and rolls back through HTTP, registry lock, DB audit and signed socket", async () => {
	const home = mkdtempSync("/tmp/lcfg-http-");
	roots.push(home);
	mkdirSync(join(home, ".flywheel"));
	writeFileSync(
		join(home, ".flywheel/summary-config.json"),
		JSON.stringify({
			granularity: "per-lead",
			setBy: "founder",
			setAt: "2026-09-16T00:00:00Z",
		}),
	);
	const projectsPath = join(home, ".flywheel/projects.json"),
		receiptPath = join(
			home,
			".flywheel/state/summary-registry/migration-receipt.json",
		);
	const raw = [
		{
			projectName: "raya",
			projectRoot: home,
			leads: [
				{
					agentId: "raya",
					summaryRole: "producer",
					backend: "codex-app-server",
					botTokenEnv: "RAYA_BOT_TOKEN",
					botUserId: "12345678901234567",
					chatChannel: "12345678901234568",
					match: { labels: ["Engineering"] },
					codexProfile: "full-access",
					canSpawnRunners: true,
					codexRunnerActions: true,
					model: "gpt-6-astra",
					effort: "low",
				},
			],
		},
	];
	const source = JSON.stringify(raw);
	writeFileSync(projectsPath, source);
	const summaryAssignmentDigest = compileSummaryAssignments(
		raw,
		readSummaryGranularity({ homeDir: home }),
	).digest;
	mkdirSync(dirname(receiptPath), { recursive: true });
	writeFileSync(
		receiptPath,
		JSON.stringify({
			schemaVersion: 1,
			postImageSha256: createHash("sha256").update(source).digest("hex"),
			summaryAssignmentDigest,
			granularity: "per-lead",
			migratedAt: "2026-09-16T00:00:00Z",
			assignments: [
				{ projectName: "raya", leadId: "raya", summaryRole: "producer" },
			],
			projectAggregators: [],
		}),
	);

	const store = await StateStore.create(join(home, "teamlead.db"));
	stores.push(store);
	const identity = resolveLeadIdentity({
		projectsPath,
		projectName: "raya",
		leadId: "raya",
		homeDir: home,
	});
	const actualRead = sourceModule.readLeadRuntimeSource;
	vi.spyOn(sourceModule, "readLeadRuntimeSource").mockImplementation((config) =>
		actualRead(config, { home, receiptPath }),
	);
	let pair = { model: "gpt-6-astra", effort: "low" };
	const proc = Object.assign(new EventEmitter(), {
		readThreadSettings: vi.fn(async () => ({ ...pair })),
		updateThreadSettings: vi.fn(
			async (value: { threadId: string; model: string; effort: string }) => {
				const changed =
					pair.model !== value.model || pair.effort !== value.effort;
				pair = { model: value.model, effort: value.effort };
				if (changed)
					proc.emit("notification", "thread/settings/updated", {
						threadId: value.threadId,
						threadSettings: pair,
					});
			},
		),
	});
	const native = new NativeLeadRuntimeConfig({
		config: {
			stateDir: home,
			projectsFile: projectsPath,
			projectName: "raya",
			leadId: "raya",
			leadKey: identity.leadKey,
			identityDigest: identity.identityDigest,
			botUserId: identity.botUserId!,
		},
		process: proc,
		build: {
			artifactBuildSha: "a".repeat(40),
			bootstrapBuildSha: "a".repeat(40),
		},
		log: vi.fn(),
	});
	natives.push(native);
	await native.bootstrap("same-thread", {
		model: pair.model,
		reasoningEffort: "low",
	});
	const inbox = new CodexLeadInboxServer({
		socketPath: join(home, "lead-inbox.sock"),
		leadId: "raya",
		authSecret: "test-secret",
		socketOwnerId: native.socketOwnerId,
		router: { submitBatch: vi.fn() },
		runtimeConfig: native.hooks,
	});
	sockets.push(inbox);
	native.bindOwner(() => inbox.runtimeConfigOwnerCurrent());
	await inbox.listen();
	const service = createProductionLeadConfigService(store, "a".repeat(40), {
		home,
		root: new URL("../../../../", import.meta.url).pathname,
		env: { RAYA_BOT_TOKEN: "test-secret" },
		stateDir: () => home,
	});
	const app = createBridgeApp(
		store,
		[],
		{
			host: "127.0.0.1",
			port: 0,
			dbPath: join(home, "teamlead.db"),
			notificationChannel: "test",
			defaultLeadAgentId: "test",
			stuckThresholdMinutes: 15,
			stuckCheckIntervalMs: 300000,
			orphanThresholdMinutes: 60,
			runnerAdmission: RunnerAdmissionController.alwaysAdmit(),
		},
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
		{ leadConfigService: service },
	);
	const server = app.listen(0, "127.0.0.1");
	servers.push(server);
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("address_missing");
	const base = `http://127.0.0.1:${address.port}`;
	const post = async (path: string, body: unknown) => {
		const response = await fetch(`${base}/api/lead-config/${path}`, {
			method: "POST",
			headers: { origin: base, "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		const value = await response.json();
		expect(response.status, JSON.stringify(value)).toBe(200);
		return value;
	};
	const receiptBefore = readFileSync(receiptPath, "utf8");
	const staged = await post("stage", {
		projectName: "raya",
		leadId: "raya",
		effort: "high",
		reason: "isolated hot apply",
	});
	const applied = await post("apply", staged);
	expect(applied.effectiveStatus).toBe("applied");
	expect(pair.effort).toBe("high");
	const originalId = staged.canonical.intent.operationId;
	expect(
		store
			.listLeadConfigAudit(originalId)
			.some((row) => row.to_status === "applied"),
	).toBe(true);
	const noOp = await post("stage", {
		projectName: "raya",
		leadId: "raya",
		effort: "high",
		reason: "isolated same-value apply",
	});
	const noOpApplied = await post("apply", noOp);
	expect(noOpApplied.effectiveStatus).toBe("applied");
	expect(pair.effort).toBe("high");
	expect(proc.updateThreadSettings).toHaveBeenCalledTimes(2);
	const noOpReceipt = store
		.listLeadConfigAudit(noOp.canonical.intent.operationId)
		.map((row) => JSON.parse(row.detail).receipt)
		.find(Boolean);
	expect(noOpReceipt?.readback).toMatchObject({
		source: "native_readback",
		model: "gpt-6-astra",
		effort: "high",
	});
	const rollback = await post("stage", {
		rollbackOperationId: originalId,
		reason: "isolated rollback",
	});
	expect((await post("apply", rollback)).effectiveStatus).toBe("applied");
	expect(pair.effort).toBe("low");
	expect(readFileSync(receiptPath, "utf8")).toBe(receiptBefore);
	expect(
		JSON.parse(readFileSync(projectsPath, "utf8"))[0].leads[0].effort,
	).toBe("low");
	expect(proc.updateThreadSettings).toHaveBeenCalledTimes(3);
	const edited = JSON.parse(readFileSync(projectsPath, "utf8"));
	edited[0].leads[0].effort = "high";
	const external = `${JSON.stringify(edited)}\n\n`;
	writeFileSync(projectsPath, external);
	await service.reconcile();
	const observed = store.listLeadConfigOperations("raya-raya").at(-1)!;
	expect(observed.input.actor).toBe("external_registry_change");
	expect(observed.status).toBe("applied");
	expect(pair.effort).toBe("high");
	expect(readFileSync(projectsPath, "utf8")).toBe(external);
	expect(readFileSync(receiptPath, "utf8")).toBe(receiptBefore);
	expect(proc.updateThreadSettings).toHaveBeenCalledTimes(4);
	expect(native.hooks.identity().threadId).toBe("same-thread");
}, 30000);
