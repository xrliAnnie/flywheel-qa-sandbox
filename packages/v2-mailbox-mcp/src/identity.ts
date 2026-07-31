/**
 * FLY-1547 §2.6: the frozen, mutually exclusive identity schema for the
 * mailbox MCP. Runner mode ⇐ FLYWHEEL_V2_SESSION_REF alone (a runner's
 * FLYWHEEL_V2_AGENT_ID is its taskKind and is NEVER identity). Lead mode ⇐
 * BOTH FLYWHEEL_V2_LEAD_AGENT_ID and FLYWHEEL_V2_LEAD_CREDENTIAL_FILE with no
 * session ref. Anything mixed or partial fails stop at startup.
 */
export type MailboxIdentity =
	| { mode: "runner"; sessionRef: string }
	| { mode: "lead"; agentId: string; credentialFile: string };

export function resolveIdentity(
	env: Record<string, string | undefined>,
): MailboxIdentity {
	const sessionRef = env.FLYWHEEL_V2_SESSION_REF?.trim();
	const leadAgentId = env.FLYWHEEL_V2_LEAD_AGENT_ID?.trim();
	const credentialFile = env.FLYWHEEL_V2_LEAD_CREDENTIAL_FILE?.trim();
	if (sessionRef) {
		if (leadAgentId || credentialFile) {
			throw new Error(
				"mailbox identity is ambiguous: FLYWHEEL_V2_SESSION_REF and FLYWHEEL_V2_LEAD_* are mutually exclusive",
			);
		}
		return { mode: "runner", sessionRef };
	}
	if (leadAgentId && credentialFile) {
		return { mode: "lead", agentId: leadAgentId, credentialFile };
	}
	throw new Error(
		"mailbox identity is incomplete: set FLYWHEEL_V2_SESSION_REF (runner) or both FLYWHEEL_V2_LEAD_AGENT_ID and FLYWHEEL_V2_LEAD_CREDENTIAL_FILE (lead)",
	);
}
