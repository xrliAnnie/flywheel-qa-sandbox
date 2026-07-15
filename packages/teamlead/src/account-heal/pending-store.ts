/**
 * FLY-696 M1/C8c — durable account_switch_pending store.
 *
 * File-backed (atomic 0600, like the account state), so a pending switch survives
 * a Bridge restart (Codex R4#3). Callers that read→mutate→write MUST hold the
 * shared account flock (withMkdirLock) — the same lock the switch executor takes —
 * so a manual profile use, a QA-slot Bridge, or the watchdog can't interleave.
 *
 * The record is keyed by sourceAlertId+observedAccount+generation so a duplicate
 * trigger for the same cap upserts one record (no double-switch), and a
 * cross-provider Infra Bot can `claim` it before the Bridge watchdog fires.
 */

import {
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface PendingSwitch {
	key: string;
	provider: "claude";
	sourceAlertId: string;
	observedAccount: string;
	observedGeneration: number;
	scope: "5h" | "weekly" | "both";
	resetAt: string;
	/** ISO — the watchdog fires the switch after this if still unclaimed. */
	deadlineAt: string;
	createdAt: string;
	/** The Infra Bot (M2) that took ownership; unset → the watchdog may fire it. */
	claimedBy?: string;
}

export function pendingKey(
	sourceAlertId: string,
	observedAccount: string,
	observedGeneration: number,
): string {
	return `${sourceAlertId}|${observedAccount}|${observedGeneration}`;
}

export function defaultPendingPath(): string {
	return (
		process.env.FLYWHEEL_ACCOUNT_PENDING_PATH ??
		join(homedir(), ".flywheel", "account-switch-pending.json")
	);
}

export function readPending(
	path: string = defaultPendingPath(),
): PendingSwitch[] {
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch {
		return [];
	}
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? (parsed as PendingSwitch[]) : [];
	} catch {
		return [];
	}
}

export function writePending(
	records: PendingSwitch[],
	path: string = defaultPendingPath(),
): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp.${process.pid}`;
	const fd = openSync(tmp, "w", 0o600);
	try {
		writeSync(fd, `${JSON.stringify(records, null, 2)}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, path);
}

/** Add or replace the record with the same key. Caller holds the flock. */
export function upsertPending(
	record: PendingSwitch,
	path: string = defaultPendingPath(),
): void {
	const all = readPending(path).filter((r) => r.key !== record.key);
	all.push(record);
	writePending(all, path);
}

/** Remove the record with `key`. Caller holds the flock. */
export function resolvePending(
	key: string,
	path: string = defaultPendingPath(),
): void {
	writePending(
		readPending(path).filter((r) => r.key !== key),
		path,
	);
}

/**
 * Claim an unclaimed pending record for `botId`. Returns false (no steal) if it
 * is already claimed or missing. Caller holds the flock.
 */
export function claimPending(
	key: string,
	botId: string,
	path: string = defaultPendingPath(),
): boolean {
	const all = readPending(path);
	const rec = all.find((r) => r.key === key);
	if (!rec || rec.claimedBy) return false;
	rec.claimedBy = botId;
	writePending(all, path);
	return true;
}

/** Records past their deadline that no bot has claimed — the watchdog fires these. */
export function duePending(
	records: PendingSwitch[],
	nowMs: number,
): PendingSwitch[] {
	return records.filter((r) => {
		if (r.claimedBy) return false;
		const deadline = Date.parse(r.deadlineAt);
		return !Number.isNaN(deadline) && deadline <= nowMs;
	});
}
