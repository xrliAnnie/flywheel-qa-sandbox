// FLY-1193 §5-1 busy-window calibration soak — READ-ONLY vm_stat at the
// production watchdog cadence (~30s). Records the raw distribution
// {ts, freePct, swapoutsTotal, swapoutDelta} per sample to a JSONL file so the
// offline replay (evidence-replay-gate.mjs) can re-run the REAL detector under
// candidate MIN values. Deliberately dist-independent (inline vm_stat parse
// mirroring machine-watermark.parseVmStat) so it can capture a live busy peak
// without waiting for a build. NO synthetic memory pressure (7-09 OOM
// precedent) — just observes whatever the machine organically does.
//
// Usage: node evidence-soak-collect.mjs <out.jsonl> [intervalMs] [samples]
import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const OUT = process.argv[2] ?? "./soak.jsonl";
const INTERVAL_MS = Number(process.argv[3]) || 30_000;
const SAMPLES = Number(process.argv[4]) || 240; // ~2h at 30s

const VM_STAT_BUCKETS = [
	"Pages free",
	"Pages active",
	"Pages inactive",
	"Pages speculative",
	"Pages throttled",
	"Pages wired down",
	"Pages occupied by compressor",
];

function parseVmStat(out) {
	const count = (label) => {
		const m = out.match(new RegExp(`^${label}:\\s+(\\d+)\\.?\\s*$`, "m"));
		if (!m) return null;
		const v = Number(m[1]);
		return Number.isFinite(v) ? v : null;
	};
	const buckets = [];
	for (const label of VM_STAT_BUCKETS) {
		const v = count(label);
		if (v == null) return null;
		buckets.push(v);
	}
	const swapouts = count("Swapouts");
	if (swapouts == null) return null;
	const total = buckets.reduce((a, b) => a + b, 0);
	if (!(total > 0)) return null;
	return {
		freePct: ((buckets[0] + buckets[2]) / total) * 100,
		swapoutsTotal: swapouts,
	};
}

async function readOnce() {
	try {
		const { stdout } = await execFileAsync("vm_stat", [], { timeout: 5000 });
		return parseVmStat(stdout);
	} catch {
		return null;
	}
}

let lastSwapouts = null;
for (let i = 0; i < SAMPLES; i++) {
	const p = await readOnce();
	let swapoutDelta = null;
	if (p && lastSwapouts != null) {
		const d = p.swapoutsTotal - lastSwapouts;
		swapoutDelta = d >= 0 ? d : null;
	}
	if (p) lastSwapouts = p.swapoutsTotal;
	const rec = {
		ts: new Date().toISOString(),
		freePct: p ? Number(p.freePct.toFixed(3)) : null,
		swapoutsTotal: p ? p.swapoutsTotal : null,
		swapoutDelta,
	};
	appendFileSync(OUT, `${JSON.stringify(rec)}\n`);
	if (i < SAMPLES - 1) await new Promise((r) => setTimeout(r, INTERVAL_MS));
}
