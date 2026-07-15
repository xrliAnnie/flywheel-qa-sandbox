/**
 * FLY-1082 (Tasks 2.2/2.5/2.6) + FLY-1142: the fleet sensor pack — memory
 * pressure episode lifecycle (trigger → hold → clear → resolve) on REAL
 * pressure signals (free% / swapout-delta, three-state health), idempotent
 * repair, bot-down latch + kickstart, throttled zombie scan with
 * batch-signature dedup, and the Hub recovery probe.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AlertPayload, AlertResult } from "../../LeadAlertNotifier.js";
import type { AlertThreadRow, StateStore } from "../../StateStore.js";
import { StateStore as RealStateStore } from "../../StateStore.js";
import {
	FleetSensors,
	fleetCorrelationKey,
	type InfraBotProbe,
	pageDebounceSecFromEnv,
} from "../fleet-sensors.js";
import type { MemoryPressure } from "../machine-watermark.js";
import { policyForKind } from "../ticket-escalation.js";
import type { ZombieFinding } from "../zombie-scan.js";

const pressure = (freePct: number, swapouts: number): MemoryPressure => ({
	freePct,
	swapoutsTotal: swapouts,
	pageSize: 16384,
});

function fleetRow(over: Partial<AlertThreadRow>): AlertThreadRow {
	return {
		correlation_key: "machine|swap|swap_pressure_high|",
		event_id: "e",
		episode_signature: null,
		thread_id: "t",
		root_message_id: null,
		channel_id: "c",
		lead_id: "swap",
		project_name: "machine",
		event_type: "swap_pressure_high",
		session_key: null,
		repair_status: null,
		opened_at: "2026-07-09 21:00:00",
		resolved_at: null,
		ticket_status: "NEW",
		owner_ref: "infra_bot:claude",
		attempt_count: 0,
		first_seen_at: "2026-07-09 21:00:00",
		acked_at: null,
		...over,
	} as AlertThreadRow;
}

/**
 * FLY-1193: the pressure-hold (machine-facing) is DECOUPLED from the page
 * (human-facing) — the hold is placed silently at trigger, but the page + Lead
 * load-shed broadcast only fire once the episode PERSISTS ≥ N seconds
 * (FLYWHEEL_MEM_PAGE_DEBOUNCE_SEC, default 120; explicit "0" = trigger-tick
 * page). These tests use a controllable fake hold-store so the durable `set_at`
 * (the sensor-owned episode identity) is deterministic across episodes — a real
 * second-precision `datetime('now')` would collide on same-second episodes.
 */
class FakeHoldStore {
	hold:
		| { set_by: string; set_at: string; watermark: string | null }
		| undefined;
	throwOnSet = false;
	constructor(private readonly clock: () => number) {}
	setFleetPressureHold(input: { setBy: string; watermark?: string }): boolean {
		if (this.throwOnSet) throw new Error("statestore write down");
		if (this.hold) return false; // INSERT OR IGNORE — first setter owns the row
		this.hold = {
			set_by: input.setBy,
			set_at: String(this.clock()),
			watermark: input.watermark ?? null,
		};
		return true;
	}
	getFleetPressureHold() {
		return this.hold;
	}
	clearFleetPressureHold(): boolean {
		const had = !!this.hold;
		this.hold = undefined;
		return had;
	}
}

describe("FleetSensors — memory pressure debounce (FLY-1193 / FLY-1142)", () => {
	let holdStore: FakeHoldStore;
	let store: StateStore;
	let alerts: AlertPayload[];
	let resolved: string[];
	let notified: Array<{ leadId: string; content: string; dedupeId?: string }>;
	let reading: MemoryPressure | null;
	let now: number;
	const LEADS = ["tadashi", "honey-lemon", "peter"];

	beforeEach(() => {
		now = 1_720_000_000_000;
		holdStore = new FakeHoldStore(() => now);
		store = holdStore as unknown as StateStore;
		alerts = [];
		resolved = [];
		notified = [];
		reading = null;
	});

	function makeSensors(env: Record<string, string> = {}) {
		return new FleetSensors({
			store,
			alert: async (p): Promise<AlertResult> => {
				alerts.push(p);
				return { sent: true };
			},
			resolveTicket: async (ck) => {
				resolved.push(ck);
			},
			notifyLead: async (leadId, content, dedupeId) => {
				notified.push({ leadId, content, dedupeId });
				return true;
			},
			listLeadIds: () => LEADS,
			readPressure: async () => reading,
			env: env as unknown as NodeJS.ProcessEnv,
			now: () => now,
			logger: () => {},
		});
	}

	// 1 — spike < N: hold placed silently at trigger, ZERO page; clear → lift + resolve.
	it("spike shorter than N: hold placed silently at trigger, zero page; clear lifts + resolves", async () => {
		const sensors = makeSensors(); // N=120 default
		reading = pressure(5, 1000);
		await sensors.tick(); // danger 1
		await sensors.tick(); // danger 2 → trigger; hold placed silently
		expect(store.getFleetPressureHold()?.set_by).toBe("swap-sensor");
		expect(alerts).toHaveLength(0); // debounce not elapsed
		expect(notified).toHaveLength(0);
		reading = pressure(45, 1000); // self-heal
		await sensors.tick(); // clear
		expect(store.getFleetPressureHold()).toBeUndefined();
		expect(resolved).toContain(
			fleetCorrelationKey("swap", "swap_pressure_high"),
		);
		expect(alerts).toHaveLength(0); // never paged, never re-delivered
	});

	// 2 — sustained ≥ N: page exactly once, eventId anchored to durable set_at.
	it("sustained ≥ N: pages exactly once (eventId anchored to holdSetAt); no repeat", async () => {
		const sensors = makeSensors(); // N=120
		reading = pressure(5, 1000);
		await sensors.tick();
		await sensors.tick(); // trigger at now=t0; elapsed 0 < N → no page
		expect(alerts).toHaveLength(0);
		const holdSetAt = store.getFleetPressureHold()!.set_at;
		now += 121_000; // past N
		await sensors.tick(); // still danger → due → page
		expect(alerts).toHaveLength(1);
		expect(alerts[0]!.eventType).toBe("swap_pressure_high");
		expect(alerts[0]!.severity).toBe("severe");
		expect(alerts[0]!.eventId).toBe(`swap-pressure:${holdSetAt}`);
		now += 60_000;
		await sensors.tick(); // already paged this episode → no repeat
		expect(alerts).toHaveLength(1);
	});

	// 2a — debounce boundary precision (FLY-1193 QA): the "≥ N" contract is exact —
	//      silent at elapsed = N − ε, pages at elapsed = N. The other tests jump to
	//      121s (well past); this pins the threshold itself so a future off-by-one
	//      (`>` vs `>=`) that lets a sub-N episode page can never regress silently.
	it("debounce boundary: silent at elapsed N−ε, pages at exactly N (the ≥ N contract)", async () => {
		const sensors = makeSensors(); // N=120
		reading = pressure(5, 1000);
		await sensors.tick();
		await sensors.tick(); // trigger at t0
		const holdSetAt = store.getFleetPressureHold()!.set_at;
		now += 120_000 - 1; // one ms below the debounce threshold
		await sensors.tick();
		expect(alerts).toHaveLength(0); // elapsed < N → still silent
		now += 1; // elapsed now exactly N seconds
		await sensors.tick();
		expect(alerts).toHaveLength(1); // elapsed >= N → pages
		expect(alerts[0]!.eventId).toBe(`swap-pressure:${holdSetAt}`);
	});

	// 2b — the production incident shape (FLY-1193 QA): a REAL pressure episode that
	//      persists across several ticks (not an elapsed≈0 blip) yet self-heals
	//      before N. Mirrors the 2026-07-12 09:04:31→09:05:01 (30s) alert_threads
	//      episode, generalized to ~95s. The whole issue: this must produce ZERO
	//      page, ZERO Lead load-shed broadcast — only a silent hold place→clear.
	it("multi-tick spike self-healing before N: persists across ticks yet zero page / zero broadcast", async () => {
		const sensors = makeSensors(); // N=120
		reading = pressure(5, 1000);
		await sensors.tick();
		await sensors.tick(); // trigger at t0; hold placed silently
		expect(store.getFleetPressureHold()?.set_by).toBe("swap-sensor");
		// still under real pressure across three more 30s ticks (cumulative 90s < N)
		for (let i = 0; i < 3; i++) {
			now += 30_000;
			reading = pressure(6, 1000); // free 6 < LOW 8 → still danger, monitor stays in-pressure
			await sensors.tick();
			expect(alerts).toHaveLength(0); // never paged inside the debounce window
			expect(notified).toHaveLength(0); // never broadcast
		}
		// self-heal at ~95s elapsed, still < N
		now += 5_000;
		reading = pressure(45, 1000);
		await sensors.tick(); // clear
		expect(store.getFleetPressureHold()).toBeUndefined(); // hold quietly lifted
		expect(alerts).toHaveLength(0); // zero page across the whole self-healed episode
		expect(notified).toHaveLength(0); // zero load-shed broadcast
		expect(resolved).toContain(
			fleetCorrelationKey("swap", "swap_pressure_high"),
		); // un-paged resolve is a safe no-op
	});

	// 3 — N=0 (explicit escape hatch): trigger tick pages once; title = "延迟已关闭", no "持续".
	it("N=0: trigger tick pages once per episode; title says page-delay closed, no 已持续", async () => {
		const sensors = makeSensors({ FLYWHEEL_MEM_PAGE_DEBOUNCE_SEC: "0" });
		reading = pressure(5, 1000);
		await sensors.tick();
		await sensors.tick(); // trigger + immediate page + broadcast
		expect(alerts).toHaveLength(1);
		expect(alerts[0]!.title).toContain("page 延迟已关闭");
		expect(alerts[0]!.body).not.toContain("已持续");
		// copy honesty: the Lead broadcast must NOT overstate duration at N=0.
		expect(notified).toHaveLength(3);
		expect(notified[0]!.content).toContain("page 延迟已关闭");
		expect(notified[0]!.content).not.toContain("已持续");
		await sensors.tick(); // same episode → no re-page
		expect(alerts).toHaveLength(1);
	});

	// 4 — page then clear: lift + resolve (current-behavior parity once paged).
	it("page then clear: lift + quiet-resolve", async () => {
		const sensors = makeSensors({ FLYWHEEL_MEM_PAGE_DEBOUNCE_SEC: "0" });
		reading = pressure(5, 1000);
		await sensors.tick();
		await sensors.tick(); // trigger + page
		expect(alerts).toHaveLength(1);
		reading = pressure(45, 1000);
		await sensors.tick(); // clear
		expect(store.getFleetPressureHold()).toBeUndefined();
		expect(resolved).toContain(
			fleetCorrelationKey("swap", "swap_pressure_high"),
		);
	});

	// 5 — broadcast fires on the PRIMARY path (maybePage), dedupeId anchored; latch; repair idempotent.
	it("load-shed broadcast: direct on the page due-point with a holdSetAt dedupeId; latch + repair idempotent", async () => {
		const sensors = makeSensors({ FLYWHEEL_MEM_PAGE_DEBOUNCE_SEC: "0" });
		reading = pressure(5, 1000);
		await sensors.tick();
		await sensors.tick(); // trigger + page + broadcast (maybePage direct call)
		const holdSetAt = store.getFleetPressureHold()!.set_at;
		expect(notified).toHaveLength(3);
		for (const leadId of LEADS) {
			expect(notified.find((n) => n.leadId === leadId)?.dedupeId).toBe(
				`swap-broadcast:${holdSetAt}:${leadId}`,
			);
		}
		await sensors.tick(); // same episode → latch blocks re-broadcast
		expect(notified).toHaveLength(3);
		await sensors.swapPressureRepair(alerts[0]!); // repair uses the same helper
		expect(notified).toHaveLength(3); // dedup — no re-send
	});

	// 6 — repair still broadcasts even when the hold is already placed (regression: old `!placed` swallow).
	it("repair broadcasts even when the hold was already placed (placed=false must NOT swallow the broadcast)", async () => {
		const sensors = makeSensors(); // N=120 → no auto-broadcast at trigger
		reading = pressure(5, 1000);
		await sensors.tick();
		await sensors.tick(); // trigger; hold placed; no page/broadcast yet
		expect(notified).toHaveLength(0);
		const holdSetAt = store.getFleetPressureHold()!.set_at;
		const r = await sensors.swapPressureRepair({
			leadId: "swap",
			projectName: "machine",
			eventId: `swap-pressure:${holdSetAt}`,
			eventType: "swap_pressure_high",
			title: "t",
			body: "b",
			severity: "severe",
		});
		expect(r.outcome).toBe("attempted");
		expect(notified).toHaveLength(3); // broadcast happened despite placed=false
	});

	// 7 — restart mid-debounce: fresh instance, durable sensor hold, no immediate page; eventId cross-restart stable.
	it("restart mid-debounce: fresh instance re-triggers idempotently, debounces from the new episodeStart, eventId stays anchored to holdSetAt", async () => {
		holdStore.setFleetPressureHold({
			setBy: "swap-sensor",
			watermark: "94.0%",
		});
		const holdSetAt = store.getFleetPressureHold()!.set_at;
		const sensors = makeSensors(); // fresh monitor = post-restart
		reading = pressure(5, 1_000_000);
		await sensors.tick();
		await sensors.tick(); // fresh trigger; hold already exists (existing_sensor)
		expect(alerts).toHaveLength(0); // debounce restarts from the new episodeStart
		now += 121_000;
		await sensors.tick(); // due → page
		expect(alerts).toHaveLength(1);
		expect(alerts[0]!.eventId).toBe(`swap-pressure:${holdSetAt}`); // stable via durable set_at
	});

	// 8 — crash-boundary identity stability: root page eventId + broadcast dedupeId anchor holdSetAt.
	it("crash boundary: root page eventId and broadcast dedupeId stay anchored to the durable holdSetAt", async () => {
		holdStore.setFleetPressureHold({
			setBy: "swap-sensor",
			watermark: "94.0%",
		});
		const holdSetAt = store.getFleetPressureHold()!.set_at;
		const sensors = makeSensors();
		reading = pressure(5, 1_000_000);
		await sensors.tick();
		await sensors.tick(); // fresh trigger
		now += 121_000;
		await sensors.tick(); // due → page + broadcast
		expect(alerts[0]!.eventId).toBe(`swap-pressure:${holdSetAt}`);
		for (const leadId of LEADS) {
			expect(notified.find((n) => n.leadId === leadId)?.dedupeId).toBe(
				`swap-broadcast:${holdSetAt}:${leadId}`,
			);
		}
	});

	// 8a — manual hold: a later episode is never permanently silenced (identity = episodeStart).
	it("manual hold overlay: a later episode still pages (identity anchors episodeStart, never permanently silenced)", async () => {
		holdStore.setFleetPressureHold({ setBy: "annie-manual" }); // not liftable
		const sensors = makeSensors({ FLYWHEEL_MEM_PAGE_DEBOUNCE_SEC: "0" });
		// episode A
		const startA = now;
		reading = pressure(5, 1000);
		await sensors.tick();
		await sensors.tick(); // trigger A + page
		expect(alerts).toHaveLength(1);
		expect(alerts[0]!.eventId).toBe(`swap-pressure:${startA}`); // episodeStart anchor
		// recover
		reading = pressure(45, 1000);
		now += 30_000;
		await sensors.tick(); // clear A (manual hold survives)
		expect(store.getFleetPressureHold()?.set_by).toBe("annie-manual");
		// episode B
		now += 30_000;
		const startB = now;
		reading = pressure(5, 1000);
		await sensors.tick();
		await sensors.tick(); // trigger B + page
		expect(alerts).toHaveLength(2);
		expect(alerts[1]!.eventId).toBe(`swap-pressure:${startB}`);
		expect(alerts[1]!.eventId).not.toBe(alerts[0]!.eventId); // B not swallowed
	});

	// 8b — broadcast partial failure: latch not set, next due tick retries only the missing Leads.
	it("broadcast partial failure: latch stays unset, next tick retries the missing Lead (CommDB dedup covers the rest)", async () => {
		const seen = new Set<string>();
		let failPeter = true;
		const sensors = new FleetSensors({
			store,
			alert: async (p): Promise<AlertResult> => {
				alerts.push(p);
				return { sent: true };
			},
			resolveTicket: async (ck) => {
				resolved.push(ck);
			},
			notifyLead: async (leadId, content, dedupeId) => {
				if (leadId === "peter" && failPeter) throw new Error("commdb down");
				if (dedupeId && seen.has(dedupeId)) return true; // INSERT OR IGNORE
				if (dedupeId) seen.add(dedupeId);
				notified.push({ leadId, content, dedupeId });
				return true;
			},
			listLeadIds: () => LEADS,
			readPressure: async () => reading,
			env: {
				FLYWHEEL_MEM_PAGE_DEBOUNCE_SEC: "0",
			} as unknown as NodeJS.ProcessEnv,
			now: () => now,
			logger: () => {},
		});
		reading = pressure(5, 1000);
		await sensors.tick();
		await sensors.tick(); // trigger + page + broadcast; peter throws → latch NOT set
		expect(notified.map((n) => n.leadId).sort()).toEqual([
			"honey-lemon",
			"tadashi",
		]);
		failPeter = false;
		await sensors.tick(); // latch unset → retry: tadashi/honey-lemon dedup, peter delivered
		expect(notified.filter((n) => n.leadId === "tadashi")).toHaveLength(1); // not doubled
		expect(notified.filter((n) => n.leadId === "peter")).toHaveLength(1); // now delivered
	});

	// 8c — page alert throws before durable: latch stays null, next tick retries → exactly one page.
	it("page alert throwing before durable handling: latch stays null, next tick retries → exactly one page", async () => {
		let firstAlert = true;
		const sensors = new FleetSensors({
			store,
			alert: async (p): Promise<AlertResult> => {
				if (firstAlert) {
					firstAlert = false;
					throw new Error("sink down");
				}
				alerts.push(p);
				return { sent: true };
			},
			resolveTicket: async () => {},
			notifyLead: async () => true,
			listLeadIds: () => [],
			readPressure: async () => reading,
			env: {
				FLYWHEEL_MEM_PAGE_DEBOUNCE_SEC: "0",
			} as unknown as NodeJS.ProcessEnv,
			now: () => now,
			logger: () => {},
		});
		reading = pressure(5, 1000);
		await sensors.tick();
		await sensors.tick(); // trigger → maybePage → alert throws (outer tick catch swallows)
		expect(alerts).toHaveLength(0);
		await sensors.tick(); // retry → alert returns sent
		expect(alerts).toHaveLength(1);
	});

	// 8d — cross-restart broadcast best-effort: a fresh instance that recovers before re-confirming lifts the hold safely.
	it("cross-restart broadcast is best-effort: a fresh instance that recovers before re-confirming lifts the hold safely (no durable outbox, no stale broadcast)", async () => {
		holdStore.setFleetPressureHold({
			setBy: "swap-sensor",
			watermark: "94.0%",
		});
		const sensors = makeSensors();
		reading = pressure(45, 100); // healthy free, static swap
		await sensors.tick(); // baseline: delta unknown → healthy null → no lift
		expect(store.getFleetPressureHold()).toBeDefined();
		await sensors.tick(); // proven healthy → restart-safety lift
		expect(store.getFleetPressureHold()).toBeUndefined();
		expect(notified).toHaveLength(0); // no stale broadcast re-sent
	});

	// 8e — delayed queue drain: prefix-aware precise matching (R4-2 + R5-4).
	it("delayed drain (i): repair on a recovered episode does NOT re-place the hold or re-broadcast", async () => {
		const sensors = makeSensors({ FLYWHEEL_MEM_PAGE_DEBOUNCE_SEC: "0" });
		reading = pressure(5, 1000);
		await sensors.tick();
		await sensors.tick(); // trigger + page
		const stalePayload = { ...alerts[0]! };
		const beforeNotified = notified.length;
		reading = pressure(45, 1000);
		now += 30_000;
		await sensors.tick(); // clear → hold lifted
		expect(store.getFleetPressureHold()).toBeUndefined();
		const r = await sensors.swapPressureRepair(stalePayload); // drained late
		expect(store.getFleetPressureHold()).toBeUndefined(); // NOT re-placed
		expect(r.action).toBe("none");
		expect(r.detail).toContain("已恢复");
		expect(notified).toHaveLength(beforeNotified); // no stale broadcast
	});

	it("delayed drain (ii): payload A drained during live episode B is a no-op — never re-targets B", async () => {
		const sensors = makeSensors({ FLYWHEEL_MEM_PAGE_DEBOUNCE_SEC: "0" });
		reading = pressure(5, 1000);
		await sensors.tick();
		await sensors.tick(); // trigger A
		const payloadA = { ...alerts[0]! };
		const holdA = store.getFleetPressureHold()!.set_at;
		reading = pressure(45, 1000);
		now += 30_000;
		await sensors.tick(); // clear A
		now += 30_000;
		reading = pressure(5, 1000);
		await sensors.tick();
		await sensors.tick(); // trigger B
		const holdB = store.getFleetPressureHold()!.set_at;
		expect(holdB).not.toBe(holdA);
		const notifiedBeforeDrain = notified.length;
		const r = await sensors.swapPressureRepair(payloadA); // A drained during live B
		expect(r.action).toBe("none");
		expect(notified).toHaveLength(notifiedBeforeDrain); // A's identity never used on B
	});

	it("delayed drain (iii): repair on the SAME live episode ensures hold + broadcasts (dedup, no double-send)", async () => {
		const sensors = makeSensors(); // N=120: no auto-broadcast yet
		reading = pressure(5, 1000);
		await sensors.tick();
		await sensors.tick(); // trigger; hold placed
		const holdSetAt = store.getFleetPressureHold()!.set_at;
		const r = await sensors.swapPressureRepair({
			leadId: "swap",
			projectName: "machine",
			eventId: `swap-pressure:${holdSetAt}`,
			eventType: "swap_pressure_high",
			title: "t",
			body: "b",
			severity: "severe",
		});
		expect(r.action).toBe("pressure_hold");
		expect(store.getFleetPressureHold()?.set_by).toBe("swap-sensor");
		expect(notified).toHaveLength(3);
	});

	it("delayed drain (iv): swap-holdfail prefix only retries the SAME still-unconfirmed episode", async () => {
		const sensors = makeSensors({ FLYWHEEL_MEM_PAGE_DEBOUNCE_SEC: "0" });
		// no live pressure — an old holdfail payload must be a no-op
		const r = await sensors.swapPressureRepair({
			leadId: "swap",
			projectName: "machine",
			eventId: `swap-holdfail:${now - 999}`,
			eventType: "swap_pressure_high",
			title: "t",
			body: "b",
			severity: "severe",
		});
		expect(r.action).toBe("none");
		expect(r.detail).toContain("hold-failure episode 已过去");
	});

	it("delayed drain (v): unknown / malformed eventId prefix → needs_human, zero side effect", async () => {
		const sensors = makeSensors();
		const r = await sensors.swapPressureRepair({
			leadId: "swap",
			projectName: "machine",
			eventId: "totally-bogus:123",
			eventType: "swap_pressure_high",
			title: "t",
			body: "b",
			severity: "severe",
		});
		expect(r.outcome).toBe("needs_human");
		expect(r.action).toBe("none");
		expect(store.getFleetPressureHold()).toBeUndefined();
		expect(notified).toHaveLength(0);
	});

	// 8e(vi) — an EMPTY suffix on a recognized prefix is a malformed identity →
	// needs_human, never a silent "already recovered" no-op (R6-2).
	it("delayed drain (vi): empty-suffix swap-pressure: / swap-holdfail: → needs_human, zero side effect", async () => {
		const sensors = makeSensors();
		for (const eventId of [
			"swap-pressure:",
			"swap-holdfail:",
			"swap-pressure:   ",
		]) {
			const r = await sensors.swapPressureRepair({
				leadId: "swap",
				projectName: "machine",
				eventId,
				eventType: "swap_pressure_high",
				title: "t",
				body: "b",
				severity: "severe",
			});
			expect(r.outcome, eventId).toBe("needs_human");
			expect(r.action, eventId).toBe("none");
		}
		expect(store.getFleetPressureHold()).toBeUndefined();
		expect(notified).toHaveLength(0);
	});

	// 9 — hold write failure → fail-loud page (independent eventId), then recovery restores normal debounce.
	it("hold placement failure: fail-loud page with an independent swap-holdfail eventId; recovery restores normal debounce", async () => {
		const sensors = makeSensors({ FLYWHEEL_MEM_PAGE_DEBOUNCE_SEC: "0" });
		holdStore.throwOnSet = true; // StateStore write down, get returns null
		reading = pressure(5, 1000);
		await sensors.tick();
		await sensors.tick(); // trigger → ensureSensorHold throws → unconfirmed → fail-loud
		expect(alerts).toHaveLength(1);
		expect(alerts[0]!.eventId).toMatch(/^swap-holdfail:/);
		expect(alerts[0]!.title).toContain("保护未能启用");
		await sensors.tick(); // still unconfirmed same episode → latch, no re-spam
		expect(alerts).toHaveLength(1);
		holdStore.throwOnSet = false; // StateStore recovers
		await sensors.tick(); // hold now placed → normal sustained page (N=0)
		expect(store.getFleetPressureHold()?.set_by).toBe("swap-sensor");
		expect(alerts).toHaveLength(2);
		expect(alerts[1]!.eventId).toMatch(/^swap-pressure:/);
	});

	// 10 — hold write failure but a MANUAL hold exists: not fail-loud; copy must not lie.
	it("hold write failure with an existing manual hold: not fail-loud; copy says manual (never sensor auto-lift)", async () => {
		const sensors = makeSensors({ FLYWHEEL_MEM_PAGE_DEBOUNCE_SEC: "0" });
		holdStore.hold = {
			set_by: "annie-manual",
			set_at: String(now),
			watermark: null,
		};
		holdStore.throwOnSet = true;
		reading = pressure(5, 1000);
		await sensors.tick();
		await sensors.tick(); // trigger → set throws, get returns manual → existing_manual → normal page
		expect(alerts).toHaveLength(1);
		expect(alerts[0]!.eventId).toMatch(/^swap-pressure:/); // NOT holdfail
		expect(alerts[0]!.body).toContain("人工 pressure-hold");
		expect(alerts[0]!.body).not.toContain("保护未能启用");
	});

	// 11 — four honest copy classes.
	it("copy class: sustained via swapout → 持续越阈 title, names the swapout branch", async () => {
		const sensors = makeSensors(); // N=120
		reading = pressure(45, 1000);
		await sensors.tick(); // baseline
		reading = pressure(45, 6000);
		await sensors.tick(); // delta 5000 danger 1
		reading = pressure(45, 11000);
		await sensors.tick(); // delta 5000 danger 2 → trigger
		now += 121_000;
		reading = pressure(45, 16000); // delta 5000 danger
		await sensors.tick(); // due → page
		expect(alerts[0]!.title).toContain("持续越阈");
		expect(alerts[0]!.body).toContain("swapout");
		expect(alerts[0]!.body).toContain("页/tick");
	});

	it("copy class: sustained in the hysteresis band → 持续中 title, never a false 'free% < LOW'", async () => {
		const sensors = makeSensors(); // N=120
		reading = pressure(5, 1000);
		await sensors.tick();
		await sensors.tick(); // trigger (danger)
		reading = pressure(12, 1000); // hysteresis: danger false, healthy false
		now += 121_000;
		await sensors.tick(); // due → page while in the band
		expect(alerts[0]!.title).toContain("持续中");
		expect(alerts[0]!.body).toContain("尚未回到恢复线");
		expect(alerts[0]!.body).not.toContain("< 8%");
	});

	// 12 — MIN>0 healthy release (public behavior; monitor source untouched).
	it("MIN>0: a delta below MIN with recovered free% releases (calibrated noise floor)", async () => {
		const sensors = makeSensors({ FLYWHEEL_MEM_SWAPOUT_MIN_PAGES: "50" });
		reading = pressure(5, 1000);
		await sensors.tick();
		await sensors.tick(); // trigger
		expect(store.getFleetPressureHold()).toBeDefined();
		reading = pressure(45, 1030); // delta 30 ≤ MIN 50, free ≥ HIGH → proven healthy
		await sensors.tick();
		expect(store.getFleetPressureHold()).toBeUndefined();
		expect(resolved).toContain(
			fleetCorrelationKey("swap", "swap_pressure_high"),
		);
	});

	// 13 — env validator.
	it("pageDebounceSecFromEnv: default 120; explicit 0; empty/whitespace/negative/NaN/Infinity → 120", () => {
		const p = (v?: string) =>
			pageDebounceSecFromEnv(
				(v === undefined
					? {}
					: {
							FLYWHEEL_MEM_PAGE_DEBOUNCE_SEC: v,
						}) as unknown as NodeJS.ProcessEnv,
			);
		expect(p()).toBe(120);
		expect(p("0")).toBe(0);
		expect(p("")).toBe(120);
		expect(p("  ")).toBe(120);
		expect(p("-5")).toBe(120);
		expect(p("abc")).toBe(120);
		expect(p("Infinity")).toBe(120);
		expect(p("300")).toBe(300);
	});

	// 14 — swap kind no-reconcile-retry sentinel (single-shot remediation).
	it("policyForKind(swap_pressure_high).retryOnReconcile === false (sentinel)", () => {
		expect(
			policyForKind("swap_pressure_high", {} as NodeJS.ProcessEnv)
				.retryOnReconcile,
		).toBe(false);
	});

	// 15 — kill switch + recoveryProbe + restart-safety + watermark parity (FLY-1142 preserved).
	it("kill switch FLYWHEEL_FLEET_SENSOR_SWAP=0 disables the sensor", async () => {
		const sensors = makeSensors({ FLYWHEEL_FLEET_SENSOR_SWAP: "0" });
		reading = pressure(2, 1000);
		await sensors.tick();
		await sensors.tick();
		expect(alerts).toHaveLength(0);
	});

	it("recoveryProbe is three-state: null before evidence, false in pressure, true when proven healthy", async () => {
		const sensors = makeSensors();
		expect(await sensors.recoveryProbe(fleetRow({}))).toBeNull();
		reading = pressure(5, 1000);
		await sensors.tick();
		expect(await sensors.recoveryProbe(fleetRow({}))).toBeNull();
		await sensors.tick(); // in pressure, free 5 < HIGH → proven not-healthy
		expect(await sensors.recoveryProbe(fleetRow({}))).toBe(false);
		reading = pressure(45, 1000);
		await sensors.tick(); // cleared + proven healthy
		expect(await sensors.recoveryProbe(fleetRow({}))).toBe(true);
	});

	it("restart safety: a stranded durable hold is NOT lifted on the first post-restart sample (delta unknown)", async () => {
		holdStore.setFleetPressureHold({
			setBy: "swap-sensor",
			watermark: "94.0%",
		});
		const sensors = makeSensors();
		reading = pressure(45, 15_000_000);
		await sensors.tick();
		expect(store.getFleetPressureHold()).toBeDefined();
		await sensors.tick(); // second static sample: delta 0 → PROVEN healthy
		expect(store.getFleetPressureHold()).toBeUndefined();
	});

	it("restart with pressure STILL real keeps the hold (and re-triggers a fresh episode)", async () => {
		holdStore.setFleetPressureHold({
			setBy: "swap-sensor",
			watermark: "94.0%",
		});
		const sensors = makeSensors({ FLYWHEEL_MEM_PAGE_DEBOUNCE_SEC: "0" });
		reading = pressure(5, 1_000_000);
		await sensors.tick();
		expect(store.getFleetPressureHold()).toBeDefined();
		await sensors.tick(); // 2-tick confirm → fresh episode (N=0 → paged)
		expect(store.getFleetPressureHold()).toBeDefined();
		expect(alerts).toHaveLength(1); // re-armed, not lifted
	});

	it("restart with ONGOING swapout never lifts (second sample has delta > MIN)", async () => {
		holdStore.setFleetPressureHold({
			setBy: "swap-sensor",
			watermark: "94.0%",
		});
		const sensors = makeSensors();
		reading = pressure(45, 1_000_000);
		await sensors.tick();
		reading = pressure(45, 1_500_000);
		await sensors.tick();
		expect(store.getFleetPressureHold()).toBeDefined();
	});

	it("probe failure (null reading) never lifts a stranded hold", async () => {
		holdStore.setFleetPressureHold({
			setBy: "swap-sensor",
			watermark: "94.0%",
		});
		const sensors = makeSensors();
		reading = null;
		await sensors.tick();
		await sensors.tick();
		expect(store.getFleetPressureHold()).toBeDefined();
	});

	it("a MANUAL hold is never lifted by the restart-safety path", async () => {
		holdStore.setFleetPressureHold({ setBy: "annie-manual" });
		const sensors = makeSensors();
		reading = pressure(45, 100);
		await sensors.tick();
		await sensors.tick(); // proven healthy — still not ours to lift
		expect(store.getFleetPressureHold()?.set_by).toBe("annie-manual");
	});

	it("lastWatermark reports free% (rides server-loss notifications)", async () => {
		const sensors = makeSensors();
		expect(sensors.lastWatermark).toBeNull();
		reading = pressure(41.26, 100);
		await sensors.tick();
		expect(sensors.lastWatermark).toBe("41.3% free");
	});
});

describe("FleetSensors — infra bot (Task 2.5)", () => {
	let store: StateStore;
	let alerts: AlertPayload[];
	let resolved: string[];
	let probes: InfraBotProbe[];

	beforeEach(async () => {
		store = await RealStateStore.create(":memory:");
		alerts = [];
		resolved = [];
		probes = [];
	});

	function makeSensors(
		kick?: (label: string) => Promise<{ ok: boolean; error?: string }>,
	) {
		return new FleetSensors({
			store,
			alert: async (p): Promise<AlertResult> => {
				alerts.push(p);
				return { sent: true };
			},
			resolveTicket: async (ck) => {
				resolved.push(ck);
			},
			readPressure: async () => null,
			probeBots: async () => probes,
			kickstart: kick ?? (async () => ({ ok: true })),
			env: {} as NodeJS.ProcessEnv,
			now: () => 1_720_000_000_000,
			logger: () => {},
		});
	}

	it("dead bot fires ONCE (episode latch) with the explicit dead-side metadata", async () => {
		const sensors = makeSensors();
		probes = [
			{
				provider: "claude",
				alive: false,
				jobLabel: "com.flywheel.claw-infra",
				probeSource: "launchctl print",
			},
		];
		await sensors.tick();
		await sensors.tick(); // still dead — latched
		expect(alerts).toHaveLength(1);
		expect(alerts[0]!.eventType).toBe("infra_bot_down");
		expect(alerts[0]!.metadata?.infraBotDown).toMatchObject({
			provider: "claude",
			jobLabel: "com.flywheel.claw-infra",
		});
	});

	it("dead→alive edge clears the latch + quiet-resolves; a NEW death re-fires", async () => {
		const sensors = makeSensors();
		probes = [
			{
				provider: "codex",
				alive: false,
				jobLabel: "com.flywheel.codex-infra",
				probeSource: "launchctl print",
			},
		];
		await sensors.tick();
		probes = [{ ...probes[0]!, alive: true }];
		await sensors.tick();
		expect(resolved).toContain(
			fleetCorrelationKey("infra-bot:codex", "infra_bot_down"),
		);
		probes = [{ ...probes[0]!, alive: false }];
		await sensors.tick();
		expect(alerts).toHaveLength(2); // fresh episode
	});

	it("kickstart repair: attempted on success AND on failure (T2 gives the 2nd try — Codex R1 MED-2); blind → needs_human", async () => {
		const okSensors = makeSensors(async () => ({ ok: true }));
		const payload: AlertPayload = {
			leadId: "infra-bot:claude",
			projectName: "machine",
			eventId: "e",
			eventType: "infra_bot_down",
			title: "t",
			body: "b",
			severity: "severe",
			metadata: {
				infraBotDown: { provider: "claude", jobLabel: "com.x.y" },
			},
		};
		expect((await okSensors.infraBotKickstartRepair(payload)).outcome).toBe(
			"attempted",
		);
		// A FAILED restart is still an attempt — stays in the T2 loop so the
		// contract's "2 次失败 → @Annie" gets its second try on reconcile.
		const failSensors = makeSensors(async () => ({
			ok: false,
			error: "nope",
		}));
		const failed = await failSensors.infraBotKickstartRepair(payload);
		expect(failed.outcome).toBe("attempted");
		expect(failed.detail).toContain("失败");
		const blind = await okSensors.infraBotKickstartRepair({
			...payload,
			metadata: {},
		});
		expect(blind.outcome).toBe("needs_human"); // refuses to restart blind
	});

	it("restart safety: a still-dead bot with an ACTIVE durable ticket re-latches instead of re-alerting (Codex R2)", async () => {
		probes = [
			{
				provider: "claude",
				alive: false,
				jobLabel: "com.flywheel.claw-infra",
				probeSource: "launchctl print",
			},
		];
		const first = makeSensors();
		await first.tick();
		expect(alerts).toHaveLength(1);
		store.openAlertThread({
			correlationKey: "machine|infra-bot:claude|infra_bot_down|",
			eventId: alerts[0]!.eventId,
			threadId: "t-bot",
			channelId: "c",
			leadId: "infra-bot:claude",
			projectName: "machine",
			eventType: "infra_bot_down",
			ticketStatus: "REPAIRING",
		});
		const postRestart = makeSensors(); // fresh in-memory latch
		await postRestart.tick();
		expect(alerts).toHaveLength(1); // no duplicate episode
	});

	it("T2 retry payload without metadata falls back to the env jobLabel (Codex R2 MED-3)", async () => {
		const kicked: string[] = [];
		const sensors = new FleetSensors({
			store,
			alert: async () => ({ sent: true }),
			readPressure: async () => null,
			kickstart: async (label) => {
				kicked.push(label);
				return { ok: true };
			},
			env: {
				FLYWHEEL_CLAUDE_INFRA_BOT_JOB: "com.flywheel.claw-infra",
			} as unknown as NodeJS.ProcessEnv,
			now: () => 1_720_000_000_000,
			logger: () => {},
		});
		// The Hub's reconcile retry reconstructs a MINIMAL payload — no metadata.
		const result = await sensors.infraBotKickstartRepair({
			leadId: "infra-bot:claude",
			projectName: "machine",
			eventId: "e",
			eventType: "infra_bot_down",
			title: "t",
			body: "b",
			severity: "severe",
		});
		expect(result.outcome).toBe("attempted");
		expect(kicked).toEqual(["com.flywheel.claw-infra"]);
	});

	it("recoveryProbe: bot resolves by the latest probe verdict (per provider)", async () => {
		const sensors = makeSensors();
		probes = [
			{
				provider: "claude",
				alive: false,
				jobLabel: "j",
				probeSource: "launchctl print",
			},
		];
		await sensors.tick();
		const row = fleetRow({
			correlation_key: "machine|infra-bot:claude|infra_bot_down|",
			lead_id: "infra-bot:claude",
			event_type: "infra_bot_down",
		});
		expect(await sensors.recoveryProbe(row)).toBe(false);
		probes = [{ ...probes[0]!, alive: true }];
		await sensors.tick();
		expect(await sensors.recoveryProbe(row)).toBe(true);
	});
});

describe("FleetSensors — zombie scan (Task 2.6)", () => {
	let store: StateStore;
	let alerts: AlertPayload[];
	let findings: ZombieFinding[];
	let now: number;

	beforeEach(async () => {
		store = await RealStateStore.create(":memory:");
		alerts = [];
		findings = [];
		now = 1_720_000_000_000;
	});

	function makeSensors(env: Record<string, string> = {}) {
		return new FleetSensors({
			store,
			alert: async (p): Promise<AlertResult> => {
				alerts.push(p);
				return { sent: true };
			},
			readPressure: async () => null,
			scanZombies: async () => findings,
			env: env as unknown as NodeJS.ProcessEnv,
			now: () => now,
			logger: () => {},
		});
	}

	const zombie = (i: number): ZombieFinding => ({
		shape: "commdb_orphan",
		executionId: `z-${i}`,
		projectName: "flywheel",
		detail: "d",
	});

	it("below threshold (default 3) → no ticket; at threshold → (b)-type ticket with samples", async () => {
		const sensors = makeSensors();
		findings = [zombie(1), zombie(2)];
		await sensors.tick();
		expect(alerts).toHaveLength(0);
		findings = [zombie(1), zombie(2), zombie(3)];
		now += 16 * 60_000; // past the scan throttle
		await sensors.tick();
		expect(alerts).toHaveLength(1);
		expect(alerts[0]!.eventType).toBe("zombie_session_backlog");
		expect(alerts[0]!.body).toContain("z-1");
		expect(alerts[0]!.body).toContain("FLY-1066");
	});

	it("scan is throttled (~15 min): consecutive ticks do not rescan", async () => {
		const sensors = makeSensors();
		const scan = vi.fn(async () => [] as ZombieFinding[]);
		const throttled = new FleetSensors({
			store,
			alert: async () => ({ sent: true }),
			readPressure: async () => null,
			scanZombies: scan,
			env: {} as NodeJS.ProcessEnv,
			now: () => now,
			logger: () => {},
		});
		await throttled.tick();
		await throttled.tick();
		expect(scan).toHaveBeenCalledTimes(1);
		void sensors;
	});

	it("same batch with an ACTIVE ticket never re-emits; a changed set emits fresh (Codex R1 HIGH-5)", async () => {
		const sensors = makeSensors();
		findings = [zombie(1), zombie(2), zombie(3)];
		await sensors.tick();
		expect(alerts).toHaveLength(1);
		// Simulate the Hub opening the ticket row for the emitted alert.
		store.openAlertThread({
			correlationKey: "machine|zombie|zombie_session_backlog|",
			eventId: alerts[0]!.eventId,
			threadId: "t-z",
			channelId: "c",
			leadId: "zombie",
			projectName: "machine",
			eventType: "zombie_session_backlog",
			ticketStatus: "ESCALATED",
		});
		now += 16 * 60_000;
		await sensors.tick(); // same batch + active ticket → silent
		expect(alerts).toHaveLength(1);
		// Codex R2 (restart safety): the dedup rides the DURABLE ticket row —
		// a fresh post-restart sensor instance stays silent too.
		const postRestart = makeSensors();
		now += 16 * 60_000;
		await postRestart.tick();
		expect(alerts).toHaveLength(1);
		findings = [...findings, zombie(4)];
		now += 16 * 60_000;
		await sensors.tick(); // changed set → fresh event id
		expect(alerts).toHaveLength(2);
		expect(alerts[1]!.eventId).not.toBe(alerts[0]!.eventId);
	});

	it("same batch RE-EMITS with a fresh eventId once the ticket resolved (never claims-swallowed)", async () => {
		const sensors = makeSensors();
		findings = [zombie(1), zombie(2), zombie(3)];
		await sensors.tick();
		expect(alerts).toHaveLength(1);
		// No active ticket row (e.g. resolved/archived) → the same backlog must
		// re-alert, and with a DIFFERENT eventId (permanent claims dedup).
		now += 16 * 60_000;
		await sensors.tick();
		expect(alerts).toHaveLength(2);
		expect(alerts[1]!.eventId).not.toBe(alerts[0]!.eventId);
	});

	it("sample list truncates at 10 with the total", async () => {
		const sensors = makeSensors();
		findings = Array.from({ length: 12 }, (_, i) => zombie(i));
		await sensors.tick();
		expect(alerts[0]!.body).toContain("共 12 个");
		expect(alerts[0]!.body).not.toContain("z-11");
	});
});
