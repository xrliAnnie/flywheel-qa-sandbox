import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

export interface EpicReportPublication {
	projectName: string;
	token: string;
}

/** Read the authoritative reserved tokens without opening StateStore or running migrations. */
export function readEpicReportPublications(
	dbPath = process.env.TEAMLEAD_DB_PATH ??
		join(homedir(), ".flywheel", "teamlead.db"),
): EpicReportPublication[] {
	let db: InstanceType<typeof Database> | undefined;
	try {
		db = new Database(dbPath, { readonly: true, fileMustExist: true });
		db.pragma("busy_timeout = 5000");
		const exists = db
			.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
			.get("epic_page_publication");
		if (!exists) return [];
		return db
			.prepare("SELECT project_name, token FROM epic_page_publication")
			.all()
			.map((value) => {
				const row = value as { project_name?: unknown; token?: unknown };
				if (
					typeof row.project_name !== "string" ||
					!row.project_name.trim() ||
					typeof row.token !== "string" ||
					!/^[a-f0-9]{32}$/.test(row.token)
				)
					throw new Error("invalid publication row");
				return { projectName: row.project_name, token: row.token };
			});
	} catch {
		throw new Error(
			"Epic publication metadata unavailable; set TEAMLEAD_DB_PATH to the authoritative Bridge database",
		);
	} finally {
		db?.close();
	}
}
