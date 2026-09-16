import { expect, it } from "vitest";
import { StateStore } from "../../StateStore.js";
import { customerReleaseAutoEnabled } from "../customer-release/runtime.js";
import { initializeFlagStore } from "../flag-store-runtime.js";

it("defaults customer auto release off and observes project on/off writes without restart", async () => {
	const state = await StateStore.create(":memory:");
	try {
		const runtime = initializeFlagStore(state, {});
		expect(customerReleaseAutoEnabled(runtime, "flywheel")).toBe(false);
		for (const rawTo of ["1", "0"]) {
			expect(
				state.applyScopedFlagValueChange({
					name: "auto_release_on_silence_enabled",
					scope: "flywheel",
					op: "set",
					rawTo,
					expectedChangeSeq: state.getFlagValueChangeSeq(
						"auto_release_on_silence_enabled",
						"flywheel",
					),
					actor: "fixture",
					reason: "test switch",
				}),
			).toMatchObject({ ok: true });
			expect(customerReleaseAutoEnabled(runtime, "flywheel")).toBe(
				rawTo === "1",
			);
		}
		expect(customerReleaseAutoEnabled(runtime, "other-project")).toBe(false);
	} finally {
		state.close();
	}
});
