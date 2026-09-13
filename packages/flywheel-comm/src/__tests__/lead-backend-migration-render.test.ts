import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { planBackendMigration } from "../lead-backend-migration.js";
import { renderMigrationArtifacts } from "../lead-backend-migration-render.js";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function fixture() {
	const base = mkdtempSync(join(tmpdir(), "fly2459-render-"));
	dirs.push(base);
	const home = join(base, "space & home");
	mkdirSync(home);
	mkdirSync(join(base, "project & root"));
	const root = realpathSync(join(base, "project & root"));
	const registry = [
		{
			projectName: "flywheel",
			projectRoot: root,
			leads: [
				{
					agentId: "flywheel-product-lead",
					backend: "claude-code",
					canSpawnRunners: true,
					summaryRole: "producer",
					chatChannel: "10000000000000001",
					match: { labels: ["Product"] },
				},
			],
		},
	];
	const plan = planBackendMigration({
		registry,
		projectName: "flywheel",
		leadId: "flywheel-product-lead",
		toBackend: "codex-app-server",
		model: "gpt-6-astra",
		effort: "high",
		runnerActions: true,
		deploymentSha: "a".repeat(40),
		manifestSha: "b".repeat(64),
		plistSha: "c".repeat(64),
		createdAt: "2026-09-11T00:00:00.000Z",
	});
	return { home, root, registry, plan };
}
it("renders one canonical manifest and parseable generic carrier plist without credentials", () => {
	const f = fixture();
	const result = renderMigrationArtifacts(f.home, f.registry, f.plan);
	expect(JSON.parse(result.manifest)).toEqual({
		leadId: "flywheel-product-lead",
		projectName: "flywheel",
		projectDir: f.root,
		workspace: f.root,
		projectsFile: `${f.home}/.flywheel/projects.json`,
		subdir: "",
		mcpExclude: "",
		model: "gpt-6-astra",
		leadBackend: { backendId: "codex-app-server" },
	});
	const parsed = spawnSync(
		"python3",
		[
			"-c",
			"import sys,plistlib,json; print(json.dumps(plistlib.loads(sys.stdin.buffer.read())))",
		],
		{ input: result.plist, encoding: "utf8" },
	);
	expect(parsed.status, parsed.stderr).toBe(0);
	expect(JSON.parse(parsed.stdout)).toEqual({
		Label: "com.flywheel.lead.flywheel-flywheel-product-lead",
		ProgramArguments: [
			"/bin/bash",
			`${f.home}/.flywheel/bin/flywheel-lead.sh`,
			`${f.home}/.flywheel/manifests/flywheel-flywheel-product-lead.json`,
		],
		RunAtLoad: true,
		KeepAlive: true,
		ThrottleInterval: 30,
		StandardOutPath: `${f.home}/.flywheel/logs/lead-flywheel-flywheel-product-lead.log`,
		StandardErrorPath: `${f.home}/.flywheel/logs/lead-flywheel-flywheel-product-lead.log`,
	});
});
it("rejects registry drift before producing replacement bytes", () => {
	const f = fixture();
	f.registry[0].projectRoot = "/other";
	expect(() => renderMigrationArtifacts(f.home, f.registry, f.plan)).toThrow(
		"stale",
	);
});

it("normalizes a registry project symlink exactly as the generic launcher", () => {
	const f = fixture();
	const alias = join(f.home, "project-link");
	symlinkSync(f.root, alias);
	f.registry[0].projectRoot = alias;
	const plan = planBackendMigration({
		...f.plan,
		registry: f.registry,
		toBackend: "codex-app-server",
		model: "gpt-6-astra",
		effort: "high",
		runnerActions: true,
		manifestSha: f.plan.expected.manifestSha,
		plistSha: f.plan.expected.plistSha,
	});
	expect(
		JSON.parse(renderMigrationArtifacts(f.home, f.registry, plan).manifest)
			.projectDir,
	).toBe(f.root);
});
