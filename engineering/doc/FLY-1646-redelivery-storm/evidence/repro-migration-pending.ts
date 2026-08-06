#!/usr/bin/env npx tsx
/**
 * FLY-1646 reproduction: run the REAL FLY-1572 migration on a copy of the REAL
 * pre-migration production input, then run the REAL post-migration
 * `chat-receipt pending` predicate that the Discord plugin replay loop drives.
 *
 * Falsifiable claim under test: the migration converts already-settled
 * ("delivered") chat receipts into rows the new pending predicate returns,
 * because the legacy `delivered_at IS NULL` guard has no counterpart in the
 * new predicate (which only excludes mailbox_log processed/disposed).
 */
import {
	Database,
	migrateCommDbWithSwap,
} from "../../../../packages/flywheel-comm/src/mailbox-migration.js";

const DB = process.argv[2];
if (!DB) throw new Error("usage: repro.ts <dbPath>");

type Db = InstanceType<typeof Database>;
const q = (db: Db, sql: string): unknown[] => db.prepare(sql).all();

async function main(): Promise<void> {
	// ---- BEFORE: legacy predicate (pre-FLY-1572 listExternalPendingForLane) ----
	const before = new Database(DB, { readonly: true, fileMustExist: true });
	console.log("== BEFORE (legacy pending predicate) ==");
	console.log(
		JSON.stringify(
			q(
				before,
				`SELECT to_lead, COUNT(*) n FROM lead_inbox
				  WHERE carrier='external' AND id LIKE 'chat:%'
				    AND delivered_at IS NULL AND processed_at IS NULL AND disposed_at IS NULL
				  GROUP BY to_lead ORDER BY n DESC`,
			),
		),
	);
	before.close();

	// ---- run the REAL migration ----
	const result = (await migrateCommDbWithSwap(DB)) as Record<string, unknown>;
	console.log("== migration result ==");
	console.log(JSON.stringify({ phase: result.phase, ok: result.ok }));

	// ---- AFTER: new predicate (post-FLY-1572 listExternalPending) ----
	const after = new Database(DB, { readonly: true, fileMustExist: true });
	console.log("== AFTER (new pending predicate = what gets [redelivery]'d) ==");
	console.log(
		JSON.stringify(
			q(
				after,
				`SELECT to_agent, COUNT(*) n,
				        SUM(state='ACKED') acked,
				        SUM(acked_at IS NOT NULL) has_acked_at,
				        substr(MIN(created_at),1,10) oldest,
				        substr(MAX(created_at),1,10) newest
				   FROM mailbox
				  WHERE carrier='external' AND id LIKE 'chat:%'
				    AND NOT EXISTS (SELECT 1 FROM mailbox_log s
				                     WHERE s.subject_id = mailbox.id
				                       AND s.event IN ('processed','disposed'))
				  GROUP BY to_agent ORDER BY n DESC`,
			),
		),
	);
	console.log("== AFTER totals ==");
	console.log(
		JSON.stringify(
			q(
				after,
				`SELECT COUNT(*) pending_total,
				        SUM(state='ACKED') pending_but_already_acked
				   FROM mailbox m
				  WHERE m.carrier='external' AND m.id LIKE 'chat:%'
				    AND NOT EXISTS (SELECT 1 FROM mailbox_log s
				                     WHERE s.subject_id = m.id
				                       AND s.event IN ('processed','disposed'))`,
			),
		),
	);
	after.close();
}

main().catch((error) => {
	console.error("REPRO FAILED:", error);
	process.exit(1);
});
