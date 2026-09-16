import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { CustomerReleaseAccounting } from "../customer-release/accounting.js";
import { CustomerReleaseStore } from "../customer-release/store.js";

const dbs: Database.Database[] = [];
afterEach(() => {
	for (const db of dbs.splice(0)) db.close();
});
const event = {
	eventId: "cycle:e1",
	projectId: "flywheel" as const,
	cycleId: "c1",
	kind: "cancelled",
	when: 1000,
	origin: "manual_intake" as const,
	facts: { reason: "manual_intake", windowOpenedAt: null },
};
function fixture() {
	const db = new Database(":memory:");
	dbs.push(db);
	const ledger = new CustomerReleaseAccounting(db);
	ledger.migrate();
	return { db, ledger };
}
it("freezes one source snapshot for both targets and rejects mutated replay", () => {
	const f = fixture();
	f.ledger.enqueue(event);
	f.ledger.enqueue(event);
	expect(f.ledger.pending(1000)).toHaveLength(2);
	expect(() => f.ledger.enqueue({ ...event, kind: "published" })).toThrow();
	expect(
		f.ledger.pending(1000).every((row) => row.event.origin === "manual_intake"),
	).toBe(true);
});
it("a lost create response recovers the same marker and reads it back without another POST", async () => {
	const f = fixture();
	f.ledger.enqueue(event);
	let sent = false;
	const transport = {
		find: vi.fn(async () => (sent ? [{ id: "external-1" }] : [])),
		create: vi.fn(async () => {
			sent = true;
			throw new Error("lost response");
		}),
		read: vi.fn(async () => ({
			marker: "release-event:cycle:e1",
			digest: f.ledger.pending(1000)[0]!.digest,
		})),
	};
	await f.ledger.project("linear", transport, 1000);
	expect(f.ledger.status(event.eventId, "linear")?.state).toBe("pending");
	await f.ledger.project("linear", transport, 61000);
	expect(transport.create).toHaveBeenCalledTimes(1);
	expect(f.ledger.status(event.eventId, "linear")?.state).toBe("delivered");
	expect(f.ledger.status(event.eventId, "github")?.state).toBe("pending");
});
it("ambiguous lookup and wrong readback remain pending and never re-create", async () => {
	const f = fixture();
	f.ledger.enqueue(event);
	const transport = {
		find: vi.fn(async () => [{ id: "a" }, { id: "b" }]),
		create: vi.fn(async () => "c"),
		read: vi.fn(async () => ({ marker: "wrong", digest: "0".repeat(64) })),
	};
	await f.ledger.project("github", transport, 1000);
	expect(transport.create).not.toHaveBeenCalled();
	expect(f.ledger.status(event.eventId, "github")?.state).toBe("pending");
});

it("migration repeats safely and a crash after send intent cannot cause a blind second create", async () => {
	const f = fixture();
	f.ledger.enqueue(event);
	f.ledger.migrate();
	f.db
		.prepare(
			"UPDATE customer_release_projections SET create_started=1 WHERE target='linear'",
		)
		.run();
	const transport = {
		find: vi.fn(async () => []),
		create: vi.fn(async () => "id"),
		read: vi.fn(async () => ({ marker: "unused", digest: "unused" })),
	};
	await f.ledger.project("linear", transport, 1000);
	expect(transport.create).not.toHaveBeenCalled();
	expect(f.ledger.status(event.eventId, "linear")?.state).toBe("pending");
	expect(() =>
		f.db
			.prepare("UPDATE customer_release_projections SET content_json='{}'")
			.run(),
	).toThrow("immutable");
});

it("captures real cancelled manual intake once, retaining safe proof references and snapshot time", () => {
	const db = new Database(":memory:");
	dbs.push(db);
	const store = new CustomerReleaseStore(db);
	store.migrate();
	const now = Date.parse("2026-09-15T15:00:00Z");
	const cycle = store.reserveManualIntake(
		{
			projectId: "flywheel",
			slotDate: "2026-09-15",
			releaseId: "manual1",
			activationEpoch: 1,
			policyRevision: "a".repeat(64),
			betaVersion: "1.2.3-beta.1",
			manifest: {
				versions: {
					"1.2.3-beta.1": {
						channel: "beta",
						status: "active",
						sourceCommit: "b".repeat(40),
						sha256: "c".repeat(64),
					},
				},
			},
			now,
		},
		"d".repeat(64),
	);
	store.accounting.capture(now);
	const rows = store.accounting.pending(now);
	expect(rows.length).toBeGreaterThan(0);
	expect(rows.every((row) => row.event.origin === "manual_intake")).toBe(true);
	expect(rows[0]!.event.facts).toMatchObject({
		capturedAt: now,
		snapshot: { state: "cancelled", windowOpenedAt: null },
	});
	const content = rows.map((row) => row.content);
	store.accounting.capture(now + 1000);
	expect(
		store.accounting.pending(now + 1000).map((row) => row.content),
	).toEqual(content);
	expect(cycle).toBeTruthy();
});

it("records a missed slot without inventing a candidate or exposing activation payload", () => {
	const db = new Database(":memory:");
	dbs.push(db);
	const store = new CustomerReleaseStore(db);
	store.migrate();
	db.prepare(
		"INSERT INTO customer_release_activation_events VALUES (?,?,?,?,?,?)",
	).run(
		"slot:flywheel:2026-09-14",
		"flywheel",
		1,
		"cycle_slot_missed",
		JSON.stringify({
			weekStart: "2026-09-14",
			reason: "unknown",
			token: "must-not-project",
		}),
		100,
	);
	store.accounting.capture(200);
	const row = store.accounting.pending(200)[0]!;
	expect(row.event).toMatchObject({
		cycleId: null,
		origin: "activation",
		kind: "cycle_slot_missed",
		facts: { reason: "unknown", weekStart: "2026-09-14" },
	});
	expect(row.content).not.toContain("must-not-project");
	expect(
		db.prepare("SELECT COUNT(*) AS n FROM customer_release_cycles").get(),
	).toEqual({ n: 0 });
});

it("repairs only a matching marker at the known external ID and independently reads it back", async () => {
	const f = fixture();
	f.ledger.enqueue(event);
	let repaired = false;
	const digest = f.ledger.status(event.eventId, "linear")!.digest;
	const transport = {
		find: vi.fn(async () => [{ id: "owned" }]),
		create: vi.fn(async () => "unused"),
		read: vi.fn(async () => ({
			marker: "release-event:cycle:e1",
			digest: repaired ? digest : "wrong",
		})),
		update: vi.fn(async () => {
			repaired = true;
		}),
	};
	await f.ledger.project("linear", transport, 1000);
	expect(transport.update).toHaveBeenCalledWith(
		"owned",
		"release-event:cycle:e1",
		event,
		digest,
	);
	expect(transport.read).toHaveBeenCalledTimes(2);
	expect(transport.create).not.toHaveBeenCalled();
	expect(f.ledger.status(event.eventId, "linear")?.state).toBe("delivered");
});

it("a successful update response without matching readback stays pending", async () => {
	const f = fixture();
	f.ledger.enqueue(event);
	const transport = {
		find: vi.fn(async () => [{ id: "owned" }]),
		create: vi.fn(async () => "unused"),
		read: vi.fn(async () => ({
			marker: "release-event:cycle:e1",
			digest: "wrong",
		})),
		update: vi.fn(async () => {}),
	};
	await f.ledger.project("linear", transport, 1000);
	expect(transport.update).toHaveBeenCalledTimes(1);
	expect(transport.read).toHaveBeenCalledTimes(2);
	expect(f.ledger.status(event.eventId, "linear")?.state).toBe("pending");
});

it("gives unattempted audit events a turn ahead of repeatedly failing old events", async () => {
	const f = fixture();
	for (let n = 0; n < 60; n++)
		f.ledger.enqueue({
			...event,
			eventId: `event:${String(n).padStart(3, "0")}`,
		});
	const transport = {
		find: vi.fn(async () => {
			throw new Error("target unavailable");
		}),
		create: vi.fn(async () => "unused"),
		read: vi.fn(async () => ({ marker: "unused", digest: "unused" })),
	};
	await f.ledger.project("linear", transport, 1000);
	const next = f.ledger
		.pending(31000)
		.filter((row) => row.target === "linear")[0]!;
	expect(next.eventId).toBe("event:010");
});

it("exports the manual decision's new full artifact binding and safe manifest proof without the permit nonce", () => {
	const db = new Database(":memory:");
	dbs.push(db);
	const store = new CustomerReleaseStore(db);
	store.migrate();
	const now = Date.parse("2026-09-15T15:00:00Z");
	const cycle = store.reserveManualIntake(
		{
			projectId: "flywheel",
			slotDate: "2026-09-15",
			releaseId: "original",
			activationEpoch: 1,
			policyRevision: "a".repeat(64),
			betaVersion: "1.2.3-beta.1",
			manifest: {
				versions: {
					"1.2.3-beta.1": {
						channel: "beta",
						status: "active",
						sourceCommit: "b".repeat(40),
						sha256: "c".repeat(64),
					},
				},
			},
			now,
		},
		"d".repeat(64),
	);
	const fullBinding = {
		releaseId: "new-manual-op",
		betaVersion: "1.2.3-beta.1",
		betaPayloadSha256: "c".repeat(64),
		releaseVersion: "1.2.3",
		releasePayloadSha256: "e".repeat(64),
		sourceCommit: "b".repeat(40),
	};
	db.prepare("INSERT INTO customer_release_decisions VALUES (?,?,?,?,?,?)").run(
		"decision-1",
		cycle.cycleId,
		"attempt-1",
		"{}",
		JSON.stringify({
			nonce: "must-not-export",
			fullBinding,
			trigger: "founder_go",
			actor: "founder",
			readiness: { state: "green", reasons: [] },
			baseEtag: '"base"',
		}),
		now,
	);
	db.prepare(
		"INSERT INTO customer_release_attempt_results VALUES (?,?,?,?,?,?)",
	).run(
		"attempt-1",
		cycle.cycleId,
		"published",
		JSON.stringify({
			nonce: "must-not-export",
			manifestEtag: '"observed"',
			manifest: { releaseOps: { "new-manual-op": { state: "committed" } } },
		}),
		"published",
		now,
	);
	store.accounting.capture(now);
	const row = store.accounting.pending(now)[0]!;
	expect(row.event.facts.decisions).toEqual([
		expect.objectContaining({
			fullBinding,
			baseEtag: '"base"',
			readiness: { state: "green", reasons: [] },
		}),
	]);
	expect(row.event.facts.results).toEqual([
		expect.objectContaining({
			manifestEtag: '"observed"',
			manifestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
		}),
	]);
	expect(row.content).not.toContain("must-not-export");
});

it("retains the founder actor for activation audit without copying credential-like payload fields", () => {
	const db = new Database(":memory:");
	dbs.push(db);
	const store = new CustomerReleaseStore(db);
	store.migrate();
	db.prepare(
		"INSERT INTO customer_release_activation_events VALUES (?,?,?,?,?,?)",
	).run(
		"123456789012345678",
		"flywheel",
		1,
		"disabled",
		JSON.stringify({
			actorId: "223456789012345678",
			epoch: 1,
			token: "must-not-export",
		}),
		100,
	);
	store.accounting.capture(200);
	const row = store.accounting.pending(200)[0]!;
	expect(row.event.facts).toMatchObject({
		who: "223456789012345678",
		actionId: "123456789012345678",
	});
	expect(row.content).not.toContain("must-not-export");
});
