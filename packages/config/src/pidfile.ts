import { execFileSync } from "node:child_process";
import {
	closeSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname } from "node:path";

export interface PidfileRecord {
	pid: number;
	uid: number;
	processStartTime: string;
	wakeProtocol?: number;
}

export interface SingletonPidfileDeps {
	pid?: number;
	uid?: number;
	processStartTime?: string;
	wakeProtocol?: number;
	isProcessAlive?: (pid: number) => boolean;
	readProcessStartTime?: (pid: number) => string | null;
	/** Deterministic race seam immediately before a stale record is reclaimed. */
	beforeStaleUnlink?: () => void;
}

export function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export function processStartTime(pid: number): string | null {
	try {
		const stdout = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
			encoding: "utf8",
			timeout: 2_000,
		});
		return stdout.trim() || null;
	} catch {
		return null;
	}
}

export interface OwnProcessStartTimeDeps {
	readStart?: (pid: number) => string | null;
	nowMs?: () => number;
	uptimeSeconds?: () => number;
}

export function resolveOwnProcessStartTime(
	deps: OwnProcessStartTimeDeps = {},
): string {
	const readStart = deps.readStart ?? processStartTime;
	const observed = readStart(process.pid);
	if (observed) return observed;
	const nowMs = deps.nowMs ?? Date.now;
	const uptimeSeconds = deps.uptimeSeconds ?? process.uptime;
	const bootMs = Math.max(0, Math.floor(nowMs() - uptimeSeconds() * 1_000));
	return `node-uptime:${bootMs}`;
}

export function parsePidfile(raw: string): PidfileRecord | null {
	try {
		const value = JSON.parse(raw) as Partial<PidfileRecord>;
		if (
			!Number.isInteger(value.pid) ||
			(value.pid as number) <= 0 ||
			!Number.isInteger(value.uid) ||
			(value.uid as number) < 0 ||
			typeof value.processStartTime !== "string" ||
			value.processStartTime.length === 0 ||
			(value.wakeProtocol !== undefined &&
				(!Number.isInteger(value.wakeProtocol) || value.wakeProtocol < 0))
		) {
			return null;
		}
		return value as PidfileRecord;
	} catch {
		return null;
	}
}

export function safeOwnedRegularFile(path: string, uid: number): boolean {
	try {
		const stat = lstatSync(path);
		return stat.isFile() && !stat.isSymbolicLink() && stat.uid === uid;
	} catch {
		return false;
	}
}

/** Atomically claim a pidfile and refuse ambiguous existing ownership. */
export function acquireSingletonPidfile(
	path: string,
	deps: SingletonPidfileDeps = {},
): { release: () => void } {
	const pid = deps.pid ?? process.pid;
	const uid = deps.uid ?? process.getuid?.() ?? -1;
	const readStart = deps.readProcessStartTime ?? processStartTime;
	const start = deps.processStartTime ?? readStart(pid);
	const isAlive = deps.isProcessAlive ?? processAlive;
	if (uid < 0 || !start) throw new Error("unsafe pidfile owner identity");
	if (
		deps.wakeProtocol !== undefined &&
		(!Number.isInteger(deps.wakeProtocol) || deps.wakeProtocol < 0)
	) {
		throw new Error("unsafe pidfile wake protocol");
	}
	const record: PidfileRecord = {
		pid,
		uid,
		processStartTime: start,
		...(deps.wakeProtocol === undefined
			? {}
			: { wakeProtocol: deps.wakeProtocol }),
	};
	mkdirSync(dirname(path), { recursive: true });

	for (let attempt = 0; attempt < 2; attempt++) {
		let fd: number;
		try {
			fd = openSync(path, "wx", 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (!safeOwnedRegularFile(path, uid)) {
				throw new Error(
					"unsafe existing pidfile (not a regular same-owner file)",
				);
			}
			let existingRaw: string;
			try {
				existingRaw = readFileSync(path, "utf8");
			} catch (readError) {
				if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw readError;
			}
			const existing = parsePidfile(existingRaw);
			if (existing === null || existing.uid !== uid) {
				throw new Error("unsafe existing pidfile record");
			}
			if (isAlive(existing.pid)) {
				const liveStart = readStart(existing.pid);
				if (liveStart === existing.processStartTime) {
					throw new Error(
						`quota monitor already running (pid ${existing.pid})`,
					);
				}
				throw new Error("unsafe pidfile: live PID start time does not match");
			}
			deps.beforeStaleUnlink?.();
			// The pathname may have been claimed by a successor after our liveness
			// check. Re-read and compare before unlinking so a stale observation never
			// deletes the successor's fresh pidfile.
			if (!safeOwnedRegularFile(path, uid)) continue;
			let latestRaw: string;
			try {
				latestRaw = readFileSync(path, "utf8");
			} catch (readError) {
				if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw readError;
			}
			if (latestRaw !== existingRaw) continue;
			try {
				unlinkSync(path);
			} catch (unlinkError) {
				if ((unlinkError as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw unlinkError;
			}
			continue;
		}
		try {
			writeSync(fd, `${JSON.stringify(record)}\n`);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		return {
			release(): void {
				if (!safeOwnedRegularFile(path, uid)) return;
				let current: PidfileRecord | null = null;
				try {
					current = parsePidfile(readFileSync(path, "utf8"));
				} catch {
					return;
				}
				if (
					current?.pid === record.pid &&
					current.uid === record.uid &&
					current.processStartTime === record.processStartTime
				) {
					unlinkSync(path);
				}
			},
		};
	}
	throw new Error("unable to acquire quota monitor pidfile");
}
