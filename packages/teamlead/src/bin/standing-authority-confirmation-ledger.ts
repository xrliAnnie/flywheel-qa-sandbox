import { existsSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

/**
 * FLY-2654 (review R7 HIGH, plan §4 line 73): the independent confirmation must
 * be written by the confirmer's authenticated channel into an authoritative
 * receipt that producer and consumer read back independently. The Bridge
 * confirm route records this row in the StateStore before any activation file
 * exists; verifiers read it back read-only and refuse activation files that
 * have no matching row. Local files, same-uid permissions, hashes, or model
 * text never self-issue an activation.
 */
export const STANDING_AUTHORITY_CONFIRMATION_TABLE =
	"standing_authority_confirmation";

export const STANDING_AUTHORITY_CONFIRMATION_DDL = `
	CREATE TABLE IF NOT EXISTS ${STANDING_AUTHORITY_CONFIRMATION_TABLE} (
		receipt_id TEXT PRIMARY KEY CHECK (length(receipt_id) = 64),
		entry_id TEXT NOT NULL,
		revision INTEGER NOT NULL CHECK (revision >= 1),
		manifest_digest TEXT NOT NULL CHECK (length(manifest_digest) = 64),
		evidence_body_digest TEXT NOT NULL CHECK (length(evidence_body_digest) = 64),
		package_digest TEXT NOT NULL CHECK (length(package_digest) = 64),
		confirmer_identity TEXT NOT NULL,
		confirmer_identity_digest TEXT NOT NULL CHECK (length(confirmer_identity_digest) = 64),
		carrier_claim TEXT NOT NULL,
		confirmed_at TEXT NOT NULL,
		recorded_at TEXT NOT NULL
	)
`;

/**
 * Sibling receipt tables (release bug receipts, founder gate verdicts) refuse
 * UPDATE/DELETE at the database level; the confirmation ledger is the
 * activation authority and must be at least as immutable.
 */
export const STANDING_AUTHORITY_CONFIRMATION_TRIGGERS = [
	`CREATE TRIGGER IF NOT EXISTS standing_authority_confirmation_no_update
	 BEFORE UPDATE ON ${STANDING_AUTHORITY_CONFIRMATION_TABLE}
	 BEGIN SELECT RAISE(ABORT, 'standing authority confirmation is immutable'); END`,
	`CREATE TRIGGER IF NOT EXISTS standing_authority_confirmation_no_delete
	 BEFORE DELETE ON ${STANDING_AUTHORITY_CONFIRMATION_TABLE}
	 BEGIN SELECT RAISE(ABORT, 'standing authority confirmation is immutable'); END`,
] as const;

/**
 * The ledger is the Bridge StateStore database. Writers resolve it through
 * `TEAMLEAD_DB_PATH` (config.ts); every reader must honour the same override
 * or a relocated Bridge would silently verify against an empty default file.
 */
export function resolveStandingAuthorityLedgerPath(
	home: string,
	env: NodeJS.ProcessEnv = process.env,
): string {
	const override = env.TEAMLEAD_DB_PATH;
	return override && override.length > 0
		? override
		: join(home, ".flywheel", "teamlead.db");
}

/**
 * Review round 5 (FLY-2654): the activation state root must be resolved the
 * same way by the Bridge confirm route, the shell package fences and every
 * TypeScript verifier, or a relocated Bridge (FLYWHEEL_STANDING_AUTHORITY_STATE_DIR)
 * activates under one root while the v3 producer reads another.
 */
export function resolveStandingAuthorityStateDir(
	home: string,
	env: NodeJS.ProcessEnv = process.env,
): string {
	const override = env.FLYWHEEL_STANDING_AUTHORITY_STATE_DIR;
	return override && override.length > 0
		? override
		: join(home, ".flywheel", "state", "standing-authority");
}

export interface StandingAuthorityConfirmationRecord {
	receiptId: string;
	entryId: string;
	revision: number;
	manifestDigest: string;
	evidenceBodyDigest: string;
	packageDigest: string;
	confirmerIdentity: string;
	confirmerIdentityDigest: string;
	carrierClaim: string;
	confirmedAt: string;
	recordedAt: string;
}

const HEX64 = /^[a-f0-9]{64}$/;
const fail = (reason: string): never => {
	throw new Error(`standing-authority-activation-${reason}`);
};

export function assertStandingAuthorityConfirmationRecord(
	value: StandingAuthorityConfirmationRecord,
): void {
	for (const digest of [
		value.receiptId,
		value.manifestDigest,
		value.evidenceBodyDigest,
		value.packageDigest,
		value.confirmerIdentityDigest,
	]) {
		if (typeof digest !== "string" || !HEX64.test(digest))
			fail("authority-record-invalid");
	}
	if (
		!Number.isInteger(value.revision) ||
		value.revision < 1 ||
		typeof value.entryId !== "string" ||
		value.entryId.length === 0 ||
		typeof value.confirmerIdentity !== "string" ||
		value.confirmerIdentity.length === 0 ||
		typeof value.carrierClaim !== "string" ||
		value.carrierClaim.length === 0 ||
		value.carrierClaim.length > 256 ||
		!Number.isFinite(Date.parse(value.confirmedAt)) ||
		!Number.isFinite(Date.parse(value.recordedAt))
	)
		fail("authority-record-invalid");
}

interface RecordRow {
	receipt_id: string;
	entry_id: string;
	revision: number;
	manifest_digest: string;
	evidence_body_digest: string;
	package_digest: string;
	confirmer_identity: string;
	confirmer_identity_digest: string;
	carrier_claim: string;
	confirmed_at: string;
	recorded_at: string;
}

function fromRow(row: RecordRow): StandingAuthorityConfirmationRecord {
	return {
		receiptId: row.receipt_id,
		entryId: row.entry_id,
		revision: row.revision,
		manifestDigest: row.manifest_digest,
		evidenceBodyDigest: row.evidence_body_digest,
		packageDigest: row.package_digest,
		confirmerIdentity: row.confirmer_identity,
		confirmerIdentityDigest: row.confirmer_identity_digest,
		carrierClaim: row.carrier_claim,
		confirmedAt: row.confirmed_at,
		recordedAt: row.recorded_at,
	};
}

/**
 * Read-only consumer-side readback. A missing ledger, a missing table, or an
 * unreadable database is `authority-ledger-unavailable`; a missing row is
 * `authority-record-missing`. Neither is ever treated as "not yet recorded,
 * so allow".
 */
export function readStandingAuthorityConfirmationRecord(
	ledgerPath: string,
	receiptId: string,
): StandingAuthorityConfirmationRecord {
	if (!HEX64.test(receiptId)) fail("authority-record-invalid");
	if (!existsSync(ledgerPath)) fail("authority-ledger-unavailable");
	let db: Database.Database;
	try {
		db = new Database(ledgerPath, { readonly: true, fileMustExist: true });
	} catch {
		return fail("authority-ledger-unavailable");
	}
	try {
		let row: RecordRow | undefined;
		try {
			row = db
				.prepare(
					`SELECT receipt_id, entry_id, revision, manifest_digest,
					        evidence_body_digest, package_digest, confirmer_identity,
					        confirmer_identity_digest, carrier_claim, confirmed_at,
					        recorded_at
					 FROM ${STANDING_AUTHORITY_CONFIRMATION_TABLE}
					 WHERE receipt_id = ?`,
				)
				.get(receiptId) as RecordRow | undefined;
		} catch {
			return fail("authority-ledger-unavailable");
		}
		if (!row) return fail("authority-record-missing");
		const record = fromRow(row);
		assertStandingAuthorityConfirmationRecord(record);
		return record;
	} finally {
		db.close();
	}
}
