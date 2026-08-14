import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants as fsConstants,
	fstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_MARKER_BYTES = 4096;
const MARKER_RE = /^bridge-syncop\.(\d+)\.json$/;

export interface SyncOpMarker {
	label: string;
	startedAt: number;
	pid: number;
	token: string;
}

type MarkerOptions = {
	pid?: number;
	now?: () => number;
	env?: NodeJS.ProcessEnv;
};

export function syncOpMarkerPath(
	pid = process.pid,
	env: NodeJS.ProcessEnv = process.env,
): string {
	const dir =
		env.FLYWHEEL_BRIDGE_SYNCOP_DIR?.trim() || join(homedir(), ".flywheel");
	return join(dir, `bridge-syncop.${pid}.json`);
}

/** Secure bounded read shared by clear, sync-op attribution and tests. */
export function readSyncOpMarker(path: string): SyncOpMarker | null {
	let fd: number | undefined;
	try {
		fd = openSync(
			path,
			fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
		);
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_MARKER_BYTES) {
			return null;
		}
		const buffer = Buffer.alloc(stat.size);
		const count = readSync(fd, buffer, 0, stat.size, 0);
		const parsed = JSON.parse(buffer.subarray(0, count).toString("utf8"));
		if (
			typeof parsed?.label !== "string" ||
			parsed.label.length === 0 ||
			parsed.label.length > 256 ||
			typeof parsed?.token !== "string" ||
			parsed.token.length === 0 ||
			!Number.isSafeInteger(parsed?.pid) ||
			parsed.pid <= 0 ||
			!Number.isFinite(parsed?.startedAt) ||
			parsed.startedAt < 0
		) {
			return null;
		}
		return {
			label: parsed.label,
			startedAt: parsed.startedAt,
			pid: parsed.pid,
			token: parsed.token,
		};
	} catch {
		return null;
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				/* best-effort */
			}
		}
	}
}

/** Best-effort atomic replace. Marker failure must never change business flow. */
export function markSyncOp(
	label: string,
	options: MarkerOptions = {},
): string | undefined {
	const pid = options.pid ?? process.pid;
	const now = options.now ?? Date.now;
	const env = options.env ?? process.env;
	if (!Number.isSafeInteger(pid) || pid <= 0 || !label || label.length > 256) {
		return undefined;
	}
	const token = randomUUID();
	const path = syncOpMarkerPath(pid, env);
	const temp = `${path}.${token}.tmp`;
	try {
		mkdirSync(path.slice(0, path.lastIndexOf("/")), {
			recursive: true,
			mode: 0o700,
		});
		writeFileSync(
			temp,
			JSON.stringify({
				label,
				startedAt: now(),
				pid,
				token,
			} satisfies SyncOpMarker),
			{ encoding: "utf8", flag: "wx", mode: 0o600 },
		);
		renameSync(temp, path);
		return token;
	} catch {
		try {
			rmSync(temp, { force: true });
		} catch {
			/* best-effort */
		}
		return undefined;
	}
}

export function clearSyncOp(
	token: string | undefined,
	options: Pick<MarkerOptions, "pid" | "env"> = {},
): void {
	if (!token) return;
	const pid = options.pid ?? process.pid;
	const path = syncOpMarkerPath(pid, options.env ?? process.env);
	try {
		const marker = readSyncOpMarker(path);
		if (marker?.pid === pid && marker.token === token)
			rmSync(path, { force: true });
	} catch {
		/* best-effort */
	}
}

export function withSyncOpMarker<T>(label: string, fn: () => T): T {
	const token = markSyncOp(label);
	try {
		return fn();
	} finally {
		clearSyncOp(token);
	}
}

export function sweepStaleSyncOpMarkers(
	options: {
		env?: NodeJS.ProcessEnv;
		isPidAlive?: (pid: number) => boolean;
	} = {},
): void {
	const env = options.env ?? process.env;
	const markerForSelf = syncOpMarkerPath(process.pid, env);
	const dir = markerForSelf.slice(0, markerForSelf.lastIndexOf("/"));
	const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
	try {
		for (const name of readdirSync(dir)) {
			const match = MARKER_RE.exec(name);
			if (!match) continue;
			const pid = Number(match[1]);
			if (!Number.isSafeInteger(pid) || pid <= 0 || isPidAlive(pid)) continue;
			rmSync(join(dir, name), { force: true });
		}
	} catch {
		/* best-effort */
	}
}

function defaultIsPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
