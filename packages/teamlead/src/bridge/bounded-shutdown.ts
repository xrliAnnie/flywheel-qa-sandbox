/**
 * FLY-516: bounded Bridge shutdown.
 *
 * Root-cure for the "orphan Bridge holds :9876 → launchd KeepAlive crash-loops
 * on EADDRINUSE → 30-min wedge" incident (batch restart #2). The old SIGTERM
 * handler did `await close(); process.exit(0)` with NO timeout — if `close()`
 * (drain → teardownRuntimes → server.close) hangs, the process never exits and
 * the socket stays bound, so the launchd-respawned Bridge can never bind.
 *
 * This races `close()` against a bounded timeout. On timeout it force-exits so
 * the port is released (a process that exits on time can never become a
 * port-hogging zombie). Extracted from run-bridge.ts so the race is hermetically
 * unit-testable (inject `close` + `exit`, drive with fake timers) without
 * starting a real Bridge.
 */

export interface BoundedShutdownDeps {
	/** The Bridge teardown (drain + teardownRuntimes + server.close + store.close). */
	close: () => Promise<void>;
	/** Hard ceiling. If close() exceeds this, force-exit to release the port. */
	timeoutMs: number;
	/** Injectable for tests; defaults to process.exit. */
	exit?: (code: number) => void;
	log?: (msg: string) => void;
	errorLog?: (msg: string) => void;
}

/**
 * Run `close()` with a hard timeout.
 * - close() resolves in time  → exit(0) (graceful).
 * - close() throws            → exit(0) (logged; the process still dies so the
 *                               port releases — exit code only signals launchd,
 *                               which respawns on KeepAlive regardless).
 * - close() exceeds timeoutMs → exit(1) (forced; port released via process death).
 *
 * Idempotent on the exit path: a late close() resolution after the timeout fired
 * never triggers a second exit.
 */
export async function runBoundedShutdown(
	deps: BoundedShutdownDeps,
): Promise<void> {
	const exit = deps.exit ?? ((code: number) => process.exit(code));
	const log = deps.log ?? ((m: string) => console.log(m));
	const errorLog = deps.errorLog ?? ((m: string) => console.error(m));

	log("[run-bridge] Shutting down...");

	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		errorLog(
			`[run-bridge] close() exceeded ${deps.timeoutMs}ms — forcing exit(1) to release the port`,
		);
		exit(1);
	}, deps.timeoutMs);

	try {
		await deps.close();
	} catch (err) {
		errorLog(
			`[run-bridge] close() threw during shutdown: ${(err as Error).message}`,
		);
	} finally {
		// If the timeout already fired, the process is already exiting — do not
		// exit again (and do not clear a timer that already ran).
		if (!timedOut) {
			clearTimeout(timer);
			exit(0);
		}
	}
}
