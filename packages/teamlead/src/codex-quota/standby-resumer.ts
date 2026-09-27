/**
 * FLY-2900 §6 — relaunch parked Codex quota standby executions.
 *
 * Driven by the resume loop inside one Bridge process. It claims permits
 * (at most two relaunches in flight), relaunches the SAME execution through
 * the shared same-execution relaunch, keeps the claim's lease alive, and
 * cleans up its own process whenever its claim is lost (failure, operator
 * release, lease expiry). Success is settled by the handshake callbacks on
 * the continue turn's first model output, never here.
 */

import { randomUUID } from "node:crypto";
import type {
	CodexQuotaResumeAuthorization,
	CodexQuotaResumeLifecycle,
} from "flywheel-core";
import type { WorkflowActorSession } from "../bridge/workflow-actor-session.js";
import type {
	SameExecutionLifecycle,
	SameExecutionRelaunchIdentity,
	SameExecutionRelaunchResult,
} from "../bridge/workflow-same-execution-relaunch.js";
import type { StateStore } from "../StateStore.js";
import {
	CODEX_STANDBY_EVALUATION_INTERVAL_MS,
	type CodexQuotaResumeLoopContext,
} from "./resume-loop.js";

/** §6: relaunches in flight at once, so a fresh account is not stampeded. */
export const CODEX_STANDBY_MAX_CONCURRENT_RESUMES = 2;
/** §6 step 6: identity must verify within this window (the relaunch's own bound). */
export const CODEX_STANDBY_IDENTITY_TIMEOUT_MS = 180_000;
/** §6 step 6: after identity, the first model output must arrive within this. */
export const CODEX_STANDBY_PROGRESS_TIMEOUT_MS = 10 * 60_000;

export interface CodexQuotaStandbyResumerDeps {
	store: StateStore;
	/** `bridge:<pid>:<boot nonce>` — claims outside it belong to a dead process. */
	ownerPrefix: string;
	getSession(executionId: string): WorkflowActorSession | undefined;
	relaunch(input: {
		session: WorkflowActorSession;
		expectedHeadSha: string;
		lifecycle: (
			identity: SameExecutionRelaunchIdentity,
		) => SameExecutionLifecycle;
	}): Promise<SameExecutionRelaunchResult>;
	/** Reap this execution's relaunched daemon and restore its CommDB row. */
	cleanup(
		session: WorkflowActorSession,
	): Promise<{ ok: boolean; error?: string }>;
	/** Revive the execution's CommDB registration in place before launch. */
	reviveCommDbSession(
		session: WorkflowActorSession,
	): Promise<{ ok: boolean; reason?: string }>;
	/** The current TURN holder of the execution's issue, if any. */
	turnHolder(session: WorkflowActorSession): Promise<string | undefined>;
	now?: () => number;
	maxConcurrent?: number;
	progressTimeoutMs?: number;
	warn?: (message: string, detail: string) => void;
}

interface InFlight {
	authorization: CodexQuotaResumeAuthorization;
	session: WorkflowActorSession;
	claimedAt: number;
	launch?: Promise<void>;
}

const MACHINE_CODE = /^[a-z0-9_:.-]{1,80}$/;

function machineCode(value: string, fallback: string): string {
	const normalized = value
		.toLowerCase()
		.replace(/[^a-z0-9_:.-]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 80);
	return MACHINE_CODE.test(normalized) ? normalized : fallback;
}

export function createCodexQuotaStandbyResumer(
	deps: CodexQuotaStandbyResumerDeps,
): {
	tick(context: CodexQuotaResumeLoopContext): Promise<void>;
	inFlight(): string[];
	settled(): Promise<void>;
} {
	const now = deps.now ?? Date.now;
	const iso = () => new Date(now()).toISOString();
	const warn =
		deps.warn ?? ((message, detail) => console.warn(message, detail));
	const maxConcurrent =
		deps.maxConcurrent ?? CODEX_STANDBY_MAX_CONCURRENT_RESUMES;
	const progressTimeoutMs =
		deps.progressTimeoutMs ?? CODEX_STANDBY_PROGRESS_TIMEOUT_MS;
	const inflight = new Map<string, InFlight>();
	// Like engine admissionBrake, a refusal stays queued, with no finite retry
	// budget. On Bridge restart the normal maintenance tick rechecks admission.
	const admissionRetries = new Map<
		string,
		{ entrySeq: number; after: number }
	>();
	let recovered = false;
	const { store } = deps;

	const fail = (
		authorization: CodexQuotaResumeAuthorization,
		detailCode: string,
		continueDetermined = false,
	) =>
		store.failCodexQuotaResume({
			authorization,
			kind: "mechanical",
			detailCode: machineCode(detailCode, "resume_failed"),
			continueDetermined,
			now: iso(),
		});

	const lifecycleFor = (
		authorization: CodexQuotaResumeAuthorization,
		claimed: { continueAttemptId: string; continueAttemptFresh: boolean },
	): SameExecutionLifecycle => {
		const quotaResume: CodexQuotaResumeLifecycle = {
			authorization,
			continueAttemptId: claimed.continueAttemptId,
			continueAttemptFresh: claimed.continueAttemptFresh,
			onContinueReconciled: (outcome) =>
				store.reconcileCodexQuotaContinue({
					authorization,
					outcome,
					now: iso(),
				}),
			onContinueStarted: ({ turnId }) =>
				store.markCodexQuotaContinueStarted(authorization, turnId, iso()),
			onContinueProgress: ({ turnId }) => {
				store.settleCodexQuotaResumeSuccess({
					authorization,
					turnId,
					now: iso(),
				});
			},
			onContinueFailed: ({ reasonCode, usageLimited }) => {
				// A usage wall is settled by the terminal signal together with the
				// trigger move (so the old permit is void before any re-claim).
				if (!usageLimited) fail(authorization, reasonCode, true);
			},
		};
		return {
			generation: authorization.entrySeq,
			resumeVerificationStatus: () =>
				store.codexQuotaResumeVerificationStatus(authorization),
			onIdentityVerified: (evidence) => {
				store.markCodexQuotaResumeIdentityVerified(
					authorization,
					iso(),
					evidence,
				);
			},
			quotaResume,
		};
	};

	const launch = async (
		entry: InFlight,
		claimed: { continueAttemptId: string; continueAttemptFresh: boolean },
	): Promise<void> => {
		const { authorization, session } = entry;
		try {
			const holder = await deps.turnHolder(session);
			if (holder !== session.execution_id) {
				fail(authorization, "turn_not_held");
				return;
			}
			const revived = await deps.reviveCommDbSession(session);
			if (!revived.ok) {
				fail(
					authorization,
					`commdb_revive_failed:${revived.reason ?? "unknown"}`,
				);
				return;
			}
			const result = await deps.relaunch({
				session,
				expectedHeadSha: "",
				lifecycle: () => lifecycleFor(authorization, claimed),
			});
			if (!result.ok) {
				if (result.admissionBrake) {
					store.failCodexQuotaResume({
						authorization,
						kind: "neutral",
						detailCode: "admission_brake",
						continueDetermined: false,
						now: iso(),
					});
					admissionRetries.set(session.execution_id, {
						entrySeq: authorization.entrySeq,
						after:
							now() +
							Math.max(
								CODEX_STANDBY_EVALUATION_INTERVAL_MS,
								(result.retryAfterSeconds ?? 0) * 1_000,
							),
					});
					return;
				}
				fail(
					authorization,
					result.error === "resume_identity_timeout"
						? "identity_timeout"
						: result.error,
				);
			}
		} catch (error) {
			fail(
				authorization,
				error instanceof Error ? error.message : "resume_launch_threw",
			);
		}
	};

	const cleanupWarned = new Set<string>();
	/** Reap the execution's relaunched process; true only when proven done. */
	const cleanup = async (session: WorkflowActorSession): Promise<boolean> => {
		const executionId = session.execution_id;
		let problem: string | undefined;
		try {
			const result = await deps.cleanup(session);
			if (result.ok) {
				cleanupWarned.delete(executionId);
				return true;
			}
			problem = `incomplete: ${result.error ?? "unknown"}`;
		} catch (error) {
			problem = `failed: ${error instanceof Error ? error.message : String(error)}`;
		}
		if (!cleanupWarned.has(executionId)) {
			cleanupWarned.add(executionId);
			warn(
				"[Bridge] Codex standby relaunch cleanup",
				`${executionId}: ${problem}`,
			);
		}
		return false;
	};

	return {
		inFlight: () => [...inflight.keys()],
		settled: async () => {
			await Promise.all([...inflight.values()].map((entry) => entry.launch));
		},
		async tick(context) {
			if (!recovered) {
				recovered = true;
				for (const executionId of store.recoverAbandonedCodexQuotaClaims(
					deps.ownerPrefix,
					iso(),
				))
					warn(
						"[Bridge] Codex standby claim from a previous Bridge returned to standby",
						executionId,
					);
			}
			for (const [executionId, entry] of inflight) {
				const row = store.codexQuota.getStandby(executionId);
				const live =
					row?.state === "resuming" &&
					row.owner_claim_id === entry.authorization.claimId;
				if (!live) {
					// Closed = the body keeps working (success or completion).
					// Otherwise reap now without waiting for an in-flight launch: a
					// late identity check fails the lost claim and the adapter exits.
					// A released row keeps naming the claim until the reap is proven,
					// so a failed reap (or a restart) is retried by the sweep below.
					if (
						row?.state !== "closed" &&
						(await cleanup(entry.session)) &&
						row?.state === "released"
					)
						store.codexQuota.clearReleasedResumeOwner(
							executionId,
							entry.authorization.claimId,
							iso(),
						);
					inflight.delete(executionId);
					continue;
				}
				store.renewCodexQuotaResumeLease(entry.authorization, iso());
				if (
					now() - entry.claimedAt >
					CODEX_STANDBY_IDENTITY_TIMEOUT_MS + progressTimeoutMs
				) {
					fail(entry.authorization, "progress_timeout");
				}
			}
			// FLY-2900 §4.3: a release whose claim was never reaped (the owner
			// died first, or its reap failed) — reap it before anything else.
			for (const row of store.codexQuota.listReleasedResumeOwners()) {
				if (inflight.has(row.execution_id) || !row.owner_claim_id) continue;
				const session = deps.getSession(row.execution_id);
				if (session && !(await cleanup(session))) continue;
				store.codexQuota.clearReleasedResumeOwner(
					row.execution_id,
					row.owner_claim_id,
					iso(),
				);
			}
			for (const [executionId, retry] of admissionRetries) {
				const row = store.codexQuota.getStandby(executionId);
				if (
					!row ||
					row.state !== "standby" ||
					row.entry_seq !== retry.entrySeq ||
					now() >= retry.after
				)
					admissionRetries.delete(executionId);
			}
			if (!context.root) return;
			for (const row of store.codexQuota.listStandby(["standby"])) {
				if (inflight.size >= maxConcurrent) break;
				if (
					inflight.has(row.execution_id) ||
					admissionRetries.has(row.execution_id)
				)
					continue;
				if (!store.codexQuota.eligiblePermitFor(row.execution_id)) continue;
				const session = deps.getSession(row.execution_id);
				if (!session) continue;
				const claimed = store.claimCodexQuotaResume({
					executionId: row.execution_id,
					ownerClaimId: `${deps.ownerPrefix}:${randomUUID()}`,
					now: iso(),
				});
				if (!claimed.ok) continue;
				const entry: InFlight = {
					authorization: claimed.authorization,
					session,
					claimedAt: now(),
				};
				inflight.set(row.execution_id, entry);
				entry.launch = launch(entry, claimed);
			}
		},
	};
}
