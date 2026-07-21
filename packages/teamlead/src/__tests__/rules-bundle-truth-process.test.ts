import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CHECKER = join(__dirname, "..", "..", "scripts", "check-rules-truth.sh");

describe("check-rules-truth real process argv boundary", () => {
	let fixtureDir: string;
	const children: ChildProcess[] = [];

	beforeEach(() => {
		fixtureDir = mkdtempSync(join(tmpdir(), "fly1402-real-argv-"));
	});

	afterEach(() => {
		for (const child of children) child.kill("SIGTERM");
		rmSync(fixtureDir, { recursive: true, force: true });
	});

	async function startClaude(
		lead: string,
		targets: string[],
	): Promise<ChildProcess> {
		const executable = join(fixtureDir, `claude-${lead}`, "claude");
		mkdirSync(join(fixtureDir, `claude-${lead}`));
		symlinkSync(process.execPath, executable);
		const args = ["-e", "setInterval(() => {}, 1000)", "--", "--agent", lead];
		for (const target of targets) {
			args.push("--append-system-prompt-file", target);
		}
		const child = spawn(executable, args, { stdio: "ignore" });
		children.push(child);
		await new Promise<void>((resolve, reject) => {
			child.once("spawn", resolve);
			child.once("error", reject);
		});
		await new Promise((resolve) => setTimeout(resolve, 100));
		return child;
	}

	function runAgainstProcess(options: {
		caseName: string;
		project: string;
		lead: string;
		role: "dept" | "external";
		child: ChildProcess;
		targets: string[];
		basenames: string[];
		strict?: boolean;
	}) {
		const pid = options.child.pid;
		expect(pid).toBeTypeOf("number");
		const startProbe = spawnSync(
			"/bin/ps",
			["-p", String(pid), "-o", "lstart="],
			{
				encoding: "utf8",
			},
		);
		expect(
			startProbe.status,
			String(startProbe.error ?? startProbe.stderr),
		).toBe(0);
		const lstart = startProbe.stdout.trim();
		expect(lstart).not.toBe("");
		const root = join(fixtureDir, options.caseName);
		const stateDir = join(root, "state");
		const manifestDir = join(root, "manifests");
		const binDir = join(root, "bin");
		mkdirSync(stateDir, { recursive: true });
		mkdirSync(manifestDir);
		mkdirSync(binDir);
		writeFileSync(
			join(stateDir, `${options.project}-${options.lead}.active.json`),
			JSON.stringify({
				mode: "legacy",
				bundlePath: null,
				pid,
				supervisorStart: lstart,
				generationNonce: null,
				sha: null,
				role: options.role,
				generatedAt: "2026-07-21T15:00:00Z",
				selectedSources: options.targets.map((path, index) => ({
					label: "base",
					basename: options.basenames[index],
					path,
				})),
				appendTargets: options.targets,
				files: options.targets.length,
			}),
		);
		writeFileSync(
			join(manifestDir, `${options.project}-${options.lead}.json`),
			JSON.stringify({ leadBackend: { backendId: "claude-code" } }),
		);
		writeFileSync(join(binDir, "tmux"), `#!/bin/sh\nprintf '${pid}\\t0\\n'\n`, {
			mode: 0o755,
		});
		const args = [
			CHECKER,
			"--lead",
			options.lead,
			"--project",
			options.project,
			"--expect-role",
			options.role,
			"--expect-mode",
			"legacy",
		];
		if (options.strict) args.push("--strict");
		return spawnSync("bash", args, {
			encoding: "utf8",
			env: {
				...process.env,
				FLYWHEEL_RULES_TRUTH_STATE_DIR: stateDir,
				FLYWHEEL_RULES_TRUTH_MANIFEST_DIR: manifestDir,
				FLYWHEEL_RULES_TRUTH_TMUX: join(binDir, "tmux"),
				FLYWHEEL_RULES_TRUTH_PS: "/bin/ps",
			},
		});
	}

	it("proves similar-prefix targets exactly and refuses spaced targets", async (context) => {
		const psPreflight = spawnSync(
			"/bin/ps",
			["-p", String(process.pid), "-o", "lstart="],
			{ encoding: "utf8" },
		);
		if (
			(psPreflight.error as NodeJS.ErrnoException | undefined)?.code === "EPERM"
		) {
			context.skip("managed sandbox denies /bin/ps process inspection");
			return;
		}
		expect(
			psPreflight.status,
			String(psPreflight.error ?? psPreflight.stderr),
		).toBe(0);
		const rulesDir = join(fixtureDir, "rules");
		mkdirSync(rulesDir);
		const first = join(rulesDir, "department-lead-rules.md");
		const prefixed = `${first}-extra`;
		writeFileSync(first, "dept\n");
		writeFileSync(prefixed, "extra\n");
		const tadashi = await startClaude("tadashi", [first, prefixed]);
		const exact = runAgainstProcess({
			caseName: "exact",
			project: "flywheel",
			lead: "tadashi",
			role: "dept",
			child: tadashi,
			targets: [first, prefixed],
			basenames: ["department-lead-rules.md", "department-lead-rules.md-extra"],
			strict: true,
		});
		expect(exact.status, `${exact.stdout}\n${exact.stderr}`).toBe(0);
		expect(exact.stdout).toMatch(/^LEGACY_EXPECTED /m);

		const spacedDir = join(fixtureDir, "rules with spaces");
		mkdirSync(spacedDir);
		const spaced = join(spacedDir, "external-agent-contract.md");
		writeFileSync(spaced, "external\n");
		const anna = await startClaude("anna", [spaced]);
		const ambiguous = runAgainstProcess({
			caseName: "ambiguous",
			project: "customer",
			lead: "anna",
			role: "external",
			child: anna,
			targets: [spaced],
			basenames: ["external-agent-contract.md"],
		});
		expect(ambiguous.status, ambiguous.stderr).toBe(0);
		expect(ambiguous.stdout).toMatch(/^AMBIGUOUS /m);
	});
});
