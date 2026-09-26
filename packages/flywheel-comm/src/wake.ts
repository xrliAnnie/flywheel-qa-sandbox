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

export interface WakeResult {
	ok: boolean;
	/** Set when the wake was intentionally skipped (not an error). */
	skippedReason?: "backend_commdb" | "no_session_lead";
	/** Set when the transport write failed (best-effort — caller already has the durable CommDB record). */
	error?: string;
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
	/** Injectable for tests. */
	transportFactory?: (
		backend: "claude-code" | "codex",
	) => Pick<ReturnType<typeof AgentTeamTransportFactory.forBackend>, "write">;
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
		>;
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
		} else {
			transport = AgentTeamTransportFactory.fromEnv();
		}
		await transport.write({
			// leadName === teamName === leadId: each Lead owns one team named
			// after itself; the Runner inbox lives at
			// teams/<leadId>/inboxes/<agentName>.json.
			leadName: teamName,
			recipient: agentName,
			payload: {
				from: args.fromAgent,
				to: agentName,
				content: args.content,
				metadata: args.metadata,
			},
		});
		return { ok: true };
	} catch (err) {
		return { ok: false, error: (err as Error).message };
	}
}
