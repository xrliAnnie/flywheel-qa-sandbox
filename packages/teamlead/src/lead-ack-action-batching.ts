import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { storeLeadAckActionBatchingEnabled } from "./bridge/flag-store-runtime.js";

/** A launch-time read receipt, never a second flag store or resolver. */
export function readLeadAckActionBatchingAtLaunch(
	projectName: string,
	dbPath = process.env.TEAMLEAD_DB_PATH ||
		join(homedir(), ".flywheel", "teamlead.db"),
): boolean {
	let db: Database.Database | undefined;
	try {
		if (!projectName.trim()) throw new Error("project name required");
		db = new Database(dbPath, {
			readonly: true,
			fileMustExist: true,
			timeout: 1000,
		});
		const query = db.prepare(
			"SELECT has_override, raw_value FROM flag_values WHERE flag_name = ? AND scope = ?",
		);
		return storeLeadAckActionBatchingEnabled(
			{
				store: {
					getFlagValueRow(name, scope = "*") {
						const row = query.get(name, scope) as
							| { has_override: number; raw_value: string | null }
							| undefined;
						if (
							row?.has_override === 1 &&
							row.raw_value !== "0" &&
							row.raw_value !== "1"
						)
							throw new Error("invalid lead_ack_action_batching value");
						return row
							? { hasOverride: row.has_override === 1, raw: row.raw_value }
							: undefined;
					},
				},
			},
			projectName,
		);
	} catch (error) {
		console.warn(
			`[lead-ack-action-batching] launch read unavailable; using historical ACK rules: ${error instanceof Error ? error.message : String(error)}`,
		);
		return false;
	} finally {
		db?.close();
	}
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	process.stdout.write(
		readLeadAckActionBatchingAtLaunch(process.argv[2] ?? "") ? "1\n" : "0\n",
	);
}
