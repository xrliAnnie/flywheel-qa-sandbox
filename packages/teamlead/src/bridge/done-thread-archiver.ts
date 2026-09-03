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
 * Discord's own auto-unarchive can reopen a thread after a new message. Local
 * `archived_at` is therefore history, not proof of current Discord state:
 * nonterminal callers preserve a human reopen, while a fresh terminal caller
 * may re-archive after the quiet window and frontier checks. A Discord 404 is
 * handled inside `archiveChatThread` (→ markChatThreadMissing).
 */

import { randomUUID } from "node:crypto";
import type { LeadConfig, ProjectEntry } from "../ProjectConfig.js";
import { resolveLeadForIssue } from "../ProjectConfig.js";
import type {
	ReopenVetoCandidates,
	StateStore,
	ThreadArchiveCompensationCause,
} from "../StateStore.js";
import {
	type ArchiveChatThreadResult,
	archiveChatThread,
	classifyThreadReopener,
	getChannelName,
	getLatestThreadMessageId,
	removeUserFromChatThread,
	unarchiveChatThread,
} from "./chat-thread-utils.js";
import { snowflakeToMs } from "./discord-guild-active-threads.js";
import {
	lookupTmuxTarget,
	probeRunnerProcessLiveness,
	type RunnerLiveness,
	type TmuxTargetLookup,
} from "./tmux-lookup.js";

// ── Shared archive sink (single token-bearing path) ─────────────────────────

export interface ArchiveThreadDeps {
	/** Caller-proven terminal issue state overrides the human-reopen veto. */
	authority?: ArchiveAuthority;
	/** Minimum inactivity before an automatic archive. */
	quietWindowMs?: number;
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
	probeFn?: typeof getChannelName;
	classifyFn?: typeof classifyThreadReopener;
	frontierFn?: typeof getLatestThreadMessageId;
	unarchiveFn?: typeof unarchiveChatThread;
	targetLookupFn?: (
		executionId: string,
		projectName: string,
	) => TmuxTargetLookup;
	livenessProbeFn?: (tmuxWindow: string) => Promise<RunnerLiveness>;
	nowMs?: () => number;
	sleepImpl?: (ms: number) => Promise<void>;
}

export type ArchiveAuthority = "terminal" | "none";
export const ISSUE_THREAD_QUIET_WINDOW_MS = 60 * 60_000;

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

/** Narrow protection for a just-admitted run before its tmux target exists. */
export const REOPEN_ADMISSION_GRACE_MS = 5 * 60_000;

export type ArchiveEpoch = { startMs: number; endMs: number };

/** Parse new ISO-millisecond epochs and legacy SQLite second-wide epochs. */
export function archiveEpochInterval(raw: string): ArchiveEpoch | null {
	const legacy = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(raw);
	if (legacy) {
		const startMs = Date.parse(`${legacy[1]}T${legacy[2]}Z`);
		return Number.isFinite(startMs)
			? { startMs, endMs: startMs + 1_000 }
			: null;
	}
	const point = stateTimestampMs(raw);
	return point !== null ? { startMs: point, endMs: point } : null;
}

/** Parse StateStore UTC strings, including SQLite-style timestamps. */
export function stateTimestampMs(raw: string): number | null {
	const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw)
		? `${raw.replace(" ", "T")}Z`
		: raw;
	const value = Date.parse(normalized);
	return Number.isFinite(value) ? value : null;
}

/** Materialized candidates only: never hold a SQLite statement across awaits. */
export async function resolveReopenVeto(
	candidates: ReopenVetoCandidates,
	archivedAtRaw: string,
	deps: Pick<
		ArchiveThreadDeps,
		"targetLookupFn" | "livenessProbeFn" | "nowMs"
	> = {},
): Promise<{ executionId: string } | null> {
	const epoch = archiveEpochInterval(archivedAtRaw);
	if (!epoch) return candidates.sessions[0] ?? candidates.claims[0] ?? null;
	const nowMs = (deps.nowMs ?? Date.now)();
	const lookup = deps.targetLookupFn ?? lookupTmuxTarget;
	const probe = deps.livenessProbeFn ?? probeRunnerProcessLiveness;
	const sessionIds = new Set(candidates.sessions.map((row) => row.executionId));

	for (const session of candidates.sessions) {
		const startedMs = session.startedAt
			? (stateTimestampMs(session.startedAt) ?? Number.NaN)
			: Number.NaN;
		if (
			Number.isFinite(startedMs) &&
			startedMs > epoch.endMs &&
			nowMs - startedMs <= REOPEN_ADMISSION_GRACE_MS
		) {
			return { executionId: session.executionId };
		}
		let target: TmuxTargetLookup;
		try {
			target = lookup(session.executionId, session.projectName);
		} catch {
			return { executionId: session.executionId };
		}
		if (target.kind === "error") return { executionId: session.executionId };
		if (target.kind === "gone") continue;
		let liveness: RunnerLiveness;
		try {
			liveness = await probe(target.target.tmuxWindow);
		} catch {
			liveness = "indeterminate";
		}
		if (liveness === "alive" || liveness === "indeterminate") {
			return { executionId: session.executionId };
		}
	}

	for (const claim of candidates.claims) {
		if (sessionIds.has(claim.executionId)) continue;
		const createdMs = stateTimestampMs(claim.createdAt) ?? Number.NaN;
		if (
			Number.isFinite(createdMs) &&
			createdMs > epoch.endMs &&
			nowMs - createdMs <= REOPEN_ADMISSION_GRACE_MS
		) {
			return { executionId: claim.executionId };
		}
	}
	return null;
}

/** Shared with explicit lifecycle reactivation so both mutations serialize. */
export async function runUnderThreadArchiveLock<T>(
	threadId: string,
	run: () => Promise<T>,
): Promise<T> {
	const prev = threadArchiveLocks.get(threadId) ?? Promise.resolve(undefined);
	const cur = prev.catch(() => undefined).then(run);
	threadArchiveLocks.set(threadId, cur);
	try {
		return await cur;
	} finally {
		if (threadArchiveLocks.get(threadId) === cur) {
			threadArchiveLocks.delete(threadId);
		}
	}
}

/**
 * Explicit new-run reactivation. A pending compensation receipt is discharged
 * to verified-open before the archive epoch is cleared; failure stays durable
 * and never blocks the session-start path.
 */
export async function reactivateChatThreadForStartedSession(
	store: StateStore,
	input: ArchiveThreadInput,
	botToken: string,
	deps: Pick<ArchiveThreadDeps, "probeFn" | "unarchiveFn" | "fetchImpl"> = {},
): Promise<boolean> {
	try {
		return await runUnderThreadArchiveLock(input.threadId, async () => {
			const pending = store.getChatThreadCompensationPending(input.threadId);
			if (pending) {
				const probeFn = deps.probeFn ?? getChannelName;
				const unarchiveFn = deps.unarchiveFn ?? unarchiveChatThread;
				const restDeps = { fetchImpl: deps.fetchImpl };
				let probe = await probeFn(input.threadId, botToken, restDeps);
				if (!probe.ok || probe.archived === undefined) {
					throw new Error(
						probe.ok ? "Discord archive state is missing" : probe.error,
					);
				}
				if (probe.archived) {
					await unarchiveFn(input.threadId, botToken, restDeps);
					probe = await probeFn(input.threadId, botToken, restDeps);
					if (!probe.ok || probe.archived !== false) {
						throw new Error(
							probe.ok ? "reactivation did not verify open" : probe.error,
						);
					}
				}
			}
			store.commitReactivation(input.threadId);
			return true;
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.warn(
			`[done-thread-archiver] reactivation of ${input.threadId} (${input.issueId}) deferred: ${message}`,
		);
		try {
			store.insertEvent({
				event_id: `chat-thread-reactivation-failed-fly1709-${randomUUID()}`,
				execution_id: input.executionId,
				issue_id: input.issueId,
				project_name: input.projectName,
				event_type: "chat_thread_reactivation_failed",
				source: "direct-event-sink",
				payload: { threadId: input.threadId, error: message },
			});
		} catch {
			// The warning above remains the loud failure trace if StateStore failed.
		}
		return false;
	}
}

/**
 * The ONE place a chat thread is archived — the close cascade, the on-demand
 * endpoint, the reconcile sweep, AND the post-ship path (FLY-1165 folded it
 * in) all route here. Goes through the Bridge-local `archiveChatThread`
 * (Bridge holds the token), marks `archived_at` on success, and writes an
 * audit event either way. Never throws.
 *
 * FLY-1709 refines the archive-once guard inside the per-thread critical
 * section: Discord-confirmed archived state is a truthful idempotent success;
 * any human post-archive message protects the reopened thread; bot-only
 * reopen activity may be re-archived behind frontier checks and compensation.
 */
export async function archiveThreadAndRecord(
	store: StateStore,
	input: ArchiveThreadInput,
	botToken: string,
	deps: ArchiveThreadDeps = {},
): Promise<ArchiveChatThreadResult> {
	const auditSource = deps.auditSource ?? "bridge.done-thread-archiver";
	const probeFn = deps.probeFn ?? getChannelName;
	const classifyFn = deps.classifyFn ?? classifyThreadReopener;
	const frontierFn = deps.frontierFn ?? getLatestThreadMessageId;
	const unarchiveFn = deps.unarchiveFn ?? unarchiveChatThread;
	const displayDeps = { fetchImpl: deps.fetchImpl };
	const authority = deps.authority ?? "none";
	const quietWindowMs = deps.quietWindowMs ?? ISSUE_THREAD_QUIET_WINDOW_MS;
	const nowMs = deps.nowMs ?? Date.now;
	const sleepImpl =
		deps.sleepImpl ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const retryDiscordRead = async <
		T extends { ok: boolean; status?: number; retryAfterMs?: number },
	>(
		read: () => Promise<T>,
	): Promise<T> => {
		let result = await read();
		for (let attempt = 1; attempt < 3; attempt += 1) {
			const transient =
				!result.ok &&
				(result.status === undefined ||
					result.status === 429 ||
					result.status >= 500);
			if (!transient) break;
			await sleepImpl(
				Math.min(result.retryAfterMs ?? 200 * 2 ** (attempt - 1), 5_000),
			);
			result = await read();
		}
		return result;
	};

	const isQuiet = (
		frontierMessageId: string | null,
		archiveTimestamp?: string,
	): boolean | null => {
		const messageAt = snowflakeToMs(frontierMessageId);
		if (messageAt === null) return null;
		const parsedArchiveAt = Date.parse(archiveTimestamp ?? "");
		const lastActivity = Number.isFinite(parsedArchiveAt)
			? Math.max(messageAt, parsedArchiveAt)
			: messageAt;
		const current = nowMs();
		return lastActivity <= current && current - lastActivity >= quietWindowMs;
	};

	const deferredQuietWindow = (): ArchiveChatThreadResult => ({
		archived: false,
		attempts: 0,
		reason: "deferred_quiet_window",
	});

	const audit = (
		result: ArchiveChatThreadResult,
		opts: { skip?: boolean; reArchived?: boolean } = {},
	): ArchiveChatThreadResult => {
		const success = result.archived || opts.skip;
		store.insertEvent({
			event_id: opts.reArchived
				? `chat-thread-rearchived-fly1709-${randomUUID()}`
				: success
					? `chat-thread-archive-skip-fly1709-${randomUUID()}`
					: `chat-thread-archive-failed-fly369-${randomUUID()}`,
			execution_id: input.executionId,
			issue_id: input.issueId,
			project_name: input.projectName,
			event_type: success
				? "chat_thread_archived"
				: "chat_thread_archive_failed",
			source: auditSource,
			payload: {
				threadId: input.threadId,
				attempts: result.attempts,
				status: result.status ?? null,
				reason: result.reason,
				error: result.error ?? null,
				...(result.activeExecutionId
					? { activeExecutionId: result.activeExecutionId }
					: {}),
				...(opts.reArchived ? { reArchived: true } : {}),
			},
		});
		return result;
	};

	const reopenFailure = (error?: string): ArchiveChatThreadResult => ({
		archived: false,
		attempts: 0,
		reason: "reopen_check_failed",
		...(error ? { error } : {}),
	});

	const resultForCause = (
		cause: ThreadArchiveCompensationCause,
	): ArchiveChatThreadResult =>
		cause === "human"
			? { archived: false, attempts: 0, reason: "founder_reopened" }
			: reopenFailure();

	const compensateKnownArchived = async (
		cause: ThreadArchiveCompensationCause,
	): Promise<ArchiveChatThreadResult> => {
		const pending = store.getChatThreadCompensationPending(input.threadId);
		if (pending?.version === 1 && pending.cause !== cause) {
			store.setChatThreadCompensationPending(input.threadId, {
				...pending,
				cause,
			});
		}
		const unarchiveResult = await unarchiveFn(
			input.threadId,
			botToken,
			displayDeps,
		);
		const verification = await probeFn(input.threadId, botToken, displayDeps);
		if (verification.ok && verification.archived === false) {
			store.clearChatThreadCompensationPending(input.threadId);
			return resultForCause(cause);
		}
		return reopenFailure(
			unarchiveResult.error ??
				(verification.ok
					? "compensation did not verify open"
					: verification.error),
		);
	};

	const resumeCompensation = async (): Promise<ArchiveChatThreadResult> => {
		const pending = store.getChatThreadCompensationPending(input.threadId);
		const cause = pending?.cause ?? "verify_failed";
		const probe = await probeFn(input.threadId, botToken, displayDeps);
		if (!probe.ok) {
			if (probe.status === 404) {
				store.markChatThreadMissing(input.threadId);
				store.clearChatThreadCompensationPending(input.threadId);
				return { archived: false, attempts: 0, status: 404, reason: "missing" };
			}
			return reopenFailure(probe.error);
		}
		if (probe.archived === false) {
			store.clearChatThreadCompensationPending(input.threadId);
			return reopenFailure();
		}
		if (probe.archived !== true) {
			return reopenFailure("Discord archive state is missing");
		}
		await compensateKnownArchived(cause);
		// A recovery invocation never reports success. The next invocation starts
		// from a clean state and re-evaluates the complete archive policy.
		return reopenFailure();
	};

	const reArchiveWithQuietWindow = async (
		archivedAtRaw: string,
		afterMs: number,
		frontier: string,
	): Promise<ArchiveChatThreadResult> => {
		const before = await frontierFn(input.threadId, botToken, displayDeps);
		if (!before.ok || before.messageId !== frontier) {
			return audit(
				reopenFailure(before.ok ? "message frontier changed" : before.error),
			);
		}

		store.setChatThreadCompensationPending(input.threadId, {
			version: 1,
			state: "prepared",
			archiveEpoch: archivedAtRaw,
			frontier,
			cause: "unknown",
			at: new Date().toISOString(),
		});

		const archiveFn = deps.archiveFn ?? archiveChatThread;
		const patchResult = await archiveFn(input.threadId, botToken, {
			markDiscordMissing: (id) => store.markChatThreadMissing(id),
			fetchImpl: deps.fetchImpl,
		});
		if (!patchResult.archived) {
			const current = await probeFn(input.threadId, botToken, displayDeps);
			if (!current.ok && current.status === 404) {
				store.clearChatThreadCompensationPending(input.threadId);
				return audit({ ...patchResult, reason: "missing" });
			}
			if (current.ok && current.archived === false) {
				store.clearChatThreadCompensationPending(input.threadId);
				return audit(patchResult);
			}
			if (current.ok && current.archived === true) {
				return audit(await compensateKnownArchived("verify_failed"));
			}
			return audit(reopenFailure(current.ok ? undefined : current.error));
		}

		const [metadata, after] = await Promise.all([
			probeFn(input.threadId, botToken, displayDeps),
			frontierFn(input.threadId, botToken, displayDeps),
		]);
		if (
			metadata.ok &&
			metadata.archived === true &&
			after.ok &&
			after.messageId === frontier
		) {
			const result: ArchiveChatThreadResult = {
				...patchResult,
				archived: true,
			};
			store.commitThreadArchive(input.threadId, {
				event_id: `chat-thread-rearchived-fly1709-${randomUUID()}`,
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
					reArchived: true,
				},
			});
			return result;
		}

		if (metadata.ok && metadata.archived === false) {
			store.clearChatThreadCompensationPending(input.threadId);
			if (after.ok && after.messageId === frontier) {
				if (authority === "terminal") return deferredQuietWindow();
				return audit(
					{ archived: false, attempts: 0, reason: "founder_reopened" },
					{ skip: true },
				);
			}
			const incremental = await classifyFn(
				input.threadId,
				botToken,
				afterMs,
				displayDeps,
			);
			if (incremental.kind !== "human") return audit(reopenFailure());
			return authority === "terminal"
				? deferredQuietWindow()
				: audit(
						{ archived: false, attempts: 0, reason: "founder_reopened" },
						{ skip: true },
					);
		}

		let cause: ThreadArchiveCompensationCause = "verify_failed";
		if (after.ok && after.messageId !== frontier) {
			const incremental = await classifyFn(
				input.threadId,
				botToken,
				afterMs,
				displayDeps,
			);
			if (incremental.kind === "human") cause = "human";
		}
		const compensated = await compensateKnownArchived(cause);
		if (
			cause === "human" &&
			authority === "terminal" &&
			!store.getChatThreadCompensationPending(input.threadId)
		) {
			return deferredQuietWindow();
		}
		return cause === "human"
			? audit(compensated, { skip: true })
			: audit(compensated);
	};

	const run = async (): Promise<ArchiveChatThreadResult> => {
		if (store.getChatThreadCompensationPending(input.threadId)) {
			return audit(await resumeCompensation());
		}

		const archivedAtRaw = store.getChatThreadArchivedAt(input.threadId);
		if (archivedAtRaw) {
			const probe = await retryDiscordRead(() =>
				probeFn(input.threadId, botToken, displayDeps),
			);
			if (!probe.ok) {
				if (probe.status === 404) {
					store.markChatThreadMissing(input.threadId);
					return audit({
						archived: false,
						attempts: 0,
						status: 404,
						reason: "missing",
					});
				}
				return audit(reopenFailure(probe.error));
			}
			if (probe.archived === true) {
				return audit(
					{ archived: true, attempts: 0, reason: "already_archived" },
					{ skip: true },
				);
			}
			if (probe.archived !== false) {
				return audit(reopenFailure("Discord archive state is missing"));
			}
			const epoch = archiveEpochInterval(archivedAtRaw);
			if (!epoch) return audit(reopenFailure("invalid archive epoch"));
			const active = await resolveReopenVeto(
				store.listReopenVetoCandidates(input.issueId),
				archivedAtRaw,
				deps,
			);
			if (active) {
				return audit(
					{
						archived: false,
						attempts: 0,
						reason: "in_active_use",
						activeExecutionId: active.executionId,
					},
					{ skip: true },
				);
			}
			const afterMs = epoch.startMs - 2_000;
			if (authority === "terminal") {
				const frontier = await frontierFn(
					input.threadId,
					botToken,
					displayDeps,
				);
				if (!frontier.ok || frontier.messageId === null) {
					return audit(
						reopenFailure(frontier.ok ? "no message clock" : frontier.error),
					);
				}
				const quiet = isQuiet(frontier.messageId, probe.archiveTimestamp);
				if (quiet === null) {
					return audit(reopenFailure("invalid message clock"));
				}
				if (!quiet) return deferredQuietWindow();
				return reArchiveWithQuietWindow(
					archivedAtRaw,
					afterMs,
					frontier.messageId,
				);
			}
			const classification = await classifyFn(
				input.threadId,
				botToken,
				afterMs,
				displayDeps,
			);
			if (classification.kind === "human") {
				return audit(
					{ archived: false, attempts: 0, reason: "founder_reopened" },
					{ skip: true },
				);
			}
			if (classification.kind === "unknown") {
				return audit(reopenFailure(classification.detail));
			}
			const quiet = isQuiet(
				classification.frontierMessageId,
				probe.archiveTimestamp,
			);
			if (quiet === null) {
				return audit(reopenFailure("invalid message clock"));
			}
			if (!quiet) return deferredQuietWindow();
			return reArchiveWithQuietWindow(
				archivedAtRaw,
				afterMs,
				classification.frontierMessageId,
			);
		}

		const archiveFn = deps.archiveFn ?? archiveChatThread;
		const removeUserFn = deps.removeUserFn ?? removeUserFromChatThread;
		if (quietWindowMs > 0) {
			const probe = await retryDiscordRead(() =>
				probeFn(input.threadId, botToken, displayDeps),
			);
			if (!probe.ok && probe.status === 404) {
				store.markChatThreadMissing(input.threadId);
				return audit({
					archived: false,
					attempts: 0,
					status: 404,
					reason: "missing",
				});
			}
			if (probe.ok && probe.archived === true) {
				const result: ArchiveChatThreadResult = {
					archived: true,
					attempts: 0,
					reason: "already_archived",
				};
				store.commitThreadArchive(input.threadId, {
					event_id: `chat-thread-archive-skip-fly1709-${randomUUID()}`,
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
			if (!probe.ok || probe.archived !== false) {
				return audit(
					reopenFailure(
						probe.ok ? "Discord archive state is missing" : probe.error,
					),
				);
			}
			const frontier = await retryDiscordRead(() =>
				frontierFn(input.threadId, botToken, displayDeps),
			);
			if (!frontier.ok || frontier.messageId === null) {
				return audit(
					reopenFailure(frontier.ok ? "no message clock" : frontier.error),
				);
			}
			const quiet = isQuiet(frontier.messageId, probe.archiveTimestamp);
			if (quiet === null) return audit(reopenFailure("invalid message clock"));
			if (!quiet) return deferredQuietWindow();

			if (deps.discordOwnerUserId) {
				await removeUserFn(input.threadId, deps.discordOwnerUserId, botToken, {
					fetchImpl: deps.fetchImpl,
				});
			}
			const archiveEpoch = new Date(nowMs()).toISOString();
			const commitAutomaticArchive = (
				result: ArchiveChatThreadResult,
			): ArchiveChatThreadResult => {
				store.commitThreadArchive(input.threadId, {
					event_id: `chat-thread-archived-fly2028-${input.threadId}-${archiveEpoch}`,
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
				return result;
			};
			store.setChatThreadCompensationPending(input.threadId, {
				version: 1,
				state: "prepared",
				archiveEpoch,
				frontier: frontier.messageId,
				cause: "unknown",
				at: archiveEpoch,
			});
			const patchResult = await archiveFn(input.threadId, botToken, {
				markDiscordMissing: (id) => store.markChatThreadMissing(id),
				fetchImpl: deps.fetchImpl,
			});
			if (!patchResult.archived) {
				const status = patchResult.status;
				const definitelyNotArchived =
					status === 401 ||
					status === 403 ||
					status === 404 ||
					(status !== undefined &&
						status >= 400 &&
						status < 500 &&
						status !== 400 &&
						status !== 429);
				if (definitelyNotArchived) {
					store.clearChatThreadCompensationPending(input.threadId);
					return audit(patchResult);
				}
				const current = await probeFn(input.threadId, botToken, displayDeps);
				if (!current.ok && current.status === 404) {
					store.markChatThreadMissing(input.threadId);
					store.clearChatThreadCompensationPending(input.threadId);
					return audit({ ...patchResult, status: 404, reason: "missing" });
				}
				if (current.ok && current.archived === false) {
					store.clearChatThreadCompensationPending(input.threadId);
					return audit(patchResult);
				}
				if (current.ok && current.archived === true) {
					if (status === 400) {
						const after = await frontierFn(
							input.threadId,
							botToken,
							displayDeps,
						);
						if (after.ok && after.messageId === frontier.messageId) {
							return commitAutomaticArchive({
								...patchResult,
								archived: true,
								reason: "already_archived",
							});
						}
						if (after.ok) {
							const compensated =
								await compensateKnownArchived("verify_failed");
							return store.getChatThreadCompensationPending(input.threadId)
								? audit(compensated)
								: deferredQuietWindow();
						}
					}
					return audit(await compensateKnownArchived("verify_failed"));
				}
				return audit(reopenFailure(current.ok ? undefined : current.error));
			}
			const [verification, after] = await Promise.all([
				probeFn(input.threadId, botToken, displayDeps),
				frontierFn(input.threadId, botToken, displayDeps),
			]);
			if (
				verification.ok &&
				verification.archived === true &&
				after.ok &&
				after.messageId === frontier.messageId
			) {
				return commitAutomaticArchive(patchResult);
			}
			if (verification.ok && verification.archived === false) {
				store.clearChatThreadCompensationPending(input.threadId);
				return deferredQuietWindow();
			}
			if (
				verification.ok &&
				verification.archived === true &&
				after.ok &&
				after.messageId !== frontier.messageId
			) {
				const compensated = await compensateKnownArchived("verify_failed");
				return store.getChatThreadCompensationPending(input.threadId)
					? audit(compensated)
					: deferredQuietWindow();
			}
			return audit(
				reopenFailure(
					verification.ok
						? after.ok
							? "archive verification failed"
							: after.error
						: verification.error,
				),
			);
		}

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

	try {
		return await runUnderThreadArchiveLock(input.threadId, run);
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
	}
}

// ── Central close→archive cascade ───────────────────────────────────────────

export interface CloseArchiveDeps
	extends Pick<ArchiveThreadDeps, "frontierFn" | "nowMs" | "probeFn"> {
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

		const result = await archiveThreadAndRecord(
			store,
			{
				threadId: thread.thread_id,
				issueId: session.issue_id,
				projectName: session.project_name,
				executionId: session.execution_id,
			},
			botToken,
			{
				authority: "none",
				archiveFn: deps.archiveFn,
				removeUserFn: deps.removeUserFn,
				discordOwnerUserId: deps.discordOwnerUserId,
				fetchImpl: deps.fetchImpl,
				frontierFn: deps.frontierFn,
				nowMs: deps.nowMs,
				probeFn: deps.probeFn,
			},
		);
		if (result.reason === "deferred_quiet_window") {
			console.info(
				`[done-thread-archiver] archive deferred for ${session.issue_id} (quiet window)`,
			);
		}
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
