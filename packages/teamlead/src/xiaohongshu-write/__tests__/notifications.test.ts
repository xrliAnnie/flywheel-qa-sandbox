import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { fixture, NOW } from "./store-fixture.js";

const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(() => {
	for (const f of fixtures.splice(0)) f.close();
});
function setup() {
	const f = fixture();
	fixtures.push(f);
	return f;
}
it("expires an unused approval atomically and leaves one durable founder notice", () => {
	const f = setup();
	f.approve();
	expect(f.store.expireProposals(f.decision.expiresAt - 1)).toBe(0);
	expect(f.store.expireProposals(f.decision.expiresAt)).toBe(1);
	f.restart();
	expect(f.store.expireProposals(f.decision.expiresAt + 1)).toBe(0);
	expect(f.store.claim(f.request, f.decision.expiresAt + 2).kind).toBe(
		"denied",
	);
	const notices = f.store.pendingFounderNotifications();
	expect(notices.filter((n) => n.eventKind === "expired")).toHaveLength(1);
	expect(f.store.status(f.frozen.proposalId, f.identity)?.state).toBe(
		"expired",
	);
});
it("never expires a consumed attempt or revives it through an outbox retry", () => {
	const f = setup();
	f.approve();
	f.store.claim(f.request, NOW + 3000);
	expect(f.store.expireProposals(NOW + 86400_000)).toBe(0);
	expect(f.store.claim(f.request, NOW + 86400_001).kind).toBe("existing");
});
it("reports undelivered approval after sixty seconds without extending receipt expiry", () => {
	const f = setup();
	f.approve();
	expect(f.store.flagDelayedNotifications(f.decision.observedAt + 59999)).toBe(
		0,
	);
	expect(f.store.flagDelayedNotifications(f.decision.observedAt + 60000)).toBe(
		1,
	);
	expect(f.store.flagDelayedNotifications(f.decision.observedAt + 60001)).toBe(
		0,
	);
	expect(
		f.store
			.pendingFounderNotifications()
			.filter((n) => n.eventKind === "delivery_delayed"),
	).toHaveLength(1);
	expect(f.store.claim(f.request, f.decision.expiresAt).kind).toBe("denied");
});
it("keeps founder and bridge delivery independently durable across restart", () => {
	const f = setup();
	f.approve();
	const notice = f.store.pendingFounderNotifications()[0]!;
	f.store.recordFounderNotificationAttempt(notice.eventId, false);
	f.restart();
	expect(f.store.pendingFounderNotifications()[0]?.attemptCount).toBe(1);
	f.store.recordFounderNotificationAttempt(notice.eventId, true);
	expect(f.store.pendingFounderNotifications()).toEqual([]);
	expect(
		f.store
			.bridgeNotifications(f.identity)
			.some((n) => n.eventId === notice.eventId),
	).toBe(true);
	f.store.ackBridgeNotification(notice.eventId, f.identity);
	expect(f.store.flagDelayedNotifications(f.decision.observedAt + 60000)).toBe(
		0,
	);
});
it("can expire an unapproved proposal without manufacturing a receipt", () => {
	const f = setup();
	f.prepare();
	expect(f.store.expireProposals(NOW + 600000)).toBe(1);
	expect(f.store.pendingFounderNotifications()).toMatchObject([
		{ eventKind: "expired", receiptId: null },
	]);
	expect(
		f.store.receiptForFounderMessage(f.decision.founderMessageId),
	).toBeNull();
});

it("rolls back expiry and its notice together if COMMIT fails", () => {
	const f = setup();
	f.approve();
	const db = (f.store as unknown as { database: Database.Database }).database;
	const original = db.exec.bind(db);
	const spy = vi.spyOn(db, "exec").mockImplementation((sql) => {
		if (sql === "COMMIT") throw Error("SQLITE_IOERR_FSYNC");
		return original(sql);
	});
	try {
		expect(() => f.store.expireProposals(f.decision.expiresAt)).toThrow();
	} finally {
		spy.mockRestore();
	}
	f.restart();
	expect(f.store.status(f.frozen.proposalId, f.identity)?.state).toBe(
		"approved",
	);
	expect(f.store.pendingFounderNotifications().map((n) => n.eventKind)).toEqual(
		["approved"],
	);
	expect(f.store.expireProposals(f.decision.expiresAt)).toBe(1);
});
it("a bridge ACK cannot suppress expiry or mint or extend an approval", () => {
	const f = setup();
	f.approve();
	f.store.ackBridgeNotification(
		f.store.bridgeNotifications(f.identity)[0]!.eventId,
		f.identity,
	);
	f.store.ackBridgeNotification("invented", f.identity);
	expect(f.store.expireProposals(f.decision.expiresAt)).toBe(1);
	expect(f.store.pendingFounderNotifications().map((n) => n.eventKind)).toEqual(
		["expired"],
	);
	expect(f.store.claim(f.request, f.decision.expiresAt).kind).toBe("denied");
});
it("suppresses a queued not-sent notice after the write has started", () => {
	const f = setup();
	f.approve();
	f.store.flagDelayedNotifications(f.decision.observedAt + 60000);
	expect(f.store.claim(f.request, f.decision.observedAt + 60001).kind).toBe(
		"claimed",
	);
	expect(
		f.store
			.pendingFounderNotifications()
			.some((n) => n.eventKind === "delivery_delayed"),
	).toBe(false);
});

it("scopes bridge reads and ACKs by original kernel UID, project and lead", () => {
	const f = setup();
	f.approve();
	const [notice] = f.store.bridgeNotifications(f.identity);
	expect(notice?.proposalId).toBe(f.frozen.proposalId);
	for (const change of [
		{ requesterUid: 502 },
		{ projectId: "other" },
		{ leadId: "other" },
	]) {
		const scope = { ...f.identity, ...change };
		expect(f.store.bridgeNotifications(scope)).toEqual([]);
		f.store.ackBridgeNotification(notice!.eventId, scope);
		expect(f.store.bridgeNotifications(f.identity)).toHaveLength(1);
	}
	f.store.ackBridgeNotification(notice!.eventId, f.identity);
	f.restart();
	expect(f.store.bridgeNotifications(f.identity)).toEqual([]);
	expect(f.store.pendingFounderNotifications()).toHaveLength(1);
	expect(f.store.status(f.frozen.proposalId, f.identity)?.state).toBe(
		"approved",
	);
});

it("filters scope before the bounded batch so another lead cannot starve delivery", () => {
	const f = setup();
	for (let i = 0; i < 101; i++) {
		f.store.prepare(
			{
				frozen: {
					...f.frozen,
					proposalId: randomUUID(),
					projectId: `other-${i}`,
				},
				prepareRequestId: `other-${i}`,
				expiresAt: NOW + 1000,
			},
			NOW,
		);
	}
	f.store.expireProposals(NOW + 1000);
	f.approve();
	expect(f.store.bridgeNotifications(f.identity)).toMatchObject([
		{ proposalId: f.frozen.proposalId, eventKind: "approved" },
	]);
	expect(
		f.store.bridgeNotifications({ ...f.identity, projectId: "other-0" }),
	).toHaveLength(1);
});
