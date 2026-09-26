/**
 * FLY-2885 QA@1 (Lead c8e10764 ②): the voice daemon must exit within a
 * bounded grace on both the idle exit and SIGTERM, whatever handle a library
 * leaks. werift left two UDP sockets after every bundled session, so a
 * daemon that had released its lock lived on and the next `launchctl
 * kickstart` found it still running.
 *
 * `begin` arms the deadline the moment shutdown starts; `finish` exits as
 * soon as cleanup is done instead of waiting for the event loop to drain.
 */

/**
 * Idle exit (run() returned on its own; no one is waiting to kill us):
 * longer than every bounded cleanup step together, so it only ever ends a
 * hang, never a cleanup still within its own bounds:
 * - a live session: realtime stop 5 s + pc.close 3 s + transport stops 4 s
 *   + app-server stop (50 ms + 5 s TERM + 5 s KILL) ≈ 22 s;
 * - its last Bridge writes ≈ 10 s;
 * - health settle 0.5 s;
 * - lead alert drain 8 s + stop 2 s.
 * That is about 45 s. An idle daemon's cleanup takes well under a second,
 * and it exits as soon as that cleanup is done.
 */
export const SHUTDOWN_EXIT_GRACE_MS = 60_000;

/**
 * A signal: launchd's exit timeout for com.flywheel.voice is 5 s (the plist
 * sets none; `launchctl print` shows "exit timeout = 5"), after which it
 * SIGKILLs the daemon and no hook runs. The daemon forces its own exit a
 * second earlier so the lead alert's process group is killed first. A live
 * session's longer close steps are cut here, as launchd would cut them; the
 * app-server exits on stdin EOF and the next start sweeps its root
 * (FLY-2885 rework review R3, Lead ruling bfcaeb10).
 */
export const SHUTDOWN_SIGNAL_GRACE_MS = 4_000;

/** Handle kinds that never keep a process alive on their own. */
const IDLE_KINDS = new Set(["Timeout", "Immediate", "TTYWrap"]);

export interface ShutdownExit {
	/**
	 * Shutdown started: a signal (SHUTDOWN_SIGNAL_GRACE_MS) or run()
	 * returning (SHUTDOWN_EXIT_GRACE_MS). A later begin only ever brings the
	 * deadline forward.
	 */
	begin(reason: "signal" | "run_returned"): ReturnType<typeof setTimeout>;
	/** Cleanup is done: exit now rather than wait for leaked handles. */
	finish(code: number | string | undefined | null): void;
	/** Runs synchronously before a forced exit (stop child process trees). */
	onForcedExit(hook: () => void): void;
}

export function createShutdownExit(
	options: {
		graceMs?: number;
		signalGraceMs?: number;
		resources?: () => string[];
		exit?: (code: number) => void;
		log?: (line: string) => void;
	} = {},
): ShutdownExit {
	const graceMs = options.graceMs ?? SHUTDOWN_EXIT_GRACE_MS;
	const signalGraceMs = options.signalGraceMs ?? SHUTDOWN_SIGNAL_GRACE_MS;
	const exit = options.exit ?? ((code: number) => process.exit(code));
	const log = options.log ?? ((line: string) => console.error(line));
	const hooks: Array<() => void> = [];
	const lingering = () => {
		const counts = new Map<string, number>();
		for (const kind of (
			options.resources ?? (() => process.getActiveResourcesInfo())
		)())
			if (!IDLE_KINDS.has(kind)) counts.set(kind, (counts.get(kind) ?? 0) + 1);
		return [...counts].map(([kind, count]) => `${kind}×${count}`).join(", ");
	};
	let deadline: ReturnType<typeof setTimeout> | undefined;
	let deadlineAt = Number.POSITIVE_INFINITY;
	return {
		begin(reason) {
			const grace = reason === "signal" ? signalGraceMs : graceMs;
			const at = Date.now() + grace;
			if (deadline && deadlineAt <= at) return deadline;
			if (deadline) clearTimeout(deadline);
			deadlineAt = at;
			deadline = setTimeout(() => {
				log(
					`[voice] shutdown (${reason}) overran ${grace} ms with handles still open (${lingering()}); forcing exit`,
				);
				for (const hook of hooks) {
					try {
						hook();
					} catch {
						// A forced exit goes ahead regardless.
					}
				}
				exit(1);
			}, grace);
			// The deadline itself never keeps the process alive.
			deadline.unref();
			return deadline;
		},
		finish(code) {
			// Only a shutdown that began has handles worth naming: a startup
			// refusal exits before the daemon ran, and its one fatal line is the
			// CLI's whole output contract (FLY-2885 QA@2).
			if (deadline) {
				clearTimeout(deadline);
				const open = lingering();
				if (open)
					log(
						`[voice] exiting after shutdown with handles still open (${open})`,
					);
			}
			const value = Number(code ?? 0);
			exit(Number.isInteger(value) ? value : 1);
		},
		onForcedExit(hook) {
			hooks.push(hook);
		},
	};
}

/**
 * The daemon's run → cleanup order, shared by the CLI and its process
 * test: a signal arms the deadline and asks the daemon to stop; run()
 * returning (after that stop, or on the idle exit) arms it too; cleanup then
 * runs, and the caller exits with `finish` once main settles.
 */
export async function superviseDaemon(input: {
	shutdownExit: ShutdownExit;
	run(): Promise<void>;
	requestStop(): void;
	cleanup(): Promise<void>;
	signals?: readonly NodeJS.Signals[];
}): Promise<void> {
	const signals = input.signals ?? (["SIGINT", "SIGTERM"] as const);
	const onSignal = () => {
		input.shutdownExit.begin("signal");
		input.requestStop();
	};
	for (const signal of signals) process.once(signal, onSignal);
	try {
		await input.run();
	} finally {
		input.shutdownExit.begin("run_returned");
		for (const signal of signals) process.off(signal, onSignal);
		await input.cleanup();
	}
}
