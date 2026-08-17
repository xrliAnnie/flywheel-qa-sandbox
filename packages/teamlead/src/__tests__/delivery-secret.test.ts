import {
	chmodSync,
	existsSync,
	mkdtempSync,
	rmSync,
	unlinkSync,
} from "node:fs";
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

	/**
	 * FLY-1809 (Codex review MEDIUM). Every test above hands the provider an
	 * explicit `secretPath`, so nothing sealed the `FLYWHEEL_DELIVERY_SECRET_PATH`
	 * fallback — yet that env var is the QA isolation lever. An isolated Bridge
	 * that fails to honor it resolves the RESIDENT `~/.flywheel/delivery-secret`,
	 * and provisioning against that Bridge's empty StateStore then runs
	 * `removeOrphanVersions()` over the production secret versions.
	 *
	 * `HOME` is redirected first so this test can go red WITHOUT reproducing that
	 * damage: if the env read is ever removed, the fallback lands in a throwaway
	 * dir instead of the real `~/.flywheel`.
	 */
	it("FLY-1809 resolves the secret path from FLYWHEEL_DELIVERY_SECRET_PATH", () => {
		const home = mkdtempSync(join(tmpdir(), "fly1809-home-"));
		const configured = join(dir, "isolated-slot", "delivery-secret");
		const prevHome = process.env.HOME;
		const prevPath = process.env.FLYWHEEL_DELIVERY_SECRET_PATH;
		process.env.HOME = home;
		process.env.FLYWHEEL_DELIVERY_SECRET_PATH = configured;
		try {
			// No `secretPath` — the env var is the ONLY thing that can steer this.
			const active = new FileDeliverySecretProvider({ store }).getActive();
			expect(existsSync(`${configured}.${active.secretId}`)).toBe(true);
			// and nothing was written to the fallback location
			expect(existsSync(join(home, ".flywheel"))).toBe(false);
		} finally {
			if (prevHome === undefined) delete process.env.HOME;
			else process.env.HOME = prevHome;
			if (prevPath === undefined)
				delete process.env.FLYWHEEL_DELIVERY_SECRET_PATH;
			else process.env.FLYWHEEL_DELIVERY_SECRET_PATH = prevPath;
			rmSync(home, { recursive: true, force: true });
		}
	});
});
