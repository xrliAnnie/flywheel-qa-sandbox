import { FEATURE_FLAGS } from "flywheel-config";
import { describe, expect, it } from "vitest";
import * as FlagToggle from "../bridge/flag-toggle.js";
import { isDirectToggleable } from "../bridge/flag-toggle.js";

describe("isDirectToggleable", () => {
	it("keeps store-backed call-time metadata direct and removes retired entries", () => {
		const direct = FEATURE_FLAGS.find((f) => f.name === "loop_profiler");
		expect(isDirectToggleable(direct as never)).toBe(true);
		for (const name of [
			"founder_review_orphan_monitor",
			"mailbox_queue",
			"lead_lease_bypass",
			"voice_qa_presence_override",
		]) {
			expect(
				FEATURE_FLAGS.some((flag) => flag.name === name),
				name,
			).toBe(false);
		}
	});

	it("rejects non-boolean value flags even if later marked direct", () => {
		const direct = FEATURE_FLAGS.find((f) => f.name === "loop_profiler")!;
		expect(isDirectToggleable({ ...direct, valueKind: "value" } as never)).toBe(
			false,
		);
	});
});

describe("retired env writer", () => {
	it("does not export an env toggle apply path", () => {
		expect(Reflect.get(FlagToggle, "applyFlagToggle")).toBeUndefined();
	});
});
