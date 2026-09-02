import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAllFlags } from "flywheel-config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { publishFableTemplateAlias } from "../bin/publish-fable-template-alias.js";
import { FleetConsole } from "../bridge/fleet-console.js";
import { ManagementChangeCoordinator } from "../bridge/management-change-coordinator.js";
import { createManagementDagProvider } from "../bridge/management-dag-source.js";
import { createManagementDagWriter } from "../bridge/management-existing-writers.js";
import { buildTopologyView } from "../bridge/management-topology-source.js";
import { ManagementWriterRegistry } from "../bridge/management-writer.js";
import { createBridgeApp } from "../bridge/plugin.js";
import type { BridgeConfig } from "../bridge/types.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";
import {
	compileWorkflowMenuSeed,
	loadWorkflowMenuLibrary,
} from "../workflow-menu.js";
import { workflowSeedContentHash } from "../workflow-template.js";

function config(): BridgeConfig {
	return {
		host: "127.0.0.1",
		port: 0,
		dbPath: ":memory:",
		ingestToken: "ingest-secret",
		apiToken: "api-secret",
		notificationChannel: "test-channel",
		defaultLeadAgentId: "lead",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300_000,
		orphanThresholdMinutes: 60,
	};
}

function oldPinnedCodeSeed() {
	const compiled = compileWorkflowMenuSeed(
		loadWorkflowMenuLibrary().find((menu) => menu.shape === "code")!,
	);
	const { contentHash: _contentHash, ...body } = compiled;
	const seed = {
		...body,
		manifest: {
			...body.manifest,
			nodes: body.manifest.nodes.map((node) =>
				node.id === "eng_design" ? { ...node, model: "claude-fable-5" } : node,
			),
		},
	};
	return { ...seed, contentHash: workflowSeedContentHash(seed) };
}

describe("publish-fable-template-alias CLI", () => {
	let root: string;
	let store: StateStore;
	let fleet: FleetConsole;
	let server: http.Server;
	let baseUrl: string;
	let project: ProjectEntry;

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "fly2238-template-publish-"));
		project = {
			projectName: "flywheel",
			projectRoot: root,
			leads: [],
		};
		store = await StateStore.create(":memory:");
		const seed = oldPinnedCodeSeed();
		store.importWorkflowTemplateSeed(seed);
		store.bindWorkflowCategory({
			project: "flywheel",
			taskCategory: "code",
			templateId: "tpl_code",
			updatedBy: "test",
		});

		const projectsPath = join(root, "projects.json");
		writeFileSync(projectsPath, JSON.stringify([project]));
		const fleetScript = join(root, "fleet.sh");
		writeFileSync(fleetScript, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		const dagProvider = createManagementDagProvider({
			reader: store,
			projectNames: () => ["flywheel"],
		});
		fleet = new FleetConsole({
			projectsJsonPath: projectsPath,
			txnDir: join(root, "transactions"),
			auditDbPath: join(root, "audit.db"),
			fleetScriptPath: fleetScript,
			logDir: join(root, "logs"),
			liveProjects: () => [project],
			legacyBackendOf: () => undefined,
			featureFlags: () =>
				resolveAllFlags({
					env: {},
					envFile: { status: "readable", content: "" },
				}),
			managementSnapshotProviders: () => [
				{
					id: "topology",
					sourceKind: "projects_json" as const,
					read: () => ({
						revision: "file:test-projects",
						fragment: buildTopologyView({
							projects: [project],
							configs: new Map([
								["flywheel", { revision: "file:test-config" }],
							]),
							projectsRevision: "file:test-projects",
						}),
					}),
				},
				dagProvider,
			],
		});
		const writer = createManagementDagWriter({
			store,
			projectNames: () => ["flywheel"],
			actor: "founder-management-console",
		});
		fleet.setManagementCoordinator(
			new ManagementChangeCoordinator({
				registry: new ManagementWriterRegistry([writer]),
				tokens: fleet.tokens,
				audit: fleet.audit,
				journalDir: join(root, "transactions"),
				snapshotRevision: () =>
					fleet.buildManagementSnapshot().snapshotRevision,
			}),
		);

		const app = createBridgeApp(
			store,
			[project],
			config(),
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
			{ fleetConsole: fleet },
		);
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		baseUrl = `http://127.0.0.1:${port}`;
	});

	afterEach(async () => {
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
		store.close();
		fleet.close();
		rmSync(root, { recursive: true, force: true });
	});

	const publish = (fetchImpl: typeof fetch = fetch) =>
		publishFableTemplateAlias(
			{ templateId: "tpl_code", nodeId: "eng_design" },
			{
				env: { FLYWHEEL_BRIDGE_URL: baseUrl },
				fetch: fetchImpl,
			},
		);

	it("requires exact same-origin HTTP and the CLI supplies base.origin", async () => {
		const missingOrigin = await fetch(`${baseUrl}/api/fleet/changes/stage`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ changes: [] }),
		});
		expect(missingOrigin.status).toBe(403);

		const origins: string[] = [];
		const observedFetch: typeof fetch = async (input, init) => {
			const headers = new Headers(init?.headers);
			origins.push(headers.get("Origin") ?? "");
			return fetch(input, init);
		};
		expect(await publish(observedFetch)).toMatchObject({ status: "published" });
		expect(origins.length).toBeGreaterThan(0);
		expect(new Set(origins)).toEqual(new Set([new URL(baseUrl).origin]));
	});

	it("publishes only eng_design as alias, founder-owns the seed, and repeats as a no-op", async () => {
		const before = JSON.parse(
			store.getWorkflowTemplateRevision("tpl_code", 1)!.manifest,
		) as { nodes: Array<Record<string, unknown>> };
		const first = await publish();
		expect(first).toEqual({
			status: "published",
			templateId: "tpl_code",
			nodeId: "eng_design",
			revision: 2,
			seedOwner: "founder",
			consequence: "new-run",
		});
		expect(store.getWorkflowTemplate("tpl_code")).toMatchObject({
			current_published_revision: 2,
			seed_owner: "founder",
		});
		const after = JSON.parse(
			store.getWorkflowTemplateRevision("tpl_code", 2)!.manifest,
		) as { nodes: Array<Record<string, unknown>> };
		expect(after.nodes.find((node) => node.id === "eng_design")?.model).toBe(
			"fable",
		);
		expect(after.nodes.filter((node) => node.id !== "eng_design")).toEqual(
			before.nodes.filter((node) => node.id !== "eng_design"),
		);

		const second = await publish();
		expect(second).toEqual({
			status: "no_op",
			templateId: "tpl_code",
			nodeId: "eng_design",
			revision: 2,
			seedOwner: "founder",
			consequence: "new-run",
		});
		expect(
			store
				.listWorkflowTemplateRevisions("tpl_code")
				.map((row) => row.revision),
		).toEqual([1, 2]);
	});

	it("re-reads and retries a bounded CAS race without losing the concurrent node edit", async () => {
		let raced = false;
		const racingFetch: typeof fetch = async (input, init) => {
			const url = String(input);
			if (!raced && url.endsWith("/api/fleet/changes/apply")) {
				raced = true;
				const current = store.getWorkflowTemplate("tpl_code")!;
				const row = store.getWorkflowTemplateRevision(
					"tpl_code",
					current.current_published_revision!,
				)!;
				const manifest = JSON.parse(row.manifest);
				manifest.nodes = manifest.nodes.map((node: Record<string, unknown>) =>
					node.id === "implement" ? { ...node, effort: "high" } : node,
				);
				expect(
					store.createAndPublishWorkflowTemplateRevision({
						templateId: "tpl_code",
						manifest,
						expectedRevision: current.current_published_revision!,
						createdBy: "concurrent-editor",
						allowUnsupportedModels: true,
					}),
				).toMatchObject({ status: "published", revision: 2 });
			}
			return fetch(input, init);
		};

		const result = await publish(racingFetch);
		expect(result).toMatchObject({ status: "published", revision: 3 });
		const final = JSON.parse(
			store.getWorkflowTemplateRevision("tpl_code", 3)!.manifest,
		) as { nodes: Array<Record<string, unknown>> };
		expect(final.nodes.find((node) => node.id === "eng_design")?.model).toBe(
			"fable",
		);
		expect(final.nodes.find((node) => node.id === "implement")?.effort).toBe(
			"high",
		);
	});

	it("fails closed when readback cannot prove founder seed ownership", async () => {
		const unownedSnapshotFetch: typeof fetch = async (input, init) => {
			const response = await fetch(input, init);
			if (!String(input).endsWith("/api/fleet/snapshot")) return response;
			const body = (await response.json()) as {
				projects: Array<{ dags: Array<Record<string, unknown>> }>;
			};
			for (const project of body.projects) {
				for (const dag of project.dags) {
					if (dag.templateId === "tpl_code") dag.seedOwner = "system";
				}
			}
			return new Response(JSON.stringify(body), {
				status: response.status,
				headers: { "Content-Type": "application/json" },
			});
		};

		await expect(publish(unownedSnapshotFetch)).rejects.toThrow(
			/founder ownership/i,
		);
	});

	it("fails closed on malformed stage JSON without leaking the confirm token", async () => {
		let confirmToken = "";
		const malformedStageFetch: typeof fetch = async (input, init) => {
			const response = await fetch(input, init);
			if (!String(input).endsWith("/api/fleet/changes/stage")) return response;
			const body = (await response.clone().json()) as { confirmToken: string };
			confirmToken = body.confirmToken;
			return new Response("{", {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		let failure: unknown;
		try {
			await publish(malformedStageFetch);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toMatch(/malformed.*JSON/i);
		expect(confirmToken).not.toBe("");
		expect((failure as Error).message).not.toContain(confirmToken);
		expect(
			store.getWorkflowTemplate("tpl_code")?.current_published_revision,
		).toBe(1);
	});

	it("rejects non-loopback Bridge URLs before issuing a request", async () => {
		let calls = 0;
		const neverFetch: typeof fetch = async () => {
			calls += 1;
			return new Response();
		};
		await expect(
			publishFableTemplateAlias(
				{ templateId: "tpl_code", nodeId: "eng_design" },
				{
					env: { FLYWHEEL_BRIDGE_URL: "https://bridge.example.test" },
					fetch: neverFetch,
				},
			),
		).rejects.toThrow(/loopback/i);
		expect(calls).toBe(0);
	});
});
