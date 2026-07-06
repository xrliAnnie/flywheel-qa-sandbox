/**
 * FLY-91 Round 2+3: Shared validation + registration for Lead-created chat threads.
 * Used by /api/runs/start (atomic), /api/chat-threads/register, and /api/chat-threads/create.
 *
 * Round 3: Split into validateChatThreadParams (pure validation) and
 * validateAndRegisterChatThread (validate + conflict check + upsert).
 */

import type { LeadConfig, ProjectEntry } from "../ProjectConfig.js";
import type { StateStore } from "../StateStore.js";

const DISCORD_API = "https://discord.com/api/v10";
const VALIDATE_TIMEOUT_MS = 5_000;

export interface RegisterChatThreadParams {
	threadId: string;
	channelId: string;
	issueId: string;
	leadId: string;
	projectName: string;
	/** When provided, validates threadId exists in Discord before persisting. */
	botToken?: string;
}

export interface RegisterOk {
	ok: true;
}

export interface RegisterError {
	ok: false;
	status: number;
	error: string;
}

export type RegisterResult = RegisterOk | RegisterError;

/** FLY-91 Round 3: Successful validation returns resolved project + lead config. */
export interface ValidatedChatThreadContext {
	ok: true;
	project: ProjectEntry;
	leadConfig: LeadConfig;
}

/**
 * FLY-91 Round 3: Pure validation — project lookup, lead agentId match, chatChannel check.
 * No side effects (no DB writes). Used by both /register and /create.
 */
export function validateChatThreadParams(
	params: { channelId: string; leadId: string; projectName: string },
	projects: ProjectEntry[],
): ValidatedChatThreadContext | RegisterError {
	const { channelId, leadId, projectName } = params;

	const project = projects.find((p) => p.projectName === projectName);
	if (!project) {
		return {
			ok: false,
			status: 404,
			error: `Project "${projectName}" not found`,
		};
	}

	const leadConfig = project.leads.find((l) => l.agentId === leadId);
	if (!leadConfig) {
		return {
			ok: false,
			status: 403,
			error: `Lead "${leadId}" not configured for project "${projectName}"`,
		};
	}

	if (leadConfig.chatChannel !== channelId) {
		return {
			ok: false,
			status: 400,
			error: `channelId "${channelId}" does not match lead's chatChannel "${leadConfig.chatChannel}"`,
		};
	}

	return { ok: true, project, leadConfig };
}

/**
 * Validate that a Discord thread exists and belongs to the expected parent channel.
 * Returns null on success, or a RegisterError on failure.
 * Fail-open on network/timeout errors (log warning, allow registration).
 */
async function validateThreadInDiscord(
	threadId: string,
	expectedChannelId: string,
	botToken: string,
): Promise<RegisterError | null> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), VALIDATE_TIMEOUT_MS);
	try {
		const res = await fetch(`${DISCORD_API}/channels/${threadId}`, {
			headers: { Authorization: `Bot ${botToken}` },
			signal: controller.signal,
		});
		if (res.status === 404) {
			return {
				ok: false,
				status: 404,
				error: `Thread ${threadId} does not exist in Discord`,
			};
		}
		// Reject on auth/permission failures — these indicate misconfiguration
		if (res.status === 401 || res.status === 403) {
			return {
				ok: false,
				status: 502,
				error: `Discord returned ${res.status} validating thread ${threadId} — check bot token/permissions`,
			};
		}
		if (res.ok) {
			const data = (await res.json()) as {
				type?: number;
				parent_id?: string;
			};
			// Discord thread types: 10 (announcement), 11 (public), 12 (private)
			const isThread = data.type === 10 || data.type === 11 || data.type === 12;
			if (!isThread) {
				return {
					ok: false,
					status: 400,
					error: `Channel ${threadId} is not a thread (type=${data.type})`,
				};
			}
			if (data.parent_id !== expectedChannelId) {
				return {
					ok: false,
					status: 400,
					error: `Thread ${threadId} belongs to channel ${data.parent_id}, not ${expectedChannelId}`,
				};
			}
			return null; // All checks passed
		}
		// Fail-open only for truly transient errors (429 rate-limit, 5xx server errors)
		if (res.status === 429 || res.status >= 500) {
			console.warn(
				`[chat-thread-register] Discord returned ${res.status} (transient, fail-open)`,
			);
			return null;
		}
		// All other unexpected status codes → reject (non-transient)
		return {
			ok: false,
			status: 502,
			error: `Discord returned unexpected ${res.status} validating thread ${threadId}`,
		};
	} catch (err) {
		console.warn(
			`[chat-thread-register] Discord validation error (fail-open):`,
			(err as Error).message,
		);
		return null; // fail-open on network/timeout
	} finally {
		clearTimeout(timeout);
	}
}

export async function validateAndRegisterChatThread(
	params: RegisterChatThreadParams,
	store: StateStore,
	projects: ProjectEntry[],
): Promise<RegisterResult> {
	const { threadId, channelId, issueId, leadId, projectName, botToken } =
		params;

	// 1-3. Shared validation
	const validation = validateChatThreadParams(
		{ channelId, leadId, projectName },
		projects,
	);
	if (!validation.ok) return validation;

	// 4. Validate thread exists in Discord and belongs to correct channel
	//    (only when botToken is provided — callers like /runs/start that
	//    register a thread just created by ChatThreadCreator can skip this)
	if (botToken) {
		const discordError = await validateThreadInDiscord(
			threadId,
			channelId,
			botToken,
		);
		if (discordError) return discordError;
	}

	// 5. Conflict detection: thread already mapped to different issue
	const existing = store.getChatThreadByThreadId(threadId);
	if (existing && existing.issue_id !== issueId) {
		return {
			ok: false,
			status: 409,
			error: `Thread ${threadId} already mapped to issue ${existing.issue_id}`,
		};
	}

	// 6. Warn if overriding an existing mapping (e.g., Bridge-created → Lead-created)
	const current = store.getChatThreadByIssue(issueId, channelId);
	if (current && current.thread_id !== threadId) {
		console.warn(
			`[chat-thread-register] Overriding thread for issue ${issueId} in channel ${channelId}: ${current.thread_id} → ${threadId}`,
		);
	}

	// 7. Register
	store.upsertChatThread(threadId, channelId, issueId, leadId);
	return { ok: true };
}
