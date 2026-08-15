import { CommDB, type RunnerDoorbellWakeResult } from "../db.js";

export interface RunnerWakeSweepArgs {
	dbPath: string;
	execId: string;
	now?: () => number;
}

/** FLY-1774 turn-end fallback. It rings a durable doorbell and never ACKs. */
export function runnerWakeSweep(
	args: RunnerWakeSweepArgs,
): RunnerDoorbellWakeResult {
	const db = new CommDB(args.dbPath, false);
	try {
		return db.sweepRunnerDoorbellWake(args.execId, (args.now ?? Date.now)());
	} finally {
		db.close();
	}
}
