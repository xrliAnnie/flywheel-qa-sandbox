import { homedir, tmpdir } from "node:os";
import { resolve, sep } from "node:path";

/** FLY-1393: the independently controlled watchdog minimum set. */
export type WatchdogEnv = Record<string, string | undefined>;

/** Discoverable migration tombs; none is consulted as runtime authority. */
export const RETIRED_WATCHDOG_ENV_VARS = [
	"FLYWHEEL_ZOMBIE_GATE_RESOLVE",
] as const;
export type RetiredWatchdogEnvVar = (typeof RETIRED_WATCHDOG_ENV_VARS)[number];

function defaultOn(env: WatchdogEnv, name: string): boolean {
	return env[name] !== "0";
}

export function watchdogLivenessEnabled(
	env: WatchdogEnv = process.env,
): boolean {
	return defaultOn(env, "FLYWHEEL_WATCHDOG_LIVENESS");
}

export function watchdogBlockedEnabled(
	env: WatchdogEnv = process.env,
): boolean {
	return defaultOn(env, "FLYWHEEL_WATCHDOG_BLOCKED");
}

/**
 * Retired delivery watchdogs are policy-hard-off. Environment variables remain
 * temporarily registered for truthful discovery, but cannot revive a lane.
 */
export function retiredWatchdogLaneEnabled(
	_env: WatchdogEnv = process.env,
	_envVar?: RetiredWatchdogEnvVar,
): false {
	return false;
}

/**
 * The W-2 hang seam is destructive, so a target Lead alone is insufficient.
 * It is armed only when CommDB is redirected inside the process temp root.
 */
export function qaStallInboxLoopLead(
	env: WatchdogEnv = process.env,
	tempRoot = tmpdir(),
	protectedFlywheelRoot = resolve(homedir(), ".flywheel"),
): string | undefined {
	const leadId = env.FLYWHEEL_QA_STALL_INBOX_LOOP_LEAD?.trim();
	// Match commDbRootDir() precedence exactly: a production COMM_ROOT must not
	// be masked by setting a harmless-looking temp COMM_DIR beside it.
	const commRoot =
		env.FLYWHEEL_COMM_ROOT?.trim() || env.FLYWHEEL_COMM_DIR?.trim();
	if (!leadId || !commRoot) return undefined;
	const root = resolve(tempRoot);
	const candidate = resolve(commRoot);
	const protectedRoot = resolve(protectedFlywheelRoot);
	if (
		candidate === protectedRoot ||
		candidate.startsWith(`${protectedRoot}${sep}`)
	) {
		return undefined;
	}
	if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
		return undefined;
	}
	return leadId;
}
