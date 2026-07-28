import { describe, expect, it, vi } from "vitest";
import type { InjectionShim } from "../types.js";

describe("frozen InjectionShim type shape", () => {
	it("retains exactly hint and deliver while the engine never invokes either", async () => {
		const shim: InjectionShim = {
			hint: vi.fn(async () => undefined),
			deliver: vi.fn(async () => undefined),
		};
		expect(Object.keys(shim).sort()).toEqual(["deliver", "hint"]);
		await shim.hint("opaque://session");
		await shim.deliver("opaque://session", {
			messageUid: "m1",
			payload: "{}",
			attemptUid: "m1#1",
		});
		expect(shim.hint).toHaveBeenCalledOnce();
		expect(shim.deliver).toHaveBeenCalledOnce();
	});
});
