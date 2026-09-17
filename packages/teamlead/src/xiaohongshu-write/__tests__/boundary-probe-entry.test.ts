import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("the actual probe process refuses missing options, production paths and user-owned fixtures", () => {
	const root = realpathSync(mkdtempSync("/tmp/xhs-probe-entry-"));
	try {
		for (const args of [
			[],
			["--probe", "file-authority", "--fixture", "/var/db/flywheel-xhs"],
			["--probe", "file-authority", "--fixture", root],
			["--probe", "headless-service", "--fixture", root],
		]) {
			const child = spawnSync(
				process.execPath,
				[
					"--import",
					"tsx",
					fileURLToPath(new URL("../boundary-probe-entry.ts", import.meta.url)),
					...args,
				],
				{ encoding: "utf8", timeout: 10000, maxBuffer: 4096 },
			);
			expect(child.status).toBe(1);
			expect(child.stdout).toBe("");
			expect(child.stderr).toBe("boundary_probe_unavailable\n");
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
