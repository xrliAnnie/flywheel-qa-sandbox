import { CommDB } from "flywheel-comm/db";
import type {
	AttentionInput,
	AttentionSource,
} from "../epic-page/attention.js";
import type { Cell, MissingReason, Provenance } from "../epic-page/model.js";
import type { FounderAskRecord, StateStore } from "../StateStore.js";
import { commDbPathForProject } from "./commdb-path.js";
import { founderAttentionLevel } from "./founder-attention.js";
import {
	type IssueTitleStateStore,
	readIssueTitleState,
} from "./issue-title-state.js";

/** Aliases come only from the project-scoped identity resolver, never message text. */
export function attentionFactMatchesIssue(
	fact: { issue: string | null; aliases?: string[] },
	aliases: readonly string[],
): boolean {
	return (
		fact.issue !== null &&
		[fact.issue, ...(fact.aliases ?? [])].some((alias) =>
			aliases.includes(alias),
		)
	);
}

/** Both display consumers use the same lifecycle and hold projection. */
export function readEffectiveFounderAttention(
	store: IssueTitleStateStore,
	facts: ReturnType<typeof readFounderAttentionFacts>,
	issueId: string,
	aliases: string[] = [issueId],
) {
	if (!facts.available) return { available: false as const, level: null };
	try {
		const level = founderAttentionLevel(
			facts.pending
				.filter((p) => attentionFactMatchesIssue(p, aliases))
				.map((p) => p.source.fact.value?.kind ?? ""),
		);
		const { titleState } = readIssueTitleState({
			store,
			issueId,
			anySession: store.getSessionByIssue(issueId),
			activeWorkflowRun: store.getActiveWorkflowRunForIssue(issueId),
			founderAttention: level,
		});
		return { available: true as const, ...titleState };
	} catch {
		return { available: false as const, level: null };
	}
}

export interface FounderAttentionFactsDeps {
	stateStore: Pick<
		StateStore,
		| "listAttentionGateFacts"
		| "resolveAttentionQuestionIdentity"
		| "classifyAttentionMailboxGate"
		| "listOpenFounderAsks"
		| "hasFounderAttentionReplyAfter"
	>;
	openCommReadonly?: (
		path: string,
	) => Pick<CommDB, "listAttentionQuestions" | "isQuestionPending" | "close">;
}

/** Shared local fact reader for title rotation and the Epic page. Owns every DB lease. */
export function readFounderAttentionFacts(
	deps: FounderAttentionFactsDeps,
	input: { projectName: string; now: Date },
) {
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
	const identityStateKey = state("sessions", {
		project_name: input.projectName,
		reader: "resolveAttentionQuestionIdentity",
	});
	const identityReads: Pick<AttentionInput["identityReads"], "statestore"> = {
		statestore: cell({ available: true as const }, identityStateKey),
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
	const readKey = state("workflow_gate_holder", {
		tables: "workflow_gate_holder,founder_ask",
		project_name: input.projectName,
	});
	const reads: Pick<AttentionInput["reads"], "gates" | "questions"> = {
		gates: cell<never>(null, readKey, "source_unavailable"),
		questions: cell<never>(null, comm(), "source_unavailable"),
	};
	type Pending = {
		key: string;
		issue: string | null;
		aliases?: string[];
		source: AttentionSource;
		channel: string | null;
		excerpt?: string;
	};
	const pending: Pending[] = [];
	let asks: FounderAskRecord[] = [];
	try {
		const result = deps.stateStore.listAttentionGateFacts(input.projectName);
		asks = deps.stateStore.listOpenFounderAsks(input.projectName);
		reads.gates = cell(
			result.truncated || asks.length > 1000
				? null
				: { count: result.facts.length },
			readKey,
			result.truncated || asks.length > 1000 ? "source_truncated" : undefined,
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
				aliases: identity.status === "resolved" ? identity.aliases : [],
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
			for (const ask of asks) {
				// Persist before send, but never advertise a message that did not reach Discord.
				if (
					!ask.message_id ||
					(ask.question_id && !db.isQuestionPending(ask.question_id))
				)
					continue;
				const provenance = state("founder_ask", { ask_id: ask.ask_id });
				pending.push({
					key: `ask:${ask.ask_id}`,
					issue: ask.issue_id,
					channel: ask.channel_id,
					excerpt: ask.excerpt,
					source: {
						fact: cell(
							{ id: ask.ask_id, kind: "founder_ask", state: "pending" },
							provenance,
						),
						since: cell(ask.asked_at, provenance),
					},
				});
				if (reads.gates.value) reads.gates.value.count++;
			}
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
					if (q.kind === "founder_gate" || q.kind === "ship") {
						try {
							if (
								deps.stateStore.classifyAttentionMailboxGate(
									input.projectName,
									q.id,
								) !== "legacy" ||
								!["founder_review", "brainstorm"].includes(q.checkpoint ?? "")
							)
								continue;
						} catch {
							incomplete = "source_unavailable";
							identityReads.statestore = cell<never>(
								null,
								identityStateKey,
								"source_unavailable",
							);
							continue;
						}
						// Review/brainstorm rounds use their mailbox checkpoint rather
						// than a gate holder. Current holders are already included above;
						// unbound legacy ship asks do not establish a current ship card.
					}
					const provenance = comm(q.id);
					const identity = resolveIdentity(q.id, q.execution_id);
					if (
						q.kind === "founder_gate" &&
						identity.status === "resolved" &&
						q.since &&
						[identity.issue_id, ...(identity.aliases ?? [])].some((alias) =>
							deps.stateStore.hasFounderAttentionReplyAfter(
								input.projectName,
								alias,
								q.since!,
							),
						)
					)
						continue;

					const role = ["lead", "bridge", "runner"].includes(
						q.recipient_role ?? "",
					)
						? (q.recipient_role as "lead" | "bridge" | "runner")
						: null;
					if (q.classification_unknown) incomplete = "source_unavailable";
					pending.push({
						key: `question:${q.id}`,
						issue: identity.status === "resolved" ? identity.issue_id : null,
						aliases: identity.status === "resolved" ? identity.aliases : [],
						channel:
							identity.status === "resolved" ? identity.channel_id : null,
						source: {
							fact: cell(
								{
									id: q.id,
									kind:
										q.kind === "founder_gate"
											? "legacy_founder_gate"
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
		reads.questions = cell<never>(null, comm(), "source_unavailable");
		if (asks.length)
			reads.gates = cell<never>(null, readKey, "source_unavailable");
	}
	return {
		pending,
		reads,
		identityRead: identityReads.statestore,
		available:
			reads.gates.value !== null &&
			reads.questions.value !== null &&
			identityReads.statestore.value !== null,
	};
}
