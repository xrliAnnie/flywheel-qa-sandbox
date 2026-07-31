import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CODEX_SANDBOX_POLICY_VERSION } from "../codex-remote.js";
import type { RuntimeLaunchRequest } from "../runtime-ports.js";
import {
	RUNNER_GATE_SCRIPT,
	type TmuxCommandPort,
	TmuxRunnerLauncher,
	workspaceWindowName,
} from "../tmux-runner-launcher.js";

describe("v2-native tmux runner launcher", () => {
	let root: string | undefined;
	const savedCloseRequestFile = process.env.FLYWHEEL_CMUX_CLOSE_REQUEST_FILE;

	function fixture(
		vendor = "claude",
		overrides: {
			processStart?: (pid: number) => string | null;
			cmuxEventFilePath?: (root: string) => string;
			context?: Partial<RuntimeLaunchRequest["context"]>;
			model?: string;
			mailboxMcpPath?: string;
			codexRemotePorts?: import("../codex-remote.js").CodexRemotePorts;
			resolveGitDirs?: (cwd: string) => Promise<string[]>;
		} = {},
	): {
		request: RuntimeLaunchRequest;
		command: TmuxCommandPort;
		calls: Array<{ file: string; args: string[] }>;
		launcher: TmuxRunnerLauncher;
		releaseRoot: string;
		stateRoot: string;
		cmuxEventFilePath: string;
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
		let presentWindowName = "";
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
					presentWindowName = args[args.indexOf("-n") + 1] ?? "";
					const session = args[args.indexOf("-s") + 1];
					return { stdout: `${session}:@0\n`, stderr: "" };
				}
				if (args.includes("list-windows")) {
					return { stdout: `${presentWindowName}\n`, stderr: "" };
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
		const cmuxEventFilePath = overrides.cmuxEventFilePath
			? overrides.cmuxEventFilePath(root)
			: join(root, "cmux-events");
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
			cmuxEventFilePath,
			command,
			now: () => new Date("2026-07-28T01:00:00.000Z"),
			processStart:
				overrides.processStart ?? (() => "Mon Jul 28 01:00:00 2026"),
			...(overrides.mailboxMcpPath
				? { mailboxMcpPath: overrides.mailboxMcpPath }
				: {}),
			...(overrides.codexRemotePorts
				? { codexRemotePorts: overrides.codexRemotePorts }
				: {}),
			// FLY-1565: the fixture projectRoot is not a git repo, so the git
			// metadata derivation is faked unless a test injects its own.
			resolveGitDirs:
				overrides.resolveGitDirs ??
				(async () => ["/fixture/main/.git", "/fixture/main/.git/worktrees/t"]),
		});
		return {
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
					model: overrides.model ?? "test-model",
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
						// FLY-1556: the pin is a git blob; the launcher only consumes the
						// content + digest, so the provenance shas are fixtures.
						sourceCommit: "c".repeat(40),
						sourceBlob: "b".repeat(40),
						contentDigest: createHash("sha256").update(role).digest("hex"),
						contentBytes: Buffer.byteLength(role),
						content: role,
					},
					...overrides.context,
				},
			},
			command,
			calls,
			launcher,
			releaseRoot,
			stateRoot,
			cmuxEventFilePath,
		};
	}

	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
		root = undefined;
		if (savedCloseRequestFile === undefined) {
			delete process.env.FLYWHEEL_CMUX_CLOSE_REQUEST_FILE;
		} else {
			process.env.FLYWHEEL_CMUX_CLOSE_REQUEST_FILE = savedCloseRequestFile;
		}
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
		expect(create?.args).toContain("--append-system-prompt-file");
		// FLY-1556: the system prompt file is the engine-owned content-addressed
		// materialization under stateRoot, never the mutable worktree file.
		const pinnedPath = join(
			target.stateRoot,
			"instructions",
			`${target.request.context.instruction.contentDigest}.md`,
		);
		expect(create?.args).toContain(pinnedPath);
		expect(create?.args).not.toContain(
			target.request.context.instruction.sourcePath,
		);
		expect(readFileSync(pinnedPath, "utf8")).toBe(
			target.request.context.instruction.content,
		);
		// The bootstrap prompt names the SAME immutable copy as the pinned
		// authority.
		expect(create?.args.at(-1)).toContain(
			`The complete role authority is pinned at ${pinnedPath}`,
		);
		expect(create?.args).toContain("--session-id");
		expect(create?.args).toContain("--name");
		expect(create?.args).not.toContain("--agent-id");
		expect(create?.args).not.toContain("--agent-name");
		expect(create?.args).not.toContain("--team-name");
		expect(create?.args.join(" ")).not.toContain("agent-teams");
		expect(create?.args.join(" ")).not.toContain(" next ");
		expect(create?.args.join(" ")).not.toContain("comm.db");
		// FLY-1544 ②: the executing vendor rides the session environment so the
		// node manual's cross-vendor review rule can name the other vendor.
		expect(create?.args).toContain("FLYWHEEL_V2_VENDOR=claude");
		expect(create?.args.at(-1)).toContain('"messageUid":"message-1"');
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

	it("FLY-1550 ①②: inherits the full environment (no env -i wash, no CLAUDE_CONFIG_DIR)", async () => {
		const target = fixture("claude");
		await target.launcher.launch(target.request);
		const create = target.calls.find((call) =>
			call.args.includes("new-session"),
		);
		// Founder order ①: no environment washing. The old `/usr/bin/env -i`
		// allowlist wrapper between the gate script and the vendor binary is gone;
		// the pane keeps the full tmux-provided environment, TERM included.
		const shIndex = create?.args.indexOf("/bin/sh") ?? -1;
		expect(shIndex).toBeGreaterThan(-1);
		expect(create?.args[shIndex + 2]).toBe(RUNNER_GATE_SCRIPT);
		// The vendor binary follows the gate script arguments directly -- no
		// wrapper, no allowlist.
		expect(create?.args[shIndex + 4]).toBe("/opt/flywheel/bin/claude");
		// Founder order ②: no per-activation config dir -- the runner shares the
		// operator's ~/.claude, so no CLAUDE_CONFIG_DIR value is ever injected.
		expect(create?.args.join(" ")).not.toContain("CLAUDE_CONFIG_DIR=");
	});

	it("FLY-1550 ① (Codex R1 HIGH-2): the gate script sweeps the named blacklist in a REAL child, even under a hostile PATH", () => {
		const scratch = mkdtempSync(join("/tmp", "flywheel-v2-gate-"));
		try {
			const release = join(scratch, "release");
			writeFileSync(release, "activate\n");
			const result = spawnSync(
				"/bin/sh",
				["-c", RUNNER_GATE_SCRIPT, release, "/usr/bin/env"],
				{
					env: {
						// Hostile PATH: the sweep must not depend on inherited lookup.
						PATH: "/nonexistent",
						FLYWHEEL_BRIDGE_URL: "secret-a",
						// An environment ENTRY name is not a shell identifier; the sweep
						// must remove it anyway (env -u, not the shell builtin unset).
						"FLYWHEEL_BRIDGE_X-Y": "secret-b",
						FLYWHEEL_BRIDGE_: "secret-c",
						CLAUDE_CONFIG_DIR: "/tmp/should-not-survive",
						TERM: "tmux-256color",
						FLYWHEEL_V2_SESSION_REF: "keep-v2",
						UNRELATED: "keep-me",
					},
					encoding: "utf8",
				},
			);
			expect(result.status).toBe(0);
			const lines = result.stdout.split("\n");
			// Blacklist gone -- every FLYWHEEL_BRIDGE_* entry and the config split.
			expect(result.stdout).not.toContain("FLYWHEEL_BRIDGE");
			expect(result.stdout).not.toContain("CLAUDE_CONFIG_DIR");
			// Everything else inherited untouched (order ①: no washing).
			expect(lines).toContain("TERM=tmux-256color");
			expect(lines).toContain("FLYWHEEL_V2_SESSION_REF=keep-v2");
			expect(lines).toContain("UNRELATED=keep-me");
			expect(lines).toContain("PATH=/nonexistent");
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("FLY-1550 ①: the gate script still blocks until the release file appears", () => {
		const scratch = mkdtempSync(join("/tmp", "flywheel-v2-gate-"));
		try {
			// No release file: the gate must wait, not exec. Probe the behaviour with
			// a 1-iteration ceiling by pointing $0 at a path that appears after 0s --
			// here we simply assert the no-file case does NOT run the vendor within
			// a bounded observation window.
			const result = spawnSync(
				"/bin/sh",
				["-c", RUNNER_GATE_SCRIPT, join(scratch, "never"), "/usr/bin/env"],
				{ encoding: "utf8", timeout: 1500 },
			);
			// Killed by the timeout while still gated -- the vendor never ran.
			expect(result.stdout).toBe("");
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	// R5-B1: a failed assignment send is never terminal — the done-latch is set
	// only after sendCodexTurn resolves, so the next coordinator tick retries
	// (and the reconcile inside sendCodexTurn keeps the retry single-effect).
	it("retries the assignment on the next activation after a failed send", async () => {
		const turns: Array<{ threadId: string; text: string; id?: string }> = [];
		let failNextStart = false;
		let startAttempts = 0;
		const fakeHandle = {
			child: { pid: 4242 },
			socketPath: "/tmp/fake.sock",
			stop: () => {},
			ensureDead: async () => true,
		};
		const fakeClient = {
			initialize: async () => {},
			readThread: async () => ({
				turns: turns.map((turn) => ({
					status: "completed",
					items: [{ type: "userMessage", clientId: turn.id ?? null }],
				})),
			}),
			startThread: async () => "thread-77",
			startTurn: async (
				threadId: string,
				text: string,
				_t?: number,
				id?: string,
			) => {
				if (id?.startsWith("assignment:")) {
					startAttempts += 1;
					if (failNextStart) {
						failNextStart = false;
						throw new Error("transport dropped mid-send");
					}
				}
				turns.push({ threadId, text, ...(id ? { id } : {}) });
			},
			close: () => {},
		};
		const target = fixture("codex", {
			mailboxMcpPath: "/opt/flywheel/mailbox-mcp/server-main.js",
			codexRemotePorts: {
				spawnDaemon: (async () => fakeHandle) as never,
				connect: (async () => ({})) as never,
				clientFactory: () => fakeClient as never,
				processGroupOf: () => 4242,
			},
		});
		await target.launcher.launch(target.request);
		failNextStart = true;
		await target.launcher.activate(target.request.sessionRef);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(startAttempts).toBe(1); // first attempt failed
		expect(turns.some((t) => t.id?.startsWith("assignment:"))).toBe(false);
		// Next coordinator tick: reconcile finds nothing, retries, succeeds.
		await target.launcher.activate(target.request.sessionRef);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(startAttempts).toBe(2);
		expect(turns.some((t) => t.id?.startsWith("assignment:"))).toBe(true);
		// Further activations are latched — no third attempt.
		await target.launcher.activate(target.request.sessionRef);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(startAttempts).toBe(2);
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
		// FLY-1565: the bare form executes locally — it needs the same
		// mailbox-capable sandbox policy as the daemon (network for the v2 host
		// socket, git metadata roots for worktree commits, apps auto-approve).
		expect(create?.args).toContain(
			`sandbox_workspace_write.writable_roots=${JSON.stringify([
				target.request.context.projectRoot,
				"/fixture/main/.git",
				"/fixture/main/.git/worktrees/t",
			])}`,
		);
		expect(create?.args).toContain(
			"sandbox_workspace_write.network_access=true",
		);
		expect(create?.args).toContain(
			'apps._default.default_tools_approval_mode="approve"',
		);
		const initialPrompt = create?.args.at(-1);
		expect(initialPrompt).toContain("# Engineer\nPinned role.");
		expect(initialPrompt).toContain(
			"Flywheel v2 runner bootstrap for FLY-1502.",
		);
		expect(initialPrompt).toContain('"messageUid":"message-1"');
		expect(create?.args.join(" ")).not.toContain("comm.db");
		expect(create?.args).toContain("FLYWHEEL_V2_VENDOR=codex");
		await target.launcher.activate(target.request.sessionRef);
		// FLY-1556: NO per-session runner-state JSON — the pin's single source of
		// truth is the kernel; the only thing under stateRoot is the
		// content-addressed instruction materialization.
		const stateFile = join(
			target.stateRoot,
			`${createHash("sha256")
				.update(target.request.sessionRef)
				.digest("hex")}.json`,
		);
		expect(existsSync(stateFile)).toBe(false);
		expect(readdirSync(target.stateRoot)).toEqual(["instructions"]);
		const pinnedPath = join(
			target.stateRoot,
			"instructions",
			`${target.request.context.instruction.contentDigest}.md`,
		);
		expect(statSync(pinnedPath).mode & 0o777).toBe(0o600);
		expect(readFileSync(pinnedPath, "utf8")).toBe(
			target.request.context.instruction.content,
		);
	});

	it("FLY-1550 doorbell regression: delivers by buffer paste + Enter, and fails loud on an absent session", async () => {
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

	it("FLY-1563 ③: delivers a lead bell into the pane resolved by pid ancestry", async () => {
		const target = fixture("claude");
		const commandRun = target.command.run.bind(target.command);
		// The lead claude process (4242) is a child of the pane shell (900),
		// which tmux reports as pane %7. An unrelated pane %2 must not match.
		target.command.run = async (file, args) => {
			target.calls.push({ file, args });
			if (args.includes("list-panes")) {
				return { stdout: "555 %2\n900 %7\n", stderr: "" };
			}
			if (file === "/bin/ps") {
				return { stdout: " 4242  900\n  900    1\n  555    1\n", stderr: "" };
			}
			return commandRun(file, args);
		};
		await target.launcher.deliverLead(
			"flywheel-eng-lead",
			4242,
			"Mon Jul 28 01:00:00 2026",
			"叮",
		);
		const paste = target.calls.find((call) =>
			call.args.includes("paste-buffer"),
		);
		const sendKeys = target.calls.find((call) =>
			call.args.includes("send-keys"),
		);
		expect(paste?.args).toContain("%7");
		expect(sendKeys?.args).toContain("%7");
		expect(sendKeys?.args).toContain("Enter");
		// A runner session name is never derived for a lead.
		expect(
			target.calls.some((call) =>
				call.args.some((arg) => arg.startsWith("=v2-")),
			),
		).toBe(false);
	});

	it("FLY-1563 (codex R1 HIGH-1): a recycled pid never takes the lead paste", async () => {
		const target = fixture("claude", {
			// The live process at 4242 reports a DIFFERENT start identity than the
			// registration binding recorded — pid reuse.
			processStart: (pid) => (pid === 4242 ? "Tue Jul 29 09:00:00 2026" : null),
		});
		const commandRun = target.command.run.bind(target.command);
		target.command.run = async (file, args) => {
			target.calls.push({ file, args });
			if (args.includes("list-panes")) {
				return { stdout: "4242 %7\n", stderr: "" };
			}
			if (file === "/bin/ps") {
				return { stdout: " 4242    1\n", stderr: "" };
			}
			return commandRun(file, args);
		};
		await expect(
			target.launcher.deliverLead(
				"flywheel-eng-lead",
				4242,
				"Mon Jul 28 01:00:00 2026",
				"叮",
			),
		).rejects.toThrow(/start identity mismatch/);
		expect(
			target.calls.some((call) => call.args.includes("paste-buffer")),
		).toBe(false);
	});

	it("FLY-1563 (codex R1 M-2): a lead lease is probed even without runner mailbox wiring", async () => {
		// No mailboxMcpPath: runner sessions stay ineligible, but a LEAD channel
		// is enabled by claude-lead.sh independently — its lease must be honored
		// or the doorbell double-rings a healthy channel.
		const target = fixture("claude");
		const { mailboxLeasePath } = await import("../tmux-runner-launcher.js");
		const { writeLease, touchLease } = await import(
			"flywheel-inbox-mcp/channel-lease"
		);
		mkdirSync(target.stateRoot, { recursive: true });
		const leasePath = mailboxLeasePath(target.stateRoot, "flywheel-eng-lead");
		writeLease(leasePath, { pid: process.pid });
		touchLease(leasePath, new Date().toISOString());
		expect(await target.launcher.channelHealthy("flywheel-eng-lead")).toBe(
			true,
		);
		expect(
			await target.launcher.channelHealthy(
				"v2dag:11111111-1111-4111-8111-111111111111:1:22222222-2222-4222-8222-222222222222",
			),
		).toBe(false);
		// A stale lease (old lastOkAt) is not healthy either.
		touchLease(leasePath, new Date(Date.now() - 60_000).toISOString());
		expect(await target.launcher.channelHealthy("flywheel-eng-lead")).toBe(
			false,
		);
	});

	it("FLY-1563 ③: lead delivery fails loud on a dead pid or a process outside tmux", async () => {
		const target = fixture("claude");
		const commandRun = target.command.run.bind(target.command);
		target.command.run = async (file, args) => {
			target.calls.push({ file, args });
			if (args.includes("list-panes")) {
				return { stdout: "900 %7\n", stderr: "" };
			}
			if (file === "/bin/ps") {
				return { stdout: " 7777    1\n  900    1\n", stderr: "" };
			}
			return commandRun(file, args);
		};
		// Pid absent from the process table: pane resolution fails loud.
		await expect(
			target.launcher.deliverLead(
				"flywheel-eng-lead",
				4242,
				"Mon Jul 28 01:00:00 2026",
				"叮",
			),
		).rejects.toThrow(/is not alive/);
		// Alive but hosted by no pane (walks 7777 → 1 without a pane hit).
		await expect(
			target.launcher.deliverLead(
				"flywheel-eng-lead",
				7777,
				"Mon Jul 28 01:00:00 2026",
				"叮",
			),
		).rejects.toThrow(/no tmux pane hosts/);
		expect(
			target.calls.some((call) => call.args.includes("paste-buffer")),
		).toBe(false);
	});

	it("fails closed before tmux for unknown vendors or a content/pin mismatch", async () => {
		const unknown = fixture("other");
		await expect(unknown.launcher.launch(unknown.request)).rejects.toThrow(
			/unsupported runner vendor/i,
		);
		expect(
			unknown.calls.some((call) => call.args.includes("new-session")),
		).toBe(false);

		// FLY-1556: the launch request must be internally consistent — content
		// that does not hash to its own pin is refused with expected vs actual
		// named (a corrupted request transport, not a worktree edit).
		const corrupted = fixture("claude");
		corrupted.request.context.instruction.content = "# Corrupted in transit\n";
		await expect(corrupted.launcher.launch(corrupted.request)).rejects.toThrow(
			/does not match its pin: expected sha256/i,
		);
		expect(
			corrupted.calls.some((call) => call.args.includes("new-session")),
		).toBe(false);
	});

	it("FLY-1556: a task editing its own instruction file cannot poison launch or activation", async () => {
		const target = fixture("claude");
		// The worktree copy changes BEFORE launch (e.g. a recovered claim whose
		// prior generation already edited the book) — irrelevant: the pinned
		// content travels in the request.
		writeFileSync(
			target.request.context.instruction.sourcePath,
			"# Edited by the task itself\n",
		);
		chmodSync(target.request.context.instruction.sourcePath, 0o600);
		await expect(target.launcher.launch(target.request)).resolves.toMatchObject(
			{ hostEpoch: "host-a" },
		);
		// ...and changes again while the session is live. Activation is presence
		// + gate release; it re-verifies nothing mutable.
		writeFileSync(
			target.request.context.instruction.sourcePath,
			"# Edited again mid-flight\n",
		);
		await expect(
			target.launcher.activate(target.request.sessionRef),
		).resolves.toBeUndefined();
		const releaseFiles = readdirSync(target.releaseRoot);
		expect(releaseFiles).toHaveLength(1);
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

	describe("FLY-1550 ③ workspace naming (FLY-1255 Locked Display Contract)", () => {
		it("names a non-three-stage node `<ISSUE>-runner-<windowLabel>-<title>`", async () => {
			const target = fixture("claude", {
				model: "claude-fable-5",
				context: { issueTitle: "config-parity" },
			});
			await target.launcher.launch(target.request);
			const create = target.calls.find((call) =>
				call.args.includes("new-session"),
			);
			const windowName = create?.args[(create?.args.indexOf("-n") ?? 0) + 1];
			// Contract §7: fixed `runner-` producer prefix + renderRunnerModelDisplay
			// windowLabel (`claude-Fable`), composed by the v1 buildWindowLabel.
			expect(windowName).toBe("FLY-1502-runner-claude-Fable-config-parity");
		});

		it("keeps the phase prefix for three-stage node kinds", () => {
			const target = fixture("claude", {
				model: "claude-fable-5",
				context: { issueTitle: "config-parity" },
			});
			expect(
				workspaceWindowName({ ...target.request, taskKind: "design" }),
			).toBe("FLY-1502-design-claude-Fable-config-parity");
		});

		it("degrades the title slug to the node kind when the admission carried none", () => {
			const target = fixture("claude");
			expect(workspaceWindowName(target.request)).toBe(
				"FLY-1502-runner-claude-test-model-engineer",
			);
		});

		it("renders codex models through the same locked windowLabel", () => {
			const target = fixture("codex", {
				model: "gpt-5.6-sol",
				context: { issueTitle: "config-parity" },
			});
			// FLY-1255 Plan B (Annie): curated non-Claude families fold to their
			// single-letter code in the window label (`codex-G`) — the value comes
			// from renderRunnerModelDisplay, never re-derived here.
			expect(workspaceWindowName(target.request)).toBe(
				"FLY-1502-runner-codex-G-config-parity",
			);
		});

		it("holds the 50-char budget with issue identifier + model identity ahead of a long title", () => {
			const target = fixture("claude", {
				model: "claude-fable-5",
				context: {
					issueTitle:
						"[v2] cmux 自动可见:runner 起/停时自动建&命名&回收 workspace(照 v1)|with'unsafe\"bytes",
				},
			});
			const name = workspaceWindowName(target.request);
			// Contract §8: deterministic truncation keeps the head (issue + model);
			// §4: dangerous bytes fold to `-`, separators collapse.
			expect(name.startsWith("FLY-1502-runner-claude-Fable")).toBe(true);
			expect(name.length).toBeLessThanOrEqual(50);
			expect(name).toMatch(/^[A-Za-z0-9-]+$/);
		});
	});

	describe("FLY-1550 ③ cmux visibility", () => {
		it("announces the new window on the v1 cmux-sync event channel", async () => {
			const target = fixture("claude", {
				model: "claude-fable-5",
				context: { issueTitle: "config-parity" },
			});
			await target.launcher.launch(target.request);
			const sessionName = `v2-${createHash("sha256")
				.update(target.request.sessionRef)
				.digest("hex")
				.slice(0, 32)}`;
			expect(readFileSync(target.cmuxEventFilePath, "utf8")).toBe(
				`create|${sessionName}|@0|FLY-1502-runner-claude-Fable-config-parity\n`,
			);
		});

		it("never fails a launch because the cmux event channel is unwritable", async () => {
			const target = fixture("claude", {
				cmuxEventFilePath: (base) =>
					join(base, "missing-directory", "cmux-events"),
			});
			await expect(
				target.launcher.launch(target.request),
			).resolves.toMatchObject({ hostEpoch: "host-a" });
			expect(existsSync(target.cmuxEventFilePath)).toBe(false);
		});

		it("stop() requests the v1 close of the workspace pin by window name", async () => {
			const target = fixture("claude", {
				model: "claude-fable-5",
				context: { issueTitle: "config-parity" },
			});
			await target.launcher.launch(target.request);
			const closeRequestFile = join(root as string, "cmux-close-requested");
			process.env.FLYWHEEL_CMUX_CLOSE_REQUEST_FILE = closeRequestFile;
			await target.launcher.stop(target.request.sessionRef);
			// The window name resolves BEFORE the kill (the v1 FLY-638 ordering) and
			// lands in the FLY-685 marker AFTER it, so the watcher's revalidating
			// chokepoint sees the window already gone and closes the pin gracelessly.
			expect(readFileSync(closeRequestFile, "utf8")).toBe(
				"FLY-1502-runner-claude-Fable-config-parity\n",
			);
			const killIndex = target.calls.findIndex((call) =>
				call.args.includes("kill-session"),
			);
			const listIndex = target.calls.findIndex((call) =>
				call.args.includes("list-windows"),
			);
			expect(listIndex).toBeGreaterThan(-1);
			expect(listIndex).toBeLessThan(killIndex);
		});

		it("stop() of an absent session writes no close request", async () => {
			const target = fixture("claude");
			const closeRequestFile = join(root as string, "cmux-close-requested");
			process.env.FLYWHEEL_CMUX_CLOSE_REQUEST_FILE = closeRequestFile;
			await target.launcher.stop(target.request.sessionRef);
			expect(existsSync(closeRequestFile)).toBe(false);
		});
	});

	// FLY-1547 (rebased onto the FLY-1550 launcher): mailbox service wiring.
	describe("FLY-1547 mailbox wiring", () => {
		it("registers the mailbox MCP + dev channel and materializes the stateRoot config", async () => {
			const target = fixture("claude", {
				mailboxMcpPath: "/opt/flywheel/mailbox-mcp/server-main.js",
			});
			await target.launcher.launch(target.request);
			const create = target.calls.find((call) =>
				call.args.includes("new-session"),
			);
			expect(create?.args).toContain("--mcp-config");
			expect(create?.args).toContain("--dangerously-load-development-channels");
			expect(create?.args).toContain("server:flywheel-v2-mailbox");
			const configPath = create?.args[
				(create?.args.indexOf("--mcp-config") ?? -1) + 1
			] as string;
			expect(configPath).toContain("-mailbox-mcp.json");
			const materialized = JSON.parse(readFileSync(configPath, "utf8")) as {
				mcpServers: Record<string, { env: Record<string, string> }>;
			};
			const server = materialized.mcpServers["flywheel-v2-mailbox"];
			expect(server?.env).toMatchObject({
				FLYWHEEL_V2_SESSION_REF: target.request.sessionRef,
			});
			expect(server?.env.FLYWHEEL_V2_MAILBOX_LEASE).toContain(
				"-mailbox-lease.json",
			);
			// channelHealthy: no lease -> false; a fresh lease flips it.
			await expect(
				target.launcher.channelHealthy(target.request.sessionRef),
			).resolves.toBe(false);
			writeFileSync(
				server?.env.FLYWHEEL_V2_MAILBOX_LEASE as string,
				JSON.stringify({
					pid: process.pid,
					startedAt: new Date().toISOString(),
					lastOkAt: new Date().toISOString(),
				}),
			);
			await expect(
				target.launcher.channelHealthy(target.request.sessionRef),
			).resolves.toBe(true);
		});

		it("keeps the spawn byte-identical when no mailbox MCP is configured", async () => {
			const target = fixture("claude");
			await target.launcher.launch(target.request);
			const create = target.calls.find((call) =>
				call.args.includes("new-session"),
			);
			expect(create?.args).not.toContain("--mcp-config");
			expect(create?.args.join(" ")).not.toContain(
				"dangerously-load-development-channels",
			);
		});

		it("launches codex in the remote-attached form and delivers the assignment at activation", async () => {
			const turns: Array<{ threadId: string; text: string; id?: string }> = [];
			let daemonStopped = 0;
			const fakeHandle = {
				child: { pid: 4242 },
				socketPath: "/tmp/fake.sock",
				stop: () => {
					daemonStopped += 1;
				},
				ensureDead: async () => true,
			};
			const fakeClient = {
				initialize: async () => {},
				readThread: async () => ({
					turns: turns.map((turn) => ({
						status: "completed",
						items: [{ type: "userMessage", clientId: turn.id ?? null }],
					})),
				}),
				startThread: async () => "thread-99",
				startTurn: async (
					threadId: string,
					text: string,
					_t?: number,
					id?: string,
				) => {
					turns.push({ threadId, text, ...(id ? { id } : {}) });
				},
				close: () => {},
			};
			const target = fixture("codex", {
				mailboxMcpPath: "/opt/flywheel/mailbox-mcp/server-main.js",
				codexRemotePorts: {
					spawnDaemon: (async () => fakeHandle) as never,
					connect: (async () => ({})) as never,
					clientFactory: () => fakeClient as never,
					processGroupOf: () => 4242,
				},
			});
			await target.launcher.launch(target.request);
			expect(turns[0]?.text).toContain("READY");
			const create = target.calls.find((call) =>
				call.args.includes("new-session"),
			);
			expect(create?.args).toContain("resume");
			expect(create?.args).toContain("--remote");
			expect(create?.args).toContain("thread-99");
			// FLY-1565: policy consistency — the attached pane carries the same
			// sandbox overrides the daemon was spawned with.
			expect(create?.args).toContain(
				"sandbox_workspace_write.network_access=true",
			);
			expect(create?.args).toContain(
				'apps._default.default_tools_approval_mode="approve"',
			);
			await target.launcher.activate(target.request.sessionRef);
			await new Promise((resolve) => setTimeout(resolve, 50));
			const assignment = turns.find((turn) =>
				turn.id?.startsWith("assignment:"),
			);
			expect(assignment).toBeDefined();
			expect(assignment?.text).toContain("Flywheel v2 runner bootstrap");
			await target.launcher.stop(target.request.sessionRef);
			expect(daemonStopped).toBe(1);
		});

		it("FLY-1565: the codex daemon spawns with the mailbox-capable sandbox (network + git roots + apps auto-approve)", async () => {
			const turns: Array<{ id?: string }> = [];
			let spawnOpts: Record<string, unknown> | undefined;
			const fakeHandle = {
				child: { pid: 4242 },
				socketPath: "/tmp/fake.sock",
				stop: () => {},
				ensureDead: async () => true,
			};
			const fakeClient = {
				initialize: async () => {},
				readThread: async () => ({
					turns: turns.map((turn) => ({
						status: "completed",
						items: [{ type: "userMessage", clientId: turn.id ?? null }],
					})),
				}),
				startThread: async () => "thread-99",
				startTurn: async (
					_threadId: string,
					_text: string,
					_t?: number,
					id?: string,
				) => {
					turns.push({ ...(id ? { id } : {}) });
				},
				close: () => {},
			};
			const target = fixture("codex", {
				mailboxMcpPath: "/opt/flywheel/mailbox-mcp/server-main.js",
				codexRemotePorts: {
					spawnDaemon: (async (opts: Record<string, unknown>) => {
						spawnOpts = opts;
						return fakeHandle;
					}) as never,
					connect: (async () => ({})) as never,
					clientFactory: () => fakeClient as never,
					processGroupOf: () => 4242,
				},
				resolveGitDirs: async (cwd) => [
					`${cwd}/../main/.git`,
					`${cwd}/../main/.git/worktrees/wt`,
				],
			});
			await target.launcher.launch(target.request);
			// EPERM root cause: workspace-write defaults network_access=false, and
			// seatbelt blocks unix-socket connect — the daemon must be spawned with
			// network access or `next`/`submit` against the host socket dies.
			expect(spawnOpts?.sandboxNetworkAccess).toBe(true);
			// Approval-stall root cause: apps/connector tools elicit per-tool
			// approval regardless of approval_policy=never — preset auto-grant.
			expect(spawnOpts?.appsDefaultToolsApprovalMode).toBe("approve");
			// Worktree-commit root cause: a linked worktree's git metadata lives
			// under the MAIN repo .git, outside the sandbox cwd root.
			expect(spawnOpts?.sandboxWritableRoots).toEqual([
				target.request.context.projectRoot,
				`${target.request.context.projectRoot}/../main/.git`,
				`${target.request.context.projectRoot}/../main/.git/worktrees/wt`,
			]);
			await target.launcher.stop(target.request.sessionRef);
		});

		it("FLY-1565 R1-HIGH: a stale-policy daemon with a DEAD pane is torn down and respawned with the current policy", async () => {
			const turns: Array<{ id?: string }> = [];
			let spawnOpts: Record<string, unknown> | undefined;
			const fakeHandle = {
				child: { pid: 4242 },
				socketPath: "/tmp/fake.sock",
				stop: () => {},
				ensureDead: async () => true,
			};
			const fakeClient = {
				initialize: async () => {},
				readThread: async () => ({
					turns: turns.map((turn) => ({
						status: "completed",
						items: [{ type: "userMessage", clientId: turn.id ?? null }],
					})),
				}),
				startThread: async () => "thread-fresh",
				startTurn: async (
					_threadId: string,
					_text: string,
					_t?: number,
					id?: string,
				) => {
					turns.push({ ...(id ? { id } : {}) });
				},
				close: () => {},
			};
			const target = fixture("codex", {
				mailboxMcpPath: "/opt/flywheel/mailbox-mcp/server-main.js",
				codexRemotePorts: {
					spawnDaemon: (async (opts: Record<string, unknown>) => {
						spawnOpts = opts;
						return fakeHandle;
					}) as never,
					// The STALE daemon's socket probes dead (ECONNREFUSED) so its
					// teardown is proof-free; the fresh daemon's socket connects.
					connect: (async (opts: { socketPath: string }) => {
						if (opts.socketPath === "/tmp/stale-old.sock") {
							const error = new Error("connect ECONNREFUSED") as Error & {
								code: string;
							};
							error.code = "ECONNREFUSED";
							throw error;
						}
						return {};
					}) as never,
					clientFactory: () => fakeClient as never,
					processGroupOf: () => 4242,
				},
			});
			// Plant a pre-FLY-1565 state: thread present, NO policy_version stamp.
			const statePath = join(
				target.stateRoot,
				`${createHash("sha256")
					.update(target.request.sessionRef)
					.digest("hex")}-codex-remote.json`,
			);
			mkdirSync(target.stateRoot, { recursive: true });
			writeFileSync(
				statePath,
				JSON.stringify({
					v: 1,
					codex_daemon: {
						socket_path: "/tmp/stale-old.sock",
						daemon_pid: 111,
						daemon_pgid: null,
						thread_id: "thread-old",
					},
					bootstrap: "old bootstrap",
				}),
			);
			await target.launcher.launch(target.request);
			// A fresh daemon was spawned with the CURRENT policy…
			expect(spawnOpts?.sandboxNetworkAccess).toBe(true);
			expect(spawnOpts?.appsDefaultToolsApprovalMode).toBe("approve");
			// …and the rewritten state is stamped + carries the fresh thread.
			const rewritten = JSON.parse(readFileSync(statePath, "utf8"));
			expect(rewritten.policy_version).toBe(CODEX_SANDBOX_POLICY_VERSION);
			expect(rewritten.codex_daemon.thread_id).toBe("thread-fresh");
			await target.launcher.stop(target.request.sessionRef);
		});

		it("FLY-1565 R1-HIGH: a stale-policy daemon under a LIVE pane fails loud instead of silent adoption", async () => {
			const turns: Array<{ id?: string }> = [];
			const fakeHandle = {
				child: { pid: 4242 },
				socketPath: "/tmp/fake.sock",
				stop: () => {},
				ensureDead: async () => true,
			};
			const fakeClient = {
				initialize: async () => {},
				readThread: async () => ({
					turns: turns.map((turn) => ({
						status: "completed",
						items: [{ type: "userMessage", clientId: turn.id ?? null }],
					})),
				}),
				startThread: async () => "thread-99",
				startTurn: async (
					_threadId: string,
					_text: string,
					_t?: number,
					id?: string,
				) => {
					turns.push({ ...(id ? { id } : {}) });
				},
				close: () => {},
			};
			const target = fixture("codex", {
				mailboxMcpPath: "/opt/flywheel/mailbox-mcp/server-main.js",
				codexRemotePorts: {
					spawnDaemon: (async () => fakeHandle) as never,
					connect: (async () => ({})) as never,
					clientFactory: () => fakeClient as never,
					processGroupOf: () => 4242,
				},
			});
			// Launch normally: the session is now live and its state is stamped.
			await target.launcher.launch(target.request);
			const statePath = join(
				target.stateRoot,
				`${createHash("sha256")
					.update(target.request.sessionRef)
					.digest("hex")}-codex-remote.json`,
			);
			const stamped = JSON.parse(readFileSync(statePath, "utf8"));
			expect(stamped.policy_version).toBe(CODEX_SANDBOX_POLICY_VERSION);
			// Simulate a pre-upgrade live session: strip the stamp.
			delete stamped.policy_version;
			writeFileSync(statePath, JSON.stringify(stamped));
			await expect(target.launcher.launch(target.request)).rejects.toThrow(
				/stale sandbox policy/,
			);
			await target.launcher.stop(target.request.sessionRef);
		});

		it("FLY-1565 R2-HIGH: activate() and codexBell() refuse to send turns to a stale-policy daemon", async () => {
			const turns: Array<{ id?: string }> = [];
			const fakeHandle = {
				child: { pid: 4242 },
				socketPath: "/tmp/fake.sock",
				stop: () => {},
				ensureDead: async () => true,
			};
			const fakeClient = {
				initialize: async () => {},
				readThread: async () => ({
					turns: turns.map((turn) => ({
						status: "completed",
						items: [{ type: "userMessage", clientId: turn.id ?? null }],
					})),
				}),
				startThread: async () => "thread-99",
				startTurn: async (
					_threadId: string,
					_text: string,
					_t?: number,
					id?: string,
				) => {
					turns.push({ ...(id ? { id } : {}) });
				},
				close: () => {},
			};
			const target = fixture("codex", {
				mailboxMcpPath: "/opt/flywheel/mailbox-mcp/server-main.js",
				codexRemotePorts: {
					spawnDaemon: (async () => fakeHandle) as never,
					connect: (async () => ({})) as never,
					clientFactory: () => fakeClient as never,
					processGroupOf: () => 4242,
				},
			});
			await target.launcher.launch(target.request);
			// Simulate a pre-upgrade live session: strip the policy stamp.
			const statePath = join(
				target.stateRoot,
				`${createHash("sha256")
					.update(target.request.sessionRef)
					.digest("hex")}-codex-remote.json`,
			);
			const state = JSON.parse(readFileSync(statePath, "utf8"));
			delete state.policy_version;
			writeFileSync(statePath, JSON.stringify(state));
			const turnsBefore = turns.length;
			// The coordinator tick's activate() on a live binding must not deliver
			// the assignment onto the stale daemon…
			await expect(
				target.launcher.activate(target.request.sessionRef),
			).rejects.toThrow(/stale sandbox policy/);
			// …and the doorbell must not ring it as a turn either.
			await expect(
				target.launcher.codexBell(
					target.request.sessionRef,
					"bell text",
					"bell:stale:1",
				),
			).rejects.toThrow(/stale sandbox policy/);
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(turns.length).toBe(turnsBefore); // no turn reached the daemon
			// stop() still reads the stale state and completes safe teardown.
			await target.launcher.stop(target.request.sessionRef);
		});

		it("FLY-1563 acceptance: the bell WAKES a remote-attached codex session as a daemon turn", async () => {
			const turns: Array<{ threadId: string; text: string; id?: string }> = [];
			const fakeHandle = {
				child: { pid: 4242 },
				socketPath: "/tmp/fake.sock",
				stop: () => {},
				ensureDead: async () => true,
			};
			const fakeClient = {
				initialize: async () => {},
				readThread: async () => ({
					turns: turns.map((turn) => ({
						status: "completed",
						items: [{ type: "userMessage", clientId: turn.id ?? null }],
					})),
				}),
				startThread: async () => "thread-99",
				startTurn: async (
					threadId: string,
					text: string,
					_t?: number,
					id?: string,
				) => {
					turns.push({ threadId, text, ...(id ? { id } : {}) });
				},
				close: () => {},
			};
			const target = fixture("codex", {
				mailboxMcpPath: "/opt/flywheel/mailbox-mcp/server-main.js",
				codexRemotePorts: {
					spawnDaemon: (async () => fakeHandle) as never,
					connect: (async () => ({})) as never,
					clientFactory: () => fakeClient as never,
					processGroupOf: () => 4242,
				},
			});
			await target.launcher.launch(target.request);
			const before = turns.length;
			const rung = await target.launcher.codexBell(
				target.request.sessionRef,
				"[flywheel-v2 mailbox bell] 你有 1 封新信",
				"bell:session:7",
			);
			expect(rung).toBe(true);
			const bell = turns
				.slice(before)
				.find((turn) => turn.id === "bell:session:7");
			expect(bell?.text).toContain("mailbox bell");
			expect(bell?.threadId).toBe("thread-99");
			// A session with no daemon record reports false — the doorbell falls to
			// the vendor-neutral pointer paste for the bare TUI form.
			expect(
				await target.launcher.codexBell(
					"v2dag:99999999-9999-4999-8999-999999999999:1:88888888-8888-4888-8888-888888888888",
					"bell",
					"bell:other:1",
				),
			).toBe(false);
			await target.launcher.stop(target.request.sessionRef);
		});
	});
});
