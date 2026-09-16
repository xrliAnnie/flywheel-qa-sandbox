import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { TEAMLEAD_TABLE_CLASSIFICATION } from "../../../../../scripts/lib/fly-2006-retention-registry.mjs";
import { StateStore } from "../../StateStore.js";
import { CustomerReleaseStore } from "../customer-release/store.js";

const resources: (() => void)[] = [];
afterEach(() => {
	for (const close of resources.splice(0).reverse()) close();
});
function open(path = ":memory:") {
	const db = new Database(path);
	resources.push(() => db.close());
	const store = new CustomerReleaseStore(db);
	store.migrate();
	return { db, store };
}
const manifest = {
	versions: {
		"1.2.3-beta.1": {
			channel: "beta",
			status: "active",
			sourceCommit: "a".repeat(40),
			sha256: "b".repeat(64),
		},
	},
};
const reservation = {
	projectId: "flywheel",
	slotDate: "2026-09-15",
	releaseId: "release-1",
	activationEpoch: 1,
	policyRevision: "c".repeat(64),
	betaVersion: "1.2.3-beta.1",
	manifest,
	now: 1_789_488_000_000,
};

it("StateStore owns the release ledger and protects it from generic retention", async () => {
	const state = await StateStore.create(":memory:");
	try {
		expect(state.customerReleases).toBeInstanceOf(CustomerReleaseStore);
		const reserved = state.customerReleases.reserve(reservation);
		expect(state.customerReleases.get(reserved.cycleId)).toEqual(reserved);
		for (const table of [
			"customer_release_cycles",
			"customer_release_events",
			"customer_release_manual_requests",
			"customer_release_notices",
			"customer_release_actions",
			"customer_release_attempt_results",
			"customer_release_decisions",
		]) {
			expect(TEAMLEAD_TABLE_CLASSIFICATION.protectedAuthority).toContain(table);
		}
	} finally {
		state.close();
	}
});

it("T01 freezes the candidate once and deduplicates revision/weekday changes within the week", () => {
	const { store } = open();
	const first = store.reserve(reservation);
	expect(first).toMatchObject({
		state: "evaluating",
		revision: 0,
		weekStart: "2026-09-14",
		frozenBeta: { sourceCommit: "a".repeat(40) },
	});
	const replay = store.reserve({
		...reservation,
		slotDate: "2026-09-18",
		releaseId: "release-2",
		activationEpoch: 2,
		policyRevision: "d".repeat(64),
		manifest: {
			versions: {
				"1.2.3-beta.1": {
					...manifest.versions["1.2.3-beta.1"],
					sourceCommit: "e".repeat(40),
				},
			},
		},
	});
	expect(replay).toEqual(first);
	expect(store.events(first.cycleId)).toHaveLength(1);
	expect(
		store.reserve({
			...reservation,
			slotDate: "2026-09-22",
			releaseId: "release-3",
		}).cycleId,
	).not.toBe(first.cycleId);
});

it("T01 persists across independent connections and reopening without replacing the frozen tuple", () => {
	const root = mkdtempSync(join(tmpdir(), "customer-release-store-"));
	resources.push(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "state.db");
	const first = open(path);
	const second = open(path);
	const reserved = first.store.reserve(reservation);
	expect(
		second.store.reserve({ ...reservation, releaseId: "release-2" }),
	).toEqual(reserved);
	expect(open(path).store.get(reserved.cycleId)).toEqual(reserved);
});

it("rolls back cycle insertion if its audit event cannot commit", () => {
	const { db, store } = open();
	db.exec(
		"CREATE TRIGGER fail_release_event BEFORE INSERT ON customer_release_events BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END",
	);
	expect(() => store.reserve(reservation)).toThrow("injected audit failure");
	expect(
		db.prepare("SELECT count(*) AS n FROM customer_release_cycles").get(),
	).toEqual({ n: 0 });
	db.exec("DROP TRIGGER fail_release_event");
	expect(store.reserve(reservation).state).toBe("evaluating");
});

it("migrates twice without altering historical tables or reserved cycles", () => {
	const { db, store } = open();
	db.exec(
		"CREATE TABLE historical_approval (id TEXT PRIMARY KEY, approved INTEGER); INSERT INTO historical_approval VALUES ('existing', 1)",
	);
	const first = store.reserve(reservation);
	store.migrate();
	store.migrate();
	expect(store.get(first.cycleId)).toEqual(first);
	expect(db.prepare("SELECT * FROM historical_approval").all()).toEqual([
		{ id: "existing", approved: 1 },
	]);
});

it("rejects invalid date, identity and candidate before any mutation", () => {
	const { db, store } = open();
	for (const patch of [
		{ slotDate: "2026-02-30" },
		{ slotDate: "2026-9-15" },
		{ projectId: "" },
		{ activationEpoch: -1 },
		{ activationEpoch: 1.5 },
		{ policyRevision: "secret" },
		{ releaseId: "../secret" },
		{ now: NaN },
		{ manifest: {} },
		{ betaVersion: "1.2.3" },
		{
			manifest: {
				versions: {
					"1.2.3-beta.1": {
						...manifest.versions["1.2.3-beta.1"],
						status: "withdrawn",
					},
				},
			},
		},
	])
		expect(() => store.reserve({ ...reservation, ...patch })).toThrow();
	expect(
		db.prepare("SELECT count(*) AS n FROM customer_release_cycles").get(),
	).toEqual({ n: 0 });
});

it("T02/T09 cancellation is durable, revision guarded, idempotent and never reopens the week", () => {
	const { store } = open();
	const first = store.reserve(reservation);
	expect(store.cancel(first.cycleId, 99, "unknown", reservation.now + 1)).toBe(
		false,
	);
	expect(store.cancel(first.cycleId, 0, "unknown", reservation.now + 1)).toBe(
		true,
	);
	expect(store.get(first.cycleId)).toMatchObject({
		state: "cancelled",
		cancelReason: "unknown",
		revision: 1,
		invalidatedEventSeq: expect.any(Number),
	});
	expect(store.cancel(first.cycleId, 0, "unknown", reservation.now + 1)).toBe(
		false,
	);
	expect(store.reserve({ ...reservation, slotDate: "2026-09-16" }).state).toBe(
		"cancelled",
	);
	expect(store.events(first.cycleId).map((event) => event.kind)).toEqual([
		"cycle_reserved",
		"cycle_cancelled",
	]);
});

it("rolls back cancellation together with its event and rejects rewriting frozen identity", () => {
	const { db, store } = open();
	const first = store.reserve(reservation);
	db.exec(
		"CREATE TRIGGER fail_cancel BEFORE UPDATE ON customer_release_cycles BEGIN SELECT RAISE(ABORT, 'injected cancellation failure'); END",
	);
	expect(() =>
		store.cancel(first.cycleId, 0, "unknown", reservation.now + 1),
	).toThrow("injected cancellation failure");
	expect(store.get(first.cycleId)).toEqual(first);
	expect(store.events(first.cycleId)).toHaveLength(1);
	db.exec("DROP TRIGGER fail_cancel");
	expect(() =>
		db
			.prepare(
				"UPDATE customer_release_cycles SET release_id=? WHERE cycle_id=?",
			)
			.run("replacement", first.cycleId),
	).toThrow("immutable identity");
	expect(() =>
		db
			.prepare("UPDATE customer_release_events SET reason=? WHERE cycle_id=?")
			.run("replacement", first.cycleId),
	).toThrow("immutable event");
	store.cancel(first.cycleId, 0, "unknown", reservation.now + 1);
	expect(() =>
		db
			.prepare(
				"UPDATE customer_release_cycles SET invalidated_event_seq=NULL WHERE cycle_id=?",
			)
			.run(first.cycleId),
	).toThrow("immutable identity");
});

it.each(["committing", "commit_unknown", "published"] as const)(
	"T20 preserves %s while durably latching a post-claim intervention",
	(state) => {
		const { db, store } = open();
		const cycle = store.reserve(reservation);
		// Persisted execution-state fixture; this test exercises invalidation, not claim authorization.
		db.prepare(
			"UPDATE customer_release_cycles SET state=? WHERE cycle_id=?",
		).run(state, cycle.cycleId);
		expect(
			store.invalidate(
				cycle.cycleId,
				0,
				"gateway_unhealthy",
				reservation.now + 1,
			),
		).toBe("post_claim");
		const latched = store.get(cycle.cycleId)!;
		expect(latched).toMatchObject({
			state,
			revision: 1,
			invalidatedEventSeq: expect.any(Number),
		});
		expect(store.events(cycle.cycleId).at(-1)).toMatchObject({
			kind: "post_claim_intervention",
			reason: "gateway_unhealthy",
		});
		expect(
			store.invalidate(
				cycle.cycleId,
				0,
				"gateway_unhealthy",
				reservation.now + 1,
			),
		).toBe("unchanged");
		expect(
			store.invalidate(cycle.cycleId, 1, "source_unknown", reservation.now + 2),
		).toBe("post_claim");
		expect(store.get(cycle.cycleId)?.invalidatedEventSeq).toBe(
			latched.invalidatedEventSeq,
		);
	},
);

it("T09 invalidates pre-claim work but does not append duplicate terminal cancellation events", () => {
	const { store } = open();
	const cycle = store.reserve(reservation);
	expect(
		store.invalidate(cycle.cycleId, 0, "source_unknown", reservation.now + 1),
	).toBe("cancelled");
	expect(
		store.invalidate(cycle.cycleId, 1, "source_unknown", reservation.now + 2),
	).toBe("unchanged");
	expect(store.events(cycle.cycleId)).toHaveLength(2);
});
