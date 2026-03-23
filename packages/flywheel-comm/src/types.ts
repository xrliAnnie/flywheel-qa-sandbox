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
