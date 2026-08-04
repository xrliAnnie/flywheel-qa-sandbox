import { describe, expect, it } from "vitest";
import { StateStore } from "../../StateStore.js";
import {
	DEFAULT_DETECTION_FLEET_THRESHOLD,
	DEFAULT_DETECTION_LEAD_GRACE_MS,
	type ReconcileEscalationsDeps,
	reboundExpiredDetectionClearings,
	reconcileDetectionEscalations,
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
	it("pages only the exact requested kind cohort", async () => {
		const store = await freshStore();
		await seedNotified(store, "legacy", {
			kind: "delivery_unconsumed",
			fp: "fp:legacy",
		});
		await seedNotified(store, "receipt", {
			kind: "receipt_unprocessed:runner_question",
			fp: "fp:receipt",
		});
		const { deps, paged } = makeDeps(store, {
			kindFilter: {
				includeKinds: ["receipt_unprocessed:runner_question"],
			},
			maintainClearing: false,
		});

		await reconcileDetectionEscalations(deps);
		expect(paged).toEqual(["receipt"]);
		expect(
			store.getDetectionEscalation("legacy", "delivery_unconsumed", "fp:legacy")
				?.status,
		).toBe("LEAD_NOTIFIED");
	});

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

	it("park policy can suppress founder paging or bypass fleet aggregation", async () => {
		const store = await freshStore();
		for (let i = 0; i < 4; i++) {
			await seedNotified(store, `park-${i}`, {
				kind: "park:blocked",
				fp: `fp:${i}`,
			});
		}
		await seedNotified(store, "qa-lead-only", {
			kind: "park:qa_hold_orphaned",
			fp: "fp:qa",
		});
		const { deps, paged, fleet } = makeDeps(store, {
			pagePolicy: (row) =>
				row.kind === "park:qa_hold_orphaned" ? "lead_only" : "page_no_fleet",
		});

		await reconcileDetectionEscalations(deps);
		expect(paged.sort()).toEqual(["park-0", "park-1", "park-2", "park-3"]);
		expect(fleet).toEqual([]);
		expect(
			store.getDetectionEscalation(
				"qa-lead-only",
				"park:qa_hold_orphaned",
				"fp:qa",
			)?.status,
		).toBe("LEAD_NOTIFIED");
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

	it("the shared maintenance pass rebounds all cohorts without paging either", async () => {
		const store = await freshStore();
		await seedClearing(store, 1_000);
		store.upsertDetectionEscalation({
			targetKey: "receipt",
			kind: "wake_failed",
			episodeFingerprint: "fp:wake",
			firstDetectedAtMs: 0,
		});
		store.markDetectionEscalationClearing(
			"receipt",
			"wake_failed",
			"fp:wake",
			1_000,
		);

		expect(
			reboundExpiredDetectionClearings({
				store,
				nowMs: 1_000 + TTL + 1,
				clearingTtlMs: TTL,
				logger: () => {},
			}),
		).toBe(2);
		expect(
			store.getDetectionEscalation("e1", "detection_stuck_confirmed", "fp:1")
				?.status,
		).toBe("NEW");
		expect(
			store.getDetectionEscalation("receipt", "wake_failed", "fp:wake")?.status,
		).toBe("NEW");
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
