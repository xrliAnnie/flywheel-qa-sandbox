/**
 * FLY-1373 reverse flag. Capture this once at Bridge boot, then pass the
 * boolean into individual legacy alert lanes; the consumer loop itself is
 * deliberately unconditional.
 */
import { retiredWatchdogLaneEnabled } from "./watchdog-minimum-set.js";

export function legacyDeliveryWatchdogsEnabled(
	env: Record<string, string | undefined> = process.env,
): false {
	return retiredWatchdogLaneEnabled(env);
}
