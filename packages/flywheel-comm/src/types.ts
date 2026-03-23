export interface Message {
	id: string;
	from_agent: string;
	to_agent: string;
	type: "question" | "response" | "instruction" | "progress";
	content: string;
	parent_id: string | null;
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
