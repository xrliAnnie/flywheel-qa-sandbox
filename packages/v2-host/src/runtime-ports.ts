import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	renameSync,
	rmdirSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type {
	DagPorts,
	InjectionRefBuilder,
	LaunchLockPort,
	ProcessProbePort,
	RunnerControlPort,
	SpawnPort,
	SpawnRequest,
} from "flywheel-v2-dag";
import type { SessionBinding } from "flywheel-v2-engine";
import { FenceViolation, type Kernel } from "flywheel-v2-kernel";
import {
	type ResolvedRoleInstruction,
	resolveRoleInstruction,
} from "./role-instruction.js";

const execFileAsync = promisify(execFile);

export interface RuntimeLaunchRequest extends SpawnRequest {
	context: {
		projectId: string;
		issueId: string;
		projectRoot: string;
		instruction: ResolvedRoleInstruction;
	};
}

export interface RunnerLauncherPort {
	launch(request: RuntimeLaunchRequest): Promise<SessionBinding>;
	probe(sessionRef: string): ReturnType<ProcessProbePort["probe"]>;
	stop(sessionRef: string): Promise<void>;
	activate?(sessionRef: string): Promise<void>;
	deliver?(
		sessionRef: string,
		injectionRef: string,
		message: {
			messageUid: string;
			attemptUid: string;
			payload: string;
		},
	): Promise<void>;
}

export interface RuntimeDagPortsOptions {
	kernel: Kernel;
	hostEpoch: string;
	lockRoot: string;
	injectionRoot: string;
	launcher: RunnerLauncherPort;
	gitBin?: string;
	ghBin?: string;
	now?: () => Date;
}

export interface CommandRunnerLauncherOptions {
	command: string[];
	requestRoot: string;
}

interface InstructionEvidence {
	v: 1;
	project_id: string;
	issue_id: string;
	logical_agent_id: string;
	config_path: string;
	source_path: string;
	content_digest: string;
	content_bytes: number;
	resolved_at: string;
}

interface TaskLaunchRow {
	project_id: string;
	external_issue_id: string;
	payload: string;
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${label} must be a non-empty string`);
	}
	return value;
}

function absolute(path: string, label: string): string {
	if (!isAbsolute(path)) throw new TypeError(`${label} must be absolute`);
	return path;
}

function safeKey(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function atomicJson(path: string, value: unknown): void {
	const parent = dirname(path);
	mkdirSync(parent, { recursive: true, mode: 0o700 });
	chmodSync(parent, 0o700);
	const temporary = join(parent, `.${safeKey(path)}.${process.pid}.tmp`);
	const fd = openSync(temporary, "wx", 0o600);
	try {
		writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8");
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temporary, path);
	chmodSync(path, 0o600);
	const parentFd = openSync(parent, "r");
	try {
		fsyncSync(parentFd);
	} finally {
		closeSync(parentFd);
	}
}

function parseSessionBinding(value: unknown): SessionBinding {
	const input = record(value, "launcher session binding");
	if (
		Object.keys(input).sort().join(",") !==
			"hostEpoch,pid,pidStart,sessionId,v" ||
		input.v !== 1 ||
		!Number.isSafeInteger(input.pid) ||
		(input.pid as number) <= 0
	) {
		throw new Error("launcher returned an invalid session binding");
	}
	return {
		v: 1,
		hostEpoch: text(input.hostEpoch, "session binding hostEpoch"),
		sessionId: text(input.sessionId, "session binding sessionId"),
		pid: input.pid as number,
		pidStart: text(input.pidStart, "session binding pidStart"),
	};
}

function parseProbe(
	value: unknown,
): Awaited<ReturnType<ProcessProbePort["probe"]>> {
	const input = record(value, "launcher probe");
	if (
		input.state === "absent" &&
		Object.keys(input).sort().join(",") === "confirmedAt,state"
	) {
		return {
			state: "absent",
			confirmedAt: text(input.confirmedAt, "probe confirmedAt"),
		};
	}
	if (
		input.state === "present" &&
		Object.keys(input).sort().join(",") === "confirmedAt,sessionBinding,state"
	) {
		return {
			state: "present",
			confirmedAt: text(input.confirmedAt, "probe confirmedAt"),
			sessionBinding: parseSessionBinding(input.sessionBinding),
		};
	}
	throw new Error("launcher returned an invalid process probe");
}

export class CommandRunnerLauncher implements RunnerLauncherPort {
	readonly #command: string[];
	readonly #requestRoot: string;

	constructor(options: CommandRunnerLauncherOptions) {
		if (options.command.length === 0) {
			throw new TypeError("launcher command must not be empty");
		}
		absolute(options.command[0] as string, "launcher executable");
		this.#command = [...options.command];
		this.#requestRoot = absolute(options.requestRoot, "requestRoot");
		mkdirSync(this.#requestRoot, { recursive: true, mode: 0o700 });
		chmodSync(this.#requestRoot, 0o700);
	}

	async #invoke(
		action: "launch" | "probe" | "stop",
		sessionRef: string,
		value: unknown,
	): Promise<unknown> {
		const path = join(
			this.#requestRoot,
			`${safeKey(sessionRef)}.${action}.json`,
		);
		atomicJson(path, value);
		const [file, ...prefix] = this.#command;
		const result = await execFileAsync(
			file as string,
			[...prefix, action, "--request", path],
			{
				encoding: "utf8",
				maxBuffer: 4 * 1024 * 1024,
			},
		);
		try {
			return JSON.parse(result.stdout) as unknown;
		} catch {
			throw new Error(`launcher ${action} returned malformed JSON`);
		}
	}

	async launch(request: RuntimeLaunchRequest): Promise<SessionBinding> {
		return parseSessionBinding(
			await this.#invoke("launch", request.sessionRef, request),
		);
	}

	async probe(
		sessionRef: string,
	): Promise<Awaited<ReturnType<ProcessProbePort["probe"]>>> {
		return parseProbe(
			await this.#invoke("probe", sessionRef, { v: 1, sessionRef }),
		);
	}

	async stop(sessionRef: string): Promise<void> {
		const result = record(
			await this.#invoke("stop", sessionRef, { v: 1, sessionRef }),
			"launcher stop result",
		);
		if (
			Object.keys(result).sort().join(",") !== "status" ||
			result.status !== "stopped"
		) {
			throw new Error("launcher did not confirm runner stop");
		}
	}
}

function parseMetaEnvelope(
	value: string,
	label: string,
): Record<string, unknown> {
	const envelope = record(JSON.parse(value), label);
	if (
		envelope.v !== 1 ||
		!Number.isSafeInteger(envelope.revision) ||
		typeof envelope.cutover_epoch !== "number"
	) {
		throw new Error(`${label} has an invalid envelope`);
	}
	return record(envelope.data, `${label} data`);
}

function launchContext(
	kernel: Kernel,
	request: SpawnRequest,
): Omit<RuntimeLaunchRequest["context"], "instruction"> {
	return kernel.read((tx) => {
		const task = tx.get<TaskLaunchRow>(
			`SELECT project_id,external_issue_id,payload
			   FROM tasks WHERE id=@taskId`,
			{ taskId: request.taskId },
		);
		if (!task) throw new Error("spawn task is missing");
		const payload = record(JSON.parse(task.payload), "spawn task payload");
		const executor = record(payload.executor, "spawn task executor");
		if (executor.logicalAgentId !== request.agent.agentId) {
			throw new FenceViolation("spawn agent does not match task executor");
		}
		let worktreeId =
			typeof payload.worktree_id === "string" ? payload.worktree_id : undefined;
		if (!worktreeId) {
			const issue = tx.get<{ value: string }>(
				"SELECT value FROM meta WHERE key=@key",
				{ key: `dag_issue:${task.external_issue_id}` },
			);
			if (!issue) throw new Error("spawn issue mapping is missing");
			worktreeId = text(
				parseMetaEnvelope(issue.value, "spawn issue mapping").ship_worktree_id,
				"ship worktree id",
			);
		}
		const worktree = tx.get<{ value: string }>(
			"SELECT value FROM meta WHERE key=@key",
			{ key: `canonical_worktree:${worktreeId}` },
		);
		if (!worktree) throw new Error("spawn canonical worktree is missing");
		return {
			projectId: task.project_id,
			issueId: task.external_issue_id,
			projectRoot: text(
				parseMetaEnvelope(worktree.value, "spawn canonical worktree")
					.worktree_path,
				"spawn project root",
			),
		};
	});
}

function recordInstructionEvidence(input: {
	kernel: Kernel;
	request: SpawnRequest;
	context: Omit<RuntimeLaunchRequest["context"], "instruction">;
	instruction: ResolvedRoleInstruction;
	nowIso: string;
}): InstructionEvidence {
	const proposed = {
		v: 1 as const,
		project_id: input.context.projectId,
		issue_id: input.context.issueId,
		logical_agent_id: input.request.agent.agentId,
		config_path: input.instruction.configPath,
		source_path: input.instruction.sourcePath,
		content_digest: input.instruction.contentDigest,
		content_bytes: input.instruction.contentBytes,
	};
	return input.kernel.write("host.record-runner-instruction", (tx) => {
		const lineage = tx.get<{
			task_id: string;
			attempt_generation: number;
			activation_id: string;
			activation_state: string;
		}>(
			`SELECT a.task_id,a.generation AS attempt_generation,
			        act.id AS activation_id,act.state AS activation_state
			   FROM attempts a
			   JOIN activations act ON act.attempt_id=a.id
			  WHERE a.id=@attemptId AND act.id=@activationId`,
			{
				attemptId: input.request.attemptId,
				activationId: input.request.activationId,
			},
		);
		if (
			!lineage ||
			lineage.task_id !== input.request.taskId ||
			lineage.attempt_generation !== input.request.attemptGeneration ||
			lineage.activation_state !== "active"
		) {
			throw new FenceViolation("instruction evidence lineage mismatch");
		}
		const key = `attempt_instruction:${input.request.attemptId}`;
		const existing = tx.get<{ value: string }>(
			"SELECT value FROM meta WHERE key=@key",
			{ key },
		);
		if (existing) {
			const parsed = record(
				JSON.parse(existing.value),
				"instruction evidence",
			) as unknown as InstructionEvidence;
			const { resolved_at: _resolvedAt, ...observed } = parsed;
			if (JSON.stringify(observed) !== JSON.stringify(proposed)) {
				throw new FenceViolation(
					"role instruction changed after this attempt was prepared",
				);
			}
			return parsed;
		}
		const evidence: InstructionEvidence = {
			...proposed,
			resolved_at: input.nowIso,
		};
		tx.run("INSERT INTO meta(key,value,updated_at) VALUES(@key,@value,@now)", {
			key,
			value: JSON.stringify(evidence),
			now: input.nowIso,
		});
		return evidence;
	});
}

function kernelSpawnPort(
	kernel: Kernel,
	launcher: RunnerLauncherPort,
	nowIso: () => string,
): SpawnPort {
	return {
		async spawn(request) {
			const context = launchContext(kernel, request);
			const instruction = resolveRoleInstruction({
				projectRoot: context.projectRoot,
				logicalAgentId: request.agent.agentId,
			});
			recordInstructionEvidence({
				kernel,
				request,
				context,
				instruction,
				nowIso: nowIso(),
			});
			return await launcher.launch({
				...request,
				context: {
					...context,
					projectRoot: instruction.projectRoot,
					instruction,
				},
			});
		},
	};
}

function launchLock(root: string): LaunchLockPort {
	absolute(root, "lockRoot");
	mkdirSync(root, { recursive: true, mode: 0o700 });
	chmodSync(root, 0o700);
	return {
		async withSessionLock(sessionRef, fn) {
			const path = join(root, `${safeKey(sessionRef)}.lock`);
			try {
				mkdirSync(path, { mode: 0o700 });
			} catch (error) {
				if (
					error instanceof Error &&
					"code" in error &&
					error.code === "EEXIST"
				) {
					throw new FenceViolation("runner session launch is already locked");
				}
				throw error;
			}
			try {
				return await fn();
			} finally {
				rmdirSync(path);
			}
		},
	};
}

function injectionBuilder(root: string): InjectionRefBuilder {
	absolute(root, "injectionRoot");
	mkdirSync(root, { recursive: true, mode: 0o700 });
	chmodSync(root, 0o700);
	return {
		build(input) {
			const key = safeKey(input.sessionRef);
			if (/codex/i.test(input.executor.vendor)) {
				return JSON.stringify({
					v: 1,
					backend: "codex",
					socketPath: join(root, "codex", `${key.slice(0, 24)}.sock`),
					threadId: input.sessionRef,
				});
			}
			if (/claude/i.test(input.executor.vendor)) {
				const agentName = input.agentId
					.replace(/[^A-Za-z0-9_-]+/g, "-")
					.slice(0, 64);
				const teamName = `v2-${agentName}`.toLowerCase();
				// Codex R3 MEDIUM-5/7: the Claude root is per-ACTIVATION, not per-agent.
				// Sharing one root across activations of the same agent broke two things
				// at once: every launcher wrote the same .claude.json (so a live Claude
				// process could overwrite a just-written project trust entry with its own
				// older snapshot and send the next runner back into interactive
				// onboarding), and the inbox carried the previous activation's unread
				// envelopes into a new terminal. Both are the same root cause, so both
				// are fixed by the same key.
				const activationRoot = join(
					root,
					"claude",
					safeKey(input.activationId),
				);
				const inboxPath = join(
					activationRoot,
					"teams",
					teamName,
					"inboxes",
					`${agentName}.json`,
				);
				return JSON.stringify({
					v: 1,
					backend: "claude",
					inboxPath,
					sidecarPath: `${inboxPath}.flywheel.jsonl`,
					toAgent: agentName,
				});
			}
			throw new Error(
				`executor vendor ${input.executor.vendor} has no injection shim`,
			);
		},
	};
}

export function createRuntimeDagPorts(
	options: RuntimeDagPortsOptions,
): DagPorts {
	const gitBin = options.gitBin ?? "/usr/bin/git";
	const ghBin = options.ghBin ?? "/usr/local/bin/gh";
	const now = options.now ?? (() => new Date());
	const output = (file: string, args: string[]) =>
		execFileSync(file, args, {
			encoding: "utf8",
			maxBuffer: 16 * 1024 * 1024,
		}).trim();
	const git = {
		async readHead(worktreePath: string) {
			return output(gitBin, ["-C", worktreePath, "rev-parse", "HEAD"]);
		},
		async mergeBase(worktreePath: string, mergeTargetRef: string) {
			return output(gitBin, [
				"-C",
				worktreePath,
				"merge-base",
				"HEAD",
				mergeTargetRef,
			]);
		},
		async isAncestor(worktreePath: string, ancestor: string, head: string) {
			try {
				output(gitBin, [
					"-C",
					worktreePath,
					"merge-base",
					"--is-ancestor",
					ancestor,
					head,
				]);
				return true;
			} catch {
				return false;
			}
		},
		async rawDiff(worktreePath: string, base: string, head: string) {
			return output(gitBin, [
				"-C",
				worktreePath,
				"diff",
				"--raw",
				"-z",
				base,
				head,
			]);
		},
		async readRef(repoIdentity: string, ref: string) {
			try {
				return isAbsolute(repoIdentity)
					? output(gitBin, ["-C", repoIdentity, "rev-parse", ref])
					: output(ghBin, [
							"api",
							`repos/${repoIdentity}/git/ref/${ref.replace(/^refs\//, "")}`,
							"--jq",
							".object.sha",
						]);
			} catch {
				return null;
			}
		},
	};
	const clock = {
		nowMs: () => now().getTime(),
		nowIso: () => now().toISOString(),
	};
	const runnerControl: RunnerControlPort = {
		requestStop: (sessionRef) => options.launcher.stop(sessionRef),
	};
	return {
		clock,
		git,
		worktreeRef: {
			async worktreePresent(worktreePath) {
				try {
					await git.readHead(worktreePath);
					return true;
				} catch {
					return false;
				}
			},
			readExactRef: (repoIdentity, ref) => git.readRef(repoIdentity, ref),
		},
		process: { probe: (sessionRef) => options.launcher.probe(sessionRef) },
		runnerControl,
		host: { hostEpoch: () => options.hostEpoch },
		injectionRef: injectionBuilder(options.injectionRoot),
		locks: launchLock(options.lockRoot),
		spawn: kernelSpawnPort(options.kernel, options.launcher, clock.nowIso),
	};
}
