import { CommDB } from "flywheel-comm/db";
import { commDbPathForProject } from "../bridge/commdb-path.js";
import {
	fetchLinearAttentionIssueMetadata,
	fetchLinearFounderReviewAttention,
	type LinearAttentionResult,
} from "../bridge/linear-attention-query.js";
import type { ProjectLinearBinding } from "../ProjectConfig.js";
import type { StateStore } from "../StateStore.js";
import type {
	AttentionCandidate,
	AttentionInput,
	AttentionSource,
} from "./attention.js";
import type { Cell, MissingReason, Provenance } from "./model.js";

export interface AttentionSourceDeps {
	stateStore: Pick<
		StateStore,
		| "readDiscordConfig"
		| "listAttentionGateFacts"
		| "resolveAttentionQuestionIdentity"
		| "resolveAttentionThreadBinding"
		| "classifyAttentionMailboxGate"
	>;
	openCommReadonly?: (
		path: string,
	) => Pick<CommDB, "listAttentionQuestions" | "close">;
	fetchFounderReview?: typeof fetchLinearFounderReviewAttention;
	fetchIssueMetadata?: typeof fetchLinearAttentionIssueMetadata;
}
export interface AttentionSourceInput {
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
	const resolveIdentity = (questionId: string, executionId: string) => {
		try {
			return deps.stateStore.resolveAttentionQuestionIdentity(
				input.projectName,
				questionId,
				executionId,
			);
		} catch {
			identityReads.statestore = cell<never>(
				null,
				identityStateKey,
				"source_unavailable",
			);
			return { status: "unknown" as const };
		}
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
	type Pending = {
		key: string;
		issue: string | null;
		source: AttentionSource;
		channel: string | null;
	};
	const pending: Pending[] = [];
	try {
		const result = deps.stateStore.listAttentionGateFacts(input.projectName);
		reads.gates = cell(
			result.truncated ? null : { count: result.facts.length },
			readKey,
			result.truncated ? "source_truncated" : undefined,
		);
		for (const fact of result.facts) {
			const identity = resolveIdentity(fact.question_id, fact.execution_id);
			const provenance = state("workflow_gate_holder", {
				question_id: fact.question_id,
				run_id: fact.run_id,
				node_id: fact.node_id,
				attempt: String(fact.attempt),
				execution_id: fact.execution_id ?? "unknown",
			});
			pending.push({
				key: `holder:${fact.question_id}`,
				issue: identity.status === "resolved" ? identity.issue_id : null,
				channel: identity.status === "resolved" ? identity.channel_id : null,
				source: {
					fact: cell(
						{
							id: fact.question_id,
							kind: fact.kind,
							state: fact.state,
							authority_mode: fact.authority_mode,
						},
						provenance,
					),
					since: cell(
						fact.since,
						provenance,
						fact.since ? undefined : "invalid_since",
					),
				},
			});
		}
	} catch {
		reads.gates = cell<never>(null, readKey, "source_unavailable");
	}
	try {
		const db = (deps.openCommReadonly ?? CommDB.openReadonly)(
			commDbPathForProject(input.projectName),
		);
		try {
			let cursor: { created_at: string; id: string } | undefined;
			let rawCount = 0;
			let count = 0;
			let incomplete: MissingReason | undefined;
			do {
				const page = db.listAttentionQuestions({
					limit: Math.min(50, 1000 - rawCount),
					...(cursor ? { cursor } : {}),
				});
				rawCount += page.rawCount;
				for (const q of page.questions) {
					let classificationFailed = false;
					if (q.kind === "founder_gate" || q.kind === "ship") {
						try {
							if (
								deps.stateStore.classifyAttentionMailboxGate(
									input.projectName,
									q.id,
								) === "excluded"
							)
								continue;
						} catch {
							classificationFailed = true;
							incomplete = "source_unavailable";
							identityReads.statestore = cell<never>(
								null,
								identityStateKey,
								"source_unavailable",
							);
						}
					}
					const provenance = comm(q.id);
					const identity = resolveIdentity(q.id, q.execution_id);

					const role = ["lead", "bridge", "runner"].includes(
						q.recipient_role ?? "",
					)
						? (q.recipient_role as "lead" | "bridge" | "runner")
						: null;
					if (q.classification_unknown) incomplete = "source_unavailable";
					pending.push({
						key: `question:${q.id}`,
						issue: identity.status === "resolved" ? identity.issue_id : null,
						channel:
							identity.status === "resolved" ? identity.channel_id : null,
						source: {
							fact: cell(
								{
									id: q.id,
									kind: classificationFailed
										? "unknown"
										: (q.kind ?? "unknown"),
									state: q.state,
								},
								provenance,
							),
							since: cell(
								q.since,
								provenance,
								q.since ? undefined : "invalid_since",
							),
							recipient_role: cell(
								role,
								provenance,
								role ? undefined : "source_unavailable",
							),
						},
					});
					count++;
				}
				cursor = page.nextCursor ?? undefined;
				if (cursor && rawCount >= 1000) {
					incomplete = "source_truncated";
					break;
				}
			} while (cursor);
			reads.questions = cell(incomplete ? null : { count }, comm(), incomplete);
		} finally {
			db.close();
		}
	} catch {
		/* Never turn a failed project read into a successful empty list. */
	}
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
	const issueFor = (p: Pending) =>
		p.issue
			? (metadata.get(p.issue) ??
				[...metadata.values()].find((v) => v.identifier === p.issue))
			: undefined;
	const gateChannels = new Map<string, Set<string>>();
	const otherChannels = new Map<string, Set<string>>();
	for (const p of pending) {
		const issue = issueFor(p);
		if (!issue || !p.channel) continue;
		const map = p.key.startsWith("holder:") ? gateChannels : otherChannels;
		const channels = map.get(issue.id) ?? new Set<string>();
		channels.add(p.channel);
		map.set(issue.id, channels);
	}
	const threads = new Map<string, AttentionCandidate["thread"]>();
	const candidates: AttentionCandidate[] = pending.map((p) => {
		const issue = issueFor(p);
		const provenance = issue ? linear(issue.id) : p.source.fact.provenance;
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
				issue ? undefined : "issue_title_unknown",
			),
			sources: [p.source],
			thread,
		};
	});
	return { guildId, reads, candidates, identityReads };
}
