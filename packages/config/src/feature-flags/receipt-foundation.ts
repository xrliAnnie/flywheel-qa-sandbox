/** FLY-1392 default-on kill switch. Only the exact string "0" rolls back. */
export function receiptFoundationEnabled(
	env: Record<string, string | undefined> = process.env,
): boolean {
	return env.FLYWHEEL_RECEIPT_FOUNDATION !== "0";
}
