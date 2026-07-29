import { createHash } from "node:crypto";
import {
	chmodSync,
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
import type { RuntimeLaunchRequest } from "../runtime-ports.js";
import {
	type TmuxCommandPort,
	TmuxRunnerLauncher,
} from "../tmux-runner-launcher.js";

describe("v2-native tmux runner launcher", () => {
	let root: string | undefined;

	function fixture(vendor = "claude"): {
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
			processStart: () => "Mon Jul 28 01:00:00 2026",
		});
		return {
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
								inboxPath: join(
									injectionRoot,
									"claude",
									"teams",
									"v2-engineer",
									"inboxes",
									"engineer.json",
								),
								sidecarPath: join(
									injectionRoot,
									"claude",
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
			`CLAUDE_CONFIG_DIR=${join(root as string, "injection", "claude")}`,
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
});
