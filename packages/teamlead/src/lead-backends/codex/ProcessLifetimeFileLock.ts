import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

const LOCK_HELPER = `
import errno, fcntl, os, sys
try:
    fd = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    print("conflict", flush=True)
    sys.exit(0)
except Exception as exc:
    print("unavailable:" + repr(exc), flush=True)
    sys.exit(0)
print("acquired:" + str(os.getpid()), flush=True)
sys.stdin.buffer.read()
`;

export interface ProcessLockHandle {
	readonly helperPid?: number;
	close(): Promise<void>;
}

export type ProcessLockAttempt =
	| { status: "acquired"; handle: ProcessLockHandle }
	| { status: "conflict" }
	| { status: "unavailable"; error: string };

export interface ProcessLifetimeFileLockOptions {
	pythonPath?: string;
	readyTimeoutMs?: number;
	onLost?: (error: string) => void;
}

export type ProcessLockAcquire = (
	path: string,
	onLost?: (error: string) => void,
) => Promise<ProcessLockAttempt>;

export async function acquireProcessLifetimeFileLock(
	path: string,
	opts: ProcessLifetimeFileLockOptions = {},
): Promise<ProcessLockAttempt> {
	const pythonPath = opts.pythonPath ?? "/usr/bin/python3";
	let child: ChildProcessWithoutNullStreams;
	try {
		child = spawn(pythonPath, ["-c", LOCK_HELPER, path], {
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch (error) {
		return { status: "unavailable", error: (error as Error).message };
	}

	const ready = await firstLine(child, opts.readyTimeoutMs ?? 5_000);
	if (!ready.startsWith("acquired:")) {
		child.stdin.end();
		if (ready === "conflict") return { status: "conflict" };
		return {
			status: "unavailable",
			error: ready.startsWith("unavailable:")
				? ready.slice("unavailable:".length)
				: ready,
		};
	}

	let closing = false;
	let closed: Promise<void> | undefined;
	child.once("exit", (code, signal) => {
		if (!closing) {
			opts.onLost?.(
				`lock helper exited code=${code ?? "null"} signal=${signal ?? "null"}`,
			);
		}
	});
	return {
		status: "acquired",
		handle: {
			helperPid: child.pid,
			close: () => {
				if (closed) return closed;
				closing = true;
				closed = new Promise<void>((resolve) => {
					if (child.exitCode !== null || child.signalCode !== null) {
						resolve();
						return;
					}
					child.once("exit", () => resolve());
					child.stdin.end();
				});
				return closed;
			},
		},
	};
}

function firstLine(
	child: ChildProcessWithoutNullStreams,
	timeoutMs: number,
): Promise<string> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (value: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
			const newline = stdout.indexOf("\n");
			if (newline >= 0) finish(stdout.slice(0, newline).trim());
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.once("error", (error) => finish(`spawn failed: ${error.message}`));
		child.once("exit", (code, signal) =>
			finish(
				stdout.trim() ||
					stderr.trim() ||
					`helper exited code=${code ?? "null"} signal=${signal ?? "null"}`,
			),
		);
		const timer = setTimeout(() => {
			child.kill();
			finish(`helper ready timeout after ${timeoutMs}ms`);
		}, timeoutMs);
		timer.unref?.();
	});
}
