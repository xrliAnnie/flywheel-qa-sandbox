/**
 * Injectable subprocess seam (FLY-543).
 *
 * Every external process (whisper-cli / edge-tts / ffmpeg / afplay / claude) is
 * reached through a `ProcessRunner` so tests inject a fake and CI needs no
 * binaries (mirrors FLY-494's ExecFileFn injection). Two shapes:
 *   - run():   one-shot — await stdout/exit (STT, TTS, headless brain).
 *   - spawn(): long-lived handle with kill()/stdout stream (mic capture, player).
 *
 * argv hygiene (plan.md §3 hard rule): the executable path + flags may go in
 * argv, but user transcript / assistant text / prompts NEVER do — pass them via
 * `stdin`. The process table is a leak surface (the eval set has API-key / bot-
 * token sentences).
 */
import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";

export interface RunOptions {
	/** piped to the child's stdin (keeps secrets out of argv). */
	stdin?: Buffer | string;
	/** hard deadline; on expiry the child is SIGKILLed and a "timeout" thrown. */
	timeoutMs?: number;
	/** abort → SIGKILL the child, reject with "cancelled". */
	signal?: AbortSignal;
	env?: NodeJS.ProcessEnv;
	cwd?: string;
}

export interface RunResult {
	stdout: Buffer;
	stderr: string;
	code: number | null;
}

export interface SpawnOptions {
	env?: NodeJS.ProcessEnv;
	cwd?: string;
}

export interface ProcessHandle {
	readonly pid: number | undefined;
	kill(signal?: NodeJS.Signals): void;
	onStdout(cb: (chunk: Buffer) => void): void;
	onExit(
		cb: (code: number | null, signal: NodeJS.Signals | null) => void,
	): void;
	write(data: Buffer | string): void;
	/** write final data (if any) and close stdin (EOF). */
	end(data?: Buffer | string): void;
}

export interface ProcessRunner {
	run(cmd: string, args: string[], opts?: RunOptions): Promise<RunResult>;
	spawn(cmd: string, args: string[], opts?: SpawnOptions): ProcessHandle;
}

class NodeProcessHandle implements ProcessHandle {
	constructor(private readonly child: ChildProcess) {}
	get pid(): number | undefined {
		return this.child.pid;
	}
	kill(signal: NodeJS.Signals = "SIGTERM"): void {
		if (this.child.exitCode === null && this.child.signalCode === null) {
			this.child.kill(signal);
		}
	}
	onStdout(cb: (chunk: Buffer) => void): void {
		this.child.stdout?.on("data", (c: Buffer) => cb(c));
	}
	onExit(
		cb: (code: number | null, signal: NodeJS.Signals | null) => void,
	): void {
		this.child.on("exit", cb);
	}
	write(data: Buffer | string): void {
		this.child.stdin?.write(data);
	}
	end(data?: Buffer | string): void {
		this.child.stdin?.end(data);
	}
}

/** Default runner backed by node:child_process. */
export class NodeProcessRunner implements ProcessRunner {
	run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
		return new Promise<RunResult>((resolve, reject) => {
			if (opts.signal?.aborted) {
				reject(new AbortError());
				return;
			}
			const child = nodeSpawn(cmd, args, {
				env: opts.env ?? process.env,
				cwd: opts.cwd,
				stdio: ["pipe", "pipe", "pipe"],
			});

			const outChunks: Buffer[] = [];
			let stderr = "";
			let settled = false;
			let timer: NodeJS.Timeout | undefined;

			const cleanup = () => {
				if (timer) clearTimeout(timer);
				if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
			};
			const finish = (fn: () => void) => {
				if (settled) return;
				settled = true;
				cleanup();
				fn();
			};
			const onAbort = () => {
				child.kill("SIGKILL");
				finish(() => reject(new AbortError()));
			};

			child.on("error", (err) => finish(() => reject(err)));
			child.stdout?.on("data", (c: Buffer) => outChunks.push(c));
			child.stderr?.on("data", (c: Buffer) => {
				stderr += c.toString();
			});
			child.on("close", (code) =>
				finish(() =>
					resolve({ stdout: Buffer.concat(outChunks), stderr, code }),
				),
			);

			if (opts.timeoutMs && opts.timeoutMs > 0) {
				timer = setTimeout(() => {
					child.kill("SIGKILL");
					finish(() => reject(new TimeoutError(opts.timeoutMs as number)));
				}, opts.timeoutMs);
			}
			if (opts.signal) opts.signal.addEventListener("abort", onAbort);

			if (opts.stdin !== undefined) {
				child.stdin?.end(opts.stdin);
			} else {
				child.stdin?.end();
			}
		});
	}

	spawn(cmd: string, args: string[], opts: SpawnOptions = {}): ProcessHandle {
		const child = nodeSpawn(cmd, args, {
			env: opts.env ?? process.env,
			cwd: opts.cwd,
			stdio: ["pipe", "pipe", "pipe"],
		});
		return new NodeProcessHandle(child);
	}
}

/** Sentinel errors so run() rejections carry a machine-readable cause. */
export class AbortError extends Error {
	constructor() {
		super("process aborted");
		this.name = "AbortError";
	}
}

export class TimeoutError extends Error {
	constructor(public readonly timeoutMs: number) {
		super(`process timed out after ${timeoutMs}ms`);
		this.name = "TimeoutError";
	}
}
