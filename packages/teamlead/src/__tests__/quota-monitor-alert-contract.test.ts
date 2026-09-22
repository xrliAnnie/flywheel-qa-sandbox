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
const sqliteAvailable = spawnSync("sqlite3", ["--version"]).status === 0;

describe("FLY-1256 shell alert rendering", () => {
	let root: string | undefined;

	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
		root = undefined;
	});

	function send(
		kind: string,
		signature: string,
		opts: {
			plain?: boolean;
			body?: string;
			title?: string;
			mentionUser?: string;
			accountsPageFailure?: boolean;
			accountsPageTimeout?: boolean;
		} = {},
	): string {
		root ??= mkdtempSync(join(tmpdir(), "fly1256-alert-"));
		const bin = join(root, "bin");
		const capture = join(root, `body-${signature}.json`);
		const accountsPageCli = join(root, "accounts-page-cli.mjs");
		mkdirSync(bin, { recursive: true });
		writeFileSync(
			accountsPageCli,
			[
				'const timeoutIndex = process.argv.indexOf("--timeout-ms");',
				'if (timeoutIndex < 0 || process.argv[timeoutIndex + 1] !== "5000") {',
				'  console.error("accounts-page: missing bounded timeout");',
				"  process.exit(1);",
				"}",
				'if (process.env.ACCOUNTS_PAGE_MODE === "failure") {',
				'  console.error("accounts-page: Bridge returned 503");',
				"  process.exit(1);",
				"}",
				'if (process.env.ACCOUNTS_PAGE_MODE === "timeout") {',
				'  console.error("publish request failed: operation aborted due to timeout");',
				"  process.exit(1);",
				"}",
				'console.log(JSON.stringify({ url: "https://reports.example/r/account-page/", reportId: "account-page", delivered: false, publishOnly: true }));',
			].join("\n"),
		);
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

		const args = [
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
			opts.title ?? "quota event",
			"--body",
			opts.body ?? "details",
			"--signature",
			signature,
		];
		if (opts.plain) args.push("--plain-message");
		if (opts.mentionUser) args.push("--mention-user", opts.mentionUser);
		const result = spawnSync("bash", args, {
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
				FLYWHEEL_COMM_CLI: accountsPageCli,
				ACCOUNTS_PAGE_MODE: opts.accountsPageTimeout
					? "timeout"
					: opts.accountsPageFailure
						? "failure"
						: "success",
			},
			encoding: "utf-8",
		});
		expect(result.status, result.stderr).toBe(0);
		return JSON.parse(readFileSync(capture, "utf-8")).content as string;
	}

	it("renders a switch-family notification as the exact ordinary message body", () => {
		const founder = "1".repeat(18);
		const body = [
			"Claude 已自动切号：**shopping → school**",
			"",
			"原账号 **shopping**",
			"shopping@example.com",
		].join("\n");
		const content = send("account_switched", "plain-switch", {
			plain: true,
			body,
			title: "must never render",
			mentionUser: founder,
		});

		expect(content).toBe(
			`<@${founder}> ${body}\n\n账号页：https://reports.example/r/account-page/`,
		);
		expect(content).not.toMatch(/ℹ️|🚨|quota-monitor|account_switched/);
	});

	it("keeps the switch notification when account-page publication fails", () => {
		const content = send("account_switched", "page-failed-switch", {
			plain: true,
			body: "Claude 已切号：**shopping → school**",
			accountsPageFailure: true,
		});

		expect(content).toContain("Claude 已切号：**shopping → school**");
		expect(content).toContain(
			"账号页本次未生成：accounts-page: Bridge returned 503",
		);
	});

	it("labels an account-page deadline without delaying the switch notification", () => {
		const content = send("account_switched", "page-timeout-switch", {
			plain: true,
			body: "Claude 已切号：**shopping → school**",
			accountsPageTimeout: true,
		});

		expect(content).toContain("Claude 已切号：**shopping → school**");
		expect(content).toContain("账号页本次未生成：timeout");
	});

	it.skipIf(!sqliteAvailable)(
		"publishes the account page once when the same switch event is replayed",
		() => {
			root = mkdtempSync(join(tmpdir(), "fly2688-switch-dedup-"));
			const bin = join(root, "bin");
			const capture = join(root, "discord.json");
			const publishCalls = join(root, "publish-calls.txt");
			const accountsPageCli = join(root, "accounts-page-cli.mjs");
			mkdirSync(bin, { recursive: true });
			writeFileSync(
				join(bin, "curl"),
				'#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "-d" ]; then printf \'%s\' "$2" > "$CAPTURE"; shift 2; else shift; fi\ndone\nprintf \'200\'\n',
				{ mode: 0o755 },
			);
			writeFileSync(
				accountsPageCli,
				[
					'import { appendFileSync } from "node:fs";',
					'appendFileSync(process.env.PUBLISH_CALLS, process.argv.slice(2).join(" ") + "\\n");',
					'console.log(JSON.stringify({ url: "https://reports.example/r/once/", reportId: "once", delivered: false, publishOnly: true }));',
				].join("\n"),
			);
			const args = [
				script,
				"--lead",
				"quota-monitor",
				"--project",
				"flywheel",
				"--kind",
				"account_switched",
				"--severity",
				"info",
				"--title",
				"Claude account switched",
				"--body",
				"Claude 已切号：**shopping → school**",
				"--signature",
				"account-switch-g17",
				"--plain-message",
				"--strict-delivery",
			];
			const env = {
				...process.env,
				PATH: `${bin}:${process.env.PATH ?? ""}`,
				HOME: root,
				CAPTURE: capture,
				PUBLISH_CALLS: publishCalls,
				FLYWHEEL_STATE_DIR: join(root, "state"),
				FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID: "quota-channel",
				FLYWHEEL_ALERT_SENDER_TOKEN_ENV: "QUOTA_TEST_TOKEN",
				QUOTA_TEST_TOKEN: "not-a-real-token",
				FLYWHEEL_CLAIMS_DB: join(root, "claims.db"),
				FLYWHEEL_ALERT_QUEUE_DIR: join(root, "queue"),
				FLYWHEEL_ALERT_DEADLETTER_DIR: join(root, "deadletter"),
				FLYWHEEL_COMM_CLI: accountsPageCli,
			};

			const first = spawnSync("bash", args, { env, encoding: "utf-8" });
			const replay = spawnSync("bash", args, { env, encoding: "utf-8" });
			expect(first.status, first.stderr).toBe(0);
			expect(replay.status, replay.stderr).toBe(0);
			expect(readFileSync(publishCalls, "utf-8").trim().split("\n")).toEqual([
				"accounts-page --project flywheel --publish-only --timeout-ms 5000",
			]);
			expect(JSON.parse(readFileSync(capture, "utf-8")).content).toContain(
				"账号页：https://reports.example/r/once/",
			);
		},
	);

	it("refuses the plain-message override for a non-switch alert kind", () => {
		expect(() =>
			send("quota_no_target", "plain-non-switch", { plain: true }),
		).toThrow();
	});

	it("refuses the plain-message override for account_dead", () => {
		expect(() =>
			send("account_dead", "plain-account-dead", { plain: true }),
		).toThrow();
	});

	it.each([
		"account_switched",
		"model_cap_switched",
		"model_cap_unknown",
		"quota_switch_confirmation",
	])("%s posts a root message without a ticket header", (kind) => {
		expect(send(kind, `info-${kind}`)).not.toContain("🎫");
	});

	it.each([
		"account_dead",
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
