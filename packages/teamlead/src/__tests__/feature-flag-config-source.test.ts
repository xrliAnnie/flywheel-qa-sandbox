import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
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

		expect(map.get("registry-project")?.config).toBeUndefined();
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
});
