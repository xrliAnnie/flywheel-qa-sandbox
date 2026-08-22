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
const script = join(here, "../../../../scripts/lead-alert.sh");

describe("FLY-1256 shell alert rendering", () => {
	let root: string | undefined;

	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
		root = undefined;
	});

	function send(kind: string, signature: string): string {
		root ??= mkdtempSync(join(tmpdir(), "fly1256-alert-"));
		const bin = join(root, "bin");
		const capture = join(root, `body-${signature}.json`);
		mkdirSync(bin, { recursive: true });
		writeFileSync(
			join(bin, "sqlite3"),
			"#!/bin/sh\ncat >/dev/null\nprintf '1\\n'\n",
			{ mode: 0o755 },
		);
		writeFileSync(
			join(bin, "curl"),
			'#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "-d" ]; then printf \'%s\' "$2" > "$CAPTURE"; shift 2; else shift; fi\ndone\nprintf \'200\'\n',
			{ mode: 0o755 },
		);

		const result = spawnSync(
			"bash",
			[
				script,
				"--lead",
				"quota-monitor",
				"--project",
				"flywheel",
				"--kind",
				kind,
				"--severity",
				"info",
				"--title",
				"quota event",
				"--body",
				"details",
				"--signature",
				signature,
			],
			{
				env: {
					...process.env,
					PATH: `${bin}:${process.env.PATH ?? ""}`,
					HOME: root,
					CAPTURE: capture,
					FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID: "quota-channel",
					FLYWHEEL_ALERT_SENDER_TOKEN_ENV: "QUOTA_TEST_TOKEN",
					QUOTA_TEST_TOKEN: "not-a-real-token",
					FLYWHEEL_CLAIMS_DB: join(root, "claims.db"),
					FLYWHEEL_ALERT_QUEUE_DIR: join(root, "queue"),
					FLYWHEEL_ALERT_DEADLETTER_DIR: join(root, "deadletter"),
				},
				encoding: "utf-8",
			},
		);
		expect(result.status, result.stderr).toBe(0);
		return JSON.parse(readFileSync(capture, "utf-8")).content as string;
	}

	it.each([
		"account_switched",
		"model_cap_switched",
		"model_cap_unknown",
		"quota_switch_confirmation",
	])("%s posts a root message without a ticket header", (kind) => {
		expect(send(kind, `info-${kind}`)).not.toContain("🎫");
	});

	it.each([
		"machine_account_conflict",
		"model_cap_persistent_unknown",
		"model_bench_malformed",
		"quota_choice",
		"quota_no_target",
	])("actionable %s keeps the normal ticket header", (kind) => {
		expect(send(kind, `actionable-${kind}`)).toContain("🎫");
	});

	it("quota_blocked_recovered posts a root message without a ticket header", () => {
		expect(send("quota_blocked_recovered", "recovered")).not.toContain("🎫");
	});

	it("non-informational quota alerts keep the normal ticket header", () => {
		expect(send("quota_no_target", "actionable")).toContain("🎫");
	});

	it("identity mismatch is allowlisted and keeps the actionable ticket header", () => {
		expect(send("account_identity_mismatch", "identity-actionable")).toContain(
			"🎫",
		);
	});

	it("quota guard bypass is allowlisted and keeps the actionable ticket header", () => {
		expect(send("quota_guard_bypassed", "bypass-audit")).toContain("🎫");
	});
});
