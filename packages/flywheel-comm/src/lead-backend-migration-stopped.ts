import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
import Database from "better-sqlite3";
import { installSqlTiming } from "flywheel-config";
import {
	type ProcessTupleState,
	processTupleStateWithStart,
} from "./lead-lease.js";

/** Read-only stop proof. The existing lifecycle helper performs the actual stop. */
export function assertMigrationWriterStopped(input: {
	dbPath: string;
	oldCarrier: { pid: number; start: string };
	assertWindow(): void;
	/** Existing lead_restart_launchd_probe, restricted by the caller to the exact target label. */
	launchdState(): "loaded" | "unloaded" | "error";
	processState?(pid: number, start: string): ProcessTupleState;
}): string {
	const fail = (): never => {
		throw new Error("migration writer stopped state unproven");
	};
	input.assertWindow();
	if (!isAbsolute(input.dbPath)) return fail();
	const stat = lstatSync(input.dbPath);
	if (!stat.isFile() || stat.isSymbolicLink()) return fail();
	const state = input.processState ?? processTupleStateWithStart;
	const assertDead = (pid: unknown, start: unknown) => {
		if (
			typeof pid !== "number" ||
			!Number.isSafeInteger(pid) ||
			pid <= 0 ||
			typeof start !== "string" ||
			!start.trim() ||
			state(pid, start) !== "dead"
		)
			return fail();
	};
	if (input.launchdState() !== "unloaded") return fail();
	assertDead(input.oldCarrier.pid, input.oldCarrier.start);
	const db = installSqlTiming(
		new Database(input.dbPath, {
			readonly: true,
			fileMustExist: true,
		}),
		"lead-lease",
	);
	try {
		const query = db.prepare(
			"SELECT lead_key, generation, holder_pid, holder_start, supervisor_pid, supervisor_start FROM lead_lease WHERE project = ? AND lead_id = ?",
		);
		const rows = query.all("flywheel", "flywheel-product-lead") as Array<
			Record<string, unknown>
		>;
		if (rows.length > 1) return fail();
		const row = rows[0];
		for (const prefix of ["holder", "supervisor"]) {
			if (!row) break;
			const pid = row[`${prefix}_pid`],
				start = row[`${prefix}_start`];
			if (pid === null && start === null) continue;
			assertDead(pid, start);
		}
		input.assertWindow();
		if (input.launchdState() !== "unloaded") return fail();
		assertDead(input.oldCarrier.pid, input.oldCarrier.start);
		if (
			JSON.stringify(query.all("flywheel", "flywheel-product-lead")) !==
			JSON.stringify(rows)
		)
			return fail();
		return createHash("sha256")
			.update(
				JSON.stringify({
					oldCarrier: input.oldCarrier,
					lease: row ?? null,
					launchd: "unloaded",
				}),
			)
			.digest("hex");
	} finally {
		db.close();
	}
}
