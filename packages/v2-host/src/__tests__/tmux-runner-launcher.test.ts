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
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";
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
	const ref = JSON.parse(request.injectionRef) as { inboxPath: string };
	// .../<configDir>/teams/<team>/inboxes/<agent>.json -- same four levels the
	// launcher's own parseClaudeTarget walks up.
	return dirname(dirname(dirname(dirname(ref.inboxPath))));
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
		claudeDeliveries: Array<{
			sessionRef: string;
			message: { messageUid: string; attemptUid: string; payload: string };
		}>;
		codexThreads: Array<{
			socketPath: string;
			threadId: string | null;
			cwd: string;
			model: string;
			baseInstructions: string;
		}>;
		codexDeliveries: Array<{
			sessionRef: string;
			message: { messageUid: string; attemptUid: string; payload: string };
		}>;
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
					const session = args[args.indexOf("-s") + 1];
					return { stdout: `${session}:@0\n`, stderr: "" };
				}
				if (args.includes("show-environment")) {
					return {
						stdout: `FLYWHEEL_V2_SESSION_REF=${sessionRef}\n`,
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
		const injectionRoot = join(root, "injection");
		// Codex R4 MEDIUM-2: a per-activation config dir needs working credentials or
		// the runner parks on a login screen. Model the operator-provisioned source.
		const claudeCredentialsPath = join(root, "operator-credentials.json");
		writeFileSync(
			claudeCredentialsPath,
			JSON.stringify({ claudeAiOauth: { accessToken: "fixture-token" } }),
			{ mode: 0o600 },
		);
		const claudeDeliveries: Array<{
			sessionRef: string;
			message: { messageUid: string; attemptUid: string; payload: string };
		}> = [];
		const codexThreads: Array<{
			socketPath: string;
			threadId: string | null;
			cwd: string;
			model: string;
			baseInstructions: string;
		}> = [];
		const codexDeliveries: Array<{
			sessionRef: string;
			message: { messageUid: string; attemptUid: string; payload: string };
		}> = [];
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
			claudeDeliver: async (sessionRef, message) => {
				claudeDeliveries.push({ sessionRef, message });
			},
			codexControl: {
				async ensureThread(input) {
					codexThreads.push(input);
					return input.threadId ?? "actual-codex-thread";
				},
				async deliver(sessionRef, message) {
					codexDeliveries.push({ sessionRef, message });
				},
			},
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
				injectionRef:
					vendor === "codex"
						? JSON.stringify({
								v: 1,
								backend: "codex",
								socketPath: join(injectionRoot, "codex", "runner.sock"),
								threadId: sessionRef,
							})
						: JSON.stringify({
								v: 1,
								backend: "claude",
								// Codex R3 MEDIUM-5/7: the shape the builder now emits --
								// <root>/claude/<sha256(activationId)>/teams/...
								inboxPath: join(
									injectionRoot,
									"claude",
									activationKey("activation-1"),
									"teams",
									"v2-engineer",
									"inboxes",
									"engineer.json",
								),
								sidecarPath: join(
									injectionRoot,
									"claude",
									activationKey("activation-1"),
									"teams",
									"v2-engineer",
									"inboxes",
									"engineer.json.flywheel.jsonl",
								),
								toAgent: "engineer",
							}),
				ownerToken: "owner-1",
				agent: {
					kind: "runner",
					agentId: "engineer",
					instanceId: sessionRef,
					generation: 1,
					activationId: "activation-1",
				},
				executor: {
					logicalAgentId: "engineer",
					family: `${vendor}-family`,
					vendor,
					model: "test-model",
					effort: "high",
				},
				context: {
					projectId: "flywheel",
					issueId: "FLY-1502",
					projectRoot,
					instruction: {
						projectRoot,
						configPath: join(projectRoot, ".flywheel", "config.yaml"),
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
			claudeDeliveries,
			codexThreads,
			codexDeliveries,
		};
	}

	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
		root = undefined;
	});

	it("starts Claude behind a registration gate with pinned role and v2-only context", async () => {
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
		expect(create?.args).toContain("--agent-id");
		expect(create?.args).toContain("engineer@v2-engineer");
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
		expect(
			JSON.parse(
				readFileSync(
					join(
						root as string,
						"injection",
						"claude",
						activationKey("activation-1"),
						"teams",
						"v2-engineer",
						"config.json",
					),
					"utf8",
				),
			),
		).toMatchObject({
			name: "v2-engineer",
			leadAgentId: "engineer@v2-engineer",
			members: [
				{
					agentId: "engineer@v2-engineer",
					cwd: target.request.context.projectRoot,
				},
			],
		});
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
		await target.launcher.deliver(
			target.request.sessionRef,
			target.request.injectionRef,
			{
				messageUid: "message-1",
				attemptUid: "message-1#1",
				payload: "durable envelope",
			},
		);
		expect(target.claudeDeliveries).toEqual([
			{
				sessionRef: target.request.injectionRef,
				message: {
					messageUid: "message-1",
					attemptUid: "message-1#1",
					payload: "durable envelope",
				},
			},
		]);
	});

	it("starts a Codex daemon and durably binds the real thread before injection", async () => {
		const target = fixture("codex");
		await target.launcher.launch(target.request);
		const create = target.calls.find((call) =>
			call.args.includes("new-session"),
		);
		expect(create?.args).toContain("/opt/flywheel/bin/codex");
		expect(create?.args).toContain("app-server");
		expect(create?.args).toContain("--remote-control");
		expect(create?.args).toContain(
			`unix://${join(root as string, "injection", "codex", "runner.sock")}`,
		);
		expect(
			statSync(join(root as string, "injection", "codex")).mode & 0o777,
		).toBe(0o700);
		expect(create?.args.join(" ")).not.toContain("comm.db");
		await target.launcher.activate(target.request.sessionRef);
		expect(target.codexThreads).toEqual([
			expect.objectContaining({
				socketPath: join(root as string, "injection", "codex", "runner.sock"),
				threadId: null,
				cwd: target.request.context.projectRoot,
				model: "test-model",
				baseInstructions: "# Engineer\nPinned role.\n",
			}),
		]);
		const stateFile = join(
			target.stateRoot,
			`${createHash("sha256")
				.update(target.request.sessionRef)
				.digest("hex")}.json`,
		);
		expect(statSync(stateFile).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(stateFile, "utf8"))).toMatchObject({
			session_ref: target.request.sessionRef,
			vendor: "codex",
			thread_id: "actual-codex-thread",
		});
		await target.launcher.deliver(
			target.request.sessionRef,
			target.request.injectionRef,
			{
				messageUid: "message-2",
				attemptUid: "message-2#1",
				payload: "proposal envelope",
			},
		);
		expect(target.codexDeliveries).toEqual([
			{
				sessionRef: JSON.stringify({
					v: 1,
					backend: "codex",
					socketPath: join(root as string, "injection", "codex", "runner.sock"),
					threadId: "actual-codex-thread",
				}),
				message: {
					messageUid: "message-2",
					attemptUid: "message-2#1",
					payload: "proposal envelope",
				},
			},
		]);
		expect(readdirSync(target.stateRoot)).toHaveLength(1);
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

	it("refuses an injection-derived config path outside the injection root", async () => {
		// Codex R1 MEDIUM-5: configDir is walked up from an injection ref, so with no
		// containment a crafted or corrupt ref could aim the .claude.json merge at a
		// real user config dir such as $HOME/.claude.json.
		const target = fixture("claude", (root) => join(root, "elsewhere"));
		await expect(target.launcher.launch(target.request)).rejects.toThrow(
			/escapes the configured injection root/,
		);
		// Nothing may be spawned once containment fails.
		expect(target.calls.some((call) => call.args.includes("new-session"))).toBe(
			false,
		);
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

	it("writes nothing outside the root when containment fails", async () => {
		// Codex R2 MEDIUM-4: containment used to run inside the preseed, by which
		// point the team config.json had ALREADY been written outside the root.
		const target = fixture("claude", (root) => join(root, "elsewhere"));
		const configDir = claudeConfigDir(target.request);
		const teamPath = join(
			dirname(dirname(JSON.parse(target.request.injectionRef).inboxPath)),
			"config.json",
		);
		await expect(target.launcher.launch(target.request)).rejects.toThrow(
			/escapes the configured injection root/,
		);
		expect(existsSync(teamPath)).toBe(false);
		expect(existsSync(join(configDir, ".claude.json"))).toBe(false);
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

	it("isolates the Claude config and inbox per activation", async () => {
		// Codex R3 MEDIUM-5/7: sharing one root across activations of the same agent
		// meant every launcher wrote the same .claude.json (a live Claude could
		// restore its older snapshot over a just-written trust entry) and a new
		// terminal inherited the previous activation's unread envelopes.
		const target = fixture("claude");
		const configDir = claudeConfigDir(target.request);
		expect(configDir).toBe(
			join(
				root as string,
				"injection",
				"claude",
				activationKey("activation-1"),
			),
		);
		await target.launcher.launch(target.request);
		expect(existsSync(join(configDir, ".claude.json"))).toBe(true);

		// A second activation of the SAME agent gets a different root, so it can
		// share neither the onboarding state nor the inbox.
		const other = fixture("claude");
		const secondRef = JSON.parse(other.request.injectionRef) as {
			inboxPath: string;
			sidecarPath: string;
		};
		const rebound = {
			...other.request,
			activationId: "activation-2",
			injectionRef: JSON.stringify({
				v: 1,
				backend: "claude",
				inboxPath: secondRef.inboxPath.replace(
					activationKey("activation-1"),
					activationKey("activation-2"),
				),
				sidecarPath: secondRef.sidecarPath.replace(
					activationKey("activation-1"),
					activationKey("activation-2"),
				),
				toAgent: "engineer",
			}),
		};
		const secondConfigDir = claudeConfigDir(rebound);
		expect(secondConfigDir).not.toBe(claudeConfigDir(other.request));
		expect(secondConfigDir).toContain(activationKey("activation-2"));
	});

	it("refuses an injection ref that does not name a recognised config root", async () => {
		const target = fixture("claude");
		const ref = JSON.parse(target.request.injectionRef) as {
			inboxPath: string;
		};
		// Drop the `claude` segment: neither the per-activation nor the legacy
		// layout, so it must not be treated as either.
		const inboxPath = ref.inboxPath.replace(
			join("claude", activationKey("activation-1")),
			"not-claude",
		);
		await expect(
			target.launcher.launch({
				...target.request,
				injectionRef: JSON.stringify({
					v: 1,
					backend: "claude",
					inboxPath,
					sidecarPath: `${inboxPath}.flywheel.jsonl`,
					toAgent: "engineer",
				}),
			}),
		).rejects.toThrow(/does not name a recognised config root/);
	});

	it("still parses a ref written before per-activation isolation", async () => {
		// An activation already in flight when this deploys must remain probeable
		// and stoppable; only the emitted shape carries the isolation guarantee.
		const target = fixture("claude");
		const ref = JSON.parse(target.request.injectionRef) as {
			inboxPath: string;
		};
		const inboxPath = ref.inboxPath.replace(
			`${sep}${activationKey("activation-1")}`,
			"",
		);
		await expect(
			target.launcher.launch({
				...target.request,
				injectionRef: JSON.stringify({
					v: 1,
					backend: "claude",
					inboxPath,
					sidecarPath: `${inboxPath}.flywheel.jsonl`,
					toAgent: "engineer",
				}),
			}),
		).resolves.toMatchObject({ hostEpoch: "host-a" });
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

	it("copies the operator credentials into the per-activation config dir", async () => {
		// Codex R4 MEDIUM-2: making the config root per-activation left it with no
		// .credentials.json, while the runner is launched `env -i` with an allowlist
		// carrying no token, so every spawn would have sat at an interactive login.
		const target = fixture("claude");
		await target.launcher.launch(target.request);
		const credentials = join(
			claudeConfigDir(target.request),
			".credentials.json",
		);
		// A copy, not a symlink -- see the rotation case below for why.
		expect(lstatSync(credentials).isFile()).toBe(true);
		expect(lstatSync(credentials).isSymbolicLink()).toBe(false);
		expect(lstatSync(credentials).mode & 0o777).toBe(0o600);
		expect(
			JSON.parse(readFileSync(credentials, "utf8")) as {
				claudeAiOauth: { accessToken: string };
			},
		).toMatchObject({ claudeAiOauth: { accessToken: "fixture-token" } });
		expect(
			readdirSync(claudeConfigDir(target.request)).filter((entry) =>
				entry.includes(".credentials.json.staging."),
			),
		).toEqual([]);
	});

	it("never overwrites a rotated token in the activation directory", async () => {
		// Codex R5 MEDIUM-2, and the reason this is a copy rather than a symlink.
		// Claude's credential writer writes a temp file and renames over the path, and
		// POSIX rename replaces the SYMLINK rather than writing through it -- verified
		// directly. So after a rotation the activation dir holds the ONLY valid token
		// as a regular file, and the previous relaunch path unlinked it and re-linked
		// the stale source. That was data loss caused by the fix.
		const target = fixture("claude");
		await target.launcher.launch(target.request);
		const credentials = join(
			claudeConfigDir(target.request),
			".credentials.json",
		);

		// Claude rotates: temp file renamed over the path, exactly as it does in
		// practice.
		const rotated = `${credentials}.tmp`;
		writeFileSync(
			rotated,
			JSON.stringify({ claudeAiOauth: { accessToken: "rotated-token" } }),
			{ mode: 0o600 },
		);
		renameSync(rotated, credentials);

		// Relaunch the same activation. The rotated token must survive untouched.
		await target.launcher.stop(target.request.sessionRef);
		await target.launcher.launch(target.request);
		expect(
			JSON.parse(readFileSync(credentials, "utf8")) as {
				claudeAiOauth: { accessToken: string };
			},
		).toMatchObject({ claudeAiOauth: { accessToken: "rotated-token" } });
		// And the operator source is untouched either way.
		expect(
			JSON.parse(readFileSync(target.claudeCredentialsPath, "utf8")) as {
				claudeAiOauth: { accessToken: string };
			},
		).toMatchObject({ claudeAiOauth: { accessToken: "fixture-token" } });
	});

	it("reseeds when the activation credentials are absent or zero-byte", async () => {
		const target = fixture("claude");
		await target.launcher.launch(target.request);
		const credentials = join(
			claudeConfigDir(target.request),
			".credentials.json",
		);
		// A zero-byte file cannot be a token, so it must not be preserved.
		writeFileSync(credentials, "", { mode: 0o600 });
		await target.launcher.stop(target.request.sessionRef);
		await target.launcher.launch(target.request);
		expect(
			JSON.parse(readFileSync(credentials, "utf8")) as {
				claudeAiOauth: { accessToken: string };
			},
		).toMatchObject({ claudeAiOauth: { accessToken: "fixture-token" } });
	});

	it("fails closed before tmux when the credentials are unusable", async () => {
		// Every rejection must name the path and happen BEFORE the session exists --
		// a runner parked on a login prompt is only noticed by a human watching it.
		for (const [mutate, expected] of [
			[
				(path: string) => rmSync(path),
				/Claude credentials are missing at .*provision them once/,
			],
			[
				(path: string) => writeFileSync(path, "", { mode: 0o600 }),
				/Claude credentials at .* are empty/,
			],
			[
				(path: string) => chmodSync(path, 0o644),
				/must be mode 0600 or 0400, found 0644/,
			],
			[
				(path: string) => writeFileSync(path, "not json", { mode: 0o600 }),
				/are not valid JSON/,
			],
		] as const) {
			const target = fixture("claude");
			mutate(target.claudeCredentialsPath);
			await expect(target.launcher.launch(target.request)).rejects.toThrow(
				expected,
			);
			expect(
				target.calls.some((call) => call.args.includes("new-session")),
			).toBe(false);
			expect(
				existsSync(join(claudeConfigDir(target.request), ".credentials.json")),
			).toBe(false);
		}
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
