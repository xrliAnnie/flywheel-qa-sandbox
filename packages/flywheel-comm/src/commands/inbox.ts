import { existsSync } from "node:fs";
import { CommDB } from "../db.js";
import type { Message } from "../types.js";

export interface InboxArgs {
	execId: string;
	dbPath: string;
}

export interface InboxResult {
	instructions: Message[];
}

export function inbox(args: InboxArgs): InboxResult {
	if (!existsSync(args.dbPath)) {
		return { instructions: [] };
	}
	const db = new CommDB(args.dbPath, false);
	try {
		const instructions = db.getUnreadInstructions(args.execId);
		for (const inst of instructions) {
			db.markInstructionRead(inst.id);
		}
		return { instructions };
	} finally {
		db.close();
	}
}
