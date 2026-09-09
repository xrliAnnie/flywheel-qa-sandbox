#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";

export interface InspectLeadOutboundDeps {
	stdout?: (line: string) => void;
	stderr?: (line: string) => void;
}

interface JournalMemberRow {
	entry_id: string;
}

interface JournalRow {
	id: string;
	state: string;
	outbox_id: string | null;
}

interface OutboxRow {
	outbox_id: string;
	idempotency_key: string;
	status: string;
}

interface DedupRow {
	idempotency_key: string;
	status: string;
	message_id: string | null;
}

function jsonLine(value: Record<string, unknown>): string {
	return JSON.stringify(value);
}

function inspectFailure(
	stderr: (line: string) => void,
	code: string,
	message: string,
	context: Record<string, unknown> = {},
): 1 {
	stderr(jsonLine({ ok: false, code, message, ...context }));
	return 1;
}

function openReadOnly(path: string): Database.Database {
	const db = new Database(path, { readonly: true, fileMustExist: true });
	db.pragma("query_only = ON");
	return db;
}

export function runInspectLeadOutbound(
	args: string[],
	deps: InspectLeadOutboundDeps = {},
): 0 | 1 | 64 | 78 {
	const stdout = deps.stdout ?? console.log;
	const stderr = deps.stderr ?? console.error;
	let values: {
		"state-dir"?: string;
		"delivery-id"?: string;
		"dedup-db"?: string;
	};
	try {
		({ values } = parseArgs({
			args,
			options: {
				"state-dir": { type: "string" },
				"delivery-id": { type: "string" },
				"dedup-db": { type: "string" },
			},
			allowPositionals: false,
		}));
	} catch (error) {
		stderr(
			jsonLine({
				ok: false,
				code: "outbound_inspector_usage",
				message: error instanceof Error ? error.message : String(error),
			}),
		);
		return 64;
	}

	const stateDir = values["state-dir"]?.trim();
	const deliveryId = values["delivery-id"]?.trim();
	const dedupDbPath = values["dedup-db"]?.trim();
	if (!stateDir || !deliveryId || !dedupDbPath) {
		stderr(
			jsonLine({
				ok: false,
				code: "outbound_inspector_usage",
				message: "--state-dir, --delivery-id, and --dedup-db are required",
			}),
		);
		return 64;
	}
	if (!isAbsolute(stateDir) || !isAbsolute(dedupDbPath)) {
		stderr(
			jsonLine({
				ok: false,
				code: "outbound_inspector_usage",
				message: "--state-dir and --dedup-db must be absolute paths",
			}),
		);
		return 64;
	}

	const journalDbPath = join(stateDir, "journal.db");
	const outboxDbPath = join(stateDir, "outbox.db");
	let journalDb: Database.Database | undefined;
	let outboxDb: Database.Database | undefined;
	let dedupDb: Database.Database | undefined;
	try {
		journalDb = openReadOnly(journalDbPath);
		const member = journalDb
			.prepare("SELECT entry_id FROM journal_member WHERE delivery_id = ?")
			.get(deliveryId) as JournalMemberRow | undefined;
		if (!member) {
			return inspectFailure(
				stderr,
				"outbound_journal_member_missing",
				"delivery_id is absent from the Codex Lead journal membership",
				{ deliveryId },
			);
		}

		const entry = journalDb
			.prepare("SELECT id, state, outbox_id FROM journal WHERE id = ?")
			.get(member.entry_id) as JournalRow | undefined;
		if (!entry) {
			return inspectFailure(
				stderr,
				"outbound_journal_entry_missing",
				"journal membership points to an absent entry",
				{ deliveryId, entryId: member.entry_id },
			);
		}
		const idempotencyKey = `${entry.id}:out`;
		if (entry.state !== "completed" || entry.outbox_id !== idempotencyKey) {
			return inspectFailure(
				stderr,
				"outbound_journal_incomplete",
				"journal entry has not completed with the exact derived outbox key",
				{
					deliveryId,
					entryId: entry.id,
					idempotencyKey,
					journalState: entry.state,
					journalOutboxId: entry.outbox_id,
				},
			);
		}

		outboxDb = openReadOnly(outboxDbPath);
		const outbox = outboxDb
			.prepare(
				"SELECT outbox_id, idempotency_key, status FROM outbox WHERE idempotency_key = ?",
			)
			.get(idempotencyKey) as OutboxRow | undefined;
		if (!outbox) {
			return inspectFailure(
				stderr,
				"outbound_local_outbox_missing",
				"exact journal-derived key is absent from the Codex Lead outbox",
				{ deliveryId, entryId: entry.id, idempotencyKey },
			);
		}
		if (
			outbox.status !== "sent" ||
			outbox.outbox_id !== idempotencyKey ||
			outbox.idempotency_key !== idempotencyKey
		) {
			return inspectFailure(
				stderr,
				"outbound_local_outbox_incomplete",
				"local outbox row is not sent under the exact journal-derived key",
				{
					deliveryId,
					entryId: entry.id,
					idempotencyKey,
					outboxStatus: outbox.status,
				},
			);
		}

		dedupDb = openReadOnly(dedupDbPath);
		const dedup = dedupDb
			.prepare(
				"SELECT idempotency_key, status, message_id FROM outbound_dedup WHERE idempotency_key = ?",
			)
			.get(idempotencyKey) as DedupRow | undefined;
		if (!dedup) {
			return inspectFailure(
				stderr,
				"outbound_bridge_dedup_missing",
				"exact journal-derived key is absent from the Bridge outbound dedup ledger",
				{ deliveryId, entryId: entry.id, idempotencyKey },
			);
		}
		if (
			dedup.status !== "sent" ||
			dedup.idempotency_key !== idempotencyKey ||
			!dedup.message_id
		) {
			return inspectFailure(
				stderr,
				"outbound_bridge_receipt_incomplete",
				"Bridge dedup row lacks sent status or a Discord message receipt",
				{
					deliveryId,
					entryId: entry.id,
					idempotencyKey,
					bridgeStatus: dedup.status,
					messageId: dedup.message_id,
				},
			);
		}

		stdout(
			jsonLine({
				ok: true,
				deliveryId,
				entryId: entry.id,
				idempotencyKey,
				journalState: entry.state,
				outboxStatus: outbox.status,
				bridgeStatus: dedup.status,
				messageId: dedup.message_id,
			}),
		);
		return 0;
	} catch (error) {
		stderr(
			jsonLine({
				ok: false,
				code: "outbound_inspection_error",
				message: error instanceof Error ? error.message : String(error),
			}),
		);
		return 78;
	} finally {
		dedupDb?.close();
		outboxDb?.close();
		journalDb?.close();
	}
}

if (
	process.argv[1] !== undefined &&
	realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	process.exitCode = runInspectLeadOutbound(process.argv.slice(2));
}
