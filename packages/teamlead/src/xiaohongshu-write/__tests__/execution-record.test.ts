import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { fixture, NOW } from "./store-fixture.js";

const cleanups: (() => void)[] = [];
function setup() {
	const f = fixture();
	cleanups.push(() => f.close());
	return f;
}
afterEach(() => {
	for (const close of cleanups.splice(0)) close();
});

it("recovers assigned proposal identity and expiry by scoped prepare request after restart", () => {
	const f = setup();
	expect(f.store.preparedRequest("prepare-a", f.identity)).toBeNull();
	f.prepare();
	f.restart();
	expect(f.store.preparedRequest("prepare-a", f.identity)).toMatchObject({
		frozen: f.frozen,
		expiresAt: NOW + 600000,
		state: "awaiting_delivery",
		supersedesProposalId: null,
	});
	expect(() =>
		f.store.preparedRequest("prepare-a", { ...f.identity, requesterUid: 502 }),
	).toThrow("prepare_conflict");
});

it("refreshes receipt time only after obtaining the write transaction", () => {
	const f = setup();
	f.approve();
	const competitor = new Database(f.path, { timeout: 0 });
	try {
		const now = () => {
			expect(() => competitor.exec("BEGIN IMMEDIATE")).toThrow(/locked/);
			return f.decision.expiresAt;
		};
		expect(f.store.claim(f.request, now)).toEqual({
			kind: "denied",
			code: "founder_receipt_expired",
		});
		expect(() =>
			f.store.executionRecord(f.frozen.proposalId, f.digest, f.identity, now),
		).toThrow("founder_receipt_expired");
	} finally {
		if (competitor.inTransaction) competitor.exec("ROLLBACK");
		competitor.close();
	}
});

it("reads the exact approved frozen proposal without consuming its receipt", () => {
	const f = setup();
	f.approve();
	const record = f.store.executionRecord(
		f.frozen.proposalId,
		f.digest,
		f.identity,
		NOW + 3000,
	);
	expect(record.frozen).toEqual(f.frozen);
	expect(record.receiptId).toBe(f.receiptId);
	expect(record.approvalExpiresAt).toBe(f.decision.expiresAt);
	expect(record.attempt).toBeNull();
	expect(f.store.status(f.frozen.proposalId, f.identity)?.state).toBe(
		"approved",
	);
});
it("rejects missing approval, changed digest or identity, expiry and revoked approval", () => {
	const f = setup();
	f.prepare();
	expect(() =>
		f.store.executionRecord(
			f.frozen.proposalId,
			f.digest,
			f.identity,
			NOW + 3000,
		),
	).toThrow("founder_receipt_invalid");
	f.approve();
	expect(() =>
		f.store.executionRecord(
			f.frozen.proposalId,
			"f".repeat(64),
			f.identity,
			NOW + 3000,
		),
	).toThrow("founder_content_digest_mismatch");
	expect(() =>
		f.store.executionRecord(
			f.frozen.proposalId,
			f.digest,
			{ ...f.identity, projectId: "other" },
			NOW + 3000,
		),
	).toThrow("founder_receipt_invalid");
	expect(() =>
		f.store.executionRecord(
			f.frozen.proposalId,
			f.digest,
			f.identity,
			f.decision.expiresAt,
		),
	).toThrow("founder_receipt_expired");
	f.store.cancel(f.frozen.proposalId, f.identity, NOW + 3000);
	expect(() =>
		f.store.executionRecord(
			f.frozen.proposalId,
			f.digest,
			f.identity,
			NOW + 3001,
		),
	).toThrow("founder_receipt_revoked");
});
it("returns an existing attempt after restart and expiry without reopening admission", () => {
	const f = setup();
	f.approve();
	const claim = f.store.claim(f.request, NOW + 3000);
	if (claim.kind !== "claimed") throw Error();
	f.restart();
	const record = f.store.executionRecord(
		f.frozen.proposalId,
		f.digest,
		f.identity,
		f.decision.expiresAt + 1,
	);
	expect(record.attempt).toEqual({
		attemptId: claim.attemptId,
		state: "claimed",
		activationId: f.request.activationId,
	});
	f.store.setDispatchEnabled(false, f.decision.expiresAt + 2);
	expect(
		f.store.executionRecord(
			f.frozen.proposalId,
			f.digest,
			f.identity,
			f.decision.expiresAt + 3,
		).attempt?.state,
	).toBe("unknown");
});
