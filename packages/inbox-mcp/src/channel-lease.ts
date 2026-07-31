/**
 * FLY-1547 §2.9: the channel-server PID lease, extracted from index.ts so the
 * v2 mailbox MCP imports the SAME bytes instead of copying them (the "import,
 * don't copy v1" red line). The v1 shape (pid + startedAt) is unchanged;
 * `lastOkAt` + `touchLease` + `readLease` extend it into the FLY-1547
 * health-bearing contract (a live PID alone proves nothing — the engine only
 * trusts a lease whose last successful poll is fresh).
 */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface ChannelLease {
	pid: number;
	startedAt: string;
	/** ISO time of the last SUCCESSFUL status poll / channel notify. Absent in
	 * legacy v1 leases (CommDB inbox-mcp does not track health). */
	lastOkAt?: string;
}

export function writeLease(
	leasePath: string,
	lease: { pid: number; startedAt?: string; lastOkAt?: string },
): void {
	mkdirSync(dirname(leasePath), { recursive: true });
	writeFileSync(
		leasePath,
		JSON.stringify({
			pid: lease.pid,
			startedAt: lease.startedAt ?? new Date().toISOString(),
			...(lease.lastOkAt ? { lastOkAt: lease.lastOkAt } : {}),
		}),
	);
}

/** Refresh the health timestamp after a successful poll/notify. */
export function touchLease(leasePath: string, nowIso: string): void {
	const lease = readLease(leasePath);
	if (!lease) return;
	writeFileSync(leasePath, JSON.stringify({ ...lease, lastOkAt: nowIso }));
}

export function readLease(leasePath: string): ChannelLease | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(leasePath, "utf8"));
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			typeof (parsed as ChannelLease).pid !== "number"
		) {
			return undefined;
		}
		return parsed as ChannelLease;
	} catch {
		return undefined;
	}
}

export function deleteLease(leasePath: string): void {
	try {
		unlinkSync(leasePath);
	} catch {
		// Already deleted or never written — fine
	}
}

/**
 * FLY-1547 §2.5: the engine-side health predicate. A lease is healthy only if
 * it exists, its pid is live, AND its lastOkAt is fresh. Legacy leases without
 * lastOkAt are never "healthy" under this predicate (they predate the health
 * contract); v1 CommDB inbox-mcp consumers do not call this.
 */
export function leaseIsHealthy(
	leasePath: string,
	options: {
		nowMs: number;
		maxAgeMs: number;
		pidIsLive: (pid: number) => boolean;
	},
): boolean {
	const lease = readLease(leasePath);
	if (!lease || !lease.lastOkAt) return false;
	if (!options.pidIsLive(lease.pid)) return false;
	const okAt = Date.parse(lease.lastOkAt);
	return Number.isFinite(okAt) && options.nowMs - okAt <= options.maxAgeMs;
}
