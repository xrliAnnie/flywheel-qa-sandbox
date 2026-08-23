import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("teamlead incremental build output hygiene", () => {
	it("removes every retired auto-QA artifact family before incremental build", () => {
		const packagePath = fileURLToPath(
			new URL("../../../package.json", import.meta.url),
		);
		const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as {
			scripts: { prebuild?: string; build: string };
		};

		const cleanup = `${packageJson.scripts.prebuild ?? ""} ${packageJson.scripts.build}`;
		for (const retired of [
			"auto-qa-held",
			"auto-qa-config-source",
			"auto-qa-coordinator",
			"auto-qa-effects",
			"auto-qa-policy",
			"manual-qa-routes",
			"ship-gate-rebind",
			"founder-milestone-config-source",
			"milestone-report-policy",
			"checkpoint-park",
		]) {
			expect(cleanup).toContain(`dist/bridge/${retired}.*`);
		}
		expect(cleanup).toContain("dist/bridge/__tests__/checkpoint-park.test.*");
	});
});
