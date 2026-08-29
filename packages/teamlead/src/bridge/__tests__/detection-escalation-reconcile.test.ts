import { describe, expect, it } from "vitest";
import { StateStore } from "../../StateStore.js";
import {
	DEFAULT_DETECTION_FLEET_THRESHOLD,
	DEFAULT_DETECTION_LEAD_GRACE_MS,
	type ReconcileEscalationsDeps,
	reconcileDetectionEscalations,
	resolveRecoveredDetectionTargets,
	unifiedFlowOwnsTarget,
} from "../detection-escalation.js";

/**
 * FLY-1048 PR-C Task C3: the ~30min Lead-grace reconcile. LEAD_NOTIFIED rows
 * whose grace elapsed with no Lead ack get a founder page — ESCALATED is
 * stamped ONLY on a CONFIRMED posted page (Codex R1 #3 of the plan); fleet-
 * scale incidents (≥K same-kind episodes) route to the FLY-915 aggregate sink
 * instead of paging the founder (PRD §4.3 boundary).
 */

const GRACE = DEFAULT_DETECTION_LEAD_GRACE_MS; // 30min

async function seedNotified(
	store: StateStore,
	targetKey: string,
	opts: { kind?: string; notifiedAtMs?: number; fp?: string } = {},
): Promise<void> {
	const kind = opts.kind ?? "detection_stuck_confirmed";
	const fp = opts.fp ?? "fp:1";
	store.upsertDetectionEscalation({
		targetKey,
		kind,
		episodeFingerprint: fp,
		issueId: `issue-${targetKey}`,
		ownerLeadId: "flywheel-eng-lead",
		firstDetectedAtMs: 0,
	});
	store.markDetectionEscalationLeadNotified(
		targetKey,
		kind,
		fp,
		opts.notifiedAtMs ?? 1_000,
	);
}

function makeDeps(
	store: StateStore,
	overrides: Partial<ReconcileEscalationsDeps> = {},
): {
	deps: ReconcileEscalationsDeps;
	paged: string[];
	fleet: Array<{ kind: string; count: number }>;
} {
	const paged: string[] = [];
	const fleet: Array<{ kind: string; count: number }> = [];
	const deps: ReconcileEscalationsDeps = {
		store,
		pageFounder: async (row) => {
			paged.push(row.target_key);
			return true;
		},
		fleetSink: async (kind, rows) => {
			fleet.push({ kind, count: rows.length });
		},
		logger: () => {},
		now: () => 1_000 + GRACE + 1,
		...overrides,
	};
	return { deps, paged, fleet };
}

async function freshStore(): Promise<StateStore> {
	return StateStore.create(":memory:");
}

describe("reconcileDetectionEscalations (FLY-1048 C3)", () => {
	it("grace not yet elapsed → no page, row stays LEAD_NOTIFIED", async () => {
		const store = await freshStore();
		await seedNotified(store, "e1", { notifiedAtMs: 1_000 });
		const { deps, paged } = makeDeps(store, { now: () => 1_000 + GRACE - 1 });
		await reconcileDetectionEscalations(deps);
		expect(paged).toHaveLength(0);
		expect(
			store.getDetectionEscalation("e1", "detection_stuck_confirmed", "fp:1")
				?.status,
		).toBe("LEAD_NOTIFIED");
	});

	it("grace elapsed + CONFIRMED page → ESCALATED with founder_paged_at_ms", async () => {
		const store = await freshStore();
		await seedNotified(store, "e1");
		const { deps, paged } = makeDeps(store);
		await reconcileDetectionEscalations(deps);
		expect(paged).toEqual(["e1"]);
		const row = store.getDetectionEscalation(
			"e1",
			"detection_stuck_confirmed",
			"fp:1",
		)!;
		expect(row.status).toBe("ESCALATED");
		expect(row.founder_paged_at_ms).toBe(1_000 + GRACE + 1);
	});

	it("page NOT confirmed (posted=false) → row stays LEAD_NOTIFIED for the next reconcile (never a silent ESCALATED)", async () => {
		const store = await freshStore();
		await seedNotified(store, "e1");
		const { deps } = makeDeps(store, { pageFounder: async () => false });
		await reconcileDetectionEscalations(deps);
		expect(
			store.getDetectionEscalation("e1", "detection_stuck_confirmed", "fp:1")
				?.status,
		).toBe("LEAD_NOTIFIED");
	});

	it("pageFounder throwing is contained: row stays LEAD_NOTIFIED, other rows still process", async () => {
		const store = await freshStore();
		await seedNotified(store, "e-throws", { fp: "fp:t" });
		await seedNotified(store, "e-ok", { fp: "fp:ok" });
		const { deps, paged } = makeDeps(store, {
			pageFounder: async (row) => {
				if (row.target_key === "e-throws") throw new Error("discord down");
				paged.push(row.target_key);
				return true;
			},
		});
		await reconcileDetectionEscalations(deps);
		expect(paged).toEqual(["e-ok"]);
		expect(
			store.getDetectionEscalation(
				"e-throws",
				"detection_stuck_confirmed",
				"fp:t",
			)?.status,
		).toBe("LEAD_NOTIFIED");
	});

	it("ACKED rows never page the founder (Lead has it)", async () => {
		const store = await freshStore();
		await seedNotified(store, "e1");
		store.ackDetectionEscalation("e1", "detection_stuck_confirmed", "fp:1", {
			atMs: 2_000,
			disposition: "ack",
		});
		const { deps, paged } = makeDeps(store);
		await reconcileDetectionEscalations(deps);
		expect(paged).toHaveLength(0);
		expect(
			store.getDetectionEscalation("e1", "detection_stuck_confirmed", "fp:1")
				?.status,
		).toBe("ACKED");
	});

	it("fleet guard: ≥ threshold same-kind overdue episodes → ONE aggregate sink call, all ESCALATED, ZERO founder pages", async () => {
		const store = await freshStore();
		for (let i = 0; i < DEFAULT_DETECTION_FLEET_THRESHOLD; i++) {
			await seedNotified(store, `e${i}`, { fp: `fp:${i}` });
		}
		const { deps, paged, fleet } = makeDeps(store);
		await reconcileDetectionEscalations(deps);
		expect(paged).toHaveLength(0);
		expect(fleet).toEqual([
			{
				kind: "detection_stuck_confirmed",
				count: DEFAULT_DETECTION_FLEET_THRESHOLD,
			},
		]);
		for (let i = 0; i < DEFAULT_DETECTION_FLEET_THRESHOLD; i++) {
			expect(
				store.getDetectionEscalation(
					`e${i}`,
					"detection_stuck_confirmed",
					`fp:${i}`,
				)?.status,
			).toBe("ESCALATED");
		}
	});

	it("below the fleet threshold each overdue episode pages individually", async () => {
		const store = await freshStore();
		await seedNotified(store, "e1", { fp: "fp:1" });
		await seedNotified(store, "e2", { fp: "fp:2" });
		const { deps, paged, fleet } = makeDeps(store);
		await reconcileDetectionEscalations(deps);
		expect(paged.sort()).toEqual(["e1", "e2"]);
		expect(fleet).toHaveLength(0);
	});

	it("second reconcile after ESCALATED is a no-op (never re-pages)", async () => {
		const store = await freshStore();
		await seedNotified(store, "e1");
		const { deps, paged } = makeDeps(store);
		await reconcileDetectionEscalations(deps);
		await reconcileDetectionEscalations(deps);
		expect(paged).toEqual(["e1"]);
	});

	// ── C3-w: per-project grace override (PRD §4.3: global + per-project 可配) ──

	it("graceMsFor: a LONGER per-row grace keeps the row LEAD_NOTIFIED past the global grace", async () => {
		const store = await freshStore();
		await seedNotified(store, "e1", { notifiedAtMs: 1_000 });
		const { deps, paged } = makeDeps(store, {
			graceMsFor: () => GRACE * 2,
			now: () => 1_000 + GRACE + 1, // overdue globally, not per-project
		});
		await reconcileDetectionEscalations(deps);
		expect(paged).toHaveLength(0);
		expect(
			store.getDetectionEscalation("e1", "detection_stuck_confirmed", "fp:1")
				?.status,
		).toBe("LEAD_NOTIFIED");
	});

	it("graceMsFor: a SHORTER per-row grace escalates before the global grace", async () => {
		const store = await freshStore();
		await seedNotified(store, "e1", { notifiedAtMs: 1_000 });
		const { deps, paged } = makeDeps(store, {
			graceMsFor: () => 60_000, // 1min project override
			now: () => 1_000 + 60_000 + 1,
		});
		await reconcileDetectionEscalations(deps);
		expect(paged).toEqual(["e1"]);
	});

	it("graceMsFor returning undefined falls back to the global grace", async () => {
		const store = await freshStore();
		await seedNotified(store, "e1", { notifiedAtMs: 1_000 });
		const { deps, paged } = makeDeps(store, {
			graceMsFor: () => undefined,
			now: () => 1_000 + GRACE - 1,
		});
		await reconcileDetectionEscalations(deps);
		expect(paged).toHaveLength(0);
	});

	it("grace timing is anchored to the DURABLE lead_notified_at_ms — a restart cannot restart the clock", async () => {
		const { mkdtempSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "fly1048c3-"));
		const dbPath = join(dir, "teamlead.db");
		try {
			const s1 = await StateStore.create(dbPath);
			await seedNotified(s1, "e1", { notifiedAtMs: 1_000 });
			s1.close();
			// "Restart": fresh store instance over the same file.
			const s2 = await StateStore.create(dbPath);
			const { deps, paged } = makeDeps(s2);
			await reconcileDetectionEscalations(deps);
			expect(paged).toEqual(["e1"]);
			s2.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

/**
 * FLY-1048 C3-w: runner-side recovery auto-RESOLVE (plan C3: "runner 侧状态
 * 恢复(session 进展/terminal)→ 自动 RESOLVED"). The probe is injected — the
 * plugin decides what "terminal" and "activity" mean; this sweep only
 * consumes trusted state (D5: never probes tmux itself). An unobservable
 * target (lead-keyed / unknown session) is NEVER auto-resolved.
 */
describe("resolveRecoveredDetectionTargets (FLY-1048 C3-w)", () => {
	it("a terminal target has ALL its episodes resolved — ESCALATED included", async () => {
		const store = await freshStore();
		await seedNotified(store, "e1", { fp: "fp:a" });
		await seedNotified(store, "e1", {
			fp: "fp:b",
			kind: "delivery_unconsumed",
		});
		// One episode already ESCALATED (paged) — recovery must close it too.
		store.markDetectionEscalationEscalated(
			"e1",
			"detection_stuck_confirmed",
			"fp:a",
			5_000,
		);
		const n = resolveRecoveredDetectionTargets({
			store,
			probe: () => ({ terminal: true, lastActivityAtMs: null }),
			logger: () => {},
		});
		expect(n).toBe(2);
		expect(
			store.getDetectionEscalation("e1", "detection_stuck_confirmed", "fp:a")
				?.status,
		).toBe("RESOLVED");
		expect(
			store.getDetectionEscalation("e1", "delivery_unconsumed", "fp:b")?.status,
		).toBe("RESOLVED");
	});

	it("progress after detection (activity newer than EVERY first_detected) resolves the target", async () => {
		const store = await freshStore();
		store.upsertDetectionEscalation({
			targetKey: "e1",
			kind: "detection_stuck_confirmed",
			episodeFingerprint: "fp:1",
			firstDetectedAtMs: 10_000,
		});
		const n = resolveRecoveredDetectionTargets({
			store,
			probe: () => ({ terminal: false, lastActivityAtMs: 20_000 }),
			logger: () => {},
		});
		expect(n).toBe(1);
		expect(
			store.getDetectionEscalation("e1", "detection_stuck_confirmed", "fp:1")
				?.status,
		).toBe("RESOLVED");
	});

	it("activity OLDER than the newest detection does NOT resolve (the stall premise still holds)", async () => {
		const store = await freshStore();
		store.upsertDetectionEscalation({
			targetKey: "e1",
			kind: "detection_stuck_confirmed",
			episodeFingerprint: "fp:1",
			firstDetectedAtMs: 10_000,
		});
		const n = resolveRecoveredDetectionTargets({
			store,
			probe: () => ({ terminal: false, lastActivityAtMs: 9_999 }),
			logger: () => {},
		});
		expect(n).toBe(0);
		expect(
			store.getDetectionEscalation("e1", "detection_stuck_confirmed", "fp:1")
				?.status,
		).toBe("NEW");
	});

	it("an unobservable target (probe null — lead-keyed / unknown session) is never auto-resolved", async () => {
		const store = await freshStore();
		await seedNotified(store, "flywheel:some-lead", { fp: "fp:1" });
		const n = resolveRecoveredDetectionTargets({
			store,
			probe: () => null,
			logger: () => {},
		});
		expect(n).toBe(0);
		expect(
			store.getDetectionEscalation(
				"flywheel:some-lead",
				"detection_stuck_confirmed",
				"fp:1",
			)?.status,
		).toBe("LEAD_NOTIFIED");
	});

	it("a throwing probe is contained — other targets still sweep", async () => {
		const store = await freshStore();
		await seedNotified(store, "e-throws", { fp: "fp:t" });
		await seedNotified(store, "e-done", { fp: "fp:d" });
		const n = resolveRecoveredDetectionTargets({
			store,
			probe: (targetKey) => {
				if (targetKey === "e-throws") throw new Error("probe boom");
				return { terminal: true, lastActivityAtMs: null };
			},
			logger: () => {},
		});
		expect(n).toBe(1);
		expect(
			store.getDetectionEscalation(
				"e-done",
				"detection_stuck_confirmed",
				"fp:d",
			)?.status,
		).toBe("RESOLVED");
		expect(
			store.getDetectionEscalation(
				"e-throws",
				"detection_stuck_confirmed",
				"fp:t",
			)?.status,
		).toBe("LEAD_NOTIFIED");
	});
});

/**
 * FLY-1048 PR-C Task C5: CLEARING TTL rebound + ESCALATED never re-alerts.
 * A cleanup that never finished must not mute the target forever — past
 * FLYWHEEL_CLEARING_TTL_MS (default 2h) the row rebounds to NEW so it can
 * re-report. ESCALATED rows are terminal for alerting: the founder was paged
 * once and is NEVER paged again for that episode (FLY-970).
 */
describe("reconcile C5 — CLEARING TTL rebound + ESCALATED terminality (FLY-1048)", () => {
	const TTL = 7_200_000; // 2h default

	async function seedClearing(
		store: StateStore,
		clearingSinceMs: number,
	): Promise<void> {
		store.upsertDetectionEscalation({
			targetKey: "e1",
			kind: "detection_stuck_confirmed",
			episodeFingerprint: "fp:1",
			firstDetectedAtMs: 0,
		});
		store.markDetectionEscalationsClearingForTarget("e1", clearingSinceMs);
	}

	it("a CLEARING row past the TTL rebounds to NEW (and is not paged in the same pass)", async () => {
		const store = await freshStore();
		await seedClearing(store, 1_000);
		const { deps, paged, fleet } = makeDeps(store, {
			now: () => 1_000 + TTL + 1,
		});
		await reconcileDetectionEscalations(deps);
		const row = store.getDetectionEscalation(
			"e1",
			"detection_stuck_confirmed",
			"fp:1",
		)!;
		expect(row.status).toBe("NEW");
		expect(row.clearing_since_ms).toBeNull();
		expect(paged).toHaveLength(0);
		expect(fleet).toHaveLength(0);
	});

	it("a CLEARING row within the TTL stays CLEARING (mute holds)", async () => {
		const store = await freshStore();
		await seedClearing(store, 1_000);
		const { deps, paged } = makeDeps(store, { now: () => 1_000 + TTL - 1 });
		await reconcileDetectionEscalations(deps);
		expect(
			store.getDetectionEscalation("e1", "detection_stuck_confirmed", "fp:1")
				?.status,
		).toBe("CLEARING");
		expect(paged).toHaveLength(0);
	});

	it("clearingTtlMs is injectable (per-deploy knob)", async () => {
		const store = await freshStore();
		await seedClearing(store, 1_000);
		const { deps } = makeDeps(store, {
			clearingTtlMs: 60_000,
			now: () => 1_000 + 60_001,
		});
		await reconcileDetectionEscalations(deps);
		expect(
			store.getDetectionEscalation("e1", "detection_stuck_confirmed", "fp:1")
				?.status,
		).toBe("NEW");
	});

	it("ESCALATED rows NEVER re-alert — no page, no fleet, however overdue (FLY-970)", async () => {
		const store = await freshStore();
		await seedNotified(store, "e1");
		store.markDetectionEscalationEscalated(
			"e1",
			"detection_stuck_confirmed",
			"fp:1",
			2_000,
		);
		const { deps, paged, fleet } = makeDeps(store, {
			now: () => 2_000 + GRACE * 100,
		});
		await reconcileDetectionEscalations(deps);
		await reconcileDetectionEscalations(deps);
		expect(paged).toHaveLength(0);
		expect(fleet).toHaveLength(0);
		expect(
			store.getDetectionEscalation("e1", "detection_stuck_confirmed", "fp:1")
				?.status,
		).toBe("ESCALATED");
	});
});

/**
 * FLY-1048 PR-C C4a/C5 shared guard: the production impl the plugin wires
 * into the old detector's `unifiedOwnsEpisode` dep — true when the unified
 * flow owns an active episode for this (target, fingerprint) OR the target is
 * in the C5 cleanup mute (any CLEARING row).
 */
describe("unifiedFlowOwnsTarget (FLY-1048 C4a/C5 guard)", () => {
	it("true for an active episode of any kind with the same fingerprint", async () => {
		const store = await freshStore();
		await seedNotified(store, "e1", {
			fp: "fp:1",
			kind: "delivery_unconsumed",
		});
		expect(unifiedFlowOwnsTarget(store, "e1", "fp:1")).toBe(true);
		expect(unifiedFlowOwnsTarget(store, "e1", "fp:other")).toBe(false);
	});

	it("true while the target is CLEARING, whatever the fingerprint (C5 mute)", async () => {
		const store = await freshStore();
		await seedNotified(store, "e1", { fp: "fp:1" });
		store.markDetectionEscalationsClearingForTarget("e1", 10);
		expect(unifiedFlowOwnsTarget(store, "e1", "fp:anything")).toBe(true);
	});

	it("false when every row is RESOLVED", async () => {
		const store = await freshStore();
		await seedNotified(store, "e1", { fp: "fp:1" });
		store.resolveDetectionEscalationsForTarget("e1");
		expect(unifiedFlowOwnsTarget(store, "e1", "fp:1")).toBe(false);
	});
});

/**
 * FLY-1048 PR-C (C4 wiring hardening): PROGRESS evidence refutes "stuck" —
 * it does NOT refute an unanswered ask / unconsumed delivery / unreported
 * park (漏② typically happens on a runner that keeps working!). Progress may
 * only resolve the kinds the caller declares; a TERMINAL target still
 * resolves everything (the session is over — nothing left to answer).
 */
describe("resolveRecoveredDetectionTargets — kind-scoped progress resolution", () => {
	it("progress resolves declared kinds only; terminal resolves all", async () => {
		const store = await freshStore();
		await seedNotified(store, "e1", {
			fp: "fp:c",
			kind: "detection_stuck_confirmed",
		});
		await seedNotified(store, "e1", {
			fp: "gap:ask",
			kind: "lead_ask_unanswered",
		});

		resolveRecoveredDetectionTargets({
			store,
			probe: () => ({ terminal: false, lastActivityAtMs: 5_000 }),
			progressResolvableKinds: new Set(["detection_stuck_confirmed"]),
			logger: () => {},
		});
		expect(
			store.getDetectionEscalation("e1", "detection_stuck_confirmed", "fp:c")
				?.status,
		).toBe("RESOLVED");
		expect(
			store.getDetectionEscalation("e1", "lead_ask_unanswered", "gap:ask")
				?.status,
		).toBe("LEAD_NOTIFIED");

		// Terminal outranks the kind scope: everything closes.
		resolveRecoveredDetectionTargets({
			store,
			probe: () => ({ terminal: true, lastActivityAtMs: null }),
			progressResolvableKinds: new Set(["detection_stuck_confirmed"]),
			logger: () => {},
		});
		expect(
			store.getDetectionEscalation("e1", "lead_ask_unanswered", "gap:ask")
				?.status,
		).toBe("RESOLVED");
	});

	it("default (no kind scope) keeps the C3-w behavior: progress resolves everything", async () => {
		const store = await freshStore();
		await seedNotified(store, "e1", {
			fp: "gap:ask",
			kind: "lead_ask_unanswered",
		});
		resolveRecoveredDetectionTargets({
			store,
			probe: () => ({ terminal: false, lastActivityAtMs: 5_000 }),
			logger: () => {},
		});
		expect(
			store.getDetectionEscalation("e1", "lead_ask_unanswered", "gap:ask")
				?.status,
		).toBe("RESOLVED");
	});
});

/**
 * FLY-1048 Codex code R1 #4: the fleet decision must count DURABLE active
 * same-kind episodes, not just this tick's newly-overdue group — staggered
 * deadlines must aggregate instead of paging the founder K times.
 */
describe("reconcileDetectionEscalations — durable fleet counting (Codex R1 #4)", () => {
	it("3 already-ESCALATED + 1 newly-overdue same-kind → the 4th rides the fleet lane", async () => {
		const store = await freshStore();
		for (let i = 0; i < 3; i++) {
			await seedNotified(store, `e${i}`, { fp: `fp:${i}` });
			store.markDetectionEscalationEscalated(
				`e${i}`,
				"detection_stuck_confirmed",
				`fp:${i}`,
				900,
			);
		}
		await seedNotified(store, "e3", { fp: "fp:3" });

		const { deps, paged, fleet } = makeDeps(store, {
			fleetThreshold: 4,
			fleetWindowMs: 3_600_000,
		});
		await reconcileDetectionEscalations(deps);
		expect(paged).toHaveLength(0);
		// R2 #3: the aggregate carries the FULL active same-kind window set
		// (3 ESCALATED + 1 newly overdue), so the ticket's count and identity
		// describe the real incident.
		expect(fleet).toEqual([{ kind: "detection_stuck_confirmed", count: 4 }]);
		expect(
			store.getDetectionEscalation("e3", "detection_stuck_confirmed", "fp:3")
				?.status,
		).toBe("ESCALATED");
	});

	it("active count below the threshold → individual founder page (unchanged)", async () => {
		const store = await freshStore();
		await seedNotified(store, "e1", { fp: "fp:solo" });
		const { deps, paged, fleet } = makeDeps(store, { fleetThreshold: 4 });
		await reconcileDetectionEscalations(deps);
		expect(paged).toEqual(["e1"]);
		expect(fleet).toHaveLength(0);
	});
});

/**
 * Codex PR-C R3 finding 1 (HIGH): machine progress recovery must persist
 * `resolved_via = 'recovery'` — defaulting to 'lead' makes a later GENUINE
 * same-fingerprint recurrence unrevivable through the unified path, breaking
 * the ~30min guarantee.
 */
describe("progress resolution carries recovery provenance (Codex R3 #1)", () => {
	it("a progress-resolved episode has resolved_via='recovery' and revives on re-detection", async () => {
		const store = await freshStore();
		store.upsertDetectionEscalation({
			targetKey: "e1",
			kind: "detection_stuck_confirmed",
			episodeFingerprint: "fp:1",
			firstDetectedAtMs: 10_000,
		});
		resolveRecoveredDetectionTargets({
			store,
			probe: () => ({ terminal: false, lastActivityAtMs: 20_000 }),
			logger: () => {},
		});
		const row = store.getDetectionEscalation(
			"e1",
			"detection_stuck_confirmed",
			"fp:1",
		)!;
		expect(row.status).toBe("RESOLVED");
		expect(row.resolved_via).toBe("recovery");

		// The genuine recurrence (re-detection NEWER than the resolution) revives.
		const revived = store.upsertDetectionEscalation({
			targetKey: "e1",
			kind: "detection_stuck_confirmed",
			episodeFingerprint: "fp:1",
			firstDetectedAtMs: 30_000,
		});
		expect(revived.row.status).toBe("NEW");
	});
});
