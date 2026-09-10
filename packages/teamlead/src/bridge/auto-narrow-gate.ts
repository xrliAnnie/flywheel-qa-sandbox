import type { AutoNarrowSourceEnvelopeV1 } from "flywheel-comm/auto-narrow-contract";
import type { AutoNarrowMetrics } from "../auto-narrow/opinion.js";
import { type ProjectEntry, resolveLeadForIssue } from "../ProjectConfig.js";
import type { StateStore } from "../StateStore.js";

interface AutoNarrowGateStore {
	listPendingAutoNarrowCandidates(
		limit?: number,
		startAfterQuestionId?: string,
	): string[];
	getAutoNarrowOpinionMetrics(at: string): AutoNarrowMetrics;
	getAutoNarrowOpinionDelivery(
		questionId: string,
	): { issueThreadId: string; state: string } | undefined;
	refreshAutoNarrowOpinion(input: {
		questionId: string;
		issueThreadId: string;
		mode: "off" | "dry_run" | "auto";
		controlAppliedAt?: string;
		at: string;
		metrics?: AutoNarrowMetrics;
	}): unknown;
	commitAutoNarrowSourceIfEligible(input: {
		questionId: string;
		at: string;
		writeSource: (args: {
			expectedOwner: string;
			projectedThroughSourceRowId: number;
			envelope: AutoNarrowSourceEnvelopeV1;
		}) => { written: boolean; replayed: boolean };
	}): {
		status:
			| "not_auto"
			| "not_candidate"
			| "ineligible"
			| "written"
			| "replayed";
	};
}

interface AutoNarrowCommDb {
	insertAutoNarrowApprovalWithSource(input: {
		project: string;
		expectedOwner: string;
		projectedThroughSourceRowId: number;
		envelope: unknown;
	}): { written: boolean; replayed: boolean };
	close(): void;
}

export interface ReconcileAutoNarrowGateDeps {
	store: AutoNarrowGateStore;
	openCommDb(project: string): AutoNarrowCommDb;
	now?: () => string;
	opinionControl?: {
		mode: "off" | "dry_run" | "auto";
		controlAppliedAt?: string;
	};
	resolveDeliveryContext?: (
		questionId: string,
	) => { issueThreadId: string } | undefined;
	scanAfterQuestionId?: string;
	monotonicNow?: () => number;
	log?: (message: string) => void;
}

export interface ReconcileAutoNarrowGateResult {
	scanned: number;
	written: number;
	replayed: number;
	skipped: number;
	failed: number;
	cursor: string | null;
}

export interface AutoNarrowGateDeliveryContext {
	leadId: string;
	issueThreadId: string;
	botToken: string;
}

export function resolveAutoNarrowGateDeliveryContext(input: {
	store: Pick<
		StateStore,
		| "getCurrentWorkflowGateHolderByQuestionId"
		| "getWorkflowRun"
		| "getSession"
		| "getSessionLabels"
		| "getChatThreadByIssue"
	>;
	projects: ProjectEntry[];
	questionId: string;
	defaultBotToken?: string;
}): AutoNarrowGateDeliveryContext | undefined {
	const holder = input.store.getCurrentWorkflowGateHolderByQuestionId(
		input.questionId,
	);
	if (!holder) return undefined;
	const run = input.store.getWorkflowRun(holder.run_id);
	if (!run || run.project_name !== "flywheel") return undefined;
	const source = input.store.getSession(holder.source_execution_id);
	if (!source) return undefined;
	const resolved = resolveLeadForIssue(
		input.projects,
		run.project_name,
		input.store.getSessionLabels(holder.source_execution_id),
	);
	// The card materializer is label-routed. A general fallback would silently
	// pick leads[0], which is not evidence of the bot that owns this card.
	if (resolved.matchMethod !== "label") return undefined;
	const thread = input.store.getChatThreadByIssue(
		run.issue_id,
		resolved.lead.chatChannel,
	);
	const botToken = resolved.lead.botToken ?? input.defaultBotToken;
	if (!thread?.thread_id || !botToken) return undefined;
	return {
		leadId: resolved.lead.agentId,
		issueThreadId: thread.thread_id,
		botToken,
	};
}

export function refreshAutoNarrowOpinionTrace(input: {
	store: Pick<
		AutoNarrowGateStore,
		"getAutoNarrowOpinionDelivery" | "refreshAutoNarrowOpinion"
	>;
	questionId: string;
	issueThreadId: string;
	opinionControl: NonNullable<ReconcileAutoNarrowGateDeps["opinionControl"]>;
	at: string;
	metrics?: AutoNarrowMetrics;
	log?: (message: string) => void;
}): boolean {
	try {
		input.store.refreshAutoNarrowOpinion({
			questionId: input.questionId,
			issueThreadId: input.issueThreadId,
			...input.opinionControl,
			at: input.at,
			...(input.metrics ? { metrics: input.metrics } : {}),
		});
		const delivery = input.store.getAutoNarrowOpinionDelivery(input.questionId);
		return Boolean(delivery && delivery.state !== "gone");
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		input.log?.(`[auto-narrow-opinion] ${input.questionId}: ${detail}`);
		return false;
	}
}

export function reconcileAutoNarrowGate(
	deps: ReconcileAutoNarrowGateDeps,
): ReconcileAutoNarrowGateResult {
	const monotonicNow = deps.monotonicNow ?? Date.now;
	const startedAt = monotonicNow();
	const result: ReconcileAutoNarrowGateResult = {
		scanned: 0,
		written: 0,
		replayed: 0,
		skipped: 0,
		failed: 0,
		cursor: null,
	};
	const candidates = deps.store.listPendingAutoNarrowCandidates(
		20,
		deps.scanAfterQuestionId,
	);
	const at = deps.now?.() ?? new Date().toISOString();
	let metrics: AutoNarrowMetrics | undefined;
	if (
		candidates.length > 0 &&
		deps.opinionControl &&
		deps.opinionControl.mode !== "off"
	) {
		try {
			metrics = deps.store.getAutoNarrowOpinionMetrics(at);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			deps.log?.(`[auto-narrow-gate] metric snapshot unavailable: ${detail}`);
			result.failed = candidates.length;
			return result;
		}
	}
	for (const questionId of candidates) {
		if (result.scanned > 0 && monotonicNow() - startedAt >= 200) break;
		result.scanned += 1;
		result.cursor = questionId;
		let delivery = deps.store.getAutoNarrowOpinionDelivery(questionId);
		if (deps.opinionControl && deps.opinionControl.mode !== "off") {
			const issueThreadId =
				delivery?.issueThreadId ??
				deps.resolveDeliveryContext?.(questionId)?.issueThreadId;
			if (
				!issueThreadId ||
				!refreshAutoNarrowOpinionTrace({
					store: deps.store,
					questionId,
					issueThreadId,
					opinionControl: deps.opinionControl,
					at,
					metrics,
					log: deps.log,
				})
			) {
				result.failed += 1;
				continue;
			}
			delivery = deps.store.getAutoNarrowOpinionDelivery(questionId);
		}
		if (
			deps.opinionControl?.mode === "auto" &&
			(!delivery || delivery.state === "gone")
		) {
			deps.log?.(
				`[auto-narrow-gate] ${questionId}: opinion delivery trace unavailable`,
			);
			result.failed += 1;
			continue;
		}
		if (deps.opinionControl?.mode !== "auto") {
			result.skipped += 1;
			continue;
		}
		const db = deps.openCommDb("flywheel");
		try {
			const outcome = deps.store.commitAutoNarrowSourceIfEligible({
				questionId,
				at,
				writeSource: ({
					expectedOwner,
					projectedThroughSourceRowId,
					envelope,
				}) =>
					db.insertAutoNarrowApprovalWithSource({
						project: "flywheel",
						expectedOwner,
						projectedThroughSourceRowId,
						envelope,
					}),
			});
			if (outcome.status === "written") result.written += 1;
			else if (outcome.status === "replayed") result.replayed += 1;
			else result.skipped += 1;
		} catch (error) {
			result.failed += 1;
			const detail = error instanceof Error ? error.message : String(error);
			deps.log?.(`[auto-narrow-gate] ${questionId}: ${detail}`);
			if (/SQLITE_(?:BUSY|LOCKED)|database is (?:locked|busy)/i.test(detail)) {
				break;
			}
		} finally {
			db.close();
		}
	}
	return result;
}
