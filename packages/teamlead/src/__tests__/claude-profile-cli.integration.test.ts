/**
 * FLY-852 (QA-caught self-deadlock) — the seam integration test that was
 * missing: switchAccount holding the REAL withMkdirLock while applyProfile
 * runs the REAL flywheel-claude-profile bash script (which takes the SAME
 * lock). Before the lock-delegation fix the child waited on its own parent
 * until timeout ("timeout acquiring lock") and the switch failed; both unit
 * suites were green because each side mocked the other.
 *
 * The security tool is still faked (state file + argv log) — no Keychain.
 * A short FLYWHEEL_CLAUDE_LOCK_TIMEOUT_MS makes a regression fail in ~2s.
 */
import { execFile } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readStore, writeStore } from "../account-heal/account-store.js";
import { makeClaudeProfileSwitchDeps } from "../account-heal/claude-profile-cli.js";
import { switchAccount } from "../account-heal/switch-executor.js";

const PROFILE_BIN = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"claude-runner",
	"bin",
	"flywheel-claude-profile",
);
const SWITCH_BIN = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"bin",
	"flywheel-claude-switch",
);
const execFileAsync = promisify(execFile);

const SECRET_A =
	'{"claudeAiOauth":{"accessToken":"sk-ant-oat01-INT-A","refreshToken":"rA"}}';
const SECRET_A_REFRESHED =
	'{"claudeAiOauth":{"accessToken":"sk-ant-oat01-INT-A-REFRESHED","refreshToken":"rAR"}}';
const SECRET_B =
	'{"claudeAiOauth":{"accessToken":"sk-ant-oat01-INT-B","refreshToken":"rB"}}';
const SECRET_C =
	'{"claudeAiOauth":{"accessToken":"sk-ant-oat01-INT-C","refreshToken":"rC"}}';

const STUB = `#!/usr/bin/env bash
set -u
printf '%s\\n' "$*" >> "$FAKE_SEC_ARGV_LOG"
case "\${1:-}" in
  find-generic-password)
    [[ -f "$FAKE_SEC_STATE" ]] || { echo "could not be found" >&2; exit 44; }
    cat "$FAKE_SEC_STATE"
    ;;
  -i)
    cmd=$(cat)
    val=$(printf '%s' "$cmd" | sed -n 's/.* -w \\([^ ]*\\).*/\\1/p')
    [[ -z "$val" ]] && exit 1
    printf '%s' "$val" > "$FAKE_SEC_STATE"
    ;;
  *) exit 2 ;;
esac
`;

const ENV_KEYS = [
	"FLYWHEEL_CLAUDE_PROFILES_DIR",
	"FLYWHEEL_CLAUDE_ACCOUNTS_LOCK",
	"FLYWHEEL_CLAUDE_ACCOUNTS_PATH",
	"FLYWHEEL_CLAUDE_TRANSITION_JOURNAL",
	"FLYWHEEL_CLAUDE_SECURITY_BIN",
	"FLYWHEEL_CLAUDE_KEYCHAIN_SERVICE",
	"FLYWHEEL_CLAUDE_KEYCHAIN_ACCOUNT",
	"FLYWHEEL_CLAUDE_LOCK_TIMEOUT_MS",
	// FLY-865 — isolate the identity write from the real ~/.claude.json.
	"FLYWHEEL_CLAUDE_JSON",
	"FLYWHEEL_CLAUDE_JSON_LOCK",
	"FAKE_SEC_STATE",
	"FAKE_SEC_ARGV_LOG",
	// FLY-871 — the real `use` now runs the freshness guard; inject a stub so the
	// real seam doesn't make a live OAuth call with dummy pool credentials.
	"FLYWHEEL_CLAUDE_FRESHNESS_BIN",
	"FLY" + "WHEEL_CLAUDE_FRESHNESS_BYPASS",
	"FLY" + "WHEEL_CLAUDE_QUOTA_BYPASS",
	// FLY-1182 — isolate identity probing + audit from real machine state.
	"FLYWHEEL_PROFILE_CURL_BIN",
	"FLYWHEEL_PROFILE_IDENTITY_ENDPOINT",
	"FLYWHEEL_PROFILE_AUDIT_LOG",
	"FAKE_IDENTITY_CURL_ARGV_LOG",
	// FLY-2240 — isolate the real public launcher, selector network probes, and
	// notification delivery used by the cross-process acceptance test below.
	"FLYWHEEL_CLAUDE_SWITCH_BIN",
	"FLYWHEEL_CLAUDE_PROFILE_BIN",
	"FLYWHEEL_CLAUDE_OAUTH_ENDPOINT",
	"FLYWHEEL_QUOTA_API_BASE",
	"FLYWHEEL_QUOTA_MONITOR_CONFIG",
	"FLYWHEEL_LEAD_ALERT_BIN",
	"FLYWHEEL_NOTIFY_CHANNEL",
	"FLYWHEEL_STATE_DIR",
	"PUBLIC_ALERT_LOG",
] as const;

// FLY-865: the target account's display identity, snapshotted in the pool.
const SCHOOL_IDENTITY = {
	accountUuid: "uuid-school",
	emailAddress: "school@example.com",
	organizationUuid: "org-school",
	organizationName: "School Org",
	displayName: "Scholar",
};
const PERSONAL_IDENTITY = {
	accountUuid: "uuid-personal",
	emailAddress: "personal@example.com",
	organizationUuid: "org-personal",
	organizationName: "Personal Org",
	displayName: "Personal",
};
const BUSINESS_IDENTITY = {
	accountUuid: "uuid-business",
	emailAddress: "business@example.com",
	organizationUuid: "org-business",
	organizationName: "Business Org",
	displayName: "Business",
};

interface ProbeAccount {
	refreshToken: string;
	accessToken: string;
	rotatedAccessToken: string;
	rotatedRefreshToken: string;
	fiveH: number;
	sevenD: number;
	fiveHResetAt: string | null;
	sevenDResetAt: string | null;
	fresh?: boolean;
	usageAvailable?: boolean;
}

async function startProbeServer(accounts: readonly ProbeAccount[]): Promise<{
	baseUrl: string;
	close: () => Promise<void>;
}> {
	const server = createServer((request, response) => {
		response.setHeader("content-type", "application/json");
		if (request.method === "POST" && request.url === "/oauth/token") {
			let raw = "";
			request.setEncoding("utf8");
			request.on("data", (chunk) => {
				raw += chunk;
			});
			request.on("end", () => {
				let refreshToken = "";
				try {
					refreshToken = String(
						(JSON.parse(raw) as { refresh_token?: unknown }).refresh_token ??
							"",
					);
				} catch {
					// malformed requests are refused below
				}
				const account = accounts.find(
					(candidate) =>
						candidate.refreshToken === refreshToken ||
						candidate.rotatedRefreshToken === refreshToken,
				);
				if (account === undefined || account.fresh === false) {
					response.statusCode = 400;
					response.end("{}");
					return;
				}
				response.end(
					JSON.stringify({
						access_token: account.rotatedAccessToken,
						refresh_token: account.rotatedRefreshToken,
						expires_in: 3600,
					}),
				);
			});
			return;
		}
		if (request.method === "GET" && request.url === "/api/oauth/usage") {
			const token =
				request.headers.authorization?.replace(/^Bearer /, "") ?? "";
			const account = accounts.find(
				(candidate) =>
					candidate.accessToken === token ||
					candidate.rotatedAccessToken === token,
			);
			if (account === undefined || account.usageAvailable === false) {
				response.statusCode = 503;
				response.end("{}");
				return;
			}
			response.end(
				JSON.stringify({
					five_hour: {
						utilization: account.fiveH,
						resets_at: account.fiveHResetAt,
					},
					seven_day: {
						utilization: account.sevenD,
						resets_at: account.sevenDResetAt,
					},
				}),
			);
			return;
		}
		response.statusCode = 404;
		response.end("{}");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("test probe server did not bind a TCP port");
	}
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		close: () =>
			new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			),
	};
}

let tmp: string;
let lockPath: string;
let storePath: string;
let claudeJson: string;
let saved: Record<string, string | undefined>;

function schoolProbe(overrides: Partial<ProbeAccount> = {}): ProbeAccount {
	return {
		refreshToken: "rB",
		accessToken: "sk-ant-oat01-INT-B",
		rotatedAccessToken: "sk-ant-oat01-INT-B-ROTATED",
		rotatedRefreshToken: "rB-rotated",
		fiveH: 12,
		sevenD: 34,
		fiveHResetAt: "2026-09-01T22:00:00.000Z",
		sevenDResetAt: "2026-09-03T20:00:00.000Z",
		...overrides,
	};
}

function configurePublicRuntime(
	baseUrl: string,
	opts: { notifyFromEnvFile?: boolean } = {},
): string {
	const alertLog = join(tmp, "public-alert.log");
	const alertBin = join(tmp, "fake-public-lead-alert");
	writeFileSync(
		alertBin,
		"#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$PUBLIC_ALERT_LOG\"\nprintf 'sent\\n'\n",
		{ mode: 0o755 },
	);
	writeFileSync(alertLog, "");
	process.env.FLYWHEEL_CLAUDE_SWITCH_BIN = SWITCH_BIN;
	process.env.FLYWHEEL_CLAUDE_PROFILE_BIN = PROFILE_BIN;
	process.env.FLYWHEEL_CLAUDE_OAUTH_ENDPOINT = `${baseUrl}/oauth/token`;
	process.env.FLYWHEEL_QUOTA_API_BASE = baseUrl;
	process.env.FLYWHEEL_QUOTA_MONITOR_CONFIG = join(tmp, "missing-config.json");
	process.env.FLYWHEEL_LEAD_ALERT_BIN = alertBin;
	process.env.FLYWHEEL_STATE_DIR = tmp;
	process.env.PUBLIC_ALERT_LOG = alertLog;
	if (opts.notifyFromEnvFile === true) {
		delete process.env.FLYWHEEL_NOTIFY_CHANNEL;
		writeFileSync(
			join(tmp, ".env"),
			"FLYWHEEL_NOTIFY_CHANNEL=notification-test\n",
		);
	} else {
		process.env.FLYWHEEL_NOTIFY_CHANNEL = "notification-test";
	}
	return alertLog;
}

function seedBusiness(): void {
	const pool = process.env.FLYWHEEL_CLAUDE_PROFILES_DIR as string;
	mkdirSync(join(pool, "business"), { recursive: true });
	writeFileSync(join(pool, "business", ".credentials.json"), SECRET_C, {
		mode: 0o600,
	});
	writeFileSync(
		join(pool, "business", "identity-anchor.json"),
		JSON.stringify({
			accountUuid: "uuid-business",
			email: "business@example.com",
			anchoredAt: "2026-07-16T00:00:00.000Z",
			anchoredBy: "test",
			confirmedBy: "test-evidence",
		}),
		{ mode: 0o600 },
	);
	writeFileSync(
		join(pool, "business", "oauthAccount.json"),
		JSON.stringify(BUSINESS_IDENTITY),
		{ mode: 0o600 },
	);
	const store = readStore(storePath);
	store.accounts.push({
		name: "business",
		quotaExhaustedUntil: null,
		weeklyResetAt: null,
	});
	writeStore(store, storePath);
}

async function runPublicSwitch(args: string[]): Promise<{
	stdout: string;
	stderr: string;
}> {
	return execFileAsync(PROFILE_BIN, args, {
		env: process.env,
		timeout: 25_000,
	});
}

async function runPublicSwitchFailure(args: string[]): Promise<{
	code: number | string | undefined;
	stdout: string;
	stderr: string;
}> {
	try {
		await runPublicSwitch(args);
	} catch (error) {
		const failure = error as {
			code?: number | string;
			stdout?: string;
			stderr?: string;
		};
		return {
			code: failure.code,
			stdout: String(failure.stdout ?? ""),
			stderr: String(failure.stderr ?? ""),
		};
	}
	throw new Error(`expected public switch to fail: ${args.join(" ")}`);
}

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "fly852-seam-"));
	const pool = join(tmp, "pool");
	lockPath = join(tmp, "accounts.lock");
	storePath = join(tmp, "claude-accounts.json");
	const stateFile = join(tmp, "keychain-state");
	const argvLog = join(tmp, "argv.log");
	const stubBin = join(tmp, "fake-security");

	mkdirSync(join(pool, "personal"), { recursive: true });
	mkdirSync(join(pool, "school"), { recursive: true });
	writeFileSync(join(pool, "personal", ".credentials.json"), SECRET_A, {
		mode: 0o600,
	});
	writeFileSync(join(pool, "school", ".credentials.json"), SECRET_B, {
		mode: 0o600,
	});
	writeFileSync(
		join(pool, "personal", "identity-anchor.json"),
		JSON.stringify({
			accountUuid: "uuid-personal",
			email: "personal@example.com",
			anchoredAt: "2026-07-16T00:00:00.000Z",
			anchoredBy: "test",
			confirmedBy: "test-evidence",
		}),
		{ mode: 0o600 },
	);
	writeFileSync(
		join(pool, "school", "identity-anchor.json"),
		JSON.stringify({
			accountUuid: "uuid-school",
			email: "school@example.com",
			anchoredAt: "2026-07-16T00:00:00.000Z",
			anchoredBy: "test",
			confirmedBy: "test-evidence",
		}),
		{ mode: 0o600 },
	);
	writeFileSync(join(pool, ".active"), "personal", { mode: 0o600 });
	writeFileSync(
		join(pool, "personal", "oauthAccount.json"),
		JSON.stringify(PERSONAL_IDENTITY),
		{ mode: 0o600 },
	);
	// FLY-865: school has a captured display identity; personal does not.
	writeFileSync(
		join(pool, "school", "oauthAccount.json"),
		JSON.stringify(SCHOOL_IDENTITY),
		{ mode: 0o600 },
	);
	// A scratch ~/.claude.json (identity currently = personal) — never the real one.
	claudeJson = join(tmp, "claude.json");
	writeFileSync(
		claudeJson,
		JSON.stringify({
			numStartups: 7,
			oauthAccount: PERSONAL_IDENTITY,
		}),
	);
	writeFileSync(stubBin, STUB, { mode: 0o755 });
	writeFileSync(stateFile, SECRET_A); // current machine credential
	writeFileSync(argvLog, "");
	// FLY-871: default "always fresh" freshness stub (exit 0) so the REAL `use`
	// path doesn't make a live OAuth call with the dummy pool credentials. Tests
	// that exercise the stale path override FLYWHEEL_CLAUDE_FRESHNESS_BIN.
	const freshBin = join(tmp, "fake-freshness");
	writeFileSync(freshBin, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
	const identityCurlBin = join(tmp, "fake-identity-curl");
	const identityCurlArgvLog = join(tmp, "identity-curl-argv.log");
	writeFileSync(identityCurlArgvLog, "");
	writeFileSync(
		identityCurlBin,
		`#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_IDENTITY_CURL_ARGV_LOG"
cfg=$(cat)
case "$cfg" in
  *sk-ant-oat01-INT-A-REFRESHED*) printf '%s' '{"account":{"uuid":"uuid-personal","email":"personal@example.com"}}' ;;
  *sk-ant-oat01-INT-A*) printf '%s' '{"account":{"uuid":"uuid-personal","email":"personal@example.com"}}' ;;
  *sk-ant-oat01-INT-B*) printf '%s' '{"account":{"uuid":"uuid-school","email":"school@example.com"}}' ;;
  *sk-ant-oat01-INT-C*) printf '%s' '{"account":{"uuid":"uuid-business","email":"business@example.com"}}' ;;
  *) exit 22 ;;
esac
`,
		{ mode: 0o755 },
	);
	writeStore(
		{
			generation: 1,
			activeAccount: "personal",
			accounts: [
				{ name: "personal", quotaExhaustedUntil: null, weeklyResetAt: null },
				{ name: "school", quotaExhaustedUntil: null, weeklyResetAt: null },
			],
		},
		storePath,
	);

	// The child bash script reads its config from env (execFile passes
	// {...process.env, FLYWHEEL_CLAUDE_LOCK_DELEGATED}), so wire it here.
	saved = {};
	for (const k of ENV_KEYS) saved[k] = process.env[k];
	process.env.FLYWHEEL_CLAUDE_PROFILES_DIR = pool;
	process.env.FLYWHEEL_CLAUDE_ACCOUNTS_LOCK = lockPath; // SAME lock as Node's
	process.env.FLYWHEEL_CLAUDE_ACCOUNTS_PATH = storePath;
	process.env.FLYWHEEL_CLAUDE_TRANSITION_JOURNAL = join(
		tmp,
		"claude-account-transition.json",
	);
	process.env.FLYWHEEL_CLAUDE_SECURITY_BIN = stubBin;
	process.env.FLYWHEEL_CLAUDE_KEYCHAIN_SERVICE = "Claude Seam-credentials";
	process.env.FLYWHEEL_CLAUDE_KEYCHAIN_ACCOUNT = "seamacct";
	// Regression speed: an un-delegated child would time out in 2s, not 30s.
	process.env.FLYWHEEL_CLAUDE_LOCK_TIMEOUT_MS = "2000";
	// FLY-865: point the identity write at the scratch file + isolated lock.
	process.env.FLYWHEEL_CLAUDE_JSON = claudeJson;
	process.env.FLYWHEEL_CLAUDE_JSON_LOCK = `${claudeJson}.lock`;
	process.env.FAKE_SEC_STATE = stateFile;
	process.env.FAKE_SEC_ARGV_LOG = argvLog;
	process.env.FLYWHEEL_CLAUDE_FRESHNESS_BIN = freshBin;
	process.env.FLYWHEEL_PROFILE_CURL_BIN = identityCurlBin;
	process.env.FLYWHEEL_PROFILE_IDENTITY_ENDPOINT =
		"https://identity.test/oauth/profile";
	process.env.FLYWHEEL_PROFILE_AUDIT_LOG = join(tmp, "profile-audit.log");
	process.env.FAKE_IDENTITY_CURL_ARGV_LOG = identityCurlArgvLog;
});

afterEach(() => {
	for (const k of ENV_KEYS) {
		const v = saved[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(tmp, { recursive: true, force: true });
});

describe("switchAccount ↔ flywheel-claude-profile seam (REAL lock + REAL script)", () => {
	it("public use routes through the built atomic executor and delivers its switch notification", async () => {
		const alertLog = join(tmp, "public-alert.log");
		const alertBin = join(tmp, "fake-public-lead-alert");
		writeFileSync(
			alertBin,
			"#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$PUBLIC_ALERT_LOG\"\nprintf 'sent\\n'\n",
			{ mode: 0o755 },
		);
		writeFileSync(alertLog, "");

		const server = createServer((request, response) => {
			response.setHeader("content-type", "application/json");
			if (request.method === "POST" && request.url === "/oauth/token") {
				response.end(
					JSON.stringify({
						access_token: "sk-ant-oat01-INT-B-ROTATED",
						refresh_token: "rB-rotated",
						expires_in: 3600,
					}),
				);
				return;
			}
			if (request.method === "GET" && request.url === "/api/oauth/usage") {
				response.end(
					JSON.stringify({
						five_hour: {
							utilization: 12,
							resets_at: "2026-09-01T22:00:00.000Z",
						},
						seven_day: {
							utilization: 34,
							resets_at: "2026-09-02T20:00:00.000Z",
						},
					}),
				);
				return;
			}
			response.statusCode = 404;
			response.end("{}");
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		try {
			const address = server.address();
			if (address === null || typeof address === "string") {
				throw new Error("test probe server did not bind a TCP port");
			}
			const baseUrl = `http://127.0.0.1:${address.port}`;
			process.env.FLYWHEEL_CLAUDE_SWITCH_BIN = SWITCH_BIN;
			process.env.FLYWHEEL_CLAUDE_PROFILE_BIN = PROFILE_BIN;
			process.env.FLYWHEEL_CLAUDE_OAUTH_ENDPOINT = `${baseUrl}/oauth/token`;
			process.env.FLYWHEEL_QUOTA_API_BASE = baseUrl;
			process.env.FLYWHEEL_QUOTA_MONITOR_CONFIG = join(
				tmp,
				"missing-config.json",
			);
			process.env.FLYWHEEL_LEAD_ALERT_BIN = alertBin;
			process.env.FLYWHEEL_NOTIFY_CHANNEL = "notification-test";
			process.env.FLYWHEEL_STATE_DIR = tmp;
			process.env.PUBLIC_ALERT_LOG = alertLog;

			const { stdout, stderr } = await execFileAsync(
				PROFILE_BIN,
				["use", "school"],
				{
					env: process.env,
					timeout: 15_000,
				},
			);

			expect(stdout).toContain(
				"Switched machine Claude account: personal → school",
			);
			expect(stderr).not.toContain("NOTIFICATION_PENDING");
			expect(
				readFileSync(process.env.FAKE_SEC_STATE as string, "utf8"),
			).toContain("INT-B-ROTATED");
			expect(readStore(storePath)).toMatchObject({
				activeAccount: "school",
				generation: 2,
				pendingSwitchNotifications: [],
			});
			const delivered = readFileSync(alertLog, "utf8");
			expect(delivered).toContain("--kind account_switched");
			expect(delivered).toContain("manual:use");
			expect(delivered).toContain("personal");
			expect(delivered).toContain("school");
		} finally {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
	}, 20_000);

	it("public next picks the live candidate with the earliest weekly reset", async () => {
		seedBusiness();
		const probes = await startProbeServer([
			schoolProbe(),
			{
				refreshToken: "rC",
				accessToken: "sk-ant-oat01-INT-C",
				rotatedAccessToken: "sk-ant-oat01-INT-C-ROTATED",
				rotatedRefreshToken: "rC-rotated",
				fiveH: 25,
				sevenD: 40,
				fiveHResetAt: "2026-09-01T23:00:00.000Z",
				sevenDResetAt: "2026-09-02T20:00:00.000Z",
			},
		]);
		try {
			const alertLog = configurePublicRuntime(probes.baseUrl);
			const { stdout } = await runPublicSwitch(["next"]);

			expect(stdout).toContain(
				"Switched machine Claude account: personal → business",
			);
			expect(
				readFileSync(process.env.FAKE_SEC_STATE as string, "utf8"),
			).toContain("INT-C-ROTATED");
			expect(readStore(storePath).activeAccount).toBe("business");
			const delivered = readFileSync(alertLog, "utf8");
			expect(delivered).toContain("--kind account_switched");
			expect(delivered).toContain("manual:next");
		} finally {
			await probes.close();
		}
	}, 20_000);

	it("public explicit use bypasses only cooldown while retaining live guards", async () => {
		const store = readStore(storePath);
		const school = store.accounts.find((account) => account.name === "school");
		if (school === undefined) throw new Error("school fixture missing");
		school.switchCooldownUntil = "2099-01-01T00:00:00.000Z";
		writeStore(store, storePath);
		const probes = await startProbeServer([schoolProbe()]);
		try {
			configurePublicRuntime(probes.baseUrl);
			const { stdout } = await runPublicSwitch(["use", "school"]);

			expect(stdout).toContain(
				"Switched machine Claude account: personal → school",
			);
			expect(readStore(storePath).activeAccount).toBe("school");
		} finally {
			await probes.close();
		}
	}, 20_000);

	it("retired public bypass names cannot admit a stale or quota-unverified target", async () => {
		const pool = process.env.FLYWHEEL_CLAUDE_PROFILES_DIR as string;
		writeFileSync(
			join(pool, "school", ".credentials.json"),
			JSON.stringify({
				claudeAiOauth: {
					accessToken: "sk-ant-oat01-INT-B",
					refreshToken: "rB",
					expiresAt: Date.now() + 3_600_000,
				},
			}),
			{ mode: 0o600 },
		);
		const probes = await startProbeServer([
			schoolProbe({ fresh: false, usageAvailable: false }),
		]);
		try {
			const alertLog = configurePublicRuntime(probes.baseUrl);
			process.env["FLY" + "WHEEL_CLAUDE_FRESHNESS_BYPASS"] = "1";
			process.env["FLY" + "WHEEL_CLAUDE_QUOTA_BYPASS"] = "1";
			const failure = await runPublicSwitchFailure(["use", "school"]);

			expect(failure.code).toBe(32);
			expect(failure.stderr).toContain("FLYWHEEL_MANUAL_NO_TARGET");
			expect(readStore(storePath).activeAccount).toBe("personal");
			const delivered = readFileSync(alertLog, "utf8");
			expect(delivered).not.toContain("--kind quota_guard_bypassed");
			expect(delivered).not.toContain("--kind account_switched");
		} finally {
			await probes.close();
		}
	}, 20_000);

	it("public stale-marker handling reconciles once and then switches atomically", async () => {
		seedBusiness();
		writeFileSync(
			join(process.env.FLYWHEEL_CLAUDE_PROFILES_DIR as string, ".active"),
			"business",
			{ mode: 0o600 },
		);
		const probes = await startProbeServer([schoolProbe()]);
		try {
			configurePublicRuntime(probes.baseUrl);
			const { stdout } = await runPublicSwitch(["use", "school"]);

			expect(stdout).toContain(
				"Switched machine Claude account: personal → school",
			);
			expect(
				readFileSync(
					join(process.env.FLYWHEEL_CLAUDE_PROFILES_DIR as string, ".active"),
					"utf8",
				),
			).toBe("school");
			const audit = readFileSync(
				process.env.FLYWHEEL_PROFILE_AUDIT_LOG as string,
				"utf8",
			)
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { probeSummary?: string });
			expect(
				audit.filter(
					(record) => record.probeSummary === "reconciled_business_to_personal",
				),
			).toHaveLength(1);
		} finally {
			await probes.close();
		}
	}, 30_000);

	it("public all-dead selection alerts and leaves the machine account untouched", async () => {
		const probes = await startProbeServer([schoolProbe({ fresh: false })]);
		try {
			const alertLog = configurePublicRuntime(probes.baseUrl);
			const failure = await runPublicSwitchFailure(["next"]);

			expect(failure.code).toBe(32);
			expect(failure.stderr).toContain("FLYWHEEL_MANUAL_NO_TARGET");
			expect(readFileSync(process.env.FAKE_SEC_STATE as string, "utf8")).toBe(
				SECRET_A,
			);
			expect(readStore(storePath).activeAccount).toBe("personal");
			expect(readFileSync(alertLog, "utf8")).toContain(
				"--kind quota_no_target",
			);
		} finally {
			await probes.close();
		}
	}, 20_000);

	it("public sender loads notification routing from the sparse daemon env file", async () => {
		const probes = await startProbeServer([schoolProbe()]);
		try {
			const alertLog = configurePublicRuntime(probes.baseUrl, {
				notifyFromEnvFile: true,
			});
			const { stdout } = await runPublicSwitch(["use", "school"]);

			expect(stdout).toContain(
				"Switched machine Claude account: personal → school",
			);
			expect(readFileSync(alertLog, "utf8")).toContain(
				"--kind account_switched",
			);
		} finally {
			await probes.close();
		}
	}, 20_000);

	it("switches while Node holds the shared lock — the delegated child neither deadlocks nor releases it", async () => {
		const deps = makeClaudeProfileSwitchDeps({
			binPath: PROFILE_BIN,
			quotaPreverified: true,
		});

		const result = await switchAccount(
			{
				scope: "5h",
				observedAccount: "personal",
				observedGeneration: 1,
				resetAt: "2026-07-05T02:30:00.000Z",
				now: new Date("2026-07-04T20:00:00Z"),
			},
			{ storePath, lockPath, ...deps },
		);

		expect(result).toMatchObject({
			outcome: "switched",
			from: "personal",
			to: "school",
		});
		// The REAL write went through the script: fake keychain now holds B.
		expect(readFileSync(process.env.FAKE_SEC_STATE as string, "utf-8")).toBe(
			SECRET_B,
		);
		// The script committed its .active…
		expect(
			readFileSync(
				join(process.env.FLYWHEEL_CLAUDE_PROFILES_DIR as string, ".active"),
				"utf-8",
			),
		).toBe("school");
		// …and the Node store committed + bumped.
		const store = readStore(storePath);
		expect(store.activeAccount).toBe("school");
		expect(store.generation).toBe(2);
		// The parent released the lock at the end (the delegated child must not
		// have released it mid-critical-section NOR left it behind).
		expect(existsSync(lockPath)).toBe(false);
		// FLY-865: the REAL bash `use` also wrote school's display identity into
		// the scratch ~/.claude.json (oauthAccount swapped, other keys preserved).
		const cj = JSON.parse(readFileSync(claudeJson, "utf-8"));
		expect(cj.oauthAccount).toEqual(SCHOOL_IDENTITY);
		expect(cj.numStartups).toBe(7); // untouched
		// No stray identity-write temp files left behind.
		expect(existsSync(`${claudeJson}.lock`)).toBe(false);
	}, 10_000);

	it("repairs delegated UUID-only display drift without mutating the Node store during apply", async () => {
		const pool = process.env.FLYWHEEL_CLAUDE_PROFILES_DIR as string;
		writeFileSync(process.env.FAKE_SEC_STATE as string, SECRET_A_REFRESHED);
		writeFileSync(
			claudeJson,
			JSON.stringify({
				numStartups: 7,
				oauthAccount: {
					...PERSONAL_IDENTITY,
					accountUuid: "uuid-stale-display",
				},
			}),
		);

		const baseDeps = makeClaudeProfileSwitchDeps({
			binPath: PROFILE_BIN,
			quotaPreverified: true,
		});
		const applySnapshots: Array<{
			before: { activeAccount: string | null; generation: number };
			after: { activeAccount: string | null; generation: number };
		}> = [];
		const deps = {
			...baseDeps,
			applyProfile: async (
				...args: Parameters<NonNullable<typeof baseDeps.applyProfile>>
			) => {
				const before = readStore(storePath);
				const result = await baseDeps.applyProfile(...args);
				const after = readStore(storePath);
				applySnapshots.push({
					before: {
						activeAccount: before.activeAccount,
						generation: before.generation,
					},
					after: {
						activeAccount: after.activeAccount,
						generation: after.generation,
					},
				});
				return result;
			},
		};

		const result = await switchAccount(
			{
				scope: "5h",
				observedAccount: "personal",
				observedGeneration: 1,
				resetAt: "2026-07-05T02:30:00.000Z",
				now: new Date("2026-07-04T20:00:00Z"),
			},
			{ storePath, lockPath, ...deps },
		);

		expect(result).toMatchObject({
			outcome: "switched",
			from: "personal",
			to: "school",
		});
		expect(applySnapshots).toEqual([
			{
				before: { activeAccount: "personal", generation: 1 },
				after: { activeAccount: "personal", generation: 1 },
			},
		]);
		expect(
			readFileSync(join(pool, "personal", ".credentials.json"), "utf8"),
		).toBe(SECRET_A_REFRESHED);
		expect(readStore(storePath)).toMatchObject({
			activeAccount: "school",
			generation: 2,
		});
		expect(JSON.parse(readFileSync(claudeJson, "utf8")).oauthAccount).toEqual(
			SCHOOL_IDENTITY,
		);
	}, 15_000);

	// FLY-871 R1/C3 — the freshness guard end-to-end through the REAL seam: a stale
	// target (real bash `use` exit 30) must reach real Node as TargetStaleError,
	// flag the account authExpired, and — with no other candidate — resolve to
	// no_account with the Keychain and .active UNTOUCHED (the incident red line,
	// proven through the real lock + real script, not a mock).
	it("a stale target (real freshness exit 30) → no_account, Keychain NOT written, account flagged authExpired", async () => {
		const staleBin = join(tmp, "fake-freshness-stale");
		writeFileSync(staleBin, "#!/usr/bin/env bash\nexit 30\n", { mode: 0o755 });
		process.env.FLYWHEEL_CLAUDE_FRESHNESS_BIN = staleBin;

		const deps = makeClaudeProfileSwitchDeps({ binPath: PROFILE_BIN });
		const result = await switchAccount(
			{
				scope: "5h",
				observedAccount: "personal",
				observedGeneration: 1,
				resetAt: "2026-07-05T02:30:00.000Z",
				now: new Date("2026-07-04T20:00:00Z"),
			},
			{ storePath, lockPath, ...deps },
		);

		// only candidate (school) was stale → no usable account
		expect(result.outcome).toBe("no_account");
		// RED LINE: the fake Keychain was NEVER written (still the previous cred)
		expect(readFileSync(process.env.FAKE_SEC_STATE as string, "utf-8")).toBe(
			SECRET_A,
		);
		// .active was never changed
		expect(
			readFileSync(
				join(process.env.FLYWHEEL_CLAUDE_PROFILES_DIR as string, ".active"),
				"utf8",
			),
		).toBe("personal");
		// the stale account was flagged authExpired (persisted in-lock)
		const store = readStore(storePath);
		expect(store.accounts.find((a) => a.name === "school")?.authExpired).toBe(
			true,
		);
		expect(store.activeAccount).toBe("personal"); // unchanged
		// lock released cleanly
		expect(existsSync(lockPath)).toBe(false);
	});
});
