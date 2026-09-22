import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export interface StartupRefusal {
	reason: string;
	title: string;
	body: string;
}

export const VOICE_LOCK_UNAVAILABLE_BODY =
	"The standalone voice lock helper is unavailable.";

function recordStartupSpool(
	reasonClass:
		| "startup_config_invalid"
		| "startup_lock_unavailable"
		| "startup_not_ready"
		| "health_observation_unavailable",
	env: Readonly<Record<string, string | undefined>>,
): void {
	const flywheelDir = env.FLYWHEEL_DIR ?? join(homedir(), "Dev", "flywheel");
	try {
		spawnSync(
			"python3",
			[
				join(flywheelDir, "scripts", "lib", "voice-health-startup-spool.py"),
				"record",
				reasonClass,
			],
			{
				env: { ...env, PATH: env.PATH ?? process.env.PATH },
				stdio: "ignore",
				timeout: 1_000,
			},
		);
	} catch {
		// The original startup outcome remains authoritative; spooling is best-effort.
	}
}

export function reportFatalStartupFailure(
	_error: unknown,
	env: Readonly<Record<string, string | undefined>> = process.env,
): void {
	recordStartupSpool("startup_not_ready", env);
	console.error(
		"[voice] fatal reasonClass=startup_not_ready operation=startup",
	);
}

export function reportStartupRefusal(
	refusal: StartupRefusal,
	env: Readonly<Record<string, string | undefined>> = process.env,
): void {
	recordStartupSpool("startup_lock_unavailable", env);
	console.error(`[voice] STARTUP REFUSED [${refusal.reason}] ${refusal.body}`);
	const flywheelDir = env.FLYWHEEL_DIR ?? join(homedir(), "Dev", "flywheel");
	try {
		spawnSync(
			join(flywheelDir, "scripts", "lib", "bounded-run.sh"),
			[
				"15",
				env.FLYWHEEL_META_ALERT_BIN ??
					join(flywheelDir, "scripts", "meta-alert.sh"),
				refusal.reason,
				refusal.title,
				refusal.body,
			],
			{ env: { ...env }, stdio: "ignore", timeout: 16_000 },
		);
	} catch {
		// Startup refusal is already loud on stderr; alert delivery is best-effort.
	}
}
