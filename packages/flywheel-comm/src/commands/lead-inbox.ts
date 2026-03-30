import { existsSync } from "node:fs";
import { CommDB } from "../db.js";
import type { Message } from "../types.js";

export interface LeadInboxArgs {
	leadId: string;
	dbPath: string;
}

export interface LeadInboxResult {
	messages: Message[];
}

export function leadInbox(args: LeadInboxArgs): LeadInboxResult {
	if (!existsSync(args.dbPath)) {
		return { messages: [] };
	}
	const db = new CommDB(args.dbPath, false);
	try {
		const messages = db.getUnreadProgress(args.leadId);
		for (const msg of messages) {
			db.markInstructionRead(msg.id);
		}
		return { messages };
	} finally {
		db.close();
	}
}
