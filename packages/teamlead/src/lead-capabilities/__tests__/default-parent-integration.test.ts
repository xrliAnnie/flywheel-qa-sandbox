import { EventEmitter } from "node:events";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestLeadOperation } from "flywheel-comm/lead-operation-client";
import { parse } from "smol-toml";
import { expect, it, vi } from "vitest";
import type { CodexLeadRuntimeConfig } from "../../lead-backends/codex/codex-lead-runtime.js";
import {
	buildTuiGeneration,
	parseCodexLeadTuiRuntimeConfig,
} from "../../lead-backends/codex/codex-lead-tui-runtime.js";
import { SqliteJournalStore } from "../../lead-backends/codex/SqliteJournalStore.js";
import { LEAD_CAPABILITY_CATALOG } from "../catalog.js";
import { startDefaultLeadCapabilityParent } from "../default-runtime.js";
import { NATIVE_CODEX_SKILL_NAMES } from "../native-skills.js";
import { UPSTREAM_TOOL_ROWS } from "../upstream-inputs.js";

const state = vi.hoisted(() => ({
	project: "",
	closed: [] as string[],
	windows: [] as any[],
}));
vi.mock("../../lead-backends/codex/tui-window.js", async (original) => ({
	...(await original<object>()),
	ensureTuiWindow: (spec: unknown) => {
		state.windows.push(spec);
		return true;
	},
	isTuiWindowAlive: () => true,
}));
vi.mock("../../lead-backends/codex/ProcessLifetimeFileLock.js", () => ({
	acquireProcessLifetimeFileLock: async () => ({
		status: "acquired",
		handle: { close: async () => {} },
	}),
}));
vi.mock("node:child_process", async (original) => ({
	...(await original<object>()),
	execFileSync: () => "codex-cli 0.153.2\n",
}));
vi.mock("../deployment.js", () => ({
	verifyLeadDeployment: () => ({
		schemaVersion: 1,
		checkoutRoot: "fixture",
		headSha: "a".repeat(40),
		entrySha256: {},
		observedAt: "fixture",
	}),
}));
vi.mock("../runtime-context.js", () => ({
	createLeadCapabilityContext: () => ({
		projectRoot: state.project,
		assertActivationCurrent: () => ({
			project: { projectName: "fixture", projectRepo: "owner/repo" },
			lead: {
				agentId: "lead",
				summaryRole: "producer",
				backend: "codex-app-server",
				codexProfile: "full-access",
				codexCapabilityBundleVersion: 2,
				canSpawnRunners: true,
				codexRunnerActions: true,
			},
			identity: {
				projectName: "fixture",
				leadId: "lead",
				backend: "codex-app-server",
				role: "dept",
				identityDigest: "d".repeat(64),
				hasSummaryDuty: false,
			},
		}),
	}),
}));
vi.mock("../../workflow-menu.js", () => ({
	resolveLeadMenus: () => [{ shape: "implement" }],
}));
vi.mock("../skill-discovery.js", async () => {
	const { recordActualLeadRuleSources } = await import("../rule-sources.js");
	return {
		discoverLeadRuleSources: () => ({
			records: recordActualLeadRuleSources([
				{
					sourceId: "persona",
					layer: "persona",
					sourcePath: join(state.project, "persona.md"),
				},
			]),
			skillInventory: [],
		}),
	};
});
vi.mock("../model-isolation.js", () => ({
	verifyModelIsolation: async () => {},
}));
vi.mock("../native-skill-baseline.js", async () => {
	const { createHash } = await import("node:crypto");
	const { NATIVE_CODEX_SKILL_NAMES } = await import("../native-skills.js");
	const sources = NATIVE_CODEX_SKILL_NAMES.map((name) => ({
		name,
		sha256: createHash("sha256")
			.update(
				`---\nname: ${name}\ndescription: Fixture native skill.\n---\nFixture.\n`,
			)
			.digest("hex"),
	}));
	const baseline = {
		codexVersion: "0.153.2",
		sources,
		origin: {
			root: "/fixture/native",
			files: sources.map((source) => ({
				path: `${source.name}/SKILL.md`,
				sha256: source.sha256,
			})),
		},
	};
	return {
		PINNED_NATIVE_CODEX_SKILLS: baseline,
		resolvePinnedNativeSkillBaseline: () => baseline,
	};
});
async function upstream(id: string) {
	return {
		handlers: new Map(
			LEAD_CAPABILITY_CATALOG.filter(
				(op) =>
					op.credentialConsumer === id &&
					op.classification === "read" &&
					(id !== "xiaohongshu-mcp" ||
						UPSTREAM_TOOL_ROWS.some(
							(row) =>
								row.serverId === id && row.operationId === op.operationId,
						)),
			).map((op) => [
				op.operationId,
				{
					authorize: async () => {},
					execute: async () => ({ status: "unknown" as const }),
				},
			]),
		),
		integration: { id, version: "fixture", toolSchemaDigest: "0".repeat(64) },
		close: async () => {
			state.closed.push(id);
		},
	};
}
vi.mock("../gbrain-provider.js", () => ({
	startGbrainProvider: () => upstream("gbrain"),
}));
vi.mock("../xiaohongshu-provider.js", () => ({
	startXiaohongshuProvider: () => upstream("xiaohongshu-mcp"),
}));
vi.mock("../context7-provider.js", () => ({
	startContext7Provider: () => upstream("context7"),
}));
vi.mock("../browser-provider.js", () => ({
	startBrowserProvider: async () => ({
		generation: "11111111-1111-4111-8111-111111111111",
		proxyPort: 31999,
		handlers: new Map(
			LEAD_CAPABILITY_CATALOG.filter(
				(op) => op.credentialConsumer === "browser",
			).map((op) => [
				op.operationId,
				{
					authorize: async () => {},
					execute: async () => ({ status: "unknown" as const }),
				},
			]),
		),
		close: async () => {
			state.closed.push("browser");
		},
	}),
}));

it("executes the default factory, real provider assembly and parent broker with fixture host inputs", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "df-")));
	const home = join(root, ".codex-fixture");
	state.project = join(root, "project");
	state.closed = [];
	mkdirSync(state.project);
	writeFileSync(
		join(state.project, "persona.md"),
		"Fixture Lead governance. Use typed tools.",
	);
	mkdirSync(home, { mode: 0o700 });
	for (const name of NATIVE_CODEX_SKILL_NAMES) {
		const dir = join(home, "skills/.system", name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "SKILL.md"),
			`---\nname: ${name}\ndescription: Fixture native skill.\n---\nFixture.\n`,
		);
	}
	vi.stubEnv("HOME", root);
	vi.stubEnv("LINEAR_API_KEY", "SYNTHETIC_LINEAR");
	vi.stubEnv("GH_TOKEN", "SYNTHETIC_GITHUB");
	vi.stubEnv("FLYWHEEL_PROJECTS_FILE", join(root, "projects.json"));
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: unknown, init?: RequestInit) => {
			if (
				String(url) === "https://discord.com/api/v10/users/@me" &&
				(!init?.method || init.method === "GET")
			)
				return Response.json({ id: "111111111111111111", bot: true });
			throw new Error("unexpected_external_network");
		}),
	);
	const journal = new SqliteJournalStore(join(root, "journal.db"));
	let parent:
		| Awaited<ReturnType<typeof startDefaultLeadCapabilityParent>>
		| undefined;
	try {
		parent = await startDefaultLeadCapabilityParent({
			config: {
				capabilityBundleVersion: 2,
				fullAccessProjectRoot: state.project,
				projectName: "fixture",
				leadId: "lead",
				identityDigest: "d".repeat(64),
				bridgeUrl: "http://127.0.0.1:31998",
				apiToken: "SYNTHETIC_BRIDGE",
				botToken: "SYNTHETIC_DISCORD",
				codexBin: process.execPath,
				codexHome: home,
			} as CodexLeadRuntimeConfig,
			journal,
			carrierInstanceId: "SYNTHETIC_CARRIER",
		});
		expect(parent.skillSources?.native).toHaveLength(6);
		const manifest = JSON.parse(readFileSync(parent.pins.manifestPath, "utf8"));
		expect(manifest.operationIds).toContain("start_runner");
		const result = await requestLeadOperation(parent.pins.brokerSocket, {
			schemaVersion: 1,
			requestId: "22222222-2222-4222-8222-222222222222",
			operationId: "artifact.text.create",
			input: { text: "Isolated report", mimeType: "text/plain" },
		});
		expect(result.status).toBe("succeeded");
		expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC_/);
		expect(fetch).not.toHaveBeenCalled();

		const stateDir = join(root, "state");
		mkdirSync(stateDir, { mode: 0o700 });
		const threadId = "33333333-3333-4333-8333-333333333333";
		mkdirSync(join(home, "sessions"));
		writeFileSync(
			join(home, "sessions", `rollout-${threadId}.jsonl`),
			"fixture rollout",
		);
		const config = parseCodexLeadTuiRuntimeConfig({
			FLYWHEEL_LEAD_ID: "lead",
			FLYWHEEL_PROJECT_NAME: "fixture",
			FLYWHEEL_LEAD_KEY: "fixture-lead",
			FLYWHEEL_LEAD_BACKEND: "codex-app-server",
			FLYWHEEL_LEAD_IDENTITY_DIGEST: "d".repeat(64),
			DISCORD_EXPECTED_BOT_USER_ID: "111111111111111111",
			DISCORD_BOT_TOKEN: "SYNTHETIC_DISCORD",
			FLYWHEEL_LEAD_CHAT_CHANNEL_ID: "222222222222222222",
			FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:31998",
			FLYWHEEL_API_TOKEN: "SYNTHETIC_BRIDGE",
			FLYWHEEL_CODEX_LEAD_OUTBOUND: "bridge",
			FLYWHEEL_CODEX_LEAD_STATE_DIR: stateDir,
			FLYWHEEL_CODEX_BIN: process.execPath,
			CODEX_HOME: home,
			FLYWHEEL_COMM_DB: join(root, "comm.db"),
			FLYWHEEL_CODEX_TUI_CWD: state.project,
		});
		Object.assign(config, {
			capabilityBundleVersion: 2,
			codexProfile: "full-access",
			fullAccessProjectRoot: state.project,
			channelIds: [],
			typingEnabled: false,
		});
		const methods: string[] = [];
		let wrongConfig = false;
		const createWs = () => {
			const ws = Object.assign(new EventEmitter(), {
				send(data: string) {
					const message = JSON.parse(data);
					methods.push(message.method);
					if (message.id === undefined) return;
					queueMicrotask(() => {
						if (message.method === "initialize")
							for (const name of parent!.mcp.included)
								ws.emit(
									"message",
									JSON.stringify({
										method: "mcpServer/startupStatus/updated",
										params: { name, status: "ready" },
									}),
								);
						const result =
							message.method === "config/read"
								? {
										config: {
											...parse(readFileSync(join(home, "config.toml"), "utf8")),
											...parse(
												parent!.mcp.argv
													.filter((_, i) => i % 2 === 1)
													.join("\n"),
											),
										},
									}
								: message.method === "skills/list"
									? {
											data: [
												{
													cwd: state.project,
													skills: parent!.skillSources!.native.map(
														(source) => ({
															name: source.name,
															path: source.sourcePath,
															scope: "system",
															enabled: true,
														}),
													),
												},
											],
										}
									: message.method === "thread/start" ||
											message.method === "thread/resume"
										? {
												thread: { id: threadId },
												approvalPolicy: "never",
												cwd: state.project,
												activePermissionProfile: {
													id: "flywheel-lead-v2",
													extends: ":workspace",
												},
											}
										: {};
						if (message.method === "config/read" && wrongConfig)
							Object.assign((result as { config: object }).config, {
								default_permissions: "foreign",
							});
						ws.emit("message", JSON.stringify({ id: message.id, result }));
					});
				},
				close() {
					ws.emit("close");
				},
				terminate() {
					ws.emit("close");
				},
			});
			return ws;
		};
		state.windows = [];
		const makeGeneration = buildTuiGeneration(
			config,
			{ info: () => {}, warn: () => {}, error: () => {} },
			{
				capabilitySession: {
					parent,
					journal,
					socket: {
						path: join(root, "app.sock"),
						assertCurrent: async () => parent!.assertCurrent(),
					},
				},
				connectDaemon: async () => createWs() as never,
				createSender: () =>
					({
						enqueue: async () => "fixture",
						deliver: async () => {},
						close: () => {},
					}) as never,
				preflight: async () => {},
			},
		);
		const generation = makeGeneration();
		try {
			await generation.start();
			expect(methods).toContain("thread/start");
			expect(methods.filter((method) => method === "config/read")).toHaveLength(
				2,
			);
			expect(methods.filter((method) => method === "skills/list")).toHaveLength(
				2,
			);
			expect(state.windows).toHaveLength(1);
			expect(state.windows[0]).toMatchObject({
				threadId,
				codexHome: home,
				capabilitySocketPath: join(root, "app.sock"),
			});
			expect(fetch).toHaveBeenCalledTimes(1);
		} finally {
			await generation.stop();
		}
		const resumed = makeGeneration();
		try {
			await resumed.start();
			expect(
				methods.filter((method) => method === "thread/start"),
			).toHaveLength(1);
			expect(
				methods.filter((method) => method === "thread/resume"),
			).toHaveLength(1);
			expect(methods.filter((method) => method === "config/read")).toHaveLength(
				4,
			);
			expect(methods.filter((method) => method === "skills/list")).toHaveLength(
				4,
			);
			expect(state.windows).toHaveLength(1);
			expect(fetch).toHaveBeenCalledTimes(2);
		} finally {
			await resumed.stop();
		}
		wrongConfig = true;
		const rejected = makeGeneration();
		try {
			await expect(rejected.start()).rejects.toThrow();
		} finally {
			await rejected.stop();
		}
		expect(methods.filter((method) => method === "thread/resume")).toHaveLength(
			1,
		);
		expect(fetch).toHaveBeenCalledTimes(2);
		await parent.assertCurrent();
		expect(journal.getById("absent")).toBeUndefined();
		const socket = parent.pins.brokerSocket,
			artifacts = parent.pins.artifactRoot;
		await parent.close();
		expect(existsSync(socket)).toBe(false);
		expect(existsSync(artifacts)).toBe(false);
		expect(state.closed).toEqual([
			"browser",
			"context7",
			"xiaohongshu-mcp",
			"gbrain",
		]);
		console.info(
			`FLY2519_DEFAULT_FACTORY=${JSON.stringify({ schemaVersion: 1, scope: "fixture", operationId: "artifact.text.create", result, nativeSourcesVerified: parent.skillSources?.native.length, tuiGeneration: { methods, sameWindowPreserved: state.windows.length === 1, wrongConfigRejected: true }, realComponents: ["default factory", "provider assembly", "parent", "native source verification", "rule loading", "UDS broker", "TUI generation", "SQLite journal", "artifact handler"], fixtureBoundaries: ["Codex version", "deployment receipt", "registry authority", "menu and source selection", "native source pins", "browser", "upstream services", "model isolation", "app-server WS", "terminal window", "process locks", "Discord identity response", "outbound preflight"], cleanup: { socketRemoved: !existsSync(socket), artifactsRemoved: !existsSync(artifacts) }, hostVerified: false })}`,
		);
	} finally {
		await parent?.close();
		journal.close();
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		rmSync(root, { recursive: true, force: true });
	}
}, 15000);
