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
	content_type: "text" | "ref";
	resolved_at: string | null;
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
}
