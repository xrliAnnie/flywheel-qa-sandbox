/**
 * FLY-1766 QA A1 — real sandbox child for the BridgeEventLoopGuard SIGKILL proof.
 *
 * Uses the PRODUCTION class (testMode: false, real worker_threads worker, real
 * SharedArrayBuffer heartbeat). argv[2] picks the scenario:
 *   stall   → block the main loop forever; the guard must SIGKILL this process
 *   healthy → stay alive and responsive; the guard must NOT kill it
 *   killswitch → FLYWHEEL_BRIDGE_LOOP_GUARD=0 + block the loop; must NOT be killed
 */
import { BridgeEventLoopGuard } from "../frozen-838/packages/teamlead/src/bridge/BridgeEventLoopGuard.js";

const mode = process.argv[2] ?? "stall";
const logPath = process.argv[3] ?? "/tmp/qa1766-loopguard.log";

const guard = new BridgeEventLoopGuard({
	heartbeatIntervalMs: 100,
	stallThresholdMs: 2_000,
	checkIntervalMs: 250,
	logPath,
});
guard.start();
process.stdout.write(`READY enabled=${guard.isEnabled()}\n`);

if (mode === "healthy") {
	// Alive and doing real work, but never blocking the loop.
	setInterval(() => {
		let x = 0;
		for (let i = 0; i < 1e6; i += 1) x += i;
		void x;
	}, 50);
	setTimeout(() => {
		process.stdout.write("SURVIVED\n");
		process.exit(0);
	}, 8_000);
} else {
	// Let the heartbeat establish, then wedge the main loop exactly like the
	// 2026-06-17 sql.js/WASM trap did: a synchronous spin that never yields.
	setTimeout(() => {
		process.stdout.write("WEDGING\n");
		const until = Date.now() + 20_000;
		// biome-ignore lint: deliberate busy-wait — this is the hang under test
		while (Date.now() < until) {
			/* spin */
		}
		process.stdout.write("ESCAPED\n");
		process.exit(0);
	}, 1_000);
}
