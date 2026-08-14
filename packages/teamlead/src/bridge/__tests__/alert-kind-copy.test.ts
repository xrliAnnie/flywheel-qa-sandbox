import { describe, expect, it } from "vitest";
import { bodyFor, titleFor } from "../alert-kind-copy.js";

describe("alert kind copy", () => {
	it("describes A0B1 using exact-ref and topology semantics", () => {
		expect(titleFor("cmux_flag_state")).toBe("cmux A0B1 topology transition");
		expect(bodyFor("cmux_flag_state", "ignored")).toBe(
			"cmux-sync entered A0B1. Exact-ref receipts remain mandatory; use the event evidence to distinguish strict-independent from grouped-rollback topology. The durable transition notice is informational; convergence remains enabled.",
		);
	});

	it("describes Discord plugin integrity failures with recovery guidance", () => {
		expect(titleFor("discord_plugin_integrity_failed")).toBe(
			"Discord plugin fork integrity failed",
		);
		expect(bodyFor("discord_plugin_integrity_failed", "ignored")).toBe(
			"A Lead could not prove the configured Discord plugin came from the Flywheel fork at the expected remote SHA. Keep that Lead stopped, repair the pointer install, then rerun the integrity check before restarting it.",
		);
	});
});
