/**
 * FLY-2882 §6 — "which issue opened this Codex turn", only along provable
 * chains. The sidecar hands us the mailbox delivery ids bound to the journal
 * entry that opened the turn; each must map to exactly one issue:
 *
 *   question   → from_agent is a runner execution id → sessions.issue_id
 *   lead_event → source_ref is a lead_events.seq → session_key "project:ISSUE"
 *   anything else (Discord chat, unknown) → unmapped
 *
 * Reads are metadata-only (explicit columns, parameterized, read-only handle);
 * body columns (`content`, `delivery_content`, `payload`) are never selected.
 * Failures log a reason constant only — never rows or parameters.
 */

import {
	ISSUE_ID_RE,
	type LeadActivityTrigger,
	undetermined,
} from "./types.js";

export interface ReadonlySqlite {
	prepare(sql: string): {
		all(...params: unknown[]): unknown[];
		get(...params: unknown[]): unknown;
	};
	close(): void;
}

export interface TurnTriggerAttributionDeps {
	/** Read-only (fileMustExist) handle to the project's CommDB, or undefined. */
	openCommDb(projectName: string): ReadonlySqlite | undefined;
	/** StateStore metadata-only getter (never reads the payload). */
	getLeadEventSessionKeyBySeq(seq: number): string | null;
	log?(reason: string): void;
}

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEQ_RE = /^[1-9]\d{0,14}$/;
const SESSION_KEY_RE = /^[^:\s]+:([A-Z][A-Z0-9]+-\d+)$/;

interface MemberRow {
	delivery_id: string;
	source_kind: string | null;
	from_agent: string;
	source_ref: string | null;
}

function issueFor(
	row: MemberRow,
	db: ReadonlySqlite,
	deps: TurnTriggerAttributionDeps,
): string | undefined {
	if (row.source_kind === "question") {
		if (!UUID_RE.test(row.from_agent)) return undefined;
		const session = db
			.prepare("SELECT issue_id FROM sessions WHERE execution_id = ?")
			.get(row.from_agent) as { issue_id: unknown } | undefined;
		const issueId = session?.issue_id;
		return typeof issueId === "string" && ISSUE_ID_RE.test(issueId)
			? issueId
			: undefined;
	}
	if (row.source_kind === "lead_event") {
		if (typeof row.source_ref !== "string" || !SEQ_RE.test(row.source_ref))
			return undefined;
		const key = deps.getLeadEventSessionKeyBySeq(Number(row.source_ref));
		return key === null ? undefined : SESSION_KEY_RE.exec(key)?.[1];
	}
	return undefined;
}

export function attributeCodexTurnTrigger(
	args: { projectName: string; leadId: string; deliveryIds: readonly string[] },
	deps: TurnTriggerAttributionDeps,
): LeadActivityTrigger {
	const ids = [...new Set(args.deliveryIds)];
	if (ids.length === 0) return undetermined("no_delivery_binding");
	let db: ReadonlySqlite | undefined;
	try {
		db = deps.openCommDb(args.projectName);
		if (!db) {
			deps.log?.("attribution_unavailable");
			return undetermined("attribution_unavailable");
		}
		const rows = db
			.prepare(
				`SELECT delivery_id, source_kind, from_agent, source_ref FROM mailbox
				  WHERE to_agent = ? AND delivery_id IN (${ids.map(() => "?").join(", ")})`,
			)
			.all(args.leadId, ...ids) as MemberRow[];
		if (rows.length !== ids.length) return undetermined("unmapped_delivery");
		const issues = new Set<string>();
		for (const row of rows) {
			const issueId = issueFor(row, db, deps);
			if (issueId === undefined) return undetermined("unmapped_delivery");
			issues.add(issueId);
		}
		if (issues.size !== 1) return undetermined("multiple_issues");
		return {
			kind: "issue",
			issueId: [...issues][0]!,
			basis: "codex_journal_members",
		};
	} catch {
		deps.log?.("attribution_unavailable");
		return undetermined("attribution_unavailable");
	} finally {
		try {
			db?.close();
		} catch {
			// read-only handle; nothing to recover
		}
	}
}
