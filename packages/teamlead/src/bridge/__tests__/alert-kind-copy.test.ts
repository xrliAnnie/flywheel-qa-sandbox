import { describe, expect, it } from "vitest";
import { bodyFor, titleFor } from "../alert-kind-copy.js";

describe("alert kind copy", () => {
	it("describes Discord plugin integrity failures with recovery guidance", () => {
		expect(titleFor("discord_plugin_integrity_failed")).toBe(
			"Discord plugin fork integrity failed",
		);
		expect(bodyFor("discord_plugin_integrity_failed", "ignored")).toBe(
			"A Lead could not prove the configured Discord plugin came from the Flywheel fork at the expected remote SHA. Keep that Lead stopped, repair the pointer install, then rerun the integrity check before restarting it.",
		);
	});
});
