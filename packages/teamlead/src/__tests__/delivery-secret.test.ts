import {
	chmodSync,
	existsSync,
	mkdirSync,
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

/**
 * FLY-1811: seals the branch nothing else covers — `FLYWHEEL_DELIVERY_SECRET_PATH`
 * absent AND no explicit `secretPath`, so the provider falls back to
 * `join(homedir(), ".flywheel", "delivery-secret")`.
 *
 * FLY-1809's test proves the env var STEERS the path; every older test hands in
 * an explicit `secretPath`. Neither exercises the fallback, which is what a
 * plain production Bridge actually takes, and which ends up in `mkdirSync` and
 * `removeOrphanVersions()` over a 0600 HMAC key.
 *
 * Why this one is deliberately literal: FLY-1811 found the registry declaring
 * `~/.flywheel/delivery-secret` while this code computes an absolute path. Node
 * does not expand `~`, so a declared default of that shape sends the secret to
 * `<cwd>/~/.flywheel/...`. Asserting against a shared helper would let both
 * sides drift together; spelling the expected path out means this test can
 * still say the owner is wrong.
 *
 * `homedir()` honours $HOME on POSIX, so no real home directory is touched, and
 * cwd is a scratch dir so a RED run cannot litter the checkout with a literal
 * `~` directory (which is exactly what a mutation run produced).
 */
describe("FLY-1811 delivery secret default path when nothing overrides it", () => {
	const realHome = process.env.HOME;
	const realSecretPathEnv = process.env.FLYWHEEL_DELIVERY_SECRET_PATH;
	const realCwd = process.cwd();
	let store: StateStore;
	let scratch: string;
	let fakeHome: string;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		scratch = mkdtempSync(join(tmpdir(), "fly1811-"));
		fakeHome = join(scratch, "home");
		mkdirSync(fakeHome, { recursive: true });
		process.env.HOME = fakeHome;
		delete process.env.FLYWHEEL_DELIVERY_SECRET_PATH;
		process.chdir(scratch);
	});

	afterEach(() => {
		try {
			store.close();
		} finally {
			try {
				process.chdir(realCwd);
			} finally {
				if (realHome === undefined) delete process.env.HOME;
				else process.env.HOME = realHome;
				if (realSecretPathEnv === undefined)
					delete process.env.FLYWHEEL_DELIVERY_SECRET_PATH;
				else process.env.FLYWHEEL_DELIVERY_SECRET_PATH = realSecretPathEnv;
				rmSync(scratch, { recursive: true, force: true });
			}
		}
	});

	it("provisions under $HOME/.flywheel, not a literal ~ directory", () => {
		const active = new FileDeliverySecretProvider({ store }).getActive();
		expect(active.secretId).toBeTruthy();

		const expected = join(fakeHome, ".flywheel", "delivery-secret");
		// Versions are stored as `<secretPath>.<secretId>`, so the resolved base
		// path is observable without reaching into privates.
		expect(existsSync(`${expected}.${active.secretId}`)).toBe(true);
		expect(existsSync(join(process.cwd(), "~"))).toBe(false);
	});
});
