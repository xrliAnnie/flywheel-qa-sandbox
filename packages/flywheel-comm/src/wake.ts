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
		const transport = AgentTeamTransportFactory.fromEnv();
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
