/** The v1 CommDB inbox channel-server PID lease. */
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface ChannelLease {
	pid: number;
	startedAt: string;
}

export function writeLease(
	leasePath: string,
	lease: { pid: number; startedAt?: string },
): void {
	mkdirSync(dirname(leasePath), { recursive: true });
	writeFileSync(
		leasePath,
		JSON.stringify({
			pid: lease.pid,
			startedAt: lease.startedAt ?? new Date().toISOString(),
		}),
	);
}

export function deleteLease(leasePath: string): void {
	try {
		unlinkSync(leasePath);
	} catch {
		// Already deleted or never written — fine
	}
}
