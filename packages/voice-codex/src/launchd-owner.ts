import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const VOICE_LAUNCHD_LABEL = "com.flywheel.voice";

/**
 * FLY-2701 (design review advisory 5): a process-lock conflict must say who
 * holds the lock and on what evidence.
 *
 * The only authority this process can read without guessing is launchd's own
 * record for the exact label the installer wrote, the contract checker
 * verifies, and the Bridge kickstarts: `launchctl print gui/<uid>/<label>`
 * prints `pid = N` while that job is running. A live pid that is not this
 * process means the host already owns a voice instance, which is precisely the
 * designed on-demand race (a wake arrived while the previous instance is still
 * finishing). Anything else — no pid, an unreadable job, a failed or timed-out
 * probe — proves nothing and stays "unknown", so the loud refusal is kept.
 */
export type VoiceLockOwnerEvidence =
	| {
			kind: "launchd_running";
			label: string;
			pid: number;
			source: "launchctl_print";
	  }
	| { kind: "not_running"; label: string; source: "launchctl_print" }
	| { kind: "unknown"; reason: string };

export type VoiceLaunchdExec = (
	file: string,
	args: string[],
	options: { timeout: number; maxBuffer: number },
) => Promise<{ stdout: string }>;

const defaultExec = promisify(execFile) as unknown as VoiceLaunchdExec;

export async function probeVoiceLaunchdOwner(
	options: { uid?: number; selfPid?: number; run?: VoiceLaunchdExec } = {},
): Promise<VoiceLockOwnerEvidence> {
	const uid = options.uid ?? process.getuid?.() ?? 501;
	const selfPid = options.selfPid ?? process.pid;
	let stdout: string;
	try {
		({ stdout } = await (options.run ?? defaultExec)(
			"/bin/launchctl",
			["print", `gui/${uid}/${VOICE_LAUNCHD_LABEL}`],
			{ timeout: 2_000, maxBuffer: 256 * 1024 },
		));
	} catch {
		// A missing unit, a denied domain, or a timeout are all "cannot prove".
		return { kind: "unknown", reason: "launchctl_print_failed" };
	}
	const matches = [...stdout.matchAll(/^\s*pid = (\d+)\s*$/gm)];
	if (matches.length !== 1) {
		return matches.length === 0
			? {
					kind: "not_running",
					label: VOICE_LAUNCHD_LABEL,
					source: "launchctl_print",
				}
			: { kind: "unknown", reason: "launchctl_print_ambiguous" };
	}
	const pid = Number(matches[0]![1]);
	if (!Number.isSafeInteger(pid) || pid <= 0) {
		return { kind: "unknown", reason: "launchctl_print_ambiguous" };
	}
	// If launchd is reporting us, it has told us nothing about the other holder.
	if (pid === selfPid) {
		return { kind: "unknown", reason: "launchctl_reports_self" };
	}
	return {
		kind: "launchd_running",
		label: VOICE_LAUNCHD_LABEL,
		pid,
		source: "launchctl_print",
	};
}
