import {
	AgentTeamTransportFactory,
	deriveRunnerMailboxIdentity,
} from "flywheel-agent-team-transport";
import { resolveCommBackend } from "flywheel-config";
import { CommDB } from "../db.js";

export interface SendArgs {
	fromAgent: string;
	toAgent: string;
	content: string;
	dbPath: string;
}

/**
 * Send a Lead → Runner instruction.
 *
 * CommDB write is the durable record (audit + rollback substrate) and ALWAYS
 * happens first. In mailbox mode (default) we ALSO write the Runner's
 * claude-code Agent Team inbox so its stock `useInboxPoller` wakes an idle
 * Runner — FLY-168 fixes the transport gap where a sentinel-equipped idle
 * Runner never saw the CommDB-only instruction (the PostToolUse hook short-
 * circuits to a no-op when the mailbox sentinel is present).
 *
 * The mailbox write is BEST-EFFORT: failures are logged to stderr and never
 * block the CommDB write. CommDB is NOT an active mailbox-mode delivery
 * fallback (the sentinel keeps the hook inert) — it is the audit/rollback
 * record. On a mailbox-write failure the operational recovery is the loud
 * stderr log plus rollback / manual resend.
 *
 * Returns the CommDB message id. Async because the mailbox write is async;
 * stdout is reserved for the caller's id/JSON output, so all diagnostics here
 * go to stderr only.
 */
export async function send(args: SendArgs): Promise<string> {
	const db = new CommDB(args.dbPath);
	let id: string;
	try {
		id = db.insertInstruction(args.fromAgent, args.toAgent, args.content);

		// Rollback mode (FLYWHEEL_COMM_BACKEND=commdb): the Runner has no mailbox
		// sentinel and the hook injects CommDB instructions directly — do NOT
		// write the mailbox.
		if (resolveCommBackend() !== "mailbox") {
			return id;
		}

		// Resolve the Runner's mailbox identity from its session row. lead_id +
		// execution_id are both populated on the production spawn path; if the
		// session or lead_id is missing we degrade to CommDB-only (best-effort).
		const session = db.getSession(args.toAgent);
		if (!session?.lead_id) {
			console.warn(
				`[flywheel-comm send] no session/lead_id for ${args.toAgent}; mailbox wake skipped (CommDB instruction written)`,
			);
			return id;
		}

		const { agentName, teamName } = deriveRunnerMailboxIdentity(
			args.toAgent,
			session.lead_id,
		);

		try {
			const transport = AgentTeamTransportFactory.fromEnv();
			await transport.write({
				// In this architecture leadName === teamName === leadId: each Lead
				// owns one team named after itself, and the Runner inbox lives at
				// teams/<leadId>/inboxes/<agentName>.json.
				leadName: teamName,
				recipient: agentName,
				payload: {
					from: args.fromAgent,
					to: agentName,
					content: args.content,
					metadata: { flywheelId: id, execId: args.toAgent },
				},
			});
		} catch (err) {
			// Best-effort wake — never block on mailbox failure. CommDB row is the
			// durable record; surface loudly on stderr for ops recovery.
			console.error(
				`[flywheel-comm send] mailbox wake failed for ${args.toAgent}: ${
					(err as Error).message
				}`,
			);
		}

		return id;
	} finally {
		db.close();
	}
}
