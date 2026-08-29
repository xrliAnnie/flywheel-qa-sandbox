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

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface BridgeExitMarker {
	pid: number;
	bootTs: number;
	state: "running" | "clean";
}

/** Marker file path — env-overridable for QA Room isolation. */
export function bridgeMarkerPath(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.FLYWHEEL_BRIDGE_MARKER?.trim();
	if (override) return override;
	const stateRoot =
		env.FLYWHEEL_STATE_DIR?.trim() || join(homedir(), ".flywheel");
	return join(stateRoot, "state", "bridge-running-marker.json");
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
