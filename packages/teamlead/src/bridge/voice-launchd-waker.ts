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

export class VoiceLaunchdWaker {
	private inFlight?: Promise<void>;
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

	requestWake(): "accepted" | "coalesced" {
		const now = (this.deps.now ?? (() => performance.now()))();
		if (this.inFlight || now < this.nextAttemptAt) return "coalesced";
		this.nextAttemptAt = now + (this.deps.minIntervalMs ?? 3_000);
		let operation: Promise<void>;
		try {
			operation = this.deps.verify
				? this.deps.verify().then(() => this.deps.wake())
				: this.deps.wake();
		} catch (error) {
			operation = Promise.reject(error);
		}
		const task = operation
			.catch(() => {
				(this.deps.log ?? console.warn)("voice launchd wake failed");
			})
			.finally(() => {
				if (this.inFlight === task) this.inFlight = undefined;
			});
		this.inFlight = task;
		return "accepted";
	}
}
