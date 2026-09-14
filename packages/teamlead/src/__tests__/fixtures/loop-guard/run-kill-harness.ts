import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LOOP_GUARD_WORKER_SOURCE } from "../../../bridge/BridgeEventLoopGuard.js";

export function canInspectProcesses(): boolean {
	return (
		spawnSync("/bin/ps", ["-axo", "pid=,ppid=,etime=,comm="], {
			stdio: "ignore",
		}).status === 0
	);
}

function killGroup(pid: number) {
	try {
		process.kill(-pid, "SIGKILL");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

export async function runKillHarness(options: {
	psAvailable: boolean;
	execDelayMs: number;
	legacy?: boolean;
}) {
	const dir = mkdtempSync(join(tmpdir(), "fly2548-kill-"));
	const sourcePath = join(dir, "worker-source.js");
	const logPath = join(dir, "loop-guard.log");
	const readyPath = join(dir, "sleep-ready.json");
	writeFileSync(sourcePath, LOOP_GUARD_WORKER_SOURCE);
	const child = spawn(
		process.execPath,
		[
			fileURLToPath(new URL("./kill-harness.cjs", import.meta.url)),
			sourcePath,
			logPath,
			readyPath,
			String(options.psAvailable),
			String(options.execDelayMs),
			options.legacy ? "legacy" : "ready",
		],
		{ detached: true, stdio: ["ignore", "ignore", "pipe"] },
	);
	let stderr = "";
	child.stderr?.on("data", (chunk) => {
		stderr = (stderr + chunk).slice(-4096);
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	const exited = new Promise<{
		code: number | null;
		signal: NodeJS.Signals | null;
	}>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => resolve({ code, signal }));
	});
	try {
		const result = await Promise.race([
			exited,
			new Promise<never>((_, reject) => {
				// 4s readiness + 200ms stall + 5s freeze grace + 2s forensic ps.
				// The sleep lasts 30s; this deadline precedes Vitest's 15s limit.
				timer = setTimeout(
					() => reject(new Error(`kill harness exceeded 12s: ${stderr}`)),
					12_000,
				);
			}),
		]);
		if (result.signal !== "SIGKILL") {
			throw new Error(
				`kill harness exited ${JSON.stringify(result)}: ${stderr}`,
			);
		}
		const forensic = JSON.parse(readFileSync(logPath, "utf8").trim()) as {
			pid: number;
			tick_gap_ms: number;
			attribution: string;
			children: Array<{ pid: number; comm: string }> | null;
		};
		const ready =
			options.psAvailable && !options.legacy
				? (JSON.parse(readFileSync(readyPath, "utf8")) as {
						pid: number;
						ppid: number;
					})
				: null;
		return { result, forensic, ready, harnessPid: child.pid };
	} finally {
		clearTimeout(timer);
		// Only our detached process group: includes the orphan sleep after the
		// guard kills the harness and does not include Vitest sibling workers.
		if (child.pid) killGroup(child.pid);
		await exited.catch(() => undefined);
		rmSync(dir, { recursive: true, force: true });
	}
}
