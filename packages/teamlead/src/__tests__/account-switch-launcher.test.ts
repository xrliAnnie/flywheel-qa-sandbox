import { spawnSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LAUNCHER = join(PACKAGE_ROOT, "bin", "flywheel-claude-switch");

let scratch: string | undefined;

afterEach(() => {
	if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
	scratch = undefined;
});

describe("flywheel-claude-switch launcher", () => {
	it("is registered as a package bin and loads the built runtime without state access", () => {
		const manifest = JSON.parse(
			readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"),
		) as { bin?: Record<string, string> };
		expect(manifest.bin?.["flywheel-claude-switch"]).toBe(
			"bin/flywheel-claude-switch",
		);

		const result = spawnSync(LAUNCHER, ["--runtime-check"], {
			encoding: "utf8",
			env: {
				PATH: process.env.PATH,
				HOME: join(tmpdir(), "flywheel-switch-runtime-check-no-home"),
				FLYWHEEL_STATE_DIR: join(
					tmpdir(),
					"flywheel-switch-runtime-check-no-state",
				),
			},
		});
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("FLYWHEEL_ATOMIC_SWITCH_RUNTIME_OK");
	});

	it("fails closed with a stable recovery marker when dist is unavailable", () => {
		scratch = mkdtempSync(join(tmpdir(), "flywheel-switch-launcher-"));
		const copiedLauncher = join(
			scratch,
			"packages",
			"teamlead",
			"bin",
			"flywheel-claude-switch",
		);
		mkdirSync(dirname(copiedLauncher), { recursive: true });
		cpSync(LAUNCHER, copiedLauncher);
		chmodSync(copiedLauncher, 0o755);

		const result = spawnSync(copiedLauncher, ["use", "school"], {
			encoding: "utf8",
			env: { PATH: process.env.PATH },
		});
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain(
			"FLYWHEEL_ATOMIC_SWITCH_RUNTIME_UNAVAILABLE",
		);
		expect(result.stderr).toContain("pnpm --filter flywheel-teamlead build");
	});
});
