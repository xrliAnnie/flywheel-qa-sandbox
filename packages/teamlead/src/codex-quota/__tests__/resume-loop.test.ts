import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import type { CodexAccountQuotaStore } from "../codex-account-quota-store.js";
import {
	CODEX_STANDBY_EVALUATION_INTERVAL_MS,
	createCodexQuotaResumeLoop,
} from "../resume-loop.js";

const stores: StateStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});
const ROOT = "root-canonical";
const ACCOUNT = "a".repeat(64);
const T0 = Date.parse("2026-09-25T12:00:00.000Z");

function raw(store: StateStore): Database.Database {
	return (store as unknown as { db: { raw: Database.Database } }).db.raw;
}

async function setup() {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	store.codexQuota.initializeRoot({
		rootKey: ROOT,
		accountKey: ACCOUNT,
		profile: "business",
		generation: 1,
	});
	return store;
}

function parkUnbound(store: StateStore, executionId: string) {
	const quota = store.codexQuota;
	quota.recordSignal({
		executionId,
		source: "runner_terminal",
		sourceEventId: `wall-${executionId}`,
		now: new Date(T0).toISOString(),
	});
	const seq = quota.signalSeqFor(
		"runner_terminal",
		executionId,
		`wall-${executionId}`,
	)!;
	raw(store)
		.prepare(
			"INSERT INTO codex_quota_standby(execution_id,run_id,node_id,attempt,entry_seq,trigger_signal_seq,source_event_id,state,entered_at,updated_at) VALUES(?,?,'implement',1,1,?,?,'standby',?,?)",
		)
		.run(
			executionId,
			`run-${executionId}`,
			seq,
			`wall-${executionId}`,
			new Date(T0).toISOString(),
			new Date(T0).toISOString(),
		);
}

function readings(
	requestSeq: number | undefined,
	observedAt = new Date(T0).toISOString(),
): CodexAccountQuotaStore {
	return {
		version: 1,
		generatedAt: observedAt,
		activeAccount: "business",
		accounts: [
			{
				name: "business",
				registeredProfile: "business",
				identityKey: ACCOUNT,
				observedAt,
				authHealth: "valid",
				note: null,
				planType: "plus",
				fiveH: { usedPercent: 5, windowMinutes: 300, resetAt: null },
				weekly: { usedPercent: 50, windowMinutes: 10080, resetAt: null },
				credits: {
					known: false,
					hasCredits: null,
					unlimited: null,
					balance: null,
				},
				resetCredits: {
					known: false,
					value: null,
					availableCount: null,
					credits: null,
				},
				unclassifiedWindows: 0,
				...(requestSeq === undefined ? {} : { requestSeq }),
			},
		],
	};
}

function loopFor(
	store: StateStore,
	overrides: Partial<Parameters<typeof createCodexQuotaResumeLoop>[0]> = {},
) {
	let clock = T0;
	const reconcile = vi.fn(async () => ({
		rootKey: ROOT,
		accountKey: ACCOUNT,
		profile: "business",
		generation: store.codexQuota.getRoot(ROOT)!.generation,
		authDigest: "d".repeat(64),
	}));
	const readiness = vi.fn(async () => ({ ready: true }));
	const refresh = vi.fn(async () => undefined);
	let current: CodexAccountQuotaStore | null = null;
	const resumer = { tick: vi.fn(async () => undefined) };
	const loop = createCodexQuotaResumeLoop({
		store,
		reconcileCanonical: reconcile,
		readiness,
		readReadings: () => current,
		requestReadingRefresh: refresh,
		resumer,
		now: () => clock,
		warn: () => undefined,
		...overrides,
	});
	return {
		loop,
		reconcile,
		readiness,
		refresh,
		resumer,
		setReadings: (value: CodexAccountQuotaStore | null) => {
			current = value;
		},
		advance: (ms: number) => {
			clock += ms;
		},
	};
}

describe("FLY-2900 C4 — resume loop", () => {
	it("stays cheap with nothing parked: no reconcile, readiness or refresh", async () => {
		const store = await setup();
		const t = loopFor(store);
		await t.loop.tick();
		expect(t.reconcile).not.toHaveBeenCalled();
		expect(t.readiness).not.toHaveBeenCalled();
		expect(t.refresh).not.toHaveBeenCalled();
		expect(t.resumer.tick).toHaveBeenCalledTimes(1);
		expect(t.loop.snapshot().parked).toBe(0);
	});

	it("turns a post-wall reading into a permit for an unbound wall", async () => {
		const store = await setup();
		parkUnbound(store, "exec-1");
		const t = loopFor(store);
		t.setReadings(readings(store.codexQuota.allocateCausalSeq()));
		await t.loop.tick();
		expect(store.codexQuota.eligiblePermitFor("exec-1")).toMatchObject({
			kind: "reading_confirmed",
		});
		expect(t.loop.snapshot()).toMatchObject({
			parked: 1,
			precondition: null,
			permit: "issued",
		});
		expect(t.resumer.tick).toHaveBeenCalledWith(
			expect.objectContaining({
				root: expect.objectContaining({ rootKey: ROOT }),
			}),
		);
	});

	it("asks for one on-demand reading per minute while evidence predates the wall", async () => {
		const store = await setup();
		const early = store.codexQuota.allocateCausalSeq();
		parkUnbound(store, "exec-1");
		const t = loopFor(store);
		t.setReadings(readings(early));
		await t.loop.tick();
		t.advance(CODEX_STANDBY_EVALUATION_INTERVAL_MS);
		await t.loop.tick();
		t.advance(CODEX_STANDBY_EVALUATION_INTERVAL_MS);
		await t.loop.tick();
		await Promise.resolve();
		expect(t.refresh).toHaveBeenCalledTimes(1);
		expect(t.loop.snapshot().permitReason).toBe("reading_predates_wall");
		t.advance(60_000);
		await t.loop.tick();
		await Promise.resolve();
		expect(t.refresh).toHaveBeenCalledTimes(2);
	});

	it("evaluates at most once per interval but runs the resumer every tick", async () => {
		const store = await setup();
		parkUnbound(store, "exec-1");
		const t = loopFor(store);
		await t.loop.tick();
		await t.loop.tick();
		expect(t.reconcile).toHaveBeenCalledTimes(1);
		expect(t.resumer.tick).toHaveBeenCalledTimes(2);
	});

	it("issues no permit and tells the Lead once when the credential chain is not ready", async () => {
		const store = await setup();
		parkUnbound(store, "exec-1");
		const t = loopFor(store, {
			readiness: async () => ({ ready: false, failureCode: "home_not_shared" }),
		});
		t.setReadings(readings(store.codexQuota.allocateCausalSeq()));
		await t.loop.tick();
		t.advance(CODEX_STANDBY_EVALUATION_INTERVAL_MS);
		await t.loop.tick();
		expect(store.codexQuota.eligiblePermitFor("exec-1")).toBeUndefined();
		expect(t.loop.snapshot().precondition).toBe("readiness:home_not_shared");
		expect(
			store.codexQuota
				.listOutbox()
				.filter((row) =>
					String(row.event_id).startsWith("codex-standby-permit:"),
				),
		).toHaveLength(1);
		expect(t.resumer.tick).toHaveBeenLastCalledWith(
			expect.objectContaining({ root: null }),
		);
	});

	it("finalizes trigger-released carriers on every tick", async () => {
		const store = await setup();
		parkUnbound(store, "exec-1");
		raw(store)
			.prepare(
				"UPDATE codex_quota_standby SET state='released',release_reason='run_terminated' WHERE execution_id='exec-1'",
			)
			.run();
		const t = loopFor(store);
		await t.loop.tick();
		expect(
			store.codexQuota.listResumeAudit("exec-1").map((row) => row.action),
		).toEqual(["released"]);
	});
});
