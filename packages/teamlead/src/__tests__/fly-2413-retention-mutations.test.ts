import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("kills all four disabled retention guards in isolated module trees", () => {
	const result = spawnSync(
		process.execPath,
		[
			"--test",
			fileURLToPath(
				new URL(
					"../../../../scripts/__tests__/fly-2413-retention-mutations.test.mjs",
					import.meta.url,
				),
			),
		],
		{ encoding: "utf8", timeout: 60_000 },
	);
	expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}, 65_000);
