/**
 * FLY-1373 reverse flag. Capture this once at Bridge boot, then pass the
 * boolean into individual legacy alert lanes; the consumer loop itself is
 * deliberately unconditional.
 */
export function legacyDeliveryWatchdogsEnabled(
	env: Record<string, string | undefined> = process.env,
): boolean {
	return env.FLYWHEEL_LEGACY_DELIVERY_WATCHDOGS === "1";
}
