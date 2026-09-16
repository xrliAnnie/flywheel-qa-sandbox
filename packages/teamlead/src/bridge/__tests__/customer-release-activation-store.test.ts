import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { CustomerReleaseActivationStore } from "../customer-release/activation-store.js";

const identity = {
	projectId: "flywheel" as const,
	policyRevision: "a".repeat(64),
	founderId: "123456789012345678",
	endpoint: "https://endpoint.example",
	audience: "payload",
	botTokenSha256: "b".repeat(64),
	decisionTokenSha256: "c".repeat(64),
	identityDigest: "d".repeat(64),
};
it("activation exists before any cycle, stays disabled and bumps epoch atomically on identity changes", () => {
	const db = new Database(":memory:");
	const invalidateRuntime = vi.fn();
	try {
		const store = new CustomerReleaseActivationStore(db, { invalidateRuntime });
		store.migrate();
		store.migrate();
		expect(store.synchronize(identity, 1000)).toMatchObject({
			epoch: 1,
			enabled: false,
		});
		expect(store.synchronize(identity, 2000).epoch).toBe(1);
		const changed = {
			...identity,
			identityDigest: "e".repeat(64),
			founderId: "223456789012345678",
		};
		expect(store.synchronize(changed, 3000)).toMatchObject({
			epoch: 2,
			enabled: false,
			enableReceiptId: null,
		});
		expect(invalidateRuntime).toHaveBeenCalledWith(
			"activation_identity_changed",
			3000,
		);
		invalidateRuntime.mockImplementation(() => {
			throw new Error("transaction failure");
		});
		expect(() => store.synchronize(identity, 4000)).toThrow();
		expect(store.get()?.epoch).toBe(2);
		expect(
			(
				db
					.prepare(
						"SELECT count(*) AS n FROM customer_release_activation_events",
					)
					.get() as { n: number }
			).n,
		).toBe(2);
	} finally {
		db.close();
	}
});
it("enable requires matching delivered notice identity; replay is immutable and owner change revokes it", () => {
	const db = new Database(":memory:");
	try {
		const store = new CustomerReleaseActivationStore(db, {
			invalidateRuntime: () => {},
		});
		store.migrate();
		store.synchronize(identity, 1000);
		const notice = {
			noticeId: "notice-1",
			epoch: 1,
			identityDigest: identity.identityDigest,
			evidenceBundleDigest: "f".repeat(64),
			applicationId: "323456789012345678",
			channelId: "423456789012345678",
			messageId: "523456789012345678",
			expiresAt: 5000,
		};
		const action = {
			interactionId: "623456789012345678",
			noticeId: notice.noticeId,
			actorId: identity.founderId,
			applicationId: notice.applicationId,
			channelId: notice.channelId,
			messageId: notice.messageId,
		};
		expect(() => store.enable(action, 2000)).toThrow();
		expect(() =>
			store.recordDeliveredEnableNotice(
				{ ...notice, interactionToken: "secret-fixture" } as typeof notice,
				1500,
			),
		).toThrow();
		store.recordDeliveredEnableNotice(notice, 1500);
		expect(() =>
			store.enable(
				{ ...action, interactionToken: "secret-fixture" } as typeof action,
				2000,
			),
		).toThrow();
		expect(() =>
			store.enable({ ...action, actorId: "723456789012345678" }, 2000),
		).toThrow();
		expect(store.enable(action, 2000)).toMatchObject({
			enabled: true,
			enableReceiptId: action.interactionId,
		});
		expect(store.enable(action, 6000)).toEqual(store.get());
		expect(() =>
			db
				.prepare(
					"UPDATE customer_release_activation_events SET kind='tampered'",
				)
				.run(),
		).toThrow();
		expect(
			store.synchronize({ ...identity, identityDigest: "e".repeat(64) }, 7000),
		).toMatchObject({ epoch: 2, enabled: false, enableReceiptId: null });
		expect(() => store.enable(action, 7001)).toThrow();
	} finally {
		db.close();
	}
});

it("canonical founder disable revokes authority and invalidates work in the same transaction", () => {
	const db = new Database(":memory:");
	const invalidateRuntime = vi.fn();
	try {
		const store = new CustomerReleaseActivationStore(db, { invalidateRuntime });
		store.migrate();
		store.synchronize(identity, 1000);
		expect(() =>
			store.disable("223456789012345678", "323456789012345678", 1, 2000),
		).toThrow();
		expect(
			store.disable("223456789012345678", identity.founderId, 1, 2000).enabled,
		).toBe(false);
		expect(invalidateRuntime).toHaveBeenLastCalledWith(
			"founder_disabled",
			2000,
		);
		expect(() =>
			store.disable("223456789012345678", identity.founderId, 2, 3000),
		).toThrow();
	} finally {
		db.close();
	}
});
