// FLY-1142 acceptance §6-5: provisional-threshold calibration soak against the
// REAL machine (no injection seam) at the production watchdog cadence (~30s).
// Records {ts, freePct, swapoutDelta, danger} per sample and asserts the
// representative window shows neither consecutive free<LOW nor consecutive
// swapoutDelta>MIN, and the monitor never triggers.
import { join } from "node:path";

const repo = "/Users/xiaorongli/Dev/flywheel-FLY-1142";
const {
	readMemoryPressure,
	MemoryPressureMonitor,
	memPressureThresholdsFromEnv,
} = await import(
	join(repo, "packages/teamlead/dist/bridge/machine-watermark.js")
);

const th = memPressureThresholdsFromEnv({}); // hard defaults: 8 / 15 / 0
const m = new MemoryPressureMonitor(th);
const SAMPLES = 8;
const INTERVAL_MS = 30_000;
const log = [];
let consecutiveFreeLow = 0;
let maxConsecutiveFreeLow = 0;
let consecutiveSwapout = 0;
let maxConsecutiveSwapout = 0;
let triggered = false;

for (let i = 0; i < SAMPLES; i++) {
	const p = await readMemoryPressure({});
	const ev = m.tick(p, Date.now());
	log.push({
		ts: new Date().toISOString(),
		freePct: ev.freePct?.toFixed(2) ?? null,
		swapoutDelta: ev.swapoutDelta,
		danger: ev.danger,
		healthy: ev.healthy,
		event: ev.event,
	});
	if (ev.freePct != null && ev.freePct < th.freeLowPct) {
		consecutiveFreeLow++;
		maxConsecutiveFreeLow = Math.max(maxConsecutiveFreeLow, consecutiveFreeLow);
	} else consecutiveFreeLow = 0;
	if (ev.swapoutDelta != null && ev.swapoutDelta > th.swapoutMinPages) {
		consecutiveSwapout++;
		maxConsecutiveSwapout = Math.max(maxConsecutiveSwapout, consecutiveSwapout);
	} else consecutiveSwapout = 0;
	if (ev.event === "trigger") triggered = true;
	if (i < SAMPLES - 1) await new Promise((r) => setTimeout(r, INTERVAL_MS));
}

console.log(JSON.stringify({ thresholds: th, samples: log }, null, 2));
const verdicts = [
	["no trigger over the soak window", !triggered && !m.inPressure],
	["never 2 consecutive free% < LOW", maxConsecutiveFreeLow < 2],
	["never 2 consecutive swapoutDelta > MIN", maxConsecutiveSwapout < 2],
];
let fail = 0;
for (const [name, okv] of verdicts) {
	console.log(`${okv ? "✓" : "✗"} ${name}`);
	if (!okv) fail++;
}
console.log(
	`maxConsecutiveFreeLow=${maxConsecutiveFreeLow} maxConsecutiveSwapout=${maxConsecutiveSwapout}`,
);
console.log(
	fail === 0
		? "SOAK VERDICT: PASS"
		: "SOAK VERDICT: FAIL (calibrate MIN before ship)",
);
process.exit(fail === 0 ? 0 : 1);
