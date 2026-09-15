import type { CommDB } from "flywheel-comm/db";
import type { GateResponseDb } from "./approval-signal/write-gate-response.js";
export type FounderReplyCommScope = <T>(run: (db: CommDB) => T) => T;
/** Exposes only eager synchronous gate methods; no handle survives into async classification. */
export function scopedGateResponseDb(
	scope: FounderReplyCommScope,
): GateResponseDb {
	return {
		getMessageById: (id) => scope((db) => db.getMessageById(id)),
		getResponse: (id) => scope((db) => db.getResponse(id)),
		insertResponse: (id, from, content, provenance) =>
			scope((db) => db.insertResponse(id, from, content, provenance)),
		insertFounderApprovalResponseWithSource: (input) =>
			scope((db) => db.insertFounderApprovalResponseWithSource(input)),
		trustedFounderGateResponse: (input) =>
			scope((db) => db.trustedFounderGateResponse(input)),
	};
}
