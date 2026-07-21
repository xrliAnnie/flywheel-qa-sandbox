/**
 * FLY-1373 reverse flag. Capture this once at Bridge boot, then pass the
 * boolean into individual legacy alert lanes; the consumer loop itself is
 * deliberately unconditional.
 */
import { retiredWatchdogLaneEnabled } from "./watchdog-minimum-set.js";

export const LEGACY_DELIVERY_WATCHDOG_ENV =
	"FLYWHEEL_LEGACY_DELIVERY_WATCHDOGS" as const;

export function legacyDeliveryWatchdogsEnabled(
	env: Record<string, string | undefined> = process.env,
): false {
	// FLY-1393: formal retirement. The env key stays registered during the
	// migration window, but no runtime value can revive the superseded cohort.
	return retiredWatchdogLaneEnabled(env, LEGACY_DELIVERY_WATCHDOG_ENV);
}
