import { existsSync } from "node:fs";
import { CommDB } from "../db.js";
import type { Message } from "../types.js";

export interface InboxArgs {
	execId: string;
	dbPath: string;
	env?: NodeJS.ProcessEnv;
	now?: () => number;
	debugExecOverride?: boolean;
}

export interface InboxResult {
	instructions: Message[];
}

export function inbox(args: InboxArgs): InboxResult {
	const observedAtMs = (args.now ?? Date.now)();
	if (!existsSync(args.dbPath)) {
		return { instructions: [] };
	}
	const db = new CommDB(args.dbPath, false);
	try {
		const instructions = db.getUnreadInstructions(args.execId);
		for (const inst of instructions) {
			db.markInstructionRead(inst.id);
		}
		db.ackRunnerReceiptWakesStarted(
			args.execId,
			observedAtMs,
			args.debugExecOverride ? "debug_override" : "exec_cli",
		);
		return { instructions };
	} finally {
		db.close();
	}
}
