import { createHash } from "node:crypto";
import type {
	AgendaClass,
	AgendaItem,
	AgendaSnapshot,
	AgendaSourceStatus,
} from "flywheel-voice-core";
import type { LeadConfig, ProjectEntry } from "../ProjectConfig.js";
import type { StateStore } from "../StateStore.js";
import { founderAttentionLevel } from "./founder-attention.js";
import {
	attentionFactMatchesIssue,
	type FounderAttentionFactsDeps,
	readFounderAttentionFacts,
} from "./founder-attention-facts.js";
import type { HeadphoneInboxStore } from "./headphone-inbox.js";
import { readIssueTitleState } from "./issue-title-state.js";
import {
	DEFAULT_LEAD_SAID_LOOKBACK_MS,
	type VoiceAgendaStore,
} from "./voice-agenda-store.js";

/** Plan §2.1 R1-6: only a source read this recently may prove an absence. */
export const DEFAULT_AGENDA_SOURCE_FRESHNESS_MS = 60_000;
const MAX_SOURCE_TEXT = 4_000;
const LINEAR_PRIORITY_URGENT = 1;

export interface VoiceAgendaSession {
	sessionId: string;
	mode: "rg" | "meeting";
	projectName: string;
	leadId: string;
	founderUserId: string;
}

export interface VoiceAgendaSourceDeps {
	store: Pick<
		StateStore,
		| "getSessionByIssue"
		| "getLatestFounderAskForIssue"
		| "getActiveWorkflowRunForIssue"
	> &
		FounderAttentionFactsDeps["stateStore"] &
		Parameters<typeof readIssueTitleState>[0]["store"];
	agenda: VoiceAgendaStore;
	inbox: Pick<HeadphoneInboxStore, "getSourceState">;
	projects: readonly ProjectEntry[];
	guildId?: string;
	openAttentionCommReadonly?: FounderAttentionFactsDeps["openCommReadonly"];
	/** Cached Linear priority (1 = Urgent) for U2; null when unknown. */
	issuePriority?(issueId: string): number | null;
	/** Invoked with blocked issue ids so an async cache can learn priorities. */
	observeBlockedIssues?(issueIds: readonly string[]): void;
	readTitle?: typeof readIssueTitleState;
	/** A Lead's own bot id; U1 counts only from the channel owner's bot. */
	leadBotUserId?(lead: LeadConfig): string | undefined;
	now(): Date;
	lookbackMs?: number;
	freshnessMs?: number;
}

/** Spoken fallback name: the registry has agent ids only. */
export function spokenLeadName(lead: Pick<LeadConfig, "agentId">): string {
	return lead.agentId.replace(/-lead$/u, "").replaceAll("-", " ");
}

interface ScopedLead {
	project: ProjectEntry;
	lead: LeadConfig;
}

function scopedLeads(
	projects: readonly ProjectEntry[],
	session: VoiceAgendaSession,
): ScopedLead[] {
	const leads: ScopedLead[] = [];
	for (const project of projects)
		for (const lead of project.leads) {
			if (!lead.chatChannel) continue;
			if (
				session.mode === "meeting" &&
				(project.projectName !== session.projectName ||
					lead.agentId !== session.leadId)
			)
				continue;
			leads.push({ project, lead });
		}
	return leads;
}

function titleClass(titleState: {
	badge: { kind: string };
	founderGateAttention: boolean;
}): Exclude<AgendaClass, "lead_said"> | null {
	// Same precedence as the thread title (issue-display-refresher).
	if (titleState.badge.kind === "blocked") return "blocked";
	if (titleState.founderGateAttention) return "awaiting_approval";
	if (titleState.badge.kind === "needs_answer") return "needs_answer";
	return null;
}

const KEY_PREFIX: Record<Exclude<AgendaClass, "lead_said">, string> = {
	blocked: "blocked",
	awaiting_approval: "approve",
	needs_answer: "answer",
};

/**
 * FLY-2863 §2: the voice agenda reads the very judgments the thread titles
 * render (待批 / 要你答 / 受阻) plus Lead-authored main-channel messages in the
 * speaking window. It never replays inbox history.
 */
export function buildVoiceAgendaSnapshot(
	deps: VoiceAgendaSourceDeps,
	session: VoiceAgendaSession,
): AgendaSnapshot {
	const now = deps.now();
	const asOf = now.toISOString();
	const sourceStatus: Record<string, AgendaSourceStatus> = {};
	const items: AgendaItem[] = [];
	const leads = scopedLeads(deps.projects, session);
	const leadByChannel = new Map(
		leads.map((entry) => [entry.lead.chatChannel, entry] as const),
	);
	const readTitle = deps.readTitle ?? readIssueTitleState;

	// ── title classes ──
	const threads = deps.agenda.listLiveIssueThreads().filter((thread) => {
		const owner = leadByChannel.get(thread.channelId);
		return owner && (!thread.leadId || thread.leadId === owner.lead.agentId);
	});
	const byProject = new Map<string, typeof threads>();
	for (const thread of threads) {
		const owner = leadByChannel.get(thread.channelId)!;
		const list = byProject.get(owner.project.projectName) ?? [];
		list.push(thread);
		byProject.set(owner.project.projectName, list);
	}
	const present: Array<{
		issueId: string;
		agendaClass: Exclude<AgendaClass, "lead_said">;
		threadId: string;
		owner: ScopedLead;
		identifier: string | null;
		title: string | null;
	}> = [];
	const completeIssueIds = new Set<string>();
	const titleProjects = new Set(
		leads.map((entry) => entry.project.projectName),
	);
	for (const projectName of titleProjects) {
		const key = `titles:${projectName}`;
		const projectThreads = byProject.get(projectName) ?? [];
		let facts: ReturnType<typeof readFounderAttentionFacts>;
		try {
			facts = readFounderAttentionFacts(
				{
					stateStore: deps.store,
					...(deps.openAttentionCommReadonly
						? { openCommReadonly: deps.openAttentionCommReadonly }
						: {}),
				},
				{ projectName, now },
			);
		} catch {
			sourceStatus[key] = {
				status: "unavailable",
				asOf,
				reason: "attention_read_failed",
			};
			continue;
		}
		let failed = 0;
		for (const thread of projectThreads) {
			const anySession = deps.store.getSessionByIssue(thread.issueId);
			const ask = anySession
				? undefined
				: deps.store.getLatestFounderAskForIssue(thread.issueId);
			if (!anySession && !ask) {
				completeIssueIds.add(thread.issueId);
				continue;
			}
			const aliases = [thread.issueId, anySession?.issue_identifier].filter(
				(alias): alias is string => !!alias,
			);
			const level = facts.available
				? founderAttentionLevel(
						facts.pending
							.filter((pending) => attentionFactMatchesIssue(pending, aliases))
							.map((pending) => pending.source.fact.value?.kind ?? ""),
					)
				: undefined;
			let agendaClass: Exclude<AgendaClass, "lead_said"> | null;
			try {
				agendaClass = titleClass(
					readTitle({
						store: deps.store,
						issueId: thread.issueId,
						...(anySession ? { anySession } : {}),
						...(() => {
							const run = deps.store.getActiveWorkflowRunForIssue(
								thread.issueId,
							);
							return run ? { activeWorkflowRun: run } : {};
						})(),
						...(level !== undefined ? { founderAttention: level } : {}),
					}).titleState,
				);
			} catch {
				failed++;
				continue;
			}
			if (facts.available) completeIssueIds.add(thread.issueId);
			if (!agendaClass) continue;
			present.push({
				issueId: thread.issueId,
				agendaClass,
				threadId: thread.threadId,
				owner: leadByChannel.get(thread.channelId)!,
				identifier: anySession?.issue_identifier ?? null,
				title: anySession?.issue_title ?? null,
			});
		}
		sourceStatus[key] = !facts.available
			? { status: "unavailable", asOf, reason: "attention_facts_unavailable" }
			: failed > 0
				? { status: "partial", asOf, reason: "title_read_failed" }
				: { status: "complete", asOf };
	}
	const episodes = deps.agenda.observeEpisodes({
		present: present.map((entry) => ({
			issueId: entry.issueId,
			agendaClass: entry.agendaClass,
		})),
		completeIssueIds,
		now: asOf,
	});
	const blockedIds = present
		.filter((entry) => entry.agendaClass === "blocked")
		.map((entry) => entry.issueId);
	if (blockedIds.length > 0) deps.observeBlockedIssues?.(blockedIds);
	for (const [index, entry] of present.entries()) {
		const since = episodes[index]!.since;
		const urgent =
			entry.agendaClass === "blocked" &&
			deps.issuePriority?.(entry.issueId) === LINEAR_PRIORITY_URGENT
				? ({
						source: "priority_urgent_blocked",
						reason: "priority_urgent_blocked",
					} as const)
				: null;
		items.push({
			itemKey: `${KEY_PREFIX[entry.agendaClass]}:${entry.issueId}:${since}`,
			class: entry.agendaClass,
			projectName: entry.owner.project.projectName,
			leadId: entry.owner.lead.agentId,
			leadName: spokenLeadName(entry.owner.lead),
			issueIdentifier: entry.identifier,
			issueTitle: entry.title,
			threadUrl: deps.guildId
				? `https://discord.com/channels/${deps.guildId}/${entry.threadId}`
				: null,
			since,
			urgent,
			pointers: { messageIds: [] },
			sourceKey: `titles:${entry.owner.project.projectName}`,
		});
	}

	// ── Lead said (main channels only; never history) ──
	const baseline = deps.agenda.leadSaidBaselineAt();
	const windowStart =
		now.getTime() - (deps.lookbackMs ?? DEFAULT_LEAD_SAID_LOOKBACK_MS);
	const freshnessMs = deps.freshnessMs ?? DEFAULT_AGENDA_SOURCE_FRESHNESS_MS;
	let olderUnspokenCount = 0;
	const candidates = deps.agenda.listLeadSaidCandidates({
		founderUserId: session.founderUserId,
		channelIds: [...leadByChannel.keys()],
		createdAfter: baseline,
	});
	const watermarks = new Map<string, number>();
	for (const { project, lead } of leads) {
		const key = `inbox:${project.projectName}:${lead.chatChannel}`;
		const state = deps.inbox.getSourceState(
			project.projectName,
			session.founderUserId,
			lead.chatChannel,
		);
		watermarks.set(
			lead.chatChannel,
			state?.founderLastMessageAt ? Date.parse(state.founderLastMessageAt) : 0,
		);
		const fresh =
			!!state && now.getTime() - Date.parse(state.updatedAt) <= freshnessMs;
		sourceStatus[key] = !state
			? { status: "recovering", asOf, reason: "never_collected" }
			: state.health === "source_gap"
				? {
						status: "source_gap",
						asOf: state.updatedAt,
						reason: state.healthReason ?? "source_gap",
					}
				: state.health === "recovering"
					? {
							status: "recovering",
							asOf: state.updatedAt,
							reason: state.healthReason ?? "recovering",
						}
					: state.health === "rate_limited" ||
							!state.bootstrapComplete ||
							!fresh
						? {
								status: "partial",
								asOf: state.updatedAt,
								reason:
									state.health === "rate_limited"
										? "rate_limited"
										: !state.bootstrapComplete
											? "bootstrap_incomplete"
											: "stale",
							}
						: { status: "complete", asOf: state.updatedAt };
	}
	const saidKeys = candidates.map(
		(candidate) =>
			`said:${candidate.channelId}:${candidate.sourceMessageId}:${candidate.revision}`,
	);
	const resolved = deps.agenda.resolvedItemKeys(saidKeys);
	for (const [index, candidate] of candidates.entries()) {
		const owner = leadByChannel.get(candidate.channelId);
		if (!owner || candidate.sourceResolved) continue;
		const createdAt = Date.parse(candidate.sourceCreatedAt);
		if (createdAt <= (watermarks.get(candidate.channelId) ?? 0)) continue;
		const itemKey = saidKeys[index]!;
		if (resolved.has(itemKey)) continue;
		if (createdAt < windowStart) {
			olderUnspokenCount++;
			continue;
		}
		const mark = deps.agenda.getUrgent(
			candidate.channelId,
			candidate.sourceMessageId,
		);
		const ownerBot = deps.leadBotUserId?.(owner.lead);
		// U1 counts only when the channel owner's own bot wrote the marked message.
		const flag =
			mark &&
			ownerBot &&
			mark.authorId === ownerBot &&
			candidate.authorId === ownerBot
				? mark
				: undefined;
		items.push({
			itemKey,
			class: "lead_said",
			projectName: owner.project.projectName,
			leadId: owner.lead.agentId,
			leadName: spokenLeadName(owner.lead),
			issueIdentifier: null,
			issueTitle: null,
			threadUrl: null,
			since: new Date(createdAt).toISOString(),
			urgent: flag ? { source: "lead_flag", reason: flag.reason } : null,
			pointers: { messageIds: [candidate.sourceMessageId] },
			sourceText: candidate.text.slice(0, MAX_SOURCE_TEXT),
			sourceKey: `inbox:${owner.project.projectName}:${candidate.channelId}`,
		});
	}

	const complete = Object.values(sourceStatus).every(
		(status) => status.status === "complete",
	);
	return {
		snapshotId: createHash("sha256")
			.update(
				JSON.stringify({
					keys: items.map((item) => item.itemKey).sort(),
					status: sourceStatus,
				}),
			)
			.digest("hex"),
		asOf,
		items,
		sourceStatus,
		complete,
		olderUnspokenCount,
	};
}

const PRIORITY_TTL_MS = 5 * 60_000;

/** U2 cache: Linear priority for blocked issues, learned asynchronously so a
 * snapshot never waits on Linear. Unknown stays unknown (not urgent). */
export class VoiceAgendaPriorityCache {
	private readonly entries = new Map<
		string,
		{ priority: number | null; fetchedAt: number }
	>();
	private readonly inFlight = new Set<string>();

	constructor(
		private readonly options: {
			fetchPriority?: (issueId: string) => Promise<number | null | undefined>;
			now?: () => number;
			log?: (message: string) => void;
		},
	) {}

	get(issueId: string): number | null {
		return this.entries.get(issueId)?.priority ?? null;
	}

	observe(issueIds: readonly string[]): void {
		const fetchPriority = this.options.fetchPriority;
		if (!fetchPriority) return;
		const now = (this.options.now ?? Date.now)();
		for (const issueId of issueIds) {
			const entry = this.entries.get(issueId);
			if (this.inFlight.has(issueId)) continue;
			if (entry && now - entry.fetchedAt < PRIORITY_TTL_MS) continue;
			this.inFlight.add(issueId);
			void fetchPriority(issueId)
				.then((priority) =>
					this.entries.set(issueId, {
						priority: typeof priority === "number" ? priority : null,
						fetchedAt: (this.options.now ?? Date.now)(),
					}),
				)
				.catch((error) =>
					(this.options.log ?? console.warn)(
						`[voice-agenda] priority read failed for ${issueId}: ${error instanceof Error ? error.message : String(error)}`,
					),
				)
				.finally(() => this.inFlight.delete(issueId));
		}
	}
}
