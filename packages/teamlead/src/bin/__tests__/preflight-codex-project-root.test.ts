import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runPreflightCodexProjectRoot } from "../preflight-codex-project-root.js";

describe("preflight-codex-project-root", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	function fixture() {
		const sandbox = mkdtempSync(join(tmpdir(), "fly2444-project-root-"));
		roots.push(sandbox);
		const home = join(sandbox, "home", "founder");
		const project = join(home, "Dev", "raya");
		const stateDir = join(home, ".flywheel", "state", "codex-lead", "raya");
		const codexHome = join(home, ".codex-raya-lead");
		for (const path of [home, project, stateDir, codexHome]) {
			mkdirSync(path, { recursive: true });
		}
		return { sandbox, home, project, stateDir, codexHome };
	}

	function run(
		f: ReturnType<typeof fixture>,
		projectRoot: string,
	): { code: number; stdout: string[]; stderr: string[] } {
		const stdout: string[] = [];
		const stderr: string[] = [];
		const code = runPreflightCodexProjectRoot(
			[
				"--project-root",
				projectRoot,
				"--state-dir",
				f.stateDir,
				"--codex-home",
				f.codexHome,
			],
			{
				homeDir: f.home,
				stdout: (line) => stdout.push(line),
				stderr: (line) => stderr.push(line),
			},
		);
		return { code, stdout, stderr };
	}

	it("returns the canonical path for a normal repository under HOME", () => {
		const f = fixture();
		const result = run(f, f.project);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout[0]!)).toEqual({
			ok: true,
			projectRoot: realpathSync(f.project),
		});
	});

	it.each([
		["HOME itself", (f: ReturnType<typeof fixture>) => f.home],
		["an ancestor of HOME", (f: ReturnType<typeof fixture>) => dirname(f.home)],
		[
			"the Flywheel state tree",
			(f: ReturnType<typeof fixture>) => join(f.home, ".flywheel"),
		],
		["the Lead state directory", (f: ReturnType<typeof fixture>) => f.stateDir],
		["CODEX_HOME", (f: ReturnType<typeof fixture>) => f.codexHome],
	])("rejects overlap with %s", (_label, projectRoot) => {
		const f = fixture();
		const result = run(f, projectRoot(f));
		expect(result.code).toBe(78);
		expect(JSON.parse(result.stderr[0]!)).toMatchObject({
			ok: false,
			code: "codex_project_root_invalid",
		});
	});

	it("uses exit 64 for incomplete arguments", () => {
		const stderr: string[] = [];
		expect(
			runPreflightCodexProjectRoot(["--project-root", "/tmp/raya"], {
				stderr: (line) => stderr.push(line),
			}),
		).toBe(64);
		expect(JSON.parse(stderr[0]!)).toMatchObject({
			code: "codex_project_root_usage",
		});
	});
});
