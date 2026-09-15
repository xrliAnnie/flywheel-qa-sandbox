import { existsSync } from "node:fs";
import { CommDB } from "flywheel-comm/db";

/** Own the connection only for this synchronous write, including failure. */
export function insertLeadInstruction(
	path: string,
	leadId: string,
	content: string,
	dedupeId?: string,
): void {
	const db = new CommDB(path);
	try {
		db.insertInstruction(
			"bridge",
			leadId,
			content,
			dedupeId ? { dedupeId } : undefined,
		);
	} finally {
		db.close();
	}
}

/** Materialize rows and release the owner before any asynchronous probe. */
export function readZombieCandidates(path: string, projectName: string) {
	if (!existsSync(path)) return [];
	const db = CommDB.openReadonly(path);
	try {
		return db.listSessions(projectName, ["running"]);
	} finally {
		db.close();
	}
}
