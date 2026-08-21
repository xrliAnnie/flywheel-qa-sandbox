/**
 * FLY-579 P2: concrete side-effects for the AutoQaCoordinator.
 *
 * Wires the coordinator's abstract effects to real Bridge primitives:
 *   - postThread / notifyShipReady → an in-thread Discord message on the
 *     issue's `[FLY-XX]` chat thread (NEVER the alert channel — alert ≠
 *     notification; FLY-523 revert lesson). The ship-ready notification (PASS)
 *     is the ONLY founder-facing emission in the whole flow.
 *   - feedbackWakeMain → a `feedback_wake` mailbox wake to the idle implementer
 *     runner, carrying the QA report (changes-requested loop, bound to the
 *     parent's review_question_id).
 *   - alertLeadPipelineError → a Lead-only `auto_qa_stuck` alert (the alert
 *     channel is for errors/exceptions only; the founder is never surfaced for
 *     a non-green QA).
 */

import { CommDB } from "flywheel-comm/db";
import { wakeRunnerMailbox } from "flywheel-comm/wake";
import { phaseMessageTag } from "flywheel-config";
import type { ApplyTransitionOpts } from "../applyTransition.js";
import type { AlertPayload, AlertResult } from "../LeadAlertNotifier.js";
import {
	type ProjectEntry,
	resolveAnnouncerBotToken,
	resolveLeadForIssue,
} from "../ProjectConfig.js";
import type { AutoQaRecord, Session, StateStore } from "../StateStore.js";
import type { AutoQaSideEffects, QaIssueRef } from "./auto-qa-coordinator.js";
import type { ChatThreadCreator } from "./ChatThreadCreator.js";
import { closeRunner } from "./close-runner.js";
import { queueCodexCodeReviewInstructionResult } from "./codex-instruction.js";
import { commDbPathForProject } from "./commdb-path.js";
import type { CompleteMarkerHeldAlert } from "./complete-marker-reconciler.js";
import {
	editDiscordMessageInChannel,
	postDiscordMessageToChannel,
} from "./discord-utils.js";
import { buildSessionKey } from "./hook-payload.js";
import type { MergedGateGuard } from "./merged-gate-guard.js";
import { EXECUTOR_TO_TRANSPORT } from "./role-adapter-resolver.js";
import { sessionModelDisplay } from "./runner-model-display.js";
import { sendRunnerWake } from "./runner-wake.js";
import type { BridgeConfig } from "./types.js";

/**
 * FLY-643: minimal structural view of the `@linear/sdk` surface the QA-issue
 * creation needs. Kept local + injectable so the effect is unit-testable with a
 * fake client (no network). The SDK returns `LinearFetch<T>` (= Promise<T>);
 * `await` handles both a Promise and a plain value, so the fakes can be sync.
 */
export interface LinearClientLike {
	issue(id: string): Promise<LinearIssueLike> | LinearIssueLike;
	createIssue(input: {
		teamId: string;
		title: string;
		description?: string;
		labelIds?: string[];
		projectId?: string;
	}): Promise<LinearIssuePayloadLike> | LinearIssuePayloadLike;
}
export interface LinearIssueLike {
	identifier?: string;
	title?: string;
	url?: string;
	team?: Promise<{ id: string } | undefined> | { id: string } | undefined;
	project?: Promise<{ id: string } | undefined> | { id: string } | undefined;
	labels(): Promise<{ nodes: { id: string }[] }> | { nodes: { id: string }[] };
}
export interface LinearIssuePayloadLike {
	issue?:
		| Promise<{ id?: string; identifier?: string; url?: string } | undefined>
		| { id?: string; identifier?: string; url?: string }
		| undefined;
}

export interface AutoQaEffectsDeps {
	store: StateStore;
	projects: ProjectEntry[];
	config: BridgeConfig;
	/** Lead-only alert sink for pipeline errors (alert channel). FLY-927: widened
	 * to the minimal sink face so plugin.ts can inject the ROUTED sink shim. */
	leadAlertNotifier?: { alert: (p: AlertPayload) => Promise<AlertResult> };
	/**
	 * FLY-630 ②: drives the PARENT issue thread's stage badge during the QA phase.
	 * Undefined when the chat-thread feature is off → `stampIssueStage` no-ops.
	 */
	chatThreadCreator?: ChatThreadCreator;
	/** Test seam for Discord HTTP. */
	fetchImpl?: typeof fetch;
	/** Test seam for the alert eventId salt (defaults to Date.now). */
	now?: () => number;
	/**
	 * FLY-643: test seam for the Linear client used by `createQaIssue`. Defaults
	 * to a real `@linear/sdk` client built from `config.linearApiKey` (lazy
	 * import). Returns undefined when no API key is configured → createQaIssue
	 * fails closed.
	 */
	linearClientFactory?: (apiKey: string) => LinearClientLike;
	/**
	 * FLY-752: FSM transition opts, required by `closeQaRunner` so a still-`running`
	 * (idle/parked) QA runner is finalized to `completed` before close (archive is
	 * completed-gated). Wired in plugin.ts (same value close-runner endpoint uses).
	 */
	transitionOpts?: ApplyTransitionOpts;
	/** FLY-752: per-Lead-less global bot token, for the closeQaRunner archive cascade. */
	globalBotToken?: string;
	/** FLY-752: test seam for the mailbox wake used by `retestWakeQa`. */
	wakeImpl?: typeof wakeRunnerMailbox;
	/** FLY-752: test seam for closeRunner (defaults to the real primitive). */
	closeRunnerImpl?: typeof closeRunner;
	/** FLY-1238: shared last-mile guard for the ship-gate rebound anchor. */
	mergedGateGuard?: MergedGateGuard;
}

function durableAlertAccepted(result: AlertResult): boolean {
	if (result.deadLettered) return false;
	return Boolean(
		result.sent ||
			result.queued ||
			result.dmSent ||
			result.skipped === "duplicate",
	);
}

export class AutoQaEffects implements AutoQaSideEffects {
	constructor(private readonly deps: AutoQaEffectsDeps) {}

	private resolveThread(
		session: Session,
	): { threadId: string; botToken: string; channel: string } | undefined {
		try {
			const { lead } = resolveLeadForIssue(
				this.deps.projects,
				session.project_name,
				parseLabels(session.issue_labels),
			);
			const channel = lead.chatChannel;
			const botToken = lead.botToken ?? this.deps.config.discordBotToken;
			if (!channel || !botToken) return undefined;
			const thread = this.deps.store.getChatThreadByIssue(
				session.issue_id,
				channel,
			);
			if (!thread) return undefined;
			return { threadId: thread.thread_id, botToken, channel };
		} catch {
			return undefined;
		}
	}

	async postThread(args: { session: Session; text: string }): Promise<void> {
		// FLY-1099 §3.3: void face delegates to the result-bearing variant — one
		// implementation, two signatures (existing call sites unchanged).
		await this.postThreadResult(args);
	}

	/**
	 * FLY-1099 §3.3 (Codex R1 #4): result-bearing thread post — the ledger
	 * drain needs a real outcome (delivered vs retry), not fire-and-forget.
	 */
	async postThreadResult(args: {
		session: Session;
		text: string;
	}): Promise<{ ok: boolean; messageId?: string }> {
		const t = this.resolveThread(args.session);
		if (!t) {
			console.warn(
				`[auto-qa-effects] no chat thread for ${args.session.issue_id} — skipping thread post`,
			);
			return { ok: false };
		}
		// FLY-892 (Step 3): this is the CENTRAL auto-QA issue-thread post seam (the
		// DAG workflow orchestrator posts through it too). Tag which phase is
		// speaking in the single converged thread. A standalone auto-QA session (on
		// its own QA issue, not a DAG workflow) has chat_thread_role='main' →
		// "" → byte-unchanged.
		const prefix = phaseMessageTag(
			args.session.chat_thread_role,
			args.session.runner_model,
			args.session.design_backend,
		);
		// FLY-892 (Step 7): a QA status broadcast → announcer bot when configured;
		// else the Lead bot (byte-compat).
		const broadcastToken =
			resolveAnnouncerBotToken(this.deps.projects, args.session.project_name) ??
			t.botToken;
		const res = await postDiscordMessageToChannel(
			t.threadId,
			`${prefix}${args.text}`,
			broadcastToken,
			{ origin: "automation" },
			this.deps.fetchImpl ?? fetch,
		);
		if (!res.ok) {
			console.warn(
				`[auto-qa-effects] thread post failed for ${args.session.issue_id}: ${res.error}`,
			);
			return { ok: false };
		}
		return { ok: true, messageId: res.messageIds[0] };
	}

	/**
	 * FLY-887 (founder-visibility status line): post-or-edit the single
	 * 3-stage status line on the issue's main chat thread. No pin (unlike
	 * FLY-560's attach-pin) — the test-slot bots don't even have
	 * MANAGE_MESSAGES, and Annie only asked for an updatable line, not a
	 * pinned one. Zero churn: skips the PATCH entirely when the text hasn't
	 * changed since the last refresh. A stale/deleted message (404) triggers
	 * exactly one repost. Never throws — a Discord hiccup here must never
	 * break a real handoff/verdict.
	 */
	async refreshPhaseStatusLine(args: {
		session: Session;
		text: string;
	}): Promise<void> {
		const t = this.resolveThread(args.session);
		if (!t) return; // no chat thread configured — nothing to update
		if (this.deps.store.getChatThreadArchivedAt(t.threadId)) return;
		const issueId = args.session.issue_id;
		const existing = this.deps.store.getPhaseStatusLine(issueId, t.channel);
		if (existing?.text === args.text) return; // no-op, zero churn
		if (existing?.messageId) {
			const edit = await editDiscordMessageInChannel(
				t.threadId,
				existing.messageId,
				args.text,
				t.botToken,
				{ origin: "automation" },
				this.deps.fetchImpl ?? fetch,
			);
			if (edit.ok) {
				this.deps.store.setPhaseStatusLine(
					issueId,
					t.channel,
					existing.messageId,
					args.text,
				);
				return;
			}
			if (edit.status !== 404) {
				console.warn(
					`[auto-qa-effects] phase-status-line edit failed for ${issueId}: ${edit.error}`,
				);
				return; // transient — leave the stale record, next refresh retries
			}
			this.deps.store.clearPhaseStatusLine(issueId, t.channel);
			// fall through to repost fresh
		}
		const post = await postDiscordMessageToChannel(
			t.threadId,
			args.text,
			t.botToken,
			{ origin: "automation" },
			this.deps.fetchImpl ?? fetch,
		);
		if (post.ok && post.messageIds[0]) {
			this.deps.store.setPhaseStatusLine(
				issueId,
				t.channel,
				post.messageIds[0],
				args.text,
			);
		} else if (!post.ok) {
			console.warn(
				`[auto-qa-effects] phase-status-line post failed for ${issueId}: ${post.error}`,
			);
		}
	}

	/**
	 * FLY-643: create the separate `QA·FLY-XX` Linear issue the auto-QA runner
	 * runs on, mirroring the PARENT issue's team / project / labels (read straight
	 * from the parent Linear issue — production projects.json carries no `linear`
	 * binding, so we never rely on one). Returns undefined on any failure so the
	 * coordinator fails closed (record stuck + Lead alert; founder NOT surfaced).
	 */
	async createQaIssue(args: {
		parent: Session;
		prHeadSha: string;
	}): Promise<QaIssueRef | undefined> {
		const apiKey = this.deps.config.linearApiKey;
		if (!apiKey) {
			console.warn(
				"[auto-qa-effects] createQaIssue: no LINEAR_API_KEY — cannot create QA issue",
			);
			return undefined;
		}
		try {
			const client = this.deps.linearClientFactory
				? this.deps.linearClientFactory(apiKey)
				: await defaultLinearClient(apiKey);
			const parentIssue = await client.issue(args.parent.issue_id);
			const team = await parentIssue.team;
			if (!team?.id) {
				console.warn(
					`[auto-qa-effects] createQaIssue: parent ${args.parent.issue_id} has no team — cannot create QA issue`,
				);
				return undefined;
			}
			const project = await parentIssue.project;
			const labelConn = await parentIssue.labels();
			const labelIds = (labelConn?.nodes ?? [])
				.map((l) => l.id)
				.filter((id): id is string => typeof id === "string");

			const { title, description } = buildQaIssueContent({
				parentIdentifier:
					args.parent.issue_identifier ?? parentIssue.identifier,
				parentTitle: args.parent.issue_title ?? parentIssue.title,
				parentUrl: args.parent.issue_url ?? parentIssue.url,
				prNumber: args.parent.pr_number,
				prHeadSha: args.prHeadSha,
			});

			const payload = await client.createIssue({
				teamId: team.id,
				title,
				description,
				...(labelIds.length > 0 && { labelIds }),
				...(project?.id && { projectId: project.id }),
			});
			const created = await payload.issue;
			if (!created?.id) {
				console.warn(
					"[auto-qa-effects] createQaIssue: Linear returned no created issue",
				);
				return undefined;
			}
			return {
				issueId: created.id,
				issueIdentifier: created.identifier,
				issueTitle: title,
				issueUrl: created.url,
			};
		} catch (err) {
			console.warn(
				`[auto-qa-effects] createQaIssue failed for ${args.parent.issue_id}: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
			return undefined;
		}
	}

	async notifyShipReady(args: {
		session: Session;
		record: AutoQaRecord;
	}): Promise<void> {
		// FLY-523 fold: in-thread founder ship-ready notification. NEVER the alert
		// channel. This fires ONLY after QA is green — the founder's first signal
		// that the change is ready for the approve gate.
		const id = args.session.issue_identifier ?? args.session.issue_id;
		const prNote = args.session.pr_number
			? ` (PR #${args.session.pr_number})`
			: "";
		await this.postThread({
			session: args.session,
			text: `✅ ${id}${prNote} — 实现 + code review + 独立 QA 全过,可以 ship 了。等你批准。`,
		});
	}

	/**
	 * FLY-945 Fix B: the ship-gate rebind follow-up. Posted with the LEAD bot
	 * (the same identity that posts gate messages — the founder's ✅ target),
	 * NOT the announcer broadcast token. Returns the created message id +
	 * thread id so the coordinator anchors the new `(question, head)` binding
	 * on it; `{ok:false}` on any miss (no thread / post failure) so the
	 * coordinator records the durable retry marker instead of a bad anchor.
	 */
	async notifyShipGateRebound(args: {
		session: Session;
		oldSha: string;
		newSha: string;
	}): Promise<{ ok: boolean; messageId?: string; threadId?: string }> {
		const t = this.resolveThread(args.session);
		if (!t) {
			console.warn(
				`[auto-qa-effects] no chat thread for ${args.session.issue_id} — ship-gate rebind follow-up skipped`,
			);
			return { ok: false };
		}
		if (this.deps.mergedGateGuard) {
			const project = this.deps.projects.find(
				(candidate) => candidate.projectName === args.session.project_name,
			);
			const guarded = await this.deps.mergedGateGuard({
				executionId: args.session.execution_id,
				issueId: args.session.issue_id,
				questionId: args.session.review_question_id ?? "",
				projectName: args.session.project_name,
				projectRoot: project?.projectRoot,
				prNumber: args.session.pr_number ?? undefined,
				source: "rebound",
			});
			if (guarded.kind !== "continue") return { ok: false };
		}
		const text =
			`⚠️ gate 更新:PR head \`${args.oldSha.slice(0, 8)}\` → \`${args.newSha.slice(0, 8)}\`` +
			"(QA 证据 commit,QA PASS)。你的批准将绑定新 head——在这条消息上 ✅ 或直接回复批准即可。";
		const res = await postDiscordMessageToChannel(
			t.threadId,
			text,
			t.botToken,
			{ origin: "automation" },
			this.deps.fetchImpl ?? fetch,
		);
		if (!res.ok || res.messageIds.length === 0) {
			console.warn(
				`[auto-qa-effects] ship-gate rebind follow-up post failed for ${args.session.issue_id}: ${res.ok ? "no message id" : res.error}`,
			);
			return { ok: false };
		}
		return { ok: true, messageId: res.messageIds[0], threadId: t.threadId };
	}

	async feedbackWakeMain(args: {
		session: Session;
		summary: string;
	}): Promise<void> {
		const db = new CommDB(
			commDbPathForProject(args.session.project_name),
			false,
		);
		try {
			await sendRunnerWake(
				this.deps.store,
				db,
				args.session.execution_id,
				args.session,
				"feedback_wake",
				{
					questionId: args.session.review_question_id,
					feedbackText: `自动 QA 未通过 — 请按报告修复后重新 push + re-request review:\n${args.summary}`,
				},
			);
		} finally {
			db.close();
		}
	}

	async alertLeadPipelineError(args: {
		session?: Session;
		issueId: string;
		projectName: string;
		reason: string;
	}): Promise<void> {
		if (!this.deps.leadAlertNotifier) {
			console.error(
				`[auto-qa-effects] pipeline error (no alert sink): ${args.reason}`,
			);
			return;
		}
		let leadId: string | undefined;
		try {
			const { lead } = resolveLeadForIssue(
				this.deps.projects,
				args.projectName,
				args.session ? parseLabels(args.session.issue_labels) : [],
			);
			leadId = lead.agentId;
		} catch {
			/* leadId stays undefined */
		}
		if (!leadId) {
			console.error(
				`[auto-qa-effects] pipeline error (no lead): ${args.reason}`,
			);
			return;
		}
		const now = this.deps.now?.() ?? Date.now();
		await this.deps.leadAlertNotifier.alert({
			leadId,
			projectName: args.projectName,
			eventId: `auto-qa-stuck:${args.session?.execution_id ?? args.issueId}:${now}`,
			eventType: "auto_qa_stuck",
			title: `Auto-QA pipeline stuck — ${args.session?.issue_identifier ?? args.issueId}`,
			body: args.reason,
			severity: "warning",
			sessionKey: args.session ? buildSessionKey(args.session) : undefined,
		});
	}

	/** FLY-1505: severe Lead-only alert, deduped per approval binding + head. */
	async alertShipAttemptFailed(args: {
		session: Session;
		reason: string;
	}): Promise<void> {
		if (!this.deps.leadAlertNotifier) {
			console.error(
				`[auto-qa-effects] ship attempt failed (no alert sink): ${args.reason}`,
			);
			throw new Error("ship attempt failed: no alert sink");
		}
		let leadId: string | undefined;
		try {
			const { lead } = resolveLeadForIssue(
				this.deps.projects,
				args.session.project_name,
				parseLabels(args.session.issue_labels),
			);
			leadId = lead.agentId;
		} catch {
			/* leadId stays undefined */
		}
		if (!leadId) {
			console.error(
				`[auto-qa-effects] ship attempt failed (no lead): ${args.session.issue_id}`,
			);
			throw new Error("ship attempt failed: no lead");
		}
		const binding = args.session.review_question_id ?? "unbound";
		const head = args.session.pr_head_sha?.toLowerCase() ?? "unknown";
		const result = await this.deps.leadAlertNotifier.alert({
			leadId,
			projectName: args.session.project_name,
			eventId: `ship-attempt-failed:${args.session.execution_id}:${binding}:${head}`,
			eventType: "ship_attempt_failed",
			title: `Founder-approved ship attempt failed — ${args.session.issue_identifier ?? args.session.issue_id}`,
			body: args.reason,
			severity: "severe",
			sessionKey: buildSessionKey(args.session),
		});
		if (!durableAlertAccepted(result)) {
			throw new Error(
				`ship attempt alert not accepted: ${JSON.stringify(result)}`,
			);
		}
	}

	/** FLY-1912: severe Lead-only marker hold, deduped by the ledger event id. */
	async alertCompleteMarkerHeld(args: CompleteMarkerHeldAlert): Promise<void> {
		if (!this.deps.leadAlertNotifier) {
			throw new Error("complete-marker alert: no alert sink");
		}
		let leadId: string | undefined;
		try {
			leadId = resolveLeadForIssue(
				this.deps.projects,
				args.projectName,
				args.session ? parseLabels(args.session.issue_labels) : [],
			).lead.agentId;
		} catch {
			// Fail closed below: the ledger remains pending for a later retry.
		}
		if (!leadId) throw new Error("complete-marker alert: no lead");
		const result = await this.deps.leadAlertNotifier.alert({
			leadId,
			projectName: args.projectName,
			eventId: args.eventId,
			eventType: "complete_marker_held",
			title:
				args.kind === "engine_invariant"
					? `Workflow completion held — ${args.session?.issue_identifier ?? args.issueId}`
					: `Workflow completion replay degraded — ${args.session?.issue_identifier ?? args.issueId}`,
			body: args.reason,
			severity: "severe",
			sessionKey: args.session ? buildSessionKey(args.session) : undefined,
		});
		if (!durableAlertAccepted(result)) {
			throw new Error(
				`complete-marker alert not accepted: ${JSON.stringify(result)}`,
			);
		}
	}

	/**
	 * FLY-827: re-queue the `/codex-code-review` instruction to a Codex-held runner
	 * (D3 loop closure — don't just block, tell the runner to go run Codex).
	 * FLY-1099 §3.3: result-bearing — DB failures surface as `{queued:false}` so
	 * ledger-driven callers can retry; the coordinator's legacy call site still
	 * treats it best-effort.
	 */
	queueCodexInstruction(args: {
		session: Session;
	}): ReturnType<typeof queueCodexCodeReviewInstructionResult> {
		return queueCodexCodeReviewInstructionResult(
			args.session.project_name,
			args.session.execution_id,
		);
	}

	/**
	 * FLY-827: a Lead-only Flywheel Alert that a session is blocked on the Codex
	 * code-review hard gate (founder NOT surfaced). eventId is keyed to (exec, head)
	 * with NO timestamp so the alert claims-db dedup fires it once. The retained
	 * caller is the missing-PR-head fail-closed path.
	 */
	async alertCodexGateBlocked(args: {
		session: Session;
		sha?: string;
	}): Promise<void> {
		const sha = args.sha?.toLowerCase();
		if (!this.deps.leadAlertNotifier) {
			console.error(
				`[auto-qa-effects] codex gate blocked (no alert sink): ${args.session.issue_id} @ ${sha?.slice(0, 8) ?? "no-head"}`,
			);
			return;
		}
		let leadId: string | undefined;
		try {
			const { lead } = resolveLeadForIssue(
				this.deps.projects,
				args.session.project_name,
				parseLabels(args.session.issue_labels),
			);
			leadId = lead.agentId;
		} catch {
			/* leadId stays undefined */
		}
		if (!leadId) {
			console.error(
				`[auto-qa-effects] codex gate blocked (no lead): ${args.session.issue_id}`,
			);
			return;
		}
		const title = `Codex code review blocked — ${args.session.issue_identifier ?? args.session.issue_id}`;
		// R3-LOW-3: missing-head variant — no head to review; ask for a re-complete.
		const eventId = sha
			? `codex-gate:${args.session.execution_id}:${sha}`
			: `codex-gate-missing-head:${args.session.execution_id}`;
		const body = sha
			? `PR head \`${sha.slice(0, 8)}\` does not have a Codex APPROVED — auto-QA blocked, merge blocked, founder held.`
			: `Session reached awaiting_review with NO valid PR head binding — the Codex hard gate is holding the founder but a head-specific review cannot run. Ask the runner to re-run \`complete --route needs_review --pr-head <sha> --question-id <id>\` with a valid head.`;
		await this.deps.leadAlertNotifier.alert({
			leadId,
			projectName: args.session.project_name,
			eventId,
			eventType: "codex_gate_blocked",
			title,
			body,
			severity: "warning",
			sessionKey: buildSessionKey(args.session),
		});
	}

	/**
	 * FLY-630 ②: stamp the PARENT issue's `[FLY-XX]` thread badge for the QA phase.
	 * Mirrors event-route's `stampStageEmojiForSession` (resolve lead → channel +
	 * bot token → existing thread → delegate to ChatThreadCreator.stampStageEmoji),
	 * so it routes through the SAME per-thread coalescing writer as runner-driven
	 * stage stamps (no race, latest wins). Gated by the SAME feature flags so the
	 * default-off byte-compat path changes nothing; fire-and-forget + best-effort,
	 * never throws into the QA lifecycle.
	 *
	 * FLY-630 (Codex R1 HIGH): the stamp is FIRE-AND-FORGET — we do NOT await the
	 * ChatThreadCreator drain. That drain can now sleep through a 429 Retry-After
	 * (up to ~10 min). The coordinator awaits this method, and `/events` /
	 * DirectEventSink await the coordinator, so awaiting the drain would block the
	 * QA lifecycle (and the runner's event response) for minutes under Discord
	 * rename rate limits. The synchronous lead/thread resolution runs inline; only
	 * the network drain is detached (mirrors event-route's stampStageEmojiForSession).
	 */
	stampIssueStage(args: { session: Session; stage: string }): void {
		// Respect the same kill switch as the runner-driven stamp path (event-route).
		const creator = this.deps.chatThreadCreator;
		if (!creator) return; // chat-thread feature off → nothing to stamp

		let chatChannel: string | undefined;
		let botToken: string | undefined;
		let leadId: string | undefined;
		try {
			const { lead } = resolveLeadForIssue(
				this.deps.projects,
				args.session.project_name,
				parseLabels(args.session.issue_labels),
			);
			chatChannel = lead.chatChannel;
			botToken = lead.botToken ?? this.deps.config.discordBotToken;
			leadId = lead.agentId;
		} catch {
			return; // project/lead not resolvable — skip
		}
		if (!chatChannel || !botToken) return;

		const thread = this.deps.store.getChatThreadByIssue(
			args.session.issue_id,
			chatChannel,
		);
		if (!thread) return; // thread not created yet — best-effort, skip

		// Fire-and-forget: kick off the (possibly minutes-long, 429-retrying) drain
		// without awaiting it. The call itself enqueues synchronously.
		void creator
			.stampStageEmoji(
				{
					chatChannelId: chatChannel,
					issueId: args.session.issue_id,
					issueIdentifier: args.session.issue_identifier,
					issueTitle: args.session.issue_title,
					botToken,
					leadId,
					// FLY-1255: carry the resolved parent model marker. `?? null`
					// authoritatively clears stale title state.
					modelMarker: sessionModelDisplay(args.session)?.threadMarker ?? null,
				},
				thread.thread_id,
				args.stage,
				true,
			)
			.catch((err: unknown) => {
				console.warn(
					`[auto-qa-effects] stampIssueStage failed for ${args.session.issue_id}: ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
			});
	}

	/**
	 * FLY-752: FAIL-LOUD re-test wake. Resolve the QA session's transport from its
	 * `adapter_type`; a no-transport QA (should be impossible — spawn forces a
	 * mailbox-capable lane) returns `{ ok:false }` so the coordinator holds the
	 * founder + keeps the durable retest marker. Clear the QA's `declare-state park`
	 * marker so idle accounting resumes, then mailbox-wake it with the new head.
	 */
	async retestWakeQa(args: {
		qaSession: Session;
		parentSession: Session;
		newSha: string;
	}): Promise<{ ok: boolean; error?: string }> {
		const adapter = args.qaSession.adapter_type;
		const transport =
			adapter && Object.hasOwn(EXECUTOR_TO_TRANSPORT, adapter)
				? EXECUTOR_TO_TRANSPORT[adapter as keyof typeof EXECUTOR_TO_TRANSPORT]
				: "claude-code"; // legacy/absent adapter → default Claude lane.
		if (transport === "none") {
			return {
				ok: false,
				error: `no-transport QA backend (${adapter}) cannot receive retest_wake`,
			};
		}
		const wake = this.deps.wakeImpl ?? wakeRunnerMailbox;
		// create-if-missing: clearDeclaredState is a no-op when the QA never parked,
		// and the wake must still proceed — never throw just because comm.db is absent.
		const db = new CommDB(commDbPathForProject(args.qaSession.project_name));
		try {
			// Clear the QA's self-declared `park` marker so idle accounting resumes
			// and treats the QA as active again once it re-tests.
			try {
				db.clearDeclaredState(args.qaSession.execution_id);
			} catch (err) {
				console.warn(
					`[auto-qa-effects] clearDeclaredState warn for ${args.qaSession.execution_id}: ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
			}
			const parentRef =
				args.parentSession.issue_identifier ?? args.parentSession.issue_id;
			const content =
				`Auto-QA RE-TEST: the PR you are verifying (${parentRef}) has a NEW reviewed head ` +
				`${args.newSha}. Re-fetch + re-pin your worktree to it, re-run your QA scenarios, then emit ` +
				`flywheel-comm qa-result --status pass|fail --target-exec ${args.parentSession.execution_id} again. ` +
				`Same QA session — do NOT complete; on FAIL park again and wait for the next retest.`;
			const res = await wake({
				db,
				execId: args.qaSession.execution_id,
				fromAgent: "bridge",
				content,
				metadata: {
					kind: "retest_wake",
					newSha: args.newSha,
					parentExec: args.parentSession.execution_id,
				},
				backend: transport,
			});
			if (res.ok) return { ok: true };
			// FLY-752 (Codex code R1 #2): unlike sendRunnerWake — whose caller has a
			// PostToolUse hook that injects the CommDB row in rollback mode — this
			// primitive delivers the wake itself. A `backend_commdb` skip therefore
			// means NOTHING was delivered, so it MUST fail-loud (keep the durable
			// retest marker + alert), never report success (which would clear the
			// marker and strand the founder gate with no retry).
			return {
				ok: false,
				error: res.error ?? res.skippedReason ?? "wake failed",
			};
		} catch (err) {
			return {
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			};
		} finally {
			db.close();
		}
	}

	/**
	 * FLY-752: close a QA runner at a terminal QA outcome (PASS / supersede). Uses
	 * `closeRunner({ finalizeDone: true })` so a still-`running` (idle/parked) QA is
	 * FSM-transitioned to `completed` first (archive is completed-gated), then its
	 * cmux workspace + tmux window + Terminal tab are killed, its Discord thread is
	 * archived (FLY-369), and its CommDB row dropped. Best-effort — a failure is
	 * logged, never thrown into the QA lifecycle (reconcile re-drives it).
	 */
	async closeQaRunner(args: {
		qaSession: Session;
		reason?: string;
	}): Promise<void> {
		const close = this.deps.closeRunnerImpl ?? closeRunner;
		try {
			const result = await close(
				{
					executionId: args.qaSession.execution_id,
					issueId: args.qaSession.issue_id,
					projectName: args.qaSession.project_name,
					reason: args.reason ?? "auto-QA terminal cleanup",
					executorType: "qa",
					finalizeDone: true,
					transitionOpts: this.deps.transitionOpts,
					archive: {
						projects: this.deps.projects,
						globalBotToken: this.deps.globalBotToken,
						discordOwnerUserId: this.deps.config.discordOwnerUserId,
					},
				},
				this.deps.store,
			);
			if (!result.closed) {
				console.warn(
					`[auto-qa-effects] closeQaRunner did not close ${args.qaSession.execution_id}: ${result.error ?? "unknown"} (reconcile will retry)`,
				);
			}
		} catch (err) {
			console.warn(
				`[auto-qa-effects] closeQaRunner threw for ${args.qaSession.execution_id}: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}
}

function parseLabels(raw: string | undefined): string[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed)
			? parsed.filter((x): x is string => typeof x === "string")
			: [];
	} catch {
		return [];
	}
}

/**
 * FLY-643: pure builder for the separate QA issue's title + description.
 * Extracted so the content shape is unit-testable without the Linear client.
 */
export function buildQaIssueContent(args: {
	parentIdentifier?: string;
	parentTitle?: string;
	parentUrl?: string;
	prNumber?: number;
	prHeadSha: string;
}): { title: string; description: string } {
	const ident = args.parentIdentifier ?? "(unknown)";
	const parentTitle = (args.parentTitle ?? "").trim();
	const titleSuffix = parentTitle ? ` — ${truncate(parentTitle, 160)}` : "";
	const title = `QA · ${ident}${titleSuffix}`;
	const lines = [
		`Independent auto-QA (Flywheel FLY-579 pipeline) of **${ident}**.`,
		"",
		`- Parent issue: ${args.parentUrl ?? ident}`,
		...(args.prNumber ? [`- PR: #${args.prNumber}`] : []),
		`- Reviewed commit (pinned): \`${args.prHeadSha}\``,
		"",
		"Verify the pinned commit per the shipped qa-executor contract (real-machine E2E, read-only — do NOT modify source). Report the verdict via `flywheel-comm qa-result --status pass|fail --target-exec <parent>`. FLY-752 fix-loop reuse: on PASS release heavy resources (close Claude-in-Chrome tabs) and STOP — do NOT `complete`, the pipeline finalizes + cleans you up; on FAIL release resources, `flywheel-comm declare-state park`, and WAIT to be re-woken with the next head, then re-test with THIS SAME session. This issue is the QA runner's own tracking issue; the change under test lives on the parent.",
	];
	return { title, description: lines.join("\n") };
}

async function defaultLinearClient(apiKey: string): Promise<LinearClientLike> {
	const { LinearClient } = await import("@linear/sdk");
	return new LinearClient({ apiKey }) as unknown as LinearClientLike;
}

function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max)}…` : s;
}
