import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("rejects an unpinned Chromium archive before writing output", () => {
	const dir = mkdtempSync(`${realpathSync(tmpdir())}/xhs-chromium-artifact-`);
	try {
		const archive = join(dir, "input.zip"),
			output = join(dir, "browser");
		writeFileSync(archive, "untrusted zip bytes");
		const script = fileURLToPath(
			new URL(
				"../../../../../scripts/xhs/materialize-chromium.py",
				import.meta.url,
			),
		);
		const child = spawnSync(
			"python3",
			[script, "--archive", archive, "--output-dir", output],
			{ encoding: "utf8", timeout: 10000 },
		);
		expect(child.status).toBe(1);
		expect(child.stderr).toBe("chromium_artifact_unavailable\n");
		expect(existsSync(output)).toBe(false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
