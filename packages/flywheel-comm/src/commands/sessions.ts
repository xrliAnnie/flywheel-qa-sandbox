import { existsSync } from "node:fs";
import { CommDB } from "../db.js";
import type { Session } from "../types.js";

export interface SessionsArgs {
	dbPath: string;
	projectName?: string;
	activeOnly?: boolean;
	leadId?: string;
}

export function sessions(args: SessionsArgs): Session[] {
	if (!existsSync(args.dbPath)) {
		return [];
	}
	const db = new CommDB(args.dbPath, false);
	try {
		let results: Session[];
		if (args.activeOnly) {
			results = db.getActiveSessions(args.projectName);
		} else {
			results = db.listSessions(args.projectName);
		}
		if (args.leadId) {
			results = results.filter((s) => s.lead_id === args.leadId);
		}
		return results;
	} finally {
		db.close();
	}
}
