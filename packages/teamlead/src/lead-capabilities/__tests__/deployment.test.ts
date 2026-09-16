import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import {
	LEAD_DEPLOYMENT_ENTRIES,
	recordLeadDeployment,
	verifyLeadDeployment,
} from "../deployment.js";

it("binds actual checkout HEAD to deployed-sha and hashes fixed dist entries", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "lead-deploy-")));
	try {
		const git = (args: string[]) =>
			execFileSync("/usr/bin/git", ["-C", root, ...args], {
				encoding: "utf8",
				env: { PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1" },
			}).trim();
		git(["init", "-q"]);
		git([
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.invalid",
			"commit",
			"--allow-empty",
			"-qm",
			"fixture",
		]);
		const sha = git(["rev-parse", "HEAD"]),
			deployedShaPath = join(root, "deployed-sha");
		writeFileSync(deployedShaPath, `${sha}\n`);
		for (const entry of LEAD_DEPLOYMENT_ENTRIES) {
			const file = join(root, "packages/teamlead/dist", entry);
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, "export {};\n");
		}
		vi.stubEnv("GIT_DIR", join(root, "nonexistent-git"));
		const receipt = verifyLeadDeployment({
			checkoutRoot: root,
			deployedShaPath,
		});
		expect(receipt.headSha).toBe(sha);
		expect(Object.keys(receipt.entrySha256)).toEqual([
			...LEAD_DEPLOYMENT_ENTRIES,
		]);
		for (const digest of Object.values(receipt.entrySha256))
			expect(digest).toMatch(/^[a-f0-9]{64}$/);
		const stateDir = join(root, "state");
		mkdirSync(stateDir, { mode: 0o700 });
		const recorded = recordLeadDeployment({
			checkoutRoot: root,
			deployedShaPath,
			stateDir,
		});
		expect(
			JSON.parse(
				readFileSync(join(stateDir, "capability-deployment.json"), "utf8"),
			),
		).toEqual(recorded);
		const file = join(
			root,
			"packages/teamlead/dist",
			LEAD_DEPLOYMENT_ENTRIES[0]!,
		);
		chmodSync(file, 0o666);
		expect(() =>
			verifyLeadDeployment({ checkoutRoot: root, deployedShaPath }),
		).toThrow("lead_deployment_unverified");
		chmodSync(file, 0o644);
		unlinkSync(file);
		expect(() =>
			verifyLeadDeployment({ checkoutRoot: root, deployedShaPath }),
		).toThrow("lead_deployment_unverified");
		symlinkSync(deployedShaPath, file);
		expect(() =>
			verifyLeadDeployment({ checkoutRoot: root, deployedShaPath }),
		).toThrow("lead_deployment_unverified");
		unlinkSync(file);
		writeFileSync(file, "export {};\n");
		writeFileSync(deployedShaPath, "0".repeat(40));
		expect(() =>
			verifyLeadDeployment({ checkoutRoot: root, deployedShaPath }),
		).toThrow("lead_deployment_unverified");
		expect(() =>
			recordLeadDeployment({ checkoutRoot: root, deployedShaPath, stateDir }),
		).toThrow();
		expect(
			JSON.parse(
				readFileSync(join(stateDir, "capability-deployment.json"), "utf8"),
			),
		).toEqual(recorded);
	} finally {
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	}
});

it("runs the compiled preflight CLI with read-only dry run and durable normal receipt", async () => {
	const { spawnSync } = await import("node:child_process");
	const { existsSync } = await import("node:fs");
	const ts = await import("typescript");
	const root = realpathSync(mkdtempSync(join(tmpdir(), "lead-cli-")));
	try {
		const git = (args: string[]) =>
			execFileSync("/usr/bin/git", ["-C", root, ...args], {
				encoding: "utf8",
				env: { HOME: root, PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1" },
			}).trim();
		git(["init", "-q"]);
		git([
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.invalid",
			"commit",
			"--allow-empty",
			"-qm",
			"fixture",
		]);
		mkdirSync(join(root, ".flywheel"));
		mkdirSync(join(root, "state"), { mode: 0o700 });
		const deployedShaPath = join(root, ".flywheel/deployed-sha");
		writeFileSync(deployedShaPath, git(["rev-parse", "HEAD"]));
		writeFileSync(join(root, "package.json"), '{"type":"module"}');
		for (const entry of LEAD_DEPLOYMENT_ENTRIES) {
			const target = join(root, "packages/teamlead/dist", entry);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, "export {};\n");
		}
		for (const [source, entry] of [
			[join(__dirname, "../deployment.ts"), "lead-capabilities/deployment.js"],
			[
				join(__dirname, "../../bin/verify-codex-deployment.ts"),
				"bin/verify-codex-deployment.js",
			],
		]) {
			const output = ts.transpileModule(readFileSync(source!, "utf8"), {
				compilerOptions: {
					target: ts.ScriptTarget.ES2022,
					module: ts.ModuleKind.ES2022,
				},
			}).outputText;
			writeFileSync(join(root, "packages/teamlead/dist", entry!), output);
		}
		const cli = join(
				root,
				"packages/teamlead/dist/bin/verify-codex-deployment.js",
			),
			receipt = join(root, "state/capability-deployment.json");
		const run = (dry: string) =>
			spawnSync(process.execPath, [cli], {
				encoding: "utf8",
				env: {
					PATH: "/usr/bin:/bin",
					HOME: root,
					FLYWHEEL_CODEX_LEAD_STATE_DIR: join(root, "state"),
					FLYWHEEL_LEAD_DRY_RUN: dry,
				},
			});
		expect(run("1").status).toBe(0);
		expect(existsSync(receipt)).toBe(false);
		expect(run("0").status).toBe(0);
		const prior = readFileSync(receipt, "utf8");
		expect(
			JSON.parse(prior).entrySha256["bin/verify-codex-deployment.js"],
		).toMatch(/^[a-f0-9]{64}$/);
		writeFileSync(deployedShaPath, "0".repeat(40));
		const rejected = run("0");
		expect(rejected.status).toBe(78);
		expect(rejected.stderr).toContain("lead_deployment_unverified");
		expect(readFileSync(receipt, "utf8")).toBe(prior);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("executes deployment preflight through a symlinked entry path", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "deployment-symlink-")));
	try {
		const alias = join(root, "verify.ts");
		symlinkSync(
			new URL("../../bin/verify-codex-deployment.ts", import.meta.url),
			alias,
		);
		const result = spawnSync(
			process.execPath,
			["--import", createRequire(import.meta.url).resolve("tsx"), alias],
			{
				env: { HOME: root, PATH: "/usr/bin:/bin" },
				encoding: "utf8",
				timeout: 10000,
			},
		);
		expect(result.status).toBe(78);
		expect(result.stderr).toContain("lead_deployment_unverified");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
