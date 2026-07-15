// FLY-1193 §5 ship gate — offline replay of the SAME detector (MemoryPressure
// monitor 2-tick confirm + three-state health) PLUS the maybePage debounce over
// the busy-window soak trace, for a candidate MIN. The gate (§5-4): under the
// chosen MIN, the complete busy trace must produce ZERO page episode (no episode
// that both triggered AND persisted ≥ N seconds). Pure JS mirror of
// machine-watermark.ts (the state machine is byte-untouched by this issue) — no
// dist build needed on a memory-pressured host.
//
// Usage: node evidence-replay-gate.mjs <soak.jsonl> [MIN=0] [N_SEC=120] [LOW=8] [HIGH=15]
import { readFileSync } from "node:fs";

const FILE = process.argv[2] ?? "./soak.jsonl";
const MIN = Number(process.argv[3] ?? 0);
const N_SEC = Number(process.argv[4] ?? 120);
const LOW = Number(process.argv[5] ?? 8);
const HIGH = Number(process.argv[6] ?? 15);

const rows = readFileSync(FILE, "utf8")
	.trim()
	.split("\n")
	.map((l) => JSON.parse(l))
	.filter((r) => r.freePct != null);

// Replay the monitor (2-tick confirm; three-state health; clear on proven
// healthy) + the debounce page decision.
let lastSwapouts = null;
let consecutiveDanger = 0;
let inPressure = false;
let episodeStartTs = null;
let dangerTicks = 0;
let triggers = 0;
let pages = 0;
let maxEpisodeSec = 0;
const episodes = [];

for (const r of rows) {
	const ts = Date.parse(r.ts);
	let delta = null;
	if (lastSwapouts != null) {
		const d = r.swapoutsTotal - lastSwapouts;
		delta = d >= 0 ? d : null;
	}
	lastSwapouts = r.swapoutsTotal;

	const danger = r.freePct < LOW || (delta != null && delta > MIN);
	const healthy = delta == null ? null : r.freePct >= HIGH && delta <= MIN;
	if (danger) dangerTicks++;

	if (inPressure) {
		if (healthy === true) {
			const durSec = (ts - episodeStartTs) / 1000;
			maxEpisodeSec = Math.max(maxEpisodeSec, durSec);
			episodes.push({ durSec: Math.round(durSec), paged: durSec >= N_SEC });
			if (durSec >= N_SEC) pages++;
			inPressure = false;
			consecutiveDanger = 0;
			episodeStartTs = null;
		} else {
			// still in the episode — a page fires the moment elapsed ≥ N
			const elapsedSec = (ts - episodeStartTs) / 1000;
			if (elapsedSec >= N_SEC)
				maxEpisodeSec = Math.max(maxEpisodeSec, elapsedSec);
		}
	} else if (danger) {
		consecutiveDanger++;
		if (consecutiveDanger >= 2) {
			inPressure = true;
			episodeStartTs = ts;
			triggers++;
		}
	} else {
		consecutiveDanger = 0;
	}
}
// An episode still open at end-of-trace: did it already reach N?
if (inPressure && episodeStartTs != null) {
	const durSec = (Date.parse(rows.at(-1).ts) - episodeStartTs) / 1000;
	maxEpisodeSec = Math.max(maxEpisodeSec, durSec);
	episodes.push({
		durSec: Math.round(durSec),
		paged: durSec >= N_SEC,
		open: true,
	});
	if (durSec >= N_SEC) pages++;
}

const spanMin = (
	(Date.parse(rows.at(-1).ts) - Date.parse(rows[0].ts)) /
	60000
).toFixed(0);
console.log(
	`FLY-1193 replay gate — MIN=${MIN} N=${N_SEC}s LOW=${LOW} HIGH=${HIGH}`,
);
console.log(`  trace: ${rows.length} samples over ~${spanMin} min`);
console.log(
	`  danger ticks: ${dangerTicks} | triggers(episodes): ${triggers} | max episode: ${Math.round(maxEpisodeSec)}s`,
);
console.log(`  episodes: ${JSON.stringify(episodes)}`);
console.log(`  PAGE episodes (persisted ≥ ${N_SEC}s): ${pages}`);
console.log(
	pages === 0
		? "GATE: PASS (zero false page under this MIN)"
		: "GATE: FAIL (a busy-trace episode would page → recalibrate MIN or revisit N)",
);
process.exit(pages === 0 ? 0 : 1);
