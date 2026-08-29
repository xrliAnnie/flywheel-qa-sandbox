/**
 * FLY-1082 (Task 2.5): the launchctl kickstart helper — the ONLY launchd
 * mutation the fleet ARC performs. `kickstart -k` restarts the job in place:
 * idempotent (a healthy job just restarts) and reversible (no config change).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** A launchd service target: `gui/<uid>/<label>` or a bare label (resolved
 * against the caller's gui domain). Restrictive on purpose — never a shell. */
const SAFE_TARGET = /^[A-Za-z0-9/._-]+$/;

/**
 * FLY-1082 (Task 2.5): launchd job liveness — tri-state so an indeterminate
 * probe (launchctl missing / timeout) never fires a false bot-down alert.
 *  true = service found and running; false = provably not running/not found;
 *  null = cannot tell.
 */
export async function probeLaunchdJobAlive(
	jobLabel: string,
): Promise<boolean | null> {
	const label = jobLabel.trim();
	if (!label || !SAFE_TARGET.test(label)) return null;
	const target = label.includes("/")
		? label
		: `gui/${process.getuid?.() ?? 501}/${label}`;
	try {
		const { stdout } = await execFileAsync("launchctl", ["print", target], {
			timeout: 10_000,
		});
		return /state = running/.test(stdout);
	} catch (err) {
		const msg = (err as Error).message ?? "";
		// "Could not find service" = the job is genuinely absent → down.
		if (/could not find service/i.test(msg)) return false;
		return null; // timeout / ENOENT / permission — indeterminate
	}
}

export async function kickstartJob(
	jobLabel: string,
): Promise<{ ok: boolean; error?: string }> {
	const label = jobLabel.trim();
	if (!label || !SAFE_TARGET.test(label)) {
		return { ok: false, error: `unsafe launchd target: "${jobLabel}"` };
	}
	const target = label.includes("/")
		? label
		: `gui/${process.getuid?.() ?? 501}/${label}`;
	try {
		await execFileAsync("launchctl", ["kickstart", "-k", target], {
			timeout: 15_000,
		});
		return { ok: true };
	} catch (err) {
		return { ok: false, error: (err as Error).message };
	}
}
