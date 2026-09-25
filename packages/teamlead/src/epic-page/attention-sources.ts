import { founderAttentionLevel } from "../bridge/founder-attention.js";
import {
	type FounderAttentionFactsDeps,
	readEffectiveFounderAttention,
	readFounderAttentionFacts,
} from "../bridge/founder-attention-facts.js";
import type { IssueTitleStateStore } from "../bridge/issue-title-state.js";
import {
	fetchLinearAttentionIssueMetadata,
	fetchLinearFounderReviewAttention,
	type LinearAttentionResult,
} from "../bridge/linear-attention-query.js";
import type { LinearActiveScopeSnapshot } from "../bridge/linear-epic-query.js";
import type { ProjectLinearBinding } from "../ProjectConfig.js";
import type { StateStore } from "../StateStore.js";
import {
	type AttentionCandidate,
	type AttentionInput,
	ISSUE_IDENTIFIER,
	validDiscordId,
} from "./attention.js";
import { discordThreadLinkPair } from "./discord-link.js";
import type { Cell, MissingReason, Provenance } from "./model.js";

export interface AttentionSourceDeps {
	stateStore: IssueTitleStateStore &
		Pick<
			StateStore,
			| "readDiscordConfig"
			| "listAttentionGateFacts"
			| "resolveAttentionQuestionIdentity"
			| "resolveAttentionThreadBinding"
			| "classifyAttentionMailboxGate"
			| "listOpenFounderAsks"
			| "hasFounderAttentionReplyAfter"
		>;
	openCommReadonly?: FounderAttentionFactsDeps["openCommReadonly"];
	fetchFounderReview?: typeof fetchLinearFounderReviewAttention;
	fetchIssueMetadata?: typeof fetchLinearAttentionIssueMetadata;
}
export interface AttentionSourceInput {
	scopeSnapshot?: Promise<LinearActiveScopeSnapshot | null>;
	projectName: string;
	binding: ProjectLinearBinding;
	apiKey: string;
	channelIds: string[];
	now: Date;
}

/** Reads project facts independently of the Epic snapshot. All database handles close here. */
export async function readAttentionSources(
	deps: AttentionSourceDeps,
	input: AttentionSourceInput,
): Promise<AttentionInput> {
	const observed_at = input.now.toISOString();
	const cell = <T>(
		value: T | null,
		provenance: Provenance,
		reason?: MissingReason,
	): Cell<T> => ({
		value,
		provenance,
		observed_at,
		...(reason ? { missing: { reason } } : {}),
	});
	const state = (table: string, key: Record<string, string>): Provenance => ({
		kind: "statestore",
		table,
		key,
	});
	const comm = (id?: string): Provenance => ({
		kind: "commdb",
		table: "mailbox",
		key: id ? { question_id: id } : { project_name: input.projectName },
	});
	const linear = (id: string): Provenance => ({
		kind: "linear",
		entity: "issue",
		id,
	});
	const readKey = state("workflow_gate_holder", {
		project_name: input.projectName,
	});
	const labelKey: Provenance = {
		kind: "linear",
		entity: "issues",
		id: `${input.projectName}:founder-review`,
	};
	const identityStateKey = state("sessions", {
		project_name: input.projectName,
		reader: "resolveAttentionQuestionIdentity",
	});
	const identityLinearKey: Provenance = {
		kind: "linear",
		entity: "issues",
		id: `${input.projectName}:attention-identity`,
	};
	const identityReads: AttentionInput["identityReads"] = {
		statestore: cell({ available: true as const }, identityStateKey),
		linear: cell({ available: true as const }, identityLinearKey),
	};
	// Start the independent network read before local database work; settle failures now.
	const namedPromise = (async (): Promise<LinearAttentionResult> => {
		try {
			return await (
				deps.fetchFounderReview ?? fetchLinearFounderReviewAttention
			)(input.apiKey, input.binding);
		} catch {
			return {
				items: [],
				rawCount: 0,
				fetchedAt: observed_at,
				missing: { reason: "source_unavailable", detail: "upstream_error" },
			};
		}
	})();
	const configKey = state("discord_config", { singleton_key: "discord" });
	let guildId: Cell<string>;
	try {
		const config = deps.stateStore.readDiscordConfig();
		guildId = cell(
			config?.state === "configured" ? config.guild_id : null,
			configKey,
			config?.state === "configured"
				? undefined
				: config?.state === "invalid"
					? "invalid_guild_config"
					: "no_guild_configured",
		);
		if (config) guildId.source_updated_at = config.source_updated_at;
	} catch {
		guildId = cell<never>(null, configKey, "statestore_error");
	}
	const reads: AttentionInput["reads"] = {
		gates: cell<never>(null, readKey, "source_unavailable"),
		questions: cell<never>(null, comm(), "source_unavailable"),
		founder_review: cell<never>(null, labelKey, "source_unavailable"),
	};
	const facts = readFounderAttentionFacts(deps, input);
	const pending = facts.pending;
	type Pending = (typeof pending)[number];
	reads.gates = facts.reads.gates;
	reads.questions = facts.reads.questions;
	identityReads.statestore = facts.identityRead;
	const named = await namedPromise;
	reads.founder_review = cell(
		named.missing ? null : { count: named.items.length },
		labelKey,
		named.missing?.reason,
	);
	for (const issue of named.items)
		pending.push({
			key: `issue:${issue.id}`,
			issue: issue.id,
			channel: null,
			source: {
				fact: cell(
					{ id: issue.id, kind: "founder_named", state: issue.stateType },
					linear(issue.id),
				),
				since: cell<never>(null, linear(issue.id), "since_unknown"),
			},
		});
	const metadata = new Map(named.items.map((issue) => [issue.id, issue]));
	const identities = [
		...new Set(
			pending.flatMap((p) =>
				p.issue && !metadata.has(p.issue) ? [p.issue] : [],
			),
		),
	];
	try {
		const result = await (
			deps.fetchIssueMetadata ?? fetchLinearAttentionIssueMetadata
		)(input.apiKey, input.binding, identities);
		for (const issue of result.items) metadata.set(issue.id, issue);
		if (result.missing)
			identityReads.linear = cell<never>(
				null,
				identityLinearKey,
				result.missing.reason,
			);
	} catch {
		identityReads.linear = cell<never>(
			null,
			identityLinearKey,
			"source_unavailable",
		);
	}
	// Descendants inherit the proven Epic scope; requiring each child to repeat
	// its root's label would hide a valid gate and its Discord binding.
	const scope = await input.scopeSnapshot?.catch(() => null);
	if (
		scope &&
		scope.boundary.teamKey === input.binding.team &&
		scope.boundary.project === (input.binding.project ?? null) &&
		scope.boundary.label === (input.binding.label ?? null)
	) {
		for (const issue of [
			...scope.roots.map((root) => ({ ...root, labels: [] as string[] })),
			...scope.items,
		]) {
			if (!metadata.has(issue.id))
				metadata.set(issue.id, {
					id: issue.id,
					identifier: issue.identifier,
					title: issue.title,
					url: issue.url,
					stateType: issue.state.type,
					labels: issue.labels,
				});
		}
	}
	const issueFor = (p: Pending) =>
		p.issue
			? (metadata.get(p.issue) ??
				[...metadata.values()].find((v) => v.identifier === p.issue))
			: undefined;
	// FLY-2761: a founder_ask row is a project-scoped local record naming its own
	// issue. Missing Linear/Epic metadata must not hide the founder's pending ask,
	// so the row's identifier stands in, cited as the ask row, never as Linear.
	const identityFor = (
		p: Pending,
	):
		| {
				id: string;
				identifier: string;
				title: string | null;
				provenance: Provenance;
		  }
		| undefined => {
		const issue = issueFor(p);
		if (issue)
			return {
				id: issue.id,
				identifier: issue.identifier,
				title: issue.title,
				provenance: linear(issue.id),
			};
		if (
			p.source.fact.value?.kind === "founder_ask" &&
			p.issue &&
			ISSUE_IDENTIFIER.test(p.issue)
		)
			return {
				id: p.issue,
				identifier: p.issue,
				title: null,
				provenance: p.source.fact.provenance,
			};
		return undefined;
	};
	const gateChannels = new Map<string, Set<string>>();
	const otherChannels = new Map<string, Set<string>>();
	for (const p of pending) {
		const issue = identityFor(p);
		if (!issue || !p.channel) continue;
		const map = p.key.startsWith("holder:") ? gateChannels : otherChannels;
		const channels = map.get(issue.id) ?? new Set<string>();
		channels.add(p.channel);
		map.set(issue.id, channels);
	}
	const threads = new Map<string, AttentionCandidate["thread"]>();
	const visible = pending.filter((p) => {
		const kindLevel = founderAttentionLevel([p.source.fact.value?.kind ?? ""]);
		if (!kindLevel) return true;
		// FLY-2761 qa@1: an unsettled founder ask waits on her until it is
		// answered, whatever the issue's session, run or thread state says. The
		// FLY-2597 title projection (no answer badge once completed) governs only
		// the ordinary answer badge, never whether this page shows her ask.
		if (p.source.fact.value?.kind === "founder_ask") return true;
		if (!p.issue) return true;
		const issue = identityFor(p);
		const aliases = issue ? [issue.id, issue.identifier] : [p.issue];
		const markUnavailable = () => {
			const bucket =
				p.source.fact.provenance.kind === "commdb" ? "questions" : "gates";
			reads[bucket] = cell<never>(
				null,
				reads[bucket].provenance,
				"source_unavailable",
			);
			return false;
		};
		try {
			// Prefer the source's bound issue key over a metadata-only UUID alias.
			const canonical =
				[p.issue, ...aliases].find((alias) =>
					deps.stateStore.getSessionByIssue(alias),
				) ?? p.issue;
			const effective = readEffectiveFounderAttention(
				deps.stateStore,
				facts,
				canonical,
				aliases,
			);
			if (!effective.available) return markUnavailable();
			return effective.level === kindLevel;
		} catch {
			return markUnavailable();
		}
	});
	for (const p of pending) {
		if (visible.includes(p)) continue;
		const bucket =
			p.source.fact.provenance.kind === "commdb" ? "questions" : "gates";
		if (reads[bucket].value) reads[bucket].value!.count--;
	}
	const candidates: AttentionCandidate[] = visible.map((p) => {
		const issue = identityFor(p);
		const provenance = issue?.provenance ?? p.source.fact.provenance;
		let thread: AttentionCandidate["thread"];
		const threadKey = state("chat_threads", { issue_id: issue?.id ?? p.key });
		if (!issue) thread = cell<never>(null, threadKey, "issue_identity_unknown");
		else if (threads.has(issue.id)) thread = threads.get(issue.id)!;
		else {
			const channels =
				gateChannels.get(issue.id) ??
				otherChannels.get(issue.id) ??
				new Set<string>();
			try {
				const found =
					channels.size > 1
						? { status: "thread_binding_conflict" as const }
						: deps.stateStore.resolveAttentionThreadBinding({
								projectName: input.projectName,
								aliases: [issue.id, issue.identifier],
								channelIds: input.channelIds,
								...(channels.size === 1
									? { authoritativeChannelId: [...channels][0] }
									: {}),
							});
				thread =
					found.status === "resolved"
						? cell(
								{ thread_id: found.thread_id, channel_id: found.channel_id },
								threadKey,
							)
						: cell<never>(null, threadKey, found.status);
			} catch {
				thread = cell<never>(null, threadKey, "statestore_error");
			}
			threads.set(issue.id, thread);
		}
		return {
			key: p.key,
			issue_id: cell(
				issue?.id ?? null,
				provenance,
				issue ? undefined : "issue_identity_unknown",
			),
			identifier: cell(
				issue?.identifier ?? null,
				provenance,
				issue ? undefined : "issue_identity_unknown",
			),
			title: cell(
				issue?.title ?? null,
				provenance,
				issue?.title ? undefined : "issue_title_unknown",
			),
			sources: [p.source],
			thread,
		};
	});
	return { guildId, reads, candidates, identityReads };
}

/** Read row links with the same project/channel confinement as attention. */
export function readChildThreads(
	store: Pick<
		StateStore,
		"readDiscordConfig" | "resolveAttentionThreadBinding"
	>,
	projectName: string,
	items: Array<{ id: string; identifier: string }>,
	channelIds: string[],
	now: Date,
): Map<string, Cell<string>> {
	const result = new Map<string, Cell<string>>();
	for (const item of items) {
		const base = {
			provenance: {
				kind: "statestore" as const,
				table: "chat_threads",
				key: { issue_id: item.id, issue_identifier: item.identifier },
			},
			observed_at: now.toISOString(),
		};
		try {
			const guild = store.readDiscordConfig();
			if (guild?.state !== "configured" || !validDiscordId(guild.guild_id)) {
				result.set(item.id, {
					...base,
					value: null,
					missing: {
						reason:
							guild?.state === "invalid" || guild?.state === "configured"
								? "invalid_guild_config"
								: "no_guild_configured",
					},
				});
				continue;
			}
			const binding = store.resolveAttentionThreadBinding({
				projectName,
				aliases: [item.id, item.identifier],
				channelIds,
			});
			if (
				binding.status === "resolved" &&
				(!validDiscordId(binding.thread_id) ||
					!validDiscordId(binding.channel_id))
			) {
				result.set(item.id, {
					...base,
					value: null,
					missing: { reason: "invalid_discord_id" },
				});
				continue;
			}
			result.set(
				item.id,
				binding.status === "resolved"
					? {
							...base,
							value: discordThreadLinkPair(guild.guild_id, binding.thread_id)!
								.web,
						}
					: { ...base, value: null, missing: { reason: binding.status } },
			);
		} catch {
			result.set(item.id, {
				...base,
				value: null,
				missing: { reason: "statestore_error" },
			});
		}
	}
	return result;
}
