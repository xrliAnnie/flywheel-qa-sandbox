import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const entry = fileURLToPath(new URL("../authority-main.ts", import.meta.url));
it("rejects unsupported startup arguments without opening authority state", () => {
	const result = spawnSync(
		process.execPath,
		[
			"--import",
			createRequire(import.meta.url).resolve("tsx"),
			entry,
			"--config",
			"/private/policy",
			"--enabled",
		],
		{ encoding: "utf8", timeout: 10000 },
	);
	expect(result.status, result.stderr).toBe(2);
	expect(result.stderr).toBe("authority_arguments_invalid\n");
});
