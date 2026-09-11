import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { CommDB } from "./db.js";
import { isLeadRecipient } from "./recipient-kind.js";
import { isMailboxTerminalStatus } from "./session-terminal.js";

export { isLeadRecipient } from "./recipient-kind.js";

export interface StateStoreSnapshotReader {
	readStatus(
		executionId: string,
	):
		| { readable: true; status: string | null }
		| { readable: false; reason: string };
}

export function createStateStoreSnapshotReader(
	env: NodeJS.ProcessEnv = process.env,
): StateStoreSnapshotReader {
	const path =
		env.TEAMLEAD_DB_PATH ?? join(homedir(), ".flywheel", "teamlead.db");
	return {
		readStatus(executionId) {
			let db: Database.Database | undefined;
			try {
				db = new Database(path, { readonly: true, fileMustExist: true });
				db.pragma("busy_timeout = 5000");
				const row = db
					.prepare("SELECT status FROM sessions WHERE execution_id = ?")
					.get(executionId) as { status: string } | undefined;
				return { readable: true, status: row?.status ?? null };
			} catch (error) {
				return {
					readable: false,
					reason: error instanceof Error ? error.message : String(error),
				};
			} finally {
				db?.close();
			}
		},
	};
}

export class RecipientError extends Error {
	constructor(
		public readonly code:
			| "recipient_malformed"
			| "recipient_not_found"
			| "recipient_ambiguous"
			| "recipient_terminal",
		message: string,
		public readonly candidates?: string[],
		public readonly terminalStatus?: string,
	) {
		super(`${code}: ${message}`);
		this.name = "RecipientError";
	}
}

export type RecipientResolution =
	| { kind: "lead"; toAgent: string }
	| {
			kind: "runner";
			executionId: string;
			resolvedFromPrefix: boolean;
			issueId: string | null;
			leadId: string | null;
			livenessWarning?: string;
	  };

const FULL_UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PREFIX_RE = /^[0-9a-f]{8}[0-9a-f-]{0,27}$/;

export function resolveRunnerRecipient(
	deps: { commDb: CommDB; stateStore: StateStoreSnapshotReader },
	raw: string,
): RecipientResolution {
	if (isLeadRecipient(raw)) return { kind: "lead", toAgent: raw };
	const canonical = raw.trim().toLowerCase();
	const full = FULL_UUID_RE.test(canonical);
	if (!full && !PREFIX_RE.test(canonical))
		throw new RecipientError(
			"recipient_malformed",
			"use a full execution UUID or a hex prefix of at least 8 characters",
		);
	const exact = full
		? deps.commDb.getSessionReceiptIdentity(canonical)
		: undefined;
	const matches = full
		? exact
			? [exact]
			: []
		: deps.commDb.findSessionReceiptIdentities(canonical);
	if (matches.length === 0)
		throw new RecipientError(
			"recipient_not_found",
			`no session matches ${canonical}`,
		);
	if (matches.length > 1)
		throw new RecipientError(
			"recipient_ambiguous",
			`multiple sessions match ${canonical}`,
			matches.map((row) => row.execution_id),
		);
	const match = matches[0]!;
	const state = deps.stateStore.readStatus(match.execution_id);
	if (
		state.readable &&
		state.status !== null &&
		isMailboxTerminalStatus(state.status)
	)
		throw new RecipientError(
			"recipient_terminal",
			`${match.execution_id} is ${state.status}`,
			undefined,
			state.status,
		);
	return {
		kind: "runner",
		executionId: match.execution_id,
		resolvedFromPrefix: !full,
		issueId: match.issue_id,
		leadId: match.lead_id,
		...(!state.readable ? { livenessWarning: state.reason } : {}),
	};
}
