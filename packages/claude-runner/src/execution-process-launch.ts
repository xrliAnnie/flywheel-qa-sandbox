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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext } from "flywheel-core";
import { z } from "zod";
import {
	type InspectedExecutionProcess,
	readExecutionProcessIdentity,
} from "./execution-process-inspector.js";

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
	readonly signal?: AbortSignal;
	prepareSpawn(): Promise<void>;
	authorizeSpawn(): boolean;
	acceptSpawn(candidate: ExecutionProcessLaunchCandidate): Promise<void>;
	close(): Promise<void>;
	finish(): Promise<void>;
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
		readIdentity?: (pid: number) => Promise<InspectedExecutionProcess | null>;
	} = {},
): Promise<void> {
	const request = requestSchema.parse(readObject(requestPath));
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
	const candidate = candidateSchema.parse(readObject(manifest.candidatePath));
	if (
		candidate.pid !== candidate.pgid ||
		Object.entries(manifest.request).some(
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
		void registerExecutionProcessLaunchCandidate(process.argv[3], pid).catch(
			() => {
				process.stderr.write("FLYWHEEL_PROCESS_REGISTRATION_FAILED\n");
				process.exitCode = 78;
			},
		);
}
