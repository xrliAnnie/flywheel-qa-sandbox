import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { init } from "../commands/init.js";

describe("flywheel init", () => {
	let root: string;

	beforeEach(() => {
		root = join(tmpdir(), `fly-init-${Date.now()}-${Math.random()}`);
		mkdirSync(root, { recursive: true });
		// Make it a git repo (init requires .git/).
		execFileSync("git", ["init", "-q"], { cwd: root });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("scaffolds a node-only project registry and node-backed config", () => {
		const result = init({ projectPath: root, noDepts: true });

		expect(existsSync(join(root, ".flywheel", "config.yaml"))).toBe(true);
		expect(existsSync(join(root, ".flywheel", "agents", "registry.yaml"))).toBe(
			true,
		);
		expect(
			existsSync(join(root, ".flywheel", "agents", "nodes", "example.md")),
		).toBe(true);
		const config = readFileSync(result.configPath, "utf8");
		expect(config).toContain("node: example");
		expect(config).not.toContain("agent_file");
		expect(result.depts).toHaveLength(0);
	});

	it("scaffolds dept subdirs when --depts is provided", () => {
		init({
			projectPath: root,
			depts: ["product", "operations", "marketing"],
		});
		const registry = readFileSync(
			join(root, ".flywheel", "agents", "registry.yaml"),
			"utf8",
		);
		expect(registry).toContain("department: product");
		expect(registry).not.toContain("department: operations");
	});

	it("refuses to scaffold over an existing .flywheel/ without --force", () => {
		mkdirSync(join(root, ".flywheel"), { recursive: true });
		expect(() => init({ projectPath: root, noDepts: true })).toThrow(
			/already exists/,
		);
	});

	it("accepts --force to overwrite an existing .flywheel/", () => {
		mkdirSync(join(root, ".flywheel"), { recursive: true });
		// No throw expected.
		const result = init({ projectPath: root, noDepts: true, force: true });
		expect(existsSync(result.configPath)).toBe(true);
	});

	it("errors when not in a git repository", () => {
		const nonGit = join(tmpdir(), `fly-init-nogit-${Date.now()}`);
		mkdirSync(nonGit, { recursive: true });
		try {
			expect(() => init({ projectPath: nonGit, noDepts: true })).toThrow(
				/git repository/,
			);
		} finally {
			rmSync(nonGit, { recursive: true, force: true });
		}
	});

	it("substitutes project name into config.yaml", () => {
		init({ projectPath: root, noDepts: true, projectName: "myproj" });
		const cfg = readFileSync(join(root, ".flywheel", "config.yaml"), "utf-8");
		expect(cfg).toContain('project: "myproj"');
	});

	it("does not scaffold retired checkpoint enabled keys", () => {
		init({ projectPath: root, noDepts: true });
		const cfg = readFileSync(join(root, ".flywheel", "config.yaml"), "utf-8");
		expect(cfg).not.toContain("checkpoints:");
		expect(cfg).not.toMatch(
			/^ {2}[a-z_]+:\n {4}enabled:\s+(?:true|false)\s*$/m,
		);
	});
});
