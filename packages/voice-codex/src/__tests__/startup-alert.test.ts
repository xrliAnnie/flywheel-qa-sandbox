import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { reportStartupRefusal } from "../startup-alert.js";

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

		expect(() =>
			reportStartupRefusal(
				{ reason: "voice_process_lock_unavailable", title: "bad", body: "bad" },
				{ FLYWHEEL_DIR: join(root, "missing") },
			),
		).not.toThrow();
	});
});
