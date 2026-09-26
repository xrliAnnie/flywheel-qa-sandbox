/** Untrusted pre-exec candidates. Only the injected Bridge verifier accepts a native worker. */
import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { access, open, realpath } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext } from "flywheel-core";
import { z } from "zod";
import {
	type InspectedExecutionProcess,
	readExecutionProcessIdentity,
} from "./execution-process-inspector.js";
import type { BodyObservation } from "./execution-process-liveness.js";

const MAX_BYTES = 16 * 1024;
const identity = z
	.string()
	.min(1)
	.max(256)
	.regex(/^[^\p{Cc}]+$/u);
const pathText = z
	.string()
	.min(1)
	.max(4096)
	.regex(/^\/[^\p{Cc}]*$/u);
const requestSchema = z
	.object({
		version: z.literal(1),
		executionId: identity,
		generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
		ownerToken: identity,
		nonce: identity.regex(/^[A-Za-z0-9_-]+$/),
		adapter: z.enum(["claude-tmux", "kimi-tmux", "antigravity-tmux"]),
		binaryName: identity,
		nativeSessionId: identity.nullable(),
		cwd: pathText,
	})
	.strict();
const candidateSchema = requestSchema
	.extend({
		pid: z.number().int().min(2).max(Number.MAX_SAFE_INTEGER),
		pgid: z.number().int().min(2).max(Number.MAX_SAFE_INTEGER),
		startIdentity: identity,
		hostBootId: identity,
		shellExecutable: pathText,
	})
	.strict();
export type ExecutionProcessLaunchRequest = z.infer<typeof requestSchema>;
export type ExecutionProcessLaunchCandidate = z.infer<typeof candidateSchema>;
export interface ExecutionProcessLaunchManifest {
	requestPath: string;
	candidatePath: string;
	request: ExecutionProcessLaunchRequest;
}
export interface TmuxProcessLaunchLease {
	readonly generation: number;
	readonly ownerToken: string;
	readonly nonce: string;
	/** Pin the verified command and interpreter lookup, independent of tmux's PATH. */
	readonly launchPath?: string;
	readonly launchEnvPath?: string;
	readonly signal?: AbortSignal;
	/** Bridge-owned accepted identity; missing/unknown evidence never means gone. */
	observeBody?(): Promise<BodyObservation | undefined>;
	isCurrentBody?(observation: BodyObservation): boolean;
	classifyBodyExit?(
		observation: BodyObservation,
	): Promise<"completed" | "abnormal_process_exit" | "pending">;
	prepareSpawn(): Promise<void>;
	authorizeSpawn(): boolean;
	acceptSpawn(candidate: ExecutionProcessLaunchCandidate): Promise<void>;
	close(): Promise<void>;
	finish(): Promise<void>;
}

export interface ExecutionLaunchExecutable {
	launchPath: string;
	executable: string;
	launchEnvPath: string;
}

/** Resolve the actual executable before creating a durable spawn permit. Script
 * launchers (e.g. Kimi) bind their native interpreter, never their ps title. */
export async function resolveExecutionLaunchExecutable(
	binaryName: string,
	launchEnvPath = process.env.PATH ?? "",
): Promise<ExecutionLaunchExecutable> {
	try {
		const entries = launchEnvPath.split(delimiter);
		const search = entries.filter((path) => isAbsolute(path));
		if (
			entries.length > 256 ||
			search.length === 0 ||
			entries.some((p) => /\p{Cc}/u.test(p))
		)
			throw new Error("invalid_path");
		// The pane receives this exact PATH too; relative entries cannot select a
		// different interpreter from the caller's worktree at native exec time.
		launchEnvPath = search.join(delimiter);
		const find = async (name: string): Promise<string> => {
			if (
				!name ||
				/\p{Cc}/u.test(name) ||
				(!isAbsolute(name) && !/^[A-Za-z0-9._+-]+$/.test(name))
			)
				throw new Error("invalid_executable");
			for (const candidate of isAbsolute(name)
				? [name]
				: search.map((p) => join(p, name))) {
				try {
					const path = await realpath(candidate);
					await access(path, constants.X_OK);
					const file = await open(
						path,
						constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
					);
					try {
						if ((await file.stat()).isFile()) return path;
					} finally {
						await file.close();
					}
				} catch {
					/* Continue the same trusted PATH lookup. */
				}
			}
			throw new Error("executable_missing");
		};
		const launchPath = await find(binaryName);
		let executable = launchPath;
		const seen = new Set<string>();
		for (let depth = 0; depth < 4; depth++) {
			if (seen.has(executable)) throw new Error("interpreter_cycle");
			seen.add(executable);
			const file = await open(
				executable,
				constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
			);
			let header: string;
			try {
				if (!(await file.stat()).isFile()) throw new Error("not_regular");
				const bytes = Buffer.alloc(4096);
				const read = await file.read(bytes, 0, bytes.length, 0);
				header = bytes.subarray(0, read.bytesRead).toString("utf8");
			} finally {
				await file.close();
			}
			if (!header.startsWith("#!"))
				return { launchPath, executable, launchEnvPath };
			const end = header.indexOf("\n");
			if (end < 0) throw new Error("invalid_shebang");
			const words = header.slice(2, end).trim().split(/\s+/);
			if (!isAbsolute(words[0]!)) throw new Error("relative_interpreter");
			if (words[0] === "/usr/bin/env" || words[0] === "/bin/env") {
				if (words.length !== 2 || words[1]!.startsWith("-"))
					throw new Error("unsupported_env_shebang");
				executable = await find(words[1]!);
			} else executable = await find(words[0]!);
		}
		throw new Error("interpreter_depth");
	} catch {
		throw new Error("process_launch_executable_unavailable");
	}
}
export interface TmuxProcessLaunchDeps {
	createLaunch(
		ctx: AdapterExecutionContext,
		input: Pick<
			ExecutionProcessLaunchRequest,
			"adapter" | "binaryName" | "nativeSessionId"
		>,
	): Promise<TmuxProcessLaunchLease>;
	/** Test seam; production uses the existing per-execution prompt directory. */
	manifestDirectory?: (ctx: AdapterExecutionContext) => string;
	waitForCandidate?: (
		manifest: ExecutionProcessLaunchManifest,
		options: { signal?: AbortSignal },
	) => Promise<ExecutionProcessLaunchCandidate>;
}

function readObject(path: string): unknown {
	const fd = openSync(
		path,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > MAX_BYTES)
			throw new Error("process_launch_invalid");
		const buffer = Buffer.alloc(MAX_BYTES + 1);
		let size = 0;
		while (size < buffer.length) {
			const n = readSync(fd, buffer, size, buffer.length - size, null);
			if (n === 0) break;
			size += n;
		}
		if (size > MAX_BYTES) throw new Error("process_launch_invalid");
		return JSON.parse(buffer.subarray(0, size).toString("utf8"));
	} finally {
		closeSync(fd);
	}
}
function writeAtomic(path: string, value: unknown): void {
	const text = JSON.stringify(value);
	if (Buffer.byteLength(text) > MAX_BYTES)
		throw new Error("process_launch_invalid");
	const tmp = join(dirname(path), `.${randomUUID()}.tmp`);
	const fd = openSync(
		tmp,
		constants.O_WRONLY |
			constants.O_CREAT |
			constants.O_EXCL |
			constants.O_NOFOLLOW,
		0o600,
	);
	try {
		try {
			writeFileSync(fd, `${text}\n`, "utf8");
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(tmp, path);
	} finally {
		try {
			unlinkSync(tmp);
		} catch {
			/* renamed or unavailable */
		}
	}
}
export function createExecutionProcessLaunchManifest(
	directory: string,
	input: ExecutionProcessLaunchRequest,
): ExecutionProcessLaunchManifest {
	const request = requestSchema.parse(input);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const directoryStat = lstatSync(directory);
	if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
		throw new Error("process_launch_invalid");
	const root = realpathSync(directory);
	const requestPath = join(
		root,
		`process-launch-${request.nonce}.request.json`,
	);
	const candidatePath = join(
		root,
		`process-launch-${request.nonce}.candidate.json`,
	);
	writeAtomic(requestPath, request);
	return { requestPath, candidatePath, request };
}
export async function registerExecutionProcessLaunchCandidate(
	requestPath: string,
	shellPid: number,
	options: {
		/** Actual positional command passed to exec by the same registered shell. */
		launchArgv?: readonly string[];
		readIdentity?: (pid: number) => Promise<InspectedExecutionProcess | null>;
	} = {},
): Promise<void> {
	const request = requestSchema.parse(readObject(requestPath));
	const argv = options.launchArgv;
	if (!argv || argv[0] !== request.binaryName)
		throw new Error("process_launch_arguments_mismatch");
	if (request.adapter === "claude-tmux") {
		const sessions: string[] = [];
		for (let i = 1; i < argv.length && argv[i] !== "--"; i++) {
			const arg = argv[i]!;
			if (arg === "--session-id" || arg === "--resume") {
				sessions.push(argv[++i] ?? "");
			} else if (
				arg.startsWith("--session-id=") ||
				arg.startsWith("--resume=")
			) {
				sessions.push(arg.slice(arg.indexOf("=") + 1));
			}
		}
		if (
			!request.nativeSessionId ||
			sessions.length !== 1 ||
			sessions[0] !== request.nativeSessionId
		)
			throw new Error("process_launch_arguments_mismatch");
	} else if (request.nativeSessionId !== null) {
		throw new Error("process_launch_arguments_mismatch");
	}
	if (!requestPath.endsWith(`process-launch-${request.nonce}.request.json`))
		throw new Error("process_launch_invalid");
	const native = await (options.readIdentity ?? readExecutionProcessIdentity)(
		shellPid,
	);
	// The helper is a child of the waiting shell. Its own PID is never a candidate.
	if (
		!native ||
		native.pid !== shellPid ||
		native.pgid !== shellPid ||
		native.cwd !== request.cwd
	)
		throw new Error("process_launch_identity_unavailable");
	const candidate = candidateSchema.parse({
		...request,
		pid: native.pid,
		pgid: native.pgid,
		startIdentity: native.startIdentity,
		hostBootId: native.hostBootId,
		shellExecutable: native.executable,
	});
	writeAtomic(
		join(
			dirname(requestPath),
			`process-launch-${request.nonce}.candidate.json`,
		),
		candidate,
	);
}
export function readExecutionProcessLaunchCandidate(
	manifest: ExecutionProcessLaunchManifest,
): ExecutionProcessLaunchCandidate {
	return verifyExecutionProcessLaunchCandidate(
		readObject(manifest.candidatePath),
		manifest.request,
	);
}

/** Bridge supplies its own expected request; candidate contents are never authority. */
export function verifyExecutionProcessLaunchCandidate(
	input: unknown,
	expected: ExecutionProcessLaunchRequest,
): ExecutionProcessLaunchCandidate {
	const candidate = candidateSchema.parse(input);
	const request = requestSchema.parse(expected);
	if (
		candidate.pid !== candidate.pgid ||
		Object.entries(request).some(
			([key, value]) =>
				candidate[key as keyof ExecutionProcessLaunchRequest] !== value,
		)
	)
		throw new Error("process_launch_invalid");
	return candidate;
}
export async function waitForExecutionProcessLaunchCandidate(
	manifest: ExecutionProcessLaunchManifest,
	options: {
		signal?: AbortSignal;
		timeoutMs?: number;
		now?: () => number;
		sleep?: (ms: number) => Promise<void>;
	} = {},
): Promise<ExecutionProcessLaunchCandidate> {
	const now = options.now ?? Date.now;
	const start = now();
	const budget = Math.min(5000, options.timeoutMs ?? 5000);
	if (!Number.isFinite(budget) || budget <= 0)
		throw new Error("process_launch_timeout");
	const sleep =
		options.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	for (;;) {
		if (options.signal?.aborted) throw new Error("process_launch_cancelled");
		const elapsed = now() - start;
		if (elapsed < 0 || elapsed >= budget)
			throw new Error("process_launch_timeout");
		try {
			return readExecutionProcessLaunchCandidate(manifest);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT")
				throw new Error("process_launch_invalid");
		}
		await sleep(Math.min(25, budget - elapsed));
	}
}

// This module is also the bounded pre-exec helper invoked by the pane shell.
if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const pid = Number(process.argv[4]);
	if (
		process.argv[2] !== "register" ||
		!process.argv[3] ||
		!Number.isSafeInteger(pid) ||
		pid <= 1
	)
		process.exitCode = 78;
	else
		void registerExecutionProcessLaunchCandidate(process.argv[3], pid, {
			launchArgv: process.argv.slice(5),
		}).catch(() => {
			process.stderr.write("FLYWHEEL_PROCESS_REGISTRATION_FAILED\n");
			process.exitCode = 78;
		});
}
