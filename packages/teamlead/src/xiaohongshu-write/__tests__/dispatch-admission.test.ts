import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { signDispatchPermit } from "../permit.js";
import { fixture, NOW } from "./store-fixture.js";

const fixtures: ReturnType<typeof fixture>[] = [];
function setup() {
	const f = fixture();
	fixtures.push(f);
	f.store.setDispatchEnabled(true, NOW);
	f.approve();
	const claim = f.store.claim(f.request, NOW + 3000);
	if (claim.kind !== "claimed") throw Error("fixture");
	const permit = JSON.parse(
		signDispatchPermit(
			{
				audience: f.identity.providerInstanceId,
				proposalId: f.frozen.proposalId,
				receiptId: f.receiptId,
				attemptId: claim.attemptId,
				contentDigest: f.digest,
				accountUserId: f.identity.accountUserId,
				accountEpoch: f.identity.accountEpoch,
				providerGeneration: f.identity.providerGeneration,
				leaseId: f.request.leaseId,
				keyId: "key-a",
				approvalExpiresAt: f.decision.expiresAt,
				leaseExpiresAt: NOW + 90000,
			},
			Buffer.alloc(32),
			NOW + 3000,
		).permitJson,
	);
	return { f, permit };
}
afterEach(() => {
	for (const f of fixtures.splice(0)) f.close();
});
it("admits only the exact claimed attempt and retains activation provenance", () => {
	const { f, permit } = setup();
	expect(
		f.store.admitDispatch(
			permit,
			f.identity,
			"activation-a",
			"key-a",
			NOW + 3001,
		),
	).toEqual(f.frozen);
	f.restart();
	expect(
		f.store.dispatchContext(
			permit,
			f.identity,
			"activation-a",
			"key-a",
			NOW + 3002,
		),
	).toEqual(f.frozen);
});
it.each([
	"contentDigest",
	"leaseId",
	"receiptId",
	"attemptId",
	"accountUserId",
	"audience",
	"keyId",
	"providerGeneration",
])("rejects changed %s", (field) => {
	const { f, permit } = setup();
	expect(
		f.store.admitDispatch(
			{ ...permit, [field]: "wrong" },
			f.identity,
			"activation-a",
			"key-a",
			NOW + 3001,
		),
	).toBeNull();
});
it("orders gate closure before admission and never revives claimed work", () => {
	const { f, permit } = setup();
	f.store.setDispatchEnabled(false, NOW + 3001);
	f.store.setDispatchEnabled(true, NOW + 3002);
	expect(
		f.store.admitDispatch(
			permit,
			f.identity,
			"activation-a",
			"key-a",
			NOW + 3003,
		),
	).toBeNull();
});
it("rejects changed activation and terminal attempt", () => {
	const { f, permit } = setup();
	expect(
		f.store.admitDispatch(
			permit,
			f.identity,
			"other-activation",
			"key-a",
			NOW + 3001,
		),
	).toBeNull();
	f.store.finish(permit.attemptId, "unknown", NOW + 3002);
	expect(
		f.store.admitDispatch(
			permit,
			f.identity,
			"activation-a",
			"key-a",
			NOW + 3003,
		),
	).toBeNull();
});
it("does not provide token context before admission", () => {
	const { f, permit } = setup();
	expect(
		f.store.dispatchContext(
			permit,
			f.identity,
			"activation-a",
			"key-a",
			NOW + 3001,
		),
	).toBeNull();
});

it("migrates old private metadata with dispatch closed despite existing approval", () => {
	const f = fixture();
	fixtures.push(f);
	f.approve();
	f.store.close();
	const db = new Database(f.path);
	db.exec(
		"ALTER TABLE authority_metadata DROP COLUMN write_enabled; ALTER TABLE authority_metadata DROP COLUMN gate_updated_at",
	);
	db.close();
	f.restart();
	expect(f.store.claim(f.request, NOW + 3000)).toEqual({
		kind: "denied",
		code: "write_gate_closed",
	});
});
it("rolls back admission when its durable update fails", () => {
	const { f, permit } = setup();
	const db = new Database(f.path);
	try {
		db.exec(
			"CREATE TRIGGER deny_admission BEFORE UPDATE ON xhs_write_attempt WHEN NEW.state='dispatch-admitted' BEGIN SELECT RAISE(ABORT,'admission_write_failed'); END",
		);
		expect(() =>
			f.store.admitDispatch(
				permit,
				f.identity,
				"activation-a",
				"key-a",
				NOW + 3001,
			),
		).toThrow("admission_write_failed");
		expect(
			f.store.status(f.frozen.proposalId, f.identity)?.attempt?.state,
		).toBe("claimed");
		expect(
			f.store.dispatchContext(
				permit,
				f.identity,
				"activation-a",
				"key-a",
				NOW + 3002,
			),
		).toBeNull();
	} finally {
		db.close();
	}
});
it("keeps an already admitted attempt eligible after closure but rejects clock rollback", () => {
	const { f, permit } = setup();
	expect(
		f.store.admitDispatch(
			permit,
			f.identity,
			"activation-a",
			"key-a",
			NOW + 3001,
		),
	).not.toBeNull();
	f.store.setDispatchEnabled(false, NOW + 4000);
	expect(
		f.store.dispatchContext(
			permit,
			f.identity,
			"activation-a",
			"key-a",
			NOW + 3500,
		),
	).toBeNull();
	expect(
		f.store.dispatchContext(
			permit,
			f.identity,
			"activation-a",
			"key-a",
			NOW + 4001,
		),
	).toEqual(f.frozen);
});
it("revokes unconsumed approvals when the gate closes", () => {
	const f = fixture();
	fixtures.push(f);
	f.approve();
	f.store.setDispatchEnabled(false, NOW + 3000);
	f.store.setDispatchEnabled(true, NOW + 3001);
	expect(f.store.claim(f.request, NOW + 3002).kind).toBe("denied");
	expect(f.store.status(f.frozen.proposalId, f.identity)?.state).toBe(
		"revoked",
	);
});
it("refreshes expiry time after acquiring the writer transaction", () => {
	const { f, permit } = setup();
	let reads = 0;
	expect(
		f.store.admitDispatch(permit, f.identity, "activation-a", "key-a", () =>
			++reads === 1 ? NOW + 3001 : NOW + 120000,
		),
	).toBeNull();
	expect(reads).toBe(2);
});
