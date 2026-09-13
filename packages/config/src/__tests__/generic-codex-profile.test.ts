import { expect, it } from "vitest";
import { resolveGenericCodexProfile } from "../codex-lead-capabilities.js";

it("uses the existing generic TUI full-access default", () => {
	expect(resolveGenericCodexProfile()).toBe("full-access");
	expect(resolveGenericCodexProfile("full-access")).toBe("full-access");
});
it.each(["companion", "write-capable", "", "unknown"])(
	"rejects unsupported generic profile %s without fallback",
	(profile) => {
		expect(() => resolveGenericCodexProfile(profile)).toThrow("full-access");
	},
);
