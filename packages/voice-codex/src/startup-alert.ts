import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export interface StartupRefusal {
	reason: string;
	title: string;
	body: string;
}

export function reportStartupRefusal(
	refusal: StartupRefusal,
	env: Readonly<Record<string, string | undefined>> = process.env,
): void {
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
