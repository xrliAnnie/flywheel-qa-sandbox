import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	loadFeatureFlagProjectConfigs,
	ProjectConfigCache,
} from "../bridge/feature-flag-config-source.js";
import type { ProjectEntry } from "../ProjectConfig.js";

const PROJECTS: ProjectEntry[] = [
	{
		projectName: "ok",
		projectRoot: "/p/ok",
		leads: [],
	} as unknown as ProjectEntry,
	{
		projectName: "missing",
		projectRoot: "/p/missing",
		leads: [],
	} as unknown as ProjectEntry,
	{
		projectName: "broken",
		projectRoot: "/p/broken",
		leads: [],
	} as unknown as ProjectEntry,
];

describe("loadFeatureFlagProjectConfigs", () => {
	it("loads config, treats ENOENT as absent/default, surfaces malformed as error", async () => {
		const OK_CONFIG = [
			"project: ok",
			"linear:",
			"  team_id: OK",
			"runners:",
			"  default: claude",
			"  available:",
			"    claude:",
			"      type: claude",
			"teams:",
			"  - name: default",
			"    orchestrators:",
			"      - type: dag",
			"        runner: claude",
			"decision_layer:",
			"  autonomy_level: advisor",
			"  escalation_channel: discord",
			"",
		].join("\n");
		const map = await loadFeatureFlagProjectConfigs(PROJECTS, (p) => {
			if (p.includes("/p/ok/")) return OK_CONFIG;
			if (p.includes("/p/missing/")) {
				const err = new Error("no file") as NodeJS.ErrnoException;
				err.code = "ENOENT";
				throw err;
			}
			// broken → invalid yaml
			return "project: broken\n:::garbage";
		});

		// ok → loaded config
		expect(map.get("ok")?.config).toBeDefined();
		expect(map.get("ok")?.error).toBeUndefined();
		expect(map.get("ok")?.revision).toMatch(/^file:[a-f0-9]{64}$/);

		// missing → no error, no config (absent/default semantics)
		expect(map.get("missing")).toEqual({ revision: "registry:absent" });

		// broken → error surfaced as data
		expect(map.get("broken")?.error).toBeTruthy();
		expect(map.get("broken")?.config).toBeUndefined();
		expect(map.get("broken")?.revision).toMatch(/^file:[a-f0-9]{64}$/);
	});

	it("surfaces a missing registry after config.yaml was read", async () => {
		const project = {
			projectName: "registry-project",
			projectRoot: "/p/registry-project",
			leads: [],
		} as unknown as ProjectEntry;
		const config = [
			"project: registry-project",
			"linear: { team_id: TEAM }",
			"runners:",
			"  default: claude",
			"  available: { claude: { type: claude } }",
			"teams:",
			"  - name: default",
			"decision_layer:",
			"  autonomy_level: advisor",
			"  escalation_channel: discord",
			"agents:",
			"  backend:",
			"    node: engineer",
			"    match: { labels: [backend] }",
			"",
		].join("\n");

		const map = await loadFeatureFlagProjectConfigs([project], () => config);

		expect(map.get("registry-project")?.config).toBeDefined();
		expect(map.get("registry-project")?.error).toMatch(/ENOENT|no such file/i);
		expect(map.get("registry-project")?.revision).toMatch(/^file:/);
	});

	it("loads a legacy agent_file config without requiring a registry", async () => {
		const project = {
			projectName: "legacy-project",
			projectRoot: "/p/legacy-project",
			leads: [],
		} as unknown as ProjectEntry;
		const config = [
			"project: legacy-project",
			"linear: { team_id: TEAM }",
			"runners:",
			"  default: claude",
			"  available: { claude: { type: claude } }",
			"teams:",
			"  - name: default",
			"decision_layer:",
			"  autonomy_level: advisor",
			"  escalation_channel: discord",
			"agents:",
			"  backend:",
			"    agent_file: .flywheel/agents/engineering/backend.md",
			"    match: { labels: [backend] }",
			"",
		].join("\n");

		const map = await loadFeatureFlagProjectConfigs([project], () => config);

		expect(map.get("legacy-project")?.error).toBeUndefined();
		expect(map.get("legacy-project")?.resolvedAgents?.backend).toMatchObject({
			agentFile: "/p/legacy-project/.flywheel/agents/engineering/backend.md",
			department: "engineering",
			departments: ["engineering"],
		});
	});

	it("resolves legacy ic-roster refs once and distinguishes them from an absent roster", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2365-legacy-roster-"));
		try {
			mkdirSync(join(root, ".flywheel", "agents", "life"), {
				recursive: true,
			});
			mkdirSync(join(root, ".flywheel", "menus"), { recursive: true });
			const handbook = join(
				root,
				".flywheel",
				"agents",
				"life",
				"life-executor.md",
			);
			writeFileSync(handbook, "# Life\n");
			writeFileSync(
				join(root, ".flywheel", "config.yaml"),
				[
					"project: personal-assistant",
					"linear: { team_id: FLY }",
					"runners:",
					"  default: claude",
					"  available: { claude: { type: claude } }",
					"teams: [{ name: default }]",
					"decision_layer:",
					"  autonomy_level: advisor",
					"  escalation_channel: discord",
					"agents:",
					"  life:",
					"    agent_file: .flywheel/agents/life/life-executor.md",
					"    match: { labels: [life] }",
					"",
				].join("\n"),
			);
			writeFileSync(
				join(root, ".flywheel", "menus", "ic-roster.yaml"),
				"general: .flywheel/agents/life/life-executor.md\n",
			);
			const entry = {
				projectName: "personal-assistant",
				projectRoot: root,
				leads: [],
			} as unknown as ProjectEntry;

			const loaded = (await loadFeatureFlagProjectConfigs([entry])).get(
				"personal-assistant",
			);
			expect(loaded).toMatchObject({
				handbookRegistryActive: false,
				handbookRosterAvailable: true,
				handbookRosterStatus: "ready",
				handbookResolvedFiles: { general: realpathSync(handbook) },
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses the runtime registry predicate even when config agents still use agent_file", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2365-overlay-active-"));
		try {
			mkdirSync(join(root, ".flywheel", "agents", "nodes"), {
				recursive: true,
			});
			writeFileSync(
				join(root, ".flywheel", "agents", "nodes", "general.md"),
				"# General\n",
			);
			writeFileSync(
				join(root, ".flywheel", "agents", "registry.yaml"),
				"nodes:\n  general:\n    file: nodes/general.md\n",
			);
			writeFileSync(
				join(root, ".flywheel", "config.yaml"),
				[
					"project: managed",
					"linear: { team_id: FLY }",
					"runners:",
					"  default: claude",
					"  available: { claude: { type: claude } }",
					"teams: [{ name: default }]",
					"decision_layer:",
					"  autonomy_level: advisor",
					"  escalation_channel: discord",
					"agents:",
					"  legacy:",
					"    agent_file: .flywheel/agents/nodes/general.md",
					"    match: { labels: [legacy] }",
					"",
				].join("\n"),
			);
			const entry = {
				projectName: "managed",
				projectRoot: root,
				leads: [],
			} as unknown as ProjectEntry;

			const loaded = (await loadFeatureFlagProjectConfigs([entry])).get(
				"managed",
			);
			expect(loaded?.handbookRegistryActive).toBe(true);
			expect(loaded?.resolvedRegistry?.nodes.general).toMatchObject({
				name: "general",
				label: "通用执行",
			});
			expect(loaded?.handbookRosterStatus).toBe("not_applicable");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("contains an unreadable overlay to its project and preserves the loaded config", async () => {
		const brokenRoot = mkdtempSync(join(tmpdir(), "fly2365-overlay-broken-"));
		const healthyRoot = mkdtempSync(join(tmpdir(), "fly2365-overlay-healthy-"));
		try {
			for (const [root, name] of [
				[brokenRoot, "broken"],
				[healthyRoot, "healthy"],
			] as const) {
				mkdirSync(join(root, ".flywheel", "agents"), { recursive: true });
				writeFileSync(join(root, ".flywheel", "agents", "general.md"), "# G\n");
				writeFileSync(
					join(root, ".flywheel", "config.yaml"),
					[
						`project: ${name}`,
						"linear: { team_id: FLY }",
						"runners:",
						"  default: claude",
						"  available: { claude: { type: claude } }",
						"teams: [{ name: default }]",
						"decision_layer:",
						"  autonomy_level: advisor",
						"  escalation_channel: discord",
						"agents:",
						"  general:",
						"    agent_file: .flywheel/agents/general.md",
						"    match: { labels: [general] }",
						"",
					].join("\n"),
				);
			}
			writeFileSync(
				join(brokenRoot, ".flywheel", "agents", "registry.yaml"),
				"nodes: [broken",
			);
			const projects = [
				{
					projectName: "broken",
					projectRoot: brokenRoot,
					leads: [],
				},
				{
					projectName: "healthy",
					projectRoot: healthyRoot,
					leads: [],
				},
			] as unknown as ProjectEntry[];

			const loaded = await loadFeatureFlagProjectConfigs(projects);
			expect(loaded.get("broken")).toMatchObject({
				config: expect.any(Object),
				handbookRegistryActive: true,
				handbookRosterStatus: "not_applicable",
				handbookResolutionError: expect.any(String),
			});
			expect(loaded.get("healthy")).toMatchObject({
				config: expect.any(Object),
				handbookRegistryActive: false,
				handbookRosterStatus: "absent",
			});
		} finally {
			rmSync(brokenRoot, { recursive: true, force: true });
			rmSync(healthyRoot, { recursive: true, force: true });
		}
	});
});

// FLY-709 P4 (Codex R1 #6): mtime-cached per-project config — a runner-config
// CLI write must be visible in the NEXT snapshot without a Bridge restart, but
// unchanged files must not be re-read per request. Presence transitions
// (appear / disappear / atomic rename) must never serve stale data (R2 note).
describe("ProjectConfigCache", () => {
	const OK = [
		"project: ok",
		"linear:",
		"  team_id: OK",
		"runners:",
		"  default: claude",
		"  available:",
		"    claude:",
		"      type: claude",
		"teams:",
		"  - name: default",
		"    orchestrators:",
		"      - type: dag",
		"        runner: claude",
		"decision_layer:",
		"  autonomy_level: advisor",
		"  escalation_channel: discord",
		"roles:",
		"  runner:",
		"    backend: claude-tmux",
		"    model: claude-sonnet-5",
		"",
	].join("\n");

	function tempProject(): {
		root: string;
		configPath: string;
		entry: ProjectEntry;
	} {
		const root = mkdtempSync(join(tmpdir(), "ffcache-"));
		mkdirSync(join(root, ".flywheel"), { recursive: true });
		return {
			root,
			configPath: join(root, ".flywheel", "config.yaml"),
			entry: {
				projectName: "ok",
				projectRoot: root,
				leads: [],
			} as unknown as ProjectEntry,
		};
	}

	it("re-reads only when the file stamp changes; write is visible next get()", async () => {
		const { root, configPath, entry } = tempProject();
		try {
			writeFileSync(configPath, OK);
			utimesSync(configPath, new Date(1000000), new Date(1000000));
			let reads = 0;
			const cache = new ProjectConfigCache((p) => {
				reads++;
				return readFileSync(p, "utf-8");
			});
			const m1 = await cache.get([entry]);
			const firstRevision = m1.get("ok")?.revision;
			expect(m1.get("ok")?.config?.roles?.runner?.model).toBe(
				"claude-sonnet-5",
			);
			expect(reads).toBe(1);

			// Unchanged stamp → no re-read.
			await cache.get([entry]);
			expect(reads).toBe(1);

			// CLI-style write (new content + new mtime) → visible on the next get.
			writeFileSync(
				configPath,
				OK.replace("claude-sonnet-5", "claude-fable-5"),
			);
			utimesSync(configPath, new Date(2000000), new Date(2000000));
			const m3 = await cache.get([entry]);
			expect(reads).toBe(2);
			expect(m3.get("ok")?.config?.roles?.runner?.model).toBe("claude-fable-5");
			expect(m3.get("ok")?.revision).not.toBe(firstRevision);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("handles appear / disappear transitions without stale data", async () => {
		const { root, configPath, entry } = tempProject();
		try {
			const cache = new ProjectConfigCache();
			// Absent → absent/default semantics.
			const m1 = await cache.get([entry]);
			expect(m1.get("ok")).toEqual({ revision: "registry:absent" });
			// File appears → loaded.
			writeFileSync(configPath, OK);
			const m2 = await cache.get([entry]);
			expect(m2.get("ok")?.config).toBeDefined();
			// File disappears (e.g. renamed away) → back to absent, not stale config.
			rmSync(configPath);
			const m3 = await cache.get([entry]);
			expect(m3.get("ok")).toEqual({ revision: "registry:absent" });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("prunes projects no longer in the roster", async () => {
		const { root, configPath, entry } = tempProject();
		try {
			writeFileSync(configPath, OK);
			const cache = new ProjectConfigCache();
			const m1 = await cache.get([entry]);
			expect(m1.has("ok")).toBe(true);
			const m2 = await cache.get([]);
			expect(m2.has("ok")).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("invalidates when an ic-roster appears without a config write", async () => {
		const { root, configPath, entry } = tempProject();
		try {
			writeFileSync(configPath, OK);
			const cache = new ProjectConfigCache();
			const first = await cache.get([entry]);
			expect(first.get("ok")?.handbookRosterStatus).toBe("absent");

			mkdirSync(join(root, ".flywheel", "menus"), { recursive: true });
			mkdirSync(join(root, ".flywheel", "agents"), { recursive: true });
			writeFileSync(join(root, ".flywheel", "agents", "general.md"), "# G\n");
			writeFileSync(
				join(root, ".flywheel", "menus", "ic-roster.yaml"),
				"general: .flywheel/agents/general.md\n",
			);

			const second = await cache.get([entry]);
			expect(second.get("ok")?.handbookRosterStatus).toBe("ready");
			expect(second.get("ok")?.handbookResolvedFiles).toHaveProperty("general");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("invalidates when a project registry overlay appears without a config write", async () => {
		const { root, configPath, entry } = tempProject();
		try {
			writeFileSync(configPath, OK);
			const cache = new ProjectConfigCache();
			const first = await cache.get([entry]);
			expect(first.get("ok")?.handbookRegistryActive).toBe(false);

			mkdirSync(join(root, ".flywheel", "agents", "nodes"), {
				recursive: true,
			});
			writeFileSync(
				join(root, ".flywheel", "agents", "nodes", "general.md"),
				"# G\n",
			);
			writeFileSync(
				join(root, ".flywheel", "agents", "registry.yaml"),
				"nodes:\n  general:\n    file: nodes/general.md\n",
			);

			const second = await cache.get([entry]);
			expect(second.get("ok")?.handbookRegistryActive).toBe(true);
			expect(second.get("ok")?.resolvedRegistry?.nodes.general).toBeDefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("invalidates on bundled registry stamp changes", async () => {
		const { root, configPath, entry } = tempProject();
		try {
			writeFileSync(configPath, OK);
			const registryPath = join(root, "bundled-registry.yaml");
			writeFileSync(
				registryPath,
				readFileSync(
					new URL(
						"../../../../.flywheel/agents/registry.yaml",
						import.meta.url,
					),
					"utf8",
				),
			);
			let reads = 0;
			const cache = new ProjectConfigCache(
				(path) => {
					reads++;
					return readFileSync(path, "utf8");
				},
				undefined,
				registryPath,
			);
			await cache.get([entry]);
			expect(reads).toBe(1);
			await cache.get([entry]);
			expect(reads).toBe(1);

			writeFileSync(
				registryPath,
				`${readFileSync(registryPath, "utf8")}\n# stamp change\n`,
			);
			await cache.get([entry]);
			expect(reads).toBe(2);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
