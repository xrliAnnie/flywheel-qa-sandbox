/**
 * FLY-1082 (Task 2.4): the Bridge dirty-exit marker — "died without a clean
 * shutdown" must leave an indelible signal (the 2026-07-09 Bridge fatal exit
 * left none; launchd respawned it silently).
 *
 * Lifecycle (evidence BEFORE overwrite — Codex R1 #5):
 *  1. wrapper preflight (scripts/lib/bridge-port.sh) READS the marker, never
 *     writes: a `running` marker at start time = the previous Bridge died
 *     dirty → the wrapper fires the Bridge-independent lead-alert.sh page
 *     (fast path, works while the Bridge is down).
 *  2. Bridge boot: LATCH the previous marker first, THEN write the fresh
 *     `running` marker (new generation). A latched `running` marker opens the
 *     `bridge_abnormal_exit` boot ticket (lifecycle leg).
 *  3. Clean shutdown: `close()` (the same path that flips /health
 *     shuttingDown — no extra signal handlers) flips the marker to `clean`.
 *
 * Dedup identities (Codex R2 #1 — the two legs must never collide in
 * claims.db, or the later one is swallowed):
 *  - wrapper page  id: `bridge-abnormal-exit-page:<prevPid>:<prevBootTs>`
 *  - boot ticket   id: `bridge-abnormal-exit-ticket:<prevPid>:<prevBootTs>`
 *  - shared episode : `bridge-abnormal-exit:<prevPid>:<prevBootTs>` (rides
 *    both messages/metadata so humans + QA can correlate the legs).
 */

import {
	closeSync,
	constants as fsConstants,
	fstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface BridgeExitMarker {
	pid: number;
	bootTs: number;
	state: "running" | "clean";
}

export interface BridgeWatchdogStallRecord {
	event: "bridge_event_loop_stall";
	pid: number;
	bootTs: number;
	stall_age_ms: number;
	at: string;
	last_sync_op?: string;
}

const MAX_WATCHDOG_LOG_BYTES = 256 * 1024;

/** Marker file path — env-overridable for QA Room isolation. */
export function bridgeMarkerPath(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.FLYWHEEL_BRIDGE_MARKER?.trim();
	if (override) return override;
	const stateRoot =
		env.FLYWHEEL_STATE_DIR?.trim() || join(homedir(), ".flywheel");
	return join(stateRoot, "state", "bridge-running-marker.json");
}

/** Watchdog forensic path — uses the same QA override as the worker. */
export function watchdogLogPath(env: NodeJS.ProcessEnv = process.env): string {
	const configured =
		env.FLYWHEEL_BRIDGE_WATCHDOG_LOG?.trim() ||
		"~/.flywheel/bridge-watchdog.log";
	if (configured === "~") return homedir();
	if (configured.startsWith("~/")) return join(homedir(), configured.slice(2));
	return configured;
}

/** Read (NEVER delete/overwrite) the previous marker. null = absent/garbage. */
export function latchPreviousMarker(path: string): BridgeExitMarker | null {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		if (
			typeof parsed?.pid === "number" &&
			typeof parsed?.bootTs === "number" &&
			(parsed?.state === "running" || parsed?.state === "clean")
		) {
			return { pid: parsed.pid, bootTs: parsed.bootTs, state: parsed.state };
		}
		return null;
	} catch {
		return null;
	}
}

/** Write this generation's `running` marker (AFTER latching the previous). */
export function writeRunningMarker(
	path: string,
	pid: number,
	bootTs: number,
): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(
		path,
		JSON.stringify({
			pid,
			bootTs,
			state: "running",
		} satisfies BridgeExitMarker),
		"utf-8",
	);
}

/**
 * Flip the marker to `clean` on the bounded-shutdown close path. Best-effort
 * (a failed write degrades to a spurious dirty page on next boot — noisy but
 * never silent); keeps pid/bootTs so the record stays attributable.
 */
export function writeCleanMarker(path: string): void {
	try {
		const current = latchPreviousMarker(path);
		writeFileSync(
			path,
			JSON.stringify({
				pid: current?.pid ?? process.pid,
				bootTs: current?.bootTs ?? 0,
				state: "clean",
			} satisfies BridgeExitMarker),
			"utf-8",
		);
	} catch {
		// best-effort — see docstring
	}
}

/** The shared episode signature both legs carry. */
export function abnormalExitEpisodeSignature(prev: BridgeExitMarker): string {
	return `bridge-abnormal-exit:${prev.pid}:${prev.bootTs}`;
}

/** The boot-leg (lifecycle ticket) dedup id — distinct from the wrapper page. */
export function abnormalExitTicketEventId(prev: BridgeExitMarker): string {
	return `bridge-abnormal-exit-ticket:${prev.pid}:${prev.bootTs}`;
}

/**
 * Find the newest watchdog record that can be attributed to exactly the dirty
 * Bridge generation. The read is bounded and refuses links/non-regular files;
 * a shared or QA-polluted log cannot attribute a different pid/generation.
 */
export function findWatchdogStallForExit(
	path: string,
	prev: BridgeExitMarker,
	currentBootTs: number,
): BridgeWatchdogStallRecord | null {
	let fd: number | undefined;
	try {
		fd = openSync(
			path,
			fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
		);
		const stat = fstatSync(fd);
		if (
			!stat.isFile() ||
			stat.size <= 0 ||
			stat.size > MAX_WATCHDOG_LOG_BYTES
		) {
			return null;
		}
		const buffer = Buffer.alloc(stat.size);
		const count = readSync(fd, buffer, 0, stat.size, 0);
		const lines = buffer.subarray(0, count).toString("utf8").split("\n");
		for (let index = lines.length - 1; index >= 0; index -= 1) {
			const line = lines[index]?.trim();
			if (!line) continue;
			const record = parseWatchdogStallRecord(line);
			if (!record) continue;
			const atMs = Date.parse(record.at);
			if (
				record.pid === prev.pid &&
				record.bootTs === prev.bootTs &&
				atMs >= prev.bootTs &&
				atMs < currentBootTs
			) {
				return record;
			}
		}
		return null;
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

/** One alert payload builder keeps the boot emission site single-shot. */
export function buildAbnormalExitAlertContent(
	prev: BridgeExitMarker,
	stall: BridgeWatchdogStallRecord | null,
): { title: string; body: string } {
	const episode = abnormalExitEpisodeSignature(prev);
	if (stall) {
		return {
			title: "Bridge event loop 卡死自杀 — 复活对账中",
			body: `上一代 Bridge (PID ${prev.pid}, boot ${prev.bootTs}) 的 watchdog 记录到 event loop 卡死 ${stall.stall_age_ms}ms，最后同步操作：${stall.last_sync_op ?? "无标记"}（episode ${episode}；wrapper 直发 page 同一 episode）。launchd 已复活本进程；boot 对账完成后本工单安静 resolve。`,
		};
	}
	return {
		title: "Bridge 非正常退出 — 复活对账中",
		body: `上一代 Bridge (PID ${prev.pid}, boot ${prev.bootTs}) 没有 clean shutdown 就退出了（episode ${episode}；wrapper 直发 page 同一 episode）。launchd 已复活本进程；boot 对账完成后本工单安静 resolve。`,
	};
}

function parseWatchdogStallRecord(
	line: string,
): BridgeWatchdogStallRecord | null {
	try {
		const parsed = JSON.parse(line);
		if (
			parsed?.event !== "bridge_event_loop_stall" ||
			!Number.isSafeInteger(parsed.pid) ||
			parsed.pid <= 0 ||
			!Number.isFinite(parsed.bootTs) ||
			parsed.bootTs < 0 ||
			!Number.isFinite(parsed.stall_age_ms) ||
			parsed.stall_age_ms < 0 ||
			typeof parsed.at !== "string" ||
			!Number.isFinite(Date.parse(parsed.at)) ||
			(parsed.last_sync_op !== undefined &&
				(typeof parsed.last_sync_op !== "string" ||
					parsed.last_sync_op.length === 0 ||
					parsed.last_sync_op.length > 256))
		) {
			return null;
		}
		return {
			event: "bridge_event_loop_stall",
			pid: parsed.pid,
			bootTs: parsed.bootTs,
			stall_age_ms: parsed.stall_age_ms,
			at: parsed.at,
			...(parsed.last_sync_op ? { last_sync_op: parsed.last_sync_op } : {}),
		};
	} catch {
		return null;
	}
}
