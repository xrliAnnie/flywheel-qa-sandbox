export interface Message {
	id: string;
	from_agent: string;
	to_agent: string;
	type: "question" | "response" | "instruction" | "progress";
	content: string;
	parent_id: string | null;
	read_at: string | null;
	created_at: string;
	expires_at: string;
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
	status: "running" | "completed" | "timeout";
	/**
	 * FLY-1188: transport vendor of the runner ("claude-code" | "codex"),
	 * written by the spawning adapter. `send` routes the mailbox wake by it.
	 * NULL/undefined = legacy row → process-wide env transport (byte-compat).
	 */
	vendor?: string | null;
}
