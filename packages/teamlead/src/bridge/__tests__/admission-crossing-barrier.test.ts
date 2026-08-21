import { describe, expect, it } from "vitest";
import { AdmissionCrossingBarrier } from "../admission-crossing-barrier.js";

describe("FLY-1944 admission crossing barrier", () => {
	it("counts both dispatcher entry lanes until their synchronous release", () => {
		const barrier = new AdmissionCrossingBarrier();
		const releaseStart = barrier.enter("start");
		const releaseRetry = barrier.enter("dispatch");
		expect(barrier.snapshot()).toEqual({ start: 1, dispatch: 1, total: 2 });

		releaseStart();
		releaseStart();
		expect(barrier.snapshot()).toEqual({ start: 0, dispatch: 1, total: 1 });

		releaseRetry();
		expect(barrier.snapshot()).toEqual({ start: 0, dispatch: 0, total: 0 });
	});
});
