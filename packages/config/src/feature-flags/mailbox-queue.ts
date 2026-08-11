/** FLY-1573 default-on queue-semantics kill switch. */
export function mailboxQueueEnabled(
	env: Record<string, string | undefined> = process.env,
): boolean {
	return env.FLYWHEEL_MAILBOX_QUEUE !== "0";
}
