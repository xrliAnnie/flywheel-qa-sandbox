/** The existing mailbox address-domain predicate, shared by admission and enqueue. */
export function isLeadRecipient(toAgent: string): boolean {
	return toAgent === "lead" || toAgent.endsWith("-lead");
}
