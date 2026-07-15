/**
 * FLY-892 (Step 5): one-shot boot sweep that reconciles the LEGACY FLY-793
 * per-phase side-table threads. Post-converge (Step 1) nothing writes
 * `phase_chat_threads`, and thread resolution is single-thread-per-issue — so the
 * old design/implement/qa threads sit in the sidebar receiving nothing. This
 * sweep, mounted on Bridge boot (same shape as the FLY-172 marker drain / FLY-324
 * sweep — event-driven, NO new periodic timer), points each legacy phase thread
 * at the issue's main thread and archives it.
 *
 * FAIL-CLOSED (Codex R1 #1): NEVER archive a phase thread that is an issue's ONLY
 * visible Discord face. A legacy phase row with NO main thread is archived only
 * when the issue is genuinely finished — a DEDICATED active check
 * (`getActivePhaseSessionForIssue`, which deliberately protects
 * running/awaiting_review/design_done/pending+worktree), NOT a global
 * TERMINAL_STATUSES set. An active-but-no-main row is skipped (logged) — its main
 * thread will be created by a future `ensureChatThread` path, and the next boot
 * picks it up.
 *
 * Idempotent by construction: an archived row drops out of
 * `getUnarchivedPhaseChatThreads()`, so a second run is a no-op. Any Discord
 * failure leaves the row unarchived → retried next boot. Per-row try/catch — one
 * bad row never aborts the sweep.
 */

import type { ProjectEntry } from "../ProjectConfig.js";
import { resolveAnnouncerBotToken } from "../ProjectConfig.js";
import type { StateStore } from "../StateStore.js";
import { markAutomatedDiscordText } from "./automated-message.js";
import { archiveChatThread } from "./chat-thread-utils.js";
import { resolveBotTokenForThread } from "./done-thread-archiver.js";

const DISCORD_API = "https://discord.com/api/v10";
const POST_TIMEOUT_MS = 5_000;

export interface LegacyPhaseThreadSweepDeps {
	store: StateStore;
	projects: ProjectEntry[];
	/** Per-Lead-less global bot token, used as the token fallback. */
	globalBotToken?: string;
	/** Test seam for Discord HTTP. */
	fetchImpl?: typeof fetch;
	/** Test seam for the archive PATCH (defaults to the real archiveChatThread). */
	archiveFn?: typeof archiveChatThread;
}

export interface LegacyPhaseThreadSweepResult {
	processed: number;
	archived: number;
	skipped: number;
	failed: number;
}

/** POST the "merged into the main thread" pointer into the legacy phase thread. */
async function postPointerMessage(
	phaseThreadId: string,
	mainThreadId: string,
	botToken: string,
	fetchImpl: typeof fetch,
): Promise<boolean> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
	try {
		const res = await fetchImpl(
			`${DISCORD_API}/channels/${phaseThreadId}/messages`,
			{
				method: "POST",
				headers: {
					Authorization: `Bot ${botToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					content: markAutomatedDiscordText(
						`🔀 本 issue 的后续消息已归并到主 thread：<#${mainThreadId}>（一 issue = 一 thread）。`,
					),
					allowed_mentions: { parse: [] },
				}),
				signal: controller.signal,
			},
		);
		return res.ok;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

export async function reconcileLegacyPhaseThreads(
	deps: LegacyPhaseThreadSweepDeps,
): Promise<LegacyPhaseThreadSweepResult> {
	const {
		store,
		projects,
		globalBotToken,
		fetchImpl = fetch,
		archiveFn = archiveChatThread,
	} = deps;

	const rows = store.getUnarchivedPhaseChatThreads();
	const result: LegacyPhaseThreadSweepResult = {
		processed: rows.length,
		archived: 0,
		skipped: 0,
		failed: 0,
	};

	for (const row of rows) {
		try {
			// Resolve the issue's project/labels (to find the thread-owning Lead bot)
			// from any session on the issue — legacy phase rows always have one.
			const session = store.getSessionByIssue(row.issue_id);
			if (!session) {
				console.warn(
					`[FLY-892 sweep] no session for issue ${row.issue_id} — cannot resolve bot token; skip`,
				);
				result.skipped += 1;
				continue;
			}
			const labels = session.issue_labels
				? (JSON.parse(session.issue_labels) as string[])
				: [];
			const leadBotToken = resolveBotTokenForThread(projects, {
				projectName: session.project_name,
				leadId: row.lead_id,
				labels,
				fallbackBotToken: globalBotToken,
			});
			if (!leadBotToken) {
				console.warn(
					`[FLY-892 sweep] no bot token for issue ${row.issue_id} thread ${row.thread_id}; skip`,
				);
				result.skipped += 1;
				continue;
			}

			const mainThread = store.getChatThreadByIssue(
				row.issue_id,
				row.channel_id,
			);

			if (!mainThread) {
				// FAIL-CLOSED (Codex R1 #1): no main thread. If the issue still needs a
				// visible face (active phase session), this legacy thread is its ONLY
				// Discord surface — do NOT archive it; a later ensureChatThread builds
				// the main thread and the next boot merges it.
				if (store.getActivePhaseSessionForIssue(row.issue_id)) {
					console.log(
						`[FLY-892 sweep] skipped_no_main issue=${row.issue_id} thread=${row.thread_id} (still active, no main thread)`,
					);
					result.skipped += 1;
					continue;
				}
				// Terminal + no main thread — the issue is finished, archive it.
				const archived = await archiveFn(row.thread_id, leadBotToken, {
					fetchImpl,
					markDiscordMissing: (id) => store.markChatThreadMissing(id),
				});
				if (archived.archived) {
					store.markChatThreadArchived(row.thread_id);
					result.archived += 1;
				} else {
					result.failed += 1;
				}
				continue;
			}

			// Has a main thread → point the phase thread at it, then archive. The
			// pointer is a pure status broadcast → announcer bot when configured
			// (Step 7 route matrix); archive PATCH stays on the thread-owning Lead
			// bot (has Manage-Threads).
			const pointerToken =
				resolveAnnouncerBotToken(projects, session.project_name) ??
				leadBotToken;
			const posted = await postPointerMessage(
				row.thread_id,
				mainThread.thread_id,
				pointerToken,
				fetchImpl,
			);
			if (!posted) {
				// Leave unarchived → retried next boot (the founder should always get
				// the "moved to the main thread" pointer before the thread vanishes).
				result.failed += 1;
				continue;
			}
			const archived = await archiveFn(row.thread_id, leadBotToken, {
				fetchImpl,
				markDiscordMissing: (id) => store.markChatThreadMissing(id),
			});
			if (archived.archived) {
				store.markChatThreadArchived(row.thread_id);
				result.archived += 1;
			} else {
				result.failed += 1;
			}
		} catch (err) {
			console.error(
				`[FLY-892 sweep] row failed issue=${row.issue_id} thread=${row.thread_id}: ${(err as Error).message}`,
			);
			result.failed += 1;
		}
	}

	if (result.processed > 0) {
		console.log(
			`[FLY-892 sweep] legacy phase threads: processed=${result.processed} archived=${result.archived} skipped=${result.skipped} failed=${result.failed}`,
		);
	}
	return result;
}
