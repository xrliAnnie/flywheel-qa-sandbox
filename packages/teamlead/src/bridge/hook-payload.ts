export interface HookPayload {
	event_type: string;
	execution_id: string;
	issue_id: string;
	issue_identifier?: string;
	issue_title?: string;
	project_name?: string;
	status?: string;
	decision_route?: string;
	commit_count?: number;
	lines_added?: number;
	lines_removed?: number;
	summary?: string;
	last_error?: string;
	thread_id?: string;
	forum_channel?: string;
	chat_channel?: string;
	issue_labels?: string[];
	// stuck-specific
	minutes_since_activity?: number;
	// action-specific fields (GEO-167)
	action?: string;
	action_source_status?: string;
	action_target_status?: string;
	action_reason?: string;
}

/** Best-effort push to OpenClaw gateway (3s timeout, warn on failure). */
export async function notifyAgent(
	gatewayUrl: string,
	hooksToken: string,
	body: Record<string, unknown>,
): Promise<void> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 3000);
	try {
		const res = await fetch(`${gatewayUrl}/hooks/ingest`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${hooksToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		if (!res.ok) {
			console.warn(`[notify] Gateway returned ${res.status}`);
		}
	} catch (err) {
		console.warn(
			"[notify] Failed to push to OpenClaw gateway:",
			(err as Error).message,
		);
	} finally {
		clearTimeout(timeout);
	}
}

export function buildSessionKey(session: {
	issue_identifier?: string;
	issue_id: string;
}): string {
	return `flywheel:${session.issue_identifier ?? session.issue_id}`;
}

export function buildHookBody(
	agentId: string,
	payload: HookPayload,
	sessionKey?: string,
): Record<string, unknown> {
	const body: Record<string, unknown> = {
		agentId,
		message: JSON.stringify(payload),
	};
	if (sessionKey) body.sessionKey = sessionKey;
	return body;
}
