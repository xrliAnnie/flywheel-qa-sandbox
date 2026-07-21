import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const MATERIALIZER = join(
	__dirname,
	"..",
	"..",
	"scripts",
	"lead-rules-bundle.sh",
);

describe("lead rules bundle materializer", () => {
	let fixtureDir: string;

	beforeEach(() => {
		fixtureDir = mkdtempSync(join(tmpdir(), "fly1402-materialize-"));
	});

	afterEach(() => {
		rmSync(fixtureDir, { recursive: true, force: true });
	});

	it("preserves both source sentinels in order with a body SHA", () => {
		const alpha = join(fixtureDir, "alpha.md");
		const beta = join(fixtureDir, "beta.md");
		const output = join(fixtureDir, "rules-bundle.md");
		writeFileSync(alpha, "FLY1402_ALPHA_SENTINEL\n");
		writeFileSync(beta, "FLY1402_BETA_SENTINEL\n");

		const result = spawnSync(
			"bash",
			[
				"-c",
				[
					"set -euo pipefail",
					'source "$1"',
					"rules_bundle_reset",
					'rules_bundle_add "$2" base',
					'rules_bundle_add "$3" project',
					'rules_bundle_materialize "$4" dept tadashi flywheel',
				].join("; "),
				"_",
				MATERIALIZER,
				alpha,
				beta,
				output,
			],
			{ encoding: "utf8" },
		);

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toBe(`${output}\n`);
		const bundle = readFileSync(output, "utf8");
		expect(bundle).toContain("RULES_BUNDLE_SHA=");
		expect(bundle).toContain("FILES=2");
		expect(bundle).toContain(`1. base/alpha.md — ${alpha}`);
		expect(bundle).toContain(`2. project/beta.md — ${beta}`);
		expect(bundle).toContain("RULE SOURCE [1/2]: base/alpha.md");
		expect(bundle).toContain("RULE SOURCE [2/2]: project/beta.md");
		expect(bundle.indexOf("FLY1402_ALPHA_SENTINEL")).toBeLessThan(
			bundle.indexOf("FLY1402_BETA_SENTINEL"),
		);

		const bodyStart = bundle.indexOf("═══ RULE SOURCE [1/2]");
		expect(bodyStart).toBeGreaterThan(0);
		const body = bundle.slice(bodyStart);
		const declaredSha = bundle.match(/RULES_BUNDLE_SHA=([a-f0-9]{64})/)?.[1];
		expect(declaredSha).toBe(createHash("sha256").update(body).digest("hex"));
	});

	it("returns cleanly without output or a file when no rules were selected", () => {
		const output = join(fixtureDir, "empty-bundle.md");
		const result = spawnSync(
			"bash",
			[
				"-c",
				[
					"set -euo pipefail",
					'source "$1"',
					"rules_bundle_reset",
					'rules_bundle_materialize "$2" dept tadashi flywheel',
				].join("; "),
				"_",
				MATERIALIZER,
				output,
			],
			{ encoding: "utf8" },
		);

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toBe("");
		expect(existsSync(output)).toBe(false);
	});

	it("distinguishes same-named sources by their layer labels", () => {
		const baseDir = join(fixtureDir, "base");
		const projectDir = join(fixtureDir, "project");
		mkdirSync(baseDir);
		mkdirSync(projectDir);
		const baseRule = join(baseDir, "shared.md");
		const projectRule = join(projectDir, "shared.md");
		const output = join(fixtureDir, "same-name-bundle.md");
		writeFileSync(baseRule, "BASE_LAYER\n");
		writeFileSync(projectRule, "PROJECT_LAYER\n");

		const result = spawnSync(
			"bash",
			[
				"-c",
				[
					"set -euo pipefail",
					'source "$1"',
					"rules_bundle_reset",
					'rules_bundle_add "$2" base',
					'rules_bundle_add "$3" project',
					'rules_bundle_materialize "$4" dept tadashi flywheel',
				].join("; "),
				"_",
				MATERIALIZER,
				baseRule,
				projectRule,
				output,
			],
			{ encoding: "utf8" },
		);

		expect(result.status, result.stderr).toBe(0);
		const bundle = readFileSync(output, "utf8");
		expect(bundle).toContain(`1. base/shared.md — ${baseRule}`);
		expect(bundle).toContain(`2. project/shared.md — ${projectRule}`);
		expect(bundle).toContain("RULE SOURCE [1/2]: base/shared.md");
		expect(bundle).toContain("RULE SOURCE [2/2]: project/shared.md");
	});

	it("separates a source without a trailing newline and supports spaced paths", () => {
		const spacedDir = join(fixtureDir, "rules with spaces");
		mkdirSync(spacedDir);
		const first = join(spacedDir, "first rule.md");
		const second = join(spacedDir, "second rule.md");
		const output = join(spacedDir, "combined rules.md");
		writeFileSync(first, "NO_FINAL_NEWLINE");
		writeFileSync(second, "SECOND_RULE\n");

		const result = spawnSync(
			"bash",
			[
				"-c",
				[
					"set -euo pipefail",
					'source "$1"',
					"rules_bundle_reset",
					'rules_bundle_add "$2" launcher',
					'rules_bundle_add "$3" launcher',
					'rules_bundle_materialize "$4" external scout flywheel',
				].join("; "),
				"_",
				MATERIALIZER,
				first,
				second,
				output,
			],
			{ encoding: "utf8" },
		);

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toBe(`${output}\n`);
		const bundle = readFileSync(output, "utf8");
		expect(bundle).toContain(
			"NO_FINAL_NEWLINE\n\n═══ RULE SOURCE [2/2]: launcher/second rule.md",
		);
		expect(bundle).toContain(`1. launcher/first rule.md — ${first}`);
	});

	it("creates a private directory and bundle regardless of the caller umask", () => {
		const source = join(fixtureDir, "private.md");
		const outputDir = join(fixtureDir, "generated", "bundles");
		const output = join(outputDir, "private-bundle.md");
		writeFileSync(source, "PRIVATE_RULE\n");

		const result = spawnSync(
			"bash",
			[
				"-c",
				[
					"set -euo pipefail",
					"umask 0000",
					'source "$1"',
					"rules_bundle_reset",
					'rules_bundle_add "$2" base',
					'rules_bundle_materialize "$3" dept tadashi flywheel',
				].join("; "),
				"_",
				MATERIALIZER,
				source,
				output,
			],
			{ encoding: "utf8" },
		);

		expect(result.status, result.stderr).toBe(0);
		expect(statSync(outputDir).mode & 0o777).toBe(0o700);
		expect(statSync(output).mode & 0o777).toBe(0o600);
	});

	it("removes body and final temp files when the atomic move fails", () => {
		const source = join(fixtureDir, "source.md");
		const outputDir = join(fixtureDir, "output");
		const output = join(outputDir, "bundle.md");
		const shimDir = join(fixtureDir, "shim");
		mkdirSync(shimDir);
		writeFileSync(source, "MOVE_FAILURE_RULE\n");
		writeFileSync(join(shimDir, "mv"), "#!/bin/sh\nexit 55\n", {
			mode: 0o755,
		});

		const result = spawnSync(
			"bash",
			[
				"-c",
				[
					"set -euo pipefail",
					'source "$1"',
					"rules_bundle_reset",
					'rules_bundle_add "$2" base',
					'rules_bundle_materialize "$3" dept tadashi flywheel',
				].join("; "),
				"_",
				MATERIALIZER,
				source,
				output,
			],
			{
				encoding: "utf8",
				env: {
					...process.env,
					PATH: `${shimDir}:${process.env.PATH ?? ""}`,
				},
			},
		);

		expect(result.status).not.toBe(0);
		expect(existsSync(output)).toBe(false);
		expect(readdirSync(outputDir)).toEqual([]);
	});

	it("keeps stdout clean when SHA tools are unavailable", () => {
		const source = join(fixtureDir, "source.md");
		const output = join(fixtureDir, "bundle.md");
		const shimDir = join(fixtureDir, "no-sha-path");
		mkdirSync(shimDir);
		writeFileSync(source, "NO_SHA_RULE\n");
		for (const command of [
			"dirname",
			"mkdir",
			"chmod",
			"mktemp",
			"basename",
			"cat",
			"tail",
			"od",
			"tr",
			"date",
			"mv",
			"rm",
		]) {
			const resolved = spawnSync("/bin/sh", ["-c", `command -v ${command}`], {
				encoding: "utf8",
			}).stdout.trim();
			expect(resolved, `missing fixture command: ${command}`).not.toBe("");
			symlinkSync(resolved, join(shimDir, command));
		}

		const result = spawnSync(
			"/bin/bash",
			[
				"-c",
				[
					"set -euo pipefail",
					'source "$1"',
					"rules_bundle_reset",
					'rules_bundle_add "$2" base',
					'rules_bundle_materialize "$3" dept tadashi flywheel',
				].join("; "),
				"_",
				MATERIALIZER,
				source,
				output,
			],
			{
				encoding: "utf8",
				env: { ...process.env, PATH: shimDir },
			},
		);

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toBe(`${output}\n`);
		expect(result.stderr).toContain("WARNING: no SHA-256 tool available");
		expect(readFileSync(output, "utf8")).toContain(
			"RULES_BUNDLE_SHA=unavailable FILES=1",
		);
	});

	it("fails at materialization and removes temps when a selected source is unreadable", () => {
		const missingSource = join(fixtureDir, "missing.md");
		const outputDir = join(fixtureDir, "read-failure");
		const output = join(outputDir, "bundle.md");
		const result = spawnSync(
			"bash",
			[
				"-c",
				[
					"set -euo pipefail",
					'source "$1"',
					"rules_bundle_reset",
					'rules_bundle_add "$2" base',
					'rules_bundle_materialize "$3" dept tadashi flywheel',
				].join("; "),
				"_",
				MATERIALIZER,
				missingSource,
				output,
			],
			{ encoding: "utf8" },
		);

		expect(result.status).not.toBe(0);
		expect(existsSync(output)).toBe(false);
		expect(readdirSync(outputDir)).toEqual([]);
	});
});
