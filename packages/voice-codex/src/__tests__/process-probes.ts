/**
 * FLY-2885: the voice tests' one way to probe, and one way to signal, a
 * process the test started itself (a daemon or app-server stand-in, a lead
 * alert's shell or its grandchild). Keeping every such call here keeps them
 * to two qa-only entries in the FLY-2211 kill-path inventory.
 */

function assertPid(pid: number): void {
	// 0 or a negative number would address a whole process group.
	if (!Number.isInteger(pid) || pid <= 0)
		throw new Error(`not a process id: ${pid}`);
}

/** Whether `pid` is still alive (a signal-0 probe). */
export function isAlive(pid: number): boolean {
	assertPid(pid);
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Signals a process this test started; one already gone is not an error.
 * Never a pid the test did not start.
 */
export function signalOwn(
	pid: number | undefined,
	signal: NodeJS.Signals,
): void {
	if (pid === undefined) return;
	assertPid(pid);
	try {
		process.kill(pid, signal);
	} catch {
		// Already gone.
	}
}
