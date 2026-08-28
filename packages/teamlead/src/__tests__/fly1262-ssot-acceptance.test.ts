import { execFile } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import type http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
	applyRunnerDefaults,
	type FlagView,
	type FlywheelConfig,
	resolveAllFlags,
} from "flywheel-config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { FleetConsole } from "../bridge/fleet-console.js";
import { ManagementChangeCoordinator } from "../bridge/management-change-coordinator.js";
import {
	fileSourceRevision,
	type ManagementSnapshotV1,
} from "../bridge/management-console-contract.js";
import {
	createManagementCronProvider,
	scanManagementCrons,
} from "../bridge/management-cron-source.js";
import { ManagementCronWriter } from "../bridge/management-cron-writer.js";
import { createManagementDagProvider } from "../bridge/management-dag-source.js";
import {
	createExistingManagementWriters,
	createManagementCronWriterAdapter,
	createManagementDagWriter,
	createManagementFlagProvider,
	createManagementRunnerProvider,
	managementFlagRevision,
} from "../bridge/management-existing-writers.js";
import {
	type ManagementSectionProvider,
	ManagementSectionRegistry,
} from "../bridge/management-section-registry.js";
import { createManagementSsotProviders } from "../bridge/management-ssot-providers.js";
import type { LoadedProjectConfig } from "../bridge/management-topology-source.js";
import { ManagementWriterRegistry } from "../bridge/management-writer.js";
import { createBridgeApp } from "../bridge/plugin.js";
import type { BridgeConfig } from "../bridge/types.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";
import { importLegacyWorkflowSeeds } from "./fixtures/legacy-workflow-manifests.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const QA_SCRIPT = resolve(
	HERE,
	"../../../../scripts/qa-fly-1262-management-dashboard.mjs",
);
const execFileAsync = promisify(execFile);

function config(root: string): BridgeConfig {
	return {
		host: "127.0.0.1",
		port: 0,
		dbPath: ":memory:",
		ingestToken: "ingest-secret",
		apiToken: "api-secret",
		notificationChannel: "test",
		defaultLeadAgentId: "alpha-lead",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300_000,
		orphanThresholdMinutes: 60,
		fleetConsole: { enabled: true, txnDir: join(root, "txns") },
	};
}

class LaunchctlStub {
	readonly commands: string[][] = [];
	readonly loaded = new Set<string>();
	readonly disabled = new Set<string>();

	private label(value: string): string {
		return value.split("/").at(-1) ?? value;
	}

	execFile = (file: string, args: readonly string[]): string => {
		if (file === "plutil") {
			if (args.includes("json") && args.includes("-")) {
				return readFileSync(String(args.at(-1)), "utf8");
			}
			return "";
		}
		const command = [...args];
		this.commands.push(command);
		const action = command[0];
		if (action === "print-disabled") {
			return [...this.disabled].map((label) => `"${label}" => true`).join("\n");
		}
		if (action === "print") {
			if (!this.loaded.has(this.label(command[1]!)))
				throw new Error("not loaded");
			return "service = { state = running }";
		}
		if (action === "bootout") {
			this.loaded.delete(this.label(command[1]!));
			return "";
		}
		if (action === "disable") {
			this.disabled.add(this.label(command[1]!));
			return "";
		}
		if (action === "enable") {
			this.disabled.delete(this.label(command[1]!));
			return "";
		}
		if (action === "bootstrap") {
			const plist = JSON.parse(readFileSync(command[2]!, "utf8")) as {
				Label: string;
			};
			this.loaded.add(plist.Label);
			return "";
		}
		throw new Error(`unexpected launchctl command: ${command.join(" ")}`);
	};
}

describe("FLY-1262 PRD section 6 acceptance", () => {
	let root: string;
	let projectRoot: string;
	let configPath: string;
	let envPath: string;
	let launchAgentsDir: string;
	let server: http.Server;
	let baseUrl: string;
	let store: StateStore;
	let fleet: FleetConsole;
	let projects: ProjectEntry[];
	let extraFlags: FlagView[];
	let env: Record<string, string | undefined>;
	let launchctl: LaunchctlStub;

	function currentConfigs(): Map<string, LoadedProjectConfig> {
		const bytes = readFileSync(configPath);
		return new Map([
			[
				"alpha",
				{
					config: parse(bytes.toString("utf8")) as FlywheelConfig,
					revision: fileSourceRevision(bytes),
				},
			],
		]);
	}

	function projectsRevision(): string {
		return fileSourceRevision(Buffer.from(JSON.stringify(projects)));
	}

	function scanCrons() {
		return scanManagementCrons({
			launchAgentsDir,
			projects,
			uid: process.getuid?.() ?? 0,
			deps: {
				readdir: readdirSync,
				lstat: lstatSync,
				realpath: realpathSync,
				readFile: readFileSync,
				execFile: launchctl.execFile,
			},
		});
	}

	function writeCron(
		name: string,
		label: string,
		script: string,
		time = { Weekday: 1, Hour: 9, Minute: 0 },
	): string {
		const path = join(launchAgentsDir, name);
		writeFileSync(
			path,
			JSON.stringify({
				Label: label,
				ProgramArguments: ["/bin/bash", script],
				StartCalendarInterval: time,
			}),
		);
		return path;
	}

	async function snapshot(): Promise<ManagementSnapshotV1> {
		const response = await fetch(`${baseUrl}/api/fleet/snapshot`);
		expect(response.status).toBe(200);
		return (await response.json()) as ManagementSnapshotV1;
	}

	async function post(path: string, body: unknown) {
		return fetch(`${baseUrl}${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: baseUrl },
			body: JSON.stringify(body),
		});
	}

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "fly1262-acceptance-"));
		projectRoot = join(root, "alpha");
		configPath = join(projectRoot, ".flywheel", "config.yaml");
		envPath = join(root, ".flywheel.env");
		launchAgentsDir = join(root, "LaunchAgents");
		mkdirSync(dirname(configPath), { recursive: true });
		mkdirSync(launchAgentsDir, { recursive: true });
		const projectConfig = [
			"project: alpha",
			"linear:",
			"  team_id: FLY",
			"runners:",
			"  default: claude",
			"  available:",
			"    claude:",
			"      type: claude",
			"teams:",
			"  - name: default",
			"    orchestrators: []",
			"decision_layer:",
			"  autonomy_level: manual_only",
			"  escalation_channel: discord",
			"roles:",
			"  runner:",
			"    backend: claude-tmux",
			"    model: claude-opus-4-8",
			"agents:",
			"  alpha:",
			"    agent_file: .flywheel/agents/engineering/alpha-executor.md",
			"    department: engineering",
			"    match:",
			"      labels: [engineering]",
			"",
		].join("\n");
		writeFileSync(configPath, projectConfig);
		writeFileSync(envPath, "SECRET_CANARY=must-not-leak\n");
		const script = join(projectRoot, "tasks", "daily.sh");
		mkdirSync(dirname(script), { recursive: true });
		writeFileSync(script, "#!/bin/sh\n");
		writeCron("alpha-daily.plist", "org.example.alpha-daily", script);

		projects = [
			{
				projectName: "alpha",
				projectRoot,
				projectRepo: "example/alpha",
				leads: [
					{
						agentId: "alpha-lead",
						chatChannel: "test",
						backend: "claude-code",
						model: "claude-fable-5",
						effort: "high",
						botToken: "must-not-leak",
						match: { labels: ["engineering"] },
					},
				],
			},
		];
		extraFlags = [];
		env = {};
		launchctl = new LaunchctlStub();
		launchctl.loaded.add("org.example.alpha-daily");

		store = await StateStore.create(":memory:");
		importLegacyWorkflowSeeds(store);
		store.bindWorkflowCategory({
			project: "alpha",
			taskCategory: "*",
			templateId: "tpl_eng_heavy",
			updatedBy: "acceptance",
		});

		const failedExtension: ManagementSectionProvider = {
			id: "failure-probe",
			label: "Failure Probe",
			fields: [{ id: "enabled", label: "Enabled", kind: "boolean" }],
			read: () => ({ revision: "failure:1", values: { enabled: false } }),
			apply: () => ({
				status: "rejected",
				reason: "intentional isolated runtime failure",
			}),
		};
		const sections = new ManagementSectionRegistry([failedExtension]);
		const flagViews = () => [
			...resolveAllFlags({ env, projectConfigs: currentConfigs() }),
			...extraFlags,
		];
		const providers = () => [
			...createManagementSsotProviders({
				projects: () => projects,
				projectsRevision,
				projectConfigs: currentConfigs,
			}),
			createManagementDagProvider({
				reader: store,
				projectNames: () => projects.map((project) => project.projectName),
			}),
			createManagementRunnerProvider({
				projects: () => projects,
				projectConfigs: currentConfigs,
			}),
			createManagementFlagProvider({
				views: flagViews,
				revision: () =>
					managementFlagRevision(readFileSync(envPath, "utf8"), env),
				projectNames: () => projects.map((project) => project.projectName),
			}),
			sections.snapshotProvider(),
			createManagementCronProvider({
				launchAgentsDir,
				projects: () => projects,
				uid: process.getuid?.() ?? 0,
				deps: {
					readdir: readdirSync,
					lstat: lstatSync,
					realpath: realpathSync,
					readFile: readFileSync,
					execFile: launchctl.execFile,
				},
			}),
		];
		fleet = new FleetConsole({
			projectsJsonPath: join(root, "projects.json"),
			txnDir: join(root, "txns"),
			auditDbPath: join(root, "audit.db"),
			fleetScriptPath: join(root, "unused-fleet.sh"),
			logDir: join(root, "logs"),
			liveProjects: () => projects,
			legacyBackendOf: () => undefined,
			managementSnapshotProviders: providers,
		});
		const existing = createExistingManagementWriters({
			projects: () => projects,
			projectsRevision,
			projectConfigs: currentConfigs,
			readProjectConfig: (path) => readFileSync(path, "utf8"),
			applyRunner: applyRunnerDefaults,
			applyLeadCanonical: () => ({ status: "applied" }),
			envPath,
			readEnvFile: (path) => readFileSync(path, "utf8"),
			writeEnvFile: (path, content) => writeFileSync(path, content),
			env,
			flagViews,
			flagLock: (operation) => operation(),
		});
		const cronAuthority = new ManagementCronWriter({
			launchAgentsDir,
			uid: process.getuid?.() ?? 0,
			targets: () => scanCrons().targets,
			deps: { execFile: launchctl.execFile },
		});
		fleet.setManagementCoordinator(
			new ManagementChangeCoordinator({
				registry: new ManagementWriterRegistry([
					existing.lead,
					existing.runner,
					existing.flag,
					createManagementDagWriter({
						store,
						projectNames: () => projects.map((project) => project.projectName),
						actor: "acceptance",
					}),
					createManagementCronWriterAdapter({
						writer: cronAuthority,
						targets: () => scanCrons().targets,
					}),
					sections.writer(),
				]),
				tokens: fleet.tokens,
				audit: fleet.audit,
				journalDir: join(root, "txns"),
				snapshotRevision: () =>
					fleet.buildManagementSnapshot().snapshotRevision,
			}),
		);

		const app = createBridgeApp(
			store,
			projects,
			config(root),
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
		await new Promise<void>((done) => server.once("listening", done));
		const address = server.address();
		baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
	});

	afterEach(async () => {
		if (server) {
			await new Promise<void>((done, reject) =>
				server.close((error) => (error ? reject(error) : done())),
			);
		}
		fleet?.close();
		store?.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("serves one secret-free aggregate and a UI with no manual ingest or copied inventory", async () => {
		const current = await snapshot();
		expect(current.projects[0]).toMatchObject({
			name: "alpha",
			leads: [{ leadId: "alpha-lead" }],
			roles: [{ name: "alpha" }],
			dags: [{ nodes: expect.any(Array) }],
			crons: [{ label: "org.example.alpha-daily" }],
		});
		expect(Object.keys(current.modelCatalog).sort()).toEqual([
			"cron",
			"dispatch",
			"lead",
			"runner",
			"workflow",
		]);
		expect(current.flags.length).toBeGreaterThan(10);
		const raw = JSON.stringify(current);
		expect(raw).not.toContain("must-not-leak");
		expect(raw).not.toContain("botToken");

		const html = await (await fetch(`${baseUrl}/`)).text();
		expect(html).toContain("/api/fleet/snapshot");
		expect(html).toContain("/api/fleet/changes/stage");
		expect(html).not.toMatch(/manual|ingest|PROJECTS|VENDORS|FLAG_GROUPS/);
		expect(html).not.toContain("org.example.alpha-daily");
	});

	it("auto-discovers added and removed Leads, registered flags, project crons, and unmatched crons with zero UI edits", async () => {
		const before = await snapshot();
		projects[0]!.leads.push({
			agentId: "new-lead",
			chatChannel: "test",
			backend: "claude-code",
			model: "claude-fable-5",
			match: { labels: ["engineering"] },
		});
		extraFlags.push({
			name: "acceptance_dynamic_flag",
			category: "feature",
			description: "injected registered view",
			toggleable: "readonly",
			valueKind: "bool",
			scope: "bridge_global",
			source: "code_default",
			readTimings: [],
			default: false,
			effective: false,
		});
		const secondScript = join(projectRoot, "tasks", "weekly.sh");
		writeFileSync(secondScript, "#!/bin/sh\n");
		const projectCron = writeCron(
			"new-project-cron.plist",
			"arbitrary.project-label",
			secondScript,
		);
		const outside = join(root, "outside.sh");
		writeFileSync(outside, "#!/bin/sh\n");
		const unmatched = writeCron(
			"unmatched.plist",
			"arbitrary.unmatched-label",
			outside,
		);

		const added = await snapshot();
		expect(added.projects[0]!.leads).toHaveLength(
			before.projects[0]!.leads.length + 1,
		);
		expect(added.flags).toHaveLength(before.flags.length + 1);
		expect(added.projects[0]!.crons.map((cron) => cron.label)).toContain(
			"arbitrary.project-label",
		);
		expect(added.unassignedCrons.map((cron) => cron.label)).toContain(
			"arbitrary.unmatched-label",
		);

		projects[0]!.leads.pop();
		extraFlags.pop();
		rmSync(projectCron);
		rmSync(unmatched);
		const removed = await snapshot();
		expect(removed.projects[0]!.leads).toHaveLength(
			before.projects[0]!.leads.length,
		);
		expect(removed.flags).toHaveLength(before.flags.length);
		expect(removed.projects[0]!.crons).toHaveLength(
			before.projects[0]!.crons.length,
		);
		expect(removed.unassignedCrons).toHaveLength(before.unassignedCrons.length);
	});

	it("stages server old-to-new values, writes config/DB/plist, rejects stale sources, and journals partial results", async () => {
		const before = await snapshot();
		const project = before.projects[0]!;
		const runner = project.runnerDefault!.dispatch;
		const dag = project.dags[0]!.nodes.find(
			(node) => node.name === "design",
		)!.dispatch;
		const cron = project.crons[0]!.schedule;
		const desiredSchedule = {
			days: [1, 3],
			times: [
				{ hour: 8, minute: 15 },
				{ hour: 17, minute: 45 },
			],
			label: "自定义" as const,
		};
		const changes = [
			{
				targetId: runner.targetId,
				desiredValue: {
					provider: "anthropic",
					model: "claude-fable-5",
					effort: null,
				},
				observedRevision: runner.source.revision,
			},
			{
				targetId: dag.targetId,
				desiredValue: {
					provider: "anthropic",
					model: "claude-opus-5",
					effort: null,
				},
				observedRevision: dag.source.revision,
			},
			{
				targetId: cron.targetId,
				desiredValue: desiredSchedule,
				observedRevision: cron.source.revision,
			},
		];
		const needsAck = await post("/api/fleet/changes/stage", { changes });
		expect(needsAck.status).toBe(200);
		const canonical = (await needsAck.json()) as {
			batch: {
				changes: Array<{
					targetId: string;
					oldValue: unknown;
					newValue: unknown;
				}>;
			};
			confirmationRequired: boolean;
		};
		expect(canonical.confirmationRequired).toBe(true);
		expect(canonical.batch.changes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					targetId: runner.targetId,
					oldValue: runner.current,
				}),
				expect.objectContaining({
					targetId: cron.targetId,
					newValue: desiredSchedule,
				}),
			]),
		);
		const stagedResponse = await post("/api/fleet/changes/stage", {
			changes,
			acknowledged: true,
		});
		const staged = (await stagedResponse.json()) as {
			batch: unknown;
			confirmToken: string;
		};
		const appliedResponse = await post("/api/fleet/changes/apply", {
			...staged,
			acknowledged: true,
		});
		expect(appliedResponse.status).toBe(200);
		expect(await appliedResponse.json()).toMatchObject({ status: "applied" });
		expect(readFileSync(configPath, "utf8")).toContain("model: claude-fable-5");
		expect(
			store.getWorkflowTemplate("tpl_eng_heavy")?.current_published_revision,
		).toBe(2);
		const persistedPlist = JSON.parse(
			readFileSync(join(launchAgentsDir, "alpha-daily.plist"), "utf8"),
		) as {
			StartCalendarInterval: unknown[];
		};
		expect(persistedPlist.StartCalendarInterval).toHaveLength(4);
		expect(launchctl.commands.map((command) => command[0])).toContain(
			"bootstrap",
		);

		const fresh = await snapshot();
		const staleRunner = fresh.projects[0]!.runnerDefault!.dispatch;
		const stableEnv = readFileSync(envPath);
		const staleStage = await post("/api/fleet/changes/stage", {
			changes: [
				{
					targetId: staleRunner.targetId,
					desiredValue: {
						provider: "anthropic",
						model: "claude-opus-5",
						effort: null,
					},
					observedRevision: staleRunner.source.revision,
				},
			],
		});
		const staleBatch = (await staleStage.json()) as {
			batch: unknown;
			confirmToken: string;
		};
		writeFileSync(
			configPath,
			`${readFileSync(configPath, "utf8")}# external drift\n`,
		);
		const driftedBytes = readFileSync(configPath);
		const staleApply = await post("/api/fleet/changes/apply", staleBatch);
		expect(staleApply.status).toBe(409);
		expect(readFileSync(configPath)).toEqual(driftedBytes);
		expect(readFileSync(envPath)).toEqual(stableEnv);

		const partialSnapshot = await snapshot();
		const partialRunner = partialSnapshot.projects[0]!.runnerDefault!.dispatch;
		const failureField = partialSnapshot.extensions[0]!.fields[0]!.value;
		const partialStage = await post("/api/fleet/changes/stage", {
			changes: [
				{
					targetId: partialRunner.targetId,
					desiredValue: {
						provider: "anthropic",
						model: "claude-opus-5",
						effort: null,
					},
					observedRevision: partialRunner.source.revision,
				},
				{
					targetId: failureField.targetId,
					desiredValue: true,
					observedRevision: failureField.source.revision,
				},
			],
		});
		const partialBatch = (await partialStage.json()) as {
			batch: unknown;
			confirmToken: string;
		};
		const partialApply = await post("/api/fleet/changes/apply", partialBatch);
		expect(partialApply.status).toBe(200);
		const partial = (await partialApply.json()) as {
			batchId: string;
			status: string;
		};
		expect(partial.status).toBe("partially-applied");
		expect(fleet.getManagementCoordinator()!.listProgress()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					batchId: partial.batchId,
					status: "partially-applied",
					terminal: true,
				}),
			]),
		);
	});

	it("ships a runnable live-readonly QA entrypoint that reports counts without mutation", async () => {
		expect(existsSync(QA_SCRIPT)).toBe(true);
		const configBefore = readFileSync(configPath);
		const envBefore = readFileSync(envPath);
		const { stdout, stderr } = await execFileAsync(process.execPath, [
			QA_SCRIPT,
			"--live-readonly",
			"--base-url",
			baseUrl,
		]);
		expect(stderr).toBe("");
		expect(stdout).toMatch(
			/PASS live-readonly: projects=1 leads=1 roles=1 dags=1 crons=1/,
		);
		expect(stdout).toContain("SOURCE_DIAGNOSTICS all=");
		expect(stdout).not.toContain("must-not-leak");
		expect(readFileSync(configPath)).toEqual(configBefore);
		expect(readFileSync(envPath)).toEqual(envBefore);
	});
});
