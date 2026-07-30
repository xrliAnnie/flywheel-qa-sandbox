import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeLaunchRequest } from "../runtime-ports.js";
import {
	type TmuxCommandPort,
	TmuxRunnerLauncher,
} from "../tmux-runner-launcher.js";

function activationKey(activationId: string): string {
	return createHash("sha256").update(activationId).digest("hex");
}

function claudeConfigDir(request: RuntimeLaunchRequest): string {
	return join(
		dirname(request.context.projectRoot),
		"injection",
		"claude",
		activationKey(request.activationId),
	);
}

describe("v2-native tmux runner launcher", () => {
	let root: string | undefined;

	function fixture(
		vendor = "claude",
		injectionRootOverride?: (root: string) => string,
		overrides: { processStart?: (pid: number) => string | null } = {},
	): {
		claudeCredentialsPath: string;
		request: RuntimeLaunchRequest;
		command: TmuxCommandPort;
		calls: Array<{ file: string; args: string[] }>;
		launcher: TmuxRunnerLauncher;
		releaseRoot: string;
		stateRoot: string;
	} {
		root = mkdtempSync(join("/tmp", "flywheel-v2-tmux-launcher-"));
		const initialProjectRoot = join(root, "project");
		const initialRolePath = join(
			initialProjectRoot,
			".flywheel",
			"roles",
			"engineer.md",
		);
		mkdirSync(join(initialProjectRoot, ".flywheel", "roles"), {
			recursive: true,
		});
		const role = "# Engineer\nPinned role.\n";
		writeFileSync(initialRolePath, role);
		const projectRoot = realpathSync(initialProjectRoot);
		const rolePath = realpathSync(initialRolePath);
		const sessionRef =
			"v2dag:11111111-1111-4111-8111-111111111111:1:22222222-2222-4222-8222-222222222222";
		const calls: Array<{ file: string; args: string[] }> = [];
		let present = false;
		let presentSessionRef = sessionRef;
		const command: TmuxCommandPort = {
			async run(file, args) {
				calls.push({ file, args });
				if (args.includes("has-session")) {
					if (!present) {
						const error = new Error("can't find session") as Error & {
							code: number;
							stderr: string;
						};
						error.code = 1;
						error.stderr = "can't find session";
						throw error;
					}
					return { stdout: "", stderr: "" };
				}
				if (args.includes("new-session")) {
					present = true;
					presentSessionRef =
						args
							.find((arg) => arg.startsWith("FLYWHEEL_V2_SESSION_REF="))
							?.slice("FLYWHEEL_V2_SESSION_REF=".length) ?? sessionRef;
					const session = args[args.indexOf("-s") + 1];
					return { stdout: `${session}:@0\n`, stderr: "" };
				}
				if (args.includes("show-environment")) {
					return {
						stdout: `FLYWHEEL_V2_SESSION_REF=${presentSessionRef}\n`,
						stderr: "",
					};
				}
				if (args.includes("display-message")) {
					return { stdout: `${process.pid}|0\n`, stderr: "" };
				}
				if (args.includes("kill-session")) {
					present = false;
					return { stdout: "", stderr: "" };
				}
				return { stdout: "", stderr: "" };
			},
		};
		const releaseRoot = join(root, "release");
		const stateRoot = join(root, "state");
		// Codex R4 MEDIUM-2: a per-activation config dir needs working credentials or
		// the runner parks on a login screen. Model the operator-provisioned source.
		const claudeCredentialsPath = join(root, "operator-credentials.json");
		writeFileSync(
			claudeCredentialsPath,
			JSON.stringify({ claudeAiOauth: { accessToken: "fixture-token" } }),
			{ mode: 0o600 },
		);
		const launcher = new TmuxRunnerLauncher({
			hostEpoch: "host-a",
			tmuxBin: "/usr/local/bin/tmux",
			claudeBin: "/opt/flywheel/bin/claude",
			codexBin: "/opt/flywheel/bin/codex",
			clientCliPath: "/opt/flywheel/v2-cli.js",
			socketPath: join(root, "host.sock"),
			secretPath: join(root, "host.secret"),
			sessionProofRoot: join(root, "proofs"),
			releaseRoot,
			stateRoot,
			injectionRoot: injectionRootOverride
				? injectionRootOverride(root)
				: join(root, "injection"),
			claudeCredentialsPath,
			command,
			now: () => new Date("2026-07-28T01:00:00.000Z"),
			processStart:
				overrides.processStart ?? (() => "Mon Jul 28 01:00:00 2026"),
			// Keep the contention test's wait observable without spending the
			// production budget on every run.
			onboardingLockTimeoutMs: 1_500,
		});
		return {
			claudeCredentialsPath,
			request: {
				taskId: "task-1",
				attemptId: "attempt-1",
				attemptGeneration: 1,
				activationId: "activation-1",
				sessionRef,
				// FLY-1544 ①: the node kind selects the instruction book and names.
				taskKind: "engineer",
				ownerToken: "owner-1",
				agent: {
					kind: "runner",
					agentId: sessionRef,
					instanceId: sessionRef,
					generation: 1,
					activationId: "activation-1",
				},
				executor: {
					family: `${vendor}-family`,
					vendor,
					model: "test-model",
					effort: "high",
				},
				context: {
					projectId: "flywheel",
					issueId: "FLY-1502",
					projectRoot,
					firstEnvelope: JSON.stringify({
						v: 1,
						message: { messageUid: "message-1", payload: "build it" },
					}),
					instruction: {
						projectRoot,
						sourcePath: rolePath,
						contentDigest: createHash("sha256").update(role).digest("hex"),
						contentBytes: Buffer.byteLength(role),
					},
				},
			},
			command,
			calls,
			launcher,
			releaseRoot,
			stateRoot,
		};
	}

	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
		root = undefined;
	});

	it("starts Claude as a windowed TUI with pinned role and first envelope", async () => {
		const target = fixture("claude");
		const binding = await target.launcher.launch(target.request);
		expect(binding).toMatchObject({
			hostEpoch: "host-a",
			sessionId: target.request.sessionRef,
			pid: process.pid,
		});
		const create = target.calls.find((call) =>
			call.args.includes("new-session"),
		);
		expect(create?.args).toContain("/opt/flywheel/bin/claude");
		const cleanEnvIndex = create?.args.indexOf("/usr/bin/env") ?? -1;
		expect(cleanEnvIndex).toBeGreaterThan(-1);
		expect(create?.args[cleanEnvIndex + 1]).toBe("-i");
		expect(create?.args).toContain("--append-system-prompt-file");
		expect(create?.args).toContain(
			target.request.context.instruction.sourcePath,
		);
		expect(create?.args).toContain("--session-id");
		expect(create?.args).toContain("--name");
		expect(create?.args).not.toContain("--agent-id");
		expect(create?.args).not.toContain("--agent-name");
		expect(create?.args).not.toContain("--team-name");
		expect(create?.args.join(" ")).not.toContain("agent-teams");
		expect(create?.args.join(" ")).toContain(
			`CLAUDE_CONFIG_DIR=${join(
				root as string,
				"injection",
				"claude",
				activationKey("activation-1"),
			)}`,
		);
		expect(create?.args.join(" ")).not.toContain(" next ");
		expect(create?.args.join(" ")).not.toContain("comm.db");
		// FLY-1544 ②: the executing vendor rides the session environment so the
		// node manual's cross-vendor review rule can name the other vendor.
		expect(create?.args).toContain("FLYWHEEL_V2_VENDOR=claude");
		expect(create?.args.at(-1)).toContain('"messageUid":"message-1"');
		expect(existsSync(join(claudeConfigDir(target.request), "teams"))).toBe(
			false,
		);
		const proofFiles = readFileSync(
			join(
				root as string,
				"proofs",
				`${createHash("sha256")
					.update(target.request.sessionRef)
					.digest("hex")}.json`,
			),
			"utf8",
		);
		expect(JSON.parse(proofFiles)).toMatchObject({
			session_id: target.request.sessionRef,
			pid: process.pid,
		});

		await target.launcher.activate(target.request.sessionRef);
		const releaseFiles = await import("node:fs").then(({ readdirSync }) =>
			readdirSync(target.releaseRoot),
		);
		expect(releaseFiles).toHaveLength(1);
		expect((await target.launcher.probe(target.request.sessionRef)).state).toBe(
			"present",
		);
	});

	it("starts Codex as a founder-visible TUI with the role and first envelope in its initial prompt", async () => {
		const target = fixture("codex");
		await target.launcher.launch(target.request);
		const create = target.calls.find((call) =>
			call.args.includes("new-session"),
		);
		expect(create?.args).toContain("/opt/flywheel/bin/codex");
		expect(create?.args).not.toContain("app-server");
		expect(create?.args).not.toContain("--remote-control");
		expect(create?.args).not.toContain("--listen");
		expect(create?.args).toContain("-C");
		expect(create?.args).toContain(target.request.context.projectRoot);
		expect(create?.args).toContain("-m");
		expect(create?.args).toContain("test-model");
		expect(create?.args).toContain("-s");
		expect(create?.args).toContain("workspace-write");
		expect(create?.args).toContain("-a");
		expect(create?.args).toContain("never");
		expect(create?.args).toContain('model_reasoning_effort="high"');
		const initialPrompt = create?.args.at(-1);
		expect(initialPrompt).toContain("# Engineer\nPinned role.");
		expect(initialPrompt).toContain(
			"Flywheel v2 runner bootstrap for FLY-1502.",
		);
		expect(initialPrompt).toContain('"messageUid":"message-1"');
		expect(create?.args.join(" ")).not.toContain("comm.db");
		expect(create?.args).toContain("FLYWHEEL_V2_VENDOR=codex");
		await target.launcher.activate(target.request.sessionRef);
		const stateFile = join(
			target.stateRoot,
			`${createHash("sha256")
				.update(target.request.sessionRef)
				.digest("hex")}.json`,
		);
		expect(statSync(stateFile).mode & 0o777).toBe(0o600);
		const state = JSON.parse(readFileSync(stateFile, "utf8"));
		expect(state).toMatchObject({
			session_ref: target.request.sessionRef,
			vendor: "codex",
		});
		expect(state).not.toHaveProperty("thread_id");
		expect(readdirSync(target.stateRoot)).toHaveLength(1);
	});

	it("FLY-1544 doorbell: delivers by buffer paste + Enter, and fails loud on an absent session", async () => {
		const target = fixture("claude");
		await expect(
			target.launcher.deliver(target.request.sessionRef, "hello"),
		).rejects.toThrow(/session is absent/);
		await target.launcher.launch(target.request);
		target.calls.length = 0;
		await target.launcher.deliver(
			target.request.sessionRef,
			"line one\nline two",
		);
		const [setBuffer, pasteBuffer, sendKeys] = target.calls.filter(
			(call) => !call.args.includes("has-session"),
		);
		expect(setBuffer?.args).toContain("set-buffer");
		expect(setBuffer?.args.at(-1)).toBe("line one\nline two");
		expect(pasteBuffer?.args).toContain("paste-buffer");
		// Bracketed paste keeps the multi-line payload one input.
		expect(pasteBuffer?.args).toContain("-p");
		expect(sendKeys?.args).toContain("send-keys");
		expect(sendKeys?.args).toContain("Enter");
		await target.launcher.stop(target.request.sessionRef);
	});

	it("fails closed before tmux for unknown vendors or changed role content", async () => {
		const unknown = fixture("other");
		await expect(unknown.launcher.launch(unknown.request)).rejects.toThrow(
			/unsupported runner vendor/i,
		);
		expect(
			unknown.calls.some((call) => call.args.includes("new-session")),
		).toBe(false);

		const changed = fixture("claude");
		writeFileSync(
			changed.request.context.instruction.sourcePath,
			"# Changed\n",
		);
		chmodSync(changed.request.context.instruction.sourcePath, 0o600);
		await expect(changed.launcher.launch(changed.request)).rejects.toThrow(
			/role instruction changed/i,
		);
		expect(
			changed.calls.some((call) => call.args.includes("new-session")),
		).toBe(false);
	});

	it("addresses set-option with a trailing colon so tmux 3.5a resolves the session", async () => {
		const target = fixture("claude");
		await target.launcher.launch(target.request);
		const setOptions = target.calls.filter((call) =>
			call.args.includes("set-option"),
		);
		expect(setOptions.length).toBeGreaterThan(0);
		for (const call of setOptions) {
			const targetIndex = call.args.indexOf("-t");
			expect(targetIndex).toBeGreaterThan(-1);
			// tmux 3.5a rejects `set-option -t =name` with "no such session" even
			// though `has-session -t =name` resolves it; a session target needs the
			// trailing colon. Exact-match `=` is kept so a prefix cannot collide --
			// the operator shim at ~/.flywheel/v2/bin/tmux-eq-shim.sh worked around
			// this by stripping `=`, which gives up exact matching.
			expect(call.args[targetIndex + 1]).toMatch(/^=.+:$/);
		}
		// has-session is unaffected and must keep the bare exact-match form.
		const hasSession = target.calls.find((call) =>
			call.args.includes("has-session"),
		);
		const hasIndex = hasSession?.args.indexOf("-t") ?? -1;
		expect(hasSession?.args[hasIndex + 1]).toMatch(/^=[^:]+$/);
	});

	it("preseeds the isolated Claude config so no first-run screen blocks the spawn", async () => {
		const target = fixture("claude");
		await target.launcher.launch(target.request);
		const statePath = join(claudeConfigDir(target.request), ".claude.json");
		const state = JSON.parse(readFileSync(statePath, "utf8")) as {
			hasCompletedOnboarding?: boolean;
			bypassPermissionsModeAccepted?: boolean;
			projects?: Record<string, Record<string, boolean>>;
		};
		// RED before the fix: the isolated CLAUDE_CONFIG_DIR held no onboarding
		// state, so the runner sat on the theme / trust / bypass-permissions
		// screens with nobody to answer them.
		expect(state.hasCompletedOnboarding).toBe(true);
		expect(state.bypassPermissionsModeAccepted).toBe(true);
		expect(state.projects?.[target.request.context.projectRoot]).toMatchObject({
			hasTrustDialogAccepted: true,
			hasCompletedProjectOnboarding: true,
		});
	});

	it("preserves existing isolated Claude config state when preseeding", async () => {
		const target = fixture("claude");
		const dir = claudeConfigDir(target.request);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, ".claude.json"),
			`${JSON.stringify({
				numStartups: 7,
				projects: { "/other/repo": { hasTrustDialogAccepted: true } },
			})}\n`,
		);
		await target.launcher.launch(target.request);
		const state = JSON.parse(
			readFileSync(join(dir, ".claude.json"), "utf8"),
		) as {
			numStartups?: number;
			projects?: Record<string, Record<string, boolean>>;
		};
		// Onboarding history and unrelated projects must survive the merge.
		expect(state.numStartups).toBe(7);
		expect(state.projects?.["/other/repo"]).toMatchObject({
			hasTrustDialogAccepted: true,
		});
		expect(state.projects?.[target.request.context.projectRoot]).toMatchObject({
			hasTrustDialogAccepted: true,
		});
	});

	it("refuses to merge an isolated Claude config that is not a regular file", async () => {
		// Codex R1 MEDIUM-5: readFileSync follows symlinks, so a link pointing at
		// credentials would have its contents merged into the new file, and a FIFO
		// would block the launcher outright.
		const target = fixture("claude");
		const dir = claudeConfigDir(target.request);
		mkdirSync(dir, { recursive: true });
		const secret = join(dir, "secret-source.json");
		writeFileSync(secret, `${JSON.stringify({ stolen: true })}\n`);
		symlinkSync(secret, join(dir, ".claude.json"));
		await expect(target.launcher.launch(target.request)).rejects.toThrow(
			/not a regular file/,
		);
	});

	it("refuses a config dir reached through a symlinked parent", async () => {
		// Codex R2 MEDIUM-4: resolve() is only lexical, so a symlinked ancestor
		// inside the root passed the old check while the write landed outside it.
		const target = fixture("claude");
		// configDir is now <injectionRoot>/claude/<activationKey>, so the injection
		// root is two levels up -- and `outside` must be outside THAT, or the
		// symlink target is legitimately contained and the test proves nothing.
		const configDir = claudeConfigDir(target.request);
		const injectionRoot = dirname(dirname(configDir));
		const outside = join(dirname(injectionRoot), "outside-config");
		mkdirSync(dirname(configDir), { recursive: true });
		mkdirSync(outside, { recursive: true });
		symlinkSync(outside, configDir);
		await expect(target.launcher.launch(target.request)).rejects.toThrow(
			/escapes the configured injection root/,
		);
		expect(existsSync(join(outside, ".claude.json"))).toBe(false);
	});

	it("isolates Claude config per activation without reading a vendor inbox ref", async () => {
		const target = fixture("claude");
		const configDir = claudeConfigDir(target.request);
		expect(configDir).toBe(
			join(
				realpathSync(root as string),
				"injection",
				"claude",
				activationKey("activation-1"),
			),
		);
		await target.launcher.launch(target.request);
		expect(existsSync(join(configDir, ".claude.json"))).toBe(true);

		const rebound: RuntimeLaunchRequest = {
			...target.request,
			activationId: "activation-2",
			sessionRef:
				"v2dag:11111111-1111-4111-8111-111111111111:1:33333333-3333-4333-8333-333333333333",
			agent: {
				...target.request.agent,
				agentId:
					"v2dag:11111111-1111-4111-8111-111111111111:1:33333333-3333-4333-8333-333333333333",
				instanceId:
					"v2dag:11111111-1111-4111-8111-111111111111:1:33333333-3333-4333-8333-333333333333",
				activationId: "activation-2",
			},
		};
		const secondConfigDir = claudeConfigDir(rebound);
		expect(secondConfigDir).not.toBe(configDir);
		expect(secondConfigDir).toContain(activationKey("activation-2"));
		await target.launcher.stop(target.request.sessionRef);
		await expect(target.launcher.launch(rebound)).resolves.toMatchObject({
			hostEpoch: "host-a",
		});
		expect(existsSync(join(secondConfigDir, ".claude.json"))).toBe(true);
	});

	it("waits for a live onboarding lock and refuses rather than robbing it", async () => {
		// Codex R3 MEDIUM-5: the old lock had NO wait between its 50 attempts (so it
		// burned them instantly and failed on brief contention) and deleted any lock
		// older than 30s with no ownership check, so it could unlink a live holder's
		// lock -- or a later holder's, having judged staleness from an earlier one.
		const target = fixture("claude");
		const configDir = claudeConfigDir(target.request);
		mkdirSync(configDir, { recursive: true, mode: 0o700 });
		const lockPath = join(configDir, ".claude.json.fly1503.lock");
		// A holder that is unambiguously LIVE: this very process, with the start
		// identity the fixture's probe reports.
		writeFileSync(
			lockPath,
			`${JSON.stringify({
				v: 1,
				token: "live-holder",
				pid: process.pid,
				pidStart: "Mon Jul 28 01:00:00 2026",
				acquiredAt: new Date(Date.now() - 600_000).toISOString(),
			})}\n`,
			{ mode: 0o600 },
		);
		const started = Date.now();
		await expect(target.launcher.launch(target.request)).rejects.toThrow(
			/locked by another launcher \(holder live-holder\)/,
		);
		// It waited rather than failing instantly, and it left the live lock alone
		// even though the recorded acquisition is 10 minutes old.
		expect(Date.now() - started).toBeGreaterThanOrEqual(1_400);
		expect(existsSync(lockPath)).toBe(true);
		expect(
			(JSON.parse(readFileSync(lockPath, "utf8")) as { token: string }).token,
		).toBe("live-holder");
	});

	it("links every activation to the one live operator credential", async () => {
		const target = fixture("claude");
		await target.launcher.launch(target.request);
		const credentials = join(
			claudeConfigDir(target.request),
			".credentials.json",
		);
		expect(lstatSync(credentials).isSymbolicLink()).toBe(true);
		expect(realpathSync(credentials)).toBe(
			realpathSync(target.claudeCredentialsPath),
		);
		expect(
			JSON.parse(readFileSync(credentials, "utf8")) as {
				claudeAiOauth: { accessToken: string };
			},
		).toMatchObject({ claudeAiOauth: { accessToken: "fixture-token" } });
	});

	it("re-points a replaced activation credential to the live source on relaunch", async () => {
		const target = fixture("claude");
		await target.launcher.launch(target.request);
		const credentials = join(
			claudeConfigDir(target.request),
			".credentials.json",
		);
		rmSync(credentials);
		writeFileSync(
			credentials,
			JSON.stringify({ claudeAiOauth: { accessToken: "rotated-token" } }),
			{ mode: 0o600 },
		);
		await target.launcher.stop(target.request.sessionRef);
		await target.launcher.launch(target.request);
		expect(lstatSync(credentials).isSymbolicLink()).toBe(true);
		expect(realpathSync(credentials)).toBe(
			realpathSync(target.claudeCredentialsPath),
		);
		expect(
			JSON.parse(readFileSync(credentials, "utf8")) as {
				claudeAiOauth: { accessToken: string };
			},
		).toMatchObject({ claudeAiOauth: { accessToken: "fixture-token" } });
	});

	it("fails closed before tmux when the live credential is missing", async () => {
		const target = fixture("claude");
		rmSync(target.claudeCredentialsPath);
		await expect(target.launcher.launch(target.request)).rejects.toThrow(
			/Claude credentials are missing at .*provision them once/,
		);
		expect(target.calls.some((call) => call.args.includes("new-session"))).toBe(
			false,
		);
		expect(
			existsSync(join(claudeConfigDir(target.request), ".credentials.json")),
		).toBe(false);
	});

	it("refuses a credentials source that is itself a symlink", async () => {
		// Following a link here would let anything able to create one aim the runner
		// at another file entirely.
		const target = fixture("claude");
		const elsewhere = join(root as string, "elsewhere-credentials.json");
		writeFileSync(elsewhere, JSON.stringify({ token: "other" }), {
			mode: 0o600,
		});
		rmSync(target.claudeCredentialsPath);
		symlinkSync(elsewhere, target.claudeCredentialsPath);
		await expect(target.launcher.launch(target.request)).rejects.toThrow(
			/must be a regular file/,
		);
	});

	it("does not spin forever on an unparseable onboarding lock", async () => {
		// Codex R4 MEDIUM-3: an unparseable lock read back as `null`, and that path
		// `continue`d WITHOUT checking the deadline -- so this loop ran at full speed
		// forever. A zero-byte lock was reachable in practice because the lock used to
		// be created and then written in two steps.
		const target = fixture("claude");
		const configDir = claudeConfigDir(target.request);
		mkdirSync(configDir, { recursive: true, mode: 0o700 });
		const lockPath = join(configDir, ".claude.json.fly1503.lock");
		writeFileSync(lockPath, "", { mode: 0o600 });
		const started = Date.now();
		await expect(target.launcher.launch(target.request)).rejects.toThrow(
			/locked by another launcher/,
		);
		// Bounded by the configured budget rather than unbounded, and it waited
		// rather than burning attempts instantly.
		expect(Date.now() - started).toBeGreaterThanOrEqual(1_400);
		expect(Date.now() - started).toBeLessThan(10_000);
	});

	it("never leaves a zero-byte onboarding lock behind", async () => {
		// The lock content is staged and linked into place, so the file can never be
		// observed empty -- which is what made the unparseable case above reachable.
		const target = fixture("claude");
		const configDir = claudeConfigDir(target.request);
		await target.launcher.launch(target.request);
		expect(
			readdirSync(configDir).filter((entry) => entry.includes(".staging.")),
		).toEqual([]);
		expect(existsSync(join(configDir, ".claude.json.fly1503.lock"))).toBe(
			false,
		);
	});

	it("keeps a live holder's lock when the process probe cannot answer", async () => {
		// Codex R4 MEDIUM-3: a `null` probe result conflates "the pid is gone" with
		// "the probe could not answer" -- the fail-open fixed one layer up in R3
		// HIGH-1 and reintroduced here. A transient probe failure must not hand this
		// launcher a lock another process is still holding.
		const target = fixture("claude", undefined, { processStart: () => null });
		const configDir = claudeConfigDir(target.request);
		mkdirSync(configDir, { recursive: true, mode: 0o700 });
		const lockPath = join(configDir, ".claude.json.fly1503.lock");
		writeFileSync(
			lockPath,
			`${JSON.stringify({
				v: 1,
				token: "live-but-unprobable",
				pid: process.pid,
				pidStart: "Mon Jul 28 01:00:00 2026",
				acquiredAt: new Date(Date.now()).toISOString(),
			})}\n`,
			{ mode: 0o600 },
		);
		await expect(target.launcher.launch(target.request)).rejects.toThrow(
			/locked by another launcher \(holder live-but-unprobable\)/,
		);
		expect(
			(JSON.parse(readFileSync(lockPath, "utf8")) as { token: string }).token,
		).toBe("live-but-unprobable");
	});

	it("fails closed rather than seizing a live lock on age when the probe is unavailable", async () => {
		// Codex R5 MEDIUM-3: falling through to the age rule when the probe could not
		// answer was the same fail-open with a two-minute delay. A live holder blocked
		// for two minutes plus one transient /bin/ps failure in the other launcher, and
		// the live lock was taken -- two processes writing one onboarding state.
		const target = fixture("claude", undefined, { processStart: () => null });
		const configDir = claudeConfigDir(target.request);
		mkdirSync(configDir, { recursive: true, mode: 0o700 });
		const lockPath = join(configDir, ".claude.json.fly1503.lock");
		writeFileSync(
			lockPath,
			`${JSON.stringify({
				v: 1,
				token: "live-and-old",
				pid: process.pid,
				pidStart: "Mon Jul 28 01:00:00 2026",
				// Well past the stale threshold: age must NOT be enough on its own.
				acquiredAt: new Date(Date.now() - 600_000).toISOString(),
			})}\n`,
			{ mode: 0o600 },
		);
		await expect(target.launcher.launch(target.request)).rejects.toThrow(
			/locked by another launcher \(holder live-and-old\)/,
		);
		expect(
			(JSON.parse(readFileSync(lockPath, "utf8")) as { token: string }).token,
		).toBe("live-and-old");
	});

	it("still reclaims an unattributable lock on age", async () => {
		// The one case age may decide: a lock naming no process, which this code cannot
		// create but an older build could. Without this it would wedge every launch.
		const target = fixture("claude");
		const configDir = claudeConfigDir(target.request);
		mkdirSync(configDir, { recursive: true, mode: 0o700 });
		const lockPath = join(configDir, ".claude.json.fly1503.lock");
		writeFileSync(lockPath, "this is not json\n", { mode: 0o600 });
		const old = new Date(Date.now() - 600_000);
		utimesSync(lockPath, old, old);
		await expect(target.launcher.launch(target.request)).resolves.toMatchObject(
			{
				hostEpoch: "host-a",
			},
		);
		expect(existsSync(lockPath)).toBe(false);
	});

	it("reclaims an onboarding lock whose owner process is gone", async () => {
		const target = fixture("claude");
		const configDir = claudeConfigDir(target.request);
		mkdirSync(configDir, { recursive: true, mode: 0o700 });
		const lockPath = join(configDir, ".claude.json.fly1503.lock");
		// Same pid, but a start identity that does not match what the probe reports:
		// positive evidence that this is a different process, so the lock is stale
		// no matter how recently it was taken.
		writeFileSync(
			lockPath,
			`${JSON.stringify({
				v: 1,
				token: "dead-holder",
				pid: process.pid,
				pidStart: "Sun Jan 01 00:00:00 2020",
				acquiredAt: new Date(Date.now()).toISOString(),
			})}\n`,
			{ mode: 0o600 },
		);
		await expect(target.launcher.launch(target.request)).resolves.toMatchObject(
			{
				hostEpoch: "host-a",
			},
		);
		// Reclaimed, used, and released -- with no quarantine file left behind.
		expect(existsSync(lockPath)).toBe(false);
		expect(
			readdirSync(configDir).filter((entry) => entry.includes(".stale.")),
		).toEqual([]);
		expect(
			JSON.parse(readFileSync(join(configDir, ".claude.json"), "utf8")),
		).toMatchObject({ hasCompletedOnboarding: true });
	});
});
