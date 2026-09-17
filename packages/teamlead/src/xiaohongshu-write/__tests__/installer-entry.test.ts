import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("actual standalone entry rejects unprivileged/path-driven execution before runtime import", () => {
	const entry = fileURLToPath(
		new URL("../../../../../scripts/xhs/installer-entry.mjs", import.meta.url),
	);
	for (const extra of [[], ["--policy", "/tmp/untrusted"]]) {
		const result = spawnSync(process.execPath, [entry, ...extra], {
			encoding: "utf8",
			timeout: 2000,
		});
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("installed_fixture_unavailable\n");
	}
});
