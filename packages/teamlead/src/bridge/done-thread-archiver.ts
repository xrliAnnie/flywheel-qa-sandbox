/**
 * FLY-369: archive-on-close.
 *
 * The Bridge only archived per-issue Discord chat threads on *ship*
 * (`runPostShipFinalization` → `archiveChatThread`, gated on
 * `landingStatus === "merged"`). Done-but-never-shipped issues (no-code
 * rollouts, QA-only, docs) therefore never had their thread archived and
 * piled up in the founder's sidebar.
 *
 * Archiving is driven **centrally by the runner-close action**, NOT a
 * standalone auto-poll on Linear "Done" — the founder wants archive bound to a
 * real wrap-up ("I say ship → you ship → no problem → THEN archive"), so a
 * thread is never archived just because Linear flipped to Done (premature, e.g.
 * a Done issue the team is still discussing). The PRIMARY trigger is
 * `maybeArchiveThreadOnClose`, invoked from `closeRunner` (the single chokepoint
 * every Lead's runner-close funnels through) — whoever closes the runner
 * triggers it, zero binding to a specific Lead. The on-demand
 * `POST /api/chat-threads/archive` endpoint is a low-level / backlog-backfill
 * capability only. The ship path still archives on ship.
 *
 * This module provides:
 *   - `maybeArchiveThreadOnClose` — the central close→archive cascade (PRIMARY
 *     trigger; see its doc for the done-cleanup + no-other-active guard).
 *   - `archiveThreadAndRecord` — the single token-bearing archive sink used by
 *     the cascade AND the endpoint. Archiving ALWAYS goes through the
 *     Bridge-local `archiveChatThread` (the Bridge holds the Discord bot token);
 *     no token-bearing Discord PATCH is ever hand-rolled outside the Bridge.
 *   - `resolveBotTokenForThread` — pick the bot token from the thread's
 *     creation-time `lead_id` (falling back to labels, then a global token).
 *
 * Safety net for an over-eager close: Discord's own auto-unarchive (posting in
 * an archived thread reopens it). "Archive once": a thread already marked
 * `archived_at` is not re-archived by the endpoint, so a re-open is not fought.
 * A Discord 404 is handled inside `archiveChatThread` (→ markChatThreadMissing).
 */

import { randomUUID } from "node:crypto";
import type { LeadConfig, ProjectEntry } from "../ProjectConfig.js";
import { resolveLeadForIssue } from "../ProjectConfig.js";
import type { StateStore } from "../StateStore.js";
import {
	type ArchiveChatThreadResult,
	archiveChatThread,
	removeUserFromChatThread,
} from "./chat-thread-utils.js";

// ── Shared archive sink (single token-bearing path) ─────────────────────────

export interface ArchiveThreadDeps {
	/** Test seam — defaults to the hardened `archiveChatThread`. */
	archiveFn?: typeof archiveChatThread;
	/** Test seam — defaults to `removeUserFromChatThread`. */
	removeUserFn?: typeof removeUserFromChatThread;
	/** Discord user removed from the thread before archive (sidebar cleanup). */
	discordOwnerUserId?: string;
	/** Discord HTTP override (passed to archive + removeUser); tests inject a mock. */
	fetchImpl?: typeof fetch;
	/**
	 * FLY-1165: audit attribution for the `chat_thread_archived[_failed]` event
	 * (e.g. `"bridge.post-ship-finalization"` when the ship path archives).
	 * Defaults to this module's source.
	 */
	auditSource?: string;
}

export interface ArchiveThreadInput {
	threadId: string;
	issueId: string;
	projectName: string;
	/** For the audit event grouping; synthetic when no session row exists. */
	executionId: string;
}

/**
 * FLY-1165: per-thread archive locks. Every archive of the same thread runs
 * through a serialized critical section so two concurrent callers (e.g. the
 * close cascade racing the post-ship path) cannot both pass the archive-once
 * guard and double-PATCH. The chain tail is rejection-proof (Codex R3 #1): a
 * failed predecessor never poisons the lock for the next caller.
 */
const threadArchiveLocks = new Map<string, Promise<unknown>>();

/**
 * The ONE place a chat thread is archived — the close cascade, the on-demand
 * endpoint, the reconcile sweep, AND the post-ship path (FLY-1165 folded it
 * in) all route here. Goes through the Bridge-local `archiveChatThread`
 * (Bridge holds the token), marks `archived_at` on success, and writes an
 * audit event either way. Never throws.
 *
 * Sink-level archive-once (FLY-1165): a FRESH `store.isChatThreadArchived`
 * read runs INSIDE the per-thread critical section — a thread with
 * `archived_at` set is never re-PATCHed (and its owner never re-removed), so
 * a founder re-open (Discord auto-unarchive on a new message) is not fought
 * by ANY caller. That case returns `reason: "already_archived"` (an
 * idempotent no-op success, attempts 0) and records a non-failure audit event.
 */
export async function archiveThreadAndRecord(
	store: StateStore,
	input: ArchiveThreadInput,
	botToken: string,
	deps: ArchiveThreadDeps = {},
): Promise<ArchiveChatThreadResult> {
	const auditSource = deps.auditSource ?? "bridge.done-thread-archiver";

	const run = async (): Promise<ArchiveChatThreadResult> => {
		// Archive-once guard — fresh read inside the critical section.
		if (store.isChatThreadArchived(input.threadId)) {
			const result: ArchiveChatThreadResult = {
				archived: false,
				attempts: 0,
				reason: "already_archived",
			};
			store.insertEvent({
				event_id: `chat-thread-archive-noop-fly1165-${randomUUID()}`,
				execution_id: input.executionId,
				issue_id: input.issueId,
				project_name: input.projectName,
				event_type: "chat_thread_archived",
				source: auditSource,
				payload: {
					threadId: input.threadId,
					attempts: 0,
					status: null,
					reason: "already_archived",
				},
			});
			return result;
		}

		const archiveFn = deps.archiveFn ?? archiveChatThread;
		const removeUserFn = deps.removeUserFn ?? removeUserFromChatThread;

		if (deps.discordOwnerUserId) {
			await removeUserFn(input.threadId, deps.discordOwnerUserId, botToken, {
				fetchImpl: deps.fetchImpl,
			});
		}

		const result = await archiveFn(input.threadId, botToken, {
			markDiscordMissing: (id) => store.markChatThreadMissing(id),
			fetchImpl: deps.fetchImpl,
		});

		if (result.archived) {
			store.markChatThreadArchived(input.threadId);
			store.insertEvent({
				event_id: `chat-thread-archived-fly369-${input.threadId}`,
				execution_id: input.executionId,
				issue_id: input.issueId,
				project_name: input.projectName,
				event_type: "chat_thread_archived",
				source: auditSource,
				payload: {
					threadId: input.threadId,
					attempts: result.attempts,
					status: result.status ?? null,
					reason: result.reason,
				},
			});
		} else {
			store.insertEvent({
				event_id: `chat-thread-archive-failed-fly369-${randomUUID()}`,
				execution_id: input.executionId,
				issue_id: input.issueId,
				project_name: input.projectName,
				event_type: "chat_thread_archive_failed",
				source: auditSource,
				payload: {
					threadId: input.threadId,
					attempts: result.attempts,
					status: result.status ?? null,
					reason: result.reason,
					error: result.error ?? null,
				},
			});
		}

		return result;
	};

	// Per-thread serialization: queue behind the previous archive of this
	// thread; a rejected predecessor is absorbed (settled tail) so the chain
	// never wedges.
	const prev =
		threadArchiveLocks.get(input.threadId) ?? Promise.resolve(undefined);
	const cur = prev.catch(() => undefined).then(run);
	threadArchiveLocks.set(input.threadId, cur);
	try {
		return await cur;
	} catch (err) {
		// Preserve the never-throws contract even for a throwing seam/store —
		// but NEVER silently: log + best-effort failure audit (Codex code R1 #2;
		// the cascade/post-ship callers ignore the return value, so this catch
		// is the only place the exception can surface).
		// Codex code R2 LOW: a thrown null/undefined must not re-throw here
		// (accessing .message on null would break never-throws).
		const message = err instanceof Error ? err.message : String(err);
		console.warn(
			`[done-thread-archiver] archive of ${input.threadId} (${input.issueId}) threw: ${message}`,
		);
		try {
			store.insertEvent({
				event_id: `chat-thread-archive-failed-fly369-${randomUUID()}`,
				execution_id: input.executionId,
				issue_id: input.issueId,
				project_name: input.projectName,
				event_type: "chat_thread_archive_failed",
				source: auditSource,
				payload: {
					threadId: input.threadId,
					attempts: 0,
					status: null,
					reason: "error",
					error: message,
				},
			});
		} catch {
			// Audit is best-effort here (the store itself may be what threw);
			// the console.warn above already surfaced the failure.
		}
		return {
			archived: false,
			attempts: 0,
			reason: "error",
			error: message,
		};
	} finally {
		// Identity-checked cleanup: only the tail owner clears the slot.
		if (threadArchiveLocks.get(input.threadId) === cur) {
			threadArchiveLocks.delete(input.threadId);
		}
	}
}

// ── Central close→archive cascade ───────────────────────────────────────────

export interface CloseArchiveDeps {
	projects: ProjectEntry[];
	/** Global bot token fallback when the lead config has none. */
	globalBotToken?: string;
	/** Discord user removed from the thread before archive (sidebar cleanup). */
	discordOwnerUserId?: string;
	/** Test seam for the archive sink. */
	archiveFn?: typeof archiveChatThread;
	removeUserFn?: typeof removeUserFromChatThread;
	fetchImpl?: typeof fetch;
}

const CLOSE_ARCHIVE_ACTIVE_STATUSES = [
	"running",
	"awaiting_review",
	"approved_to_ship",
];

/**
 * FLY-369 / FLY-720: the guarded close→archive cascade. Archives the issue's
 * chat thread ONLY when BOTH hold:
 *   (a) `session.status` is in `opts.allowStatuses` (the caller's status gate),
 *       and
 *   (b) the issue has no OTHER active runner (running/awaiting_review/
 *       approved_to_ship).
 *
 * This is the single archive-policy surface — label/lead resolution, chat-channel
 * + thread lookup, bot-token selection, and the "no other active runner" guard
 * live here so callers never fork the policy (Codex FLY-720 R1 MED-4). Two
 * callers parameterize the status gate:
 *   - `maybeArchiveThreadOnClose` → `["completed"]` (FLY-369 done-cleanup close).
 *   - the FLY-720 crash reaper → `["terminated"]`, AFTER it has transitioned the
 *     just-reaped row to `terminated` (so the row is excluded from the active-set
 *     check above).
 *
 * Always goes through `archiveThreadAndRecord` → Bridge-local `archiveChatThread`
 * (idempotent Discord PATCH). Never throws.
 */
export async function archiveIssueThreadIfNoOtherActive(
	store: StateStore,
	session: {
		execution_id: string;
		issue_id: string;
		issue_identifier?: string;
		project_name: string;
		status: string;
	},
	deps: CloseArchiveDeps,
	opts: { allowStatuses: readonly string[] },
): Promise<void> {
	try {
		// (a) status gate — only the caller-allowed terminal statuses archive.
		if (!opts.allowStatuses.includes(session.status)) return;

		// (b) no OTHER active runner for the same issue.
		const others = store
			.getSessionsByIssueAndStatuses(
				session.issue_id,
				CLOSE_ARCHIVE_ACTIVE_STATUSES,
			)
			.filter((s) => s.execution_id !== session.execution_id);
		if (others.length > 0) return;

		const labels = store.getSessionLabels(session.execution_id);
		let chatChannel: string | undefined;
		try {
			const { lead } = resolveLeadForIssue(
				deps.projects,
				session.project_name,
				labels,
			);
			chatChannel = lead.chatChannel;
		} catch {
			// no project / lead — cannot resolve channel; nothing to archive.
			return;
		}
		if (!chatChannel) return;

		const thread = store.getChatThreadByIssue(session.issue_id, chatChannel);
		if (!thread) return; // no registered thread for this issue/channel

		const botToken = resolveBotTokenForThread(deps.projects, {
			projectName: session.project_name,
			leadId: thread.lead_id,
			labels,
			fallbackBotToken: deps.globalBotToken,
		});
		if (!botToken) return;

		await archiveThreadAndRecord(
			store,
			{
				threadId: thread.thread_id,
				issueId: session.issue_id,
				projectName: session.project_name,
				executionId: session.execution_id,
			},
			botToken,
			{
				archiveFn: deps.archiveFn,
				removeUserFn: deps.removeUserFn,
				discordOwnerUserId: deps.discordOwnerUserId,
				fetchImpl: deps.fetchImpl,
			},
		);
	} catch (err) {
		// Never let archive cascade break the close/reap path.
		console.warn(
			`[done-thread-archiver] archive cascade failed for ${session.execution_id} (${session.issue_id}): ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

/**
 * FLY-369: the central close→archive cascade. Called from `closeRunner` (the
 * single chokepoint every Lead's runner-close funnels through), so archiving is
 * bound to a real close action — NOT to Linear flipping to "Done" (premature).
 * Zero binding to a specific Lead: whoever closes the runner triggers it.
 *
 * Done-cleanup only: archives when `session.status === "completed"` (NOT an
 * abandon/terminate: rejected/deferred/shelved/terminated/failed/blocked never
 * archive here). Thin delegate over `archiveIssueThreadIfNoOtherActive` with the
 * `["completed"]` gate — byte-compatible with the pre-FLY-720 behavior.
 */
export async function maybeArchiveThreadOnClose(
	store: StateStore,
	session: {
		execution_id: string;
		issue_id: string;
		issue_identifier?: string;
		project_name: string;
		status: string;
	},
	deps: CloseArchiveDeps,
): Promise<void> {
	return archiveIssueThreadIfNoOtherActive(store, session, deps, {
		allowStatuses: ["completed"],
	});
}

/** Resolve the bot token for a thread, preferring its creation-time lead_id. */
export function resolveBotTokenForThread(
	projects: ProjectEntry[],
	opts: {
		projectName: string;
		leadId: string | null;
		labels: string[];
		fallbackBotToken?: string;
	},
): string | undefined {
	const project = projects.find((p) => p.projectName === opts.projectName);
	// Prefer the lead recorded on the thread at creation time.
	if (project && opts.leadId) {
		const byId: LeadConfig | undefined = project.leads.find(
			(l) => l.agentId === opts.leadId,
		);
		if (byId?.botToken) return byId.botToken;
	}
	// Legacy rows without lead_id: fall back to current label-based resolution.
	if (project) {
		try {
			const { lead } = resolveLeadForIssue(
				projects,
				opts.projectName,
				opts.labels,
			);
			if (lead.botToken) return lead.botToken;
		} catch {
			// no project / lead — fall through to global
		}
	}
	return opts.fallbackBotToken;
}
