import type { LeadEventRow } from "../StateStore.js";
import {
	type ShipReadyHandledOutcome,
	type WorkflowShipReadyArm,
	type WorkflowShipReadyNotice,
	workflowShipReadyUid,
} from "../workflow-ship-ready.js";
import type { PrMergeInfo } from "./external-merge-reconcile.js";
import type { FounderThreadNotifyResult } from "./founder-thread-notifier.js";
import type { LeadEventEnvelope } from "./lead-runtime.js";
import { leadEventEnvelopeFromJournalRow } from "./legacy-lead-event-reconciler.js";
import type { DurableQueueReceipt } from "./runtime-registry.js";

const DEFINITIVE_CACHE_TTL_MS = 15_000;
const PROBE_TIMEOUT_MS = 2_500;
const PROBE_BUDGET_PER_MINUTE = 6;
const UNKNOWN_BACKOFF_MS = [30_000, 60_000, 120_000, 240_000, 300_000] as const;

type WorkflowShipReadyLead = {
	leadId: string;
	chatChannel: string;
	botToken?: string;
};

type WorkflowShipReadyArmStore = {
	appendLeadEvent(
		leadId: string,
		eventId: string,
		eventType: string,
		payload: string,
		sessionKey?: string,
	): number;
	getLeadEventBySeq(seq: number): LeadEventRow | null;
	getChatThreadByIssue(
		issueId: string,
		channelId?: string,
	):
		| {
				thread_id: string;
				channel_id: string;
				lead_id: string | null;
				archived_at: string | null;
		  }
		| undefined;
	hasWorkflowShipReadyFounderApproval(runId: string): boolean;
};

export interface WorkflowShipReadyArmDeps {
	store: WorkflowShipReadyArmStore;
	resolveLead(notice: WorkflowShipReadyNotice): WorkflowShipReadyLead;
	enqueueLeadEvent(envelope: LeadEventEnvelope): DurableQueueReceipt;
	emitFounderThreadNotification(options: {
		questionId: string;
		checkpoint: "ship_ready";
		executionId: string;
		issueId: string;
		issueIdentifier?: string;
		projectName: string;
		summary: string;
		ageMinutes: number;
		thread?: ReturnType<WorkflowShipReadyArmStore["getChatThreadByIssue"]>;
		botToken?: string;
		ownerUserId?: string;
	}): Promise<FounderThreadNotifyResult>;
	ownerUserId?: string;
	projectRootFor(projectName: string): string | undefined;
	checkPrMerge(
		projectRoot: string,
		prNumber: number,
		timeoutMs?: number,
	): Promise<PrMergeInfo>;
	now?: () => number;
	log?: (message: string) => void;
}

function evidenceSummary(notice: WorkflowShipReadyNotice): string {
	const evidence = notice.evidence.qaPassed
		? `${notice.evidence.prNumber ? `PR #${notice.evidence.prNumber}` : "PR 未绑定"}${
				notice.evidence.headSha
					? ` (head ${notice.evidence.headSha.slice(0, 8)})`
					: ""
			} · QA passed`
		: "⚠️ 证据缺失（无 qa_passed claim）";
	return `${evidence}\n引擎已走完 ${notice.templateId} 流程，停在 founder gate 等 ship。`;
}

/** Composition-root arm: both delivery paths share one notice contract. */
export function createWorkflowShipReadyArm(
	deps: WorkflowShipReadyArmDeps,
): WorkflowShipReadyArm {
	const classifyShipHandled = createWorkflowShipReadyHandledClassifier({
		hasFounderApproval: (runId) =>
			deps.store.hasWorkflowShipReadyFounderApproval(runId),
		projectRootFor: deps.projectRootFor,
		checkPrMerge: deps.checkPrMerge,
		now: deps.now,
		log: deps.log,
	});

	return {
		async queueLeadNotice(notice) {
			const uid = workflowShipReadyUid(notice);
			const lead = deps.resolveLead(notice);
			const thread = deps.store.getChatThreadByIssue(
				notice.issueId,
				lead.chatChannel,
			);
			const payload = {
				event_type: "workflow_ship_ready",
				execution_id: notice.sourceExecutionId,
				issue_id: notice.issueId,
				...(notice.issueIdentifier
					? { issue_identifier: notice.issueIdentifier }
					: {}),
				project_name: notice.projectName,
				status: "ship_ready",
				summary: evidenceSummary(notice),
				...(lead.chatChannel ? { chat_channel: lead.chatChannel } : {}),
				...(thread?.thread_id ? { chat_thread_id: thread.thread_id } : {}),
				...(notice.evidence.prNumber
					? { pr_number: notice.evidence.prNumber }
					: {}),
				stage_context:
					"Workflow engine reached the founder ship gate; notify the founder and coordinate the ship decision.",
			};
			const eventId = `workflow_ship_ready:${uid}`;
			const seq = deps.store.appendLeadEvent(
				lead.leadId,
				eventId,
				"workflow_ship_ready",
				JSON.stringify(payload),
				notice.sourceExecutionId,
			);
			const row = deps.store.getLeadEventBySeq(seq);
			if (!row) {
				throw new Error(`workflow_ship_ready_journal_row_missing:${seq}`);
			}
			const receipt = deps.enqueueLeadEvent(
				leadEventEnvelopeFromJournalRow(row, 1),
			);
			return { queued: receipt.queued };
		},

		async postFounderCard(notice) {
			const lead = deps.resolveLead(notice);
			const result = await deps.emitFounderThreadNotification({
				questionId: workflowShipReadyUid(notice),
				checkpoint: "ship_ready",
				executionId: notice.sourceExecutionId,
				issueId: notice.issueId,
				...(notice.issueIdentifier
					? { issueIdentifier: notice.issueIdentifier }
					: {}),
				projectName: notice.projectName,
				summary: evidenceSummary(notice),
				ageMinutes: notice.ageMinutes,
				thread: deps.store.getChatThreadByIssue(
					notice.issueId,
					lead.chatChannel,
				),
				botToken: lead.botToken,
				ownerUserId: deps.ownerUserId,
			});
			if (result.kind === "posted") return { kind: "posted" };
			if (result.kind === "transient_failed") {
				return {
					kind: "transient",
					reason: "transient_failed",
					...(result.retryAfterMs !== undefined
						? { retryAfterMs: result.retryAfterMs }
						: {}),
				};
			}
			if (result.kind === "skipped") {
				const reason = result.skipReason ?? "skipped";
				return result.skipReason === "no_chat_thread"
					? { kind: "transient", reason }
					: { kind: "permanent", reason };
			}
			return { kind: "permanent", reason: "permanent_failed" };
		},

		classifyShipHandled,

		async classifyRunnerShipMerged(batch) {
			const outcomes = new Map<
				string,
				{
					state: "merged" | "closed" | "open" | "unknown";
					headRefOid?: string;
				}
			>();
			await Promise.all(
				batch.map(async (candidate) => {
					const prNumber = candidate.prNumber;
					const projectRoot = deps.projectRootFor(candidate.projectName);
					if (!prNumber || !projectRoot) {
						outcomes.set(candidate.questionId, { state: "unknown" });
						return;
					}
					try {
						const info = await deps.checkPrMerge(
							projectRoot,
							prNumber,
							PROBE_TIMEOUT_MS,
						);
						outcomes.set(candidate.questionId, {
							state: info.state,
							...(info.headRefOid
								? { headRefOid: info.headRefOid.toLowerCase() }
								: {}),
						});
					} catch (error) {
						deps.log?.(
							`runner-ship merge probe failed for ${candidate.questionId}: ${error instanceof Error ? error.message : String(error)}`,
						);
						outcomes.set(candidate.questionId, { state: "unknown" });
					}
				}),
			);
			return outcomes;
		},
	};
}

type ShipReadyClassifierDeps = {
	hasFounderApproval(runId: string): boolean;
	projectRootFor(projectName: string): string | undefined;
	checkPrMerge(
		projectRoot: string,
		prNumber: number,
		timeoutMs?: number,
	): Promise<PrMergeInfo>;
	now?: () => number;
	log?: (message: string) => void;
};

type ProbeState = {
	attempts: number;
	nextAttemptAtMs: number;
	lastRawProbeAt?: number;
};

type ProbeCandidate = {
	uid: string;
	notice: WorkflowShipReadyNotice;
	projectRoot: string;
	prNumber: number;
	probeKey: string;
	state: ProbeState;
};

/**
 * Read-only handled guard with definitive caching, single-flight, a six/minute
 * project budget, and fair never-probed-first rotation.
 */
export function createWorkflowShipReadyHandledClassifier(
	deps: ShipReadyClassifierDeps,
): WorkflowShipReadyArm["classifyShipHandled"] {
	const now = deps.now ?? Date.now;
	const states = new Map<string, ProbeState>();
	const cache = new Map<string, { info: PrMergeInfo; observedAtMs: number }>();
	const inFlight = new Map<string, Promise<PrMergeInfo>>();
	const projectProbeTimes = new Map<string, number[]>();

	const afterNoMerge = (
		notice: WorkflowShipReadyNotice,
	): ShipReadyHandledOutcome =>
		deps.hasFounderApproval(notice.runId)
			? { kind: "handled", reason: "founder_approved" }
			: { kind: "unhandled" };

	return async (batch) => {
		const active = new Set(batch.map((item) => workflowShipReadyUid(item)));
		const activeProbeKeys = new Set(
			batch.flatMap((item) =>
				item.evidence.prNumber
					? [`${item.projectName}:${item.evidence.prNumber}`]
					: [],
			),
		);
		const outcomes = new Map<string, ShipReadyHandledOutcome>();
		const raw: ProbeCandidate[] = [];
		const nowMs = now();
		try {
			for (const item of batch) {
				const uid = workflowShipReadyUid(item);
				try {
					if (deps.hasFounderApproval(item.runId)) {
						outcomes.set(uid, {
							kind: "handled",
							reason: "founder_approved",
						});
						continue;
					}
					const prNumber = item.evidence.prNumber;
					if (!prNumber) {
						outcomes.set(uid, afterNoMerge(item));
						continue;
					}
					const projectRoot = deps.projectRootFor(item.projectName);
					if (!projectRoot) {
						outcomes.set(uid, { kind: "unknown" });
						continue;
					}
					const probeKey = `${item.projectName}:${prNumber}`;
					const cached = cache.get(probeKey);
					if (
						cached &&
						(cached.info.state === "merged" ||
							nowMs - cached.observedAtMs <= DEFINITIVE_CACHE_TTL_MS)
					) {
						outcomes.set(
							uid,
							cached.info.state === "merged"
								? { kind: "handled", reason: "pr_merged" }
								: afterNoMerge(item),
						);
						continue;
					}
					const state = states.get(uid) ?? {
						attempts: 0,
						nextAttemptAtMs: 0,
					};
					states.set(uid, state);
					if (nowMs < state.nextAttemptAtMs) {
						outcomes.set(uid, { kind: "unknown" });
						continue;
					}
					raw.push({
						uid,
						notice: item,
						projectRoot,
						prNumber,
						probeKey,
						state,
					});
				} catch (error) {
					deps.log?.(
						`ship-ready handled classification failed for ${uid}: ${error instanceof Error ? error.message : String(error)}`,
					);
					outcomes.set(uid, { kind: "unknown" });
				}
			}

			const byProject = new Map<string, Map<string, ProbeCandidate[]>>();
			for (const candidate of raw) {
				const project =
					byProject.get(candidate.notice.projectName) ??
					new Map<string, ProbeCandidate[]>();
				const group = project.get(candidate.probeKey) ?? [];
				group.push(candidate);
				project.set(candidate.probeKey, group);
				byProject.set(candidate.notice.projectName, project);
			}

			const jobs: Array<Promise<void>> = [];
			for (const [projectName, grouped] of byProject) {
				const recent = (projectProbeTimes.get(projectName) ?? []).filter(
					(timestamp) => nowMs - timestamp < 60_000,
				);
				projectProbeTimes.set(projectName, recent);
				let remaining = Math.max(0, PROBE_BUDGET_PER_MINUTE - recent.length);
				const groups = [...grouped.values()].sort((left, right) => {
					const leftLast = Math.min(
						...left.map((candidate) =>
							candidate.state.lastRawProbeAt === undefined
								? Number.NEGATIVE_INFINITY
								: candidate.state.lastRawProbeAt,
						),
					);
					const rightLast = Math.min(
						...right.map((candidate) =>
							candidate.state.lastRawProbeAt === undefined
								? Number.NEGATIVE_INFINITY
								: candidate.state.lastRawProbeAt,
						),
					);
					return (
						leftLast - rightLast || left[0]!.uid.localeCompare(right[0]!.uid)
					);
				});
				for (const group of groups) {
					let probe = inFlight.get(group[0]!.probeKey);
					if (!probe) {
						if (remaining <= 0) {
							for (const candidate of group) {
								outcomes.set(candidate.uid, { kind: "unknown" });
							}
							continue;
						}
						remaining -= 1;
						recent.push(nowMs);
						for (const candidate of group) {
							candidate.state.lastRawProbeAt = nowMs;
						}
						const first = group[0]!;
						probe = Promise.resolve()
							.then(() =>
								deps.checkPrMerge(
									first.projectRoot,
									first.prNumber,
									PROBE_TIMEOUT_MS,
								),
							)
							.catch(() => ({ state: "unknown" }) as PrMergeInfo)
							.finally(() => inFlight.delete(first.probeKey));
						inFlight.set(first.probeKey, probe);
					}
					jobs.push(
						probe.then((info) => {
							if (
								info.state === "merged" ||
								info.state === "open" ||
								info.state === "closed"
							) {
								cache.set(group[0]!.probeKey, { info, observedAtMs: nowMs });
							}
							for (const candidate of group) {
								if (info.state === "merged") {
									candidate.state.attempts = 0;
									candidate.state.nextAttemptAtMs = 0;
									outcomes.set(candidate.uid, {
										kind: "handled",
										reason: "pr_merged",
									});
								} else if (info.state === "open" || info.state === "closed") {
									candidate.state.attempts = 0;
									candidate.state.nextAttemptAtMs = 0;
									try {
										outcomes.set(candidate.uid, afterNoMerge(candidate.notice));
									} catch {
										outcomes.set(candidate.uid, { kind: "unknown" });
									}
								} else {
									candidate.state.attempts += 1;
									candidate.state.nextAttemptAtMs =
										nowMs +
										UNKNOWN_BACKOFF_MS[
											Math.min(
												candidate.state.attempts - 1,
												UNKNOWN_BACKOFF_MS.length - 1,
											)
										]!;
									outcomes.set(candidate.uid, { kind: "unknown" });
								}
							}
						}),
					);
				}
			}
			await Promise.all(jobs);
			return outcomes;
		} finally {
			for (const uid of states.keys()) {
				if (!active.has(uid)) states.delete(uid);
			}
			for (const probeKey of cache.keys()) {
				if (!activeProbeKeys.has(probeKey)) cache.delete(probeKey);
			}
		}
	};
}
