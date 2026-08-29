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

	it("scaffolds .flywheel/ with no depts (flat agents/)", () => {
		const result = init({ projectPath: root, noDepts: true });

		expect(existsSync(join(root, ".flywheel", "config.yaml"))).toBe(true);
		expect(existsSync(join(root, ".flywheel", "agents"))).toBe(true);
		expect(existsSync(join(root, ".flywheel", "agents", ".gitkeep"))).toBe(
			true,
		);
		expect(
			existsSync(join(root, ".flywheel", "agents", "example-executor.md")),
		).toBe(true);
		expect(result.depts).toHaveLength(0);
	});

	it("scaffolds dept subdirs when --depts is provided", () => {
		init({
			projectPath: root,
			depts: ["product", "operations", "marketing"],
		});
		for (const d of ["product", "operations", "marketing"]) {
			expect(existsSync(join(root, ".flywheel", "agents", d))).toBe(true);
			expect(existsSync(join(root, ".flywheel", "agents", d, ".gitkeep"))).toBe(
				true,
			);
		}
		// Example agent goes under FIRST dept.
		expect(
			existsSync(
				join(root, ".flywheel", "agents", "product", "example-executor.md"),
			),
		).toBe(true);
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
		expect(cfg).toContain('name: "myproj"');
	});
});
