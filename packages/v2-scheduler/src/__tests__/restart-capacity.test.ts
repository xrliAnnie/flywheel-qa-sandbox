import { describe, expect, it } from "vitest";
import { RestartCapacity } from "../restart-capacity.js";

describe("restart capacity AIMD", () => {
	it("starts at one, decreases at most once per 2s, and never below one", () => {
		const capacity = new RestartCapacity({
			maxCapacity: 4,
			decreaseWindowMs: 2000,
			healthyIncreaseWindowMs: 180_000,
		});
		expect(capacity.current).toBe(1);
		expect(capacity.observeHealthy(0, true)).toBe(1);
		expect(capacity.observeHealthy(180_000, true)).toBe(2);
		expect(capacity.observeHealthy(360_000, true)).toBe(3);
		expect(capacity.observeHealthy(540_000, true)).toBe(4);
		expect(capacity.observePressure(600_000)).toBe(3);
		expect(capacity.observePressure(601_000)).toBe(3);
		expect(capacity.observePressure(602_000)).toBe(2);
		expect(capacity.observePressure(604_000)).toBe(1);
		expect(capacity.observePressure(606_000)).toBe(1);
	});

	it("adds one per quiet three-minute window up to the finite maximum", () => {
		const capacity = new RestartCapacity({
			maxCapacity: 3,
			decreaseWindowMs: 2000,
			healthyIncreaseWindowMs: 180_000,
		});
		expect(capacity.observeHealthy(0, true)).toBe(1);
		expect(capacity.observeHealthy(179_999, true)).toBe(1);
		expect(capacity.observeHealthy(180_000, true)).toBe(2);
		expect(capacity.observeHealthy(200_000, true)).toBe(2);
		expect(capacity.observeHealthy(360_000, true)).toBe(3);
		expect(capacity.observeHealthy(540_000, true)).toBe(3);
	});

	it("clamps capacity to one whenever memory is unknown or not proven healthy", () => {
		const capacity = new RestartCapacity({
			maxCapacity: 8,
			decreaseWindowMs: 2000,
			healthyIncreaseWindowMs: 180_000,
		});
		expect(capacity.observeHealthy(0, true)).toBe(1);
		expect(capacity.observeHealthy(180_000, true)).toBe(2);
		expect(capacity.observeHealthy(360_000, true)).toBe(3);
		expect(capacity.observeHealthy(360_001, false)).toBe(1);
	});
});
