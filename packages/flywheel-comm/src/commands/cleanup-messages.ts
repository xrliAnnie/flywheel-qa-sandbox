import { existsSync } from "node:fs";
import { CommDB } from "../db.js";

export interface CleanupMessagesArgs {
	dbPath: string;
	ttlHours?: number;
}

export interface CleanupMessagesResult {
	cleaned: number;
}

export function cleanupMessages(
	args: CleanupMessagesArgs,
): CleanupMessagesResult {
	if (!existsSync(args.dbPath)) {
		return { cleaned: 0 };
	}
	const db = new CommDB(args.dbPath);
	try {
		const cleaned = db.cleanupReadMessagesWithRefs(args.ttlHours);
		return { cleaned };
	} finally {
		db.close();
	}
}
