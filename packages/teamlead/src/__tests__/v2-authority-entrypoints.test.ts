import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = fileURLToPath(new URL("../", import.meta.url));

describe("legacy writer entrypoint authority fence", () => {
	it.each([
		"index.ts",
		"lead-backends/codex/codex-lead-runtime.ts",
		"lead-backends/codex/codex-lead-tui-runtime.ts",
		"lead-backends/codex/gateway/gateway-main.ts",
	])("%s checks machine authority before starting", (relativePath) => {
		const source = readFileSync(`${SOURCE_ROOT}/${relativePath}`, "utf8");
		expect(source).toContain("requireLegacyWriterAllowedFromEnvironment");
	});

	it("keeps the v2-only Discord ingress outside the legacy writer guard", () => {
		const source = readFileSync(`${SOURCE_ROOT}/v2-discord-ingress.ts`, "utf8");
		expect(source).not.toContain("requireLegacyWriterAllowedFromEnvironment");
		expect(source).toContain("new V2DiscordIngress");
	});
});
