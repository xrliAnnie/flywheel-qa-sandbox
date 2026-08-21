/**
 * FLY-191 Phase 2: shared best-effort mailbox wake for an idle Runner.
 *
 * Extracted from `send.ts` (FLY-168) so the approval write-sites can reuse the
 * exact same transport path: `flywheel-comm send`, the `respond` emergency
 * bypass, and (server-side, via its own copy of this logic in
 * `runner-wake.ts`) the Bridge's `approveExecution` / gate-response wrapper.
 *
 * SECURITY NOTE: a wake is a HINT, never authority. The runner must re-verify
 * via `verify-approval` (trusted CommDB gate response + StateStore status +
 * pr_head_sha) before shipping — anything able to write the inbox file could
 * forge this text.
 */

import {
	AgentTeamTransportFactory,
	deriveRunnerMailboxIdentity,
} from "flywheel-agent-team-transport";
import { resolveCommBackend } from "flywheel-config";
import type { CommDB } from "./db.js";

export type RunnerWakeBackend = "claude-code" | "codex";
export type RunnerWakeSettlement = "on_delivery" | "on_consume";
export type WakeResult =
	| {
			ok: true;
			backend: RunnerWakeBackend;
			settlement: RunnerWakeSettlement;
	  }
	| {
			ok: false;
			/** Set when the wake was intentionally skipped (not an error). */
			skippedReason?: "backend_commdb" | "no_session_lead";
			/** Set when the transport write failed (best-effort — caller already has the durable CommDB record). */
			error?: string;
	  };

function successfulWake(backend: RunnerWakeBackend): WakeResult {
	return {
		ok: true,
		backend,
		settlement: backend === "claude-code" ? "on_delivery" : "on_consume",
	};
}

export interface WakeRunnerArgs {
	/** Already-open CommDB — caller owns its lifecycle. */
	db: CommDB;
	/** Runner execution id (mailbox identity derives from its session row). */
	execId: string;
	/** Shown as the mailbox message sender. */
	fromAgent: string;
	/** Plain text body. Carries NO authority by design. */
	content: string;
	metadata?: Record<string, unknown>;
	/**
	 * FLY-123 (Codex design review R4 #1): explicit TRANSPORT backend of the
	 * target runner ("claude-code" | "codex"). When set, the wake routes via
	 * `AgentTeamTransportFactory.forBackend(backend)` — NOT the process-wide
	 * `fromEnv()` — so a Codex runner's wake reaches the Codex mailbox even
	 * though the Bridge env is locked to claude-code in Phase 1. Callers get
	 * the value from the unanswered-gate marker (written by the runner's own
	 * gate-register, which knows its backend). Absent → legacy `fromEnv()`
	 * behavior (claude approve_to_ship path, byte-compat).
	 */
	backend?: string;
	/** T1 retry path: verify the durable mailbox entry after write. */
	verified?: boolean;
	/** Injectable for tests. */
	transportFactory?: (
		backend: "claude-code" | "codex",
	) => Pick<ReturnType<typeof AgentTeamTransportFactory.forBackend>, "write"> &
		Partial<
			Pick<
				ReturnType<typeof AgentTeamTransportFactory.forBackend>,
				"verifyLastWrite"
			>
		>;
}

export interface DurableTurnWakeArgs extends WakeRunnerArgs {
	wakeId: string;
	issueId: string;
	epoch: number;
	activationId?: string;
	purpose: string;
	nowMs?: number;
	retryAfterMs?: number;
	leaseMs?: number;
}

export async function wakeRunnerMailbox(
	args: WakeRunnerArgs,
): Promise<WakeResult> {
	// Rollback mode (FLYWHEEL_COMM_BACKEND=commdb): the Runner has no mailbox
	// sentinel and the hook injects CommDB rows directly — do NOT write the
	// mailbox.
	if (resolveCommBackend() !== "mailbox") {
		return { ok: false, skippedReason: "backend_commdb" };
	}

	const session = args.db.getSession(args.execId);
	if (!session?.lead_id) {
		return { ok: false, skippedReason: "no_session_lead" };
	}

	const { agentName, teamName } = deriveRunnerMailboxIdentity(
		args.execId,
		session.lead_id,
	);

	try {
		// FLY-123 R4 #1: backend-scoped routing when the caller knows the
		// target runner's transport backend (from the gate marker). Unknown
		// backend strings are an error, not a silent fallback — a misrouted
		// wake means a permanently idle runner.
		let transport: Pick<
			ReturnType<typeof AgentTeamTransportFactory.forBackend>,
			"write"
		> &
			Partial<
				Pick<
					ReturnType<typeof AgentTeamTransportFactory.forBackend>,
					"verifyLastWrite"
				>
			>;
		let actualBackend: RunnerWakeBackend;
		if (args.backend !== undefined) {
			if (args.backend !== "claude-code" && args.backend !== "codex") {
				return {
					ok: false,
					error: `unsupported wake transport backend "${args.backend}" (expected "claude-code" | "codex")`,
				};
			}
			transport = (
				args.transportFactory ?? AgentTeamTransportFactory.forBackend
			)(args.backend);
			actualBackend = args.backend;
		} else {
			const selected = AgentTeamTransportFactory.fromEnv();
			const vendor = selected.vendorId();
			if (vendor !== "claude-code" && vendor !== "codex") {
				return {
					ok: false,
					error: `unsupported wake transport backend "${vendor}" (expected "claude-code" | "codex")`,
				};
			}
			transport = selected;
			actualBackend = vendor;
		}
		const payload = {
			from: args.fromAgent,
			to: agentName,
			content: args.content,
			metadata: args.metadata,
		};
		const writeResult = await transport.write({
			// leadName === teamName === leadId: each Lead owns one team named
			// after itself; the Runner inbox lives at
			// teams/<leadId>/inboxes/<agentName>.json.
			leadName: teamName,
			recipient: agentName,
			payload,
		});
		if (
			args.verified &&
			!(writeResult.idempotent && writeResult.finalized === true)
		) {
			if (!transport.verifyLastWrite) {
				throw new Error("wake transport does not support verified writes");
			}
			await transport.verifyLastWrite({
				leadName: teamName,
				recipient: agentName,
				expected: payload,
			});
		}
		return successfulWake(actualBackend);
	} catch (err) {
		return { ok: false, error: (err as Error).message };
	}
}

/**
 * Persist a TURN wake before transport I/O. Replays use the same wake id and
 * can perform at most one T1 retry; the retry is verified read-after-write.
 */
export async function deliverDurableTurnWake(
	args: DurableTurnWakeArgs,
): Promise<WakeResult> {
	const nowMs = args.nowMs ?? Date.now();
	const retryAfterMs = args.retryAfterMs ?? 3 * 60_000;
	const leaseMs = args.leaseMs ?? 30_000;
	args.db.enqueueTurnWake({
		wakeId: args.wakeId,
		executionId: args.execId,
		issueId: args.issueId,
		epoch: args.epoch,
		...(args.activationId ? { activationId: args.activationId } : {}),
		purpose: args.purpose,
		envelope: {
			fromAgent: args.fromAgent,
			content: args.content,
			...(args.metadata ? { metadata: args.metadata } : {}),
		},
		backend: args.backend ?? "claude-code",
		createdAtMs: nowMs,
	});
	const claim = args.db.claimTurnWakeById({
		wakeId: args.wakeId,
		nowMs,
		retryAfterMs,
		leaseMs,
	});
	if (!claim) {
		const row = args.db.getTurnWake(args.wakeId);
		if (row?.state === "acked" || row?.last_push_result === "ok") {
			if (row.backend === "claude-code" || row.backend === "codex") {
				return successfulWake(row.backend);
			}
			return { ok: false, error: `unsupported wake backend:${row.backend}` };
		}
		return {
			ok: false,
			error:
				row?.state === "cancelled"
					? `wake_cancelled:${row.cancel_reason ?? "unknown"}`
					: (row?.last_push_result?.replace(/^error:/, "") ??
						"wake_pending_retry"),
		};
	}
	const outcome = await wakeRunnerMailbox({
		db: args.db,
		execId: args.execId,
		fromAgent: args.fromAgent,
		content: args.content,
		metadata: args.metadata,
		backend: args.backend,
		verified: claim.push_count === 1,
		transportFactory: args.transportFactory,
	});
	args.db.finishTurnWakePush({
		wakeId: args.wakeId,
		claimToken: claim.claim_token!,
		pushedAtMs: nowMs,
		result: outcome.ok
			? "ok"
			: `error:${outcome.error ?? outcome.skippedReason ?? "wake_failed"}`,
	});
	return outcome;
}
