import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPTS = join(__dirname, "..", "..", "scripts");
const MATERIALIZER = join(SCRIPTS, "lead-rules-bundle.sh");
const CHECKER = join(SCRIPTS, "check-rules-truth.sh");

function writeDynamicProbe(options: {
	root: string;
	project: string;
	lead: string;
	receipt: Record<string, unknown>;
	processTree: string;
	lstart?: string;
	tmuxOutput?: string;
	carrier?: string | null;
}): NodeJS.ProcessEnv {
	const stateDir = join(options.root, "dynamic-state");
	const manifestDir = join(options.root, "dynamic-manifests");
	const binDir = join(options.root, "dynamic-bin");
	mkdirSync(stateDir);
	mkdirSync(manifestDir);
	mkdirSync(binDir);
	writeFileSync(
		join(stateDir, `${options.project}-${options.lead}.active.json`),
		JSON.stringify(options.receipt),
	);
	const manifest: Record<string, unknown> = {
		leadId: options.lead,
		projectName: options.project,
	};
	if (options.carrier !== undefined) {
		manifest.leadBackend = { backendId: options.carrier };
	}
	writeFileSync(
		join(manifestDir, `${options.project}-${options.lead}.json`),
		JSON.stringify(manifest),
	);
	writeFileSync(
		join(binDir, "tmux"),
		[
			"#!/bin/sh",
			'if [ "$3" != "$TRUTH_EXPECT_TMUX_TARGET" ]; then exit 9; fi',
			"printf '%b' \"$TRUTH_TMUX_OUTPUT\"",
			"",
		].join("\n"),
		{ mode: 0o755 },
	);
	writeFileSync(
		join(binDir, "ps"),
		[
			"#!/bin/sh",
			'if [ "$1" = "-p" ]; then',
			"  printf '%s\\n' \"$TRUTH_LSTART\"",
			"else",
			"  printf '%s\\n' \"$TRUTH_PROCESS_TREE\"",
			"fi",
			"",
		].join("\n"),
		{ mode: 0o755 },
	);
	return {
		...process.env,
		FLYWHEEL_RULES_TRUTH_STATE_DIR: stateDir,
		FLYWHEEL_RULES_TRUTH_MANIFEST_DIR: manifestDir,
		FLYWHEEL_RULES_TRUTH_TMUX: join(binDir, "tmux"),
		FLYWHEEL_RULES_TRUTH_PS: join(binDir, "ps"),
		TRUTH_LSTART: options.lstart ?? "Tue Jul 21 08:00:00 2026",
		TRUTH_TMUX_OUTPUT: options.tmuxOutput ?? "5000\\t0\\n",
		TRUTH_EXPECT_TMUX_TARGET: `=flywheel:=${options.project}-${options.lead}`,
		TRUTH_PROCESS_TREE: options.processTree,
	};
}

describe("check-rules-truth", () => {
	let fixtureDir: string;

	beforeEach(() => {
		fixtureDir = mkdtempSync(join(tmpdir(), "fly1402-truth-"));
	});

	afterEach(() => {
		rmSync(fixtureDir, { recursive: true, force: true });
	});

	it("accepts a valid dept bundle through the static probe seam", () => {
		const department = join(fixtureDir, "department-lead-rules.md");
		const founder = join(fixtureDir, "founder-only-authority.md");
		const bundle = join(fixtureDir, "dept-bundle.md");
		writeFileSync(department, "# FLY-162 Reply Discipline\n");
		writeFileSync(founder, "# Founder-only authority\n");
		const materialized = spawnSync(
			"bash",
			[
				"-c",
				[
					"set -euo pipefail",
					'source "$1"',
					"rules_bundle_reset",
					'rules_bundle_add "$2" base',
					'rules_bundle_add "$3" base',
					'rules_bundle_materialize "$4" dept tadashi flywheel',
				].join("; "),
				"_",
				MATERIALIZER,
				department,
				founder,
				bundle,
			],
			{ encoding: "utf8" },
		);
		expect(materialized.status, materialized.stderr).toBe(0);

		const result = spawnSync(
			"bash",
			[CHECKER, "--bundle-file", bundle, "--expect-role", "dept"],
			{ encoding: "utf8" },
		);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toMatch(/^PASS .*role=dept .*files=2/m);
	});

	it("rejects a self-consistent bundle whose section differs from its manifest source", () => {
		const department = join(fixtureDir, "department-lead-rules.md");
		const founder = join(fixtureDir, "founder-only-authority.md");
		const bundle = join(fixtureDir, "stale-content-bundle.md");
		writeFileSync(department, "# FLY-162 Reply Discipline\n");
		writeFileSync(founder, "# Founder-only authority\n");
		const materialized = spawnSync(
			"bash",
			[
				"-c",
				[
					"set -euo pipefail",
					'source "$1"',
					"rules_bundle_reset",
					'rules_bundle_add "$2" base',
					'rules_bundle_add "$3" base',
					'rules_bundle_materialize "$4" dept tadashi flywheel',
				].join("; "),
				"_",
				MATERIALIZER,
				department,
				founder,
				bundle,
			],
			{ encoding: "utf8" },
		);
		expect(materialized.status, materialized.stderr).toBe(0);

		writeFileSync(department, "ATTACKER CONTENT: not the bundled governance\n");
		const result = spawnSync(
			"bash",
			[CHECKER, "--bundle-file", bundle, "--expect-role", "dept"],
			{ encoding: "utf8" },
		);
		expect(result.status).not.toBe(0);
		expect(result.stdout).toContain("source content mismatch at index 1");
	});

	it("rejects a self-consistent dept bundle when independent truth expects cos", () => {
		const department = join(fixtureDir, "department-lead-rules.md");
		const bundle = join(fixtureDir, "wrong-cass-arm.md");
		writeFileSync(department, "# FLY-162 Reply Discipline\n");
		const materialized = spawnSync(
			"bash",
			[
				"-c",
				[
					"set -euo pipefail",
					'source "$1"',
					"rules_bundle_reset",
					'rules_bundle_add "$2" base',
					'rules_bundle_materialize "$3" dept cass flywheel',
				].join("; "),
				"_",
				MATERIALIZER,
				department,
				bundle,
			],
			{ encoding: "utf8" },
		);
		expect(materialized.status, materialized.stderr).toBe(0);

		const result = spawnSync(
			"bash",
			[CHECKER, "--bundle-file", bundle, "--expect-role", "cos"],
			{ encoding: "utf8" },
		);
		expect(result.status).not.toBe(0);
		expect(result.stdout).toContain("FAIL");
		expect(result.stdout).toContain("role mismatch: header=dept expected=cos");
	});

	it("rejects bundle body tampering through an independent SHA calculation", () => {
		const department = join(fixtureDir, "department-lead-rules.md");
		const bundle = join(fixtureDir, "tampered.md");
		writeFileSync(department, "# FLY-162 Reply Discipline\n");
		const materialized = spawnSync(
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
				department,
				bundle,
			],
			{ encoding: "utf8" },
		);
		expect(materialized.status, materialized.stderr).toBe(0);
		appendFileSync(bundle, "TAMPERED\n");

		const result = spawnSync(
			"bash",
			[CHECKER, "--bundle-file", bundle, "--expect-role", "dept"],
			{ encoding: "utf8" },
		);
		expect(result.status).not.toBe(0);
		expect(result.stdout).toContain("bundle SHA mismatch");
	});

	it("rejects a FILES header that disagrees with the manifest and sections", () => {
		const department = join(fixtureDir, "department-lead-rules.md");
		const bundle = join(fixtureDir, "wrong-count.md");
		writeFileSync(department, "# FLY-162 Reply Discipline\n");
		const materialized = spawnSync(
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
				department,
				bundle,
			],
			{ encoding: "utf8" },
		);
		expect(materialized.status, materialized.stderr).toBe(0);
		writeFileSync(
			bundle,
			readFileSync(bundle, "utf8").replace("FILES=1", "FILES=2"),
		);

		const result = spawnSync(
			"bash",
			[CHECKER, "--bundle-file", bundle, "--expect-role", "dept"],
			{ encoding: "utf8" },
		);
		expect(result.status).not.toBe(0);
		expect(result.stdout).toContain(
			"file count mismatch: FILES=2 manifest=1 sections=1",
		);
	});

	it("pins the ps locale to C and returns PASS for the exact live bundle target", () => {
		const department = join(fixtureDir, "department-lead-rules.md");
		const bundle = join(fixtureDir, "live-dept-bundle.md");
		writeFileSync(department, "# FLY-162 Reply Discipline\n");
		const materialized = spawnSync(
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
				department,
				bundle,
			],
			{ encoding: "utf8" },
		);
		expect(materialized.status, materialized.stderr).toBe(0);
		const bundleText = readFileSync(bundle, "utf8");
		const sha = bundleText.match(/RULES_BUNDLE_SHA=([a-f0-9]{64})/)?.[1];
		expect(sha).toBeDefined();

		const stateDir = join(fixtureDir, "state");
		const manifestDir = join(fixtureDir, "manifests");
		const binDir = join(fixtureDir, "bin");
		mkdirSync(stateDir);
		mkdirSync(manifestDir);
		mkdirSync(binDir);
		writeFileSync(
			join(stateDir, "flywheel-tadashi.active.json"),
			JSON.stringify({
				mode: "bundle",
				bundlePath: bundle,
				pid: 4242,
				supervisorStart: "Tue Jul 21 08:00:00 2026",
				sha,
				role: "dept",
				generatedAt: "2026-07-21T15:00:00Z",
				selectedSources: [
					{
						label: "base",
						basename: "department-lead-rules.md",
						path: department,
					},
				],
				appendTargets: [bundle],
				files: 1,
			}),
		);
		writeFileSync(
			join(manifestDir, "flywheel-tadashi.json"),
			JSON.stringify({
				leadId: "tadashi",
				projectName: "flywheel",
				leadBackend: { backendId: "claude-code" },
			}),
		);
		writeFileSync(
			join(binDir, "tmux"),
			[
				"#!/bin/sh",
				'[ "$3" = "=flywheel:=flywheel-tadashi" ] || exit 9',
				"printf '5000\\t0\\n'",
				"",
			].join("\n"),
			{ mode: 0o755 },
		);
		writeFileSync(
			join(binDir, "ps"),
			[
				"#!/bin/sh",
				`[ "\${LC_ALL:-}" = "C" ] || exit 17`,
				'if [ "$1" = "-p" ]; then',
				"  printf 'Tue Jul 21 08:00:00 2026\\n'",
				"else",
				"  printf '5000 1 /bin/bash\\n'",
				`  printf '5001 5000 /usr/local/bin/claude --agent tadashi --append-system-prompt-file ${bundle}\\n'`,
				"fi",
				"",
			].join("\n"),
			{ mode: 0o755 },
		);

		const result = spawnSync(
			"bash",
			[
				CHECKER,
				"--lead",
				"tadashi",
				"--project",
				"flywheel",
				"--expect-role",
				"dept",
				"--expect-mode",
				"bundle",
				"--strict",
			],
			{
				encoding: "utf8",
				env: {
					...process.env,
					LC_ALL: "fr_FR.UTF-8",
					FLYWHEEL_RULES_TRUTH_STATE_DIR: stateDir,
					FLYWHEEL_RULES_TRUTH_MANIFEST_DIR: manifestDir,
					FLYWHEEL_RULES_TRUTH_TMUX: join(binDir, "tmux"),
					FLYWHEEL_RULES_TRUTH_PS: join(binDir, "ps"),
				},
			},
		);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toMatch(/^PASS .*mode=bundle .*role=dept/m);
	});

	it("rejects a bundle whose header Lead and project do not match the dynamic target", () => {
		const department = join(fixtureDir, "department-lead-rules.md");
		const bundle = join(fixtureDir, "wrong-identity-bundle.md");
		writeFileSync(department, "# FLY-162 Reply Discipline\n");
		const materialized = spawnSync(
			"bash",
			[
				"-c",
				[
					"set -euo pipefail",
					'source "$1"',
					"rules_bundle_reset",
					'rules_bundle_add "$2" base',
					'rules_bundle_materialize "$3" dept impostor other-project',
				].join("; "),
				"_",
				MATERIALIZER,
				department,
				bundle,
			],
			{ encoding: "utf8" },
		);
		expect(materialized.status, materialized.stderr).toBe(0);
		const sha = readFileSync(bundle, "utf8").match(
			/RULES_BUNDLE_SHA=([a-f0-9]{64})/,
		)?.[1];
		expect(sha).toBeDefined();
		const env = writeDynamicProbe({
			root: fixtureDir,
			project: "flywheel",
			lead: "tadashi",
			carrier: "claude-code",
			receipt: {
				mode: "bundle",
				bundlePath: bundle,
				pid: 4242,
				supervisorStart: "Tue Jul 21 08:00:00 2026",
				sha,
				role: "dept",
				generatedAt: "2026-07-21T15:00:00Z",
				selectedSources: [
					{
						label: "base",
						basename: "department-lead-rules.md",
						path: department,
					},
				],
				appendTargets: [bundle],
				files: 1,
			},
			processTree: [
				"5000 1 /bin/bash",
				`5001 5000 /usr/local/bin/claude --agent tadashi --append-system-prompt-file ${bundle}`,
			].join("\n"),
		});

		const result = spawnSync(
			"bash",
			[
				CHECKER,
				"--lead",
				"tadashi",
				"--project",
				"flywheel",
				"--expect-role",
				"dept",
				"--expect-mode",
				"bundle",
				"--strict",
			],
			{ encoding: "utf8", env },
		);
		expect(result.status).not.toBe(0);
		expect(result.stdout).toContain(
			"bundle identity mismatch: header=other-project/impostor expected=flywheel/tadashi",
		);
	});

	it("returns LEGACY_EXPECTED for an exact ordered dept legacy argv", () => {
		const department = join(fixtureDir, "department-lead-rules.md");
		const founder = join(fixtureDir, "founder-only-authority.md");
		writeFileSync(department, "dept\n");
		writeFileSync(founder, "founder\n");
		const selectedSources = [
			{
				label: "base",
				basename: "department-lead-rules.md",
				path: department,
			},
			{
				label: "base",
				basename: "founder-only-authority.md",
				path: founder,
			},
		];
		const env = writeDynamicProbe({
			root: fixtureDir,
			project: "flywheel",
			lead: "tadashi",
			carrier: "claude-code",
			receipt: {
				mode: "legacy",
				bundlePath: null,
				pid: 4242,
				supervisorStart: "Tue Jul 21 08:00:00 2026",
				generationNonce: null,
				sha: null,
				role: "dept",
				generatedAt: "2026-07-21T15:00:00Z",
				selectedSources,
				appendTargets: [department, founder],
				files: 2,
			},
			processTree: [
				"5000 1 /bin/bash",
				`5001 5000 /usr/local/bin/claude --agent tadashi --append-system-prompt-file ${department} --append-system-prompt-file ${founder}`,
			].join("\n"),
		});

		const result = spawnSync(
			"bash",
			[
				CHECKER,
				"--lead",
				"tadashi",
				"--project",
				"flywheel",
				"--expect-role",
				"dept",
				"--expect-mode",
				"legacy",
				"--strict",
			],
			{ encoding: "utf8", env },
		);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toMatch(
			/^LEGACY_EXPECTED .*mode=legacy .*role=dept/m,
		);
	});

	it("returns LEGACY_EXPECTED for a one-flag external legacy receipt", () => {
		const contract = join(fixtureDir, "external-agent-contract.md");
		writeFileSync(contract, "external\n");
		const env = writeDynamicProbe({
			root: fixtureDir,
			project: "customer",
			lead: "anna",
			receipt: {
				mode: "legacy",
				bundlePath: null,
				pid: 4242,
				supervisorStart: "Tue Jul 21 08:00:00 2026",
				generationNonce: null,
				sha: null,
				role: "external",
				generatedAt: "2026-07-21T15:00:00Z",
				selectedSources: [
					{
						label: "base",
						basename: "external-agent-contract.md",
						path: contract,
					},
				],
				appendTargets: [contract],
				files: 1,
			},
			processTree: [
				"5000 1 /bin/bash",
				`5001 5000 /usr/local/bin/claude --agent anna --append-system-prompt-file ${contract}`,
			].join("\n"),
		});
		const result = spawnSync(
			"bash",
			[
				CHECKER,
				"--lead",
				"anna",
				"--project",
				"customer",
				"--expect-role",
				"external",
				"--expect-mode",
				"legacy",
				"--strict",
			],
			{ encoding: "utf8", env },
		);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toMatch(
			/^LEGACY_EXPECTED .*mode=legacy .*role=external/m,
		);
		expect(result.stdout).toContain("carrier=defaulted");
	});

	it("reports nonce generations as DEGRADED and fails them only in strict mode", () => {
		const contract = join(fixtureDir, "external-agent-contract.md");
		writeFileSync(contract, "external\n");
		const env = writeDynamicProbe({
			root: fixtureDir,
			project: "customer",
			lead: "anna",
			carrier: "claude-code",
			receipt: {
				mode: "legacy",
				bundlePath: null,
				pid: 4242,
				supervisorStart: null,
				generationNonce: "f09a1b2c",
				sha: null,
				role: "external",
				generatedAt: "2026-07-21T15:00:00Z",
				selectedSources: [
					{
						label: "base",
						basename: "external-agent-contract.md",
						path: contract,
					},
				],
				appendTargets: [contract],
				files: 1,
			},
			processTree: "",
		});
		const baseArgs = [
			CHECKER,
			"--lead",
			"anna",
			"--project",
			"customer",
			"--expect-role",
			"external",
			"--expect-mode",
			"legacy",
		];
		const diagnostic = spawnSync("bash", baseArgs, { encoding: "utf8", env });
		expect(diagnostic.status, diagnostic.stderr).toBe(0);
		expect(diagnostic.stdout).toMatch(/^DEGRADED /m);

		const strict = spawnSync("bash", [...baseArgs, "--strict"], {
			encoding: "utf8",
			env,
		});
		expect(strict.status).not.toBe(0);
		expect(strict.stdout).toMatch(/^DEGRADED /m);
	});

	it.each([
		{
			name: "pid reuse",
			expected: "STALE",
			lstart: "Tue Jul 21 09:00:00 2026",
			tmuxOutput: "5000\\t0\\n",
			processTree:
				"5000 1 /bin/bash\n5001 5000 /usr/local/bin/claude --agent anna --append-system-prompt-file TARGET",
		},
		{
			name: "dead pane",
			expected: "STATIC_ONLY",
			lstart: "Tue Jul 21 08:00:00 2026",
			tmuxOutput: "5000\\t1\\n",
			processTree: "",
		},
		{
			name: "no claude descendant",
			expected: "STATIC_ONLY",
			lstart: "Tue Jul 21 08:00:00 2026",
			tmuxOutput: "5000\\t0\\n",
			processTree: "5000 1 /bin/bash\n5001 5000 /usr/bin/sleep 30",
		},
		{
			name: "multiple claude descendants",
			expected: "STATIC_ONLY",
			lstart: "Tue Jul 21 08:00:00 2026",
			tmuxOutput: "5000\\t0\\n",
			processTree:
				"5000 1 /bin/bash\n5001 5000 /usr/local/bin/claude --agent anna\n5002 5000 /usr/local/bin/claude --agent anna",
		},
		{
			name: "wrong agent",
			expected: "STATIC_ONLY",
			lstart: "Tue Jul 21 08:00:00 2026",
			tmuxOutput: "5000\\t0\\n",
			processTree:
				"5000 1 /bin/bash\n5001 5000 /usr/local/bin/claude --agent simba",
		},
	])("classifies $name without claiming dynamic truth", (probe) => {
		const caseRoot = join(fixtureDir, probe.name.replaceAll(" ", "-"));
		mkdirSync(caseRoot);
		const contract = join(caseRoot, "external-agent-contract.md");
		writeFileSync(contract, "external\n");
		const processTree = probe.processTree.replaceAll("TARGET", contract);
		const env = writeDynamicProbe({
			root: caseRoot,
			project: "customer",
			lead: "anna",
			carrier: "claude-code",
			lstart: probe.lstart,
			tmuxOutput: probe.tmuxOutput,
			receipt: {
				mode: "legacy",
				bundlePath: null,
				pid: 4242,
				supervisorStart: "Tue Jul 21 08:00:00 2026",
				generationNonce: null,
				sha: null,
				role: "external",
				generatedAt: "2026-07-21T15:00:00Z",
				selectedSources: [
					{
						label: "base",
						basename: "external-agent-contract.md",
						path: contract,
					},
				],
				appendTargets: [contract],
				files: 1,
			},
			processTree,
		});
		const baseArgs = [
			CHECKER,
			"--lead",
			"anna",
			"--project",
			"customer",
			"--expect-role",
			"external",
			"--expect-mode",
			"legacy",
		];
		const diagnostic = spawnSync("bash", baseArgs, { encoding: "utf8", env });
		expect(diagnostic.status, diagnostic.stderr).toBe(0);
		expect(diagnostic.stdout).toMatch(new RegExp(`^${probe.expected} `, "m"));
		const strict = spawnSync("bash", [...baseArgs, "--strict"], {
			encoding: "utf8",
			env,
		});
		expect(strict.status).not.toBe(0);
		expect(strict.stdout).toMatch(new RegExp(`^${probe.expected} `, "m"));
	});

	it("reports spaced append targets as AMBIGUOUS instead of claiming exact argv", () => {
		const spacedDir = join(fixtureDir, "rules with spaces");
		mkdirSync(spacedDir);
		const contract = join(spacedDir, "external-agent-contract.md");
		writeFileSync(contract, "external\n");
		const env = writeDynamicProbe({
			root: fixtureDir,
			project: "customer",
			lead: "anna",
			carrier: "claude-code",
			receipt: {
				mode: "legacy",
				bundlePath: null,
				pid: 4242,
				supervisorStart: "Tue Jul 21 08:00:00 2026",
				generationNonce: null,
				sha: null,
				role: "external",
				generatedAt: "2026-07-21T15:00:00Z",
				selectedSources: [
					{
						label: "base",
						basename: "external-agent-contract.md",
						path: contract,
					},
				],
				appendTargets: [contract],
				files: 1,
			},
			processTree: `5000 1 /bin/bash\n5001 5000 /usr/local/bin/claude --agent anna --append-system-prompt-file ${contract}`,
		});
		const args = [
			CHECKER,
			"--lead",
			"anna",
			"--project",
			"customer",
			"--expect-role",
			"external",
			"--expect-mode",
			"legacy",
		];
		const diagnostic = spawnSync("bash", args, { encoding: "utf8", env });
		expect(diagnostic.status, diagnostic.stderr).toBe(0);
		expect(diagnostic.stdout).toMatch(/^AMBIGUOUS /m);
		const strict = spawnSync("bash", [...args, "--strict"], {
			encoding: "utf8",
			env,
		});
		expect(strict.status).not.toBe(0);
		expect(strict.stdout).toMatch(/^AMBIGUOUS /m);
	});

	it("fails when legacy live argv reorders the receipt append targets", () => {
		const department = join(fixtureDir, "department-lead-rules.md");
		const founder = join(fixtureDir, "founder-only-authority.md");
		writeFileSync(department, "dept\n");
		writeFileSync(founder, "founder\n");
		const selectedSources = [
			{
				label: "base",
				basename: "department-lead-rules.md",
				path: department,
			},
			{
				label: "base",
				basename: "founder-only-authority.md",
				path: founder,
			},
		];
		const env = writeDynamicProbe({
			root: fixtureDir,
			project: "flywheel",
			lead: "tadashi",
			carrier: "claude-code",
			receipt: {
				mode: "legacy",
				bundlePath: null,
				pid: 4242,
				supervisorStart: "Tue Jul 21 08:00:00 2026",
				generationNonce: null,
				sha: null,
				role: "dept",
				generatedAt: "2026-07-21T15:00:00Z",
				selectedSources,
				appendTargets: [department, founder],
				files: 2,
			},
			processTree: [
				"5000 1 /bin/bash",
				`5001 5000 /usr/local/bin/claude --agent tadashi --append-system-prompt-file ${founder} --append-system-prompt-file ${department}`,
			].join("\n"),
		});
		const result = spawnSync(
			"bash",
			[
				CHECKER,
				"--lead",
				"tadashi",
				"--project",
				"flywheel",
				"--expect-role",
				"dept",
				"--expect-mode",
				"legacy",
			],
			{ encoding: "utf8", env },
		);
		expect(result.status).not.toBe(0);
		expect(result.stdout).toContain("live appendTargets mismatch");
	});

	it("fails bundle mode when live argv is repeated, legacy-shaped, or wrong", () => {
		const department = join(fixtureDir, "department-lead-rules.md");
		const bundle = join(fixtureDir, "exact-bundle.md");
		writeFileSync(department, "dept\n");
		const materialized = spawnSync(
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
				department,
				bundle,
			],
			{ encoding: "utf8" },
		);
		expect(materialized.status, materialized.stderr).toBe(0);
		const sha = readFileSync(bundle, "utf8").match(
			/RULES_BUNDLE_SHA=([a-f0-9]{64})/,
		)?.[1];
		expect(sha).toBeDefined();
		const cases = [
			{ name: "repeated", targets: [bundle, bundle] },
			{ name: "legacy-shaped", targets: [department] },
			{ name: "wrong", targets: [`${bundle}.other`] },
		];
		for (const testCase of cases) {
			const caseRoot = join(fixtureDir, `bundle-${testCase.name}`);
			mkdirSync(caseRoot);
			const flags = testCase.targets
				.map((target) => `--append-system-prompt-file ${target}`)
				.join(" ");
			const env = writeDynamicProbe({
				root: caseRoot,
				project: "flywheel",
				lead: "tadashi",
				carrier: "claude-code",
				receipt: {
					mode: "bundle",
					bundlePath: bundle,
					pid: 4242,
					supervisorStart: "Tue Jul 21 08:00:00 2026",
					generationNonce: null,
					sha,
					role: "dept",
					generatedAt: "2026-07-21T15:00:00Z",
					selectedSources: [
						{
							label: "base",
							basename: "department-lead-rules.md",
							path: department,
						},
					],
					appendTargets: [bundle],
					files: 1,
				},
				processTree: `5000 1 /bin/bash\n5001 5000 /usr/local/bin/claude --agent tadashi ${flags}`,
			});
			const result = spawnSync(
				"bash",
				[
					CHECKER,
					"--lead",
					"tadashi",
					"--project",
					"flywheel",
					"--expect-role",
					"dept",
					"--expect-mode",
					"bundle",
				],
				{ encoding: "utf8", env },
			);
			expect(result.status, `${testCase.name}: ${result.stdout}`).not.toBe(0);
			expect(result.stdout).toContain("live appendTargets mismatch");
		}
	});

	it("derives Cass as cos independently and rejects a self-consistent dept receipt", () => {
		const department = join(fixtureDir, "department-lead-rules.md");
		const bundle = join(fixtureDir, "cass-wrong-arm.md");
		writeFileSync(department, "dept\n");
		const materialized = spawnSync(
			"bash",
			[
				"-c",
				[
					"set -euo pipefail",
					'source "$1"',
					"rules_bundle_reset",
					'rules_bundle_add "$2" base',
					'rules_bundle_materialize "$3" dept cass flywheel',
				].join("; "),
				"_",
				MATERIALIZER,
				department,
				bundle,
			],
			{ encoding: "utf8" },
		);
		expect(materialized.status, materialized.stderr).toBe(0);
		const sha = readFileSync(bundle, "utf8").match(
			/RULES_BUNDLE_SHA=([a-f0-9]{64})/,
		)?.[1];
		const env = writeDynamicProbe({
			root: fixtureDir,
			project: "flywheel",
			lead: "cass",
			carrier: "claude-code",
			receipt: {
				mode: "bundle",
				bundlePath: bundle,
				pid: 4242,
				supervisorStart: "Tue Jul 21 08:00:00 2026",
				generationNonce: null,
				sha,
				role: "dept",
				generatedAt: "2026-07-21T15:00:00Z",
				selectedSources: [
					{
						label: "base",
						basename: "department-lead-rules.md",
						path: department,
					},
				],
				appendTargets: [bundle],
				files: 1,
			},
			processTree: "",
		});
		const gateCli = join(fixtureDir, "core-room-gate-cli.mjs");
		writeFileSync(
			gateCli,
			`process.stdout.write(JSON.stringify({projectName:"flywheel",leadId:"cass",isCoS:true,gateNonCoS:false,backend:"claude-code"})+"\\n");\n`,
		);
		env.FLYWHEEL_RULES_TRUTH_GATE_CLI = gateCli;
		env.FLYWHEEL_PROJECTS = JSON.stringify([
			{
				projectName: "flywheel",
				leads: [{ agentId: "cass" }],
			},
		]);

		const result = spawnSync(
			"bash",
			[
				CHECKER,
				"--lead",
				"cass",
				"--project",
				"flywheel",
				"--expect-mode",
				"bundle",
			],
			{ encoding: "utf8", env },
		);
		expect(result.status).not.toBe(0);
		expect(result.stdout).toContain(
			"receipt role mismatch: receipt=dept expected=cos",
		);
	});

	it("mirrors wrapper carrier truth for codex, unknown, and missing manifests", () => {
		const baseArgs = [
			CHECKER,
			"--lead",
			"anna",
			"--project",
			"customer",
			"--expect-role",
			"external",
		];

		const codexRoot = join(fixtureDir, "carrier-codex");
		mkdirSync(codexRoot);
		const codexEnv = writeDynamicProbe({
			root: codexRoot,
			project: "customer",
			lead: "anna",
			carrier: "codex-app-server",
			receipt: {},
			processTree: "",
		});
		const codex = spawnSync("bash", [...baseArgs, "--strict"], {
			encoding: "utf8",
			env: codexEnv,
		});
		expect(codex.status, codex.stderr).toBe(0);
		expect(codex.stdout).toMatch(/^SKIP .*carrier=codex-app-server/m);

		const unknownRoot = join(fixtureDir, "carrier-unknown");
		mkdirSync(unknownRoot);
		const unknownEnv = writeDynamicProbe({
			root: unknownRoot,
			project: "customer",
			lead: "anna",
			carrier: "gemini-cli",
			receipt: {},
			processTree: "",
		});
		const unknown = spawnSync("bash", baseArgs, {
			encoding: "utf8",
			env: unknownEnv,
		});
		expect(unknown.status).not.toBe(0);
		expect(unknown.stdout).toContain("unknown lead carrier: gemini-cli");

		const missingRoot = join(fixtureDir, "carrier-missing");
		mkdirSync(missingRoot);
		const missingEnv = writeDynamicProbe({
			root: missingRoot,
			project: "customer",
			lead: "anna",
			carrier: "claude-code",
			receipt: {},
			processTree: "",
		});
		rmSync(
			join(
				missingEnv.FLYWHEEL_RULES_TRUTH_MANIFEST_DIR as string,
				"customer-anna.json",
			),
		);
		const missing = spawnSync("bash", baseArgs, {
			encoding: "utf8",
			env: missingEnv,
		});
		expect(missing.status).not.toBe(0);
		expect(missing.stdout).toContain("lead manifest unreadable or invalid");
	});

	it("derives expected legacy mode from the wave inventory", () => {
		const contract = join(fixtureDir, "external-agent-contract.md");
		const inventory = join(fixtureDir, "wave-inventory.json");
		writeFileSync(contract, "external\n");
		writeFileSync(
			inventory,
			JSON.stringify([{ project: "customer", leadId: "anna", mode: "legacy" }]),
		);
		const env = writeDynamicProbe({
			root: fixtureDir,
			project: "customer",
			lead: "anna",
			carrier: "claude-code",
			receipt: {
				mode: "legacy",
				bundlePath: null,
				pid: 4242,
				supervisorStart: "Tue Jul 21 08:00:00 2026",
				generationNonce: null,
				sha: null,
				role: "external",
				generatedAt: "2026-07-21T15:00:00Z",
				selectedSources: [
					{
						label: "base",
						basename: "external-agent-contract.md",
						path: contract,
					},
				],
				appendTargets: [contract],
				files: 1,
			},
			processTree: `5000 1 /bin/bash\n5001 5000 /usr/local/bin/claude --agent anna --append-system-prompt-file ${contract}`,
		});
		const result = spawnSync(
			"bash",
			[
				CHECKER,
				"--lead",
				"anna",
				"--project",
				"customer",
				"--expect-role",
				"external",
				"--expected",
				inventory,
				"--strict",
			],
			{ encoding: "utf8", env },
		);
		expect(result.status, result.stdout).toBe(0);
		expect(result.stdout).toMatch(/^LEGACY_EXPECTED .*mode=legacy/m);
	});

	it("checks the full roster with strict mode-aware outcomes and carrier skips", () => {
		const stateDir = join(fixtureDir, "fleet-state");
		const manifestDir = join(fixtureDir, "fleet-manifests");
		const binDir = join(fixtureDir, "fleet-bin");
		mkdirSync(stateDir);
		mkdirSync(manifestDir);
		mkdirSync(binDir);
		const contract = join(fixtureDir, "external-agent-contract.md");
		const inventory = join(fixtureDir, "fleet-wave.json");
		writeFileSync(contract, "external\n");
		writeFileSync(
			join(stateDir, "customer-anna.active.json"),
			JSON.stringify({
				mode: "legacy",
				bundlePath: null,
				pid: 4242,
				supervisorStart: "Tue Jul 21 08:00:00 2026",
				generationNonce: null,
				sha: null,
				role: "external",
				generatedAt: "2026-07-21T15:00:00Z",
				selectedSources: [
					{
						label: "base",
						basename: "external-agent-contract.md",
						path: contract,
					},
				],
				appendTargets: [contract],
				files: 1,
			}),
		);
		writeFileSync(
			join(manifestDir, "customer-anna.json"),
			JSON.stringify({ leadBackend: { backendId: "claude-code" } }),
		);
		writeFileSync(
			join(manifestDir, "tools-cody.json"),
			JSON.stringify({ leadBackend: { backendId: "codex-app-server" } }),
		);
		writeFileSync(
			inventory,
			JSON.stringify([{ project: "customer", leadId: "anna", mode: "legacy" }]),
		);
		writeFileSync(join(binDir, "tmux"), "#!/bin/sh\nprintf '5000\\t0\\n'\n", {
			mode: 0o755,
		});
		writeFileSync(
			join(binDir, "ps"),
			[
				"#!/bin/sh",
				'if [ "$1" = "-p" ]; then',
				"  printf 'Tue Jul 21 08:00:00 2026\\n'",
				"else",
				"  printf '5000 1 /bin/bash\\n'",
				`  printf '5001 5000 /usr/local/bin/claude --agent anna --append-system-prompt-file ${contract}\\n'`,
				"fi",
				"",
			].join("\n"),
			{ mode: 0o755 },
		);
		const gateCli = join(fixtureDir, "fleet-gate-cli.mjs");
		writeFileSync(
			gateCli,
			[
				'process.stdout.write(JSON.stringify({projectName:"customer",leadId:"anna",isCoS:false,gateNonCoS:false,backend:"claude-code"})+"\\n");',
				'process.stdout.write(JSON.stringify({projectName:"tools",leadId:"cody",isCoS:false,gateNonCoS:false,backend:"codex-app-server"})+"\\n");',
				"",
			].join("\n"),
		);

		const result = spawnSync(
			"bash",
			[CHECKER, "--all", "--expected", inventory, "--strict"],
			{
				encoding: "utf8",
				env: {
					...process.env,
					FLYWHEEL_RULES_TRUTH_STATE_DIR: stateDir,
					FLYWHEEL_RULES_TRUTH_MANIFEST_DIR: manifestDir,
					FLYWHEEL_RULES_TRUTH_TMUX: join(binDir, "tmux"),
					FLYWHEEL_RULES_TRUTH_PS: join(binDir, "ps"),
					FLYWHEEL_RULES_TRUTH_GATE_CLI: gateCli,
					FLYWHEEL_PROJECTS: JSON.stringify([
						{
							projectName: "customer",
							leads: [
								{
									agentId: "anna",
									external: true,
									canSpawnRunners: false,
								},
							],
						},
						{
							projectName: "tools",
							leads: [{ agentId: "cody" }],
						},
					]),
				},
			},
		);
		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(result.stdout).toMatch(
			/^LEGACY_EXPECTED project=customer lead=anna .*role=external/m,
		);
		expect(result.stdout).toMatch(
			/^SKIP project=tools lead=cody carrier=codex-app-server/m,
		);
	});

	it("rejects a receipt selectedSources path that disagrees with the bundle manifest", () => {
		const department = join(fixtureDir, "department-lead-rules.md");
		const claimedDir = join(fixtureDir, "claimed");
		const bundle = join(fixtureDir, "manifest-claim.md");
		mkdirSync(claimedDir);
		writeFileSync(department, "dept\n");
		const materialized = spawnSync(
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
				department,
				bundle,
			],
			{ encoding: "utf8" },
		);
		expect(materialized.status, materialized.stderr).toBe(0);
		const sha = readFileSync(bundle, "utf8").match(
			/RULES_BUNDLE_SHA=([a-f0-9]{64})/,
		)?.[1];
		const env = writeDynamicProbe({
			root: fixtureDir,
			project: "flywheel",
			lead: "tadashi",
			carrier: "claude-code",
			receipt: {
				mode: "bundle",
				bundlePath: bundle,
				pid: 4242,
				supervisorStart: "Tue Jul 21 08:00:00 2026",
				generationNonce: null,
				sha,
				role: "dept",
				generatedAt: "2026-07-21T15:00:00Z",
				selectedSources: [
					{
						label: "base",
						basename: "department-lead-rules.md",
						path: join(claimedDir, "department-lead-rules.md"),
					},
				],
				appendTargets: [bundle],
				files: 1,
			},
			processTree: "",
		});
		const result = spawnSync(
			"bash",
			[
				CHECKER,
				"--lead",
				"tadashi",
				"--project",
				"flywheel",
				"--expect-role",
				"dept",
			],
			{ encoding: "utf8", env },
		);
		expect(result.status).not.toBe(0);
		expect(result.stdout).toContain(
			"receipt/header manifest mismatch at index 1",
		);
	});

	it("reports SHA-unavailable bundles as DEGRADED and never PASS", () => {
		const department = join(fixtureDir, "department-lead-rules.md");
		const bundle = join(fixtureDir, "sha-unavailable.md");
		writeFileSync(department, "dept\n");
		const materialized = spawnSync(
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
				department,
				bundle,
			],
			{ encoding: "utf8" },
		);
		expect(materialized.status, materialized.stderr).toBe(0);
		writeFileSync(
			bundle,
			readFileSync(bundle, "utf8").replace(
				/RULES_BUNDLE_SHA=[a-f0-9]{64}/,
				"RULES_BUNDLE_SHA=unavailable",
			),
		);
		const args = [CHECKER, "--bundle-file", bundle, "--expect-role", "dept"];
		const diagnostic = spawnSync("bash", args, { encoding: "utf8" });
		expect(diagnostic.status, diagnostic.stderr).toBe(0);
		expect(diagnostic.stdout).toMatch(/^DEGRADED /m);
		const strict = spawnSync("bash", [...args, "--strict"], {
			encoding: "utf8",
		});
		expect(strict.status).not.toBe(0);
		expect(strict.stdout).toMatch(/^DEGRADED /m);
	});

	it("rejects a forged selectedSources basename on the legacy path", () => {
		const wrong = join(fixtureDir, "wrong.md");
		writeFileSync(wrong, "not the external contract\n");
		const env = writeDynamicProbe({
			root: fixtureDir,
			project: "customer",
			lead: "anna",
			carrier: "claude-code",
			receipt: {
				mode: "legacy",
				bundlePath: null,
				pid: 4242,
				supervisorStart: "Tue Jul 21 08:00:00 2026",
				generationNonce: null,
				sha: null,
				role: "external",
				generatedAt: "2026-07-21T15:00:00Z",
				selectedSources: [
					{
						label: "base",
						basename: "external-agent-contract.md",
						path: wrong,
					},
				],
				appendTargets: [wrong],
				files: 1,
			},
			processTree: `5000 1 /bin/bash\n5001 5000 /usr/local/bin/claude --agent anna --append-system-prompt-file ${wrong}`,
		});
		const result = spawnSync(
			"bash",
			[
				CHECKER,
				"--lead",
				"anna",
				"--project",
				"customer",
				"--expect-role",
				"external",
				"--expect-mode",
				"legacy",
			],
			{ encoding: "utf8", env },
		);
		expect(result.status).not.toBe(0);
		expect(result.stdout).toContain("selectedSources basename/path mismatch");
	});
});
