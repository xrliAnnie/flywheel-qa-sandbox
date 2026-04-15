/**
 * FLY-102: Runner ready-to-close notifier.
 *
 * Posts "🏁 Runner 完工可关闭" into the per-issue Discord chat thread (FLY-91)
 * after postMergeTmuxCleanup has finished. Signal to Lead: decide whether to
 * call MCP `close_runner` tool (default: confirm with Annie first).
 *
 * Callers: `runPostShipFinalization` (DES + event-route both route here).
 *
 * Atomic dedupe: uses a stable `event_id = runner-ready-to-close-${executionId}`
 * and relies on `StateStore.insertEvent` returning `false` on UNIQUE conflict.
 * The first caller wins the claim and posts; concurrent callers short-circuit.
 * No `findEvents` read-then-write — the UNIQUE constraint is the dedupe primitive.
 */

import { randomUUID } from "node:crypto";
import type { StateStore } from "../StateStore.js";

/**
 * Derived type — avoids adding a new StateStore export.
 * `getChatThreadByIssue` currently returns `{ thread_id, channel_id } | undefined`.
 */
export type ChatThreadRef = NonNullable<
	ReturnType<StateStore["getChatThreadByIssue"]>
>;

export interface ReadyToCloseOpts {
	executionId: string;
	issueId: string;
	issueIdentifier?: string;
	projectName: string;
	sessionStatus: string;
	tmuxClosed: boolean;
	errors?: string[];
	/** Pre-resolved by `runPostShipFinalization`. */
	thread?: ChatThreadRef;
	/** Pre-resolved (lead.botToken ?? config.discordBotToken). */
	botToken?: string;
}

export interface ReadyToCloseDeps {
	store: StateStore;
	/** Test seam for Discord HTTP. */
	fetchImpl?: typeof fetch;
}

const DISCORD_API = "https://discord.com/api/v10";

export async function emitRunnerReadyToCloseNotification(
	opts: ReadyToCloseOpts,
	deps: ReadyToCloseDeps,
): Promise<void> {
	const { store, fetchImpl = fetch } = deps;

	// ── (A) ATOMIC CLAIM ──
	// Stable event_id → UNIQUE constraint collapses concurrent callers to one winner.
	const claimId = `runner-ready-to-close-${opts.executionId}`;
	const claimed = store.insertEvent({
		event_id: claimId,
		execution_id: opts.executionId,
		issue_id: opts.issueId,
		project_name: opts.projectName,
		event_type: "runner_ready_to_close_claim",
		source: "bridge.ready-to-close-notifier",
		payload: { claimedAt: new Date().toISOString() },
	});
	if (!claimed) return;

	// ── (B) VALIDATE INPUTS ──
	const thread = opts.thread;
	if (!thread?.thread_id) {
		store.insertEvent({
			event_id: `runner-ready-to-close-skipped-${randomUUID()}`,
			execution_id: opts.executionId,
			issue_id: opts.issueId,
			project_name: opts.projectName,
			event_type: "runner_ready_to_close_skipped",
			source: "bridge.ready-to-close-notifier",
			payload: { reason: "no_chat_thread", claimId },
		});
		return;
	}
	if (!opts.botToken) {
		store.insertEvent({
			event_id: `runner-ready-to-close-skipped-${randomUUID()}`,
			execution_id: opts.executionId,
			issue_id: opts.issueId,
			project_name: opts.projectName,
			event_type: "runner_ready_to_close_skipped",
			source: "bridge.ready-to-close-notifier",
			payload: { reason: "no_bot_token", claimId },
		});
		return;
	}

	// ── (C) COMPOSE + POST ──
	const identifier = opts.issueIdentifier ?? opts.issueId;
	const errLine = opts.errors?.length
		? `\n- Cleanup errors: ${opts.errors.join("; ")}`
		: "";
	const tmuxLine = opts.tmuxClosed
		? "已由 postMergeTmuxCleanup 关闭"
		: "仍在（Lead 可用 close_runner 收尾）";
	const body = [
		`🏁 **Runner 完工可关闭** — ${identifier}`,
		"",
		`- Execution: \`${opts.executionId}\``,
		`- Session status: \`${opts.sessionStatus}\``,
		`- Tmux: ${tmuxLine}${errLine}`,
		"",
		"Lead：按规则决策（默认向 Annie 确认后再调 `close_runner`）。",
	].join("\n");

	try {
		const resp = await fetchImpl(
			`${DISCORD_API}/channels/${thread.thread_id}/messages`,
			{
				method: "POST",
				headers: {
					Authorization: `Bot ${opts.botToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ content: body }),
			},
		);
		if (!resp.ok) {
			const errText = await resp.text().catch(() => "");
			store.insertEvent({
				event_id: `runner-ready-to-close-failed-${randomUUID()}`,
				execution_id: opts.executionId,
				issue_id: opts.issueId,
				project_name: opts.projectName,
				event_type: "runner_ready_to_close_notify_failed",
				source: "bridge.ready-to-close-notifier",
				payload: {
					status: resp.status,
					body: errText.slice(0, 500),
					claimId,
				},
			});
			return;
		}
	} catch (err) {
		store.insertEvent({
			event_id: `runner-ready-to-close-failed-${randomUUID()}`,
			execution_id: opts.executionId,
			issue_id: opts.issueId,
			project_name: opts.projectName,
			event_type: "runner_ready_to_close_notify_failed",
			source: "bridge.ready-to-close-notifier",
			payload: { error: (err as Error).message, claimId },
		});
		return;
	}

	// ── (D) SUCCESS AUDIT ──
	store.insertEvent({
		event_id: `runner-ready-to-close-notified-${randomUUID()}`,
		execution_id: opts.executionId,
		issue_id: opts.issueId,
		project_name: opts.projectName,
		event_type: "runner_ready_to_close_notified",
		source: "bridge.ready-to-close-notifier",
		payload: {
			threadId: thread.thread_id,
			tmuxClosed: opts.tmuxClosed,
			claimId,
		},
	});
}
