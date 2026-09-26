/**
 * FLY-2885 QA@1: once the daemon has shut down and released its lock,
 * nothing may keep the process alive. A library that leaks a handle
 * (werift left two UDP sockets after every bundled session) otherwise leaves
 * an orphan daemon that holds no lock yet stops the next `launchctl
 * kickstart` from starting a fresh one. The timer is unref'd, so a clean
 * shutdown still exits on its own; it fires only when something lingers.
 */
export function exitAfterShutdown(
	options: {
		graceMs?: number;
		resources?: () => string[];
		exitCode?: () => number | string | undefined | null;
		exit?: (code: number) => void;
		log?: (line: string) => void;
	} = {},
): ReturnType<typeof setTimeout> {
	const timer = setTimeout(() => {
		const counts = new Map<string, number>();
		for (const kind of (
			options.resources ?? (() => process.getActiveResourcesInfo())
		)())
			counts.set(kind, (counts.get(kind) ?? 0) + 1);
		const summary = [...counts]
			.map(([kind, count]) => `${kind}×${count}`)
			.join(", ");
		(options.log ?? ((line) => console.error(line)))(
			`[voice] handles kept the daemon alive after shutdown (${summary}); exiting`,
		);
		const code = Number((options.exitCode ?? (() => process.exitCode))() ?? 0);
		(options.exit ?? ((value) => process.exit(value)))(
			Number.isInteger(code) ? code : 1,
		);
	}, options.graceMs ?? 5_000);
	timer.unref();
	return timer;
}
