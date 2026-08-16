export interface Message {
	id: string;
	from_agent: string;
	to_agent: string;
	type: "question" | "response" | "instruction" | "progress" | "ack_receipt";
	content: string;
	parent_id: string | null;
	read_at: string | null;
	created_at: string;
	expires_at: string;
	/** Queue-native SLA; strict UTC ISO when present. */
	deadline_at: string | null;
	relay_state: "open" | "protected" | "terminal_disposed";
	/**
	 * FLY-1328: how this question was disposed of — 'owner_closed' (the owning
	 * runner's teardown cascade) or 'owner_closed_sweep' (the patrol catching a
	 * runner that died without one). Null for every row disposed of by any other
	 * path.
	 */
	resolved_via?: string | null;
	logical_event_id: string | null;
	/** FLY-1314: durable disposition for a gate retired by a newer issue gate. */
	superseded_at: string | null;
	/** FLY-1314: exact newer question id that caused the retirement. */
	superseded_by: string | null;
	checkpoint: string | null;
	content_ref: string | null;
	/** GEO-151: added "artifact" for ProofShot artifact_emitted audit rows. */
	content_type: "text" | "ref" | "artifact";
	resolved_at: string | null;
	delivered_at: string | null;
	/**
	 * GEO-151: JSON-encoded `string[]` of artifact file paths. Populated by
	 * `insertArtifactProgress` (type='progress' + content_type='artifact').
	 * Null for non-artifact rows. SQL column added by the GEO-151 migration.
	 */
	attachments: string | null;
	/**
	 * FLY-1041: 'report' = runner→Lead status report (`ask --report`) —
	 * excluded from the founder-reply binding candidate set. Null for every
	 * pre-FLY-1041 row and every unflagged ask (byte-compat).
	 */
	kind?: string | null;
	/** FLY-1309: immutable Lead pane holder resolved from lease generation history. */
	sender_lease_key: string | null;
	sender_generation: number | null;
	sender_holder_pid: number | null;
	sender_holder_start: string | null;
	/** OS process that performed the CommDB write (normally flywheel-comm CLI). */
	writer_pid: number | null;
	writer_start: string | null;
}

/** Result of attempting to write a question response. */
export type ResponseWriteResult =
	| { written: true }
	| { written: false; reason: "gate_not_open" };

/** Camel-case write shape; CommDB persists it in the six sender_* / writer_* columns. */
export interface MessageProvenance {
	senderLeaseKey?: string | null;
	senderGeneration?: number | null;
	senderHolderPid?: number | null;
	senderHolderStart?: string | null;
	writerPid?: number | null;
	writerStart?: string | null;
}

export interface CheckResult {
	status: "answered" | "pending";
	content?: string;
	from_agent?: string;
	created_at?: string;
}

export interface PendingQuestion {
	id: string;
	from_agent: string;
	content: string;
	created_at: string;
	checkpoint: string | null;
	content_type: "text" | "ref";
	content_ref: string | null;
	/** FLY-1041: see Message.kind — getPendingQuestions returns whole rows. */
	kind?: string | null;
}

/** Gate response structured content (convention, not DB-enforced) */
export interface GateResponseContent {
	approved: boolean;
	feedback?: string;
	corrections?: string[];
}

export interface Session {
	execution_id: string;
	tmux_window: string;
	project_name: string;
	issue_id: string | null;
	lead_id: string | null;
	started_at: string;
	ended_at: string | null;
	status: "running" | "completed" | "timeout" | "blocked" | "failed";
	/**
	 * FLY-1188: transport vendor of the runner ("claude-code" | "codex"),
	 * written by the spawning adapter. `send` routes the mailbox wake by it.
	 * NULL/undefined = legacy row → process-wide env transport (byte-compat).
	 */
	vendor?: string | null;
	/** FLY-1774: this execution owns a resident Codex phase-hold consumer. */
	phase_keep_alive?: 0 | 1;
}
