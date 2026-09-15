import { CommDB } from "flywheel-comm/db";
import type { GateResponseDb } from "./approval-signal/write-gate-response.js";
import { scopedGateResponseDb } from "./founder-reply-comm-scope.js";

/** Admit only an existing initialized database; no handle survives the factory. */
export function openVoiceCommDb(path: string): GateResponseDb {
	CommDB.openExistingWriter(path).close();
	return scopedGateResponseDb((run) => {
		const db = CommDB.openExistingWriter(path);
		try {
			return run(db);
		} finally {
			db.close();
		}
	});
}
