import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { READINESS_WINDOW_MS } from "../release-readiness/evaluate.js";

it("loads the built evaluator without repository scripts in a packaged install", () => {
	const root = mkdtempSync(join(tmpdir(), "readiness-packaged-"));
	try {
		const pkg = join(root, "node_modules/flywheel-teamlead");
		const target = join(pkg, "dist/bridge/release-readiness/evaluate.js");
		mkdirSync(join(pkg, "dist/bridge/release-readiness"), { recursive: true });
		writeFileSync(join(pkg, "package.json"), '{"type":"module"}');
		copyFileSync(
			fileURLToPath(
				new URL(
					"../../../dist/bridge/release-readiness/evaluate.js",
					import.meta.url,
				),
			),
			target,
		);
		const output = execFileSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`const m = await import(${JSON.stringify(pathToFileURL(target).href)}); console.log(m.READINESS_WINDOW_MS);`,
			],
			{ encoding: "utf8", timeout: 5000 },
		);
		expect(Number(output.trim())).toBe(READINESS_WINDOW_MS);
		expect(READINESS_WINDOW_MS).toBe(14 * 24 * 60 * 60 * 1000);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
