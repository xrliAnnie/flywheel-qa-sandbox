import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	reportFatalStartupFailure,
	reportStartupRefusal,
	VOICE_LOCK_UNAVAILABLE_BODY,
} from "../startup-alert.js";

describe("reportStartupRefusal", () => {
	it("uses the bounded meta-alert path and never throws", () => {
		const root = mkdtempSync(join(tmpdir(), "flywheel-voice-alert-"));
		const output = join(root, "alert-args");
		mkdirSync(join(root, "scripts", "lib"), { recursive: true });
		writeFileSync(
			join(root, "scripts", "lib", "bounded-run.sh"),
			`#!/bin/bash\nprintf '%s\\n' "$@" > "$TEST_OUTPUT"\n`,
		);
		chmodSync(join(root, "scripts", "lib", "bounded-run.sh"), 0o755);
		copyFileSync(
			join(
				process.cwd(),
				"..",
				"..",
				"scripts",
				"lib",
				"voice-health-startup-spool.py",
			),
			join(root, "scripts", "lib", "voice-health-startup-spool.py"),
		);
		const home = join(root, "home");
		mkdirSync(home);

		expect(() =>
			reportStartupRefusal(
				{
					reason: "voice_process_lock_conflict",
					title: "Voice process lock unavailable",
					body: "another daemon owns the lock",
				},
				{
					FLYWHEEL_DIR: root,
					FLYWHEEL_META_ALERT_BIN: join(root, "meta-alert.sh"),
					HOME: home,
					TEST_OUTPUT: output,
				},
			),
		).not.toThrow();
		expect(readFileSync(output, "utf8").trim().split("\n")).toEqual([
			"15",
			join(root, "meta-alert.sh"),
			"voice_process_lock_conflict",
			"Voice process lock unavailable",
			"another daemon owns the lock",
		]);
		const spoolFiles = readdirSync(
			join(home, ".flywheel", "voice-startup-spool"),
		);
		expect(spoolFiles).toHaveLength(1);
		expect(
			JSON.parse(
				readFileSync(
					join(home, ".flywheel", "voice-startup-spool", spoolFiles[0]!),
					"utf8",
				),
			),
		).toMatchObject({
			reasonClass: "startup_lock_unavailable",
			operation: "startup",
		});

		expect(() =>
			reportStartupRefusal(
				{ reason: "voice_process_lock_unavailable", title: "bad", body: "bad" },
				{ FLYWHEEL_DIR: join(root, "missing") },
			),
		).not.toThrow();
	});
});

describe("closed startup diagnostics", () => {
	it("never includes raw lock or fatal error text and spools the closed class", () => {
		const secret = "token-secret /private/voice.lock";
		const root = mkdtempSync(join(tmpdir(), "flywheel-voice-fatal-"));
		const home = join(root, "home");
		mkdirSync(join(root, "scripts", "lib"), { recursive: true });
		mkdirSync(home);
		copyFileSync(
			join(
				process.cwd(),
				"..",
				"..",
				"scripts",
				"lib",
				"voice-health-startup-spool.py",
			),
			join(root, "scripts", "lib", "voice-health-startup-spool.py"),
		);
		expect(VOICE_LOCK_UNAVAILABLE_BODY).not.toContain(secret);
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			reportFatalStartupFailure(new Error(secret), {
				FLYWHEEL_DIR: root,
				HOME: home,
			});
			expect(log).toHaveBeenCalledWith(
				"[voice] fatal reasonClass=startup_not_ready operation=startup",
			);
			expect(log.mock.calls.flat().join(" ")).not.toContain(secret);
			const files = readdirSync(join(home, ".flywheel", "voice-startup-spool"));
			expect(files).toHaveLength(1);
			expect(
				JSON.parse(
					readFileSync(
						join(home, ".flywheel", "voice-startup-spool", files[0]!),
						"utf8",
					),
				),
			).toMatchObject({ reasonClass: "startup_not_ready" });
		} finally {
			log.mockRestore();
		}
	});
});
