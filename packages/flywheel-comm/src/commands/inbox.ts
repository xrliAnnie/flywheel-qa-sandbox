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

function ageInMinutes(createdAt: string, observedAtMs: number): string {
	const createdAtMs = Date.parse(createdAt);
	if (!Number.isFinite(createdAtMs) || !Number.isFinite(observedAtMs)) {
		return "unknown";
	}
	const minutes = Math.max(
		0,
		Math.floor((observedAtMs - createdAtMs) / 60_000),
	);
	return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

export function renderInboxInstruction(
	instruction: Message,
	observedAtMs: number,
): string {
	return `[${instruction.id}] from ${instruction.from_agent} | created_at ${instruction.created_at} | age at pull: ${ageInMinutes(instruction.created_at, observedAtMs)}: ${instruction.content}`;
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
