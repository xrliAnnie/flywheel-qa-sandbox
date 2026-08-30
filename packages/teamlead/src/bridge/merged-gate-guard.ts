import type { MergedGateGuardFailureRow } from "../StateStore.js";
import {
	checkPrMergeViaGh,
	type PrMergeInfo,
} from "./external-merge-reconcile.js";

export type MergedGateGuardSource =
	| "text"
	| "reaction"
	| "action_drain"
	| "deferred_rebind"
	| "gate_card"
	| "rebound";

export interface MergedGateGuardStore {
	ensureMergedGateGuardFailure(input: {
		questionId: string;
		source: MergedGateGuardSource;
		executionId: string;
		issueId: string;
		projectName: string;
		nowMs: number;
	}): MergedGateGuardFailureRow;
	recordMergedGateGuardUnknown(input: {
		questionId: string;
		source: MergedGateGuardSource;
		nowMs: number;
		nextRetryMs: number;
		error: string;
		terminal: boolean;
	}): MergedGateGuardFailureRow;
	resolveMergedGateGuardFailure(
		questionId: string,
		source: MergedGateGuardSource,
	): void;
	invalidateMergedGateArtifacts(input: {
		executionId: string;
		issueId: string;
		projectName: string;
		questionId: string;
		prNumber: number;
		source: MergedGateGuardSource;
		observedMergeCommitOid?: string;
	}): {
		invalidatedDeferredCount: number;
		supersededActionCount: number;
	};
}

export interface MergedGateGuardArgs {
	executionId: string;
	issueId: string;
	questionId: string;
	projectName: string;
	projectRoot?: string;
	prNumber?: number;
	source: MergedGateGuardSource;
}

export type MergedGateGuardResult =
	| { kind: "continue"; prState: "open" | "closed" }
	| { kind: "suppress_merged"; cleanupComplete: boolean }
	| {
			kind: "retry_later";
			reason: "unknown" | "backoff" | "budget" | "missing_binding";
	  }
	| {
			kind: "terminal_unavailable";
			reason: "unknown_exhausted";
	  };

export type MergedGateGuard = (
	args: MergedGateGuardArgs,
) => Promise<MergedGateGuardResult>;

interface CacheEntry {
	info: PrMergeInfo;
	observedAtMs: number;
}

const CACHE_TTL_MS = 15_000;
const PROBE_TIMEOUT_MS = 2_500;
const PROBE_BUDGET_PER_MINUTE = 6;
const FAILURE_DEADLINE_MS = 15 * 60_000;
const BACKOFF_MS = [30_000, 60_000, 120_000, 240_000, 300_000] as const;

/**
 * Shared last-mile check immediately before any stale-gate recovery output.
 * MERGED is monotonic in cache and suppresses before best-effort cleanup.
 */
export function createMergedGateGuard(deps: {
	store: MergedGateGuardStore;
	retireQuestion: (
		questionId: string,
		executionId: string,
		projectName: string,
	) => void;
	checkPrMerge?: (
		projectRoot: string,
		prNumber: number,
		timeoutMs?: number,
	) => Promise<PrMergeInfo>;
	now?: () => number;
	env?: Record<string, string | undefined>;
	log?: (message: string) => void;
}): MergedGateGuard {
	const now = deps.now ?? Date.now;
	const checkPrMerge = deps.checkPrMerge ?? checkPrMergeViaGh;
	const cache = new Map<string, CacheEntry>();
	const inFlight = new Map<string, Promise<PrMergeInfo>>();
	const projectProbeTimes = new Map<string, number[]>();

	function recordTerminal(
		args: MergedGateGuardArgs,
		row: MergedGateGuardFailureRow,
		nowMs: number,
		error: string,
	): void {
		if (row.terminal) return;
		deps.store.recordMergedGateGuardUnknown({
			questionId: args.questionId,
			source: args.source,
			nowMs,
			nextRetryMs: nowMs,
			error,
			terminal: true,
		});
	}

	async function suppressMerged(
		args: MergedGateGuardArgs & { prNumber: number },
		info: PrMergeInfo,
	): Promise<MergedGateGuardResult> {
		let cleanupComplete = true;
		try {
			deps.retireQuestion(args.questionId, args.executionId, args.projectName);
		} catch (error) {
			cleanupComplete = false;
			deps.log?.(
				`[merged-gate-guard] CommDB retire failed for ${args.questionId}: ${String(error)}`,
			);
		}
		try {
			deps.store.invalidateMergedGateArtifacts({
				executionId: args.executionId,
				issueId: args.issueId,
				projectName: args.projectName,
				questionId: args.questionId,
				prNumber: args.prNumber,
				source: args.source,
				observedMergeCommitOid: info.mergeCommitOid,
			});
		} catch (error) {
			cleanupComplete = false;
			deps.log?.(
				`[merged-gate-guard] StateStore cleanup failed for ${args.questionId}: ${String(error)}`,
			);
		}
		try {
			deps.store.resolveMergedGateGuardFailure(args.questionId, args.source);
		} catch (error) {
			cleanupComplete = false;
			deps.log?.(
				`[merged-gate-guard] failure-row resolve failed for ${args.questionId}: ${String(error)}`,
			);
		}
		return { kind: "suppress_merged", cleanupComplete };
	}

	return async (args) => {
		const nowMs = now();
		const projectRoot = args.projectRoot;
		const prNumber = args.prNumber;
		const cacheKey =
			projectRoot && prNumber && prNumber > 0
				? `${args.projectName}:${prNumber}`
				: undefined;
		const cached = cacheKey ? cache.get(cacheKey) : undefined;
		if (
			cached &&
			prNumber !== undefined &&
			(cached.info.state === "merged" ||
				nowMs - cached.observedAtMs <= CACHE_TTL_MS)
		) {
			if (cached.info.state === "merged") {
				return suppressMerged({ ...args, prNumber }, cached.info);
			}
			if (cached.info.state === "open" || cached.info.state === "closed") {
				deps.store.resolveMergedGateGuardFailure(args.questionId, args.source);
				return { kind: "continue", prState: cached.info.state };
			}
		}

		if (!projectRoot || !prNumber || !cacheKey) {
			// A PR number is patched independently from the reviewed head. Its
			// absence means the guard cannot ask GitHub yet, not that GitHub stayed
			// UNKNOWN through the bounded retry budget. Keep the founder decision
			// parked and let a later pass probe once the binding arrives. Resolve a
			// legacy missing-binding terminal row so that pass can re-arm it.
			deps.store.resolveMergedGateGuardFailure(args.questionId, args.source);
			return { kind: "retry_later", reason: "missing_binding" };
		}

		const row = deps.store.ensureMergedGateGuardFailure({
			questionId: args.questionId,
			source: args.source,
			executionId: args.executionId,
			issueId: args.issueId,
			projectName: args.projectName,
			nowMs,
		});
		if (row.terminal) {
			return { kind: "terminal_unavailable", reason: "unknown_exhausted" };
		}
		if (nowMs - row.first_seen_ms >= FAILURE_DEADLINE_MS) {
			recordTerminal(args, row, nowMs, "unknown_deadline_exhausted");
			return { kind: "terminal_unavailable", reason: "unknown_exhausted" };
		}
		if (nowMs < row.next_retry_ms) {
			return { kind: "retry_later", reason: "backoff" };
		}

		let probe = inFlight.get(cacheKey);
		if (!probe) {
			const recent = (projectProbeTimes.get(args.projectName) ?? []).filter(
				(timestamp) => nowMs - timestamp < 60_000,
			);
			if (recent.length >= PROBE_BUDGET_PER_MINUTE) {
				projectProbeTimes.set(args.projectName, recent);
				return { kind: "retry_later", reason: "budget" };
			}
			recent.push(nowMs);
			projectProbeTimes.set(args.projectName, recent);
			probe = checkPrMerge(projectRoot, prNumber, PROBE_TIMEOUT_MS).finally(
				() => inFlight.delete(cacheKey),
			);
			inFlight.set(cacheKey, probe);
		}

		const info = await probe;
		if (info.state === "merged") {
			cache.set(cacheKey, { info, observedAtMs: nowMs });
			return suppressMerged({ ...args, prNumber }, info);
		}
		if (info.state === "open" || info.state === "closed") {
			cache.set(cacheKey, { info, observedAtMs: nowMs });
			deps.store.resolveMergedGateGuardFailure(args.questionId, args.source);
			return { kind: "continue", prState: info.state };
		}

		const nextAttempt = row.attempts + 1;
		const terminal =
			nextAttempt >= BACKOFF_MS.length ||
			nowMs - row.first_seen_ms >= FAILURE_DEADLINE_MS;
		deps.store.recordMergedGateGuardUnknown({
			questionId: args.questionId,
			source: args.source,
			nowMs,
			nextRetryMs:
				nowMs + BACKOFF_MS[Math.min(nextAttempt - 1, BACKOFF_MS.length - 1)]!,
			error: "gh_pr_state_unknown",
			terminal,
		});
		return terminal
			? { kind: "terminal_unavailable", reason: "unknown_exhausted" }
			: { kind: "retry_later", reason: "unknown" };
	};
}
