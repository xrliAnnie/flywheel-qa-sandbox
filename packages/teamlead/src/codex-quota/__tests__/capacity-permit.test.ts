import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { CodexReadingEvidence } from "../../bridge/codex-quota-store.js";
import { StateStore } from "../../StateStore.js";

const stores: StateStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});

const NOW = Date.parse("2026-09-25T12:00:00.000Z");
const ROOT = "root-canonical";
const ACCOUNT = "a".repeat(64);
const OTHER = "b".repeat(64);

function raw(store: StateStore): Database.Database {
	return (store as unknown as { db: { raw: Database.Database } }).db.raw;
}

async function setup(options: { generation?: number } = {}) {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	store.codexQuota.initializeRoot({
		rootKey: ROOT,
		accountKey: ACCOUNT,
		profile: "business",
		generation: options.generation ?? 4,
	});
	return store;
}

/** Record a wall (bound to the current generation when bindingId is given) and park it. */
function park(
	store: StateStore,
	executionId: string,
	options: { bound?: boolean; generation?: number; parkRow?: boolean } = {},
) {
	const quota = store.codexQuota;
	const generation = options.generation ?? quota.getRoot(ROOT)!.generation;
	let bindingId: string | undefined;
	if (options.bound !== false) {
		bindingId = `bind-${executionId}-${generation}`;
		quota.registerBinding({
			bindingId,
			executionId,
			runId: `run-${executionId}`,
			purpose: "runner",
			accountKey: ACCOUNT,
			profile: "business",
			generation,
			credentialRootKey: ROOT,
		});
	}
	const sourceEventId = `wall-${executionId}-${quota.allocateCausalSeq()}`;
	quota.recordSignal({
		executionId,
		...(bindingId ? { bindingId } : {}),
		source: "runner_terminal",
		sourceEventId,
		now: new Date(NOW).toISOString(),
	});
	const seq = quota.signalSeqFor(
		"runner_terminal",
		executionId,
		sourceEventId,
	)!;
	if (options.parkRow === false) return seq;
	raw(store)
		.prepare(
			"INSERT INTO codex_quota_standby(execution_id,run_id,node_id,attempt,entry_seq,trigger_signal_seq,source_event_id,root_key,generation,binding_id,state,entered_at,updated_at) VALUES(?,?,?,1,1,?,?,?,?,?,'standby',?,?) ON CONFLICT(execution_id) DO UPDATE SET trigger_signal_seq=excluded.trigger_signal_seq",
		)
		.run(
			executionId,
			`run-${executionId}`,
			"implement",
			seq,
			sourceEventId,
			bindingId ? ROOT : null,
			bindingId ? generation : null,
			bindingId ?? null,
			new Date(NOW).toISOString(),
			new Date(NOW).toISOString(),
		);
	return seq;
}

function reading(
	store: StateStore,
	overrides: Partial<CodexReadingEvidence> = {},
): CodexReadingEvidence {
	return {
		name: "business",
		identityKey: ACCOUNT,
		observedAt: new Date(NOW - 60_000).toISOString(),
		fiveH: { usedPercent: 10, resetAt: "2026-09-25T15:00:00.000Z" },
		weekly: { usedPercent: 40, resetAt: "2026-09-28T00:00:00.000Z" },
		requestSeq: store.codexQuota.allocateCausalSeq(),
		...overrides,
	};
}

function issue(
	store: StateStore,
	evidence: CodexReadingEvidence | undefined,
	activeAccount: string | null = "business",
) {
	const root = store.codexQuota.getRoot(ROOT)!;
	return store.codexQuota.issueReadingConfirmedPermit({
		rootKey: ROOT,
		expectedGeneration: root.generation,
		authDigest: "c".repeat(64),
		reading: evidence,
		activeAccount,
		nowMs: NOW,
	});
}

describe("FLY-2900 C4 — reading-confirmed capacity permits", () => {
	it("issues a permit and opens a same-account generation when this generation walled", async () => {
		const store = await setup();
		const seq = park(store, "exec-1");
		const result = issue(store, reading(store));
		expect(result).toMatchObject({ outcome: "issued" });
		const root = store.codexQuota.getRoot(ROOT)!;
		expect(root).toMatchObject({ accountKey: ACCOUNT, generation: 5 });
		expect(
			raw(store)
				.prepare(
					"SELECT account_key,profile,reason FROM codex_quota_external_generation WHERE root_key=? AND generation=5",
				)
				.get(ROOT),
		).toEqual({
			account_key: ACCOUNT,
			profile: "business",
			reason: "reading_confirmed",
		});
		const permit = store.codexQuota.eligiblePermitFor("exec-1");
		expect(permit).toMatchObject({
			kind: "reading_confirmed",
			root_key: ROOT,
			generation: 5,
		});
		expect(permit!.covers_signal_seq).toBeGreaterThanOrEqual(seq);
		// Replaying the same evidence neither bumps again nor issues a second permit.
		expect(issue(store, reading(store))).toMatchObject({ outcome: "exists" });
		expect(store.codexQuota.getRoot(ROOT)!.generation).toBe(5);
		expect(
			raw(store)
				.prepare("SELECT COUNT(*) AS n FROM codex_quota_capacity_permit")
				.get(),
		).toEqual({ n: 1 });
	});

	it("opens a fresh generation without claiming the old incident recovered", async () => {
		const store = await setup();
		park(store, "exec-1");
		expect(store.codexQuota.isPaused(ROOT)).toBe(true);
		issue(store, reading(store));
		expect(store.codexQuota.getIncident(`codex:${ROOT}:4`)).toMatchObject({
			state: "prepared",
		});
		expect(store.codexQuota.isPaused(ROOT)).toBe(false);
	});

	it("does not bump for an unbound wall or settle identity-uncertain incidents without output", async () => {
		const store = await setup();
		park(store, "exec-unbound", { bound: false });
		raw(store)
			.prepare(
				"INSERT INTO codex_quota_incident(incident_id,root_key,generation,state,first_seen_at,failure_code) VALUES('codex:root-canonical:3',?,3,'identity_uncertain','t','canonical_identity_changed')",
			)
			.run(ROOT);
		expect(issue(store, reading(store))).toMatchObject({ outcome: "issued" });
		expect(store.codexQuota.getRoot(ROOT)!.generation).toBe(4);
		expect(store.codexQuota.getIncident(`codex:${ROOT}:3`)).toMatchObject({
			state: "identity_uncertain",
			failure_code: "canonical_identity_changed",
		});
		expect(store.codexQuota.eligiblePermitFor("exec-unbound")).toMatchObject({
			generation: 4,
		});
	});

	const refusals: [
		string,
		(store: StateStore) => CodexReadingEvidence | undefined,
		string,
		string | null,
	][] = [
		["no reading exists", () => undefined, "reading_missing", null],
		[
			"the reading is stale",
			(store) =>
				reading(store, {
					observedAt: new Date(NOW - 5 * 60_000 - 1).toISOString(),
				}),
			"reading_stale",
			null,
		],
		[
			"the reading belongs to another login",
			(store) => reading(store, { identityKey: OTHER }),
			"reading_identity_mismatch",
			null,
		],
		[
			"another account is active",
			(store) => reading(store),
			"reading_not_active",
			"school",
		],
		[
			"a window is unknown",
			(store) => reading(store, { fiveH: null }),
			"reading_window_unknown",
			null,
		],
		[
			"a window is exhausted",
			(store) =>
				reading(store, {
					weekly: { usedPercent: 100, resetAt: "2026-09-28T00:00:00.000Z" },
				}),
			"reading_exhausted",
			null,
		],
		[
			"the reading carries no request sequence",
			(store) => {
				const evidence = reading(store);
				delete evidence.requestSeq;
				return evidence;
			},
			"reading_unsequenced",
			null,
		],
	];
	for (const [name, evidence, reason, active] of refusals) {
		it(`refuses when ${name}`, async () => {
			const store = await setup();
			park(store, "exec-1");
			const result = issue(store, evidence(store), active ?? "business");
			expect(result).toMatchObject({ outcome: "refused", reason });
			expect(store.codexQuota.getRoot(ROOT)!.generation).toBe(4);
			expect(store.codexQuota.eligiblePermitFor("exec-1")).toBeUndefined();
		});
	}

	it("refuses a reading requested before the wall", async () => {
		const store = await setup();
		const early = reading(store);
		park(store, "exec-1");
		expect(issue(store, early)).toMatchObject({
			outcome: "refused",
			reason: "reading_predates_wall",
			needsRefresh: true,
		});
	});

	for (const bound of [true, false]) {
		it(`refuses when a ${bound ? "bound" : "unbound"} wall lands between the request and the evaluation`, async () => {
			const store = await setup();
			park(store, "exec-1");
			const requested = reading(store);
			// A wall that does not park (e.g. another runner on the old path).
			park(store, "exec-2", { bound, parkRow: false });
			expect(issue(store, requested)).toMatchObject({
				outcome: "refused",
				reason: "reading_superseded",
				needsRefresh: true,
			});
			expect(store.codexQuota.getRoot(ROOT)!.generation).toBe(4);
			// A fresher reading requested after the second wall is accepted.
			expect(issue(store, reading(store))).toMatchObject({
				outcome: "issued",
			});
		});
	}

	it("voids a permit when the resumed account walls again and issues a new one on newer evidence", async () => {
		const store = await setup();
		park(store, "exec-1");
		issue(store, reading(store));
		const first = store.codexQuota.eligiblePermitFor("exec-1")!;
		// The resumed body walls again on the new generation.
		park(store, "exec-1", { generation: 5 });
		expect(store.codexQuota.eligiblePermitFor("exec-1")).toBeUndefined();
		expect(issue(store, reading(store))).toMatchObject({ outcome: "issued" });
		const second = store.codexQuota.eligiblePermitFor("exec-1")!;
		expect(second.permit_id).not.toBe(first.permit_id);
		expect(second.generation).toBe(6);
	});

	it("ignores a late wall from an older generation", async () => {
		const store = await setup();
		park(store, "exec-1");
		issue(store, reading(store));
		expect(store.codexQuota.getRoot(ROOT)!.generation).toBe(5);
		// A late signal attributed to generation 4 must not void the generation-5 permit.
		const quota = store.codexQuota;
		quota.registerBinding({
			bindingId: "bind-late",
			executionId: "exec-late",
			runId: "run-late",
			purpose: "runner",
			accountKey: ACCOUNT,
			profile: "business",
			generation: 4,
			credentialRootKey: ROOT,
		});
		quota.recordSignal({
			executionId: "exec-late",
			bindingId: "bind-late",
			source: "runner_terminal",
			sourceEventId: "late",
			now: new Date(NOW).toISOString(),
		});
		expect(store.codexQuota.eligiblePermitFor("exec-1")).toBeDefined();
	});

	it("needs no permit when nothing is parked", async () => {
		const store = await setup();
		expect(issue(store, reading(store))).toMatchObject({
			outcome: "not_needed",
		});
		expect(store.codexQuota.getRoot(ROOT)!.generation).toBe(4);
	});
});

describe("FLY-2900 C4 — switch-committed capacity permits", () => {
	it("writes a permit in the committing transaction that covers every earlier wall", async () => {
		const store = await setup({ generation: 1 });
		const seq = park(store, "exec-1");
		const quota = store.codexQuota;
		quota.recordInstalling({
			incidentId: `codex:${ROOT}:1`,
			profile: "school",
			accountKey: OTHER,
			priorAuthDigest: "p".repeat(64),
			installedAuthDigest: "i".repeat(64),
			recoveryMaterialPath: "/tmp/recovery",
		});
		quota.commitGeneration({
			incidentId: `codex:${ROOT}:1`,
			expectedGeneration: 1,
			accountKey: OTHER,
			profile: "school",
			authDigest: "i".repeat(64),
			probeResult: "ok",
		});
		const permit = quota.eligiblePermitFor("exec-1");
		expect(permit).toMatchObject({
			kind: "switch_committed",
			generation: 2,
			account_key: OTHER,
			profile: "school",
		});
		expect(permit!.covers_signal_seq).toBeGreaterThanOrEqual(seq);
	});
});

describe("FLY-2900 C7 — which FLY-2465 targets the standby carrier owns", () => {
	it("owns the entry's walls and releases ownership for a later wall it never parked", async () => {
		const store = await setup({ generation: 1 });
		park(store, "exec-1");
		const incident = `codex:${ROOT}:1`;
		expect(store.codexQuota.standbyTargetDisposition(incident, "exec-1")).toBe(
			"carrier",
		);
		raw(store)
			.prepare(
				"UPDATE codex_quota_standby SET state='closed' WHERE execution_id='exec-1'",
			)
			.run();
		expect(store.codexQuota.standbyTargetDisposition(incident, "exec-1")).toBe(
			"recovered",
		);
		raw(store)
			.prepare(
				"UPDATE codex_quota_standby SET fallback_execution_id='new' WHERE execution_id='exec-1'",
			)
			.run();
		expect(store.codexQuota.standbyTargetDisposition(incident, "exec-1")).toBe(
			"abandoned",
		);
		// A later wall of the same execution the carrier never covered.
		park(store, "exec-1", { parkRow: false });
		expect(
			store.codexQuota.standbyTargetDisposition(incident, "exec-1"),
		).toBeNull();
	});
});
