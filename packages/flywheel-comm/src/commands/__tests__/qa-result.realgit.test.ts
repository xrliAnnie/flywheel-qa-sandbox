import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOneShotGitCredentialHelper, qaResult } from "../qa-result.js";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function runGit(
	cwd: string,
	args: readonly string[],
	env: NodeJS.ProcessEnv = process.env,
): string {
	return execFileSync("git", [...args], {
		cwd,
		env,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

describe("FLY-1686 real Git push attestation", () => {
	it("uses the one-shot helper in a real Git HTTP credential flow (credential segment only)", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly1686-credential-flow-"));
		const cleanHome = join(root, "clean-home");
		mkdirSync(cleanHome);
		const username = "fixture-user";
		const password = "fixture-password";
		const expectedAuthorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
		const authorizations: Array<string | undefined> = [];
		const server = createServer((request, response) => {
			authorizations.push(request.headers.authorization);
			if (request.headers.authorization !== expectedAuthorization) {
				response.statusCode = 401;
				response.setHeader("WWW-Authenticate", 'Basic realm="flywheel-test"');
				response.end();
				return;
			}
			const service = "# service=git-upload-pack\n";
			const packet = `${(service.length + 4).toString(16).padStart(4, "0")}${service}`;
			response.statusCode = 200;
			response.setHeader(
				"Content-Type",
				"application/x-git-upload-pack-advertisement",
			);
			response.end(`${packet}00000000`);
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("no port");
		try {
			const helper = createOneShotGitCredentialHelper(root, "github.com", {
				username,
				password,
			});
			const args = [
				"-c",
				"credential.helper=",
				"-c",
				`credential.helper=!${shellQuote(helper.path)}`,
				"-c",
				"protocol.version=0",
				"ls-remote",
				`http://127.0.0.1:${address.port}/repository.git`,
			];
			const gitEnv = {
				PATH: "/usr/bin:/bin",
				HOME: cleanHome,
				LANG: "C",
				LC_ALL: "C",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_CONFIG_SYSTEM: "/dev/null",
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_TERMINAL_PROMPT: "0",
				GIT_ASKPASS: "/usr/bin/false",
				...helper.env,
			};
			expect(args.join(" ")).not.toContain(username);
			expect(args.join(" ")).not.toContain(password);
			expect(gitEnv).not.toHaveProperty(
				"FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL",
			);

			const result = await new Promise<{
				status: number | null;
				stderr: string;
			}>((resolve) => {
				const child = spawn("/usr/bin/git", args, { env: gitEnv });
				let stderr = "";
				child.stderr.setEncoding("utf8");
				child.stderr.on("data", (chunk: string) => {
					stderr += chunk;
				});
				child.on("close", (status) => resolve({ status, stderr }));
			});
			expect(result.status, result.stderr).toBe(0);
			expect(authorizations).toEqual([undefined, expectedAuthorization]);
			expect(process.env.FLYWHEEL_QA_GIT_PASSWORD).not.toBe(password);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("pushes through origin's single rewrite instead of reapplying pushInsteadOf to the parsed endpoint", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly1686-qa-realgit-"));
		const worktree = join(root, "worktree");
		const authorizedRemote = join(root, "authorized.git");
		const prohibitedRemote = join(root, "prohibited.git");
		const fetchRemote = join(root, "fetch-only.git");
		const stagingRoot = join(root, "staging");
		try {
			runGit(root, ["init", "--bare", authorizedRemote]);
			runGit(root, ["init", "--bare", prohibitedRemote]);
			runGit(root, ["init", "--bare", fetchRemote]);
			runGit(root, ["init", "-b", "qa-local", worktree]);
			runGit(worktree, ["config", "user.name", "Flywheel Test"]);
			runGit(worktree, ["config", "user.email", "flywheel@example.test"]);

			writeFileSync(join(worktree, "progress.md"), "bound\n", "utf8");
			runGit(worktree, ["add", "progress.md"]);
			runGit(worktree, ["commit", "-m", "bound tip"]);
			const authorizedOid = runGit(worktree, ["rev-parse", "HEAD"]).trim();

			writeFileSync(join(worktree, "progress.md"), "ambient head\n", "utf8");
			runGit(worktree, ["add", "progress.md"]);
			runGit(worktree, ["commit", "-m", "ambient head advanced"]);
			const ambientHeadOid = runGit(worktree, ["rev-parse", "HEAD"]).trim();
			expect(ambientHeadOid).not.toBe(authorizedOid);

			const originAlias = "flywheel-fixture://repository";
			const attestedPushEndpoint =
				"ssh://git@github.com/GeoForge3D/Flywheel.git";
			const chainedSinkEndpoint =
				"ssh://git@github.com/GeoForge3D/Flywheel-sink.git";
			runGit(worktree, ["remote", "add", "origin", originAlias]);
			runGit(worktree, [
				"remote",
				"add",
				"parsed-endpoint",
				attestedPushEndpoint,
			]);
			const globalConfig = join(root, "trusted-global.gitconfig");
			runGit(worktree, [
				"config",
				"--file",
				globalConfig,
				`url.file://${fetchRemote}/.insteadOf`,
				originAlias,
			]);
			runGit(worktree, [
				"config",
				"--file",
				globalConfig,
				`url.${attestedPushEndpoint}.pushInsteadOf`,
				originAlias,
			]);
			runGit(worktree, [
				"config",
				"--file",
				globalConfig,
				`url.${chainedSinkEndpoint}.pushInsteadOf`,
				attestedPushEndpoint,
			]);
			const sshHelper = join(root, "local-git-ssh");
			const pushTrace = join(root, "push-targets.log");
			const credentialLeakMarker = join(root, "CREDENTIAL_ENV_LEAKED");
			const hostileHookMarker = join(root, "HOSTILE_PRE_PUSH_RAN");
			const hostileHook = join(worktree, ".git", "hooks", "pre-push");
			writeFileSync(
				hostileHook,
				`#!/bin/sh\nprintf ran > "${hostileHookMarker}"\n`,
				"utf8",
			);
			chmodSync(hostileHook, 0o700);
			writeFileSync(
				sshHelper,
				`#!/bin/sh\nif [ "\${FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL+x}" = x ]; then printf leaked > ${shellQuote(credentialLeakMarker)}; fi\ncase "$*" in\n  *Flywheel-sink.git*) target=${shellQuote(prohibitedRemote)} ;;\n  *Flywheel.git*) target=${shellQuote(authorizedRemote)} ;;\n  *) exit 64 ;;\nesac\nprintf "%s\\n" "$target" >> ${shellQuote(pushTrace)}\nexec /usr/bin/git-receive-pack "$target"\n`,
				"utf8",
			);
			chmodSync(sshHelper, 0o700);
			const hostileMarkers = [
				join(root, "HOSTILE_SSH_RAN"),
				join(root, "HOSTILE_CREDENTIAL_HELPER_RAN"),
				join(root, "HOSTILE_ASKPASS_RAN"),
				join(root, "HOSTILE_FSMONITOR_RAN"),
			];
			const hostileScripts = hostileMarkers.map((marker, index) => {
				const script = join(root, `hostile-${index}`);
				writeFileSync(
					script,
					`#!/bin/sh\nprintf ran > ${shellQuote(marker)}\nexit 97\n`,
					"utf8",
				);
				chmodSync(script, 0o700);
				return script;
			});
			runGit(worktree, ["config", "core.sshCommand", hostileScripts[0]!]);
			runGit(worktree, [
				"config",
				"credential.helper",
				`!${hostileScripts[1]!}`,
			]);
			runGit(worktree, ["config", "core.askPass", hostileScripts[2]!]);
			runGit(worktree, ["config", "core.fsmonitor", hostileScripts[3]!]);
			runGit(worktree, ["config", "http.proxy", "http://127.0.0.1:9"]);
			runGit(worktree, ["config", "https.proxy", "http://127.0.0.1:9"]);
			const gitEnv = {
				PATH: "/usr/bin:/bin",
				HOME: root,
				LANG: "C",
				LC_ALL: "C",
				GIT_CONFIG_GLOBAL: globalConfig,
				GIT_CONFIG_SYSTEM: "/dev/null",
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_TERMINAL_PROMPT: "0",
				GIT_SSH_COMMAND: sshHelper,
			};

			expect(
				runGit(
					worktree,
					["remote", "get-url", "--push", "--all", "origin"],
					gitEnv,
				).trim(),
			).toBe(attestedPushEndpoint);
			expect(
				runGit(
					worktree,
					["remote", "get-url", "--push", "--all", "parsed-endpoint"],
					gitEnv,
				).trim(),
			).toBe(chainedSinkEndpoint);
			runGit(
				worktree,
				[
					"push",
					"--dry-run",
					attestedPushEndpoint,
					`${authorizedOid}:refs/heads/prohibited-direct-url`,
				],
				gitEnv,
			);
			expect(readFileSync(pushTrace, "utf8").trim()).toBe(prohibitedRemote);
			expect(
				runGit(
					worktree,
					["remote", "get-url", "--all", "origin"],
					gitEnv,
				).trim(),
			).toBe(`file://${fetchRemote}/`);
			for (const marker of [
				credentialLeakMarker,
				hostileHookMarker,
				...hostileMarkers,
			]) {
				rmSync(marker, { force: true });
			}

			vi.stubEnv("FLYWHEEL_COMM_DB", "");
			vi.stubEnv("FLYWHEEL_EXEC_ID", "qa-engine");
			vi.stubEnv("FLYWHEEL_ISSUE_ID", "FLY-1686");
			vi.stubEnv("FLYWHEEL_PROJECT_NAME", "flywheel");
			vi.stubEnv("FLYWHEEL_BRIDGE_URL", "http://127.0.0.1:9876");
			vi.stubEnv("FLYWHEEL_WORKFLOW_SUBMISSION_EXPECTED", "1");
			vi.stubEnv("FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL", "scoped-secret");
			vi.stubEnv("GIT_CONFIG_GLOBAL", globalConfig);
			vi.stubEnv("GIT_SSH_COMMAND", hostileScripts[0]!);
			vi.stubEnv("GIT_ASKPASS", hostileScripts[2]!);
			vi.stubEnv("SSH_ASKPASS", hostileScripts[2]!);
			vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:9");
			vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:9");
			vi.stubEnv("ALL_PROXY", "http://127.0.0.1:9");
			const fetchMock = vi
				.fn()
				.mockResolvedValueOnce(
					new Response(
						JSON.stringify({
							ok: false,
							reason: "land_head_pr_not_at_tip",
							detail: {
								expectedHeadOid: authorizedOid,
								expectedHeadRefName: "fly-1686-docs",
								prNumber: 1686,
								repoSlug: "geoforge3d/flywheel",
								currentHeadOid: "0".repeat(40),
							},
						}),
						{ status: 409 },
					),
				)
				.mockResolvedValueOnce(
					new Response(
						JSON.stringify({
							ok: true,
							claimId: 1686,
							serverSeq: 2,
							idempotentReplay: false,
						}),
						{ status: 200 },
					),
				);
			vi.stubGlobal("fetch", fetchMock);

			await qaResult(
				{
					status: "pass",
					targetExec: "impl-1",
					prHeadSha: authorizedOid,
				},
				{
					createClientRequestId: () => "real-git-resend",
					gitPath: "/usr/bin/git",
					sourceRepoPath: worktree,
					stagingRoot,
					trustedSshCommand: sshHelper,
				},
			);

			expect(
				runGit(authorizedRemote, [
					"rev-parse",
					"refs/heads/fly-1686-docs",
				]).trim(),
			).toBe(authorizedOid);
			expect(runGit(worktree, ["rev-parse", "HEAD"]).trim()).toBe(
				ambientHeadOid,
			);
			expect(
				runGit(authorizedRemote, [
					"for-each-ref",
					"--format=%(refname)",
					"refs/heads",
				])
					.trim()
					.split("\n"),
			).toEqual(["refs/heads/fly-1686-docs"]);
			const ambientObjectProbe = spawnSync(
				"git",
				["cat-file", "-e", `${ambientHeadOid}^{commit}`],
				{ cwd: authorizedRemote, encoding: "utf8" },
			);
			expect(ambientObjectProbe.status).not.toBe(0);
			const fetchTargetProbe = spawnSync(
				"git",
				["rev-parse", "--verify", "--quiet", "refs/heads/fly-1686-docs"],
				{ cwd: fetchRemote, encoding: "utf8" },
			);
			expect(fetchTargetProbe.status).not.toBe(0);
			const prohibitedTargetProbe = spawnSync(
				"git",
				["rev-parse", "--verify", "--quiet", "refs/heads/fly-1686-docs"],
				{ cwd: prohibitedRemote, encoding: "utf8" },
			);
			expect(prohibitedTargetProbe.status).not.toBe(0);
			const prohibitedObjectProbe = spawnSync(
				"git",
				["cat-file", "-e", `${authorizedOid}^{commit}`],
				{ cwd: prohibitedRemote, encoding: "utf8" },
			);
			expect(prohibitedObjectProbe.status).not.toBe(0);
			expect(existsSync(hostileHookMarker)).toBe(false);
			expect(existsSync(credentialLeakMarker)).toBe(false);
			for (const marker of hostileMarkers)
				expect(existsSync(marker)).toBe(false);
			expect(readFileSync(pushTrace, "utf8").trim().split("\n")).toEqual([
				prohibitedRemote,
				authorizedRemote,
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
