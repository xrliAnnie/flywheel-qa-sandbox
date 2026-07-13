// QA·FLY-1193 — real-machine E2E for the OOM pressure-hold PAGE DEBOUNCE.
//
// Drives the ACTUAL FleetSensors + MemoryPressureMonitor + StateStore source
// (via tsx, no heavy dist build — the machine this fix protects is often under
// memory pressure, so a full `pnpm -r build` here would be self-defeating)
// through the REAL vm_stat parse seam (FLYWHEEL_SWAP_SENSOR_CMD → a temp file we
// rewrite per tick). Evidence: a REAL temp-file StateStore's fleet_pressure_hold
// timeline (placed → exists → cleared) + a dedup-aware load-shed broadcast
// recorder (simulating CommDB INSERT OR IGNORE) + the page (alert) count.
//
// Deliberately Discord-free: the page timeline + hold timeline + broadcast dedup
// are the issue's acceptance surface and are all observable without the Hub.
// Coverage boundary (honest): the actual cross-restart claims-dedup MECHANISM
// (claims.db / lead_events) is PRE-EXISTING FLY-1082/1142 alert-pipeline
// infrastructure with its own tests + the real-Discord FLY-1082 E2E
// (scripts/qa-fly-1082-fleet-alerts-e2e.mjs) — it is NOT re-verified here. What
// THIS issue must guarantee is that the page eventId is STABLE across a restart
// (so the existing dedup layer recognizes the repeat as the same identity); that
// stability is what scenario ⑤ + unit tests 7/8 assert. The StateStore-throw
// fail-loud path is covered by unit test 9.
//
// Usage: node --import tsx scripts/qa-fly-1193-debounce-e2e.mjs
//    (or: node_modules/.bin/tsx scripts/qa-fly-1193-debounce-e2e.mjs)
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const { FleetSensors } = await import(
	join(repoRoot, "packages/teamlead/src/bridge/fleet-sensors.ts")
);
const { StateStore } = await import(
	join(repoRoot, "packages/teamlead/src/StateStore.ts")
);

const workDir = mkdtempSync(join(tmpdir(), "fly1193-e2e-"));
const vmFile = join(workDir, "vm_stat.txt");
const TOTAL = 1_000_000; // pages; free% = (free+inactive)/TOTAL

// Write a vm_stat-shaped file for a target (freePct, swapouts) — the sensor's
// REAL readMemoryPressure/parseVmStat consumes it via FLYWHEEL_SWAP_SENSOR_CMD.
function setReading(freePct, swapouts) {
	const free = Math.round((freePct / 100) * TOTAL);
	const active = TOTAL - free;
	writeFileSync(
		vmFile,
		[
			"Mach Virtual Memory Statistics: (page size of 16384 bytes)",
			`Pages free:                        ${free}.`,
			`Pages active:                      ${active}.`,
			"Pages inactive:                    0.",
			"Pages speculative:                 0.",
			"Pages throttled:                   0.",
			"Pages wired down:                  0.",
			"Pages occupied by compressor:      0.",
			`Swapouts:                          ${swapouts}.`,
			"",
		].join("\n"),
	);
}

const LEADS = ["tadashi", "honey-lemon", "peter"];
let failures = 0;
function check(name, cond) {
	console.log(`${cond ? "✓" : "✗"} ${name}`);
	if (!cond) failures++;
}

async function scenario(title, envExtra, body) {
	console.log(`\n── ${title} ──`);
	const store = await StateStore.create(
		join(workDir, `${Date.now()}-${Math.round(performance.now())}.db`),
	);
	const alerts = [];
	const broadcasts = new Set(); // dedupeId set — CommDB INSERT OR IGNORE
	const broadcastLog = [];
	const holdTimeline = [];
	let now = 1_720_000_000_000;
	const env = {
		FLYWHEEL_SWAP_SENSOR_CMD: `cat ${vmFile}`,
		...envExtra,
	};
	const deps = {
		store,
		alert: async (p) => {
			alerts.push(p);
			return { sent: true };
		},
		resolveTicket: async () => {},
		notifyLead: async (_leadId, _content, dedupeId) => {
			if (dedupeId && broadcasts.has(dedupeId)) return true; // idempotent
			if (dedupeId) broadcasts.add(dedupeId);
			broadcastLog.push(dedupeId);
			return true;
		},
		listLeadIds: () => LEADS,
		env,
		now: () => now,
		logger: () => {},
	};
	let sensors = new FleetSensors(deps);
	const api = {
		alerts,
		broadcasts,
		broadcastLog,
		holdTimeline,
		store,
		setNow: (v) => {
			now = v;
		},
		advance: (ms) => {
			now += ms;
		},
		tick: async () => {
			await sensors.tick();
			holdTimeline.push(store.getFleetPressureHold()?.set_by ?? null);
		},
		restart: () => {
			sensors = new FleetSensors(deps); // fresh in-memory latches, same durable store
		},
	};
	await body(api);
}

// ① spike < N: hold placed silently, ZERO page / broadcast, hold timeline shows place→clear.
await scenario(
	"① spike (self-heals in < N): zero page, zero broadcast, hold placed then cleared",
	{},
	async (t) => {
		setReading(5, 1000);
		await t.tick(); // danger 1
		await t.tick(); // danger 2 → trigger, hold placed silently
		const placed = t.store.getFleetPressureHold()?.set_by === "swap-sensor";
		setReading(45, 1000);
		await t.tick(); // clear (< N elapsed)
		check("hold was placed at trigger (silent)", placed);
		check("zero page on the spike", t.alerts.length === 0);
		check("zero load-shed broadcast on the spike", t.broadcastLog.length === 0);
		check(
			"hold timeline shows placed then cleared",
			t.holdTimeline.includes("swap-sensor") &&
				t.store.getFleetPressureHold() === undefined,
		);
	},
);

// ② sustained ≥ N: exactly one page + one broadcast round; resolve after recovery.
await scenario(
	"② sustained (≥ N): exactly one page + one broadcast round, resolve on recovery",
	{},
	async (t) => {
		setReading(5, 1000);
		await t.tick();
		await t.tick(); // trigger at t0
		const holdSetAt = t.store.getFleetPressureHold()?.set_at;
		t.advance(121_000); // past N=120
		await t.tick(); // due → page + broadcast
		await t.tick(); // still danger → no repeat
		check("exactly one page after N", t.alerts.length === 1);
		check(
			"page eventId anchored to holdSetAt",
			t.alerts[0]?.eventId === `swap-pressure:${holdSetAt}`,
		);
		check(
			"exactly one broadcast per Lead",
			t.broadcastLog.length === LEADS.length,
		);
		setReading(45, 1000);
		await t.tick(); // clear
		check(
			"hold lifted on recovery",
			t.store.getFleetPressureHold() === undefined,
		);
	},
);

// ③ N=0 escape hatch: trigger tick pages immediately.
await scenario(
	"③ N=0: trigger tick pages immediately",
	{ FLYWHEEL_MEM_PAGE_DEBOUNCE_SEC: "0" },
	async (t) => {
		setReading(5, 1000);
		await t.tick();
		await t.tick(); // trigger + immediate page
		check("one page on the trigger tick", t.alerts.length === 1);
		check(
			"title marks page-delay closed",
			(t.alerts[0]?.title ?? "").includes("page 延迟已关闭"),
		);
	},
);

// ④ restart mid-debounce: fresh instance, durable hold, no immediate page; one page after re-reaching N.
await scenario(
	"④ restart mid-debounce: no immediate page; one page after re-reaching N",
	{},
	async (t) => {
		setReading(5, 1000);
		await t.tick();
		await t.tick(); // trigger at t0
		t.advance(60_000); // halfway through N
		t.restart(); // Bridge restart — in-memory episodeStart lost, durable hold kept
		await t.tick();
		await t.tick(); // fresh 2-tick confirm at the restarted clock
		check(
			"no page immediately after restart (debounce restarts)",
			t.alerts.length === 0,
		);
		t.advance(121_000);
		await t.tick(); // due → page
		check(
			"exactly one page once the fresh episode persists ≥ N",
			t.alerts.length === 1,
		);
	},
);

// ⑤ restart after-page: a FRESH re-triggered page after restart carries the
//    IDENTICAL eventId (the claims-dedup enabler — the real Hub/claims layer
//    dedups the repeat by this identity; this harness has no claims layer, so it
//    intentionally SEES the second alert and asserts its identity is stable).
await scenario(
	"⑤ restart after-page: a freshly re-triggered page carries the SAME durable eventId",
	{},
	async (t) => {
		setReading(5, 1000);
		await t.tick();
		await t.tick(); // trigger
		const holdSetAt = t.store.getFleetPressureHold()?.set_at;
		t.advance(121_000);
		await t.tick(); // page #1
		const id1 = t.alerts[0]?.eventId;
		t.restart(); // durable hold survives; in-memory paged-latch lost
		setReading(5, 1000); // pressure still real
		await t.tick();
		await t.tick(); // fresh 2-tick confirm re-triggers the episode (existing_sensor)
		t.advance(121_000);
		await t.tick(); // fresh episode persisted ≥ N → page #2 (no claims layer here)
		check(
			"a fresh page really fires after restart (proves it's not the stale alert)",
			t.alerts.length === 2,
		);
		check(
			"both page eventIds anchor the same durable holdSetAt (real Hub/claims dedups by this identity)",
			id1 === `swap-pressure:${holdSetAt}` && t.alerts[1]?.eventId === id1,
		);
	},
);

rmSync(workDir, { recursive: true, force: true });
console.log(
	`\n${failures === 0 ? "E2E VERDICT: PASS" : `E2E VERDICT: FAIL (${failures})`}`,
);
process.exit(failures === 0 ? 0 : 1);
