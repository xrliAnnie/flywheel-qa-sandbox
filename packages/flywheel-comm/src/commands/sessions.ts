import { existsSync } from "node:fs";
import { CommDB } from "../db.js";
import type { Session } from "../types.js";

export interface SessionsArgs {
	dbPath: string;
	projectName?: string;
	activeOnly?: boolean;
}

export function sessions(args: SessionsArgs): Session[] {
	if (!existsSync(args.dbPath)) {
		return [];
	}
	const db = new CommDB(args.dbPath, false);
	try {
		if (args.activeOnly) {
			return db.getActiveSessions(args.projectName);
		}
		return db.listSessions(args.projectName);
	} finally {
		db.close();
	}
}
