import type Database from "better-sqlite3";
import { expect, it } from "vitest";
import { StateStore } from "../../StateStore.js";

const now = Date.parse("2026-09-15T15:00:00.000Z");
const sha = "a".repeat(40);
const input = {
	projectId: "flywheel",
	slotDate: "2026-09-15",
	releaseId: "release-1",
	activationEpoch: 1,
	policyRevision: "c".repeat(64),
	betaVersion: "1.2.3-beta.1",
	now,
	manifest: {
		versions: {
			"1.2.3-beta.1": {
				channel: "beta",
				status: "active",
				sourceCommit: sha,
				sha256: "b".repeat(64),
			},
		},
	},
};
function verdict(db: Database.Database, patch: Record<string, unknown> = {}) {
	// The persisted B3 producer shape, including the independently stored deployed SHA.
	const record = {
		id: "rr-1",
		source: sha,
		base: "1.2.3",
		deployed: sha,
		state: "green",
		at: new Date(now).toISOString(),
		...patch,
	};
	db.prepare(
		`INSERT INTO release_readiness_verdicts (verdict_id,subject_commit,base_version,local_deployed_sha,state,reasons_json,evidence_json,policy_json,evaluated_at) VALUES (@id,@source,@base,@deployed,@state,'[]','{}','{}',@at)`,
	).run(record);
	return record.id as string;
}
async function setup() {
	const state = await StateStore.create(":memory:");
	const db = (state as unknown as { db: { raw: Database.Database } }).db.raw;
	const cycle = state.customerReleases.reserve(input);
	return { state, db, cycle, store: state.customerReleases };
}

it("T03 fresh persisted green produces exactly one durable prepare intent", async () => {
	const { state, db, cycle, store } = await setup();
	try {
		let calls = 0;
		expect(
			store.beginPreparation(cycle.cycleId, 0, now, () => {
				calls++;
				return verdict(db);
			}),
		).toBe(true);
		expect(store.get(cycle.cycleId)).toMatchObject({
			state: "preparing",
			revision: 1,
			latestVerdictId: "rr-1",
		});
		expect(store.events(cycle.cycleId).map((e) => e.kind)).toEqual([
			"cycle_reserved",
			"prepare_requested",
		]);
		expect(
			store.beginPreparation(cycle.cycleId, 0, now, () => {
				calls++;
				return "rr-1";
			}),
		).toBe(false);
		expect(calls).toBe(1);
	} finally {
		state.close();
	}
});

it.each([
	{ state: "hold" },
	{ state: "unknown" },
	{ source: "d".repeat(40) },
	{ base: "9.9.9" },
	{ deployed: null },
	{ at: "invalid" },
	{ at: new Date(now - 30_001).toISOString() },
	{ at: new Date(now + 1).toISOString() },
])("T02 fails closed on an unusable persisted verdict %j", async (patch) => {
	const { state, db, cycle, store } = await setup();
	try {
		expect(
			store.beginPreparation(cycle.cycleId, 0, now, () => verdict(db, patch)),
		).toBe(false);
		expect(store.get(cycle.cycleId)).toMatchObject({
			state: "cancelled",
			invalidatedEventSeq: expect.any(Number),
		});
		expect(
			store.events(cycle.cycleId).some((e) => e.kind === "prepare_requested"),
		).toBe(false);
		expect(
			store.beginPreparation(cycle.cycleId, 1, now, () =>
				verdict(db, { id: "recovered" }),
			),
		).toBe(false);
	} finally {
		state.close();
	}
});

it("T02 rejects missing, older and failed evaluations without retaining a prepare intent", async () => {
	for (const mode of ["missing", "older", "failed"] as const) {
		const { state, db, cycle, store } = await setup();
		try {
			const evaluate = () => {
				if (mode === "failed")
					throw new Error("private path must not be logged");
				if (mode === "missing") return "missing";
				verdict(db);
				verdict(db, { id: "rr-2", state: "unknown" });
				return "rr-1";
			};
			expect(store.beginPreparation(cycle.cycleId, 0, now, evaluate)).toBe(
				false,
			);
			expect(store.get(cycle.cycleId)?.state).toBe("cancelled");
			expect(JSON.stringify(store.events(cycle.cycleId))).not.toContain(
				"private path",
			);
		} finally {
			state.close();
		}
	}
});

it("T03 audit failure rolls back preparation and the freshly appended B3 verdict", async () => {
	const { state, db, cycle, store } = await setup();
	try {
		db.exec(
			"CREATE TRIGGER fail_prepare BEFORE INSERT ON customer_release_events WHEN NEW.kind='prepare_requested' BEGIN SELECT RAISE(ABORT, 'injected prepare failure'); END",
		);
		expect(() =>
			store.beginPreparation(cycle.cycleId, 0, now, () => verdict(db)),
		).toThrow("injected prepare failure");
		expect(store.get(cycle.cycleId)?.state).toBe("evaluating");
		expect(
			db.prepare("SELECT count(*) AS n FROM release_readiness_verdicts").get(),
		).toEqual({ n: 0 });
	} finally {
		state.close();
	}
});

it("a negative source event received during evaluation remains cancelled even if evaluation returns green", async () => {
	const { state, db, cycle, store } = await setup();
	try {
		expect(
			store.beginPreparation(cycle.cycleId, 0, now, () => {
				store.cancel(cycle.cycleId, 0, "source_unknown", now);
				return verdict(db);
			}),
		).toBe(false);
		expect(store.get(cycle.cycleId)).toMatchObject({
			state: "cancelled",
			cancelReason: "source_unknown",
		});
		expect(
			store
				.events(cycle.cycleId)
				.some((event) => event.kind === "prepare_requested"),
		).toBe(false);
	} finally {
		state.close();
	}
});
