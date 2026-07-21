import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const alertScript = join(here, "../../../../scripts/lead-alert.sh");

describe("FLY-1402 legacy rules-bundle alert", () => {
	let fixtureDir: string | undefined;

	afterEach(() => {
		if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
		fixtureDir = undefined;
	});

	it("accepts the kind and delivers a complete warning payload", () => {
		fixtureDir = mkdtempSync(join(tmpdir(), "fly1402-legacy-alert-"));
		const binDir = join(fixtureDir, "bin");
		const capture = join(fixtureDir, "payload.json");
		mkdirSync(binDir);
		writeFileSync(
			join(binDir, "sqlite3"),
			[
				"#!/bin/sh",
				"sql=$(cat)",
				'if printf \'%s\' "$sql" | grep -q "SELECT state ||"; then',
				"  token=$(printf '%s' \"$sql\" | sed -n \"s/.*lease_token='\\([^']*\\)'.*/\\1/p\" | head -n 1)",
				"  printf 'leased|%s\\n' \"$token\"",
				"else",
				"  printf '1\\n'",
				"fi",
				"",
			].join("\n"),
			{ mode: 0o755 },
		);
		writeFileSync(
			join(binDir, "curl"),
			'#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "-d" ]; then printf \'%s\' "$2" > "$CAPTURE"; shift 2; else shift; fi\ndone\nprintf \'200\'\n',
			{ mode: 0o755 },
		);

		const result = spawnSync(
			"bash",
			[
				alertScript,
				"--lead",
				"tadashi",
				"--project",
				"flywheel",
				"--kind",
				"rules_bundle_legacy",
				"--severity",
				"warning",
				"--title",
				"Lead rules bundle legacy mode",
				"--body",
				"flywheel/tadashi launched with last-one-wins rule loading.",
				"--signature",
				"fly1402-generation",
				"--strict-delivery",
			],
			{
				encoding: "utf8",
				env: {
					...process.env,
					PATH: `${binDir}:${process.env.PATH ?? ""}`,
					HOME: fixtureDir,
					CAPTURE: capture,
					FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID: "rules-alert-channel",
					FLYWHEEL_ALERT_SENDER_TOKEN_ENV: "RULES_ALERT_TOKEN",
					RULES_ALERT_TOKEN: "not-a-real-token",
					FLYWHEEL_CLAIMS_DB: join(fixtureDir, "claims.db"),
					FLYWHEEL_ALERT_QUEUE_DIR: join(fixtureDir, "queue"),
					FLYWHEEL_ALERT_DEADLETTER_DIR: join(fixtureDir, "deadletter"),
				},
			},
		);

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toBe("sent\n");
		const content = JSON.parse(readFileSync(capture, "utf8")).content as string;
		expect(content).toContain("Lead rules bundle legacy mode");
		expect(content).toContain(
			"flywheel/tadashi launched with last-one-wins rule loading.",
		);
	});
});
