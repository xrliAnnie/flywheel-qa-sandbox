// QA·FLY-1142 — independent behavioral verification of the real-memory-pressure
// swap sensor, driving the ACTUAL compiled teamlead dist end-to-end:
//   real readMemoryPressure (via the FLYWHEEL_SWAP_SENSOR_CMD injection seam) →
//   parseVmStat → MemoryPressureMonitor → FleetSensors → real StateStore →
//   real RunnerAdmissionController (pressure-hold probe).
//
// This is NOT the implement-phase's own harness — it is an independent QA
// session exercising the real dist through the plan §6 acceptance sequences,
// plus the LIVE scar on this very machine (scarred swap watermark + healthy
// free%), the exact 2026-07-10 incident condition.
//
// Usage: node qa-fly-1142-harness.mjs
// Requires: built teamlead dist.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Portable: this file lives at engineering/doc/FLY-1142-.../ — repo root is 3 up.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const tl = (p) => import(join(ROOT, "packages/teamlead/dist", p));

const { StateStore } = await tl("StateStore.js");
const { FleetSensors, fleetCorrelationKey } = await tl(
	"bridge/fleet-sensors.js",
);
const { parseVmStat, memPressureThresholdsFromEnv } = await tl(
	"bridge/machine-watermark.js",
);
const { RunnerAdmissionController } = await tl("bridge/runner-admission.js");

let pass = 0;
let fail = 0;
const fails = [];
function check(name, cond, extra = "") {
	if (cond) {
		pass++;
		console.log(`  ✅ ${name}${extra ? ` — ${extra}` : ""}`);
	} else {
		fail++;
		fails.push(name);
		console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ""}`);
	}
}

// A vm_stat-shaped fixture the injection seam emits (16 KiB page header — the
// exact page-size trap; free% must ignore it).
const dir = mkdtempSync(join(tmpdir(), "qa-fly1142-"));
function vmstat({
	free,
	active,
	inactive,
	spec = 1000,
	wired = 400000,
	comp = 900000,
	swapouts,
}) {
	return [
		"Mach Virtual Memory Statistics: (page size of 16384 bytes)",
		`Pages free:                               ${free}.`,
		`Pages active:                            ${active}.`,
		`Pages inactive:                          ${inactive}.`,
		`Pages speculative:                        ${spec}.`,
		"Pages throttled:                              0.",
		`Pages wired down:                        ${wired}.`,
		"Pages purgeable:                          10496.",
		`Pages occupied by compressor:           ${comp}.`,
		`Swapouts:                              ${swapouts}.`,
		"",
	].join("\n");
}
let seq = 0;
function seam(reading) {
	// Each call gets its own file so a scenario can flip readings between ticks.
	const f = join(dir, `vm-${seq++}.txt`);
	writeFileSync(f, vmstat(reading));
	return `cat ${f}`;
}

// A healthy reading (~45% free) and a danger reading (~4% free). Big-denominator
// so free/inactive dominate the ratio predictably.
const HEALTHY = {
	free: 900000,
	active: 600000,
	inactive: 400000,
	swapouts: 1000,
};
const LOWFREE = {
	free: 20000,
	active: 1800000,
	inactive: 20000,
	swapouts: 1000,
};

function makeSensors(store, env, alerts, resolved, notified) {
	return new FleetSensors({
		store,
		alert: async (p) => {
			alerts.push(p);
			return { sent: true };
		},
		resolveTicket: async (ck) => resolved.push(ck),
		notifyLead: async (leadId, content) => {
			notified.push({ leadId, content });
			return true;
		},
		listLeadIds: () => ["tadashi", "honey-lemon", "peter"],
		env, // real readMemoryPressure(env) reads env.FLYWHEEL_SWAP_SENSOR_CMD
		now: (() => {
			let t = 1_720_000_000_000;
			return () => {
				t += 30_000; // 30s watchdog cadence
				return t;
			};
		})(),
		logger: () => {},
	});
}

// Admission wired exactly like plugin.ts:3012 — probe reads the real hold.
function admission(store) {
	const a = new RunnerAdmissionController({
		availMemFn: () => Number.MAX_SAFE_INTEGER,
		loadavgFn: () => [0, 0, 0],
		cpuCount: 8,
	});
	a.setPressureHoldProbe(() => {
		const hold = store.getFleetPressureHold();
		return hold ? `fleet pressure-hold active (by ${hold.set_by})` : null;
	});
	return a;
}

console.log("\n════ Thresholds in effect ════");
const th = memPressureThresholdsFromEnv({});
console.log(
	`  LOW=${th.freeLowPct}  HIGH=${th.freeHighPct}  SWAPOUT_MIN=${th.swapoutMinPages}`,
);
check(
	"default thresholds LOW=8/HIGH=15/MIN=0",
	th.freeLowPct === 8 && th.freeHighPct === 15 && th.swapoutMinPages === 0,
);

// ─── ★ LIVE SCAR (this machine, right now) ─────────────────────────────────
console.log(
	"\n════ ★ LIVE SCAR — real vm_stat + real sysctl on THIS machine ════",
);
let realVmStat, realSwap;
try {
	realVmStat = execFileSync("vm_stat").toString();
	realSwap = execFileSync("sysctl", ["vm.swapusage"]).toString().trim();
} catch {
	console.log(
		"  (vm_stat/sysctl unavailable — non-macOS host; skipping the live-scar section)",
	);
}
if (realVmStat && realSwap) {
	const parsed = parseVmStat(realVmStat);
	// Old signal: swap used-% from the watermark (the monotonic scar).
	const m = realSwap.match(/total = ([\d.]+)M\s+used = ([\d.]+)M/);
	const usedPct = m ? (Number(m[2]) / Number(m[1])) * 100 : NaN;
	console.log(
		`  old swap watermark: ${usedPct.toFixed(1)}% used  (${realSwap})`,
	);
	console.log(
		`  new free% signal:   ${parsed ? parsed.freePct.toFixed(1) : "null"}% free`,
	);
	check("real vm_stat parses (no null on a live machine)", parsed != null);
	// The whole point: a real reading via the seamless default path is healthy
	// even though the swap watermark is scarred high.
	const alerts = [],
		resolved = [],
		notified = [];
	const store = await StateStore.create(":memory:");
	// Preset the stranded hold the old sensor would have left (the 8h blackout).
	store.setFleetPressureHold({
		setBy: "swap-sensor",
		watermark: `${usedPct.toFixed(1)}% used`,
	});
	const adm = admission(store);
	check(
		"stranded hold blocks admission BEFORE the new sensor runs",
		adm.tryAdmit().admit === false,
		adm.tryAdmit().reason,
	);
	// Drive the REAL default path (NO injection) — env has no seam, so it runs
	// the real vm_stat via readMemoryPressure. Two ticks: baseline then a
	// second reading that proves health → lift.
	const sensors = makeSensors(store, {}, alerts, resolved, notified);
	await sensors.tick(); // baseline: delta unknown → no lift
	const heldAfter1 = store.getFleetPressureHold();
	await sensors.tick(); // second real sample: delta computable, free% healthy → lift
	const heldAfter2 = store.getFleetPressureHold();
	if (usedPct > 65 && parsed && parsed.freePct >= th.freeHighPct) {
		// This is the genuine scar condition. First sample must NOT lift; second must.
		check(
			"scar: 1st real sample does NOT lift (no delta baseline)",
			heldAfter1 != null,
		);
		check(
			"scar: 2nd real sample lifts the stranded hold (proven healthy)",
			heldAfter2 == null,
		);
		check("admission restored after lift", adm.tryAdmit().admit === true);
		check(
			"no false alert on a healthy scarred machine",
			alerts.length === 0,
			`alerts=${alerts.length}`,
		);
		console.log(
			"  → the exact 2026-07-10 incident condition is present on this box and the fix clears it",
		);
	} else {
		console.log(
			`  (machine not in scar condition right now: usedPct=${usedPct.toFixed(1)} freePct=${parsed?.freePct?.toFixed(1)} — skipping live-lift asserts)`,
		);
	}
}

// ─── ① trigger, free-low branch ────────────────────────────────────────────
console.log("\n════ ① trigger — free-low branch (2-tick) ════");
{
	const alerts = [],
		resolved = [],
		notified = [];
	const store = await StateStore.create(":memory:");
	const adm = admission(store);
	check("admission open before pressure", adm.tryAdmit().admit === true);
	const env = {};
	const sensors = makeSensors(store, env, alerts, resolved, notified);
	env.FLYWHEEL_SWAP_SENSOR_CMD = seam(LOWFREE);
	await sensors.tick();
	check(
		"1st low-free tick: no alert yet (confirm pending)",
		alerts.length === 0,
	);
	env.FLYWHEEL_SWAP_SENSOR_CMD = seam(LOWFREE);
	await sensors.tick();
	check(
		"2nd low-free tick: severe ticket fired",
		alerts.length === 1 && alerts[0].severity === "severe",
		alerts[0]?.eventType,
	);
	check("alert body names free%", /free/.test(alerts[0]?.body ?? ""));
	// ARC places the hold; admission then really defers.
	await sensors.swapPressureRepair(alerts[0]);
	check(
		"swapPressureRepair placed the hold",
		store.getFleetPressureHold()?.set_by === "swap-sensor",
	);
	check(
		"hold watermark is free% (not swap%)",
		/% free/.test(store.getFleetPressureHold()?.watermark ?? ""),
		store.getFleetPressureHold()?.watermark,
	);
	const dec = adm.tryAdmit();
	check(
		"admission now DEFERS with reason=pressure_hold",
		dec.admit === false && dec.reason === "pressure_hold",
	);
	check("load-shed broadcast to all 3 Leads", notified.length === 3);
}

// ─── ①′ trigger, swapout branch (healthy free%) ────────────────────────────
console.log(
	"\n════ ①′ trigger — swapout branch (baseline + 2 delta ticks) ════",
);
{
	const alerts = [],
		resolved = [],
		notified = [];
	const store = await StateStore.create(":memory:");
	const env = {};
	const sensors = makeSensors(store, env, alerts, resolved, notified);
	env.FLYWHEEL_SWAP_SENSOR_CMD = seam({ ...HEALTHY, swapouts: 1_000_000 });
	await sensors.tick(); // baseline, delta unknown
	check("baseline sample: no alert", alerts.length === 0);
	env.FLYWHEEL_SWAP_SENSOR_CMD = seam({ ...HEALTHY, swapouts: 1_005_000 }); // +5000
	await sensors.tick();
	check("delta tick 1: no alert (confirm pending)", alerts.length === 0);
	env.FLYWHEEL_SWAP_SENSOR_CMD = seam({ ...HEALTHY, swapouts: 1_010_000 }); // +5000
	await sensors.tick();
	check(
		"delta tick 2: severe swapout ticket fired",
		alerts.length === 1,
		alerts[0]?.eventType,
	);
	check(
		"alert body names active swapout",
		/swapout/.test(alerts[0]?.body ?? ""),
	);
}

// ─── ② immediate clear (Tadashi's hard requirement, no fake green) ──────────
console.log(
	"\n════ ② pressure → recovery: IMMEDIATE clear (no 2nd recovery sample) ════",
);
{
	const alerts = [],
		resolved = [],
		notified = [];
	const store = await StateStore.create(":memory:");
	const adm = admission(store);
	const env = {};
	const sensors = makeSensors(store, env, alerts, resolved, notified);
	env.FLYWHEEL_SWAP_SENSOR_CMD = seam(LOWFREE);
	await sensors.tick();
	env.FLYWHEEL_SWAP_SENSOR_CMD = seam(LOWFREE);
	await sensors.tick(); // trigger
	await sensors.swapPressureRepair(alerts[0]);
	check(
		"in pressure, hold placed, admission blocked",
		adm.tryAdmit().admit === false,
	);
	// Recovery: free% back to healthy AND Swapouts static (delta 0) → clear NOW.
	env.FLYWHEEL_SWAP_SENSOR_CMD = seam({ ...HEALTHY, swapouts: 1000 }); // same swapouts as LOWFREE
	await sensors.tick();
	check(
		"clear on the FIRST healthy sample (hold lifted)",
		store.getFleetPressureHold() === undefined,
	);
	check(
		"ticket quiet-resolved",
		resolved.includes(fleetCorrelationKey("swap", "swap_pressure_high")),
	);
	check("admission RESTORED", adm.tryAdmit().admit === true);
}

// ─── ②′ active-swapout blocks clear even with free% back (AND-release) ──────
console.log(
	"\n════ ②′ AND-release: free% recovered but still thrashing → NO clear ════",
);
{
	const alerts = [],
		resolved = [],
		notified = [];
	const store = await StateStore.create(":memory:");
	const env = {};
	const sensors = makeSensors(store, env, alerts, resolved, notified);
	env.FLYWHEEL_SWAP_SENSOR_CMD = seam({ ...LOWFREE, swapouts: 1000 });
	await sensors.tick();
	env.FLYWHEEL_SWAP_SENSOR_CMD = seam({ ...LOWFREE, swapouts: 1000 });
	await sensors.tick(); // trigger
	await sensors.swapPressureRepair(alerts[0]);
	env.FLYWHEEL_SWAP_SENSOR_CMD = seam({ ...HEALTHY, swapouts: 50000 }); // free ok, delta huge
	await sensors.tick();
	check(
		"still thrashing → hold NOT lifted",
		store.getFleetPressureHold() != null,
	);
	check("no premature resolve", resolved.length === 0);
}

// ─── ③ restart / counter-reset stranded hold (2nd sample lifts) ────────────
console.log(
	"\n════ ③ restart-safety: stranded swap-sensor hold, fresh monitor ════",
);
{
	const alerts = [],
		resolved = [],
		notified = [];
	const store = await StateStore.create(":memory:");
	store.setFleetPressureHold({ setBy: "swap-sensor", watermark: "93.8% used" });
	const adm = admission(store);
	check(
		"stranded hold blocks admission at boot",
		adm.tryAdmit().admit === false,
	);
	const env = {};
	const sensors = makeSensors(store, env, alerts, resolved, notified); // fresh monitor
	env.FLYWHEEL_SWAP_SENSOR_CMD = seam({ ...HEALTHY, swapouts: 15_351_310 }); // scar swapouts, healthy free
	await sensors.tick();
	check(
		"1st post-restart sample does NOT lift (delta unknown)",
		store.getFleetPressureHold() != null,
	);
	env.FLYWHEEL_SWAP_SENSOR_CMD = seam({ ...HEALTHY, swapouts: 15_351_310 }); // static → delta 0
	await sensors.tick();
	check(
		"2nd static sample lifts (proven healthy)",
		store.getFleetPressureHold() === undefined,
	);
	check("admission restored", adm.tryAdmit().admit === true);
	check("zero new tickets across the scar recovery", alerts.length === 0);
}

// ─── ③′ manual hold is NEVER lifted by the sensor ──────────────────────────
console.log("\n════ ③′ manual hold immunity ════");
{
	const alerts = [],
		resolved = [],
		notified = [];
	const store = await StateStore.create(":memory:");
	store.setFleetPressureHold({ setBy: "annie-manual" });
	const env = {};
	const sensors = makeSensors(store, env, alerts, resolved, notified);
	env.FLYWHEEL_SWAP_SENSOR_CMD = seam({ ...HEALTHY, swapouts: 1000 });
	await sensors.tick();
	env.FLYWHEEL_SWAP_SENSOR_CMD = seam({ ...HEALTHY, swapouts: 1000 });
	await sensors.tick(); // proven healthy — but not ours to lift
	check(
		"manual hold survives proven-healthy readings",
		store.getFleetPressureHold()?.set_by === "annie-manual",
	);
}

// ─── ③″ probe failure never lifts ──────────────────────────────────────────
console.log("\n════ ③″ probe failure (seam exits non-zero) never lifts ════");
{
	const alerts = [],
		resolved = [],
		notified = [];
	const store = await StateStore.create(":memory:");
	store.setFleetPressureHold({ setBy: "swap-sensor", watermark: "93.8% used" });
	const env = { FLYWHEEL_SWAP_SENSOR_CMD: "exit 1" };
	const sensors = makeSensors(store, env, alerts, resolved, notified);
	await sensors.tick();
	await sensors.tick();
	check(
		"null reading (probe fail) never lifts a stranded hold",
		store.getFleetPressureHold() != null,
	);
}

console.log(
	`\n════ VERDICT: ${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed ════`,
);
if (fail > 0) {
	console.log("FAILURES:", fails.join(" | "));
	process.exit(1);
}
