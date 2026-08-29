/**
 * Daemon state persistence (FLY-546 B2-2 ②) — atomic, fail-loud.
 *
 * - writes go tmp file → fsync → rename (a crash never leaves a torn file)
 * - 0600 (the queue snapshot may quote founder-facing message bodies)
 * - schemaVersion pinned; corrupt or unknown-version files are QUARANTINED
 *   (renamed aside with a timestamp) and the load throws — the daemon must
 *   never silently zero the queue/ledger (messages would vanish unspoken).
 */
import {
	closeSync,
	fsyncSync,
	openSync,
	readFileSync,
	renameSync,
	writeSync,
} from "node:fs";
import type { PersistedTurnState, QueueSnapshot } from "flywheel-voice-core";

export const STATE_SCHEMA_VERSION = 1;

export type DaemonState = {
	schemaVersion: number;
	modeOn: boolean;
	/** per-channel last seen Discord message id (snowflake) for offline backfill. */
	cursors: Record<string, string>;
	queue: QueueSnapshot;
	turn: PersistedTurnState | undefined;
};

export function saveState(path: string, state: DaemonState): void {
	const tmp = `${path}.tmp-${process.pid}`;
	const fd = openSync(tmp, "w", 0o600);
	try {
		writeSync(fd, JSON.stringify(state));
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, path);
}

function quarantine(path: string): string {
	const aside = `${path}.corrupt-${Date.now()}`;
	renameSync(path, aside);
	return aside;
}

export function loadState(path: string): DaemonState | undefined {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw err;
	}
	let parsed: DaemonState;
	try {
		parsed = JSON.parse(raw) as DaemonState;
	} catch (err) {
		const aside = quarantine(path);
		throw new Error(
			`headphone state: ${path} is corrupt — quarantined to ${aside}. Inspect it before restarting (the queue snapshot lives there).`,
			{ cause: err },
		);
	}
	if (parsed.schemaVersion !== STATE_SCHEMA_VERSION) {
		const aside = quarantine(path);
		throw new Error(
			`headphone state: unknown schemaVersion ${parsed.schemaVersion} (expected ${STATE_SCHEMA_VERSION}) — quarantined to ${aside}.`,
		);
	}
	return parsed;
}
