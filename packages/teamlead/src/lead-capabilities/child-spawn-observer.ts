import { AsyncLocalStorage } from "node:async_hooks";

/**
 * FLY-2886 plan v12 §14.2: a voice admission records the exact identity of every
 * child process it causes to exist, so a failed admission can reap them by
 * identity. The observer is scoped to the admission's async context; spawns
 * outside it are never reported.
 */
const observer = new AsyncLocalStorage<(pid: number) => void>();

export function observeChildSpawns<T>(
	onSpawned: (pid: number) => void,
	run: () => T,
): T {
	return observer.run(onSpawned, run);
}

/** Called right after a parent-owned child is spawned. Never throws. */
export function reportChildSpawned(pid: number | undefined): void {
	if (!pid) return;
	try {
		observer.getStore()?.(pid);
	} catch {
		// Reporting is evidence for later reaping; it must not fail the spawn.
	}
}
