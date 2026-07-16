import { chmodSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileDeliverySecretProvider } from "../bridge/delivery-secret.js";
import { deriveLeadEventAckToken } from "../bridge/lead-event-delivery.js";
import { StateStore } from "../StateStore.js";

describe("FileDeliverySecretProvider (FLY-1279 D1)", () => {
	let store: StateStore;
	let dir: string;
	let secretPath: string;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		dir = mkdtempSync(join(tmpdir(), "fly1279-secret-"));
		secretPath = join(dir, "delivery-secret");
	});

	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("provisions once with a durable ACTIVE marker and stable token", () => {
		const first = new FileDeliverySecretProvider({
			store,
			secretPath,
		}).getActive();
		const second = new FileDeliverySecretProvider({
			store,
			secretPath,
		}).getActive();
		expect(second.secretId).toBe(first.secretId);
		expect(second.key.equals(first.key)).toBe(true);
		expect(store.getDeliverySecretState()).toMatchObject({
			state: "ACTIVE",
			activeSecretId: first.secretId,
		});
		expect(
			deriveLeadEventAckToken(first, {
				eventSeq: 1,
				ackOwnerLeadId: "lead-1",
				ownerEpoch: 0,
			}),
		).toBe(
			deriveLeadEventAckToken(second, {
				eventSeq: 1,
				ackOwnerLeadId: "lead-1",
				ownerEpoch: 0,
			}),
		);
	});

	it("fails loudly instead of regenerating when an ACTIVE secret disappears", () => {
		const provider = new FileDeliverySecretProvider({ store, secretPath });
		const active = provider.getActive();
		unlinkSync(`${secretPath}.${active.secretId}`);
		expect(() => provider.getActive()).toThrow(
			/ACTIVE delivery secret.*missing/,
		);
		expect(store.getDeliverySecretState()?.activeSecretId).toBe(
			active.secretId,
		);
	});

	it("rejects an insecure established secret file", () => {
		const provider = new FileDeliverySecretProvider({ store, secretPath });
		const active = provider.getActive();
		chmodSync(`${secretPath}.${active.secretId}`, 0o644);
		expect(() => provider.getActive()).toThrow(/mode 0600/);
	});

	it("rotation advances the marker and invalidates the old derived bearer", () => {
		const provider = new FileDeliverySecretProvider({ store, secretPath });
		const before = provider.getActive();
		const after = provider.rotate();
		expect(after.secretId).not.toBe(before.secretId);
		expect(store.getDeliverySecretState()?.activeSecretId).toBe(after.secretId);
		const tuple = { eventSeq: 9, ackOwnerLeadId: "lead-1", ownerEpoch: 0 };
		expect(deriveLeadEventAckToken(after, tuple)).not.toBe(
			deriveLeadEventAckToken(before, tuple),
		);
	});
});
