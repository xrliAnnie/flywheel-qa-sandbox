import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

export type VoiceLaunchdExec = (
	file: string,
	args: string[],
	options: { timeout: number; maxBuffer?: number },
) => Promise<unknown>;

const defaultExec = promisify(execFile) as unknown as VoiceLaunchdExec;

export async function kickstartVoiceOnDemand(
	options: { uid?: number; run?: VoiceLaunchdExec } = {},
): Promise<void> {
	const uid = options.uid ?? process.getuid?.() ?? 501;
	await (options.run ?? defaultExec)(
		"/bin/launchctl",
		["kickstart", `gui/${uid}/com.flywheel.voice`],
		{ timeout: 2_000, maxBuffer: 16 * 1024 },
	);
}

export async function verifyVoiceOnDemandContract(
	options: {
		repoRoot?: string;
		homeDir?: string;
		uid?: number;
		run?: VoiceLaunchdExec;
	} = {},
): Promise<void> {
	const repoRoot = options.repoRoot ?? process.cwd();
	const homeDir = options.homeDir ?? homedir();
	const uid = options.uid ?? process.getuid?.() ?? 501;
	await (options.run ?? defaultExec)(
		"/bin/bash",
		[
			join(repoRoot, "scripts", "lib", "voice-on-demand.sh"),
			repoRoot,
			homeDir,
			`gui/${uid}`,
		],
		{ timeout: 2_000, maxBuffer: 16 * 1024 },
	);
}

/**
 * What the host actually did with one wake request. FLY-2701 review R3: the
 * caller spends a launch budget on this, so "accepted" must mean the command
 * really settled successfully — not merely that a request was started.
 */
export type VoiceWakeOutcome =
	| "coalesced"
	| "accepted"
	| "unavailable"
	| "failed";

export class VoiceLaunchdWaker {
	private inFlight?: Promise<VoiceWakeOutcome>;
	private nextAttemptAt = 0;

	constructor(
		private readonly deps: {
			wake: () => Promise<void>;
			verify?: () => Promise<void>;
			now?: () => number;
			minIntervalMs?: number;
			log?: (message: string) => void;
		},
	) {}

	requestWake(): Promise<VoiceWakeOutcome> {
		const now = (this.deps.now ?? (() => performance.now()))();
		if (this.inFlight || now < this.nextAttemptAt) {
			return Promise.resolve("coalesced");
		}
		this.nextAttemptAt = now + (this.deps.minIntervalMs ?? 3_000);
		// A failed contract check is a configuration fault, not a flaky command:
		// the unit is missing, disabled, or has drifted from the source bytes, and
		// retrying cannot fix it. Keep the two apart so the budget can stop
		// immediately on the first rather than burning three startup windows.
		const task: Promise<VoiceWakeOutcome> = (async () => {
			if (this.deps.verify) {
				try {
					await this.deps.verify();
				} catch {
					(this.deps.log ?? console.warn)("voice launchd contract unavailable");
					return "unavailable";
				}
			}
			try {
				await this.deps.wake();
				return "accepted";
			} catch {
				(this.deps.log ?? console.warn)("voice launchd wake failed");
				return "failed";
			}
		})().finally(() => {
			if (this.inFlight === task) this.inFlight = undefined;
		});
		this.inFlight = task;
		return task;
	}
}
