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
export const SHUTDOWN_EXIT_GRACE_MS = 15_000;

/** Handle kinds that never keep a process alive on their own. */
const IDLE_KINDS = new Set(["Timeout", "Immediate", "TTYWrap"]);

export function createShutdownExit(
	options: {
		/** Covers the 5 s close barrier and the last Bridge writes; below launchd's 20 s ExitTimeOut. */
		graceMs?: number;
		resources?: () => string[];
		exit?: (code: number) => void;
		log?: (line: string) => void;
	} = {},
) {
	const graceMs = options.graceMs ?? SHUTDOWN_EXIT_GRACE_MS;
	const exit = options.exit ?? ((code: number) => process.exit(code));
	const log = options.log ?? ((line: string) => console.error(line));
	const lingering = () => {
		const counts = new Map<string, number>();
		for (const kind of (
			options.resources ?? (() => process.getActiveResourcesInfo())
		)())
			if (!IDLE_KINDS.has(kind)) counts.set(kind, (counts.get(kind) ?? 0) + 1);
		return [...counts].map(([kind, count]) => `${kind}×${count}`).join(", ");
	};
	let deadline: ReturnType<typeof setTimeout> | undefined;
	return {
		/** Shutdown started (a signal, or run() returning on the idle exit). */
		begin(reason: string): ReturnType<typeof setTimeout> {
			deadline ??= setTimeout(() => {
				log(
					`[voice] shutdown (${reason}) overran ${graceMs} ms with handles still open (${lingering()}); forcing exit`,
				);
				exit(1);
			}, graceMs);
			// The deadline itself never keeps the process alive.
			deadline.unref();
			return deadline;
		},
		/** Cleanup is done: exit now rather than wait for leaked handles. */
		finish(code: number | string | undefined | null): void {
			if (deadline) clearTimeout(deadline);
			const open = lingering();
			if (open)
				log(`[voice] exiting after shutdown with handles still open (${open})`);
			const value = Number(code ?? 0);
			exit(Number.isInteger(value) ? value : 1);
		},
	};
}
