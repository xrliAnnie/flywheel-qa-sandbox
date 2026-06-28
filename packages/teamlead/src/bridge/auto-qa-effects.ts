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
import type { LeadAlertNotifier } from "../LeadAlertNotifier.js";
import { type ProjectEntry, resolveLeadForIssue } from "../ProjectConfig.js";
import type { AutoQaRecord, Session, StateStore } from "../StateStore.js";
import type { AutoQaSideEffects, QaIssueRef } from "./auto-qa-coordinator.js";
import { commDbPathForProject } from "./commdb-path.js";
import { postDiscordMessageToChannel } from "./discord-utils.js";
import { buildSessionKey } from "./hook-payload.js";
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
	/** Lead-only alert sink for pipeline errors (alert channel). */
	leadAlertNotifier?: LeadAlertNotifier;
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
}

export class AutoQaEffects implements AutoQaSideEffects {
	constructor(private readonly deps: AutoQaEffectsDeps) {}

	private resolveThread(
		session: Session,
	): { threadId: string; botToken: string } | undefined {
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
			return { threadId: thread.thread_id, botToken };
		} catch {
			return undefined;
		}
	}

	async postThread(args: { session: Session; text: string }): Promise<void> {
		const t = this.resolveThread(args.session);
		if (!t) {
			console.warn(
				`[auto-qa-effects] no chat thread for ${args.session.issue_id} — skipping thread post`,
			);
			return;
		}
		const res = await postDiscordMessageToChannel(
			t.threadId,
			args.text,
			t.botToken,
			{},
			this.deps.fetchImpl ?? fetch,
		);
		if (!res.ok) {
			console.warn(
				`[auto-qa-effects] thread post failed for ${args.session.issue_id}: ${res.error}`,
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
		"Verify the pinned commit per the shipped qa-executor contract (real-machine E2E, read-only — do NOT modify source). Report the verdict via `flywheel-comm qa-result --target-exec <parent>` then `complete --route no_code`. This issue is the QA runner's own tracking issue; the change under test lives on the parent.",
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
