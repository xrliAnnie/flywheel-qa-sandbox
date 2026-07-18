/**
 * QA·FLY-1365 — Capability ① (stall immunity) + ④ (regression of the 09:35 death form)
 *
 * Drives the REAL production code (imported from source):
 *   - ensureSessionWithRetryAsync (the fix)  vs  ensureSessionWithRetry (old sync compat)
 *   - the REAL BridgeEventLoopWatchdog worker (WATCHDOG_WORKER_SOURCE), in testMode,
 *     with a low stall threshold, observing the REAL heartbeat SharedArrayBuffer.
 *
 * Fault injection reproduces today's fatal path: the guarded tmux-server-rescue
 * ensure keeps returning `status=5 hold_lock_unavailable/acquire_timeout`, each
 * attempt eating time, for far longer than the watchdog's stall threshold.
 *
 * PASS criteria:
 *   A. ASYNC (fix): while ensure loops against lock-timeout for > threshold, the
 *      Bridge event loop keeps ticking (small max gap) AND the real watchdog worker
 *      NEVER posts "stall" (would-be SIGKILL never fires).
 *   B. SYNC (positive control = the OLD fatal path): a blocking spawnSync-style seam
 *      freezes the event loop; the real watchdog worker DOES post "stall" (proving the
 *      old path tripped the SIGKILL and that the detector actually works — no vacuous pass).
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import {
	ensureSessionWithRetry,
	ensureSessionWithRetryAsync,
} from "../../../../packages/claude-runner/src/codex-runner-tui-window.js";
import {
	BridgeEventLoopWatchdog,
	WATCHDOG_WORKER_SOURCE,
} from "../../../../packages/teamlead/src/bridge/BridgeEventLoopWatchdog.js";

const THRESHOLD_MS = 800; // low stall threshold so the test runs in seconds, not 60s
const HEARTBEAT_MS = 25;
const CHECK_MS = 50;
const ENSURE_RUN_MS = 2500; // > THRESHOLD_MS: ensure must loop for longer than the death line

type StallObserver = { stalled: boolean };

/** Build the REAL watchdog with a createWorker that runs the REAL worker source
 * and additionally records a "stall" postMessage (testMode) so we can observe it. */
function startRealWatchdog(
	observer: StallObserver,
	logPath = "",
): BridgeEventLoopWatchdog {
	const wd = new BridgeEventLoopWatchdog({
		enabled: true,
		testMode: true,
		heartbeatIntervalMs: HEARTBEAT_MS,
		stallThresholdMs: THRESHOLD_MS,
		checkIntervalMs: CHECK_MS,
		logPath, // scenario B writes a forensic line we read back for stall_age_ms
		createWorker: (source, opts) => {
			// source === WATCHDOG_WORKER_SOURCE (asserted below): the real worker code.
			const w = new Worker(source, opts as any);
			w.on("message", (m: unknown) => {
				if (m === "stall") observer.stalled = true;
			});
			return w as any;
		},
	});
	return wd;
}

/** Event-loop liveness probe: max gap between successive macrotask ticks. */
function startLoopProbe(): { stop: () => number } {
	let last = Date.now();
	let maxGap = 0;
	const t = setInterval(() => {
		const now = Date.now();
		maxGap = Math.max(maxGap, now - last);
		last = now;
	}, HEARTBEAT_MS);
	return {
		stop: () => {
			clearInterval(t);
			return maxGap;
		},
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

async function scenarioAsyncFix(): Promise<{
	maxGap: number;
	stalled: boolean;
	attempts: number;
}> {
	const observer: StallObserver = { stalled: false };
	const wd = startRealWatchdog(observer);
	wd.start();
	await sleep(HEARTBEAT_MS * 4); // let the worker seed + start checking
	const probe = startLoopProbe();

	let attempts = 0;
	const start = Date.now();
	// ASYNC ensure with an injected slow lock-timeout seam: EVERY attempt returns
	// status=5 (held / acquire_timeout) after a real async delay, exactly like the
	// tmux-server-rescue guard under lock contention on 07-18.
	await ensureSessionWithRetryAsync({
		now: Date.now,
		deadlineMs: ENSURE_RUN_MS,
		attemptCapMs: 400,
		cliPath: "/bin/true",
		socket: "/tmp/fly1365-qa.sock",
		session: "qa-async",
		log: () => {},
		spawn: async (_cmd, _args, _opts) => {
			attempts += 1;
			await sleep(200); // async: yields the loop — this is the whole point
			return { status: 5, stdout: '{"action":"hold_lock_unavailable"}' };
		},
		sleep: (ms) => sleep(ms),
	});
	const ranMs = Date.now() - start;
	const maxGap = probe.stop();
	await sleep(CHECK_MS * 3); // give the worker a final chance to (not) trip
	wd.stop();
	if (ranMs < THRESHOLD_MS) {
		throw new Error(
			`test invalid: async ensure only ran ${ranMs}ms (< threshold ${THRESHOLD_MS}) — didn't cross the death line`,
		);
	}
	return { maxGap, stalled: observer.stalled, attempts };
}

async function scenarioSyncOldPath(): Promise<{
	stalled: boolean;
	stallAgeMs: number | null;
}> {
	const observer: StallObserver = { stalled: false };
	const dir = mkdtempSync(join(tmpdir(), "fly1365-wd-"));
	const logPath = join(dir, "watchdog.log");
	const wd = startRealWatchdog(observer, logPath);
	wd.start();
	await sleep(HEARTBEAT_MS * 4);
	const probe = startLoopProbe();

	// OLD sync path: a spawnSync-style seam that BLOCKS the event loop (busy-wait),
	// reproducing spawnSync(tmux-server-rescue) hanging on lock acquisition. The
	// retained ensureSessionWithRetry is the exact code that ran on 07-18.
	const blockUntil = Date.now() + ENSURE_RUN_MS;
	ensureSessionWithRetry({
		now: Date.now,
		deadlineMs: ENSURE_RUN_MS + 5_000,
		attemptCapMs: ENSURE_RUN_MS + 5_000,
		cliPath: "/bin/true",
		socket: "/tmp/fly1365-qa.sock",
		session: "qa-sync",
		log: () => {},
		// Synchronous blocking seam: does NOT yield — freezes the loop like spawnSync.
		spawn: (_cmd, _args, _opts) => {
			const buf = new Int32Array(new SharedArrayBuffer(4));
			// Atomics.wait blocks THIS (main) thread — identical shape to a hung spawnSync.
			while (Date.now() < blockUntil) {
				Atomics.wait(buf, 0, 0, Math.min(50, blockUntil - Date.now()));
			}
			return { status: 0, stdout: "" }; // return success so it stops after one block
		},
		sleep: () => {},
	});
	// NOTE: a fully-frozen loop cannot measure its own gap (this probe couldn't fire
	// during the freeze). The INDEPENDENT watchdog worker thread is the instrument —
	// it read the stale heartbeat SAB and recorded a forensic stall line.
	probe.stop();
	await sleep(CHECK_MS * 6); // let the worker observe the stale heartbeat & write forensic
	wd.stop();
	let stallAgeMs: number | null = null;
	try {
		const lines = readFileSync(logPath, "utf8").trim().split("\n");
		for (let i = lines.length - 1; i >= 0; i -= 1) {
			const rec = JSON.parse(lines[i]);
			if (rec?.event === "bridge_event_loop_stall") {
				stallAgeMs = rec.stall_age_ms;
				break;
			}
		}
	} catch {
		/* no forensic line */
	}
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		/* best-effort */
	}
	return { stalled: observer.stalled, stallAgeMs };
}

async function main(): Promise<void> {
	// Guard: assert we are running the REAL worker source, not a stub.
	if (
		typeof WATCHDOG_WORKER_SOURCE !== "string" ||
		!WATCHDOG_WORKER_SOURCE.includes("bridge_event_loop_stall")
	) {
		throw new Error("WATCHDOG_WORKER_SOURCE is not the real worker code");
	}

	console.log(
		`config: threshold=${THRESHOLD_MS}ms heartbeat=${HEARTBEAT_MS}ms check=${CHECK_MS}ms ensureRun≈${ENSURE_RUN_MS}ms\n`,
	);

	const asyncRes = await scenarioAsyncFix();
	console.log("── Scenario A: ASYNC ensure (THE FIX) ──");
	console.log(
		`  ensure attempts under lock-timeout: ${asyncRes.attempts} (looped past the ${THRESHOLD_MS}ms death line)`,
	);
	console.log(`  event-loop max gap:  ${asyncRes.maxGap}ms`);
	console.log(`  watchdog fired SIGKILL(stall)? ${asyncRes.stalled}`);

	const syncRes = await scenarioSyncOldPath();
	console.log(
		"\n── Scenario B: SYNC ensure (OLD FATAL PATH — positive control) ──",
	);
	console.log(
		`  watchdog worker (independent thread) recorded stall_age_ms: ${syncRes.stallAgeMs}`,
	);
	console.log(`  watchdog fired SIGKILL(stall)? ${syncRes.stalled}`);

	// PASS logic
	const asyncImmune =
		asyncRes.stalled === false && asyncRes.maxGap < THRESHOLD_MS;
	const syncControlTrips =
		syncRes.stalled === true &&
		syncRes.stallAgeMs !== null &&
		syncRes.stallAgeMs >= THRESHOLD_MS;

	console.log("\n── Verdict ──");
	console.log(
		`  ① async is stall-immune (no self-kill, loop live): ${asyncImmune}`,
	);
	console.log(
		`  ④ old sync path DOES trip the watchdog (control):  ${syncControlTrips}`,
	);

	if (asyncImmune && syncControlTrips) {
		console.log(
			"\nRESULT: PASS ✅  (fix immune; positive control proves the detector + old death form)",
		);
		process.exit(0);
	}
	console.log("\nRESULT: FAIL ❌");
	process.exit(1);
}

main().catch((e) => {
	console.error("HARNESS ERROR:", e);
	process.exit(2);
});
