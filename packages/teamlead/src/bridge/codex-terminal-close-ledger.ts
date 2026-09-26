import type { Database as BetterDb } from "better-sqlite3";
import type { SessionEvent } from "../StateStore.js";

/**
 * FLY-2903 terminal close ledger: one row per terminal Codex execution, so
 * every such execution ends with a verified close verdict (two samples, see
 * codex-terminal-sweep.ts) or a visible alert. This module is the only writer
 * of `codex_terminal_close` and of the `codex_terminal_close_*` audit events.
 */

export const CODEX_TERMINAL_CLOSE_STATES = [
	"close_attempted",
	"pending_confirm",
	"closed",
	"owned_seen",
	"stop_requested",
	"alive_reaped_pending",
	"alive_unverifiable",
	"alive_residual",
	"probe_unknown",
] as const;
export type CodexTerminalCloseState =
	(typeof CODEX_TERMINAL_CLOSE_STATES)[number];

/** Rows the quota page shows: still alive, unproven, or burned tokens after terminal. */
export const CODEX_TERMINAL_CLOSE_VISIBLE_STATES: readonly CodexTerminalCloseState[] =
	[
		"owned_seen",
		"stop_requested",
		"alive_reaped_pending",
		"alive_unverifiable",
		"alive_residual",
		"probe_unknown",
	];

const MAX_EVIDENCE_BYTES = 2048;

/**
 * FLY-2903: session statuses where the adapter's goal run has ended; any
 * daemon still alive then is a leak. `ship_parked`, `running` and the other
 * deliberately-alive statuses are never candidates.
 */
export const CODEX_TERMINAL_SWEEP_STATUSES = [
	"completed",
	"failed",
	"terminated",
	"blocked",
] as const;

const EVIDENCE_ENUMS = {
	ownerStop: ["not_owned", "reserved_fenced", "stopped", "timeout"],
	reap: ["reaped", "absent", "residual", "unverifiable"],
	liveness: ["alive", "absent", "unknown"],
	ledger: ["missing", "no_group", "valid_group", "unreadable"],
	groupState: ["alive", "absent", "unknown"],
	spawnLock: ["absent", "stale", "live", "unreadable"],
	ownership: ["none", "reserved", "active"],
	rollout: ["ok", "unresolved", "read_truncated", "rewound"],
} as const;

type EnumField = keyof typeof EVIDENCE_ENUMS;

/** Bounded, enum-only evidence. No paths, argv, env or stack text. */
export interface CodexTerminalCloseEvidence {
	source?: string;
	ownerStop?: (typeof EVIDENCE_ENUMS.ownerStop)[number];
	reap?: (typeof EVIDENCE_ENUMS.reap)[number];
	liveness?: (typeof EVIDENCE_ENUMS.liveness)[number];
	ledger?: (typeof EVIDENCE_ENUMS.ledger)[number];
	socketLive?: boolean;
	groupState?: (typeof EVIDENCE_ENUMS.groupState)[number];
	spawnLock?: (typeof EVIDENCE_ENUMS.spawnLock)[number];
	procs?: { status: "ok" | "unknown"; count: number };
	ownership?: (typeof EVIDENCE_ENUMS.ownership)[number];
	rollout?: (typeof EVIDENCE_ENUMS.rollout)[number];
	/** A short error code (snake_case), never a message. */
	error?: string;
}

const SOURCE_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const EVIDENCE_KEYS = new Set<string>([
	"source",
	"socketLive",
	"procs",
	"error",
	...Object.keys(EVIDENCE_ENUMS),
]);

/** Validate evidence before any write; throws on anything outside the whitelist. */
export function validateCodexTerminalCloseEvidence(
	evidence: CodexTerminalCloseEvidence,
): CodexTerminalCloseEvidence {
	if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
		throw new Error("codex_terminal_close_evidence_invalid");
	}
	const record = evidence as Record<string, unknown>;
	for (const [key, value] of Object.entries(record)) {
		if (value === undefined) continue;
		if (!EVIDENCE_KEYS.has(key)) {
			throw new Error(`codex_terminal_close_evidence_field:${key}`);
		}
		if (key in EVIDENCE_ENUMS) {
			const allowed = EVIDENCE_ENUMS[key as EnumField] as readonly string[];
			if (typeof value !== "string" || !allowed.includes(value)) {
				throw new Error(`codex_terminal_close_evidence_value:${key}`);
			}
		} else if (key === "socketLive") {
			if (typeof value !== "boolean") {
				throw new Error("codex_terminal_close_evidence_value:socketLive");
			}
		} else if (key === "source") {
			if (typeof value !== "string" || !SOURCE_PATTERN.test(value)) {
				throw new Error("codex_terminal_close_evidence_value:source");
			}
		} else if (key === "error") {
			if (typeof value !== "string" || !ERROR_CODE_PATTERN.test(value)) {
				throw new Error("codex_terminal_close_evidence_value:error");
			}
		} else if (key === "procs") {
			const procs = value as Record<string, unknown>;
			if (
				!procs ||
				typeof procs !== "object" ||
				Object.keys(procs).some((k) => k !== "status" && k !== "count") ||
				(procs.status !== "ok" && procs.status !== "unknown") ||
				!Number.isSafeInteger(procs.count) ||
				(procs.count as number) < 0
			) {
				throw new Error("codex_terminal_close_evidence_value:procs");
			}
		}
	}
	if (Buffer.byteLength(JSON.stringify(record), "utf8") > MAX_EVIDENCE_BYTES) {
		throw new Error("codex_terminal_close_evidence_oversize");
	}
	return evidence;
}

export interface CodexTerminalCloseRow {
	execution_id: string;
	project_name: string | null;
	issue_identifier: string | null;
	session_status: string;
	terminal_at: string | null;
	state: CodexTerminalCloseState;
	owned_streak: number;
	unknown_streak: number;
	attempts: number;
	rollout_path: string | null;
	rollout_offset: number | null;
	/** Last cumulative rollout total read: the delta baseline for the next read. */
	rollout_last_total: number | null;
	tokens_at_terminal: number | null;
	tokens_after_terminal: number | null;
	confirm_tokens: number | null;
	last_evidence: string;
	first_seen_at: string;
	last_checked_at: string;
	closed_at: string | null;
	alerted_key: string | null;
}

const COLUMNS = [
	"execution_id",
	"project_name",
	"issue_identifier",
	"session_status",
	"terminal_at",
	"state",
	"owned_streak",
	"unknown_streak",
	"attempts",
	"rollout_path",
	"rollout_offset",
	"rollout_last_total",
	"tokens_at_terminal",
	"tokens_after_terminal",
	"confirm_tokens",
	"last_evidence",
	"first_seen_at",
	"last_checked_at",
	"closed_at",
	"alerted_key",
] as const satisfies readonly (keyof CodexTerminalCloseRow)[];

export class CodexTerminalCloseStore {
	constructor(private readonly db: BetterDb) {}

	migrate(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS codex_terminal_close (
				execution_id TEXT PRIMARY KEY,
				project_name TEXT,
				issue_identifier TEXT,
				session_status TEXT NOT NULL,
				terminal_at TEXT,
				state TEXT NOT NULL CHECK (state IN (
					'close_attempted','pending_confirm','closed',
					'owned_seen','stop_requested',
					'alive_reaped_pending','alive_unverifiable','alive_residual',
					'probe_unknown')),
				owned_streak INTEGER NOT NULL DEFAULT 0,
				unknown_streak INTEGER NOT NULL DEFAULT 0,
				attempts INTEGER NOT NULL DEFAULT 0,
				rollout_path TEXT,
				rollout_offset INTEGER,
				rollout_last_total INTEGER,
				tokens_at_terminal INTEGER,
				tokens_after_terminal INTEGER,
				confirm_tokens INTEGER,
				last_evidence TEXT NOT NULL,
				first_seen_at TEXT NOT NULL,
				last_checked_at TEXT NOT NULL,
				closed_at TEXT,
				alerted_key TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_codex_terminal_close_state
				ON codex_terminal_close(state);
		`);
	}

	get(executionId: string): CodexTerminalCloseRow | undefined {
		return this.db
			.prepare("SELECT * FROM codex_terminal_close WHERE execution_id = ?")
			.get(executionId) as CodexTerminalCloseRow | undefined;
	}

	upsert(row: CodexTerminalCloseRow): void {
		const placeholders = COLUMNS.map(() => "?").join(",");
		const updates = COLUMNS.filter((c) => c !== "execution_id")
			.map((c) => `${c} = excluded.${c}`)
			.join(", ");
		this.db
			.prepare(
				`INSERT INTO codex_terminal_close (${COLUMNS.join(",")})
				 VALUES (${placeholders})
				 ON CONFLICT(execution_id) DO UPDATE SET ${updates}`,
			)
			.run(...COLUMNS.map((c) => row[c]));
	}

	/**
	 * FLY-2903 sweep candidates: terminal Codex sessions from the last 48h that
	 * are at least 3 minutes past terminal (the adapter's own drain window) and
	 * not yet proven closed, oldest first.
	 */
	listSweepCandidateExecutionIds(input: {
		now: Date;
		limit: number;
	}): string[] {
		const now = input.now.toISOString();
		const rows = this.db
			.prepare(
				`SELECT s.execution_id AS execution_id FROM sessions s
				   LEFT JOIN codex_terminal_close c ON c.execution_id = s.execution_id
				  WHERE s.adapter_type = 'codex-tmux'
				    AND s.status IN (${CODEX_TERMINAL_SWEEP_STATUSES.map(() => "?").join(",")})
				    AND s.terminal_at IS NOT NULL
				    AND julianday(s.terminal_at) >= julianday(?, '-48 hours')
				    AND julianday(s.terminal_at) <= julianday(?, '-3 minutes')
				    AND (c.state IS NULL OR c.state <> 'closed')
				  ORDER BY (c.last_checked_at IS NOT NULL) ASC,
				           c.last_checked_at ASC,
				           julianday(s.terminal_at) ASC, s.execution_id
				  LIMIT ?`,
			)
			.all(
				...CODEX_TERMINAL_SWEEP_STATUSES,
				now,
				now,
				Math.max(0, Math.floor(input.limit)),
			) as Array<{ execution_id: string }>;
		return rows.map((row) => row.execution_id);
	}

	/**
	 * Rows the quota page shows: terminal within 24h of `now`, and either not
	 * yet proven closed or with tokens burned after terminal.
	 */
	listVisible(input: { now: Date; limit: number }): CodexTerminalCloseRow[] {
		const states = CODEX_TERMINAL_CLOSE_VISIBLE_STATES;
		return this.db
			.prepare(
				`SELECT * FROM codex_terminal_close
				  WHERE terminal_at IS NOT NULL
				    AND julianday(terminal_at) >= julianday(?, '-24 hours')
				    AND (state IN (${states.map(() => "?").join(",")})
				         OR COALESCE(tokens_after_terminal, 0) > 0)
				  ORDER BY julianday(terminal_at) DESC, execution_id
				  LIMIT ?`,
			)
			.all(
				input.now.toISOString(),
				...states,
				Math.max(0, Math.floor(input.limit)),
			) as CodexTerminalCloseRow[];
	}
}

export interface CodexTerminalCloseObservation {
	state: CodexTerminalCloseState;
	/** Audit source, e.g. `bridge.codex-terminal-sweep` or a terminal path. */
	source: string;
	projectName?: string | null;
	issueIdentifier?: string | null;
	sessionStatus: string;
	terminalAt?: string | null;
	evidence: CodexTerminalCloseEvidence;
	ownedStreak?: number;
	unknownStreak?: number;
	tokens?: {
		rolloutPath?: string | null;
		rolloutOffset?: number | null;
		rolloutLastTotal?: number | null;
		tokensAtTerminal?: number | null;
		tokensAfterTerminal?: number | null;
		confirmTokens?: number | null;
	};
	closedAt?: string | null;
	alertedKey?: string | null;
}

export interface CodexTerminalCloseLedgerDeps {
	store: CodexTerminalCloseStore;
	events: {
		insertEvent(event: SessionEvent): boolean;
		/** Same-connection transaction so row + event commit together. */
		transaction?: (fn: () => void) => void;
	};
	now?: () => Date;
}

export interface CodexTerminalCloseWrite {
	row: CodexTerminalCloseRow;
	changed: boolean;
	previous: CodexTerminalCloseRow | undefined;
}

function pick<T>(next: T | undefined, current: T): T {
	return next === undefined ? current : next;
}

/**
 * The single writer: upserts the row and, only when the state changes, writes
 * one `codex_terminal_close_<state>` session event with a deterministic id so
 * a replay never duplicates it.
 */
export function observeCodexTerminalClose(
	deps: CodexTerminalCloseLedgerDeps,
	executionId: string,
	observation: CodexTerminalCloseObservation,
): CodexTerminalCloseWrite {
	if (!executionId) throw new Error("codex_terminal_close_execution_missing");
	if (
		!(CODEX_TERMINAL_CLOSE_STATES as readonly string[]).includes(
			observation.state,
		)
	) {
		// The table CHECK is the authority; fail before touching it anyway.
		throw new Error(`codex_terminal_close_state_invalid:${observation.state}`);
	}
	const evidence = validateCodexTerminalCloseEvidence({
		source: observation.source,
		...observation.evidence,
	});
	const at = (deps.now ?? (() => new Date()))().toISOString();
	let write: CodexTerminalCloseWrite | undefined;
	const run = () => {
		const previous = deps.store.get(executionId);
		const changed = previous?.state !== observation.state;
		const tokens = observation.tokens ?? {};
		const row: CodexTerminalCloseRow = {
			execution_id: executionId,
			project_name: pick(
				observation.projectName,
				previous?.project_name ?? null,
			),
			issue_identifier: pick(
				observation.issueIdentifier,
				previous?.issue_identifier ?? null,
			),
			session_status: observation.sessionStatus,
			terminal_at: pick(observation.terminalAt, previous?.terminal_at ?? null),
			state: observation.state,
			owned_streak: pick(observation.ownedStreak, previous?.owned_streak ?? 0),
			unknown_streak: pick(
				observation.unknownStreak,
				previous?.unknown_streak ?? 0,
			),
			attempts: (previous?.attempts ?? 0) + (changed ? 1 : 0),
			rollout_path: pick(tokens.rolloutPath, previous?.rollout_path ?? null),
			rollout_offset: pick(
				tokens.rolloutOffset,
				previous?.rollout_offset ?? null,
			),
			rollout_last_total: pick(
				tokens.rolloutLastTotal,
				previous?.rollout_last_total ?? null,
			),
			tokens_at_terminal: pick(
				tokens.tokensAtTerminal,
				previous?.tokens_at_terminal ?? null,
			),
			tokens_after_terminal: pick(
				tokens.tokensAfterTerminal,
				previous?.tokens_after_terminal ?? null,
			),
			confirm_tokens: pick(
				tokens.confirmTokens,
				previous?.confirm_tokens ?? null,
			),
			last_evidence: JSON.stringify(evidence),
			first_seen_at: previous?.first_seen_at ?? at,
			last_checked_at: at,
			closed_at: pick(observation.closedAt, previous?.closed_at ?? null),
			alerted_key: pick(observation.alertedKey, previous?.alerted_key ?? null),
		};
		deps.store.upsert(row);
		if (changed) {
			deps.events.insertEvent({
				event_id: `codex-terminal-close:${executionId}:${row.state}:${row.attempts}`,
				execution_id: executionId,
				issue_id: row.issue_identifier ?? "unknown",
				project_name: row.project_name ?? "unknown",
				event_type: `codex_terminal_close_${row.state}`,
				source: observation.source,
				payload: {
					...evidence,
					previousState: previous?.state ?? null,
					sessionStatus: row.session_status,
					tokensAtTerminal: row.tokens_at_terminal,
					tokensAfterTerminal: row.tokens_after_terminal,
				},
			});
		}
		write = { row, changed, previous };
	};
	if (deps.events.transaction) deps.events.transaction(run);
	else run();
	if (!write) throw new Error("codex_terminal_close_write_missing");
	return write;
}

/**
 * State after a terminal path's reap. Only the sweep proves `closed`; a later
 * reap that found the daemon already absent never regresses an already-closed
 * row, while any reap that signalled or failed reopens it.
 */
export function closeAttemptState(
	previous: CodexTerminalCloseState | undefined,
	reap: NonNullable<CodexTerminalCloseEvidence["reap"]>,
): CodexTerminalCloseState {
	if (reap === "residual") return "alive_residual";
	if (reap === "unverifiable") return "alive_unverifiable";
	// Only a daemon already absent leaves a closed verdict standing: a `reaped`
	// outcome means a live, proven group was just signalled, so the sweep must
	// prove the close again.
	return previous === "closed" && reap === "absent"
		? "closed"
		: "close_attempted";
}

/** FLY-2903: what a terminal path records after its reap (no probe of its own). */
export interface CodexTerminalCloseAttemptRecorder {
	recordCloseAttempt(input: {
		executionId: string;
		source: string;
		ownerStop?: NonNullable<CodexTerminalCloseEvidence["ownerStop"]>;
		reap: NonNullable<CodexTerminalCloseEvidence["reap"]>;
	}): void;
}

export function createCodexTerminalCloseAttemptRecorder(store: {
	codexTerminalClose: CodexTerminalCloseStore;
	getSession(executionId: string):
		| {
				status: string;
				terminal_at?: string | null;
				issue_identifier?: string;
				issue_id: string;
				project_name: string;
		  }
		| undefined;
	insertEvent(event: SessionEvent): boolean;
	runInTransaction(fn: () => void): void;
}): CodexTerminalCloseAttemptRecorder {
	return {
		recordCloseAttempt(input) {
			const session = store.getSession(input.executionId);
			const previous = store.codexTerminalClose.get(input.executionId);
			observeCodexTerminalClose(
				{
					store: store.codexTerminalClose,
					events: {
						insertEvent: (event) => store.insertEvent(event),
						transaction: (fn) => store.runInTransaction(fn),
					},
				},
				input.executionId,
				{
					state: closeAttemptState(previous?.state, input.reap),
					source: input.source,
					projectName: session?.project_name ?? null,
					issueIdentifier:
						session?.issue_identifier ?? session?.issue_id ?? null,
					sessionStatus: session?.status ?? "unknown",
					terminalAt: session?.terminal_at ?? null,
					evidence: {
						...(input.ownerStop ? { ownerStop: input.ownerStop } : {}),
						reap: input.reap,
					},
				},
			);
		},
	};
}

/** FLY-2903: quota-page banner rows, best effort — any failure is an empty banner. */
export function terminalBodiesForQuotaPage(
	store: { codexTerminalClose: Pick<CodexTerminalCloseStore, "listVisible"> },
	now: Date,
	log: (line: string) => void = (line) => console.warn(line),
): Array<{
	executionId: string;
	issueIdentifier: string | null;
	terminalAt: string | null;
	state: string;
	tokensAfterTerminal: number | null;
}> {
	try {
		return store.codexTerminalClose
			.listVisible({ now, limit: 10 })
			.map((row) => ({
				executionId: row.execution_id,
				issueIdentifier: row.issue_identifier,
				terminalAt: row.terminal_at,
				state: row.state,
				tokensAfterTerminal: row.tokens_after_terminal,
			}));
	} catch (error) {
		log(
			`[codex-terminal-close] quota banner unavailable: ${error instanceof Error ? error.message : String(error)}`,
		);
		return [];
	}
}
