import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LeadEventRow } from "../StateStore.js";
import {
	type ShipReadyHandledOutcome,
	type WorkflowRunnerShipMergeCandidate,
	type WorkflowRunnerShipMergeProbe,
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
const RUNNER_SHIP_DEFINITIVE_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 2_500;
const REST_PROBE_TIMEOUT_MS = 10_000;
const PROBE_BUDGET_PER_MINUTE = 6;
const UNKNOWN_BACKOFF_MS = [30_000, 60_000, 120_000, 240_000, 300_000] as const;
const execFileP = promisify(execFile);

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
		probeRepoSlug?: string,
	): Promise<PrMergeInfo>;
	enrichPrHead?: RunnerShipClassifierDeps["enrichPrHead"];
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
	const classifyRunnerShipMerged = createWorkflowRunnerShipMergedClassifier({
		projectRootFor: deps.projectRootFor,
		checkPrMerge: deps.checkPrMerge,
		enrichPrHead:
			deps.enrichPrHead ?? (async () => ({ ok: false, reason: "spawn" })),
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

		classifyRunnerShipMerged,
	};
}

export type EnrichPrHeadResult =
	| { ok: true; headSha: string; mergedAt: string }
	| {
			ok: false;
			reason:
				| "timeout"
				| "spawn"
				| "nonzero"
				| "bad_json"
				| "not_merged"
				| "invalid_head"
				| "invalid_pr_number";
			rawHead?: string;
	  };

/** REST-only head authority used when GraphQL cannot supply a valid merge head. */
export async function enrichPrHeadViaGh(
	projectRoot: string,
	probeRepoSlug: string | null,
	prNumber: number,
	timeoutMs = 10_000,
): Promise<EnrichPrHeadResult> {
	if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
		return { ok: false, reason: "invalid_pr_number" };
	}
	const endpoint = probeRepoSlug
		? `repos/${probeRepoSlug}/pulls/${prNumber}`
		: `repos/{owner}/{repo}/pulls/${prNumber}`;
	try {
		const { stdout } = await execFileP("gh", ["api", endpoint], {
			cwd: projectRoot,
			timeout: Math.max(1, timeoutMs),
		});
		let parsed: unknown;
		try {
			parsed = JSON.parse(stdout);
		} catch {
			return { ok: false, reason: "bad_json" };
		}
		const payload = parsed as {
			merged_at?: unknown;
			head?: { sha?: unknown } | null;
		};
		const rawHead = boundedProbeText(payload.head?.sha);
		if (typeof payload.merged_at !== "string" || !payload.merged_at.trim()) {
			return {
				ok: false,
				reason: "not_merged",
				...(rawHead !== undefined ? { rawHead } : {}),
			};
		}
		const headSha = normalizedHead(payload.head?.sha);
		if (!headSha) {
			return {
				ok: false,
				reason: "invalid_head",
				...(rawHead !== undefined ? { rawHead } : {}),
			};
		}
		return { ok: true, headSha, mergedAt: payload.merged_at };
	} catch (error) {
		const processError = error as NodeJS.ErrnoException & {
			killed?: boolean;
			signal?: string;
		};
		const reason =
			processError.killed || processError.signal === "SIGTERM"
				? "timeout"
				: processError.code === "ENOENT" || processError.code === "EACCES"
					? "spawn"
					: "nonzero";
		return {
			ok: false,
			reason,
		};
	}
}

type RunnerShipClassifierDeps = {
	projectRootFor(projectName: string): string | undefined;
	checkPrMerge(
		projectRoot: string,
		prNumber: number,
		timeoutMs?: number,
		probeRepoSlug?: string,
	): Promise<PrMergeInfo>;
	enrichPrHead(
		projectRoot: string,
		probeRepoSlug: string | null,
		prNumber: number,
		timeoutMs: number,
	): Promise<EnrichPrHeadResult>;
	now?: () => number;
	log?: (message: string) => void;
};

type RunnerProbeState = {
	graphqlAttempts: number;
	graphqlNextAttemptAtMs: number;
	restAttempts: number;
	restNextAttemptAtMs: number;
	lastAttemptAt?: number;
	lastGraphqlAt?: number;
	mergedNeedsRest?: { rawHeadRefOid?: string };
};

type RunnerProbeTarget = {
	candidate: WorkflowRunnerShipMergeCandidate;
	key: string;
	projectRoot: string;
	prNumber: number;
	probeRepoSlug: string | null;
	fingerprint?: string;
	state: RunnerProbeState;
	counts: Map<string, { graphql: number; rest: number }>;
};

function countRunnerProbe(
	target: RunnerProbeTarget,
	kind: "graphql" | "rest",
): void {
	const count = target.counts.get(target.candidate.projectName) ?? {
		graphql: 0,
		rest: 0,
	};
	count[kind] += 1;
	target.counts.set(target.candidate.projectName, count);
}

function boundedProbeText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return value.slice(0, 80);
}

function normalizedHead(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.toLowerCase();
	return /^[0-9a-f]{40}$/.test(normalized) ? normalized : undefined;
}

/**
 * Epoch-2 runner merge classifier. Durable observations enter through REST
 * revalidation; raw GraphQL and REST attempts share one fair project budget.
 */
export function createWorkflowRunnerShipMergedClassifier(
	deps: RunnerShipClassifierDeps,
): NonNullable<WorkflowShipReadyArm["classifyRunnerShipMerged"]> {
	const now = deps.now ?? Date.now;
	const states = new Map<string, RunnerProbeState>();
	const cache = new Map<
		string,
		{
			probe: WorkflowRunnerShipMergeProbe;
			observedAtMs: number;
			hydratedHead?: string;
		}
	>();
	const inFlight = new Map<string, Promise<WorkflowRunnerShipMergeProbe>>();
	const projectProbeTimes = new Map<string, number[]>();
	const legacyMergedPins = new Map<string, WorkflowRunnerShipMergeProbe>();

	const reserveProjectBudget = (projectName: string, atMs: number): boolean => {
		const recent = (projectProbeTimes.get(projectName) ?? []).filter(
			(timestamp) => atMs - timestamp < 60_000,
		);
		projectProbeTimes.set(projectName, recent);
		if (recent.length >= PROBE_BUDGET_PER_MINUTE) return false;
		recent.push(atMs);
		return true;
	};

	const markUnknown = (
		state: RunnerProbeState,
		atMs: number,
		namespace: "graphql" | "rest",
	): WorkflowRunnerShipMergeProbe => {
		if (namespace === "graphql") {
			state.graphqlAttempts += 1;
			state.graphqlNextAttemptAtMs =
				atMs +
				UNKNOWN_BACKOFF_MS[
					Math.min(state.graphqlAttempts - 1, UNKNOWN_BACKOFF_MS.length - 1)
				]!;
		} else {
			state.restAttempts += 1;
			state.restNextAttemptAtMs =
				atMs +
				UNKNOWN_BACKOFF_MS[
					Math.min(state.restAttempts - 1, UNKNOWN_BACKOFF_MS.length - 1)
				]!;
		}
		return { state: "unknown" };
	};

	const restProbe = async (
		target: RunnerProbeTarget,
		atMs: number,
		failureKind: "head_enrichment" | "hydration_revalidation",
	): Promise<WorkflowRunnerShipMergeProbe> => {
		if (!reserveProjectBudget(target.candidate.projectName, atMs)) {
			return failureKind === "head_enrichment"
				? {
						state: "merged",
						rawHeadRefOid: target.state.mergedNeedsRest?.rawHeadRefOid,
						evidence: "current",
						...(target.fingerprint ? { fingerprint: target.fingerprint } : {}),
					}
				: { state: "unknown" };
		}
		target.state.lastAttemptAt = atMs;
		countRunnerProbe(target, "rest");
		let result: EnrichPrHeadResult;
		try {
			result = await deps.enrichPrHead(
				target.projectRoot,
				target.probeRepoSlug,
				target.prNumber,
				REST_PROBE_TIMEOUT_MS,
			);
		} catch (error) {
			deps.log?.(
				`runner-ship REST probe failed for ${target.candidate.questionId}: ${error instanceof Error ? error.message : String(error)}`,
			);
			result = {
				ok: false,
				reason: "nonzero",
			};
		}
		if (!result.ok) {
			const unknown = markUnknown(target.state, atMs, "rest");
			if (failureKind === "head_enrichment") {
				return {
					state: "merged",
					rawHeadRefOid: target.state.mergedNeedsRest?.rawHeadRefOid,
					evidence: "current",
					...(target.fingerprint ? { fingerprint: target.fingerprint } : {}),
					failure: {
						kind: failureKind,
						reason: result.reason,
						notify: target.state.restAttempts >= 5,
					},
				};
			}
			return {
				...unknown,
				failure: {
					kind: failureKind,
					reason: result.reason,
					notify: target.state.restAttempts >= 5,
				},
			};
		}
		const headSha = normalizedHead(result.headSha);
		if (!headSha) return markUnknown(target.state, atMs, "rest");
		target.state.mergedNeedsRest = undefined;
		target.state.restAttempts = 0;
		target.state.restNextAttemptAtMs = 0;
		return {
			state: "merged",
			headRefOid: headSha,
			rawHeadRefOid: boundedProbeText(result.headSha),
			evidence:
				failureKind === "hydration_revalidation" ? "verified" : "current",
			...(target.fingerprint ? { fingerprint: target.fingerprint } : {}),
		};
	};

	const probe = async (
		target: RunnerProbeTarget,
		atMs: number,
	): Promise<WorkflowRunnerShipMergeProbe> => {
		if (target.candidate.mergedObserved?.status === "valid") {
			return restProbe(target, atMs, "hydration_revalidation");
		}
		if (target.candidate.mergedObserved?.status === "needs_rest") {
			return restProbe(target, atMs, "head_enrichment");
		}
		if (target.state.mergedNeedsRest) {
			return restProbe(target, atMs, "head_enrichment");
		}
		if (
			target.state.lastGraphqlAt !== undefined &&
			atMs - target.state.lastGraphqlAt < RUNNER_SHIP_DEFINITIVE_TTL_MS
		) {
			return { state: "unknown" };
		}
		if (!reserveProjectBudget(target.candidate.projectName, atMs)) {
			return { state: "unknown" };
		}
		target.state.lastAttemptAt = atMs;
		target.state.lastGraphqlAt = atMs;
		countRunnerProbe(target, "graphql");
		let info: PrMergeInfo;
		try {
			info = await deps.checkPrMerge(
				target.projectRoot,
				target.prNumber,
				PROBE_TIMEOUT_MS,
				target.probeRepoSlug ?? undefined,
			);
		} catch (error) {
			deps.log?.(
				`runner-ship merge probe failed for ${target.candidate.questionId}: ${error instanceof Error ? error.message : String(error)}`,
			);
			info = { state: "unknown" };
		}
		if (info.state === "unknown") {
			return markUnknown(target.state, atMs, "graphql");
		}
		if (info.state === "open" || info.state === "closed") {
			target.state.graphqlAttempts = 0;
			target.state.graphqlNextAttemptAtMs = 0;
			return { state: info.state };
		}
		const headSha = normalizedHead(info.headRefOid);
		if (!headSha) {
			target.state.graphqlAttempts = 0;
			target.state.graphqlNextAttemptAtMs = 0;
			target.state.mergedNeedsRest = {
				rawHeadRefOid: boundedProbeText(info.rawHeadRefOid ?? info.headRefOid),
			};
			return restProbe(target, atMs, "head_enrichment");
		}
		target.state.graphqlAttempts = 0;
		target.state.graphqlNextAttemptAtMs = 0;
		return {
			state: "merged",
			headRefOid: headSha,
			rawHeadRefOid: boundedProbeText(
				(info as PrMergeInfo & { rawHeadRefOid?: string }).rawHeadRefOid ??
					info.headRefOid,
			),
			evidence: "current",
			...(target.fingerprint ? { fingerprint: target.fingerprint } : {}),
		};
	};

	return async (batch) => {
		const atMs = now();
		const outcomes = new Map<string, WorkflowRunnerShipMergeProbe>();
		const targets = new Map<string, RunnerProbeTarget[]>();
		const active = new Set<string>();
		const counts = new Map<string, { graphql: number; rest: number }>();

		for (const candidate of batch) {
			const authority = candidate.authority;
			if (
				authority.status !== "resolved" &&
				authority.status !== "legacy_missing"
			) {
				outcomes.set(candidate.questionId, { state: "unknown" });
				continue;
			}
			const prNumber = authority.prNumber;
			const projectRoot = deps.projectRootFor(candidate.projectName);
			if (!projectRoot) {
				outcomes.set(candidate.questionId, { state: "unknown" });
				continue;
			}
			const fingerprint =
				authority.status === "resolved"
					? (candidate.fingerprint ??
						`${authority.repoIdentity}:${authority.probeRepoSlug}:${authority.prNumber}`)
					: undefined;
			const key =
				authority.status === "resolved"
					? `${candidate.projectName}:${fingerprint}`
					: `${candidate.projectName}:legacy:${prNumber}`;
			active.add(key);
			const legacyPin = legacyMergedPins.get(key);
			if (legacyPin) {
				outcomes.set(candidate.questionId, legacyPin);
				continue;
			}
			const cached = cache.get(key);
			const hydratedHead =
				candidate.mergedObserved?.status === "valid"
					? normalizedHead(candidate.mergedObserved.headSha)
					: undefined;
			if (
				cached &&
				(cached.probe.state === "merged" ||
					atMs - cached.observedAtMs < RUNNER_SHIP_DEFINITIVE_TTL_MS) &&
				(!candidate.mergedObserved ||
					(candidate.mergedObserved.status === "valid" &&
						cached.hydratedHead === hydratedHead) ||
					(candidate.mergedObserved.status === "needs_rest" &&
						cached.probe.state === "merged" &&
						cached.probe.headRefOid !== undefined))
			) {
				outcomes.set(candidate.questionId, cached.probe);
				continue;
			}
			const state = states.get(key) ?? {
				graphqlAttempts: 0,
				graphqlNextAttemptAtMs: 0,
				restAttempts: 0,
				restNextAttemptAtMs: 0,
			};
			states.set(key, state);
			const restState = Boolean(
				candidate.mergedObserved || state.mergedNeedsRest,
			);
			const nextAttemptAtMs = restState
				? state.restNextAttemptAtMs
				: state.graphqlNextAttemptAtMs;
			if (atMs < nextAttemptAtMs) {
				outcomes.set(
					candidate.questionId,
					state.mergedNeedsRest && !candidate.mergedObserved
						? {
								state: "merged",
								rawHeadRefOid: state.mergedNeedsRest.rawHeadRefOid,
								evidence: "current",
								...(fingerprint ? { fingerprint } : {}),
							}
						: { state: "unknown" },
				);
				continue;
			}
			const target: RunnerProbeTarget = {
				candidate,
				key,
				projectRoot,
				prNumber,
				probeRepoSlug:
					authority.status === "resolved" ? authority.probeRepoSlug : null,
				...(fingerprint ? { fingerprint } : {}),
				state,
				counts,
			};
			const group = targets.get(key) ?? [];
			group.push(target);
			targets.set(key, group);
		}

		const ordered = [...targets.values()].sort((left, right) => {
			const leftAt = left[0]!.state.lastAttemptAt ?? Number.NEGATIVE_INFINITY;
			const rightAt = right[0]!.state.lastAttemptAt ?? Number.NEGATIVE_INFINITY;
			return leftAt - rightAt || left[0]!.key.localeCompare(right[0]!.key);
		});
		await Promise.all(
			ordered.map(async (group) => {
				const first = group[0]!;
				let promise = inFlight.get(first.key);
				if (!promise) {
					promise = probe(first, atMs).finally(() =>
						inFlight.delete(first.key),
					);
					inFlight.set(first.key, promise);
				}
				const result = await promise;
				if (
					(result.state === "merged" && result.headRefOid !== undefined) ||
					result.state === "open" ||
					result.state === "closed"
				) {
					const hydratedHead =
						first.candidate.mergedObserved?.status === "valid"
							? normalizedHead(first.candidate.mergedObserved.headSha)
							: result.state === "merged"
								? result.headRefOid
								: undefined;
					cache.set(first.key, {
						probe: result,
						observedAtMs: atMs,
						...(hydratedHead ? { hydratedHead } : {}),
					});
				}
				if (
					first.candidate.authority.status === "legacy_missing" &&
					result.state === "merged"
				) {
					legacyMergedPins.set(first.key, result);
				}
				for (const target of group)
					outcomes.set(target.candidate.questionId, result);
			}),
		);

		for (const key of states.keys()) {
			if (!active.has(key)) states.delete(key);
		}
		for (const key of cache.keys()) {
			if (!active.has(key)) cache.delete(key);
		}
		for (const [projectName, count] of counts) {
			deps.log?.(
				`runner-ship probe attempts project=${projectName} graphql=${count.graphql} rest=${count.rest}`,
			);
		}
		return outcomes;
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
