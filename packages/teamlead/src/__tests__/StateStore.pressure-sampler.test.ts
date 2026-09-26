import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

describe("pressure sampler durable evidence", () => {
	it("round-trips the original boot deadline independently of invalid cache JSON across restart", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly2920-cache-"));
		const path = join(dir, "test.db");
		let store = await StateStore.create(path);
		try {
			expect(store.getPressureSamplerState()).toBeUndefined();
			store.setPressureSamplerState({
				hostBootId: "boot",
				warmupUntilMs: 60_000,
				cacheJson: "invalid JSON",
			});
			store.close();
			store = await StateStore.create(path);
			expect(store.getPressureSamplerState()).toEqual({
				hostBootId: "boot",
				warmupUntilMs: 60_000,
				cacheJson: "invalid JSON",
			});
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("removes legacy sensor rows on migration while preserving manual rows; compatible reads ignore later sensor rows", async () => {
		const store = await StateStore.create(":memory:");
		try {
			store.setFleetPressureHold({ setBy: "swap-sensor" });
			expect(store.getManualFleetPressureHold()).toBeUndefined();
			store.migrate();
			expect(store.getFleetPressureHold()).toBeUndefined();
			store.setFleetPressureHold({
				setBy: "operator",
				watermark: "manual reason",
			});
			store.migrate();
			expect(store.getManualFleetPressureHold()).toMatchObject({
				set_by: "operator",
				watermark: "manual reason",
			});
		} finally {
			store.close();
		}
	});
});
