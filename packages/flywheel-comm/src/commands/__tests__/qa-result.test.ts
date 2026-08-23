import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommDB } from "../../db.js";
import {
	buildGitHubAuthEnvironment,
	buildQaResultFailureMarker,
	classifyQaResultRejection,
	createOneShotGitCredentialHelper,
	parseGitHubCredentialOutput,
	qaResult,
	type WorkflowQaDecisionBody,
} from "../qa-result.js";

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("FLY-1686 GitHub credential boundary", () => {
	it("accepts only the exact bounded Git credential protocol response", () => {
		expect(
			parseGitHubCredentialOutput(
				"protocol=https\nhost=github.com\nusername=x-access-token\npassword=secret-value\n\n",
				"github.com",
			),
		).toEqual({ username: "x-access-token", password: "secret-value" });

		const invalid = [
			"",
			"protocol=https\nhost=github.com\nusername=user\n",
			"protocol=https\nhost=github.com\nusername=user\npassword=secret\nusername=again\n",
			"protocol=https\nhost=github.com\nusername=user\npassword=secret\noauth_token=unknown\n",
			"protocol=http\nhost=github.com\nusername=user\npassword=secret\n",
			"protocol=https\nhost=evil.example\nusername=user\npassword=secret\n",
			"protocol=https\nhost=github.com\nusername=\npassword=secret\n",
			"protocol=https\nhost=github.com\nusername=user\npassword=\n",
			`protocol=https\nhost=github.com\nusername=user\npassword=secret\u0000sentinel\n`,
			`protocol=https\nhost=github.com\nusername=${"u".repeat(257)}\npassword=secret\n`,
			`protocol=https\nhost=github.com\nusername=user\npassword=${"p".repeat(8_193)}\n`,
			"protocol=https\nhost=github.com\nusername=user\npassword\n",
		];
		for (const output of invalid) {
			expect(() => parseGitHubCredentialOutput(output, "github.com")).toThrow(
				"GitHub CLI credential response is invalid",
			);
			try {
				parseGitHubCredentialOutput(output, "github.com");
			} catch (error) {
				expect(String(error)).not.toContain("secret\u0000sentinel");
			}
		}
	});

	it("builds a real-HOME auth environment from an explicit safe allowlist", () => {
		const home = mkdtempSync(join(tmpdir(), "fly1686-auth-home-"));
		const ghConfig = join(home, "gh-config");
		mkdirSync(ghConfig);
		const authEnv = buildGitHubAuthEnvironment("/usr/bin/false", {
			HOME: home,
			GH_CONFIG_DIR: ghConfig,
			USER: "runner",
			LOGNAME: "runner",
			TMPDIR: realpathSync(tmpdir()),
			SECURITYSESSIONID: "keychain-session",
			__CF_USER_TEXT_ENCODING: "0x1F5:0x0:0x0",
			FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL: "submission-secret",
			FLYWHEEL_PRIVATE_TOKEN: "flywheel-secret",
			GH_TOKEN: "gh-env-secret",
			GITHUB_TOKEN: "github-env-secret",
			HTTP_PROXY: "http://127.0.0.1:9",
			HTTPS_PROXY: "http://127.0.0.1:9",
			NODE_OPTIONS: "--require hostile.js",
		});

		expect(authEnv).toEqual({
			PATH: "/usr/bin:/bin",
			LANG: "C",
			LC_ALL: "C",
			HOME: realpathSync(home),
			GH_CONFIG_DIR: realpathSync(ghConfig),
			USER: "runner",
			LOGNAME: "runner",
			TMPDIR: realpathSync(tmpdir()),
			SECURITYSESSIONID: "keychain-session",
			__CF_USER_TEXT_ENCODING: "0x1F5:0x0:0x0",
		});
		rmSync(home, { recursive: true, force: true });
	});

	it("creates a credential helper that emits only on the first get", () => {
		const root = mkdtempSync(join(tmpdir(), "fly1686-one-shot-helper-"));
		const helper = createOneShotGitCredentialHelper(root, "github.com", {
			username: "x-access-token",
			password: "credential-secret",
		});
		const script = readFileSync(helper.path, "utf8");
		expect(statSync(helper.path).mode & 0o777).toBe(0o700);
		expect(script).not.toContain("x-access-token");
		expect(script).not.toContain("credential-secret");
		expect(helper.config.join(" ")).not.toContain("credential-secret");

		const invoke = (operation: string) =>
			spawnSync(helper.path, [operation], {
				env: helper.env,
				encoding: "utf8",
			});
		expect(invoke("store").stdout).toBe("");
		expect(invoke("get").stdout).toBe(
			"protocol=https\nhost=github.com\nusername=x-access-token\npassword=credential-secret\n\n",
		);
		expect(invoke("get").stdout).toBe("");
		expect(invoke("erase").stdout).toBe("");
		rmSync(root, { recursive: true, force: true });
	});
});

describe("credential-backed qa-result delivery", () => {
	it("uses the current TURN activation credential instead of the stale process env", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly1423-qa-activation-"));
		const dbPath = join(dir, "comm.db");
		const db = new CommDB(dbPath);
		try {
			db.registerSession("qa-1", "win:1", "flywheel", "FLY-1423", "lead");
			db.grantTurn("FLY-1423", "qa-1", "qa", 1_700_000_000_000, {
				project: "flywheel",
				sourceEventId: "rework:req-1:qa-activation-2",
				targetRunId: "run-1",
				activation: {
					activationId: "qa-activation-2",
					runId: "run-1",
					nodeId: "qa",
					attempt: 2,
					submissionCredential: "current-qa-credential",
					context: { verification: "qa_retest" },
				},
			});
		} finally {
			db.close();
		}
		vi.stubEnv("FLYWHEEL_COMM_DB", dbPath);
		vi.stubEnv("FLYWHEEL_EXEC_ID", "qa-1");
		vi.stubEnv("FLYWHEEL_ISSUE_ID", "FLY-1423");
		vi.stubEnv("FLYWHEEL_PROJECT_NAME", "flywheel");
		vi.stubEnv("FLYWHEEL_BRIDGE_URL", "http://127.0.0.1:9876");
		vi.stubEnv("FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL", "stale-startup");
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					ok: true,
					claimId: 1,
					serverSeq: 1,
					idempotentReplay: false,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);
		vi.stubGlobal("fetch", fetchMock);

		await qaResult({
			status: "pass",
			targetExec: "impl-1",
			prHeadSha: "a".repeat(40),
		});

		const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
		expect(JSON.parse(init.body).credential).toBe("current-qa-credential");
		rmSync(dir, { recursive: true, force: true });
	});

	it("uses the dedicated decision route without the fleet ingest bearer", async () => {
		vi.stubEnv("FLYWHEEL_COMM_DB", "");
		vi.stubEnv("FLYWHEEL_EXEC_ID", "qa-1");
		vi.stubEnv("FLYWHEEL_ISSUE_ID", "FLY-1244");
		vi.stubEnv("FLYWHEEL_PROJECT_NAME", "flywheel");
		vi.stubEnv("FLYWHEEL_BRIDGE_URL", "http://127.0.0.1:9876");
		vi.stubEnv("FLYWHEEL_INGEST_TOKEN", "fleet-secret");
		vi.stubEnv("FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL", "scoped-secret");
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					ok: true,
					claimId: 1,
					serverSeq: 1,
					idempotentReplay: false,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);
		vi.stubGlobal("fetch", fetchMock);

		await qaResult({
			status: "pass",
			targetExec: "impl-1",
			summary: "all checks passed",
			prHeadSha: "a".repeat(40),
		});

		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, init] = fetchMock.mock.calls[0] as [
			string,
			{ headers: Record<string, string>; body: string },
		];
		expect(url).toBe("http://127.0.0.1:9876/api/workflow/decision");
		expect(init.headers.Authorization).toBeUndefined();
		expect(JSON.parse(init.body)).toMatchObject({
			credential: "scoped-secret",
			status: "pass",
			summary: "all checks passed",
			client_pr_head_sha: "a".repeat(40),
			client_request_id: expect.any(String),
		});
	});

	it("fails loudly without a DAG submission credential and never falls back to /events", async () => {
		vi.stubEnv("FLYWHEEL_COMM_DB", "");
		vi.stubEnv("FLYWHEEL_EXEC_ID", "qa-legacy");
		vi.stubEnv("FLYWHEEL_ISSUE_ID", "FLY-1244");
		vi.stubEnv("FLYWHEEL_PROJECT_NAME", "flywheel");
		vi.stubEnv("FLYWHEEL_BRIDGE_URL", "http://127.0.0.1:9876");
		vi.stubEnv("FLYWHEEL_INGEST_TOKEN", "fleet-secret");
		vi.stubEnv("FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL", "");
		vi.stubEnv("FLYWHEEL_WORKFLOW_SUBMISSION_EXPECTED", "");
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const exit = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("exit:1");
		}) as never);

		await expect(
			qaResult({
				status: "fail",
				targetExec: "impl-1",
				prHeadSha: "b".repeat(40),
			}),
		).rejects.toThrow("exit:1");
		expect(exit).toHaveBeenCalledWith(1);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("failure marker preserves the recoverable verdict but never the credential", () => {
		const marker = buildQaResultFailureMarker({
			execId: "qa-1",
			requestId: "request-1",
			body: {
				credential: "do-not-persist",
				status: "fail",
				summary: "blocking regression reproduced",
			},
			lastError: "Bridge returned 503",
			timestamp: "2026-07-14T00:00:00.000Z",
		});
		expect(marker).toMatchObject({
			execution_id: "qa-1",
			client_request_id: "request-1",
			error: "Bridge returned 503",
			status: "fail",
			summary: "blocking regression reproduced",
			body_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
		});
		expect(JSON.stringify(marker)).not.toContain("do-not-persist");
	});
});

describe("FLY-1686 authorized land-head push handshake", () => {
	const expectedHeadOid = "b".repeat(40);
	const currentHeadOid = "a".repeat(40);

	function stubHandshakeEnv(home?: string): void {
		vi.stubEnv("FLYWHEEL_COMM_DB", "");
		vi.stubEnv("FLYWHEEL_EXEC_ID", "qa-engine");
		vi.stubEnv("FLYWHEEL_ISSUE_ID", "FLY-1686");
		vi.stubEnv("FLYWHEEL_PROJECT_NAME", "flywheel");
		vi.stubEnv("FLYWHEEL_BRIDGE_URL", "http://127.0.0.1:9876");
		vi.stubEnv("FLYWHEEL_WORKFLOW_SUBMISSION_EXPECTED", "1");
		vi.stubEnv("FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL", "scoped-secret");
		if (home) vi.stubEnv("HOME", home);
	}

	function notAtTipResponse(detail: Record<string, unknown> = {}): Response {
		return new Response(
			JSON.stringify({
				ok: false,
				reason: "land_head_pr_not_at_tip",
				detail: {
					expectedHeadOid,
					expectedHeadRefName: "fly-1686-docs",
					prNumber: 1686,
					repoSlug: "GeoForge3D/Flywheel",
					currentHeadOid,
					...detail,
				},
			}),
			{ status: 409, headers: { "Content-Type": "application/json" } },
		);
	}

	function acceptedResponse(): Response {
		return new Response(
			JSON.stringify({
				ok: true,
				claimId: 42,
				serverSeq: 7,
				idempotentReplay: false,
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	}

	const validGitHubCredential = () =>
		"protocol=https\nhost=github.com\nusername=x-access-token\npassword=fixture-secret\n\n";

	function stubFailureExit(): ReturnType<typeof vi.spyOn> {
		vi.spyOn(globalThis, "setTimeout").mockImplementation(((
			callback: () => void,
		) => {
			callback();
			return 0;
		}) as typeof setTimeout);
		return vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("exit:1");
		}) as never);
	}

	function logicalGitArgs(args: readonly string[]): string[] {
		const commands = new Set([
			"check-ref-format",
			"remote",
			"config",
			"rev-parse",
			"init",
			"cat-file",
			"push",
		]);
		const commandIndex = args.findIndex((value) => commands.has(value));
		if (commandIndex < 0)
			throw new Error(`missing git command: ${args.join(" ")}`);
		return [...args.slice(commandIndex)];
	}

	function createHandshakeGit(
		options: {
			remoteOutput?: string;
			rawOrigin?: string;
			invalidRef?: boolean;
			onPush?: (
				args: readonly string[],
				opts: { cwd: string; env: Readonly<Record<string, string>> },
			) => string;
		} = {},
	) {
		const logicalCalls: string[][] = [];
		const rawCalls: Array<{
			args: readonly string[];
			opts: { cwd: string; env: Readonly<Record<string, string>> };
		}> = [];
		const remoteOutput =
			options.remoteOutput ?? "git@github.com:GeoForge3D/Flywheel.git\n";
		const runGit = vi.fn(
			(
				args: readonly string[],
				opts: {
					cwd: string;
					env: Readonly<Record<string, string>>;
				},
			) => {
				rawCalls.push({ args, opts });
				const command = logicalGitArgs(args);
				logicalCalls.push(command);
				if (command[0] === "check-ref-format") {
					if (options.invalidRef) throw new Error("invalid ref");
					return "";
				}
				if (command[0] === "remote" && command[1] === "get-url") {
					return remoteOutput;
				}
				if (command[0] === "remote" && command[1] === "add") return "";
				if (
					command[0] === "config" &&
					command.includes("remote.origin.pushurl")
				) {
					throw new Error("no pushurl");
				}
				if (command[0] === "config" && command.includes("remote.origin.url")) {
					return `${options.rawOrigin ?? remoteOutput.trim()}\n`;
				}
				if (command[0] === "config") return "";
				if (command[0] === "rev-parse") return `${process.cwd()}\n`;
				if (command[0] === "init" || command[0] === "cat-file") return "";
				if (command[0] === "push") return options.onPush?.(args, opts) ?? "";
				throw new Error(`unexpected git argv: ${command.join(" ")}`);
			},
		);
		return { logicalCalls, rawCalls, runGit };
	}

	it("submits a credential decision without initializing git on the first POST", async () => {
		const home = mkdtempSync(join(tmpdir(), "fly1686-qa-lazy-git-"));
		stubHandshakeEnv(home);
		const missingRepo = join(home, "missing-worktree");
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					ok: true,
					claimId: 1686,
					serverSeq: 1,
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
				summary: "verified the production workflow",
			},
			{
				sourceRepoPath: missingRepo,
				createClientRequestId: () => "recoverable-request-id",
			},
		);

		expect(fetchMock).toHaveBeenCalledOnce();
		const request = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
		expect(request).not.toHaveProperty("client_pr_head_sha");
		expect(
			existsSync(
				join(home, ".flywheel", "state", "qa-result-failed", "qa-engine.json"),
			),
		).toBe(false);
		rmSync(home, { recursive: true, force: true });
	});

	it("prints the same safe verdict projection when the eager-abort marker cannot be written", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly1686-qa-eager-stderr-"));
		const unusableHome = join(root, "home-is-a-file");
		writeFileSync(unusableHome, "not a directory");
		stubHandshakeEnv(unusableHome);
		const exit = stubFailureExit();
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(
			qaResult(
				{
					status: "fail",
					targetExec: "impl-2",
					summary: "blocking regression reproduced",
				},
				{ sourceRepoPath: join(root, "missing-worktree") },
			),
		).rejects.toThrow("exit:1");

		expect(exit).toHaveBeenCalledWith(1);
		const stderr = error.mock.calls.flat().join("\n");
		expect(stderr).toContain('"targetExecutionId":"impl-2"');
		expect(stderr).toContain('"issueId":"FLY-1686"');
		expect(stderr).toContain('"status":"fail"');
		expect(stderr).toContain('"summary":"blocking regression reproduced"');
		expect(stderr).not.toContain("scoped-secret");
		rmSync(root, { recursive: true, force: true });
	});

	it("persists the safe verdict when workflow activation storage is corrupt", async () => {
		const home = mkdtempSync(join(tmpdir(), "fly1686-qa-activation-marker-"));
		const corruptDb = join(home, "comm.db");
		writeFileSync(corruptDb, "not a sqlite database");
		stubHandshakeEnv(home);
		vi.stubEnv("FLYWHEEL_COMM_DB", corruptDb);
		const exit = stubFailureExit();
		vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(
			qaResult({
				status: "pass",
				targetExec: "impl-activation",
				summary: "activation failure must not erase this verdict",
				prHeadSha: expectedHeadOid,
			}),
		).rejects.toThrow("exit:1");

		expect(exit).toHaveBeenCalledWith(1);
		const marker = JSON.parse(
			readFileSync(
				join(home, ".flywheel", "state", "qa-result-failed", "qa-engine.json"),
				"utf8",
			),
		);
		expect(marker).toMatchObject({
			error: expect.stringContaining("qa_activation_context_unavailable"),
			recoverable_verdict: {
				targetExecutionId: "impl-activation",
				status: "pass",
				summary: "activation failure must not erase this verdict",
			},
		});
		expect(JSON.stringify(marker)).not.toContain("scoped-secret");
		rmSync(home, { recursive: true, force: true });
	});

	it("persists the safe verdict before required delivery environment validation aborts", async () => {
		const home = mkdtempSync(join(tmpdir(), "fly1686-qa-env-marker-"));
		stubHandshakeEnv(home);
		vi.stubEnv("FLYWHEEL_BRIDGE_URL", "");
		const exit = stubFailureExit();
		vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(
			qaResult({
				status: "fail",
				targetExec: "impl-env",
				summary: "delivery env is unavailable",
				prHeadSha: expectedHeadOid,
			}),
		).rejects.toThrow("exit:1");

		expect(exit).toHaveBeenCalledWith(1);
		const marker = JSON.parse(
			readFileSync(
				join(home, ".flywheel", "state", "qa-result-failed", "qa-engine.json"),
				"utf8",
			),
		);
		expect(marker).toMatchObject({
			error: expect.stringContaining("qa_environment_context_unavailable"),
			recoverable_verdict: {
				targetExecutionId: "impl-env",
				status: "fail",
				prHeadSha: expectedHeadOid,
			},
		});
		rmSync(home, { recursive: true, force: true });
	});

	it("posts first with zero git mutation, then pushes the exact authorized OID and resends with a new request id", async () => {
		stubHandshakeEnv();
		const stagingRoot = join(
			tmpdir(),
			`fly1686-first-post-${process.pid}-${Date.now()}`,
		);
		const { logicalCalls: gitCalls, runGit } = createHandshakeGit();
		const fetchMock = vi
			.fn()
			.mockImplementationOnce(async () => {
				expect(gitCalls).toEqual([]);
				expect(existsSync(stagingRoot)).toBe(false);
				return notAtTipResponse();
			})
			.mockResolvedValueOnce(acceptedResponse());
		vi.stubGlobal("fetch", fetchMock);

		await qaResult(
			{
				status: "pass",
				targetExec: "impl-1",
				prHeadSha: expectedHeadOid,
			},
			{
				runGit,
				stagingRoot,
				createClientRequestId: () => "fresh-request-id",
			},
		);

		expect(gitCalls.at(-1)).toEqual([
			"push",
			"origin",
			`${expectedHeadOid}:refs/heads/fly-1686-docs`,
		]);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const first = JSON.parse(
			(fetchMock.mock.calls[0]?.[1] as { body: string }).body,
		) as Record<string, unknown>;
		const second = JSON.parse(
			(fetchMock.mock.calls[1]?.[1] as { body: string }).body,
		) as Record<string, unknown>;
		expect(second.client_request_id).toBe("fresh-request-id");
		expect(second.client_request_id).not.toBe(first.client_request_id);
		expect(second).toMatchObject({
			credential: first.credential,
			status: first.status,
			client_pr_head_sha: first.client_pr_head_sha,
		});
		rmSync(stagingRoot, { recursive: true, force: true });
	});

	it("settles a stale post-push PR probe before resending the same decision", async () => {
		const home = mkdtempSync(join(tmpdir(), "fly1686-qa-stale-settle-"));
		stubHandshakeEnv(home);
		vi.useFakeTimers();
		const exit = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("exit:1");
		}) as never);
		const { logicalCalls, runGit } = createHandshakeGit();
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(notAtTipResponse())
			.mockResolvedValueOnce(notAtTipResponse())
			.mockResolvedValueOnce(acceptedResponse());
		vi.stubGlobal("fetch", fetchMock);

		const startedAt = Date.now();
		const submission = qaResult(
			{
				status: "pass",
				targetExec: "impl-1",
				prHeadSha: expectedHeadOid,
			},
			{
				runGit,
				createClientRequestId: () => "stale-settle-request-id",
			},
		);
		await vi.advanceTimersByTimeAsync(250);
		await expect(submission).resolves.toBeUndefined();

		expect(Date.now() - startedAt).toBe(250);
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(logicalCalls.filter(([command]) => command === "push")).toHaveLength(
			1,
		);
		const firstResend = JSON.parse(
			(fetchMock.mock.calls[1]?.[1] as { body: string }).body,
		) as WorkflowQaDecisionBody;
		const settledResend = JSON.parse(
			(fetchMock.mock.calls[2]?.[1] as { body: string }).body,
		) as WorkflowQaDecisionBody;
		expect(firstResend.client_request_id).toBe("stale-settle-request-id");
		expect(settledResend).toEqual(firstResend);
		expect(exit).not.toHaveBeenCalled();
		rmSync(home, { recursive: true, force: true });
	});

	it("fails closed after five seconds when the pre-push PR tip stays visible", async () => {
		const home = mkdtempSync(join(tmpdir(), "fly1686-qa-settle-timeout-"));
		stubHandshakeEnv(home);
		let nowMs = 0;
		const settleDelays: number[] = [];
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("exit:1");
		}) as never);
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const { logicalCalls, runGit } = createHandshakeGit();
		const fetchMock = vi
			.fn()
			.mockImplementation(async () => notAtTipResponse());
		vi.stubGlobal("fetch", fetchMock);

		const startedAt = nowMs;
		const submission = qaResult(
			{
				status: "pass",
				targetExec: "impl-1",
				prHeadSha: expectedHeadOid,
			},
			{
				runGit,
				createClientRequestId: () => "settle-timeout-request-id",
				now: () => nowMs,
				sleep: async (ms) => {
					settleDelays.push(ms);
					nowMs += ms;
				},
			},
		);
		await expect(submission).rejects.toThrow("exit:1");

		expect(nowMs - startedAt).toBe(5000);
		expect(settleDelays).toEqual(Array(20).fill(250));
		expect(fetchMock).toHaveBeenCalledTimes(22);
		expect(logicalCalls.filter(([command]) => command === "push")).toHaveLength(
			1,
		);
		const stderr = error.mock.calls.flat().join("\n");
		expect(stderr).toContain("5s settle timeout");
		expect(stderr).not.toContain("Stop making commits");
		const marker = JSON.parse(
			readFileSync(
				join(home, ".flywheel", "state", "qa-result-failed", "qa-engine.json"),
				"utf8",
			),
		) as Record<string, unknown>;
		expect(marker).toMatchObject({
			client_request_id: "settle-timeout-request-id",
			error: expect.stringContaining("5s settle timeout"),
		});
		rmSync(home, { recursive: true, force: true });
	});

	it("retrieves credentials with real HOME and injects them only into the clean push helper", async () => {
		const home = mkdtempSync(join(tmpdir(), "fly1686-qa-https-auth-"));
		const ghConfig = join(home, "gh-config");
		mkdirSync(ghConfig);
		stubHandshakeEnv(home);
		vi.stubEnv("GH_CONFIG_DIR", ghConfig);
		vi.stubEnv("GH_TOKEN", "hostile-gh-token");
		vi.stubEnv("GITHUB_TOKEN", "hostile-github-token");
		vi.stubEnv("FLYWHEEL_PRIVATE_TOKEN", "hostile-flywheel-token");
		vi.stubEnv("GIT_ASKPASS", join(home, "hostile-askpass"));
		vi.stubEnv("GIT_SSH_COMMAND", join(home, "hostile-ssh"));
		vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:9");
		vi.stubEnv("ALL_PROXY", "http://127.0.0.1:9");
		const runGitHubCredential = vi.fn(
			(
				_args: readonly string[],
				_opts: {
					env: Readonly<Record<string, string>>;
					input: string;
				},
			) =>
				"protocol=https\nhost=github.com\nusername=x-access-token\npassword=helper-secret\n\n",
		);
		const { rawCalls, runGit } = createHandshakeGit({
			remoteOutput: "https://github.com/GeoForge3D/Flywheel.git\n",
			rawOrigin: "git@github.com:GeoForge3D/Flywheel.git",
		});
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(notAtTipResponse())
				.mockResolvedValueOnce(acceptedResponse()),
		);

		await qaResult(
			{
				status: "pass",
				targetExec: "impl-1",
				prHeadSha: expectedHeadOid,
			},
			{
				runGit,
				githubCliPath: "/usr/bin/false",
				runGitHubCredential,
				stagingRoot: join(home, "staging"),
				createClientRequestId: () => "https-resend-id",
			},
		);

		expect(runGitHubCredential).toHaveBeenCalledOnce();
		const [authArgs, authOptions] = runGitHubCredential.mock.calls[0]!;
		expect(authArgs).toEqual(["auth", "git-credential", "get"]);
		expect(authOptions.input).toBe("protocol=https\nhost=github.com\n\n");
		expect(authOptions.env).toMatchObject({
			HOME: realpathSync(home),
			GH_CONFIG_DIR: realpathSync(ghConfig),
			LANG: "C",
			LC_ALL: "C",
		});
		for (const stripped of [
			"FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL",
			"FLYWHEEL_PRIVATE_TOKEN",
			"GH_TOKEN",
			"GITHUB_TOKEN",
			"HTTPS_PROXY",
			"ALL_PROXY",
		]) {
			expect(authOptions.env[stripped]).toBeUndefined();
		}
		const pushCall = rawCalls.find(
			({ args }) => logicalGitArgs(args)[0] === "push",
		);
		expect(pushCall).toBeDefined();
		const resetIndex = pushCall!.args.indexOf("credential.helper=");
		const helperIndex = pushCall!.args.findIndex((value) =>
			value.startsWith("credential.https://github.com.helper=!"),
		);
		expect(resetIndex).toBeGreaterThanOrEqual(0);
		expect(helperIndex).toBeGreaterThan(resetIndex);
		expect(pushCall!.args[helperIndex]).toContain("git-credential-once");
		expect(pushCall!.args.join(" ")).not.toContain("x-access-token");
		expect(pushCall!.args.join(" ")).not.toContain("helper-secret");
		expect(pushCall!.opts.env).toMatchObject({
			HOME: join(home, "staging", "home"),
			GIT_TERMINAL_PROMPT: "0",
			GIT_ASKPASS: "/usr/bin/false",
			SSH_ASKPASS: "/usr/bin/false",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_SYSTEM: "/dev/null",
			FLYWHEEL_QA_GIT_USERNAME: "x-access-token",
			FLYWHEEL_QA_GIT_PASSWORD: "helper-secret",
		});
		for (const secretOrExecutor of [
			"FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL",
			"FLYWHEEL_PRIVATE_TOKEN",
			"GH_TOKEN",
			"GITHUB_TOKEN",
			"GIT_SSH_COMMAND",
			"HTTPS_PROXY",
			"HTTP_PROXY",
			"ALL_PROXY",
		]) {
			expect(pushCall!.opts.env[secretOrExecutor]).toBeUndefined();
		}
		expect(
			rawCalls.filter(
				(call) => call.opts.env.FLYWHEEL_QA_GIT_PASSWORD === "helper-secret",
			),
		).toEqual([pushCall]);
		rmSync(home, { recursive: true, force: true });
	});

	it("writes a fail-close marker and never pushes when gh returns no credential", async () => {
		const home = mkdtempSync(join(tmpdir(), "fly1686-qa-empty-auth-"));
		stubHandshakeEnv(home);
		stubFailureExit();
		const runGitHubCredential = vi.fn(() => "");
		const { logicalCalls, runGit } = createHandshakeGit({
			remoteOutput: "https://github.com/GeoForge3D/Flywheel.git\n",
		});
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(notAtTipResponse()));
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(
			qaResult(
				{
					status: "pass",
					targetExec: "impl-1",
					prHeadSha: expectedHeadOid,
				},
				{
					runGit,
					githubCliPath: "/usr/bin/false",
					runGitHubCredential,
				},
			),
		).rejects.toThrow("exit:1");

		expect(runGitHubCredential).toHaveBeenCalledOnce();
		expect(logicalCalls.some(([command]) => command === "push")).toBe(false);
		expect(error.mock.calls.flat().join("\n")).toContain(
			"repair gh auth login",
		);
		const markerText = readFileSync(
			join(home, ".flywheel", "state", "qa-result-failed", "qa-engine.json"),
			"utf8",
		);
		expect(markerText).toContain("repair gh auth login");
		expect(markerText).not.toContain("scoped-secret");
		rmSync(home, { recursive: true, force: true });
	});

	it("fails closed before push when HTTPS has no trusted credential helper", async () => {
		const home = mkdtempSync(join(tmpdir(), "fly1686-qa-no-helper-"));
		stubHandshakeEnv(home);
		stubFailureExit();
		const { logicalCalls, runGit } = createHandshakeGit({
			remoteOutput: "https://github.com/GeoForge3D/Flywheel.git\n",
		});
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(notAtTipResponse()));
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(
			qaResult(
				{
					status: "pass",
					targetExec: "impl-1",
					prHeadSha: expectedHeadOid,
				},
				{ runGit, githubCliPath: false },
			),
		).rejects.toThrow("exit:1");
		expect(logicalCalls.some(([command]) => command === "push")).toBe(false);
		expect(error).toHaveBeenCalledWith(
			expect.stringContaining(
				"trusted GitHub CLI credential helper is unavailable",
			),
		);
		rmSync(home, { recursive: true, force: true });
	});

	it("reuses the same client request id for an ordinary retry", async () => {
		stubHandshakeEnv();
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ ok: false, reason: "bridge_busy" }), {
					status: 503,
				}),
			)
			.mockResolvedValueOnce(acceptedResponse());
		vi.stubGlobal("fetch", fetchMock);
		vi.spyOn(globalThis, "setTimeout").mockImplementation(((
			callback: () => void,
		) => {
			callback();
			return 0;
		}) as typeof setTimeout);

		await qaResult({
			status: "pass",
			targetExec: "impl-1",
			prHeadSha: expectedHeadOid,
		});

		const requestIds = fetchMock.mock.calls.map(
			([, init]) =>
				(
					JSON.parse((init as { body: string }).body) as {
						client_request_id: string;
					}
				).client_request_id,
		);
		expect(requestIds[1]).toBe(requestIds[0]);
	});

	it.each([
		[
			"bad expected oid",
			{ expectedHeadOid: "not-an-oid" },
			"git@github.com:GeoForge3D/Flywheel.git\n",
		],
		[
			"bad current oid",
			{ currentHeadOid: "not-an-oid" },
			"git@github.com:GeoForge3D/Flywheel.git\n",
		],
		[
			"bad PR number",
			{ prNumber: 0 },
			"git@github.com:GeoForge3D/Flywheel.git\n",
		],
		[
			"bad repo slug",
			{ repoSlug: "GeoForge3D/Flywheel/extra" },
			"git@github.com:GeoForge3D/Flywheel.git\n",
		],
		["hostile push host", {}, "git@evil.example:GeoForge3D/Flywheel.git\n"],
		["local push path", {}, "/tmp/GeoForge3D/Flywheel.git\n"],
		[
			"whitespace-wrapped push URL",
			{},
			" https://github.com/GeoForge3D/Flywheel.git \n",
		],
		["extra push path", {}, "git@github.com:extra/GeoForge3D/Flywheel.git\n"],
		[
			"multiple push URLs",
			{},
			"git@github.com:GeoForge3D/Flywheel.git\nhttps://github.com/GeoForge3D/Flywheel.git\n",
		],
		["mismatched push slug", {}, "git@github.com:someone-else/Flywheel.git\n"],
	] as const)(
		"rejects %s without pushing",
		async (_label, detail, remoteOutput) => {
			const home = mkdtempSync(join(tmpdir(), "fly1686-qa-handshake-"));
			stubHandshakeEnv(home);
			stubFailureExit();
			const { logicalCalls, runGit } = createHandshakeGit({ remoteOutput });
			vi.stubGlobal(
				"fetch",
				vi.fn().mockResolvedValue(notAtTipResponse(detail)),
			);

			await expect(
				qaResult(
					{
						status: "pass",
						targetExec: "impl-1",
						prHeadSha: expectedHeadOid,
					},
					{ runGit },
				),
			).rejects.toThrow("exit:1");
			expect(logicalCalls.some(([command]) => command === "push")).toBe(false);
			rmSync(home, { recursive: true, force: true });
		},
	);

	it("rejects an invalid full ref without reading the remote or pushing", async () => {
		const home = mkdtempSync(join(tmpdir(), "fly1686-qa-ref-"));
		stubHandshakeEnv(home);
		stubFailureExit();
		const { logicalCalls, runGit } = createHandshakeGit({ invalidRef: true });
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					notAtTipResponse({ expectedHeadRefName: "bad..branch" }),
				),
		);

		await expect(
			qaResult(
				{
					status: "pass",
					targetExec: "impl-1",
					prHeadSha: expectedHeadOid,
				},
				{ runGit },
			),
		).rejects.toThrow("exit:1");
		expect(runGit).toHaveBeenCalledTimes(1);
		expect(logicalCalls).toEqual([
			["check-ref-format", "refs/heads/bad..branch"],
		]);
		rmSync(home, { recursive: true, force: true });
	});

	it("fails immediately with changed-tip guidance when the post-push head really moves", async () => {
		const home = mkdtempSync(join(tmpdir(), "fly1686-qa-budget-"));
		stubHandshakeEnv(home);
		stubFailureExit();
		const { logicalCalls, runGit } = createHandshakeGit({
			remoteOutput: "https://github.com/geoforge3d/flywheel.git\n",
		});
		const fetchMock = vi.fn().mockImplementation(async () =>
			fetchMock.mock.calls.length === 1
				? notAtTipResponse()
				: notAtTipResponse({
						expectedHeadOid: "c".repeat(40),
						currentHeadOid: expectedHeadOid,
					}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const settleSleep = vi.fn(async () => {});

		await expect(
			qaResult(
				{
					status: "pass",
					targetExec: "impl-1",
					prHeadSha: expectedHeadOid,
				},
				{
					runGit,
					githubCliPath: "/usr/bin/false",
					runGitHubCredential: validGitHubCredential,
					createClientRequestId: () => "fresh-request-id",
					sleep: settleSleep,
				},
			),
		).rejects.toThrow("exit:1");
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(settleSleep).not.toHaveBeenCalled();
		expect(logicalCalls.filter(([command]) => command === "push")).toHaveLength(
			1,
		);
		expect(error).toHaveBeenCalledWith(
			expect.stringContaining("PR head changed after the authorized push"),
		);
		expect(error.mock.calls.flat().join("\n")).not.toContain(
			"Stop making commits",
		);
		expect(error).toHaveBeenCalledWith(
			expect.stringContaining("flywheel-comm qa-result --status 'pass'"),
		);
		const markerText = readFileSync(
			join(home, ".flywheel", "state", "qa-result-failed", "qa-engine.json"),
			"utf8",
		);
		expect(JSON.parse(markerText).client_request_id).toBe("fresh-request-id");
		expect(markerText).not.toContain("scoped-secret");
		rmSync(home, { recursive: true, force: true });
	});

	it("fails closed without pushing when a distinct resend request id cannot be created", async () => {
		const home = mkdtempSync(join(tmpdir(), "fly1686-qa-request-id-"));
		stubHandshakeEnv(home);
		stubFailureExit();
		const { logicalCalls, runGit } = createHandshakeGit({
			remoteOutput: "https://github.com/geoforge3d/flywheel.git\n",
		});
		const fetchMock = vi
			.fn()
			.mockImplementation(async () => notAtTipResponse());
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			qaResult(
				{
					status: "pass",
					targetExec: "impl-1",
					prHeadSha: expectedHeadOid,
				},
				{
					runGit,
					createClientRequestId: () => {
						throw new Error("uuid source unavailable");
					},
				},
			),
		).rejects.toThrow("exit:1");
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(logicalCalls.some(([command]) => command === "push")).toBe(false);
		rmSync(home, { recursive: true, force: true });
	});

	it("does not treat a non-409 not-at-tip response as push authorization", async () => {
		const home = mkdtempSync(join(tmpdir(), "fly1686-qa-status-"));
		stubHandshakeEnv(home);
		stubFailureExit();
		const runGit = vi.fn<(args: readonly string[]) => string>();
		const fetchMock = vi.fn().mockImplementation(
			async () =>
				new Response(
					JSON.stringify({
						ok: false,
						reason: "land_head_pr_not_at_tip",
						detail: {},
					}),
					{ status: 400 },
				),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			qaResult(
				{
					status: "pass",
					targetExec: "impl-1",
					prHeadSha: expectedHeadOid,
				},
				{ runGit },
			),
		).rejects.toThrow("exit:1");
		expect(fetchMock).toHaveBeenCalledTimes(4);
		expect(runGit).not.toHaveBeenCalled();
		rmSync(home, { recursive: true, force: true });
	});

	it("preserves the legacy transition_refused terminal path with zero git mutation", async () => {
		const home = mkdtempSync(join(tmpdir(), "fly1686-qa-legacy-refused-"));
		stubHandshakeEnv(home);
		stubFailureExit();
		const runGit = vi.fn<(args: readonly string[]) => string>();
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				new Response(
					JSON.stringify({ ok: false, reason: "transition_refused" }),
					{ status: 409 },
				),
			);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			qaResult(
				{
					status: "pass",
					targetExec: "impl-1",
					prHeadSha: expectedHeadOid,
				},
				{ runGit },
			),
		).rejects.toThrow("exit:1");
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(runGit).not.toHaveBeenCalled();
		rmSync(home, { recursive: true, force: true });
	});

	it("spends the one-push budget and fails terminally when push times out after a possible write", async () => {
		const home = mkdtempSync(join(tmpdir(), "fly1686-qa-push-fail-"));
		stubHandshakeEnv(home);
		stubFailureExit();
		let pushSideEffects = 0;
		const { logicalCalls, runGit } = createHandshakeGit({
			remoteOutput: "https://github.com/geoforge3d/flywheel.git\n",
			onPush: () => {
				pushSideEffects += 1;
				const error = new Error("git push timed out after write");
				Object.assign(error, { code: "ETIMEDOUT" });
				throw error;
			},
		});
		const fetchMock = vi
			.fn()
			.mockImplementation(async () => notAtTipResponse());
		vi.stubGlobal("fetch", fetchMock);
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(
			qaResult(
				{
					status: "pass",
					targetExec: "impl-1",
					prHeadSha: expectedHeadOid,
				},
				{
					runGit,
					githubCliPath: "/usr/bin/false",
					runGitHubCredential: validGitHubCredential,
				},
			),
		).rejects.toThrow("exit:1");
		expect(error).toHaveBeenCalledWith(
			expect.stringContaining("authorized git push failed"),
		);
		expect(logicalCalls.filter(([command]) => command === "push")).toHaveLength(
			1,
		);
		expect(pushSideEffects).toBe(1);
		expect(fetchMock).toHaveBeenCalledOnce();
		rmSync(home, { recursive: true, force: true });
	});
});

describe("FLY-1425 qa-result fail-loud contract", () => {
	const deterministicReasons = [
		"workflow_submission_required",
		"credential_not_found",
		"credential_revoked",
		"credential_expired",
		"credential_receipt_corrupt",
		"invalid_request",
		"invalid_status",
		"invalid_client_head",
		"invalid_timestamp",
		"head_authority_mismatch",
		"replay_payload_mismatch",
		"not_durable_qa_execution",
		"predicate_not_allowed",
		"binding_not_current",
		"same_vendor_review",
		"missing_subject_producer",
		"node_does_not_emit_decisions",
		"decision_family_mismatch",
		"materialized_head_invalid",
		"materialized_output_mismatch",
		"materialized_producer_ambiguous",
		"execution_not_found",
		"worktree_not_found",
		"invalid_git_head",
		"run_not_found",
		"transition_refused",
		"land_head_pr_closed",
		"land_head_pr_merged",
		"land_head_pr_draft",
		"land_head_pr_cross_repo",
		"land_head_pr_ref_invalid",
		"land_head_pr_identity_unavailable",
		"land_head_authority_drift",
		"land_head_materialized_pr_not_at_tip",
		"land_gate_entry_binding_mismatch",
		"land_gate_entry_sealed_manifest_stale",
	] as const;
	const retryableReasons = [
		"materialized_head_unavailable",
		"materialized_run_snapshot_unavailable",
		"materialized_review_node_unavailable",
		"materialized_producer_unavailable",
		"execution_runtime_unavailable",
		"producer_runtime_unavailable",
		"producer_not_found",
		"head_unavailable",
		"git_head_unavailable",
		"decision_authority_unavailable",
		"invalid_server_clock",
	] as const;

	function stubBaseEnv(): void {
		vi.stubEnv("FLYWHEEL_EXEC_ID", "qa-engine");
		vi.stubEnv("FLYWHEEL_ISSUE_ID", "FLY-1425");
		vi.stubEnv("FLYWHEEL_PROJECT_NAME", "flywheel");
		vi.stubEnv("FLYWHEEL_BRIDGE_URL", "http://127.0.0.1:9876");
	}

	function stubFastFailureExit(): ReturnType<typeof vi.spyOn> {
		vi.spyOn(globalThis, "setTimeout").mockImplementation(((
			callback: () => void,
		) => {
			callback();
			return 0;
		}) as typeof setTimeout);
		return vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("exit:1");
		}) as never);
	}

	it.each(deterministicReasons)(
		"classifies stable deterministic reason %s as fail",
		(reason) => {
			expect(classifyQaResultRejection(reason)).toBe("fail");
		},
	);

	it.each(retryableReasons)(
		"classifies recoverable reason %s as retry",
		(reason) => {
			expect(classifyQaResultRejection(reason)).toBe("retry");
		},
	);

	it("keeps unknown server reasons retryable for forward compatibility", () => {
		expect(classifyQaResultRejection("new_bridge_reason")).toBe("retry");
		expect(classifyQaResultRejection(undefined)).toBe("retry");
	});

	it("refuses locally when an engine credential was expected but is missing", async () => {
		stubBaseEnv();
		vi.stubEnv("FLYWHEEL_WORKFLOW_SUBMISSION_EXPECTED", "1");
		vi.stubEnv("FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL", "");
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const exit = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("exit:1");
		}) as never);

		await expect(
			qaResult({
				status: "pass",
				targetExec: "impl-1",
				prHeadSha: "a".repeat(40),
			}),
		).rejects.toThrow("exit:1");
		expect(exit).toHaveBeenCalledWith(1);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("requires a credential regardless of the legacy expected sentinel value", async () => {
		stubBaseEnv();
		vi.stubEnv("FLYWHEEL_WORKFLOW_SUBMISSION_EXPECTED", "true");
		vi.stubEnv("FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL", "");
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const exit = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("exit:1");
		}) as never);

		await expect(
			qaResult({
				status: "pass",
				targetExec: "impl-1",
				prHeadSha: "a".repeat(40),
			}),
		).rejects.toThrow("exit:1");
		expect(exit).toHaveBeenCalledWith(1);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("fails immediately on a deterministic reason and accepts the legacy error field", async () => {
		const home = mkdtempSync(join(tmpdir(), "fly1655-qa-marker-"));
		stubBaseEnv();
		vi.stubEnv("HOME", home);
		vi.stubEnv("FLYWHEEL_WORKFLOW_SUBMISSION_EXPECTED", "1");
		vi.stubEnv("FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL", "scoped-secret");
		const fetchMock = vi.fn().mockImplementation(
			async () =>
				new Response(JSON.stringify({ ok: false, error: "invalid_request" }), {
					status: 409,
				}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const exit = stubFastFailureExit();

		await expect(
			qaResult({
				status: "pass",
				targetExec: "impl-1",
				prHeadSha: "a".repeat(40),
			}),
		).rejects.toThrow("exit:1");
		expect(exit).toHaveBeenCalledWith(1);
		expect(fetchMock).toHaveBeenCalledOnce();
		const markerPath = join(
			home,
			".flywheel",
			"state",
			"qa-result-failed",
			"qa-engine.json",
		);
		expect(statSync(markerPath).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(markerPath, "utf8"))).toMatchObject({
			status: "pass",
		});
		expect(readFileSync(markerPath, "utf8")).not.toContain("scoped-secret");
		rmSync(home, { recursive: true, force: true });
	});

	it("renders structured rejection detail without terminal controls or secrets", async () => {
		const home = mkdtempSync(join(tmpdir(), "fly1686-qa-detail-"));
		stubBaseEnv();
		vi.stubEnv("HOME", home);
		vi.stubEnv("FLYWHEEL_WORKFLOW_SUBMISSION_EXPECTED", "1");
		vi.stubEnv("FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL", "scoped-secret");
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						ok: false,
						reason: "land_gate_entry_sealed_manifest_stale",
						detail: {
							offendingPath: "packages/\ndanger.ts",
							credential: "must-not-print",
							long: "x".repeat(2_000),
						},
					}),
					{ status: 409 },
				),
			),
		);
		stubFastFailureExit();
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(
			qaResult({
				status: "pass",
				targetExec: "impl-1",
				prHeadSha: "a".repeat(40),
			}),
		).rejects.toThrow("exit:1");
		const rendered = error.mock.calls.flat().join("\n");
		expect(rendered).toContain("detail=");
		expect(rendered).toContain("packages/?danger.ts");
		expect(rendered).toContain("[redacted]");
		expect(rendered).toContain("[truncated]");
		expect(rendered).not.toContain("must-not-print");
		expect(rendered).not.toContain("packages/\ndanger.ts");
		rmSync(home, { recursive: true, force: true });
	});

	it("explains replay_payload_mismatch without claiming the current verdict landed", async () => {
		stubBaseEnv();
		vi.stubEnv("FLYWHEEL_WORKFLOW_SUBMISSION_EXPECTED", "1");
		vi.stubEnv("FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL", "scoped-secret");
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				new Response(
					JSON.stringify({ ok: false, reason: "replay_payload_mismatch" }),
					{ status: 409 },
				),
			);
		vi.stubGlobal("fetch", fetchMock);
		stubFastFailureExit();
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(
			qaResult({
				status: "fail",
				targetExec: "impl-1",
				prHeadSha: "a".repeat(40),
			}),
		).rejects.toThrow("exit:1");
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(error).toHaveBeenCalledWith(
			expect.stringContaining(
				"does NOT prove the current verdict was recorded",
			),
		);
	});

	it.each([
		[409, { ok: false, reason: "new_bridge_reason" }],
		[503, { ok: false, reason: "invalid_request" }],
	] as const)(
		"keeps bounded retry for HTTP %s recoverable responses",
		async (status, body) => {
			stubBaseEnv();
			vi.stubEnv("FLYWHEEL_WORKFLOW_SUBMISSION_EXPECTED", "1");
			vi.stubEnv("FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL", "scoped-secret");
			const fetchMock = vi
				.fn()
				.mockImplementation(
					async () => new Response(JSON.stringify(body), { status }),
				);
			vi.stubGlobal("fetch", fetchMock);
			stubFastFailureExit();

			await expect(
				qaResult({
					status: "pass",
					targetExec: "impl-1",
					prHeadSha: "a".repeat(40),
				}),
			).rejects.toThrow("exit:1");
			expect(fetchMock).toHaveBeenCalledTimes(4);
		},
	);

	it("accepts only a shaped decision acknowledgement before claiming consumption", async () => {
		stubBaseEnv();
		vi.stubEnv("FLYWHEEL_WORKFLOW_SUBMISSION_EXPECTED", "1");
		vi.stubEnv("FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL", "scoped-secret");
		const fetchMock = vi.fn().mockImplementation(
			async () =>
				new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);
		vi.stubGlobal("fetch", fetchMock);
		vi.spyOn(globalThis, "setTimeout").mockImplementation(((
			callback: () => void,
		) => {
			callback();
			return 0;
		}) as typeof setTimeout);
		const exit = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("exit:1");
		}) as never);

		await expect(
			qaResult({
				status: "pass",
				targetExec: "impl-1",
				prHeadSha: "a".repeat(40),
			}),
		).rejects.toThrow("exit:1");
		expect(exit).toHaveBeenCalledWith(1);
		expect(fetchMock).toHaveBeenCalledTimes(4);
	});

	it("prints an honest decision-consumed message only for a shaped ack", async () => {
		stubBaseEnv();
		vi.stubEnv("FLYWHEEL_WORKFLOW_SUBMISSION_EXPECTED", "1");
		vi.stubEnv("FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL", "scoped-secret");
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						ok: true,
						claimId: 42,
						serverSeq: 7,
						idempotentReplay: false,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			),
		);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await qaResult({
			status: "pass",
			targetExec: "impl-1",
			prHeadSha: "a".repeat(40),
		});

		expect(log).toHaveBeenCalledWith(
			expect.stringContaining(
				"decision consumed (claimId=42 serverSeq=7 idempotentReplay=false)",
			),
		);
		expect(log).not.toHaveBeenCalledWith(expect.stringContaining("delivered"));
	});
});
