import { expect, it, vi } from "vitest";
import {
	CodexQuotaAvailability,
	formatCodexQuotaManualReason,
} from "../availability.js";

const ready = { ready: true, failures: [] } as const;
const missing = {
	ready: false,
	failures: [{ reason: "readiness_receipt_missing" as const }],
};

it("starts manual and records the exact receipt failure while automation is disabled", async () => {
	const check = vi.fn(async () => missing);
	const availability = new CodexQuotaAvailability({
		enabled: () => false,
		runtimeAvailable: () => true,
		check,
	});

	expect(availability.snapshot()).toEqual({
		mode: "manual",
		reasons: ["readiness_unchecked"],
		revision: 0,
		checkedAt: null,
	});
	expect(await availability.refresh()).toMatchObject({
		mode: "manual",
		reasons: ["readiness_receipt_missing", "flag_disabled"],
		revision: 1,
	});
	expect(check).toHaveBeenCalledOnce();
	expect(formatCodexQuotaManualReason("readiness_receipt_missing")).toBe(
		"readiness-receipt 不存在",
	);
});

it("distinguishes a founder-disabled switch from an unverified receipt", async () => {
	const availability = new CodexQuotaAvailability({
		enabled: () => false,
		runtimeAvailable: () => true,
		check: async () => ready,
	});
	expect(await availability.refresh()).toMatchObject({
		mode: "manual",
		reasons: ["flag_disabled"],
	});
});

it("requires both readiness and a constructed runtime before automatic mode", async () => {
	let runtimeAvailable = false;
	const availability = new CodexQuotaAvailability({
		enabled: () => true,
		runtimeAvailable: () => runtimeAvailable,
		check: async () => ready,
	});
	expect(await availability.refresh()).toMatchObject({
		mode: "manual",
		reasons: ["runtime_unavailable"],
	});
	runtimeAvailable = true;
	expect(await availability.refresh()).toMatchObject({
		mode: "automatic",
		reasons: [],
		revision: 2,
	});
});

it("rechecks the switch after asynchronous readiness and discards a stale success", async () => {
	let enabled = true;
	let resolve!: (value: typeof ready) => void;
	const check = vi.fn(
		() =>
			new Promise<typeof ready>((done) => {
				resolve = done;
			}),
	);
	const availability = new CodexQuotaAvailability({
		enabled: () => enabled,
		runtimeAvailable: () => true,
		check,
	});
	const first = availability.refresh();
	const joined = availability.refresh();
	enabled = false;
	resolve(ready);
	expect(await first).toMatchObject({
		mode: "manual",
		reasons: ["flag_disabled"],
	});
	expect(await joined).toEqual(await first);
	expect(check).toHaveBeenCalledOnce();
});
