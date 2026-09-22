import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runLeadRegistryCommand } from "../commands/lead-registry.js";
import { compileSummaryAssignments } from "../summary-assignment.js";

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

describe("flywheel-comm lead-registry", () => {
	it("prints the shared generic Codex profile without registry access", () => {
		const output: string[] = [];
		expect(
			runLeadRegistryCommand(["generic-codex-profile"], {
				stdout: (line) => output.push(line),
				homeDir: "/absent",
			}),
		).toBe(0);
		expect(output).toEqual(["full-access"]);
	});

	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0))
			rmSync(dir, { recursive: true, force: true });
	});

	function tempDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "fly2444-lead-registry-"));
		dirs.push(dir);
		return dir;
	}

	function fixture() {
		const homeDir = tempDir();
		const flywheelDir = join(homeDir, ".flywheel");
		const receiptDir = join(flywheelDir, "state", "summary-registry");
		mkdirSync(receiptDir, { recursive: true });
		writeFileSync(
			join(flywheelDir, "summary-config.json"),
			JSON.stringify({
				granularity: "per-lead",
				setBy: "founder",
				setAt: "2026-09-08T00:00:00.000Z",
			}),
		);
		const projectsPath = join(flywheelDir, "projects.json");
		const registry = [
			{
				projectName: "flywheel",
				projectRoot: "/tmp/flywheel",
				leads: [
					{
						agentId: "existing-lead",
						summaryRole: "producer",
						chatChannel: "10000000000000001",
						match: { labels: ["existing-lead"] },
						botTokenEnv: "EXISTING_BOT_TOKEN",
						botUserId: "20000000000000001",
					},
				],
			},
		];
		const projectsText = `${JSON.stringify(registry, null, 2)}\n`;
		writeFileSync(projectsPath, projectsText, { mode: 0o600 });
		const selection = {
			state: "selected" as const,
			granularity: "per-lead" as const,
			setBy: "founder",
			setAt: "2026-09-08T00:00:00.000Z",
		};
		const projection = compileSummaryAssignments(registry, selection);
		const receiptPath = join(receiptDir, "migration-receipt.json");
		writeFileSync(
			receiptPath,
			`${JSON.stringify(
				{
					schemaVersion: 1,
					postImageSha256: sha256(projectsText),
					assignments: projection.leads.map((row) => ({
						projectName: row.projectName,
						leadId: row.leadId,
						summaryRole: row.summaryRole,
					})),
					projectAggregators: projection.projectAggregators,
					granularity: "per-lead",
					summaryAssignmentDigest: projection.digest,
					migratedAt: "2026-09-08T00:00:00.000Z",
				},
				null,
				2,
			)}\n`,
			{ mode: 0o600 },
		);
		return { homeDir, projectsPath, receiptPath, registry };
	}

	function backendFixture() {
		const f = fixture();
		const projectRoot = join(f.homeDir, "project");
		mkdirSync(projectRoot);
		spawnSync("git", ["init", projectRoot]);
		spawnSync(
			"git",
			[
				"-c",
				"user.name=Fixture",
				"-c",
				"user.email=fixture@example.invalid",
				"commit",
				"--allow-empty",
				"-m",
				"fixture",
			],
			{ cwd: projectRoot },
		);
		const deploymentSha = spawnSync("git", ["rev-parse", "HEAD"], {
			cwd: projectRoot,
			encoding: "utf8",
		}).stdout.trim();
		f.registry[0]!.projectRoot = projectRoot;
		const row = f.registry[0]!.leads[0]!;
		row.agentId = "flywheel-product-lead";
		Object.assign(row, { backend: "claude-code", canSpawnRunners: true });
		writeFileSync(f.projectsPath, JSON.stringify(f.registry));
		const selection = {
			state: "selected" as const,
			granularity: "per-lead" as const,
			setBy: "founder",
			setAt: "2026-09-08T00:00:00.000Z",
		};
		const projection = compileSummaryAssignments(f.registry, selection);
		const receipt = JSON.parse(readFileSync(f.receiptPath, "utf8"));
		receipt.summaryAssignmentDigest = projection.digest;
		receipt.assignments = projection.leads.map(
			({ projectName, leadId, summaryRole }) => ({
				projectName,
				leadId,
				summaryRole,
			}),
		);
		writeFileSync(f.receiptPath, JSON.stringify(receipt));
		const state = join(f.homeDir, ".flywheel");
		mkdirSync(join(state, "manifests"));
		mkdirSync(join(f.homeDir, "Library/LaunchAgents"), { recursive: true });
		writeFileSync(
			join(state, "manifests/flywheel-flywheel-product-lead.json"),
			JSON.stringify({
				projectName: "flywheel",
				leadId: "flywheel-product-lead",
				projectDir: "/tmp/flywheel",
				leadBackend: { backendId: "claude-code" },
			}),
		);
		writeFileSync(
			join(
				f.homeDir,
				"Library/LaunchAgents/com.flywheel.lead.flywheel-flywheel-product-lead.plist",
			),
			"fixture-plist",
		);
		writeFileSync(join(state, "deployed-sha"), deploymentSha);
		const out = join(
			state,
			"lead-backend-migrations/FLY-2459-honey-lemon.json",
		);
		return {
			...f,
			out,
			args: [
				"plan-backend-migration",
				"--project",
				"flywheel",
				"--lead",
				"flywheel-product-lead",
				"--to-backend",
				"codex-app-server",
				"--model",
				"astra",
				"--effort",
				"high",
				"--runner-actions",
				"--out",
				out,
			],
		};
	}
	it("plans a backend migration without changing registry or summary receipt", () => {
		const f = backendFixture(),
			stdout: string[] = [],
			stderr: string[] = [];
		const before = readFileSync(f.projectsPath),
			receipt = readFileSync(f.receiptPath);
		expect(
			runLeadRegistryCommand(f.args, {
				homeDir: f.homeDir,
				stdout: (s) => stdout.push(s),
				stderr: (s) => stderr.push(s),
				now: () => "2026-09-11T00:00:00.000Z",
			}),
			stderr.join("\n"),
		).toBe(0);
		const intent = JSON.parse(readFileSync(f.out, "utf8"));
		expect(intent.target.model).toBe("gpt-6-astra");
		expect(intent.target.codexProfile).toBe("full-access");
		expect(readFileSync(f.projectsPath)).toEqual(before);
		expect(readFileSync(f.receiptPath)).toEqual(receipt);
		const first = readFileSync(f.out);
		expect(
			runLeadRegistryCommand(f.args, {
				homeDir: f.homeDir,
				stdout: () => {},
				stderr: () => {},
				now: () => "2026-09-12T00:00:00.000Z",
			}),
		).toBe(0);
		expect(readFileSync(f.out)).toEqual(first);
	});
	it("rejects an expected deployment absent from the target repository", () => {
		const f = backendFixture();
		expect(
			runLeadRegistryCommand([...f.args, "--deployment-sha", "d".repeat(40)], {
				homeDir: f.homeDir,
				stdout: () => {},
				stderr: () => {},
				validateTeamleadCandidate: () => {},
			}),
		).not.toBe(0);
		expect(existsSync(f.out)).toBe(false);
	});

	it("rejects unsupported migration profile before producing intent", () => {
		const f = backendFixture();
		expect(
			runLeadRegistryCommand([...f.args, "--codex-profile", "write-capable"], {
				homeDir: f.homeDir,
				stdout: () => {},
				stderr: () => {},
				validateTeamleadCandidate: () => {},
			}),
		).not.toBe(0);
		expect(existsSync(f.out)).toBe(false);
	});
	it("refuses a migration with stale summary activation", () => {
		const f = backendFixture();
		const receipt = JSON.parse(readFileSync(f.receiptPath, "utf8"));
		receipt.summaryAssignmentDigest = "e".repeat(64);
		writeFileSync(f.receiptPath, JSON.stringify(receipt));
		expect(
			runLeadRegistryCommand(f.args, {
				homeDir: f.homeDir,
				stdout: () => {},
				stderr: () => {},
				validateTeamleadCandidate: () => {},
			}),
		).not.toBe(0);
		expect(existsSync(f.out)).toBe(false);
	});

	function writeIntent(
		f: ReturnType<typeof fixture>,
		input: {
			phase?: "pending" | "done";
			projectsShaBefore: string;
			receiptDigestBefore: string;
			projectsShaPlanned: string;
			receiptDigestPlanned: string;
			projectsBackup?: string;
			receiptBackup?: string;
		},
	): string {
		const intentPath = `${f.receiptPath}.lead-registry-intent.json`;
		writeFileSync(
			intentPath,
			`${JSON.stringify(
				{
					schemaVersion: 1,
					phase: input.phase ?? "pending",
					leadKey: "raya-raya-product-lead",
					startedAt: "2026-09-08T02:00:00.000Z",
					projectsShaBefore: input.projectsShaBefore,
					receiptDigestBefore: input.receiptDigestBefore,
					projectsShaPlanned: input.projectsShaPlanned,
					receiptDigestPlanned: input.receiptDigestPlanned,
					backups: {
						projects:
							input.projectsBackup ??
							`${f.projectsPath}.lead-registry-test.bak`,
						receipt:
							input.receiptBackup ?? `${f.receiptPath}.lead-registry-test.bak`,
					},
				},
				null,
				2,
			)}\n`,
		);
		return intentPath;
	}

	const rayaAddArgs = [
		"add",
		"--project-name",
		"raya",
		"--project-root",
		"/tmp/raya",
		"--project-repo",
		"xrliAnnie/raya",
		"--memory-allowed-users",
		"30000000000000001",
		"--lead-id",
		"raya-product-lead",
		"--chat-channel",
		"40000000000000001",
		"--bot-token-env",
		"RAYA_PRODUCT_BOT_TOKEN",
		"--bot-user-id",
		"50000000000000001",
		"--harness",
		"codex",
		"--roundtable-channel",
		"60000000000000001",
		"--alert-channel",
		"40000000000000001",
		"--alert-bot-token-env",
		"RAYA_PRODUCT_BOT_TOKEN",
		"--alert-fallback-to-core",
		"false",
	];

	it.each(["\n", "", " \n"])(
		"selector binds projectsDigest to the exact raw bytes ending %j",
		(suffix) => {
			const dir = tempDir();
			const projectsPath = join(dir, "projects.json");
			const raw = `${JSON.stringify(
				[
					{
						projectName: "raya",
						projectRoot: "/tmp/raya",
						projectRepo: "xrliAnnie/raya",
						generalChannel: "10000000000000001",
						leads: [
							{
								agentId: "raya-product-lead",
								summaryRole: "recipient",
								chatChannel: "20000000000000001",
								match: { labels: ["raya-product-lead"] },
								botTokenEnv: "RAYA_PRODUCT_BOT_TOKEN",
								botUserId: "30000000000000001",
								canSpawnRunners: false,
								backend: "codex-app-server",
								codexProfile: "full-access",
								roundtableChannel: "40000000000000002",
								alertChannel: "20000000000000001",
								alertBotTokenEnv: "RAYA_PRODUCT_BOT_TOKEN",
								alertFallbackToCore: false,
							},
						],
					},
				],
				null,
				2,
			)}${suffix}`;
			writeFileSync(projectsPath, raw);
			const stdout: string[] = [];

			expect(
				runLeadRegistryCommand(
					[
						"selector",
						"--project",
						"raya",
						"--lead",
						"raya-product-lead",
						"--projects-file",
						projectsPath,
					],
					{ stdout: (line) => stdout.push(line) },
				),
			).toBe(0);
			expect(JSON.parse(stdout[0]!)).toEqual({
				projectsDigest: sha256(raw),
				projectName: "raya",
				leadId: "raya-product-lead",
				projectRoot: "/tmp/raya",
				projectRepo: "xrliAnnie/raya",
				chatChannel: "20000000000000001",
				generalChannel: "10000000000000001",
				backend: "codex-app-server",
				codexProfile: "full-access",
				genericCodexDefaultProfile: "full-access",
				codexCapabilities: {
					eligible: true,
					runnerActionsEnabled: false,
					reason: null,
				},
				botTokenEnv: "RAYA_PRODUCT_BOT_TOKEN",
				roundtableChannel: "40000000000000002",
				alertChannel: "20000000000000001",
				alertBotTokenEnv: "RAYA_PRODUCT_BOT_TOKEN",
				alertFallbackToCore: false,
			});
		},
	);

	it("selector emits projectRepo and a valid opt-in only for its exact Lead", () => {
		const dir = tempDir();
		const projectsPath = join(dir, "projects.json");
		const projection = {
			schemaVersion: 1,
			enabled: true,
			leadId: "raya",
			repo: "xrliAnnie/raya",
			path: ".lead/raya/identity.md",
			pin: {
				commit: "a".repeat(40),
				personaBlobDigest: "b".repeat(64),
				approval: {
					channelId: "12345678901234567",
					messageId: "22345678901234567",
					contentSha256: "c".repeat(64),
				},
			},
			lastKnownGood: {
				commit: "d".repeat(40),
				personaBlobDigest: "e".repeat(64),
				approval: {
					channelId: "12345678901234567",
					messageId: "32345678901234567",
					contentSha256: "f".repeat(64),
				},
			},
		};
		writeFileSync(
			projectsPath,
			JSON.stringify([
				{
					projectName: "raya",
					projectRoot: "/tmp/raya",
					projectRepo: "xrliAnnie/raya",
					personaProjection: projection,
					leads: [
						{
							agentId: "raya",
							summaryRole: "recipient",
							chatChannel: "42345678901234567",
							match: { labels: ["raya"] },
							backend: "codex-app-server",
							codexProfile: "full-access",
							canSpawnRunners: false,
						},
					],
				},
			]),
		);
		const stdout: string[] = [];
		expect(
			runLeadRegistryCommand(
				[
					"selector",
					"--project",
					"raya",
					"--lead",
					"raya",
					"--projects-file",
					projectsPath,
				],
				{ homeDir: dir, stdout: (line) => stdout.push(line) },
			),
		).toBe(0);
		const selected = JSON.parse(stdout[0]!);
		expect(selected.projectRepo).toBe("xrliAnnie/raya");
		expect(selected.personaProjection).toEqual(projection);
		expect(selected.personaProjectionContractDigest).toMatch(/^[a-f0-9]{64}$/);
	});

	it("isolates a malformed Raya opt-in until raya/raya is selected", () => {
		const dir = tempDir();
		const projectsPath = join(dir, "projects.json");
		writeFileSync(
			projectsPath,
			JSON.stringify([
				{
					projectName: "flywheel",
					projectRoot: "/tmp/flywheel",
					projectRepo: "xrliAnnie/flywheel",
					leads: [
						{
							agentId: "flywheel-eng-lead",
							summaryRole: "producer",
							chatChannel: "12345678901234567",
							match: { labels: ["eng"] },
						},
					],
				},
				{
					projectName: "raya",
					projectRoot: "/tmp/raya",
					projectRepo: "xrliAnnie/raya",
					personaProjection: { enabled: false },
					leads: [
						{
							agentId: "raya",
							summaryRole: "recipient",
							chatChannel: "22345678901234567",
							match: { labels: ["raya"] },
							backend: "codex-app-server",
							codexProfile: "full-access",
							canSpawnRunners: false,
						},
					],
				},
			]),
		);
		const flywheelOutput: string[] = [];
		expect(
			runLeadRegistryCommand(
				[
					"selector",
					"--project",
					"flywheel",
					"--lead",
					"flywheel-eng-lead",
					"--projects-file",
					projectsPath,
				],
				{ homeDir: dir, stdout: (line) => flywheelOutput.push(line) },
			),
		).toBe(0);
		expect(JSON.parse(flywheelOutput[0]!).personaProjection).toBeUndefined();

		const stderr: string[] = [];
		expect(
			runLeadRegistryCommand(
				[
					"selector",
					"--project",
					"raya",
					"--lead",
					"raya",
					"--projects-file",
					projectsPath,
				],
				{ homeDir: dir, stderr: (line) => stderr.push(line) },
			),
		).toBe(78);
		expect(stderr.join("\n")).toContain(
			"lead_registry_persona_projection_invalid",
		);
	});

	it("adds a Lead and remints the activation receipt in one locked transaction", () => {
		const f = fixture();
		const beforeProjects = readFileSync(f.projectsPath, "utf8");
		const beforeReceipt = readFileSync(f.receiptPath, "utf8");
		const stdout: string[] = [];
		const rc = runLeadRegistryCommand(rayaAddArgs, {
			homeDir: f.homeDir,
			env: { FLYWHEEL_SUMMARY_CONFIG_LOCK_HELD: "1" },
			stdout: (line) => stdout.push(line),
			validateTeamleadCandidate: () => undefined,
			now: () => "2026-09-08T02:00:00.000Z",
		});

		expect(rc).toBe(0);
		const output = JSON.parse(stdout[0]!);
		expect(output).toMatchObject({
			ok: true,
			leadKey: "raya-raya-product-lead",
			projectsFile: f.projectsPath,
			receiptFile: f.receiptPath,
			effectiveAt: "next-bridge-restart",
			backups: {
				projects: `${f.projectsPath}.bak-fly2444-20260908T020000000Z`,
				receipt: `${f.receiptPath}.bak-fly2444-20260908T020000000Z`,
			},
		});
		expect(readFileSync(output.backups.projects, "utf8")).toBe(beforeProjects);
		expect(readFileSync(output.backups.receipt, "utf8")).toBe(beforeReceipt);
		const registry = JSON.parse(readFileSync(f.projectsPath, "utf8"));
		expect(registry[1].leads[0]).toMatchObject({
			agentId: "raya-product-lead",
			backend: "codex-app-server",
			codexProfile: "full-access",
			roundtableChannel: "60000000000000001",
			alertChannel: "40000000000000001",
			alertBotTokenEnv: "RAYA_PRODUCT_BOT_TOKEN",
			alertFallbackToCore: false,
		});
		expect(JSON.parse(readFileSync(f.receiptPath, "utf8"))).toMatchObject({
			assignments: expect.arrayContaining([
				expect.objectContaining({ leadId: "raya-product-lead" }),
			]),
		});
		expect(existsSync(`${f.receiptPath}.lead-registry-intent.json`)).toBe(
			false,
		);
	});

	it("dry-runs without the lock and leaves both registries byte-identical", () => {
		const f = fixture();
		const beforeProjects = readFileSync(f.projectsPath, "utf8");
		const beforeReceipt = readFileSync(f.receiptPath, "utf8");
		const stdout: string[] = [];

		expect(
			runLeadRegistryCommand([...rayaAddArgs, "--dry-run"], {
				homeDir: f.homeDir,
				env: {},
				stdout: (line) => stdout.push(line),
				validateTeamleadCandidate: () => undefined,
			}),
		).toBe(0);
		expect(JSON.parse(stdout[0]!)).toMatchObject({
			ok: true,
			dryRun: true,
			leadKey: "raya-raya-product-lead",
		});
		expect(readFileSync(f.projectsPath, "utf8")).toBe(beforeProjects);
		expect(readFileSync(f.receiptPath, "utf8")).toBe(beforeReceipt);
		expect(
			readdirSync(join(f.homeDir, ".flywheel"), { recursive: true }).filter(
				(path) => String(path).includes("lead-registry"),
			),
		).toEqual([]);
	});

	it("validates a dry-run candidate with the compiled TeamLead validator", () => {
		const f = fixture();
		const validatorPath = join(
			process.cwd(),
			"../teamlead/dist/bin/validate-projects.js",
		);
		expect(existsSync(validatorPath)).toBe(true);
		const stdout: string[] = [];

		expect(
			runLeadRegistryCommand([...rayaAddArgs, "--dry-run"], {
				homeDir: f.homeDir,
				env: { FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR: validatorPath },
				stdout: (line) => stdout.push(line),
			}),
		).toBe(0);
		expect(JSON.parse(stdout[0]!)).toMatchObject({
			ok: true,
			dryRun: true,
			leadKey: "raya-raya-product-lead",
		});
	});

	it("continues an exact prior add with zero registry writes or new backups", () => {
		const f = fixture();
		expect(
			runLeadRegistryCommand(rayaAddArgs, {
				homeDir: f.homeDir,
				env: { FLYWHEEL_SUMMARY_CONFIG_LOCK_HELD: "1" },
				validateTeamleadCandidate: () => undefined,
			}),
		).toBe(0);
		const beforeProjects = readFileSync(f.projectsPath, "utf8");
		const beforeReceipt = readFileSync(f.receiptPath, "utf8");
		const beforeTree = readdirSync(join(f.homeDir, ".flywheel"), {
			recursive: true,
		});
		const stdout: string[] = [];

		expect(
			runLeadRegistryCommand(rayaAddArgs, {
				homeDir: f.homeDir,
				env: {},
				stdout: (line) => stdout.push(line),
				validateTeamleadCandidate: () => undefined,
			}),
		).toBe(0);
		expect(JSON.parse(stdout[0]!)).toMatchObject({
			ok: true,
			continuation: true,
		});
		expect(readFileSync(f.projectsPath, "utf8")).toBe(beforeProjects);
		expect(readFileSync(f.receiptPath, "utf8")).toBe(beforeReceipt);
		expect(
			readdirSync(join(f.homeDir, ".flywheel"), { recursive: true }),
		).toEqual(beforeTree);
	});

	it("rolls both files back when the transaction throws after projects rename", () => {
		const f = fixture();
		const beforeProjects = readFileSync(f.projectsPath, "utf8");
		const beforeReceipt = readFileSync(f.receiptPath, "utf8");
		const stderr: string[] = [];

		expect(
			runLeadRegistryCommand(rayaAddArgs, {
				homeDir: f.homeDir,
				env: { FLYWHEEL_SUMMARY_CONFIG_LOCK_HELD: "1" },
				stderr: (line) => stderr.push(line),
				validateTeamleadCandidate: () => undefined,
				afterProjectsRename: () => {
					throw new Error("simulated split");
				},
			}),
		).toBe(70);
		expect(JSON.parse(stderr[0]!)).toMatchObject({
			code: "lead_registry_rolled_back",
		});
		expect(readFileSync(f.projectsPath, "utf8")).toBe(beforeProjects);
		expect(readFileSync(f.receiptPath, "utf8")).toBe(beforeReceipt);
		expect(existsSync(`${f.receiptPath}.lead-registry-intent.json`)).toBe(
			false,
		);
	});

	it("rejects non-per-lead mode before interpreting the activation receipt", () => {
		const f = fixture();
		writeFileSync(
			join(f.homeDir, ".flywheel", "summary-config.json"),
			JSON.stringify({
				granularity: "per-project",
				setBy: "founder",
				setAt: "2026-09-08T00:00:00.000Z",
			}),
		);
		const beforeProjects = readFileSync(f.projectsPath, "utf8");
		const beforeReceipt = readFileSync(f.receiptPath, "utf8");
		const stderr: string[] = [];

		expect(
			runLeadRegistryCommand(rayaAddArgs, {
				homeDir: f.homeDir,
				env: { FLYWHEEL_SUMMARY_CONFIG_LOCK_HELD: "1" },
				stderr: (line) => stderr.push(line),
				validateTeamleadCandidate: () => undefined,
			}),
		).toBe(78);
		expect(JSON.parse(stderr[0]!)).toMatchObject({
			code: "lead_registry_granularity_unsupported",
		});
		expect(readFileSync(f.projectsPath, "utf8")).toBe(beforeProjects);
		expect(readFileSync(f.receiptPath, "utf8")).toBe(beforeReceipt);
	});

	it("rejects a stale pre-image receipt without writing either registry", () => {
		const f = fixture();
		const staleReceipt = JSON.parse(readFileSync(f.receiptPath, "utf8"));
		staleReceipt.summaryAssignmentDigest = "0".repeat(64);
		writeFileSync(f.receiptPath, `${JSON.stringify(staleReceipt, null, 2)}\n`);
		const beforeProjects = readFileSync(f.projectsPath, "utf8");
		const beforeReceipt = readFileSync(f.receiptPath, "utf8");
		const stderr: string[] = [];

		expect(
			runLeadRegistryCommand(rayaAddArgs, {
				homeDir: f.homeDir,
				env: { FLYWHEEL_SUMMARY_CONFIG_LOCK_HELD: "1" },
				stderr: (line) => stderr.push(line),
				validateTeamleadCandidate: () => undefined,
			}),
		).toBe(78);
		expect(JSON.parse(stderr[0]!)).toMatchObject({
			code: "lead_registry_preimage_stale",
		});
		expect(readFileSync(f.projectsPath, "utf8")).toBe(beforeProjects);
		expect(readFileSync(f.receiptPath, "utf8")).toBe(beforeReceipt);
	});

	it("requires the shared config lock before the first persistent write", () => {
		const f = fixture();
		const beforeProjects = readFileSync(f.projectsPath, "utf8");
		const beforeReceipt = readFileSync(f.receiptPath, "utf8");
		const beforeTree = readdirSync(join(f.homeDir, ".flywheel"), {
			recursive: true,
		});
		const stderr: string[] = [];

		expect(
			runLeadRegistryCommand(rayaAddArgs, {
				homeDir: f.homeDir,
				env: {},
				stderr: (line) => stderr.push(line),
				validateTeamleadCandidate: () => undefined,
			}),
		).toBe(78);
		expect(JSON.parse(stderr[0]!)).toMatchObject({
			code: "lead_registry_lock_required",
		});
		expect(readFileSync(f.projectsPath, "utf8")).toBe(beforeProjects);
		expect(readFileSync(f.receiptPath, "utf8")).toBe(beforeReceipt);
		expect(
			readdirSync(join(f.homeDir, ".flywheel"), { recursive: true }),
		).toEqual(beforeTree);
	});

	it("reports a missing configured validator explicitly", () => {
		const f = fixture();
		const stderr: string[] = [];

		expect(
			runLeadRegistryCommand(rayaAddArgs, {
				homeDir: f.homeDir,
				env: {
					FLYWHEEL_SUMMARY_CONFIG_LOCK_HELD: "1",
					FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR: join(
						f.homeDir,
						"missing-validator.mjs",
					),
				},
				stderr: (line) => stderr.push(line),
			}),
		).toBe(78);
		expect(JSON.parse(stderr[0]!)).toMatchObject({
			code: "lead_registry_validator_missing",
		});
	});

	it("reports candidate validator rejection explicitly and leaves no writes", () => {
		const f = fixture();
		const beforeProjects = readFileSync(f.projectsPath, "utf8");
		const beforeReceipt = readFileSync(f.receiptPath, "utf8");
		const stderr: string[] = [];
		let validations = 0;

		expect(
			runLeadRegistryCommand(rayaAddArgs, {
				homeDir: f.homeDir,
				env: { FLYWHEEL_SUMMARY_CONFIG_LOCK_HELD: "1" },
				stderr: (line) => stderr.push(line),
				validateTeamleadCandidate: () => {
					validations += 1;
					if (validations === 2) throw new Error("candidate rejected");
				},
			}),
		).toBe(78);
		expect(JSON.parse(stderr[0]!)).toMatchObject({
			code: "lead_registry_candidate_invalid",
		});
		expect(readFileSync(f.projectsPath, "utf8")).toBe(beforeProjects);
		expect(readFileSync(f.receiptPath, "utf8")).toBe(beforeReceipt);
	});

	it("maps malformed command arguments to the usage exit code", () => {
		const stderr: string[] = [];
		expect(
			runLeadRegistryCommand(["add", "--unknown"], {
				stderr: (line) => stderr.push(line),
			}),
		).toBe(64);
		expect(JSON.parse(stderr[0]!)).toMatchObject({
			code: "lead_registry_usage",
		});
	});

	it("rejects a projects registry symlink without following it", () => {
		const f = fixture();
		const sourcePath = join(f.homeDir, "projects-source.json");
		writeFileSync(sourcePath, readFileSync(f.projectsPath, "utf8"));
		rmSync(f.projectsPath);
		symlinkSync(sourcePath, f.projectsPath);
		const stderr: string[] = [];

		expect(
			runLeadRegistryCommand(rayaAddArgs, {
				homeDir: f.homeDir,
				env: { FLYWHEEL_SUMMARY_CONFIG_LOCK_HELD: "1" },
				stderr: (line) => stderr.push(line),
				validateTeamleadCandidate: () => undefined,
			}),
		).toBe(78);
		expect(JSON.parse(stderr[0]!)).toMatchObject({
			code: "lead_registry_source_invalid",
		});
		expect(readFileSync(sourcePath, "utf8")).toBe(
			`${JSON.stringify(f.registry, null, 2)}\n`,
		);
	});

	it("fails the fence when projects change after candidate validation", () => {
		const f = fixture();
		const beforeReceipt = readFileSync(f.receiptPath, "utf8");
		const stderr: string[] = [];
		let validations = 0;

		expect(
			runLeadRegistryCommand(rayaAddArgs, {
				homeDir: f.homeDir,
				env: { FLYWHEEL_SUMMARY_CONFIG_LOCK_HELD: "1" },
				stderr: (line) => stderr.push(line),
				validateTeamleadCandidate: () => {
					validations += 1;
					if (validations === 2) writeFileSync(f.projectsPath, "[]\n");
				},
			}),
		).toBe(78);
		expect(JSON.parse(stderr[0]!)).toMatchObject({
			code: "lead_registry_source_stale",
		});
		expect(readFileSync(f.projectsPath, "utf8")).toBe("[]\n");
		expect(readFileSync(f.receiptPath, "utf8")).toBe(beforeReceipt);
	});

	it("fails the fence when the receipt changes after candidate validation", () => {
		const f = fixture();
		const beforeProjects = readFileSync(f.projectsPath, "utf8");
		const stderr: string[] = [];
		let validations = 0;

		expect(
			runLeadRegistryCommand(rayaAddArgs, {
				homeDir: f.homeDir,
				env: { FLYWHEEL_SUMMARY_CONFIG_LOCK_HELD: "1" },
				stderr: (line) => stderr.push(line),
				validateTeamleadCandidate: () => {
					validations += 1;
					if (validations === 2) writeFileSync(f.receiptPath, "{}\n");
				},
			}),
		).toBe(78);
		expect(JSON.parse(stderr[0]!)).toMatchObject({
			code: "lead_registry_source_stale",
		});
		expect(readFileSync(f.projectsPath, "utf8")).toBe(beforeProjects);
		expect(readFileSync(f.receiptPath, "utf8")).toBe("{}\n");
	});

	it("retains the intent when a corrupted receipt backup prevents rollback", () => {
		const f = fixture();
		const beforeProjects = readFileSync(f.projectsPath, "utf8");
		const stderr: string[] = [];

		expect(
			runLeadRegistryCommand(rayaAddArgs, {
				homeDir: f.homeDir,
				env: { FLYWHEEL_SUMMARY_CONFIG_LOCK_HELD: "1" },
				stderr: (line) => stderr.push(line),
				validateTeamleadCandidate: () => undefined,
				afterProjectsRename: () => {
					const backup = readdirSync(
						join(f.homeDir, ".flywheel", "state", "summary-registry"),
					).find((name) => name.includes(".bak-fly2444-"));
					expect(backup).toBeDefined();
					writeFileSync(
						join(f.homeDir, ".flywheel", "state", "summary-registry", backup!),
						"{}\n",
					);
					throw new Error("simulated split with corrupted backup");
				},
			}),
		).toBe(70);
		expect(JSON.parse(stderr[0]!)).toMatchObject({
			code: "lead_registry_rollback_failed",
		});
		expect(readFileSync(f.projectsPath, "utf8")).toBe(beforeProjects);
		expect(existsSync(`${f.receiptPath}.lead-registry-intent.json`)).toBe(true);
	});

	it("recovers an absent intent as an idempotent no-op", () => {
		const f = fixture();
		const stdout: string[] = [];

		expect(
			runLeadRegistryCommand(["recover"], {
				homeDir: f.homeDir,
				env: { FLYWHEEL_SUMMARY_CONFIG_LOCK_HELD: "1" },
				stdout: (line) => stdout.push(line),
			}),
		).toBe(0);
		expect(JSON.parse(stdout[0]!)).toEqual({ ok: true, state: "none" });
	});

	it("rejects a dangling intent symlink instead of treating it as absent", () => {
		const f = fixture();
		const intentPath = `${f.receiptPath}.lead-registry-intent.json`;
		symlinkSync(join(f.homeDir, "missing-intent-target"), intentPath);
		const stderr: string[] = [];

		expect(
			runLeadRegistryCommand(["recover"], {
				homeDir: f.homeDir,
				env: { FLYWHEEL_SUMMARY_CONFIG_LOCK_HELD: "1" },
				stderr: (line) => stderr.push(line),
			}),
		).toBe(78);
		expect(JSON.parse(stderr[0]!)).toMatchObject({
			code: "lead_registry_source_invalid",
		});
		expect(existsSync(intentPath)).toBe(false);
	});

	it.each([
		["done", "cleaned_done"],
		["pending", "cleaned_unwritten"],
	] as const)(
		"cleans a %s intent after revalidating the before image",
		(phase, state) => {
			const f = fixture();
			const projects = readFileSync(f.projectsPath, "utf8");
			const receipt = JSON.parse(readFileSync(f.receiptPath, "utf8"));
			const intentPath = writeIntent(f, {
				phase,
				projectsShaBefore: sha256(projects),
				receiptDigestBefore: receipt.summaryAssignmentDigest,
				projectsShaPlanned: "c".repeat(64),
				receiptDigestPlanned: "d".repeat(64),
			});
			const stdout: string[] = [];

			expect(
				runLeadRegistryCommand(["recover"], {
					homeDir: f.homeDir,
					env: { FLYWHEEL_SUMMARY_CONFIG_LOCK_HELD: "1" },
					stdout: (line) => stdout.push(line),
					validateTeamleadCandidate: () => undefined,
				}),
			).toBe(0);
			expect(existsSync(intentPath)).toBe(false);
			expect(JSON.parse(stdout[0]!)).toMatchObject({ ok: true, state });
		},
	);

	it("finalizes a fully landed planned image", () => {
		const f = fixture();
		const beforeProjects = readFileSync(f.projectsPath, "utf8");
		const beforeReceipt = JSON.parse(readFileSync(f.receiptPath, "utf8"));
		const stdout: string[] = [];
		expect(
			runLeadRegistryCommand(rayaAddArgs, {
				homeDir: f.homeDir,
				env: { FLYWHEEL_SUMMARY_CONFIG_LOCK_HELD: "1" },
				validateTeamleadCandidate: () => undefined,
			}),
		).toBe(0);
		const projects = readFileSync(f.projectsPath, "utf8");
		const receipt = JSON.parse(readFileSync(f.receiptPath, "utf8"));
		const intentPath = writeIntent(f, {
			projectsShaBefore: sha256(beforeProjects),
			receiptDigestBefore: beforeReceipt.summaryAssignmentDigest,
			projectsShaPlanned: sha256(projects),
			receiptDigestPlanned: receipt.summaryAssignmentDigest,
		});
		let recoveryValidations = 0;

		expect(
			runLeadRegistryCommand(["recover"], {
				homeDir: f.homeDir,
				env: { FLYWHEEL_SUMMARY_CONFIG_LOCK_HELD: "1" },
				stdout: (line) => stdout.push(line),
				validateTeamleadCandidate: () => {
					recoveryValidations += 1;
				},
			}),
		).toBe(0);
		expect(existsSync(intentPath)).toBe(false);
		expect(recoveryValidations).toBe(2);
		expect(JSON.parse(stdout.at(-1)!)).toEqual({
			ok: true,
			state: "finalized",
		});
	});

	it("rejects a recovery image outside the enumerated states", () => {
		const f = fixture();
		const intentPath = writeIntent(f, {
			projectsShaBefore: "a".repeat(64),
			receiptDigestBefore: "b".repeat(64),
			projectsShaPlanned: "c".repeat(64),
			receiptDigestPlanned: "d".repeat(64),
		});
		const stderr: string[] = [];

		expect(
			runLeadRegistryCommand(["recover"], {
				homeDir: f.homeDir,
				env: { FLYWHEEL_SUMMARY_CONFIG_LOCK_HELD: "1" },
				stderr: (line) => stderr.push(line),
				validateTeamleadCandidate: () => undefined,
			}),
		).toBe(78);
		expect(existsSync(intentPath)).toBe(true);
		expect(JSON.parse(stderr[0]!)).toMatchObject({
			code: "lead_registry_recovery_conflict",
		});
	});

	it("recovers the pending split left by a hard process exit", () => {
		const f = fixture();
		const beforeProjects = readFileSync(f.projectsPath, "utf8");
		const beforeReceipt = readFileSync(f.receiptPath, "utf8");
		const scriptPath = join(f.homeDir, "crash-after-projects-rename.mjs");
		const commandModule = new URL(
			"../commands/lead-registry.ts",
			import.meta.url,
		).href;
		writeFileSync(
			scriptPath,
			`import { runLeadRegistryCommand } from ${JSON.stringify(commandModule)};\n` +
				`const result = runLeadRegistryCommand(${JSON.stringify(rayaAddArgs)}, {\n` +
				`  homeDir: ${JSON.stringify(f.homeDir)},\n` +
				`  env: { FLYWHEEL_SUMMARY_CONFIG_LOCK_HELD: "1" },\n` +
				`  validateTeamleadCandidate: () => undefined,\n` +
				`  afterProjectsRename: () => process.exit(91),\n` +
				`});\nprocess.exit(result);\n`,
		);

		const crashed = spawnSync(
			process.execPath,
			["--import", "tsx", scriptPath],
			{ cwd: process.cwd(), encoding: "utf8" },
		);
		expect(crashed.status, crashed.stderr).toBe(91);
		expect(readFileSync(f.projectsPath, "utf8")).not.toBe(beforeProjects);
		expect(readFileSync(f.receiptPath, "utf8")).toBe(beforeReceipt);
		expect(existsSync(`${f.receiptPath}.lead-registry-intent.json`)).toBe(true);

		const stdout: string[] = [];
		expect(
			runLeadRegistryCommand(["recover"], {
				homeDir: f.homeDir,
				env: { FLYWHEEL_SUMMARY_CONFIG_LOCK_HELD: "1" },
				stdout: (line) => stdout.push(line),
				validateTeamleadCandidate: () => undefined,
			}),
		).toBe(0);
		expect(readFileSync(f.projectsPath, "utf8")).toBe(beforeProjects);
		expect(readFileSync(f.receiptPath, "utf8")).toBe(beforeReceipt);
		expect(JSON.parse(stdout[0]!)).toEqual({
			ok: true,
			state: "restored_projects",
		});
	});

	it("recovers the projects-first crash state from its bound backup", () => {
		const f = fixture();
		const beforeProjects = readFileSync(f.projectsPath, "utf8");
		const beforeReceipt = JSON.parse(readFileSync(f.receiptPath, "utf8"));
		const projectsBackup = `${f.projectsPath}.lead-registry-test.bak`;
		const receiptBackup = `${f.receiptPath}.lead-registry-test.bak`;
		writeFileSync(projectsBackup, beforeProjects);
		writeFileSync(receiptBackup, readFileSync(f.receiptPath, "utf8"));
		const candidate = structuredClone(f.registry);
		candidate.push({
			projectName: "raya",
			projectRoot: "/tmp/raya",
			leads: [
				{
					agentId: "raya-lead",
					summaryRole: "recipient",
					chatChannel: "40000000000000001",
					match: { labels: ["raya-lead"] },
					botTokenEnv: "RAYA_BOT_TOKEN",
					botUserId: "50000000000000001",
					backend: "codex-app-server",
					codexProfile: "full-access",
					canSpawnRunners: false,
				},
			],
		});
		const candidateText = `${JSON.stringify(candidate, null, 2)}\n`;
		writeFileSync(f.projectsPath, candidateText);
		const planned = compileSummaryAssignments(candidate, {
			state: "selected",
			granularity: "per-lead",
			setBy: "founder",
			setAt: "2026-09-08T00:00:00.000Z",
		});
		const intentPath = `${f.receiptPath}.lead-registry-intent.json`;
		writeFileSync(
			intentPath,
			JSON.stringify({
				schemaVersion: 1,
				phase: "pending",
				leadKey: "raya-raya-lead",
				startedAt: "2026-09-08T02:00:00.000Z",
				projectsShaBefore: sha256(beforeProjects),
				receiptDigestBefore: beforeReceipt.summaryAssignmentDigest,
				projectsShaPlanned: sha256(candidateText),
				receiptDigestPlanned: planned.digest,
				backups: { projects: projectsBackup, receipt: receiptBackup },
			}),
		);
		const stdout: string[] = [];

		expect(
			runLeadRegistryCommand(["recover"], {
				homeDir: f.homeDir,
				env: { FLYWHEEL_SUMMARY_CONFIG_LOCK_HELD: "1" },
				stdout: (line) => stdout.push(line),
				validateTeamleadCandidate: () => undefined,
			}),
		).toBe(0);
		expect(readFileSync(f.projectsPath, "utf8")).toBe(beforeProjects);
		expect(existsSync(intentPath)).toBe(false);
		expect(JSON.parse(stdout[0]!)).toMatchObject({
			ok: true,
			state: "restored_projects",
		});
	});
});
