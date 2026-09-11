/**
 * FLY-123 WS-A + WS-C: per-runner CODEX_HOME provisioning + credential
 * lockdown. Unit-covers the home module against a temp source ~/.codex and a
 * temp homes root (no real ~/.codex touched).
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	admitCodexAgentHome,
	assertCodexSourceIdentity,
	codexAgentHomeDir,
	codexCredentialTruthPath,
	codexHomeDir,
	codexHomesRoot,
	discoverAccountPool as discoverAccountPoolProduction,
	migrateCodexAgentHomeCredential,
	migrateCodexHomeCredential,
	pinRunnerNotice,
	provisionCodexAgentHome,
	provisionCodexHome as provisionCodexHomeProduction,
	rawCodexBin,
	releaseCodexAgentHomeLease,
	removeCodexHome,
	renderCodexHomeConfig,
	resolveExecutionCodexHome,
	retireCodexExecutionHome,
	scrubCodexHomeCredential,
	scrubOrphanedCodexAgentHomes,
	scrubOrphanedCodexHomes,
	sourceCodexDir,
	stripInheritedSecretEnv,
	stripSecretEnv,
} from "../src/codex-home.js";

const GLOBAL_CONFIG = `sandbox_mode = "workspace-write"
approval_policy = "never"
model = "gpt-5-codex"

[projects."/Users/x/Dev/flywheel"]
trust_level = "trusted"
`;
const TOKEN = "gho_AbC123_def-456";

let tmp: string;
let env: NodeJS.ProcessEnv;
let registryPath: string;
let ledgerRoot: string;

function jwt(email: string, accountId: string, plan = "pro"): string {
	return [
		Buffer.from('{"alg":"none"}').toString("base64url"),
		Buffer.from(
			JSON.stringify({
				email,
				"https://api.openai.com/auth": {
					chatgpt_account_id: accountId,
					chatgpt_plan_type: plan,
				},
			}),
		).toString("base64url"),
		"signature",
	].join(".");
}

function testAuth(
	email = "personal@example.test",
	accountId = "acct-personal",
) {
	return JSON.stringify({
		tokens: {
			id_token: jwt(email, accountId),
			access_token: "test-access-canary",
			refresh_token: "test-refresh-canary",
		},
	});
}

function provisionCodexHome(
	opts: Parameters<typeof provisionCodexHomeProduction>[0],
): string {
	return provisionCodexHomeProduction({
		...opts,
		registryPath,
		ledgerRoot,
	});
}

function discoverAccountPool(envArg: NodeJS.ProcessEnv = env): string[] {
	return discoverAccountPoolProduction(envArg, registryPath);
}

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "fly123-home-"));
	const src = join(tmp, "dotcodex");
	mkdirSync(join(src, "profiles", "personal"), { recursive: true });
	mkdirSync(join(src, "profiles", "business"), { recursive: true });
	registryPath = join(tmp, "codex-account-registry.json");
	ledgerRoot = join(tmp, "codex-account-ledger");
	writeFileSync(
		registryPath,
		JSON.stringify({
			version: 1,
			primary: "personal",
			profiles: [
				{
					name: "school",
					email: "school@example.test",
					role: "manual_backup",
				},
				{
					name: "personal",
					email: "personal@example.test",
					role: "primary",
				},
				{
					name: "business",
					email: "business@example.test",
					role: "manual_backup",
				},
			],
		}),
	);
	writeFileSync(join(src, "auth.json"), testAuth());
	chmodSync(join(src, "auth.json"), 0o600);
	writeFileSync(join(src, "config.toml"), GLOBAL_CONFIG);
	env = {
		HOME: tmp,
		FLYWHEEL_CODEX_HOMES_ROOT: join(tmp, "homes"),
		FLYWHEEL_CODEX_SOURCE_HOME: src,
		FLYWHEEL_CODEX_SESSION_DIR: join(tmp, "codex-sessions"),
	};
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("path resolution (WS-E seam)", () => {
	it("codexHomesRoot honors FLYWHEEL_CODEX_HOMES_ROOT", () => {
		expect(codexHomesRoot(env)).toBe(join(tmp, "homes"));
	});

	it("codexHomeDir nests the execution id under the root", () => {
		expect(codexHomeDir("exec-42", env)).toBe(join(tmp, "homes", "exec-42"));
	});

	it("defaults to ~/.flywheel/codex-homes when unset", () => {
		expect(codexHomesRoot({})).toMatch(/\.flywheel\/codex-homes$/);
	});

	it("sourceCodexDir honors FLYWHEEL_CODEX_SOURCE_HOME", () => {
		expect(sourceCodexDir(env)).toBe(join(tmp, "dotcodex"));
	});

	it("rejects a relative credential source home", () => {
		expect(() =>
			codexCredentialTruthPath({ FLYWHEEL_CODEX_SOURCE_HOME: "relative-home" }),
		).toThrow(/credential source home must be absolute/);
	});
});

describe("FLY-2358 agent home path", () => {
	it("maps the same project and role to the same persistent home", () => {
		const identity = { project: "flywheel", role: "implement" };
		expect(codexAgentHomeDir(identity, env)).toBe(
			join(tmp, "homes", "agents", "flywheel", "implement"),
		);
		expect(codexAgentHomeDir(identity, env)).toBe(
			codexAgentHomeDir({ ...identity }, env),
		);
	});

	it("keeps different agents, projects, and case-distinct agents apart", () => {
		const baseline = codexAgentHomeDir(
			{ project: "flywheel", role: "implement" },
			env,
		);
		const comparisons = [
			{ project: "flywheel", role: "qa" },
			{ project: "joycon-typeless", role: "implement" },
			{ project: "flywheel", role: "design" },
			{ project: "flywheel", role: "Implement" },
		];
		for (const identity of comparisons) {
			expect(codexAgentHomeDir(identity, env)).not.toBe(baseline);
		}
	});

	it.each([
		[{ project: "bad/project", role: "implement" }],
		[{ project: "flywheel", role: "bad/role" }],
		[{ project: "x".repeat(129), role: "implement" }],
		[{ project: "flywheel", role: "x".repeat(129) }],
	])("rejects an unsafe identity before forming a path", (identity) => {
		expect(() => codexAgentHomeDir(identity, env)).toThrow(
			/invalid codex agent home (project|role)/,
		);
	});
});

describe("FLY-2358 agent home admission and provisioning", () => {
	const identity = { project: "flywheel", role: "implement" };

	it("publishes legacy memory before creating the first lease", async () => {
		const legacyMemories = join(codexHomeDir("exec-old", env), "memories");
		mkdirSync(legacyMemories, { recursive: true });
		writeFileSync(join(legacyMemories, "MEMORY.md"), "legacy marker\n");
		const home = codexAgentHomeDir(identity, env);
		const loader = vi.fn(() => {
			expect(readdirSync(join(home, ".flywheel-leases"))).toEqual([]);
			return {
				sources: [
					{
						executionId: "exec-old",
						issueId: "issue-old",
						issueIdentifier: "FLY-OLD",
						issueTitle: "Old task",
						startedAt: "2026-07-19 18:36:36",
					},
				],
				skipped: [],
			};
		});

		const admission = await admitCodexAgentHome(
			{
				...identity,
				executionId: "exec-new",
				requestedAssemblyArm: "bare",
				loadMemorySeedSources: loader,
			},
			env,
		);

		expect(loader).toHaveBeenCalledTimes(1);
		expect(admission.memorySeed).toBe("published");
		const manifest = JSON.parse(
			readFileSync(
				join(home, ".flywheel-memory-seed", "manifest.json"),
				"utf8",
			),
		);
		expect(
			readFileSync(
				join(
					home,
					".flywheel-memory-seed",
					"snapshots",
					manifest.sources[0].snapshotHash,
					"MEMORY.md",
				),
				"utf8",
			),
		).toBe("legacy marker\n");
		expect(readdirSync(join(home, ".flywheel-leases"))).toEqual(["exec-new"]);
	});

	it("defers a B1 home while busy and seeds it after every lease drains", async () => {
		const first = await admitCodexAgentHome(
			{
				...identity,
				executionId: "exec-a",
				requestedAssemblyArm: "bare",
			},
			env,
		);
		const legacyMemories = join(codexHomeDir("exec-old", env), "memories");
		mkdirSync(legacyMemories, { recursive: true });
		writeFileSync(join(legacyMemories, "MEMORY.md"), "drained marker\n");
		const loader = vi.fn(() => ({
			sources: [
				{
					executionId: "exec-old",
					issueId: null,
					issueIdentifier: null,
					issueTitle: null,
					startedAt: null,
				},
			],
			skipped: [],
		}));
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		const second = await admitCodexAgentHome(
			{
				...identity,
				executionId: "exec-b",
				requestedAssemblyArm: "bare",
				loadMemorySeedSources: loader,
			},
			env,
		);
		expect(second.memorySeed).toBe("deferred_busy");
		expect(loader).not.toHaveBeenCalled();
		expect(warning).toHaveBeenCalledWith(
			expect.stringContaining("deferred_busy project=flywheel role=implement"),
		);
		warning.mockRestore();
		await releaseCodexAgentHomeLease(first.handle, env);
		await releaseCodexAgentHomeLease(second.handle, env);

		const third = await admitCodexAgentHome(
			{
				...identity,
				executionId: "exec-c",
				requestedAssemblyArm: "bare",
				loadMemorySeedSources: loader,
			},
			env,
		);
		expect(third.memorySeed).toBe("published");
		expect(loader).toHaveBeenCalledTimes(1);
		expect(
			readFileSync(
				join(third.handle.home, ".flywheel-memory-seed", "catalog.md"),
				"utf8",
			),
		).toContain("snapshots/");
	});

	it("replays a post-rename crash from the complete archive without adding a lease twice", async () => {
		const legacyMemories = join(codexHomeDir("exec-old", env), "memories");
		mkdirSync(legacyMemories, { recursive: true });
		writeFileSync(join(legacyMemories, "MEMORY.md"), "crash marker\n");
		const loader = vi.fn(() => ({
			sources: [
				{
					executionId: "exec-old",
					issueId: null,
					issueIdentifier: null,
					issueTitle: null,
					startedAt: null,
				},
			],
			skipped: [],
		}));
		await expect(
			admitCodexAgentHome(
				{
					...identity,
					executionId: "exec-new",
					requestedAssemblyArm: "bare",
					loadMemorySeedSources: loader,
					memorySeedTesting: {
						afterRename: () => {
							throw new Error("post-rename crash");
						},
					},
				},
				env,
			),
		).rejects.toThrow("post-rename crash");
		const home = codexAgentHomeDir(identity, env);
		expect(readdirSync(join(home, ".flywheel-leases"))).toEqual([]);
		expect(
			existsSync(join(home, ".flywheel-memory-seed", "manifest.json")),
		).toBe(true);

		const replay = await admitCodexAgentHome(
			{
				...identity,
				executionId: "exec-new",
				requestedAssemblyArm: "bare",
				loadMemorySeedSources: loader,
			},
			env,
		);
		expect(replay.memorySeed).toBe("reused");
		expect(loader).toHaveBeenCalledTimes(1);
		expect(readdirSync(join(home, ".flywheel-leases"))).toEqual(["exec-new"]);
	});

	it("leaves no lease or completed archive after a seed failure and retries", async () => {
		const failingLoader = vi.fn(() => {
			throw new Error("source query failed");
		});
		await expect(
			admitCodexAgentHome(
				{
					...identity,
					executionId: "exec-new",
					requestedAssemblyArm: "bare",
					loadMemorySeedSources: failingLoader,
				},
				env,
			),
		).rejects.toThrow("source query failed");
		const home = codexAgentHomeDir(identity, env);
		expect(existsSync(join(home, ".flywheel-agent-home.json"))).toBe(true);
		expect(readdirSync(join(home, ".flywheel-leases"))).toEqual([]);
		expect(existsSync(join(home, ".flywheel-memory-seed"))).toBe(false);

		const retry = await admitCodexAgentHome(
			{
				...identity,
				executionId: "exec-new",
				requestedAssemblyArm: "bare",
				loadMemorySeedSources: () => ({ sources: [], skipped: [] }),
			},
			env,
		);
		expect(retry.memorySeed).toBe("published");
		expect(readdirSync(join(home, ".flywheel-leases"))).toEqual(["exec-new"]);
	});

	it("rejects a completed directory without a valid manifest before creating a lease", async () => {
		const initial = await admitCodexAgentHome(
			{
				...identity,
				executionId: "exec-initial",
				requestedAssemblyArm: "bare",
			},
			env,
		);
		await releaseCodexAgentHomeLease(initial.handle, env);
		const seed = join(initial.handle.home, ".flywheel-memory-seed");
		mkdirSync(seed);

		await expect(
			admitCodexAgentHome(
				{
					...identity,
					executionId: "exec-new",
					requestedAssemblyArm: "bare",
				},
				env,
			),
		).rejects.toThrow("invalid codex memory seed manifest");
		expect(readdirSync(join(initial.handle.home, ".flywheel-leases"))).toEqual(
			[],
		);
	});

	it("creates a keyed home lazily and makes repeated admission idempotent", async () => {
		expect(existsSync(join(tmp, "homes", "agents"))).toBe(false);
		const first = await admitCodexAgentHome(
			{
				...identity,
				executionId: "exec-a",
				requestedAssemblyArm: "superpowers",
			},
			env,
		);
		const markerPath = join(first.handle.home, ".flywheel-agent-home.json");
		const marker = JSON.parse(readFileSync(markerPath, "utf8"));
		expect(first).toMatchObject({
			effectiveAssemblyArm: "superpowers",
			inherited: false,
			liveLeases: 1,
			createdLease: true,
		});
		expect(marker).toMatchObject({
			version: 1,
			...identity,
			assemblyArm: "superpowers",
			materializedArm: null,
		});
		expect(marker.createdAt).toEqual(expect.any(String));

		const repeated = await admitCodexAgentHome(
			{
				...identity,
				executionId: "exec-a",
				requestedAssemblyArm: "matt",
			},
			env,
		);
		expect(repeated.handle).toEqual(first.handle);
		expect(repeated).toMatchObject({
			effectiveAssemblyArm: "superpowers",
			inherited: true,
			liveLeases: 1,
			createdLease: false,
		});
		expect(JSON.parse(readFileSync(markerPath, "utf8")).createdAt).toBe(
			marker.createdAt,
		);
	});

	it("inherits the home arm while another execution holds a lease", async () => {
		const first = await admitCodexAgentHome(
			{
				...identity,
				executionId: "exec-a",
				requestedAssemblyArm: "matt",
			},
			env,
		);
		const second = await admitCodexAgentHome(
			{
				...identity,
				executionId: "exec-b",
				requestedAssemblyArm: "bare",
			},
			env,
		);
		expect(second.handle.home).toBe(first.handle.home);
		expect(second).toMatchObject({
			effectiveAssemblyArm: "matt",
			inherited: true,
			liveLeases: 2,
			createdLease: true,
		});
		expect(
			readdirSync(join(first.handle.home, ".flywheel-leases")).sort(),
		).toEqual(["exec-a", "exec-b"]);
	});

	it("keeps a keyed legacy credential copy ordinary across two live leases", async () => {
		const first = await admitCodexAgentHome(
			{
				...identity,
				executionId: "exec-copy-a",
				requestedAssemblyArm: "bare",
			},
			env,
		);
		writeFileSync(join(first.handle.home, "auth.json"), "legacy-copy", {
			mode: 0o600,
		});
		await provisionCodexAgentHome(first.handle, {
			env,
			skillFrameworkMode: "bare",
			registryPath,
			ledgerRoot,
		});
		const second = await admitCodexAgentHome(
			{
				...identity,
				executionId: "exec-copy-b",
				requestedAssemblyArm: "bare",
			},
			env,
		);
		await provisionCodexAgentHome(second.handle, {
			env,
			skillFrameworkMode: "bare",
			registryPath,
			ledgerRoot,
		});

		const authPath = join(first.handle.home, "auth.json");
		expect(lstatSync(authPath).isSymbolicLink()).toBe(false);
		expect(readFileSync(authPath)).toEqual(
			readFileSync(codexCredentialTruthPath(env)),
		);
		expect(
			existsSync(join(first.handle.home, ".credential-copy-pending")),
		).toBe(true);
	});

	it("ignores interrupted-write and foreign entries in the lease directory", async () => {
		const admission = await admitCodexAgentHome(
			{
				...identity,
				executionId: "exec-a",
				requestedAssemblyArm: "bare",
			},
			env,
		);
		await provisionCodexAgentHome(admission.handle, {
			env,
			ghToken: TOKEN,
			skillFrameworkMode: "bare",
			registryPath,
			ledgerRoot,
		});
		const leasesDir = join(admission.handle.home, ".flywheel-leases");
		writeFileSync(
			join(leasesDir, ".exec-a.1234.deadbeefdeadbeef.tmp"),
			"stale",
		);
		writeFileSync(join(leasesDir, ".DS_Store"), "foreign");
		mkdirSync(join(leasesDir, "foreign-dir"));

		await expect(
			releaseCodexAgentHomeLease(admission.handle, env),
		).resolves.toBeUndefined();
		expect(
			readFileSync(join(admission.handle.home, "config.toml"), "utf8"),
		).not.toContain("GH_TOKEN");
		await expect(
			admitCodexAgentHome(
				{
					...identity,
					executionId: "exec-b",
					requestedAssemblyArm: "matt",
				},
				env,
			),
		).resolves.toMatchObject({
			effectiveAssemblyArm: "matt",
			liveLeases: 1,
		});
	});

	it("serializes eight processes onto one arm, one memory seed, marker, and trust set", async () => {
		const barrier = join(tmp, "concurrency-barrier");
		const memoryCounter = join(tmp, "memory-seed-counter");
		const memorySource = "exec-memory-source";
		const sourceMemories = join(codexHomeDir(memorySource, env), "memories");
		mkdirSync(sourceMemories, { recursive: true });
		writeFileSync(join(sourceMemories, "MEMORY.md"), "concurrent marker\n");
		const worker = fileURLToPath(
			new URL(
				"./fixtures/codex-agent-home-concurrent-worker.ts",
				import.meta.url,
			),
		);
		const repoRoot = resolve(
			dirname(fileURLToPath(import.meta.url)),
			"../../..",
		);
		const arms = [
			"superpowers",
			"matt",
			"bare",
			"superpowers",
			"matt",
			"bare",
			"superpowers",
			"matt",
		] as const;
		const children = arms.map((arm, index) => {
			const executionId = `exec-concurrent-${index}`;
			const ready = join(tmp, `ready-${index}`);
			const worktree = join(tmp, `worktree-${index}`);
			mkdirSync(worktree);
			const child = spawn(process.execPath, ["--import", "tsx", worker], {
				cwd: repoRoot,
				env: {
					...process.env,
					...env,
					FLY_TEST_EXECUTION_ID: executionId,
					FLY_TEST_ASSEMBLY_ARM: arm,
					FLY_TEST_READY: ready,
					FLY_TEST_BARRIER: barrier,
					FLY_TEST_WORKTREE: worktree,
					FLY_TEST_REGISTRY: registryPath,
					FLY_TEST_LEDGER: join(ledgerRoot, executionId),
					FLY_TEST_GH_TOKEN: TOKEN,
					FLY_TEST_MEMORY_SOURCE: memorySource,
					FLY_TEST_MEMORY_COUNTER: memoryCounter,
					FLY_TEST_MATT_SKILLS: join(
						repoRoot,
						"vendor",
						"matt-skills",
						"skills",
					),
				},
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk) => {
				stdout += String(chunk);
			});
			child.stderr.on("data", (chunk) => {
				stderr += String(chunk);
			});
			return {
				arm,
				executionId,
				ready,
				worktree,
				done: new Promise<string>((resolveOutput, reject) => {
					child.once("error", reject);
					child.once("close", (code) => {
						if (code === 0) resolveOutput(stdout.trim());
						else reject(new Error(`worker ${index} exited ${code}: ${stderr}`));
					});
				}),
			};
		});
		await vi.waitFor(
			() => {
				expect(children.every((child) => existsSync(child.ready))).toBe(true);
			},
			{ timeout: 10_000, interval: 10 },
		);
		writeFileSync(barrier, "go\n");
		const results = await Promise.all(
			children.map(async (child) => ({
				...child,
				result: JSON.parse(await child.done) as {
					requestedAssemblyArm: string;
					effectiveAssemblyArm: string;
					inherited: boolean;
					memorySeed: string;
				},
			})),
		);
		const effectiveArm = results[0]!.result.effectiveAssemblyArm;
		expect(
			results.every(
				({ result }) => result.effectiveAssemblyArm === effectiveArm,
			),
		).toBe(true);
		for (const { result } of results) {
			expect(result.inherited).toBe(
				result.requestedAssemblyArm !== effectiveArm,
			);
		}
		const home = codexAgentHomeDir(identity, env);
		const marker = JSON.parse(
			readFileSync(join(home, ".flywheel-agent-home.json"), "utf8"),
		);
		expect(marker.assemblyArm).toBe(effectiveArm);
		expect(marker.materializedArm).toBe(effectiveArm);
		expect(readdirSync(join(home, ".flywheel-leases"))).toHaveLength(8);
		expect(readFileSync(memoryCounter, "utf8").trim().split("\n")).toHaveLength(
			1,
		);
		expect(
			results.filter(({ result }) => result.memorySeed === "published"),
		).toHaveLength(1);
		expect(
			results.filter(({ result }) => result.memorySeed === "reused"),
		).toHaveLength(7);
		expect(
			readFileSync(join(home, ".flywheel-memory-seed", "catalog.md"), "utf8"),
		).toContain("snapshots/");
		const config = readFileSync(join(home, "config.toml"), "utf8");
		expect(() => parseToml(config)).not.toThrow();
		for (const child of children) {
			expect(config).toContain(JSON.stringify(child.worktree));
		}
	}, 30_000);

	it("fails closed on a corrupt marker while a lease is live", async () => {
		const first = await admitCodexAgentHome(
			{
				...identity,
				executionId: "exec-a",
				requestedAssemblyArm: "bare",
			},
			env,
		);
		writeFileSync(
			join(first.handle.home, ".flywheel-agent-home.json"),
			"not-json",
		);
		await expect(
			admitCodexAgentHome(
				{
					...identity,
					executionId: "exec-b",
					requestedAssemblyArm: "bare",
				},
				env,
			),
		).rejects.toThrow(/agent home marker/);
		expect(
			existsSync(join(first.handle.home, ".flywheel-leases", "exec-b")),
		).toBe(false);
	});

	it("provisions through the admitted home and materializes the contract", async () => {
		const admission = await admitCodexAgentHome(
			{
				...identity,
				executionId: "exec-a",
				requestedAssemblyArm: "bare",
			},
			env,
		);
		await provisionCodexAgentHome(admission.handle, {
			env,
			ghToken: TOKEN,
			skillFrameworkMode: "bare",
			registryPath,
			ledgerRoot,
		});
		expect(
			readFileSync(join(admission.handle.home, "config.toml"), "utf8"),
		).toContain(`GH_TOKEN = "${TOKEN}"`);
		expect(
			readFileSync(join(admission.handle.home, "AGENTS.md"), "utf8"),
		).toContain("Flywheel Codex Runner Contract");
		expect(
			JSON.parse(
				readFileSync(
					join(admission.handle.home, ".flywheel-agent-home.json"),
					"utf8",
				),
			).materializedArm,
		).toBe("bare");
	});

	it("accumulates live worktree trust and prunes paths that disappear", async () => {
		const worktreeA = join(tmp, "worktree-a");
		const worktreeB = join(tmp, "worktree-b");
		mkdirSync(worktreeA);
		mkdirSync(worktreeB);
		const first = await admitCodexAgentHome(
			{
				...identity,
				executionId: "exec-a",
				requestedAssemblyArm: "bare",
			},
			env,
		);
		const second = await admitCodexAgentHome(
			{
				...identity,
				executionId: "exec-b",
				requestedAssemblyArm: "bare",
			},
			env,
		);
		await provisionCodexAgentHome(first.handle, {
			env,
			skillFrameworkMode: "bare",
			trustedProjectPath: worktreeA,
			registryPath,
			ledgerRoot,
		});
		await provisionCodexAgentHome(second.handle, {
			env,
			skillFrameworkMode: "bare",
			trustedProjectPath: worktreeB,
			registryPath,
			ledgerRoot,
		});
		let config = readFileSync(join(first.handle.home, "config.toml"), "utf8");
		expect(config).toContain(JSON.stringify(worktreeA));
		expect(config).toContain(JSON.stringify(worktreeB));

		rmSync(worktreeA, { recursive: true });
		await provisionCodexAgentHome(second.handle, {
			env,
			skillFrameworkMode: "bare",
			trustedProjectPath: worktreeB,
			registryPath,
			ledgerRoot,
		});
		config = readFileSync(join(first.handle.home, "config.toml"), "utf8");
		expect(config).not.toContain(JSON.stringify(worktreeA));
		expect(config).toContain(JSON.stringify(worktreeB));
	});

	it("rejects provisioning without the exact live lease and home arm", async () => {
		const admission = await admitCodexAgentHome(
			{
				...identity,
				executionId: "exec-a",
				requestedAssemblyArm: "bare",
			},
			env,
		);
		await expect(
			provisionCodexAgentHome(
				{ ...admission.handle, token: "wrong" },
				{ env, skillFrameworkMode: "bare", registryPath, ledgerRoot },
			),
		).rejects.toThrow(/lease token/);
		await expect(
			provisionCodexAgentHome(admission.handle, {
				env,
				skillFrameworkMode: "matt",
				registryPath,
				ledgerRoot,
			}),
		).rejects.toThrow(/assembly arm/);
	});

	it("releases only an exact lease and scrubs credentials after the last one", async () => {
		const first = await admitCodexAgentHome(
			{
				...identity,
				executionId: "exec-a",
				requestedAssemblyArm: "bare",
			},
			env,
		);
		const second = await admitCodexAgentHome(
			{
				...identity,
				executionId: "exec-b",
				requestedAssemblyArm: "bare",
			},
			env,
		);
		await provisionCodexAgentHome(first.handle, {
			env,
			ghToken: TOKEN,
			skillFrameworkMode: "bare",
			registryPath,
			ledgerRoot,
		});
		await expect(
			releaseCodexAgentHomeLease({ ...first.handle, token: "wrong" }, env),
		).rejects.toThrow(/lease token/);
		await releaseCodexAgentHomeLease(first.handle, env);
		expect(
			readFileSync(join(first.handle.home, "config.toml"), "utf8"),
		).toContain("GH_TOKEN");
		await releaseCodexAgentHomeLease(second.handle, env);
		expect(
			readFileSync(join(first.handle.home, "config.toml"), "utf8"),
		).not.toContain("GH_TOKEN");
	});

	it.each(["project-file", "project-symlink", "home-file", "home-symlink"])(
		"rejects hostile path component %s",
		async (shape) => {
			const agents = join(tmp, "homes", "agents");
			mkdirSync(agents, { recursive: true });
			const project = join(agents, "flywheel");
			const home = join(project, "implement");
			const target = join(tmp, "target");
			mkdirSync(target);
			if (shape === "project-file") writeFileSync(project, "hostile");
			if (shape === "project-symlink") symlinkSync(target, project);
			if (shape.startsWith("home-")) mkdirSync(project);
			if (shape === "home-file") writeFileSync(home, "hostile");
			if (shape === "home-symlink") symlinkSync(target, home);
			await expect(
				admitCodexAgentHome(
					{
						...identity,
						executionId: "exec-a",
						requestedAssemblyArm: "bare",
					},
					env,
				),
			).rejects.toThrow(/unsafe codex agent home path/);
		},
	);
});

describe("FLY-2358 execution home resolution and retirement", () => {
	const identity = { project: "flywheel", role: "implement" };
	const writeSession = (executionId: string, codexAgentHome: unknown): void => {
		const stateDir = join(env.FLYWHEEL_CODEX_SESSION_DIR!, executionId);
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(
			join(stateDir, "session.json"),
			JSON.stringify({ codexAgentHome }),
		);
	};

	it("distinguishes keyed, prepublished, and legacy execution homes", async () => {
		const admission = await admitCodexAgentHome(
			{
				...identity,
				executionId: "exec-keyed",
				requestedAssemblyArm: "bare",
			},
			env,
		);
		expect(
			resolveExecutionCodexHome("exec-keyed", identity, env),
		).toMatchObject({
			kind: "prepublished",
			...identity,
			home: admission.handle.home,
		});
		writeSession("exec-keyed", { ...identity, home: admission.handle.home });
		expect(resolveExecutionCodexHome("exec-keyed", identity, env)).toEqual({
			kind: "keyed",
			...identity,
			home: admission.handle.home,
		});
		expect(resolveExecutionCodexHome("exec-legacy", identity, env)).toEqual({
			kind: "legacy",
			home: codexHomeDir("exec-legacy", env),
		});
	});

	it("keeps recordless executions legacy when their expected identity cannot form a keyed path", () => {
		expect(
			resolveExecutionCodexHome(
				"exec-legacy",
				{ project: "my project", role: "impl/ement" },
				env,
			),
		).toEqual({
			kind: "legacy",
			home: codexHomeDir("exec-legacy", env),
		});
	});

	it.each([
		"malformed-json",
		"path-mismatch",
		"identity-mismatch",
		"expected-mismatch",
	])("fails closed for unresolved session state: %s", async (shape) => {
		const executionId = `exec-${shape}`;
		const admission = await admitCodexAgentHome(
			{
				...identity,
				executionId,
				requestedAssemblyArm: "bare",
			},
			env,
		);
		const stateDir = join(env.FLYWHEEL_CODEX_SESSION_DIR!, executionId);
		mkdirSync(stateDir, { recursive: true });
		if (shape === "malformed-json") {
			writeFileSync(join(stateDir, "session.json"), "not-json");
		} else {
			writeSession(executionId, {
				home:
					shape === "path-mismatch"
						? join(tmp, "outside")
						: admission.handle.home,
				project: shape === "identity-mismatch" ? "other" : identity.project,
				role: identity.role,
			});
		}
		const expected =
			shape === "expected-mismatch"
				? { project: identity.project, role: "qa" }
				: identity;
		expect(resolveExecutionCodexHome(executionId, expected, env).kind).toBe(
			"unknown",
		);
	});

	it("retires shared leases one by one and scrubs only after the last", async () => {
		const first = await admitCodexAgentHome(
			{
				...identity,
				executionId: "exec-a",
				requestedAssemblyArm: "bare",
			},
			env,
		);
		const second = await admitCodexAgentHome(
			{
				...identity,
				executionId: "exec-b",
				requestedAssemblyArm: "bare",
			},
			env,
		);
		for (const admission of [first, second]) {
			writeSession(admission.handle.executionId, {
				...identity,
				home: admission.handle.home,
			});
		}
		await provisionCodexAgentHome(first.handle, {
			env,
			ghToken: TOKEN,
			skillFrameworkMode: "bare",
			registryPath,
			ledgerRoot,
		});
		await retireCodexExecutionHome("exec-a", identity, env);
		expect(
			readFileSync(join(first.handle.home, "config.toml"), "utf8"),
		).toContain("GH_TOKEN");
		await retireCodexExecutionHome("exec-b", identity, env);
		expect(
			readFileSync(join(first.handle.home, "config.toml"), "utf8"),
		).not.toContain("GH_TOKEN");
		expect(readdirSync(join(first.handle.home, ".flywheel-leases"))).toEqual(
			[],
		);
	});

	it("keeps legacy retirement behavior unchanged", async () => {
		const home = provisionCodexHome({
			executionId: "exec-legacy",
			env,
			ghToken: TOKEN,
		});
		await retireCodexExecutionHome("exec-legacy", identity, env);
		expect(readFileSync(join(home, "config.toml"), "utf8")).not.toContain(
			"GH_TOKEN",
		);
	});
});

describe("FLY-2358 persistent agent home deletion guard", () => {
	const identity = { project: "flywheel", role: "implement" };

	it("refuses to delete a keyed home after its final lease retires", async () => {
		const admission = await admitCodexAgentHome(
			{
				...identity,
				executionId: "exec-keyed",
				requestedAssemblyArm: "bare",
			},
			env,
		);
		const stateDir = join(env.FLYWHEEL_CODEX_SESSION_DIR!, "exec-keyed");
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(
			join(stateDir, "session.json"),
			JSON.stringify({
				codexAgentHome: { ...identity, home: admission.handle.home },
			}),
		);
		await releaseCodexAgentHomeLease(admission.handle, env);
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(removeCodexHome("exec-keyed", env, identity)).toEqual({
			removed: false,
			reason: "agent_home_protected",
		});
		expect(existsSync(admission.handle.home)).toBe(true);
		expect(error).toHaveBeenCalledWith(
			expect.stringContaining("refuse_remove_agent_home"),
		);
		error.mockRestore();
	});

	it("preserves legacy deletion and reports its result", () => {
		const home = provisionCodexHome({ executionId: "exec-legacy", env });
		expect(removeCodexHome("exec-legacy", env, identity)).toEqual({
			removed: true,
		});
		expect(existsSync(home)).toBe(false);
	});

	it("fails closed for malformed state and the agents subtree fallback", () => {
		const stateDir = join(env.FLYWHEEL_CODEX_SESSION_DIR!, "exec-unknown");
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(join(stateDir, "session.json"), "not-json");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(removeCodexHome("exec-unknown", env, identity)).toEqual({
			removed: false,
			reason: "unresolved",
		});
		mkdirSync(join(tmp, "homes", "agents"), { recursive: true });
		expect(removeCodexHome("agents", env)).toEqual({
			removed: false,
			reason: "agent_home_protected",
		});
		expect(existsSync(join(tmp, "homes", "agents"))).toBe(true);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("remove_home_unresolved"),
		);
		warn.mockRestore();
	});
});

describe("FLY-2358 keyed-home startup janitor", () => {
	const identity = { project: "flywheel", role: "implement" };

	it("keeps reown candidates and removes terminal and orphan leases", async () => {
		const admissions = await Promise.all(
			[
				["exec-design", "design_done"],
				["exec-approved", "approved_to_ship"],
				["exec-terminal", "completed"],
				["exec-orphan", undefined],
			].map(async ([executionId]) =>
				admitCodexAgentHome(
					{
						...identity,
						executionId: executionId!,
						requestedAssemblyArm: "bare",
					},
					env,
				),
			),
		);
		await provisionCodexAgentHome(admissions[0].handle, {
			env,
			ghToken: TOKEN,
			skillFrameworkMode: "bare",
			registryPath,
			ledgerRoot,
		});
		const sessions = new Map([
			["exec-design", { status: "design_done", ...identity }],
			["exec-approved", { status: "approved_to_ship", ...identity }],
			["exec-terminal", { status: "completed", ...identity }],
		]);
		expect(await scrubOrphanedCodexAgentHomes(sessions, env)).toBe(2);
		expect(
			readdirSync(join(admissions[0].handle.home, ".flywheel-leases")).sort(),
		).toEqual(["exec-approved", "exec-design"]);
		expect(
			readFileSync(join(admissions[0].handle.home, "config.toml"), "utf8"),
		).toContain("GH_TOKEN");
	});

	it("fails closed when a live session identity does not match the home", async () => {
		const admission = await admitCodexAgentHome(
			{
				...identity,
				executionId: "exec-live",
				requestedAssemblyArm: "bare",
			},
			env,
		);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(
			await scrubOrphanedCodexAgentHomes(
				new Map([
					["exec-live", { status: "running", project: "flywheel", role: "qa" }],
				]),
				env,
			),
		).toBe(0);
		expect(
			existsSync(join(admission.handle.home, ".flywheel-leases", "exec-live")),
		).toBe(true);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("keyed_home_janitor_identity_mismatch"),
		);
		warn.mockRestore();
	});
});

describe("discoverAccountPool (dynamic, AC6)", () => {
	it("lists only existing canonical profile dirs sorted", () => {
		expect(discoverAccountPool(env)).toEqual(["business", "personal"]);
	});

	it("follows the pool when a profile is added (no code change)", () => {
		mkdirSync(join(tmp, "dotcodex", "profiles", "school"));
		expect(discoverAccountPool(env)).toEqual([
			"business",
			"personal",
			"school",
		]);
	});

	it("returns [] when the pool dir is absent", () => {
		expect(
			discoverAccountPool({ FLYWHEEL_CODEX_PROFILES_DIR: join(tmp, "nope") }),
		).toEqual([]);
	});

	it("excludes zombie and unknown profile directories", () => {
		mkdirSync(join(tmp, "dotcodex", "profiles", "personal1"));
		mkdirSync(join(tmp, "dotcodex", "profiles", "mystery"));
		expect(discoverAccountPool(env)).toEqual(["business", "personal"]);
	});
});

describe("renderCodexHomeConfig (WS-C delivery)", () => {
	it("preserves base config and appends the GH_TOKEN block", () => {
		const out = renderCodexHomeConfig(GLOBAL_CONFIG, TOKEN);
		expect(out).toContain('model = "gpt-5-codex"');
		expect(out).toContain("[shell_environment_policy.set]");
		expect(out).toContain(`GH_TOKEN = "${TOKEN}"`);
	});

	it("is idempotent — re-render does not stack duplicate blocks", () => {
		const once = renderCodexHomeConfig(GLOBAL_CONFIG, TOKEN);
		const twice = renderCodexHomeConfig(once, TOKEN);
		expect(twice).toBe(once);
		expect(twice.match(/shell_environment_policy/g)?.length).toBe(1);
	});

	it("emits no credential block when no token is given", () => {
		const out = renderCodexHomeConfig(GLOBAL_CONFIG);
		expect(out).not.toContain("shell_environment_policy");
		expect(out).toContain('model = "gpt-5-codex"');
	});

	it("strips a prior block when re-rendered without a token (scrub semantics)", () => {
		const withTok = renderCodexHomeConfig(GLOBAL_CONFIG, TOKEN);
		const scrubbed = renderCodexHomeConfig(withTok);
		expect(scrubbed).not.toContain("GH_TOKEN");
		expect(scrubbed).not.toContain("shell_environment_policy");
		expect(scrubbed).toContain('model = "gpt-5-codex"');
	});

	it("FLY-1604 fails loudly ONLY on unmergeable shell_environment_policy shapes — root dotted key or inline table (rewrite of R1 #5)", () => {
		// Root-level dotted/inline definitions must sit BEFORE any [table]
		// header — appended after one they would be relative keys inside that
		// table (exactly the false-positive class the root-aware merge fixed).
		const variants = [
			`shell_environment_policy.set.FOO = "bar"\n${GLOBAL_CONFIG}`,
			`shell_environment_policy = { set = { FOO = "bar" } }\n${GLOBAL_CONFIG}`,
		];
		for (const base of variants) {
			expect(() => renderCodexHomeConfig(base, TOKEN)).toThrow(
				/shell_environment_policy/,
			);
		}
		// A comment mentioning it must NOT trip the guard.
		expect(() =>
			renderCodexHomeConfig(
				`${GLOBAL_CONFIG}\n# shell_environment_policy is managed by flywheel\n`,
				TOKEN,
			),
		).not.toThrow();
	});

	it("FLY-1395 renders deterministic Codex skill-disable blocks", () => {
		const out = renderCodexHomeConfig(GLOBAL_CONFIG, TOKEN, {
			skillDisableNames: [
				"superpowers:test-driven-development",
				"superpowers:brainstorming",
				"superpowers:brainstorming",
			],
		});
		expect(out).toContain(
			'# >>> flywheel-managed skills (FLY-1395) — do not edit >>>\n[[skills.config]]\nname = "superpowers:brainstorming"\nenabled = false\n\n[[skills.config]]\nname = "superpowers:test-driven-development"\nenabled = false\n# <<< flywheel-managed skills (FLY-1395) <<<',
		);
		expect(out).toContain(`GH_TOKEN = "${TOKEN}"`);
	});

	it("FLY-1395 skill rendering is idempotent and does not stack blocks", () => {
		const opts = {
			skillDisableNames: ["superpowers:brainstorming"],
		};
		const once = renderCodexHomeConfig(GLOBAL_CONFIG, TOKEN, opts);
		const twice = renderCodexHomeConfig(once, TOKEN, opts);
		expect(twice).toBe(once);
		expect(twice.match(/flywheel-managed skills \(FLY-1395\)/g)).toHaveLength(
			2,
		);
	});

	it("FLY-1395 A arm opts absent remains byte-identical", () => {
		expect(renderCodexHomeConfig(GLOBAL_CONFIG, TOKEN)).toBe(
			`${GLOBAL_CONFIG.trimEnd()}\n\n# >>> flywheel-managed credential (FLY-123) — do not edit >>>\n[shell_environment_policy.set]\nGH_TOKEN = "${TOKEN}"\n# <<< flywheel-managed credential (FLY-123) <<<\n`,
		);
	});

	it("FLY-1604 fails loudly ONLY on unmergeable skills shapes — single table, dotted-inline array, inline table (rewrite of FLY-1395 guard)", () => {
		// Header form may sit anywhere; root dotted/inline forms must sit
		// BEFORE any [table] header to actually be root-level definitions.
		for (const base of [
			`${GLOBAL_CONFIG}\n[skills.config]\nname = "x"\n`,
			`skills.config = [{ name = "x", enabled = true }]\n${GLOBAL_CONFIG}`,
			`skills = { config = [] }\n${GLOBAL_CONFIG}`,
		]) {
			expect(() =>
				renderCodexHomeConfig(base, TOKEN, {
					skillDisableNames: ["superpowers:brainstorming"],
				}),
			).toThrow(/skills|valid TOML/);
		}
		expect(() =>
			renderCodexHomeConfig(
				`${GLOBAL_CONFIG}\n# [skills] is managed per runner\n`,
				TOKEN,
				{ skillDisableNames: ["superpowers:brainstorming"] },
			),
		).not.toThrow();
	});

	it("FLY-1395 rejects unsafe skill names before emitting TOML", () => {
		expect(() =>
			renderCodexHomeConfig(GLOBAL_CONFIG, TOKEN, {
				skillDisableNames: ['superpowers:bad"\nenabled = true'],
			}),
		).toThrow(/invalid Codex skill name/);
	});
});

describe("renderCodexHomeConfig — FLY-1961 workspace trust", () => {
	const trustedProjectPath = '/Users/x/Dev/flywheel-"quoted"\\repo';

	it("adds an escaped trusted project without changing existing projects", () => {
		const out = renderCodexHomeConfig(GLOBAL_CONFIG, TOKEN, {
			trustedProjectPath,
		});
		const parsed = parseToml(out) as Record<
			string,
			Record<string, Record<string, unknown>>
		>;

		expect(parsed.projects[trustedProjectPath].trust_level).toBe("trusted");
		expect(parsed.projects["/Users/x/Dev/flywheel"].trust_level).toBe(
			"trusted",
		);
		expect(parsed.shell_environment_policy.set.GH_TOKEN).toBe(TOKEN);
		expect(out).toContain("flywheel-managed workspace trust (FLY-1961)");
	});

	it("does not drop trust on the pure-passthrough path and is idempotent", () => {
		const once = renderCodexHomeConfig(GLOBAL_CONFIG, undefined, {
			trustedProjectPath: "/tmp/new-worktree",
		});
		const twice = renderCodexHomeConfig(once, undefined, {
			trustedProjectPath: "/tmp/new-worktree",
		});

		expect(
			(
				parseToml(once) as Record<
					string,
					Record<string, Record<string, unknown>>
				>
			).projects["/tmp/new-worktree"].trust_level,
		).toBe("trusted");
		expect(twice).toBe(once);
		expect(twice.match(/flywheel-managed workspace trust/g)).toHaveLength(2);
	});

	it("does not add a managed block when the exact target is already trusted", () => {
		const out = renderCodexHomeConfig(GLOBAL_CONFIG, undefined, {
			trustedProjectPath: "/Users/x/Dev/flywheel",
		});

		expect(out).toBe(`${GLOBAL_CONFIG.trimEnd()}\n`);
		expect(out).not.toContain("flywheel-managed workspace trust");
	});

	it.each([
		[
			"untrusted target",
			`[projects."/tmp/new-worktree"]\ntrust_level = "untrusted"\n`,
			/trust_level.*trusted/,
		],
		[
			"empty target",
			`[projects."/tmp/new-worktree"]\n`,
			/trust_level.*trusted/,
		],
		["non-table projects", "projects = []\n", /projects.*table/],
		[
			"non-table target",
			`projects."/tmp/new-worktree" = "bad"\n`,
			/project entry.*table/,
		],
	])("fails loudly for %s", (_name, base, message) => {
		expect(() =>
			renderCodexHomeConfig(base, undefined, {
				trustedProjectPath: "/tmp/new-worktree",
			}),
		).toThrow(message);
	});

	it.each(["relative/worktree", "/tmp/bad\0worktree"])(
		"rejects unsafe trustedProjectPath %j",
		(path) => {
			expect(() =>
				renderCodexHomeConfig(GLOBAL_CONFIG, undefined, {
					trustedProjectPath: path,
				}),
			).toThrow(/trustedProjectPath must be.*absolute.*NUL-free/);
		},
	);

	it("coexists with notify, skill disables, and credential injection", () => {
		const notifyProgramPath = join(tmp, "hooks", "runner-stop-notify.sh");
		const out = renderCodexHomeConfig(GLOBAL_CONFIG, TOKEN, {
			trustedProjectPath: "/tmp/coexist",
			notifyProgramPath,
			skillDisableNames: ["superpowers:brainstorming"],
		});
		const parsed = parseToml(out) as Record<string, any>;

		expect(parsed.projects["/tmp/coexist"].trust_level).toBe("trusted");
		expect(parsed.notify).toEqual([notifyProgramPath, "--codex"]);
		expect(parsed.shell_environment_policy.set.GH_TOKEN).toBe(TOKEN);
		expect(parsed.skills.config).toContainEqual({
			name: "superpowers:brainstorming",
			enabled: false,
		});
	});
});

describe("renderCodexHomeConfig — FLY-1571 managed notify", () => {
	const notifyProgramPath = '/Users/x/Flywheel Hooks/runner-"stop"\\notify.sh';
	const opts = { notifyProgramPath };

	it("replaces the real single-line root notify and preserves other semantics", () => {
		const base = `notify = ["/Applications/Sky.app/notify", "turn-ended"]\n${GLOBAL_CONFIG}`;
		const out = renderCodexHomeConfig(base, TOKEN, opts);
		const parsed = parseToml(out) as Record<string, unknown>;
		expect(parsed.notify).toEqual([notifyProgramPath, "--codex"]);
		expect(parsed.model).toBe("gpt-5-codex");
		expect(out).not.toContain("Sky.app");
		expect(out).toContain("flywheel-managed notify (FLY-1571)");
	});

	it("inserts notify before the first table when the base has none", () => {
		const out = renderCodexHomeConfig(GLOBAL_CONFIG, undefined, opts);
		expect((parseToml(out) as Record<string, unknown>).notify).toEqual([
			notifyProgramPath,
			"--codex",
		]);
		expect(out.indexOf("notify =")).toBeLessThan(out.indexOf("[projects."));
	});

	it("is idempotent and coexists with the managed GH_TOKEN block", () => {
		const once = renderCodexHomeConfig(GLOBAL_CONFIG, TOKEN, opts);
		const twice = renderCodexHomeConfig(once, TOKEN, opts);
		expect(twice).toBe(once);
		expect(twice.match(/flywheel-managed notify/g)).toHaveLength(2);
		expect(twice).toContain(`GH_TOKEN = "${TOKEN}"`);
	});

	it.each([
		[
			"multiline",
			`notify = [\n  "/Applications/Sky.app/notify",\n  "turn-ended",\n]\n${GLOBAL_CONFIG}`,
		],
		["two anchors", `notify = ["one"]\nnotify = ["two"]\n${GLOBAL_CONFIG}`],
		[
			"relative after table",
			`${GLOBAL_CONFIG}\n[other]\nnotify = ["relative"]\n`,
		],
		["quoted key", `"notify" = ["quoted"]\n${GLOBAL_CONFIG}`],
		["dotted key", `notify.program = "dotted"\n${GLOBAL_CONFIG}`],
	])("fails loud for an ambiguous %s shape", (_name, base) => {
		expect(() => renderCodexHomeConfig(base, TOKEN, opts)).toThrow(/notify/i);
	});

	it("sanitizes notify merge errors without quoting path or base canaries", () => {
		const canary = "FLY1571_PRIVATE_SOURCE_CANARY";
		const pathCanary = `/private/${canary}/notify`;
		let message = "";
		try {
			renderCodexHomeConfig(
				`notify = [\n"${canary}"\n]\n${GLOBAL_CONFIG}`,
				TOKEN,
				{ notifyProgramPath: pathCanary },
			);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toMatch(/notify/i);
		expect(message).not.toContain(canary);
	});
});

describe("renderCodexHomeConfig — FLY-1604 TOML-aware merge", () => {
	const MANAGED_BEGIN =
		"# >>> flywheel-managed credential (FLY-123) — do not edit >>>";
	const MANAGED_END = "# <<< flywheel-managed credential (FLY-123) <<<";
	const PLACEHOLDER = "__FLYWHEEL_GH_TOKEN_PLACEHOLDER__";
	const CODEX_KEYS = `BROWSER_USE_AVAILABLE_BACKENDS = "chrome,iab"
NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S = "41e1151f1e50f096c7561da32bb01123e74b6ecdd38f081e34da30091fc4f193,6d25aa7656feac858f3a3bdaea5bcbab0dbfd426c9de8e6931ce90c399ee8e4f"
NODE_REPL_TRUSTED_CODE_PATHS = "/Users/x/.codex"`;
	// Mirrors the real 2026-08-01 incident: codex itself wrote a
	// [shell_environment_policy.set] table into the global config.
	const SEP_CONFLICT_CONFIG = `${GLOBAL_CONFIG}
[shell_environment_policy.set]
${CODEX_KEYS}
`;

	function sepSet(out: string): Record<string, unknown> {
		const parsed = parseToml(out) as Record<
			string,
			Record<string, Record<string, unknown>>
		>;
		return parsed.shell_environment_policy.set;
	}

	it("T1 merges GH_TOKEN into the existing [shell_environment_policy.set] table (real incident shape)", () => {
		const out = renderCodexHomeConfig(SEP_CONFLICT_CONFIG, TOKEN);
		const set = sepSet(out);
		expect(Object.keys(set).sort()).toEqual([
			"BROWSER_USE_AVAILABLE_BACKENDS",
			"GH_TOKEN",
			"NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S",
			"NODE_REPL_TRUSTED_CODE_PATHS",
		]);
		expect(set.GH_TOKEN).toBe(TOKEN);
		expect(set.BROWSER_USE_AVAILABLE_BACKENDS).toBe("chrome,iab");
		// codex's own lines survive byte-for-byte
		for (const line of CODEX_KEYS.split("\n")) {
			expect(out).toContain(line);
		}
		// the sentinel-wrapped keyline sits directly after the existing header
		expect(out).toContain(
			`[shell_environment_policy.set]\n${MANAGED_BEGIN}\nGH_TOKEN = "${TOKEN}"\n${MANAGED_END}\nBROWSER_USE_AVAILABLE_BACKENDS`,
		);
		// placeholder must not leak into the final artifact (base has none)
		expect(out).not.toContain(PLACEHOLDER);
	});

	it("T2 merge path is idempotent — re-render does not stack", () => {
		const once = renderCodexHomeConfig(SEP_CONFLICT_CONFIG, TOKEN);
		const twice = renderCodexHomeConfig(once, TOKEN);
		expect(twice).toBe(once);
		expect(once.match(/GH_TOKEN/g)).toHaveLength(1);
		expect(once.match(/flywheel-managed credential/g)).toHaveLength(2);
	});

	it("T3 merge path scrub — re-render without token restores base verbatim", () => {
		const merged = renderCodexHomeConfig(SEP_CONFLICT_CONFIG, TOKEN);
		const scrubbed = renderCodexHomeConfig(merged);
		expect(scrubbed).toBe(`${SEP_CONFLICT_CONFIG.trimEnd()}\n`);
		expect(scrubbed).not.toContain("GH_TOKEN");
		expect(scrubbed).not.toContain("flywheel-managed credential");
	});

	it("T4 refuses to overwrite a pre-existing non-managed GH_TOKEN", () => {
		const base = `${GLOBAL_CONFIG}\n[shell_environment_policy.set]\nGH_TOKEN = "someone_elses_token"\n`;
		expect(() => renderCodexHomeConfig(base, TOKEN)).toThrow(
			/refusing to overwrite/,
		);
	});

	it("T6 quoted header defining the set table is unmergeable — fail loud (old code silently corrupted)", () => {
		const base = `${GLOBAL_CONFIG}\n["shell_environment_policy".set]\nFOO = "bar"\n`;
		expect(() => renderCodexHomeConfig(base, TOKEN)).toThrow(
			/shell_environment_policy/,
		);
	});

	it("T7 parent-table-only base gets the appended block (legal sub-table)", () => {
		for (const header of [
			"[shell_environment_policy]",
			"[ shell_environment_policy ]",
		]) {
			const base = `${GLOBAL_CONFIG}\n${header}\ninherit = "core"\n`;
			const out = renderCodexHomeConfig(base, TOKEN);
			const parsed = parseToml(out) as Record<string, Record<string, unknown>>;
			expect(parsed.shell_environment_policy.inherit).toBe("core");
			expect(sepSet(out).GH_TOKEN).toBe(TOKEN);
		}
	});

	it("T8 sibling sub-table shapes are mergeable — bracket and root-dotted (root-aware, R1-HIGH-2)", () => {
		// Bracket header may sit anywhere; the root-dotted sibling must sit
		// BEFORE any [table] header to actually be root-level.
		for (const base of [
			`${GLOBAL_CONFIG}\n[shell_environment_policy.exclude]\nFOO = "x"\n`,
			`shell_environment_policy.exclude.FOO = "x"\n${GLOBAL_CONFIG}`,
		]) {
			const out = renderCodexHomeConfig(base, TOKEN);
			const parsed = parseToml(out) as Record<
				string,
				Record<string, Record<string, unknown>>
			>;
			expect(parsed.shell_environment_policy.exclude.FOO).toBe("x");
			expect(sepSet(out).GH_TOKEN).toBe(TOKEN);
		}
	});

	it("T9 relative same-name key under another table is NOT the root namespace — mergeable", () => {
		const base = `${GLOBAL_CONFIG}\n[other]\nshell_environment_policy.foo = "x"\n`;
		const out = renderCodexHomeConfig(base, TOKEN);
		const parsed = parseToml(out) as Record<
			string,
			Record<string, Record<string, unknown>>
		>;
		expect(parsed.other.shell_environment_policy.foo).toBe("x");
		expect(sepSet(out).GH_TOKEN).toBe(TOKEN);
	});

	it("T10 invalid TOML base fails loud before write when injecting", () => {
		expect(() =>
			renderCodexHomeConfig("this = is [not valid\ntoml ===", TOKEN),
		).toThrow(/not valid TOML/);
	});

	it("T11 thrown errors never carry the token or base source fragments", () => {
		const canary = "ZQ9_SOURCE_CANARY_77";
		const throwers = [
			`${GLOBAL_CONFIG}\n[shell_environment_policy.set]\nGH_TOKEN = "${canary}"\n`,
			`${GLOBAL_CONFIG}\n["shell_environment_policy".set]\nFOO = "${canary}"\n`,
			`shell_environment_policy = { set = { FOO = "${canary}" } }\n${GLOBAL_CONFIG}`,
			`broken toml ${canary} ===`,
		];
		for (const base of throwers) {
			let message = "";
			try {
				renderCodexHomeConfig(base, TOKEN);
			} catch (err) {
				message = err instanceof Error ? err.message : String(err);
			}
			expect(message).not.toBe("");
			expect(message).not.toContain(TOKEN);
			expect(message).not.toContain(canary);
		}
	});

	it("T12 preservation check survives non-primitive base values (deep compare, not ===)", () => {
		const base = `${GLOBAL_CONFIG}\n[shell_environment_policy.set]\nFOO = "bar"\nEXTRA_ARR = ["a", "b"]\n`;
		const out = renderCodexHomeConfig(base, TOKEN);
		const set = sepSet(out);
		expect(set.EXTRA_ARR).toEqual(["a", "b"]);
		expect(set.GH_TOKEN).toBe(TOKEN);
		expect(out).toContain('EXTRA_ARR = ["a", "b"]');
	});

	it("T12b base bytes containing the placeholder literal survive verbatim (no global substitution, R2-HIGH-1)", () => {
		const base = `${GLOBAL_CONFIG}
# comment mentions ${PLACEHOLDER} here
[shell_environment_policy.set]
LOOKALIKE = "${PLACEHOLDER}"
${CODEX_KEYS}

[unrelated]
note = "${PLACEHOLDER}"
`;
		const out = renderCodexHomeConfig(base, TOKEN);
		// exactly the base's 3 placeholder occurrences — the managed line took
		// the real token, and no base byte was substituted
		expect(out.match(new RegExp(PLACEHOLDER, "g"))).toHaveLength(3);
		expect(out).toContain(`LOOKALIKE = "${PLACEHOLDER}"`);
		expect(out).toContain(`note = "${PLACEHOLDER}"`);
		expect(out).toContain(`# comment mentions ${PLACEHOLDER} here`);
		expect(out).toContain(`GH_TOKEN = "${TOKEN}"`);
		expect(sepSet(out).LOOKALIKE).toBe(PLACEHOLDER);
	});

	it("T13 skills: base [[skills.config]] entries extend as array-of-tables (no overlap)", () => {
		const base = `${GLOBAL_CONFIG}\n[[skills.config]]\nname = "existing:skill"\nenabled = true\n`;
		const out = renderCodexHomeConfig(base, TOKEN, {
			skillDisableNames: ["superpowers:brainstorming"],
		});
		const parsed = parseToml(out) as Record<
			string,
			Record<string, Array<Record<string, unknown>>>
		>;
		const cfg = parsed.skills.config;
		expect(cfg).toHaveLength(2);
		expect(cfg[0]).toEqual({ name: "existing:skill", enabled: true });
		expect(cfg[1]).toEqual({
			name: "superpowers:brainstorming",
			enabled: false,
		});
	});

	it("T14 skills: [skills] table, [skills.other] sub-table, and relative keys stay mergeable (root-aware)", () => {
		for (const decl of [
			"[skills]\nfoo = 1",
			'[skills.other]\nfoo = "x"',
			'[other]\nskills.foo = "x"',
		]) {
			const out = renderCodexHomeConfig(`${GLOBAL_CONFIG}\n${decl}\n`, TOKEN, {
				skillDisableNames: ["superpowers:brainstorming"],
			});
			const parsed = parseToml(out) as Record<
				string,
				Record<string, Array<Record<string, unknown>>>
			>;
			expect(parsed.skills.config).toHaveLength(1);
		}
	});

	it("T16 an empty-string token fails the boundary check — with and without skills (Codex code R1 MED-1)", () => {
		// "" is present-but-invalid: truthiness must not silently drop it (no
		// skills) or half-render an empty credential block (with skills).
		expect(() => renderCodexHomeConfig(GLOBAL_CONFIG, "")).toThrow(
			/ghToken must match/,
		);
		let message = "";
		try {
			renderCodexHomeConfig(GLOBAL_CONFIG, "", {
				skillDisableNames: ["superpowers:brainstorming"],
			});
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}
		expect(message).toMatch(/ghToken must match/);
		expect(message).not.toContain('GH_TOKEN = ""');
	});

	it("T17 rendered-candidate parse failure uses the sanitized classification message (Codex code R1 LOW-2)", () => {
		// Inline parent WITHOUT a set sub-table passes every precheck (sep is a
		// plain table, set undefined → append path) but the appended
		// [shell_environment_policy.set] header cannot extend an immutable
		// inline table — the failure surfaces ONLY at the rendered-stage parse.
		const canary = "ZQ9_RENDERED_CANARY_31";
		const base = `shell_environment_policy = { exclude = { SECRET = "${canary}" } }\n${GLOBAL_CONFIG}`;
		let message = "";
		try {
			renderCodexHomeConfig(base, TOKEN);
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}
		// EXACT equality (Codex code R2 LOW-1): a prefix `toContain` stays green
		// when raw parser text is appended after the fixed message — the
		// sanitization contract is "this fixed string and nothing else".
		expect(message).toBe(
			"renderCodexHomeConfig: rendered config.toml would not be valid TOML — the base declares a shape this writer cannot legally extend (e.g. an inline table); refusing to write a corrupt config (parser detail withheld: it may quote config or credential content).",
		);
		expect(message).not.toContain(TOKEN);
		expect(message).not.toContain(canary);
	});

	it("T15 skills: name overlap with base entries fails loud regardless of enabled value", () => {
		for (const enabled of ["true", "false"]) {
			const base = `${GLOBAL_CONFIG}\n[[skills.config]]\nname = "superpowers:brainstorming"\nenabled = ${enabled}\n`;
			expect(() =>
				renderCodexHomeConfig(base, TOKEN, {
					skillDisableNames: ["superpowers:brainstorming"],
				}),
			).toThrow(/duplicate-name|ambiguous/);
		}
	});
});

describe("pinRunnerNotice (FLY-2296)", () => {
	it("pins the rate-limit model nudge off in an empty runner seed", () => {
		const parsed = parseToml(pinRunnerNotice("")) as Record<
			string,
			Record<string, unknown>
		>;

		expect(parsed.notice.hide_rate_limit_model_nudge).toBe(true);
	});

	it("adds the pin to an existing notice table without duplicating it", () => {
		const out = pinRunnerNotice("[notice]\nhide_full_access_warning = true\n");
		const parsed = parseToml(out) as Record<string, Record<string, unknown>>;

		expect(parsed.notice).toEqual({
			hide_full_access_warning: true,
			hide_rate_limit_model_nudge: true,
		});
		expect(out.match(/^\[notice\]$/gm)).toHaveLength(1);
	});

	it("overrides an explicit false nudge setting without duplicating the key", () => {
		const out = pinRunnerNotice(
			"[notice]\nhide_rate_limit_model_nudge = false\n",
		);
		const parsed = parseToml(out) as Record<string, Record<string, unknown>>;

		expect(parsed.notice.hide_rate_limit_model_nudge).toBe(true);
		expect(out.match(/^hide_rate_limit_model_nudge\s*=/gm)).toHaveLength(1);
	});

	it("rejects an inline root notice table without echoing config contents", () => {
		const base =
			'notice = { hide_full_access_warning = true, canary = "private-value" }';

		expect(() => pinRunnerNotice(base)).toThrow(
			/seed config \(~\/\.codex\/config\.toml\).*literal \[notice\] table header/,
		);
		try {
			pinRunnerNotice(base);
		} catch (error) {
			expect(String(error)).not.toContain("private-value");
		}
	});

	it("rejects a quoted root notice scalar", () => {
		expect(() => pinRunnerNotice('"notice" = 1\n')).toThrow(
			/notice.*refusing to pin/,
		);
	});

	it("fails closed when an existing pin uses a quoted key", () => {
		expect(() =>
			pinRunnerNotice('[notice]\n"hide_rate_limit_model_nudge" = false\n'),
		).toThrow(/rendered config\.toml would not be valid TOML/);
	});

	it("preserves a notice model-migrations subtable while adding the parent pin", () => {
		const parsed = parseToml(
			pinRunnerNotice('[notice.model_migrations]\n"a" = "b"\n'),
		) as Record<string, Record<string, unknown>>;

		expect(parsed.notice.hide_rate_limit_model_nudge).toBe(true);
		expect(parsed.notice.model_migrations).toEqual({ a: "b" });
	});

	it("keeps an already-true pin as one equivalent assignment", () => {
		const base = "[notice]\nhide_rate_limit_model_nudge = true\n";
		const out = pinRunnerNotice(base);

		expect(parseToml(out)).toEqual(parseToml(base));
		expect(out.match(/^hide_rate_limit_model_nudge\s*=/gm)).toHaveLength(1);
	});

	it("limits assignment matching to the literal notice table span", () => {
		const base = `[notice]
[projects."/x"]
trust_level = "trusted"
[notice.model_migrations]
"a" = "b"
`;
		const parsed = parseToml(pinRunnerNotice(base)) as Record<
			string,
			Record<string, unknown>
		>;

		expect(parsed.notice.hide_rate_limit_model_nudge).toBe(true);
		expect(parsed.notice.model_migrations).toEqual({ a: "b" });
		expect(parsed.projects).toEqual({ "/x": { trust_level: "trusted" } });
	});

	it("rejects a root dotted notice definition", () => {
		expect(() =>
			pinRunnerNotice("notice.hide_rate_limit_model_nudge = false\n"),
		).toThrow(/literal \[notice\] table header before dispatching/);
	});

	it("does not confuse a relative notice key under another table with root notice", () => {
		const parsed = parseToml(
			pinRunnerNotice('[other]\nnotice.foo = "x"\n'),
		) as Record<string, Record<string, unknown>>;

		expect(parsed.other).toEqual({ notice: { foo: "x" } });
		expect(parsed.notice.hide_rate_limit_model_nudge).toBe(true);
	});
});

describe("provisionCodexHome (WS-A)", () => {
	function makeMattSkillsSource(): string {
		const source = join(tmp, "matt-skills-source");
		for (const name of [
			"code-review",
			"diagnosing-bugs",
			"grilling",
			"tdd",
			"to-spec",
			"to-tickets",
		]) {
			const dir = join(source, name);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\n---\n`);
		}
		return source;
	}

	it("identifies the live source credential before provisioning", () => {
		expect(assertCodexSourceIdentity({ env, registryPath })).toEqual({
			profile: "personal",
			email: "personal@example.test",
			accountId: "acct-personal",
			plan: "pro",
			mode: "primary",
		});
	});

	it("links a new runner home to the canonical credential truth without changing it", () => {
		const truthPath = codexCredentialTruthPath(env);
		chmodSync(truthPath, 0o600);
		const truthBefore = statSync(truthPath);
		const truthBytes = readFileSync(truthPath);

		const home = provisionCodexHome({ executionId: "exec-linked-truth", env });
		const linkedAuth = join(home, "auth.json");

		expect(lstatSync(linkedAuth).isSymbolicLink()).toBe(true);
		expect(readlinkSync(linkedAuth)).toBe(truthPath);
		expect(readFileSync(linkedAuth)).toEqual(truthBytes);
		const truthAfter = statSync(truthPath);
		expect(truthAfter.ino).toBe(truthBefore.ino);
		expect(truthAfter.mode & 0o777).toBe(0o600);
	});

	it("scrubs a retained managed credential when fresh-home link installation fails", () => {
		const executionId = "exec-link-install-failure";
		const home = codexHomeDir(executionId, env);
		mkdirSync(home, { recursive: true, mode: 0o700 });
		writeFileSync(join(home, "config.toml"), renderCodexHomeConfig("", TOKEN), {
			mode: 0o600,
		});
		const beforeSymlink = vi.fn(() => {
			throw new Error("injected fresh-home link failure");
		});

		expect(() =>
			provisionCodexHome({
				executionId,
				env,
				testing: { beforeSymlink },
			}),
		).toThrow(/injected fresh-home link failure/);
		expect(beforeSymlink).toHaveBeenCalledOnce();
		expect(readFileSync(join(home, "config.toml"), "utf8")).not.toContain(
			TOKEN,
		);
		expect(existsSync(join(home, "auth.json"))).toBe(false);
		expect(
			readdirSync(home).filter((name) => name.startsWith("auth.json.link.")),
		).toEqual([]);
	});

	it("keeps an existing correct credential link without rewriting the truth", () => {
		const truthPath = codexCredentialTruthPath(env);
		const home = provisionCodexHome({
			executionId: "exec-link-idempotent",
			env,
		});
		const linkedAuth = join(home, "auth.json");
		const fixedTime = new Date("2020-01-02T03:04:05.000Z");
		utimesSync(truthPath, fixedTime, fixedTime);
		const truthBefore = statSync(truthPath);

		provisionCodexHome({ executionId: "exec-link-idempotent", env });

		expect(lstatSync(linkedAuth).isSymbolicLink()).toBe(true);
		expect(readlinkSync(linkedAuth)).toBe(truthPath);
		const truthAfter = statSync(truthPath);
		expect(truthAfter.ino).toBe(truthBefore.ino);
		expect(truthAfter.mtimeMs).toBe(truthBefore.mtimeMs);
	});

	it.each([
		["wrong", true],
		["dangling", false],
	] as const)(
		"rejects an existing %s credential link without writing through it",
		(_label, createTarget) => {
			const executionId = `exec-${_label}-credential-link`;
			const home = codexHomeDir(executionId, env);
			const destination = join(home, "auth.json");
			const wrongTarget = join(tmp, `${_label}-auth-target.json`);
			mkdirSync(home, { recursive: true });
			if (createTarget) writeFileSync(wrongTarget, "wrong-target-canary");
			symlinkSync(wrongTarget, destination);
			writeFileSync(join(home, "config.toml"), "config-canary");
			const truthBefore = readFileSync(codexCredentialTruthPath(env));

			expect(() => provisionCodexHome({ executionId, env })).toThrow(
				/credential_link_drift/,
			);
			expect(readlinkSync(destination)).toBe(wrongTarget);
			expect(existsSync(wrongTarget)).toBe(createTarget);
			if (createTarget) {
				expect(readFileSync(wrongTarget, "utf8")).toBe("wrong-target-canary");
			}
			expect(readFileSync(join(home, "config.toml"), "utf8")).toBe(
				"config-canary\n",
			);
			expect(readFileSync(codexCredentialTruthPath(env))).toEqual(truthBefore);
		},
	);

	it("keeps an existing legacy credential copy ordinary and marks it pending migration", () => {
		const executionId = "exec-existing-credential-copy";
		const home = codexHomeDir(executionId, env);
		const destination = join(home, "auth.json");
		mkdirSync(home, { recursive: true });
		writeFileSync(destination, "old-copy");
		const truthPath = codexCredentialTruthPath(env);
		const truthBefore = readFileSync(truthPath);

		provisionCodexHome({ executionId, env });

		expect(lstatSync(destination).isFile()).toBe(true);
		expect(lstatSync(destination).isSymbolicLink()).toBe(false);
		expect(readFileSync(destination)).toEqual(truthBefore);
		expect(existsSync(join(home, ".credential-copy-pending"))).toBe(true);
		expect(readFileSync(truthPath)).toEqual(truthBefore);
	});

	it("rejects a symlinked legacy home without writing through it", () => {
		const executionId = "exec-symlinked-home";
		const home = codexHomeDir(executionId, env);
		const foreignDirectory = join(tmp, "foreign-home-target");
		mkdirSync(dirname(home), { recursive: true });
		mkdirSync(foreignDirectory);
		symlinkSync(foreignDirectory, home);

		expect(() => provisionCodexHome({ executionId, env })).toThrow(
			/unsafe codex home path/,
		);
		expect(readdirSync(foreignDirectory)).toEqual([]);
	});

	it("rejects a runner home inside the canonical credential source without creating it", () => {
		const sourceHome = sourceCodexDir(env);
		const nestedHomesRoot = join(sourceHome, "managed-homes");
		const unsafeEnv = {
			...env,
			FLYWHEEL_CODEX_HOMES_ROOT: nestedHomesRoot,
		};

		expect(() =>
			provisionCodexHome({ executionId: "exec-inside-source", env: unsafeEnv }),
		).toThrow(/credential source directory/);
		expect(existsSync(nestedHomesRoot)).toBe(false);
	});

	it("rejects a credential truth that is not mode 0600 before creating a home", () => {
		const truthPath = codexCredentialTruthPath(env);
		chmodSync(truthPath, 0o644);

		expect(() =>
			provisionCodexHome({ executionId: "exec-wide-truth", env }),
		).toThrow(/credential truth must be a 0600 regular file/);
		expect(existsSync(codexHomeDir("exec-wide-truth", env))).toBe(false);
	});

	it("FLY-2168 pins a requirements-compatible runner policy", () => {
		writeFileSync(
			join(sourceCodexDir(env), "config.toml"),
			`sandbox_mode = "danger-full-access"
approval_policy = "never"
model = "gpt-5-codex"

[projects."/Users/x/Dev/flywheel"]
trust_level = "trusted"

[notice.model_migrations]
"gpt-5-codex" = "gpt-5.6-codex"
`,
		);

		const home = provisionCodexHome({
			executionId: "exec-managed-requirements",
			env,
		});
		const parsed = parseToml(
			readFileSync(join(home, "config.toml"), "utf8"),
		) as Record<string, unknown>;

		expect(parsed.sandbox_mode).toBe("workspace-write");
		expect(parsed.approval_policy).toBe("never");
		expect(parsed.model).toBe("gpt-5-codex");
		expect(
			(parsed.notice as Record<string, unknown>).hide_rate_limit_model_nudge,
		).toBe(true);
		expect(
			(parsed.notice as Record<string, Record<string, unknown>>)
				.model_migrations,
		).toEqual({ "gpt-5-codex": "gpt-5.6-codex" });
	});

	it("scrubs a prior live token and does not rewrite identity files when the notice pin rejects", () => {
		const sourceConfig = join(sourceCodexDir(env), "config.toml");
		const executionId = "exec-notice-pin-reject";
		const home = provisionCodexHome({ executionId, ghToken: TOKEN, env });
		const authPath = join(home, "auth.json");
		const activePath = join(home, ".active");
		const fixedTime = new Date("2020-01-02T03:04:05.000Z");
		utimesSync(authPath, fixedTime, fixedTime);
		utimesSync(activePath, fixedTime, fixedTime);
		const authBefore = readFileSync(authPath);
		const activeBefore = readFileSync(activePath);
		const authMtimeBefore = statSync(authPath).mtimeMs;
		const activeMtimeBefore = statSync(activePath).mtimeMs;

		writeFileSync(
			sourceConfig,
			"notice = { hide_rate_limit_model_nudge = false }\n",
		);

		expect(() =>
			provisionCodexHome({ executionId, ghToken: TOKEN, env }),
		).toThrow(/literal \[notice\] table header before dispatching/);
		expect(readFileSync(join(home, "config.toml"), "utf8")).not.toContain(
			"GH_TOKEN",
		);
		expect(readFileSync(authPath)).toEqual(authBefore);
		expect(readFileSync(activePath)).toEqual(activeBefore);
		expect(statSync(authPath).mtimeMs).toBe(authMtimeBefore);
		expect(statSync(activePath).mtimeMs).toBe(activeMtimeBefore);
	});

	it("coexists with existing shell-environment and notice tables", () => {
		writeFileSync(
			join(sourceCodexDir(env), "config.toml"),
			`sandbox_mode = "workspace-write"
approval_policy = "never"

[shell_environment_policy.set]
EXISTING = "kept"

[notice]
hide_full_access_warning = true
`,
		);

		const home = provisionCodexHome({
			executionId: "exec-notice-shell-env",
			ghToken: TOKEN,
			env,
		});
		const parsed = parseToml(
			readFileSync(join(home, "config.toml"), "utf8"),
		) as Record<string, Record<string, unknown>>;

		expect(parsed.shell_environment_policy.set).toEqual({
			EXISTING: "kept",
			GH_TOKEN: TOKEN,
		});
		expect(parsed.notice).toEqual({
			hide_full_access_warning: true,
			hide_rate_limit_model_nudge: true,
		});
	});

	it.each([
		["personal", "personal@example.test", "acct-personal", "primary"],
		["school", "school@example.test", "acct-school", "manual_backup"],
		["business", "business@example.test", "acct-business", "manual_backup"],
	] as const)(
		"provisions canonical %s, writes the truthful sidecar and ledger",
		(profile, email, accountId, mode) => {
			writeFileSync(
				join(sourceCodexDir(env), "auth.json"),
				testAuth(email, accountId),
			);

			const home = provisionCodexHome({ executionId: `exec-${profile}`, env });

			expect(readFileSync(join(home, "auth.json"), "utf8")).toBe(
				testAuth(email, accountId),
			);
			expect(readFileSync(join(home, ".active"), "utf8")).toBe(`${profile}\n`);
			expect(
				JSON.parse(readFileSync(join(ledgerRoot, `${profile}.json`), "utf8")),
			).toMatchObject({ profile, mode, lastSource: "provision" });
		},
	);

	it("keeps a fully provisioned runner home when only the ledger is unavailable", () => {
		writeFileSync(ledgerRoot, "ledger-root-is-not-a-directory");
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

		try {
			const home = provisionCodexHome({
				executionId: "exec-ledger-unavailable",
				ghToken: TOKEN,
				env,
			});

			expect(readFileSync(join(home, "auth.json"), "utf8")).toBe(testAuth());
			expect(readFileSync(join(home, ".active"), "utf8")).toBe("personal\n");
			expect(readFileSync(join(home, "config.toml"), "utf8")).toContain(TOKEN);
			expect(warning).toHaveBeenCalledWith(
				expect.stringContaining(
					"account ledger observation failed for personal; runner provisioning will continue",
				),
			);
		} finally {
			warning.mockRestore();
		}
	});

	it.each([
		["unknown", testAuth("zombie@example.test", "acct-zombie")],
		["malformed", '{"tokens":{"id_token":"not-a-jwt"}}'],
	] as const)(
		"rejects a %s source identity before changing a pre-existing execution home",
		(_label, sourceAuth) => {
			const home = codexHomeDir("exec-reject", env);
			mkdirSync(home, { recursive: true });
			writeFileSync(join(home, "auth.json"), "auth-canary");
			writeFileSync(join(home, "config.toml"), "config-canary");
			writeFileSync(join(sourceCodexDir(env), "auth.json"), sourceAuth);

			expect(() =>
				provisionCodexHome({
					executionId: "exec-reject",
					ghToken: TOKEN,
					env,
				}),
			).toThrow(/Codex|identity|JWT/);
			expect(readFileSync(join(home, "auth.json"), "utf8")).toBe("auth-canary");
			expect(readFileSync(join(home, "config.toml"), "utf8")).toBe(
				"config-canary",
			);
			expect(existsSync(ledgerRoot)).toBe(false);
		},
	);

	it("rejects a symlinked source auth before creating an execution home", () => {
		const srcAuth = join(sourceCodexDir(env), "auth.json");
		const realAuth = join(tmp, "real-auth.json");
		writeFileSync(realAuth, testAuth());
		rmSync(srcAuth);
		symlinkSync(realAuth, srcAuth);

		expect(() =>
			provisionCodexHome({ executionId: "exec-symlink", env }),
		).toThrow(/symlink/);
		expect(existsSync(codexHomeDir("exec-symlink", env))).toBe(false);
	});

	it("FLY-1571 provisions the managed Runner stop notify program", () => {
		const notifyProgramPath = join(tmp, "hooks", "runner-stop-notify.sh");
		const home = provisionCodexHome({
			executionId: "exec-notify",
			env,
			notifyProgramPath,
		});
		const parsed = parseToml(
			readFileSync(join(home, "config.toml"), "utf8"),
		) as Record<string, unknown>;
		expect(parsed.notify).toEqual([notifyProgramPath, "--codex"]);
	});

	it("FLY-1961 provisions trust into the execution-scoped CODEX_HOME", () => {
		const trustedProjectPath = join(tmp, "new-worktree");
		const home = provisionCodexHome({
			executionId: "exec-trust",
			env,
			trustedProjectPath,
		});
		const parsed = parseToml(
			readFileSync(join(home, "config.toml"), "utf8"),
		) as Record<string, Record<string, Record<string, unknown>>>;

		expect(parsed.projects[trustedProjectPath].trust_level).toBe("trusted");
		expect(home).toBe(join(tmp, "homes", "exec-trust"));
	});

	it("creates the home, seeds auth.json (0600) and config.toml (0600) with the token", () => {
		const home = provisionCodexHome({
			executionId: "exec-1",
			ghToken: TOKEN,
			env,
		});
		expect(home).toBe(join(tmp, "homes", "exec-1"));

		const authMode = statSync(join(home, "auth.json")).mode & 0o777;
		expect(authMode).toBe(0o600);
		const cfgMode = statSync(join(home, "config.toml")).mode & 0o777;
		expect(cfgMode).toBe(0o600);

		const cfg = readFileSync(join(home, "config.toml"), "utf-8");
		expect(cfg).toContain(`GH_TOKEN = "${TOKEN}"`);
		expect(cfg).toContain('model = "gpt-5-codex"');
		// auth seeded verbatim from source
		expect(readFileSync(join(home, "auth.json"), "utf-8")).toContain(
			'"tokens"',
		);
	});

	it("is idempotent — re-provisioning overwrites in place", () => {
		const home = provisionCodexHome({
			executionId: "exec-2",
			ghToken: TOKEN,
			env,
		});
		const first = readFileSync(join(home, "config.toml"), "utf-8");
		provisionCodexHome({ executionId: "exec-2", ghToken: TOKEN, env });
		const second = readFileSync(
			join(tmp, "homes", "exec-2", "config.toml"),
			"utf-8",
		);
		expect(second).toBe(first);
		expect(second.match(/shell_environment_policy/g)?.length).toBe(1);
		expect(second.match(/^\[notice\]$/gm)).toHaveLength(1);
	});

	it("provisions without a token (no credential block)", () => {
		const home = provisionCodexHome({ executionId: "exec-3", env });
		const cfg = readFileSync(join(home, "config.toml"), "utf-8");
		expect(cfg).not.toContain("GH_TOKEN");
	});

	it("FLY-1395 bare provisions the disable config without a skills directory", () => {
		const home = provisionCodexHome({
			executionId: "exec-bare",
			env,
			skillFrameworkMode: "bare",
			codexSkillDisableNames: ["superpowers:brainstorming"],
		});
		const config = readFileSync(join(home, "config.toml"), "utf-8");
		expect(config).toContain('name = "superpowers:brainstorming"');
		expect(existsSync(join(home, "skills", "matt-skills"))).toBe(false);
	});

	it("FLY-1395 matt installs all six vendored skills with stable namespace names and is idempotent", () => {
		const source = makeMattSkillsSource();
		const opts = {
			executionId: "exec-matt",
			env,
			skillFrameworkMode: "matt" as const,
			codexSkillDisableNames: ["superpowers:brainstorming"],
			codexMattSkillsSourceDir: source,
		};
		const home = provisionCodexHome(opts);
		provisionCodexHome(opts);
		for (const name of [
			"code-review",
			"diagnosing-bugs",
			"grilling",
			"tdd",
			"to-spec",
			"to-tickets",
		]) {
			const skillFile = join(home, "skills", `matt-skills:${name}`, "SKILL.md");
			expect(existsSync(skillFile)).toBe(true);
			expect(readFileSync(skillFile, "utf-8")).toContain(
				`name: matt-skills:${name}`,
			);
		}
		expect(existsSync(join(home, "skills", "matt-skills"))).toBe(false);
		expect(readFileSync(join(home, "config.toml"), "utf-8")).toContain(
			'name = "superpowers:brainstorming"',
		);
	});

	it("FLY-1395 removes stale managed Matt skills when reprovisioned as bare", () => {
		const source = makeMattSkillsSource();
		const mattHome = provisionCodexHome({
			executionId: "exec-rearm",
			env,
			skillFrameworkMode: "matt",
			codexSkillDisableNames: ["superpowers:brainstorming"],
			codexMattSkillsSourceDir: source,
		});
		expect(
			existsSync(join(mattHome, "skills", "matt-skills:tdd", "SKILL.md")),
		).toBe(true);
		const home = provisionCodexHome({
			executionId: "exec-rearm",
			env,
			skillFrameworkMode: "bare",
			codexSkillDisableNames: ["superpowers:brainstorming"],
		});
		expect(existsSync(join(home, "skills", "matt-skills:tdd"))).toBe(false);
	});

	it("FLY-1395 matt source failure is loud and leaves no runner home", () => {
		expect(() =>
			provisionCodexHome({
				executionId: "exec-matt-bad",
				env,
				skillFrameworkMode: "matt",
				codexSkillDisableNames: ["superpowers:brainstorming"],
				codexMattSkillsSourceDir: join(tmp, "missing-matt"),
			}),
		).toThrow(/matt skills source/);
		expect(existsSync(join(tmp, "homes", "exec-matt-bad"))).toBe(false);
	});

	it("FLY-1395 scrubs the live token when Matt skill copying fails", () => {
		const source = makeMattSkillsSource();
		const home = codexHomeDir("exec-matt-copy-fails", env);
		const skillsRoot = join(home, "skills");
		mkdirSync(skillsRoot, { recursive: true });
		chmodSync(skillsRoot, 0o500);
		try {
			expect(() =>
				provisionCodexHome({
					executionId: "exec-matt-copy-fails",
					ghToken: TOKEN,
					env,
					skillFrameworkMode: "matt",
					codexSkillDisableNames: ["superpowers:brainstorming"],
					codexMattSkillsSourceDir: source,
				}),
			).toThrow();
			const configPath = join(home, "config.toml");
			const config = existsSync(configPath)
				? readFileSync(configPath, "utf-8")
				: "";
			expect(config).not.toContain(TOKEN);
			expect(config).not.toContain("GH_TOKEN");
		} finally {
			chmodSync(skillsRoot, 0o700);
		}
	});

	// FLY-1395 QA: every existing matt test uses a SYNTHETIC fixture whose
	// frontmatter name is written to equal its directory (so namespaceMattSkill's
	// `sourceName === skillDir` invariant is trivially satisfied). None exercises
	// the REAL vendored artifact. If an upstream matt-skills sync renames a
	// SKILL.md `name:` field, or drops/renames a skill directory, the matt arm
	// would throw at provision time in production while every fixture test stays
	// green. This guard drives production provisionCodexHome against the actual
	// git-tracked vendor/matt-skills/skills so that drift fails in CI, not on a
	// real Codex implement runner.
	it("FLY-1395 provisions the matt arm from the REAL vendored skills (drift guard)", () => {
		const repoRoot = resolve(
			dirname(fileURLToPath(import.meta.url)),
			"..",
			"..",
			"..",
		);
		const vendorSkills = join(repoRoot, "vendor", "matt-skills", "skills");
		// Fail loud, not vacuously skip, if the vendored artifact is missing —
		// its absence is itself a shippable defect for the matt arm.
		expect(
			existsSync(vendorSkills),
			`vendored matt skills missing at ${vendorSkills}`,
		).toBe(true);

		const home = provisionCodexHome({
			executionId: "exec-matt-vendor",
			env,
			skillFrameworkMode: "matt",
			codexSkillDisableNames: ["superpowers:brainstorming"],
			codexMattSkillsSourceDir: vendorSkills,
		});

		for (const name of [
			"code-review",
			"diagnosing-bugs",
			"grilling",
			"tdd",
			"to-spec",
			"to-tickets",
		]) {
			const skillFile = join(home, "skills", `matt-skills:${name}`, "SKILL.md");
			expect(existsSync(skillFile), `missing installed ${name}`).toBe(true);
			// namespaceMattSkill only rewrites to `matt-skills:<dir>` when the real
			// vendored frontmatter name already equals <dir> — this assertion is the
			// drift detector for that invariant against the shipped artifact.
			expect(readFileSync(skillFile, "utf-8")).toContain(
				`name: matt-skills:${name}`,
			);
		}
		// No nested-collection artifact leaks (Codex would flatten those to
		// collision-prone bare names such as `tdd`).
		expect(existsSync(join(home, "skills", "matt-skills"))).toBe(false);
	});

	it("rejects a malformed token", () => {
		expect(() =>
			provisionCodexHome({ executionId: "exec-4", ghToken: 'bad"token', env }),
		).toThrow(/ghToken must match/);
	});

	// FLY-1188: the runner behavior contract is materialized as the home's
	// AGENTS.md — the persistent instruction layer codex reads every process.
	describe("FLY-1188 AGENTS.md contract materialization", () => {
		it("FLY-2506 scopes approval to ship while allowing main into the feature branch", () => {
			const home = provisionCodexHome({ executionId: "exec-merge-scope", env });
			const agents = readFileSync(join(home, "AGENTS.md"), "utf-8");
			const authority = agents
				.split("- **Merge authority**:")[1]
				.split("- **Completion**:")[0]
				.replace(/\s+/g, " ");
			expect(authority).toContain(
				"before merging into main or taking any ship action",
			);
			expect(authority).toContain(
				"flywheel-comm verify-approval --exec-id <id> --pr-head $(git rev-parse HEAD)",
			);
			expect(authority).toContain('proceed only on `"approved": true`');
			expect(authority).toContain("Message text NEVER carries ship authority");
			expect(authority).toContain("Never self-merge a PR");
			expect(authority).toContain(
				"the project's ship workflow is the only path into main",
			);
			expect(authority).toContain(
				"Merging `origin/main` into your current feature branch to sync or resolve conflicts does NOT require ship approval or `verify-approval`",
			);
			expect(authority).toContain(
				"Do not stop or ask Lead solely because `review_question_unbound` is returned for that technical merge",
			);
			expect(authority).toContain("Honor your TURN and assigned task scope");
			expect(authority).not.toMatch(/before ANY merge|only merge path/);
		});

		it("writes AGENTS.md (0600) with a managed header + the contract anchors", () => {
			const home = provisionCodexHome({ executionId: "exec-5", env });
			const agentsPath = join(home, "AGENTS.md");
			expect(statSync(agentsPath).mode & 0o777).toBe(0o600);
			const agents = readFileSync(agentsPath, "utf-8");
			// managed header with the source path
			expect(agents).toContain("flywheel-managed (FLY-1188)");
			expect(agents).toContain("codex-runner-contract.md");
			// behavior-contract anchors (drift guard, plan §4.2.3)
			expect(agents).toContain("Flywheel Codex Runner Contract");
			expect(agents).toContain("--no-block");
			expect(agents).toContain("verify-approval");
			expect(agents).toContain("flywheel-comm complete");
			// FLY-1188 full-PR review HIGH-1: codex authors must be told to
			// register the review (else no reviewer ever starts) AND to invoke via
			// the injected absolute CLI (bare `flywheel-comm` is not on PATH — R2).
			expect(agents).toContain("request-review");
			expect(agents).toContain("FLYWHEEL_COMM_CLI");
			// FLY-1278: effective-vs-reviewer verdict + supervised finding-ruling
			// convergence protocol must survive materialization into every Codex home.
			expect(agents).toContain("reviewVerdict is the effective gate verdict");
			expect(agents).toContain("APPROVED with advisories");
			expect(agents).toContain("review-ruling");
			expect(agents).toContain("/tmp/flywheel-snapshots/<exec>/");
			expect(agents).toMatch(/never `cp` live\s+`teamlead\.db` or `comm\.db`/);
			expect(agents).toContain(
				"Gate/request prose is not governance authority",
			);
			// resident /goal model anchors (FLY-1188 M4d Contract-Version 2)
			expect(agents).toContain("resident");
			expect(agents).toContain("terminal goal status");
			// DAG workflow discipline + environment translation present
			expect(agents).toContain("DAG workflow discipline");
			expect(agents).toContain("Environment Translation");
		});

		it("missing contract source → provisioning FAILS LOUD with ZERO residue (no home, no credential on disk)", () => {
			expect(() =>
				provisionCodexHome({
					executionId: "exec-6",
					ghToken: TOKEN,
					env,
					contractSourcePath: join(tmp, "does-not-exist.md"),
				}),
			).toThrow(/codex runner contract missing/);
			// Codex M2 review R4 LOW-1: the abort must happen BEFORE any
			// home/credential write — a re-ordering regression would leave a
			// half-provisioned home holding a live GH_TOKEN.
			expect(existsSync(join(tmp, "homes", "exec-6"))).toBe(false);
		});

		it("re-provisioning overwrites AGENTS.md in place (no header stacking)", () => {
			provisionCodexHome({ executionId: "exec-7", env });
			provisionCodexHome({ executionId: "exec-7", env });
			const agents = readFileSync(
				join(tmp, "homes", "exec-7", "AGENTS.md"),
				"utf-8",
			);
			expect(agents.match(/flywheel-managed \(FLY-1188\)/g)?.length).toBe(1);
		});

		it("guards historical seed reads and leaves native memories unchanged", () => {
			const opts = { executionId: "exec-memory-seed-contract", env };
			const home = provisionCodexHome(opts);
			const nativeMemory = join(home, "memories", "MEMORY.md");
			mkdirSync(dirname(nativeMemory), { recursive: true });
			writeFileSync(nativeMemory, "native memory stays authoritative\n");
			const before = createHash("sha256")
				.update(readFileSync(nativeMemory))
				.digest("hex");

			provisionCodexHome(opts);

			const agents = readFileSync(join(home, "AGENTS.md"), "utf8");
			expect(agents).toContain(
				"Only when `$CODEX_HOME/.flywheel-memory-seed/index.md` exists",
			);
			expect(agents).toContain("do not read the archive at all");
			expect(agents).toMatch(/Search `catalog\.md`\s+by issue or topic/);
			expect(agents).toMatch(
				/Current task and\s+repository evidence always win/,
			);
			expect(
				createHash("sha256").update(readFileSync(nativeMemory)).digest("hex"),
			).toBe(before);
		});
	});
});

describe("Codex credential migration (WS-A)", () => {
	it("atomically replaces an idle ordinary credential copy with the canonical link", async () => {
		const home = join(tmp, "idle-legacy-home");
		mkdirSync(home, { mode: 0o700 });
		writeFileSync(join(home, "auth.json"), testAuth("old@example.test"), {
			mode: 0o600,
		});
		writeFileSync(join(home, ".credential-copy-pending"), "pending\n", {
			mode: 0o600,
		});

		const result = await migrateCodexHomeCredential({
			home,
			env,
			registryPath,
		});

		expect(result.state).toBe("linked");
		expect(lstatSync(join(home, "auth.json")).isSymbolicLink()).toBe(true);
		expect(readlinkSync(join(home, "auth.json"))).toBe(
			codexCredentialTruthPath(env),
		);
		expect(existsSync(join(home, ".credential-copy-pending"))).toBe(false);
		expect(
			readdirSync(home).filter((name) => name.startsWith("auth.json.link.")),
		).toEqual([]);
	});

	it("migrates a drained keyed home while holding its admission lock", async () => {
		const admission = await admitCodexAgentHome(
			{
				project: "flywheel",
				role: "implement",
				executionId: "exec-drained-migration",
				requestedAssemblyArm: "bare",
			},
			env,
		);
		await releaseCodexAgentHomeLease(admission.handle, env);
		writeFileSync(join(admission.handle.home, "auth.json"), "legacy-copy", {
			mode: 0o600,
		});

		const result = await migrateCodexAgentHomeCredential({
			home: admission.handle.home,
			env,
			registryPath,
		});

		expect(result.state).toBe("linked");
		expect(readlinkSync(join(admission.handle.home, "auth.json"))).toBe(
			codexCredentialTruthPath(env),
		);
	});

	it("durably backs up an ordinary credential before replacing it when requested", () => {
		const home = join(tmp, "backup-source-home");
		const original = testAuth("old@example.test", "acct-old");
		mkdirSync(home, { mode: 0o700 });
		writeFileSync(join(home, "auth.json"), original, { mode: 0o600 });

		const result = migrateCodexHomeCredential({
			home,
			env,
			registryPath,
			keepBackup: true,
		});

		expect(result.backupPath).toBeDefined();
		expect(readFileSync(result.backupPath!, "utf8")).toBe(original);
		expect(statSync(dirname(result.backupPath!)).mode & 0o777).toBe(0o700);
		expect(statSync(result.backupPath!).mode & 0o777).toBe(0o600);
		expect(lstatSync(join(home, "auth.json")).isSymbolicLink()).toBe(true);
	});

	it("returns uncertain when the home directory cannot be fsynced after link installation", () => {
		const home = join(tmp, "uncertain-home");
		mkdirSync(home, { mode: 0o700 });
		writeFileSync(join(home, "auth.json"), "legacy-copy", { mode: 0o600 });

		const result = migrateCodexHomeCredential({
			home,
			env,
			registryPath,
			testing: {
				fsyncDirectory(path) {
					if (path === home) throw new Error("injected home fsync failure");
				},
			},
		});

		expect(result.state).toBe("uncertain");
		expect(readlinkSync(join(home, "auth.json"))).toBe(
			codexCredentialTruthPath(env),
		);
	});

	it("leaves the original credential in place and removes the temporary link when rename fails", () => {
		const home = join(tmp, "rename-failure-home");
		mkdirSync(home, { mode: 0o700 });
		writeFileSync(join(home, "auth.json"), "original-copy", { mode: 0o600 });

		expect(() =>
			migrateCodexHomeCredential({
				home,
				env,
				registryPath,
				testing: {
					beforeRename() {
						throw new Error("injected rename failure");
					},
				},
			}),
		).toThrow(/injected rename failure/);
		expect(readFileSync(join(home, "auth.json"), "utf8")).toBe("original-copy");
		expect(
			readdirSync(home).filter((name) => name.startsWith("auth.json.link.")),
		).toEqual([]);
	});

	it("refuses keyed migration while any execution lease is live", async () => {
		const admission = await admitCodexAgentHome(
			{
				project: "flywheel",
				role: "qa",
				executionId: "exec-live-migration",
				requestedAssemblyArm: "bare",
			},
			env,
		);
		writeFileSync(join(admission.handle.home, "auth.json"), "legacy-copy", {
			mode: 0o600,
		});

		await expect(
			migrateCodexAgentHomeCredential({
				home: admission.handle.home,
				env,
				registryPath,
			}),
		).rejects.toThrow(/live leases/);
		expect(readFileSync(join(admission.handle.home, "auth.json"), "utf8")).toBe(
			"legacy-copy",
		);
	});

	it("repairs a missing credential in a drained home and can roll it back to a 0600 copy", () => {
		const home = join(tmp, "missing-link-home");
		mkdirSync(home, { mode: 0o700 });

		const linked = migrateCodexHomeCredential({ home, env, registryPath });
		expect(linked.state).toBe("linked");
		expect(lstatSync(join(home, "auth.json")).isSymbolicLink()).toBe(true);

		const unlinked = migrateCodexHomeCredential({
			home,
			env,
			registryPath,
			unlink: true,
		});
		expect(unlinked.state).toBe("unlinked");
		expect(lstatSync(join(home, "auth.json")).isSymbolicLink()).toBe(false);
		expect(statSync(join(home, "auth.json")).mode & 0o777).toBe(0o600);
		expect(readFileSync(join(home, "auth.json"))).toEqual(
			readFileSync(codexCredentialTruthPath(env)),
		);
		expect(existsSync(join(home, ".credential-copy-pending"))).toBe(true);
	});

	it("repairs a missing credential with keepBackup without inventing a backup", () => {
		const home = join(tmp, "missing-link-with-backup-home");
		mkdirSync(home, { mode: 0o700 });

		const result = migrateCodexHomeCredential({
			home,
			env,
			registryPath,
			keepBackup: true,
		});

		expect(result.state).toBe("linked");
		expect(result.backupPath).toBeUndefined();
		expect(readlinkSync(join(home, "auth.json"))).toBe(
			codexCredentialTruthPath(env),
		);
	});
});

describe("retirement (P5 credential-residue invariant)", () => {
	it("scrubCodexHomeCredential removes the live token but keeps the home", () => {
		const home = provisionCodexHome({
			executionId: "exec-5",
			ghToken: TOKEN,
			env,
		});
		scrubCodexHomeCredential("exec-5", env);
		const cfg = readFileSync(join(home, "config.toml"), "utf-8");
		expect(cfg).not.toContain("GH_TOKEN");
		expect(cfg).not.toContain("shell_environment_policy");
		expect(cfg).toContain('model = "gpt-5-codex"'); // base config retained
	});

	it("scrub is a no-op when the home is absent", () => {
		expect(() => scrubCodexHomeCredential("never-existed", env)).not.toThrow();
	});

	it("removeCodexHome deletes the whole home", () => {
		const home = provisionCodexHome({
			executionId: "exec-6",
			ghToken: TOKEN,
			env,
		});
		removeCodexHome("exec-6", env);
		expect(() => statSync(home)).toThrow();
	});
});

describe("R1 hardening (Codex code review round 1)", () => {
	it("MED #2: re-provision repairs a pre-existing wider-mode config.toml back to 0600", () => {
		const home = provisionCodexHome({ executionId: "x1", ghToken: TOKEN, env });
		// Simulate a config that pre-existed world-readable (e.g. crash-recovery).
		chmodSync(join(home, "config.toml"), 0o644);
		chmodSync(home, 0o755);
		provisionCodexHome({ executionId: "x1", ghToken: TOKEN, env });
		expect(statSync(join(home, "config.toml")).mode & 0o777).toBe(0o600);
		expect(statSync(home).mode & 0o777).toBe(0o700);
	});

	it("MED #3: scrubOrphanedCodexHomes strips the token from non-live homes, keeps live ones", () => {
		provisionCodexHome({ executionId: "live-1", ghToken: TOKEN, env });
		provisionCodexHome({ executionId: "dead-1", ghToken: TOKEN, env });
		provisionCodexHome({ executionId: "dead-2", ghToken: TOKEN, env });

		const scrubbed = scrubOrphanedCodexHomes(new Set(["live-1"]), env);
		expect(scrubbed).toBe(2);

		const read = (id: string) =>
			readFileSync(join(codexHomeDir(id, env), "config.toml"), "utf-8");
		expect(read("live-1")).toContain("GH_TOKEN"); // live runner keeps its token
		expect(read("dead-1")).not.toContain("GH_TOKEN");
		expect(read("dead-2")).not.toContain("GH_TOKEN");
		// re-running is a no-op (already-clean homes aren't recounted)
		expect(scrubOrphanedCodexHomes(new Set(["live-1"]), env)).toBe(0);
	});

	it("MED #3: scrubOrphanedCodexHomes is a no-op when the homes root is absent", () => {
		expect(
			scrubOrphanedCodexHomes(new Set(), {
				FLYWHEEL_CODEX_HOMES_ROOT: join(tmp, "no-such-root"),
			}),
		).toBe(0);
	});

	it("HIGH #1: stripSecretEnv removes all GitHub-token env names, keeps the rest", () => {
		const out = stripSecretEnv({
			GH_TOKEN: "ghp_x",
			GITHUB_TOKEN: "ghp_y",
			GH_ENTERPRISE_TOKEN: "z",
			PATH: "/usr/bin",
			CODEX_HOME: "/home",
		});
		expect(out.GH_TOKEN).toBeUndefined();
		expect(out.GITHUB_TOKEN).toBeUndefined();
		expect(out.GH_ENTERPRISE_TOKEN).toBeUndefined();
		expect(out.PATH).toBe("/usr/bin");
		expect(out.CODEX_HOME).toBe("/home");
	});
});

describe("FLY-1188 full-PR HIGH-4: stripInheritedSecretEnv (daemon env leak)", () => {
	it("strips the Bridge's third-party creds (Discord/Linear/DB/API + GH family)", () => {
		const out = stripInheritedSecretEnv({
			DISCORD_BOT_TOKEN: "d",
			LINEAR_API_KEY: "l",
			ANTHROPIC_API_KEY: "a",
			OPENAI_API_KEY: "o",
			DATABASE_PASSWORD: "p",
			SUPABASE_SECRET: "s",
			SOME_KEY: "k",
			GH_TOKEN: "ghp",
			GITHUB_TOKEN: "ghp2",
		});
		for (const k of [
			"DISCORD_BOT_TOKEN",
			"LINEAR_API_KEY",
			"ANTHROPIC_API_KEY",
			"OPENAI_API_KEY",
			"DATABASE_PASSWORD",
			"SUPABASE_SECRET",
			"SOME_KEY",
			"GH_TOKEN",
			"GITHUB_TOKEN",
		]) {
			expect(out[k]).toBeUndefined();
		}
	});

	it("FLY-1643: drops every inherited FLYWHEEL_ var and keeps the safe OS base", () => {
		const out = stripInheritedSecretEnv({
			FLYWHEEL_INGEST_TOKEN: "it",
			FLYWHEEL_BRIDGE_URL: "http://x",
			FLYWHEEL_COMM_DB: "/db",
			FLYWHEEL_GATE_MARKER_DIR: "/m",
			FLYWHEEL_COMPLETE_MARKER_DIR: "/complete",
			FLYWHEEL_AGENT_TEAM_NAME: "eng",
			FLYWHEEL_WORKFLOW_OUTPUT_CREDENTIAL: "output-ticket",
			FLYWHEEL_ALERT_BOT_TOKEN: "alert-secret",
			PATH: "/usr/bin",
			HOME: "/home/u",
		});
		for (const key of Object.keys(out)) expect(key).not.toMatch(/^FLYWHEEL_/);
		expect(out.PATH).toBe("/usr/bin");
		expect(out.HOME).toBe("/home/u");
	});

	// R3 HIGH: a NAME denylist misses auth-CAPABLE handles whose names don't look
	// secret. The safe-base ALLOWLIST drops them (and any unknown var) while
	// keeping the OS/locale/proxy base the daemon needs.
	it("safe-base allowlist: DROPS auth-capable + unknown vars, KEEPS OS/locale/proxy base", () => {
		const out = stripInheritedSecretEnv({
			// auth-capable / credential pointers whose names are not secret-shaped
			SSH_AUTH_SOCK: "/tmp/agent.sock",
			SSH_AGENT_PID: "123",
			AWS_SHARED_CREDENTIALS_FILE: "/root/.aws/credentials",
			GOOGLE_APPLICATION_CREDENTIALS: "/root/gcp.json",
			KUBECONFIG: "/root/.kube/config",
			DOCKER_CONFIG: "/root/.docker",
			// an arbitrary var the model or host might introduce
			SOME_RANDOM_HOST_VAR: "x",
			// safe base the daemon genuinely needs
			PATH: "/usr/bin",
			HOME: "/home/u",
			LANG: "en_US.UTF-8",
			LC_ALL: "en_US.UTF-8",
			HTTPS_PROXY: "http://proxy:8080",
			FLYWHEEL_GATE_MARKER_DIR: "/m",
			FLYWHEEL_INGEST_TOKEN: "it",
		});
		for (const k of [
			"SSH_AUTH_SOCK",
			"SSH_AGENT_PID",
			"AWS_SHARED_CREDENTIALS_FILE",
			"GOOGLE_APPLICATION_CREDENTIALS",
			"KUBECONFIG",
			"DOCKER_CONFIG",
			"SOME_RANDOM_HOST_VAR",
		]) {
			expect(out[k]).toBeUndefined();
		}
		expect(out.PATH).toBe("/usr/bin");
		expect(out.HOME).toBe("/home/u");
		expect(out.LANG).toBe("en_US.UTF-8");
		expect(out.LC_ALL).toBe("en_US.UTF-8");
		expect(out.HTTPS_PROXY).toBe("http://proxy:8080");
		expect(out.FLYWHEEL_GATE_MARKER_DIR).toBeUndefined();
		expect(out.FLYWHEEL_INGEST_TOKEN).toBeUndefined();
	});

	// R4/R5 HIGH: a proxy URL can embed `user:pass@` (incl. `@` inside the pass, no
	// scheme, or scheme-relative `//`). Strip to the LAST `@` of the authority; keep
	// the host; fail-closed (drop) if userinfo but no host.
	it("R5: strips credential userinfo from proxy URLs in every form (keeps the host)", () => {
		const out = stripInheritedSecretEnv({
			HTTPS_PROXY: "http://user:password@proxy:8080",
			http_proxy: "https://tok@10.0.0.1:3128",
			ALL_PROXY: "http://user:p@ss@proxy:8080", // `@` inside the password
			HTTP_PROXY: "user:pass@proxy:8080", // no scheme
			https_proxy: "//user:pass@proxy:8080", // scheme-relative
			no_proxy: "localhost,127.0.0.1", // no userinfo, unchanged
		});
		expect(out.HTTPS_PROXY).toBe("http://proxy:8080");
		expect(out.http_proxy).toBe("https://10.0.0.1:3128");
		expect(out.ALL_PROXY).toBe("http://proxy:8080"); // stripped to the LAST @
		expect(out.HTTP_PROXY).toBe("proxy:8080"); // no scheme, userinfo gone
		expect(out.https_proxy).toBe("//proxy:8080"); // scheme-relative preserved
		expect(out.no_proxy).toBe("localhost,127.0.0.1");
	});

	// R6 HIGH: redundant slashes (`http:///user:pass@host`) push the userinfo out of
	// the parsed authority — curl still reads it as creds. Any residual `@` in a
	// cleared proxy value fails-closed (the var is dropped entirely).
	it("R6: DROPS proxy values whose credentials survive normalization (redundant slashes)", () => {
		const out = stripInheritedSecretEnv({
			HTTPS_PROXY: "http:///user:pass@proxy:8080",
			HTTP_PROXY: "http:////user:pass@proxy:8080",
			ALL_PROXY: "http://proxy:8080", // clean → kept
		});
		expect(out.HTTPS_PROXY).toBeUndefined();
		expect(out.HTTP_PROXY).toBeUndefined();
		expect(out.ALL_PROXY).toBe("http://proxy:8080");
	});
});

// ── QA · FLY-1188 — the founder TUI must NOT be launched through the rotation
// shim. The shim pipes codex's stdout through `tee` (to sniff a 429 and rotate
// the account), so stdout is a pipe, and `codex resume --remote` is a TUI: it
// prints "Error: stdout is not a terminal" and exits 1. That is why the founder's
// cmux tab was empty. The daemon keeps the shim (app-server needs no TTY). ──
describe("rawCodexBin (the TTY-capable binary for the founder TUI)", () => {
	it("resolves the raw TUI binary independently of the daemon launcher", () => {
		expect(rawCodexBin({ PATH: "/usr/bin" })).not.toContain(
			"flywheel-codex-with-fallback",
		);
		// ...not even when the shim is the daemon's configured binary
		expect(
			rawCodexBin({
				PATH: "/usr/bin",
				FLYWHEEL_CODEX_BIN: "/x/flywheel-codex-with-fallback",
			}),
		).not.toContain("flywheel-codex-with-fallback");
	});

	it("honours an explicit ops/test override", () => {
		expect(rawCodexBin({ FLYWHEEL_CODEX_TUI_BIN: "/opt/codex" })).toBe(
			"/opt/codex",
		);
	});

	it("falls back to the bare name when PATH holds no codex (the tmux shell resolves it — the verified lead-side behavior)", () => {
		expect(rawCodexBin({ PATH: "/nonexistent-dir-fly1188" })).toBe("codex");
		expect(rawCodexBin({})).toBe("codex");
	});
});
