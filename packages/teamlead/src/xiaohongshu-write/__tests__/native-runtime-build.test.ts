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

it("refuses unpinned native inputs before creating an artifact", () => {
	const dir = mkdtempSync(`${realpathSync(tmpdir())}/xhs-pinned-runtime-`);
	try {
		for (const name of ["node", "better_sqlite3.node", "LICENSE"])
			writeFileSync(join(dir, name), "untrusted");
		const script = fileURLToPath(
			new URL(
				"../../../../../scripts/xhs/build-native-runtime.ts",
				import.meta.url,
			),
		);
		const output = join(dir, "output");
		const child = spawnSync(
			process.execPath,
			["--import", "tsx", script, "--assets", dir, "--output-dir", output],
			{ encoding: "utf8", timeout: 30000 },
		);
		expect(child.status).toBe(1);
		expect(child.stderr).toBe("offline_native_runtime_unavailable\n");
		expect(existsSync(output)).toBe(false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
