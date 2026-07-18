/**
 * FLY-696 M1/⑤ — flywheel-claude-profile (machine-level Claude account
 * rotation over the Keychain).
 *
 * The security tool is faked (FLYWHEEL_CLAUDE_SECURITY_BIN → a stub that keeps
 * "keychain" state in a file and logs EVERY argv line), so these tests cover
 * the full contract without touching any real Keychain:
 *   - RED LINE: no credential ever appears in any argv (the stub's argv log
 *     must never contain the secret);
 *   - RED LINE: verify-before-commit — a corrupted write (stub in corrupt
 *     mode) must roll back to the previous credential and leave .active
 *     untouched (never break the claude login);
 *   - pool hygiene (symlink refusal, 0600/0700), rotation order, lock
 *     timeout/stale-break byte-compatible with withMkdirLock.
 *
 * Real-Keychain behavior (security -i round-trip, prompt-free writes) was
 * spike-verified on-machine (2026-07-03) and is re-verified by the
 * independent QA against a scratch keychain + dummy service.
 */
import {
	execFileSync,
	type SpawnSyncReturns,
	spawn,
	spawnSync,
} from "node:child_process";
import { createHash } from "node:crypto";
import {
	accessSync,
	chmodSync,
	constants,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
// (dirname is used by both the PROFILE_BIN locator and FLY-865 identity tests)
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 15_000 });

const PROFILE_BIN = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"bin",
	"flywheel-claude-profile",
);

const SECRET_A =
	'{"claudeAiOauth":{"accessToken":"sk-ant-oat01-AAA","refreshToken":"rA"}}';
const SECRET_B =
	'{"claudeAiOauth":{"accessToken":"sk-ant-oat01-BBB","refreshToken":"rB"}}';
const SECRET_CUR =
	'{"claudeAiOauth":{"accessToken":"sk-ant-oat01-CURRENT","refreshToken":"rC"}}';
const SECRET_RELOGIN_PERSONAL =
	'{"claudeAiOauth":{"accessToken":"sk-ant-oat01-PERSONAL-RELOGIN","refreshToken":"rP"}}';
// FLY-871: a value the live Keychain "drifted" to (claude auto-refreshed the
// active account's token) — capture-back must snapshot THIS into the pool.
const SECRET_DRIFT =
	'{"claudeAiOauth":{"accessToken":"sk-ant-oat01-DRIFT","refreshToken":"rD"}}';
// FLY-871: what a "refreshing" freshness helper writes back to the pool.
const SECRET_ROTATED =
	'{"claudeAiOauth":{"accessToken":"sk-ant-oat01-ROTATED","refreshToken":"rR"}}';
const SECRET_PERSONAL_REFRESHED =
	'{"claudeAiOauth":{"accessToken":"sk-ant-oat01-PERSONAL-REFRESHED","refreshToken":"rPR"}}';
const SECRET_BIZ =
	'{"claudeAiOauth":{"accessToken":"sk-ant-oat01-BIZ","refreshToken":"rBiz"}}';
const EMAILS = {
	business: "xrliannie.b@gmail.com",
	personal: "xrliannie@gmail.com",
	personal1: "xrliannie.1@gmail.com",
	school: "xiaorongli2011@u.northwestern.edu",
	shopping: "xrliannie.shopping@gmail.com",
} as const;

let tmp: string;
let pool: string;
let lockDir: string;
let stateFile: string;
let argvLog: string;
let stubBin: string;
// FLY-871: a default "always fresh" freshness helper stub (exit 0) so existing
// `use` tests keep passing; freshLog records its argv for the invocation assertion.
let freshBin: string;
let freshLog: string;
// FLY-1182: fake OAuth identity probe. The stub reads curl config from stdin,
// records argv separately (the access token must never appear there), and
// returns a profile based on the bearer token in the stdin-only header.
let identityCurlBin: string;
let identityCurlArgvLog: string;
let auditLog: string;
// FLY-1252: live quota guard + bypass-alert stubs. Existing profile tests use
// an always-healthy guard; focused tests override it to exercise 32/33.
let quotaBin: string;
let quotaLog: string;
let alertBin: string;
let alertLog: string;
let accountsStore: string;
let transitionJournal: string;
// FLY-865: a scratch ~/.claude.json + its lock. env() ALWAYS points the script
// at these so no test can ever touch the real ~/.claude.json.
let claudeJson: string;
let claudeJsonLock: string;

// A representative oauthAccount identity block (non-secret: email/org/uuid).
const IDENTITY_SHOP = {
	accountUuid: "uuid-shop",
	emailAddress: EMAILS.shopping,
	organizationUuid: "org-shop",
	organizationName: "Shop Org",
	displayName: "Shopper",
	organizationRole: "admin",
};
const IDENTITY_BIZ = {
	accountUuid: "uuid-biz",
	emailAddress: EMAILS.business,
	organizationUuid: "org-biz",
	organizationName: "Biz Org",
	displayName: "Biz",
	organizationRole: "admin",
};

const IDENTITY_PROFILES: Record<string, { uuid: string; email: string }> = {
	"sk-ant-oat01-AAA": { uuid: "uuid-personal", email: EMAILS.personal },
	"sk-ant-oat01-PERSONAL-RELOGIN": {
		uuid: "uuid-personal",
		email: EMAILS.personal,
	},
	"sk-ant-oat01-BBB": { uuid: "uuid-school", email: EMAILS.school },
	"sk-ant-oat01-CURRENT": {
		uuid: "uuid-current",
		email: "current@example.com",
	},
	"sk-ant-oat01-DRIFT": { uuid: "uuid-drift", email: "drift@example.com" },
	"sk-ant-oat01-ROTATED": {
		uuid: "uuid-school",
		email: EMAILS.school,
	},
	"sk-ant-oat01-PERSONAL-REFRESHED": {
		uuid: "uuid-personal",
		email: EMAILS.personal,
	},
	"sk-ant-oat01-BIZ": { uuid: "uuid-biz", email: EMAILS.business },
};

/** A full-ish ~/.claude.json shape (many top-level keys + nested) to prove the
 * patch preserves everything except oauthAccount. */
function claudeJsonWith(oauth: unknown): string {
	return JSON.stringify({
		numStartups: 42,
		mcpServers: { some: { command: "x" } },
		projects: { "/a/b": { hasTrustDialogAccepted: true } },
		oauthAccount: oauth,
		tail: "keepme",
	});
}

/**
 * The fake `security`. State = one file (the "keychain item"). Every argv is
 * appended to the argv log — the red-line assertion greps that log for the
 * secret. `-i` mode reads the command from stdin and extracts the `-w` token.
 * FAKE_SEC_CORRUPT=1 makes writes store a corrupted value (verify-fail path).
 */
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
    if [[ "\${FAKE_SEC_CORRUPT:-0}" == "1" ]]; then
      printf '%s' "CORRUPTED" > "$FAKE_SEC_STATE"
    else
      printf '%s' "$val" > "$FAKE_SEC_STATE"
    fi
    ;;
  *)
    exit 2
    ;;
esac
`;

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	return {
		...process.env,
		FLYWHEEL_CLAUDE_PROFILES_DIR: pool,
		FLYWHEEL_CLAUDE_ACCOUNTS_LOCK: lockDir,
		FLYWHEEL_CLAUDE_SECURITY_BIN: stubBin,
		FLYWHEEL_CLAUDE_KEYCHAIN_SERVICE: "Claude Test-credentials",
		FLYWHEEL_CLAUDE_KEYCHAIN_ACCOUNT: "testacct",
		FAKE_SEC_STATE: stateFile,
		FAKE_SEC_ARGV_LOG: argvLog,
		// FLY-871: default "always fresh" helper — existing `use`/`next` tests are
		// unaffected (fresh verdict, no pool write-back). Individual tests override
		// FLYWHEEL_CLAUDE_FRESHNESS_BIN to exercise stale / unavailable / refresh.
		FLYWHEEL_CLAUDE_FRESHNESS_BIN: freshBin,
		FRESH_ARGV_LOG: freshLog,
		FLYWHEEL_CLAUDE_QUOTA_GUARD_BIN: quotaBin,
		FLYWHEEL_CLAUDE_ACCOUNTS_PATH: accountsStore,
		FLYWHEEL_CLAUDE_TRANSITION_JOURNAL: transitionJournal,
		FLYWHEEL_NODE_BIN: process.execPath,
		QUOTA_ARGV_LOG: quotaLog,
		FLYWHEEL_LEAD_ALERT_BIN: alertBin,
		ALERT_ARGV_LOG: alertLog,
		// FLY-865 SAFETY: never let a test touch the real ~/.claude.json.
		FLYWHEEL_CLAUDE_JSON: claudeJson,
		FLYWHEEL_CLAUDE_JSON_LOCK: claudeJsonLock,
		FLYWHEEL_PROFILE_CURL_BIN: identityCurlBin,
		FLYWHEEL_PROFILE_IDENTITY_ENDPOINT: "https://identity.test/oauth/profile",
		FLYWHEEL_PROFILE_AUDIT_LOG: auditLog,
		FAKE_IDENTITY_CURL_ARGV_LOG: identityCurlArgvLog,
		...extra,
	};
}

/** Which bash to run the script with. Defaults to PATH bash (Homebrew 5.x on
 * this host); pass "/bin/bash" to exercise macOS system bash 3.2 (FLY-865/#6). */
function run(
	args: string[],
	extra: Record<string, string> = {},
	bash = "bash",
): string {
	return execFileSync(bash, [PROFILE_BIN, ...args], {
		env: env(extra),
		encoding: "utf-8",
	});
}

function runExpectFail(
	args: string[],
	extra: Record<string, string> = {},
	bash = "bash",
): { status: number; stderr: string } {
	try {
		execFileSync(bash, [PROFILE_BIN, ...args], {
			env: env(extra),
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (err) {
		const e = err as SpawnSyncReturns<string>;
		return { status: e.status ?? -1, stderr: String(e.stderr) };
	}
	throw new Error(`expected non-zero exit for: ${args.join(" ")}`);
}

/** Run and capture stdout+stderr separately (identity notes go to stderr). */
function runBoth(
	args: string[],
	extra: Record<string, string> = {},
	bash = "bash",
): { stdout: string; stderr: string } {
	const r = spawnSync(bash, [PROFILE_BIN, ...args], {
		env: env(extra),
		encoding: "utf-8",
	});
	if (r.status !== 0) {
		throw new Error(
			`expected exit 0 for ${args.join(" ")}, got ${r.status}: ${r.stderr}`,
		);
	}
	return { stdout: String(r.stdout), stderr: String(r.stderr) };
}

function seedProfile(name: string, secret: string): void {
	mkdirSync(join(pool, name), { recursive: true });
	writeFileSync(join(pool, name, ".credentials.json"), secret, { mode: 0o600 });
}

function seedAnchor(name: string, accountUuid: string, email: string): void {
	mkdirSync(join(pool, name), { recursive: true });
	writeFileSync(
		join(pool, name, "identity-anchor.json"),
		JSON.stringify({
			accountUuid,
			email,
			anchoredAt: "2026-07-16T00:00:00.000Z",
			anchoredBy: "test",
			confirmedBy: "test-evidence",
		}),
		{ mode: 0o600 },
	);
}

function seedIdentityMap(
	overrides: Partial<Record<string, string>> = {},
): void {
	writeFileSync(
		join(pool, "identity-map.json"),
		JSON.stringify({
			version: 1,
			artifactId: "identity-map-test-v1",
			confirmedAt: "2026-07-16T00:00:00.000Z",
			labels: {
				...EMAILS,
				...overrides,
			},
		}),
		{ mode: 0o600 },
	);
}

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function seedTransitionJournal(
	overrides: Partial<Record<string, unknown>> = {},
): void {
	writeFileSync(
		transitionJournal,
		JSON.stringify({
			opId: "test-op",
			writerUid: process.getuid?.() ?? 0,
			writerPgid: 999_999,
			leaderPid: 999_999,
			leaderStartTime: "test-start",
			writerLeaseToken: "old-token",
			oldLabel: "school",
			targetLabel: "personal",
			oldDigest: digest(SECRET_CUR),
			targetDigest: digest(SECRET_A),
			startedAt: "2026-07-16T00:00:00.000Z",
			...overrides,
		}),
		{ mode: 0o600 },
	);
}

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "fly696-profile-"));
	pool = join(tmp, "pool");
	lockDir = join(tmp, "accounts.lock");
	stateFile = join(tmp, "keychain-state");
	argvLog = join(tmp, "argv.log");
	stubBin = join(tmp, "fake-security");
	claudeJson = join(tmp, "claude.json");
	claudeJsonLock = join(tmp, "claude.json.lock");
	freshBin = join(tmp, "fake-freshness");
	freshLog = join(tmp, "fresh-argv.log");
	quotaBin = join(tmp, "fake-quota-guard");
	quotaLog = join(tmp, "quota-argv.log");
	alertBin = join(tmp, "fake-lead-alert");
	alertLog = join(tmp, "alert-argv.log");
	accountsStore = join(tmp, "claude-accounts.json");
	transitionJournal = join(tmp, "claude-account-transition.json");
	writeFileSync(stubBin, STUB, { mode: 0o755 });
	writeFileSync(argvLog, "");
	// Default freshness helper: logs its argv, exits 0 (fresh). NO pool write-back.
	writeFileSync(
		freshBin,
		'#!/usr/bin/env bash\nset -u\nprintf \'%s\\n\' "$*" >> "$FRESH_ARGV_LOG"\nexit 0\n',
		{ mode: 0o755 },
	);
	writeFileSync(freshLog, "");
	identityCurlBin = join(tmp, "fake-identity-curl");
	identityCurlArgvLog = join(tmp, "identity-curl-argv.log");
	auditLog = join(tmp, "claude-profile-audit.log");
	writeFileSync(identityCurlArgvLog, "");
	writeFileSync(
		identityCurlBin,
		`#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_IDENTITY_CURL_ARGV_LOG"
cfg=$(cat)
case "$cfg" in
${Object.entries(IDENTITY_PROFILES)
	.map(
		([token, profile]) =>
			`  *${token}*) printf '%s' '${JSON.stringify({ account: profile })}' ;;`,
	)
	.join("\n")}
  *) printf '%s' '{"error":"unknown token"}'; exit 22 ;;
esac
`,
		{ mode: 0o755 },
	);
	writeFileSync(
		quotaBin,
		'#!/usr/bin/env bash\nset -u\nprintf \'%s\\n\' "$*" >> "$QUOTA_ARGV_LOG"\nexit 0\n',
		{ mode: 0o755 },
	);
	writeFileSync(quotaLog, "");
	writeFileSync(
		alertBin,
		'#!/usr/bin/env bash\nset -u\nprintf \'%s\\n\' "$*" >> "$ALERT_ARGV_LOG"\necho sent\n',
		{ mode: 0o755 },
	);
	writeFileSync(alertLog, "");
	writeFileSync(
		accountsStore,
		JSON.stringify({ generation: 0, activeAccount: null, accounts: {} }),
	);
	mkdirSync(pool, { recursive: true });
	seedProfile("personal", SECRET_A);
	seedProfile("school", SECRET_B);
	seedAnchor("personal", "uuid-personal", EMAILS.personal);
	seedAnchor("school", "uuid-school", EMAILS.school);
	// current machine credential (what a rollback must restore)
	writeFileSync(stateFile, SECRET_CUR);
	// A scratch ~/.claude.json whose oauthAccount = the "shop" identity.
	writeFileSync(claudeJson, claudeJsonWith(IDENTITY_SHOP));
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("flywheel-claude-profile", () => {
	it("is bundled and executable", () => {
		expect(() => accessSync(PROFILE_BIN, constants.X_OK)).not.toThrow();
	});

	it("`use` swaps the keychain item to the pool credential + commits .active", () => {
		const out = run(["use", "personal"]);
		expect(out).toContain(
			"Switched machine Claude account to profile 'personal'",
		);
		expect(readFileSync(stateFile, "utf-8")).toBe(SECRET_A);
		expect(readFileSync(join(pool, ".active"), "utf-8")).toBe("personal");
	});

	it("RED LINE: the credential NEVER appears in any security argv", () => {
		run(["use", "personal"]);
		run(["use", "school"]);
		const log = readFileSync(argvLog, "utf-8");
		expect(log.length).toBeGreaterThan(0); // the stub was actually exercised
		expect(log).not.toContain("sk-ant-oat01");
		expect(log).not.toContain("accessToken");
	});

	it("active-marker temp preflight fails before any Keychain mutation", () => {
		const binDir = join(tmp, "mktemp-fail-bin");
		mkdirSync(binDir);
		writeFileSync(
			join(binDir, "mktemp"),
			`#!/bin/sh
case "$1" in
  *.active.tmp.*) exit 9 ;;
esac
exec "$REAL_MKTEMP" "$@"
`,
			{ mode: 0o755 },
		);
		const realMktemp = execFileSync("which", ["mktemp"], {
			encoding: "utf8",
		}).trim();
		const result = runExpectFail(["use", "personal"], {
			PATH: `${binDir}:${process.env.PATH ?? ""}`,
			REAL_MKTEMP: realMktemp,
		});
		expect(result.status).not.toBe(0);
		expect(readFileSync(stateFile, "utf8")).toBe(SECRET_CUR);
		expect(existsSync(join(pool, ".active"))).toBe(false);
		expect(readFileSync(argvLog, "utf8")).not.toMatch(/^-i$/m);
	});

	it("RED LINE: verify-fail rolls back to the previous credential, .active untouched", () => {
		// First write corrupts (stub corrupt mode ON) → read-back mismatch. The
		// rollback write must restore SECRET_CUR — but corrupt mode would corrupt
		// the rollback too, so flip corruption off after the first write via a
		// one-shot marker the stub honors… simpler: corrupt mode ON corrupts every
		// write, so the rollback ALSO stores CORRUPTED ≠ backup → the script must
		// still exit non-zero and leave .active untouched (worst-case honesty).
		const { status, stderr } = runExpectFail(["use", "personal"], {
			FAKE_SEC_CORRUPT: "1",
		});
		expect(status).toBe(37);
		expect(stderr).toContain("verify-before-commit failed");
		expect(existsSync(join(pool, ".active"))).toBe(false);
	});

	it("RED LINE: a failed Keychain write still restores and verifies the previous credential", () => {
		const partialWriteStub = join(tmp, "fake-security-partial-write");
		const marker = join(tmp, "fail-write-once");
		writeFileSync(
			partialWriteStub,
			`#!/usr/bin/env bash
set -u
case "\${1:-}" in
  find-generic-password) [[ -f "$FAKE_SEC_STATE" ]] || exit 44; cat "$FAKE_SEC_STATE" ;;
  -i)
    cmd=$(cat)
    val=$(printf '%s' "$cmd" | sed -n 's/.* -w \\([^ ]*\\).*/\\1/p')
    if [[ -f "${marker}" ]]; then
      rm -f "${marker}"
      printf '%s' "$val" > "$FAKE_SEC_STATE"
      exit 9
    fi
    printf '%s' "$val" > "$FAKE_SEC_STATE"
    ;;
  *) exit 2 ;;
esac
`,
			{ mode: 0o755 },
		);
		writeFileSync(marker, "");

		const { status, stderr } = runExpectFail(["use", "personal"], {
			FLYWHEEL_CLAUDE_SECURITY_BIN: partialWriteStub,
		});
		expect(status).not.toBe(0);
		expect(stderr).toContain("Keychain write failed");
		expect(stderr).toContain("rolled back");
		expect(readFileSync(stateFile, "utf8")).toBe(SECRET_CUR);
		expect(existsSync(join(pool, ".active"))).toBe(false);
	});

	it("RED LINE: an unreadable Keychain preimage aborts before write or delete", () => {
		const unreadableStub = join(tmp, "fake-security-unreadable");
		writeFileSync(
			unreadableStub,
			`#!/usr/bin/env bash
set -u
printf '%s\\n' "$*" >> "$FAKE_SEC_ARGV_LOG"
case "\${1:-}" in
  find-generic-password) exit 63 ;;
  -i) cat >/dev/null; printf '%s' BROKEN > "$FAKE_SEC_STATE" ;;
  delete-generic-password) rm -f "$FAKE_SEC_STATE" ;;
  *) exit 2 ;;
esac
`,
			{ mode: 0o755 },
		);

		const { status, stderr } = runExpectFail(["use", "personal"], {
			FLYWHEEL_CLAUDE_SECURITY_BIN: unreadableStub,
		});
		expect(status).not.toBe(0);
		expect(stderr).toContain("cannot read the current Keychain credential");
		expect(readFileSync(stateFile, "utf8")).toBe(SECRET_CUR);
		expect(readFileSync(argvLog, "utf8")).not.toMatch(
			/^-i$|^delete-generic-password/m,
		);
		expect(existsSync(join(pool, ".active"))).toBe(false);
	});

	it("RED LINE: a non-restorable Keychain preimage aborts before mutation", () => {
		const pretty =
			'{ "claudeAiOauth": { "accessToken": "sk-ant-oat01-CURRENT", "refreshToken": "rC" } }';
		writeFileSync(stateFile, pretty);

		const { status, stderr } = runExpectFail(["use", "personal"]);

		expect(status).not.toBe(0);
		expect(stderr).toContain("whitespace");
		expect(readFileSync(stateFile, "utf8")).toBe(pretty);
		expect(readFileSync(argvLog, "utf8")).not.toMatch(
			/^-i$|^delete-generic-password/m,
		);
		expect(existsSync(join(pool, ".active"))).toBe(false);
	});

	it("RED LINE: an absent preimage with a corrupt read-back fails closed (37), .active untouched", () => {
		const absentStub = join(tmp, "fake-security-absent-preimage");
		const corruptOnce = join(tmp, "corrupt-once-absent");
		rmSync(stateFile);
		writeFileSync(corruptOnce, "");
		writeFileSync(
			absentStub,
			`#!/usr/bin/env bash
set -u
printf '%s\\n' "$*" >> "$FAKE_SEC_ARGV_LOG"
case "\${1:-}" in
  find-generic-password) [[ -f "$FAKE_SEC_STATE" ]] || exit 44; cat "$FAKE_SEC_STATE" ;;
  -i)
    cmd=$(cat)
    val=$(printf '%s' "$cmd" | sed -n 's/.* -w \\([^ ]*\\).*/\\1/p')
    if [[ -f "${corruptOnce}" ]]; then rm -f "${corruptOnce}"; val=CORRUPTED; fi
    printf '%s' "$val" > "$FAKE_SEC_STATE"
    ;;
  delete-generic-password) rm -f "$FAKE_SEC_STATE" ;;
  *) exit 2 ;;
esac
`,
			{ mode: 0o755 },
		);

		const { status, stderr } = runExpectFail(["use", "personal"], {
			FLYWHEEL_CLAUDE_SECURITY_BIN: absentStub,
		});
		expect(status).toBe(37);
		expect(stderr).toContain("verify-before-commit failed");
		expect(existsSync(join(pool, ".active"))).toBe(false);
	});

	it("verify-fail with a WORKING rollback restores the previous credential", () => {
		// Corrupt exactly the first -i write: the stub corrupts while the marker
		// file exists (then deletes it) — the rollback write goes through clean.
		const oneShotStub = join(tmp, "fake-security-oneshot");
		const marker = join(tmp, "corrupt-once");
		const stub2 = `#!/usr/bin/env bash
set -u
printf '%s\\n' "$*" >> "$FAKE_SEC_ARGV_LOG"
case "\${1:-}" in
  find-generic-password) [[ -f "$FAKE_SEC_STATE" ]] || exit 44; cat "$FAKE_SEC_STATE" ;;
  -i)
    cmd=$(cat)
    val=$(printf '%s' "$cmd" | sed -n 's/.* -w \\([^ ]*\\).*/\\1/p')
    [[ -z "$val" ]] && exit 1
    if [[ -f "${marker}" ]]; then rm -f "${marker}"; printf '%s' "CORRUPTED" > "$FAKE_SEC_STATE"
    else printf '%s' "$val" > "$FAKE_SEC_STATE"; fi
    ;;
  *) exit 2 ;;
esac
`;
		writeFileSync(oneShotStub, stub2, { mode: 0o755 });
		writeFileSync(marker, "");

		const { status, stderr } = runExpectFail(["use", "personal"], {
			FLYWHEEL_CLAUDE_SECURITY_BIN: oneShotStub,
		});
		expect(status).toBe(36);
		expect(stderr).toContain("rolled back");
		// the machine credential is back to what it was — login never broken
		expect(readFileSync(stateFile, "utf-8")).toBe(SECRET_CUR);
		expect(existsSync(join(pool, ".active"))).toBe(false);
	});

	it("`use` refuses a missing profile", () => {
		const { status, stderr } = runExpectFail(["use", "ghost"]);
		expect(status).not.toBe(0);
		expect(stderr).toContain("not found");
		expect(readFileSync(stateFile, "utf-8")).toBe(SECRET_CUR); // untouched
	});

	it("`use` refuses a symlinked credential file", () => {
		mkdirSync(join(pool, "evil"), { recursive: true });
		symlinkSync(
			join(pool, "personal", ".credentials.json"),
			join(pool, "evil", ".credentials.json"),
		);
		const { status, stderr } = runExpectFail(["use", "evil"]);
		expect(status).not.toBe(0);
		expect(stderr).toContain("symlink");
	});

	it("refuses a credential containing whitespace (security -i single-token rule)", () => {
		seedProfile("spacey", '{"claudeAiOauth": {"accessToken":"x"}}'); // has a space
		const { status, stderr } = runExpectFail(["use", "spacey"]);
		expect(status).not.toBe(0);
		expect(stderr).toContain("whitespace");
		expect(readFileSync(stateFile, "utf-8")).toBe(SECRET_CUR);
	});

	it("refuses path-traversal / reserved profile names (use + capture)", () => {
		for (const bad of ["../evil", "a/b", ".active", "..", "a..b"]) {
			const { status, stderr } = runExpectFail(["use", bad]);
			expect(status, `use ${bad}`).not.toBe(0);
			expect(stderr, `use ${bad}`).toContain("profile name");
		}
		const { status } = runExpectFail(["capture", "../evil"]);
		expect(status).not.toBe(0);
		expect(readFileSync(stateFile, "utf-8")).toBe(SECRET_CUR); // untouched
	});

	it("refuses a group/world-readable credential file (must be 0600/0400)", () => {
		mkdirSync(join(pool, "loose"), { recursive: true });
		writeFileSync(join(pool, "loose", ".credentials.json"), SECRET_A, {
			mode: 0o644,
		});
		const { status, stderr } = runExpectFail(["use", "loose"]);
		expect(status).not.toBe(0);
		expect(stderr).toContain("must be 600/400");
		expect(readFileSync(stateFile, "utf-8")).toBe(SECRET_CUR);
	});

	it("refuses a non-JSON-object credential", () => {
		seedProfile("garbage", "not-json-at-all");
		const { status, stderr } = runExpectFail(["use", "garbage"]);
		expect(status).not.toBe(0);
		expect(stderr).toContain("not a JSON object");
	});

	it("`next` rotates in sorted order and wraps", () => {
		run(["use", "personal"]);
		run(["next"]); // personal → school
		expect(readFileSync(join(pool, ".active"), "utf-8")).toBe("school");
		expect(readFileSync(stateFile, "utf-8")).toBe(SECRET_B);
		run(["next"]); // school → wraps to personal
		expect(readFileSync(join(pool, ".active"), "utf-8")).toBe("personal");
		expect(readFileSync(stateFile, "utf-8")).toBe(SECRET_A);
	});

	it("`next` fails with a single-profile pool", () => {
		rmSync(join(pool, "school"), { recursive: true, force: true });
		const { status } = runExpectFail(["next"]);
		expect(status).not.toBe(0);
	});

	it("`capture` snapshots the current keychain into the pool with 0600/0700", () => {
		writeFileSync(stateFile, SECRET_A);
		writeFileSync(
			claudeJson,
			claudeJsonWith({
				accountUuid: "uuid-personal",
				emailAddress: EMAILS.personal,
				organizationUuid: "org-personal",
				organizationName: "Personal Org",
			}),
		);
		chmodSync(join(pool, "personal"), 0o755);
		const out = run(["capture", "personal"]);
		expect(out).toContain("Captured");
		const file = join(pool, "personal", ".credentials.json");
		expect(readFileSync(file, "utf-8")).toBe(SECRET_A);
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(statSync(join(pool, "personal")).mode & 0o777).toBe(0o700);
	});

	it("status/list reflect the active profile", () => {
		expect(run(["status"])).toContain("No active profile set.");
		run(["use", "school"]);
		expect(run(["status"])).toContain("Active profile: school");
		const list = run(["list"]);
		expect(list).toContain("* school");
		expect(list).toContain("  personal");
	});

	it("lock delegation (FLY-852): matching live holder pid → proceeds WITHOUT taking or releasing the lock", () => {
		// Simulates the Node switch executor: it holds the lock (live holder =
		// this vitest process) and delegates to the child via env.
		mkdirSync(lockDir, { recursive: true });
		writeFileSync(
			join(lockDir, "holder"),
			JSON.stringify({ pid: process.pid, at: Date.now() }),
		);
		run(["use", "personal"], {
			FLYWHEEL_CLAUDE_LOCK_DELEGATED: String(process.pid),
		});
		expect(readFileSync(stateFile, "utf-8")).toBe(SECRET_A); // switch happened
		// The parent's lock is UNTOUCHED (not released by the child).
		expect(existsSync(lockDir)).toBe(true);
		expect(readFileSync(join(lockDir, "holder"), "utf-8")).toContain(
			`"pid":${process.pid}`,
		);
		rmSync(lockDir, { recursive: true, force: true });
	});

	it("lock delegation (Codex R3 HIGH-1): env pid matches a live holder that is NOT our parent → refused", () => {
		// A forger can read the holder file and copy a live pid into the env —
		// but the holder must ALSO be the script's direct parent ($PPID). Use
		// pid 1 (launchd: always alive, never the script's parent): the
		// delegation must fall through to a normal acquire, which then times
		// out against the live-holder lock.
		mkdirSync(lockDir, { recursive: true });
		writeFileSync(
			join(lockDir, "holder"),
			JSON.stringify({ pid: 1, at: Date.now() }),
		);
		const { status, stderr } = runExpectFail(["use", "personal"], {
			FLYWHEEL_CLAUDE_LOCK_DELEGATED: "1", // matches holder, NOT our parent
			FLYWHEEL_CLAUDE_LOCK_TIMEOUT_MS: "300",
		});
		expect(status).not.toBe(0);
		expect(stderr).toContain("timeout acquiring lock");
		expect(readFileSync(stateFile, "utf-8")).toBe(SECRET_CUR); // untouched
		rmSync(lockDir, { recursive: true, force: true });
	});

	it("lock delegation: a FORGED env (pid not the live holder) falls through to a normal acquire → times out", () => {
		mkdirSync(lockDir, { recursive: true });
		writeFileSync(
			join(lockDir, "holder"),
			JSON.stringify({ pid: process.pid, at: Date.now() }), // live holder = us
		);
		const { status, stderr } = runExpectFail(["use", "personal"], {
			FLYWHEEL_CLAUDE_LOCK_DELEGATED: "424242", // NOT the holder
			FLYWHEEL_CLAUDE_LOCK_TIMEOUT_MS: "300",
		});
		expect(status).not.toBe(0);
		expect(stderr).toContain("timeout acquiring lock");
		expect(readFileSync(stateFile, "utf-8")).toBe(SECRET_CUR); // untouched
		rmSync(lockDir, { recursive: true, force: true });
	});

	it("lock: held by a LIVE holder is never age-stolen → times out fail-closed", () => {
		mkdirSync(lockDir, { recursive: true });
		writeFileSync(
			join(lockDir, "holder"),
			JSON.stringify({ pid: process.pid, at: Date.now() - 300_000 }),
		);
		const { status, stderr } = runExpectFail(["use", "personal"], {
			FLYWHEEL_CLAUDE_LOCK_TIMEOUT_MS: "300",
		});
		expect(status).not.toBe(0);
		expect(stderr).toContain("timeout acquiring lock");
		expect(readFileSync(stateFile, "utf-8")).toBe(SECRET_CUR); // untouched
	});

	it("lock: stale holder (dead pid) is broken and the switch proceeds", () => {
		mkdirSync(lockDir, { recursive: true });
		writeFileSync(
			join(lockDir, "holder"),
			JSON.stringify({ pid: 999999, at: Date.now() - 300_000 }), // dead + old
		);
		run(["use", "personal"], { FLYWHEEL_CLAUDE_LOCK_TIMEOUT_MS: "2000" });
		expect(readFileSync(stateFile, "utf-8")).toBe(SECRET_A);
	});

	it("lock: a stale breaker never removes a successor directory created after inspection", () => {
		mkdirSync(lockDir, { recursive: true });
		const staleMarker = join(lockDir, "holder");
		writeFileSync(
			staleMarker,
			JSON.stringify({ pid: 999999, at: Date.now() - 300_000 }),
		);
		const shimDir = join(tmp, "race-shims");
		mkdirSync(shimDir);
		writeFileSync(
			join(shimDir, "mv"),
			`#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "$RACE_STALE_MARKER" && ! -e "$RACE_ONCE" ]]; then
  : > "$RACE_ONCE"
  /bin/rm "$RACE_STALE_MARKER"
  /bin/rmdir "$RACE_LOCK_DIR"
  /bin/mkdir "$RACE_LOCK_DIR"
fi
/bin/mv "$@"
`,
			{ mode: 0o755 },
		);

		const { status, stderr } = runExpectFail(["use", "personal"], {
			PATH: `${shimDir}:${process.env.PATH ?? ""}`,
			RACE_STALE_MARKER: staleMarker,
			RACE_LOCK_DIR: lockDir,
			RACE_ONCE: join(tmp, "race-once"),
			FLYWHEEL_CLAUDE_LOCK_TIMEOUT_MS: "250",
		});

		expect(status).not.toBe(0);
		expect(stderr).toContain("timeout acquiring lock");
		expect(readFileSync(stateFile, "utf8")).toBe(SECRET_CUR);
		expect(existsSync(lockDir)).toBe(true);
	});

	it("lock is RELEASED after a successful command (next run acquires instantly)", () => {
		run(["use", "personal"]);
		expect(existsSync(lockDir)).toBe(false);
		run(["use", "school"], { FLYWHEEL_CLAUDE_LOCK_TIMEOUT_MS: "300" });
		expect(readFileSync(stateFile, "utf-8")).toBe(SECRET_B);
	});

	describe("FLY-1252 transition journal", () => {
		it("persists before Keychain mutation and clears after a successful commit", () => {
			run(["use", "personal"]);
			expect(existsSync(transitionJournal)).toBe(false);
			expect(readFileSync(stateFile, "utf8")).toBe(SECRET_A);
		});

		it("clears an abandoned journal when Keychain still has the old digest", () => {
			seedTransitionJournal();
			const result = JSON.parse(run(["reconcile-journal"]).trim());
			expect(result).toEqual({ outcome: "cleared" });
			expect(existsSync(transitionJournal)).toBe(false);
			expect(readFileSync(stateFile, "utf8")).toBe(SECRET_CUR);
		});

		it("completes .active + store when Keychain has the target digest", () => {
			writeFileSync(stateFile, SECRET_A);
			writeFileSync(join(pool, ".active"), "school");
			writeFileSync(
				accountsStore,
				JSON.stringify({
					generation: 3,
					activeAccount: "school",
					accounts: [
						{
							name: "personal",
							quotaExhaustedUntil: null,
							weeklyResetAt: null,
						},
						{ name: "school", quotaExhaustedUntil: null, weeklyResetAt: null },
					],
				}),
			);
			const syncBin = join(tmp, "sync-store");
			writeFileSync(
				syncBin,
				`#!/usr/bin/env bash
set -euo pipefail
node -e 'const fs=require("fs"); const [path,name]=process.argv.slice(1); const s=JSON.parse(fs.readFileSync(path,"utf8")); if(s.activeAccount!==name){s.activeAccount=name;s.generation+=1;} fs.writeFileSync(path,JSON.stringify(s));' "$5" "$3"
`,
				{ mode: 0o755 },
			);
			seedTransitionJournal();

			const result = JSON.parse(
				run(["reconcile-journal"], {
					FLYWHEEL_CLAUDE_QUOTA_GUARD_BIN: syncBin,
				}).trim(),
			);
			expect(result).toEqual({
				outcome: "completed",
				activeAccount: "personal",
				generation: 4,
			});
			expect(readFileSync(join(pool, ".active"), "utf8")).toBe("personal");
			expect(JSON.parse(readFileSync(accountsStore, "utf8"))).toMatchObject({
				generation: 4,
				activeAccount: "personal",
			});
			expect(existsSync(transitionJournal)).toBe(false);
		});

		it("keeps the journal and blocks while any writer-group process is alive", () => {
			const child = spawn(
				process.execPath,
				["-e", "setTimeout(()=>{},30000)"],
				{
					detached: true,
					stdio: "ignore",
				},
			);
			if (!child.pid) throw new Error("missing detached child pid");
			try {
				seedTransitionJournal({ writerPgid: child.pid, leaderPid: child.pid });
				const result = JSON.parse(run(["reconcile-journal"]).trim());
				expect(result).toEqual({ outcome: "writer_alive" });
				expect(existsSync(transitionJournal)).toBe(true);
			} finally {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					// already gone
				}
			}
		});

		it("manual mutation runs under a dedicated group whose leader owns the journal", async () => {
			const pause = join(tmp, "journal-pause");
			const psStub = join(tmp, "fake-ps");
			writeFileSync(
				psStub,
				`#!/usr/bin/env bash
case "$*" in
  *"lstart="*) printf '%s\n' "Thu Jul 16 15:00:00 2026" ;;
  *) exit 1 ;;
esac
`,
				{ mode: 0o755 },
			);
			const caller = spawn("bash", [PROFILE_BIN, "use", "personal"], {
				env: env({
					FLYWHEEL_TEST_PAUSE_AFTER_JOURNAL: pause,
					FLYWHEEL_CLAUDE_PS_BIN: psStub,
				}),
				stdio: "ignore",
			});
			const waitFor = async (condition: () => boolean) => {
				for (let i = 0; i < 500; i++) {
					if (condition()) return true;
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				return false;
			};
			try {
				expect(await waitFor(() => existsSync(`${pause}.ready`))).toBe(true);
				const journal = JSON.parse(readFileSync(transitionJournal, "utf8"));
				const markerName = readdirSync(lockDir).find((name) =>
					name.startsWith("holder."),
				);
				if (!markerName) throw new Error("bash lock marker missing");
				const marker = JSON.parse(
					readFileSync(join(lockDir, markerName), "utf8"),
				);
				expect(marker.processStartTime).toEqual(expect.any(String));
				expect(marker.processStartTime.length).toBeGreaterThan(0);
				expect(journal.writerPgid).toBe(journal.leaderPid);
				expect(journal.leaderPid).not.toBe(caller.pid);
				writeFileSync(`${pause}.continue`, "go");
				const exitCode = await new Promise<number | null>((resolve) =>
					caller.once("exit", resolve),
				);
				expect(exitCode).toBe(0);
				expect(existsSync(transitionJournal)).toBe(false);
			} finally {
				if (caller.exitCode === null) caller.kill("SIGKILL");
			}
		}, 15_000);

		it("fails closed and preserves a journal when Keychain matches neither digest", () => {
			writeFileSync(stateFile, SECRET_B);
			seedTransitionJournal();
			const result = JSON.parse(run(["reconcile-journal"]).trim());
			expect(result).toEqual({
				outcome: "conflict",
				reason: "digest_mismatch_both",
			});
			expect(existsSync(transitionJournal)).toBe(true);
		});

		it("capture of the journal target recovers a re-login digest conflict", () => {
			// The operator followed the recovery instruction and logged into the
			// journal target before capturing its newly-issued credential.
			writeFileSync(stateFile, SECRET_RELOGIN_PERSONAL);
			writeFileSync(
				accountsStore,
				JSON.stringify({
					generation: 3,
					activeAccount: "school",
					accounts: [
						{
							name: "personal",
							quotaExhaustedUntil: null,
							weeklyResetAt: null,
						},
						{ name: "school", quotaExhaustedUntil: null, weeklyResetAt: null },
					],
				}),
			);
			const syncBin = join(tmp, "capture-recovery-sync-store");
			writeFileSync(
				syncBin,
				`#!/usr/bin/env bash
set -euo pipefail
node -e 'const fs=require("fs"); const [path,name]=process.argv.slice(1); const s=JSON.parse(fs.readFileSync(path,"utf8")); if(s.activeAccount!==name){s.activeAccount=name;s.generation+=1;} fs.writeFileSync(path,JSON.stringify(s));' "$5" "$3"
`,
				{ mode: 0o755 },
			);
			seedTransitionJournal();

			const output = run(["capture", "personal"], {
				FLYWHEEL_CLAUDE_QUOTA_GUARD_BIN: syncBin,
			});

			expect(output).toContain("Recovered transition journal");
			expect(
				readFileSync(join(pool, "personal", ".credentials.json"), "utf8"),
			).toBe(SECRET_RELOGIN_PERSONAL);
			expect(readFileSync(join(pool, ".active"), "utf8")).toBe("personal");
			expect(JSON.parse(readFileSync(accountsStore, "utf8"))).toMatchObject({
				generation: 4,
				activeAccount: "personal",
			});
			expect(existsSync(transitionJournal)).toBe(false);
		});

		it("journal recovery tells the operator to log into the target before capture", () => {
			writeFileSync(stateFile, SECRET_B);
			seedTransitionJournal();

			const { status, stderr } = runExpectFail(["capture", "school"]);

			expect(status).not.toBe(0);
			expect(stderr).toContain("log into 'personal' first");
			expect(stderr).toContain("capture personal");
			expect(existsSync(transitionJournal)).toBe(true);
		});
	});
});

describe("flywheel-claude-profile — identity proof (FLY-1182)", () => {
	it("verify pool probes the token against its anchor without exposing the token in curl argv", () => {
		seedAnchor("personal", "uuid-personal", EMAILS.personal);

		const { stdout } = runBoth(["verify", "personal", "--source", "pool"]);

		expect(stdout).toContain("match");
		expect(stdout).toContain("x***@gmail.com");
		const argv = readFileSync(identityCurlArgvLog, "utf-8");
		expect(argv).toContain("--config -");
		expect(argv).not.toContain("sk-ant-oat01");
	});

	it("target identity assertion C maps mismatch/untracked/unavailable to 86/87/88 with zero mutation", () => {
		const beforeDisplay = readFileSync(claudeJson, "utf-8");

		seedAnchor("personal", "wrong-uuid", "wrong@example.com");
		let result = runExpectFail(["use", "personal"]);
		expect(result.status).toBe(86);
		expect(readFileSync(stateFile, "utf-8")).toBe(SECRET_CUR);
		expect(existsSync(join(pool, ".active"))).toBe(false);
		expect(readFileSync(claudeJson, "utf-8")).toBe(beforeDisplay);

		rmSync(join(pool, "personal", "identity-anchor.json"));
		result = runExpectFail(["use", "personal"]);
		expect(result.status).toBe(87);
		expect(readFileSync(stateFile, "utf-8")).toBe(SECRET_CUR);
		expect(existsSync(join(pool, ".active"))).toBe(false);

		seedAnchor("personal", "uuid-personal", EMAILS.personal);
		const unavailableCurl = join(tmp, "identity-curl-unavailable");
		writeFileSync(unavailableCurl, "#!/bin/sh\ncat >/dev/null\nexit 22\n", {
			mode: 0o755,
		});
		result = runExpectFail(["use", "personal"], {
			FLYWHEEL_PROFILE_CURL_BIN: unavailableCurl,
		});
		expect(result.status).toBe(88);
		expect(readFileSync(stateFile, "utf-8")).toBe(SECRET_CUR);
		expect(existsSync(join(pool, ".active"))).toBe(false);
		expect(readFileSync(claudeJson, "utf-8")).toBe(beforeDisplay);
	});

	it("active identity assertion B captures only matches and emits one stable marker for every non-match branch", () => {
		// match → capture-back is allowed
		writeFileSync(join(pool, ".active"), "personal");
		writeFileSync(stateFile, SECRET_PERSONAL_REFRESHED);
		let switched = runBoth(["use", "school"]);
		expect(switched.stderr).not.toContain("FLYWHEEL_ACTIVE_IDENTITY_DRIFT");
		expect(
			readFileSync(join(pool, "personal", ".credentials.json"), "utf-8"),
		).toBe(SECRET_PERSONAL_REFRESHED);

		// mismatch → skip capture-back, repair drift by writing verified target
		writeFileSync(join(pool, ".active"), "personal");
		writeFileSync(join(pool, "personal", ".credentials.json"), SECRET_A);
		writeFileSync(stateFile, SECRET_DRIFT);
		switched = runBoth(["use", "school"]);
		expect(readFileSync(stateFile, "utf-8")).toBe(SECRET_B);
		expect(readFileSync(join(pool, ".active"), "utf-8")).toBe("school");
		expect(
			readFileSync(join(pool, "personal", ".credentials.json"), "utf-8"),
		).toBe(SECRET_A);
		let markers = switched.stderr
			.split("\n")
			.filter((line) => line.startsWith("FLYWHEEL_ACTIVE_IDENTITY_DRIFT "));
		expect(markers).toHaveLength(1);
		expect(JSON.parse(markers[0].split(" ", 2)[1])).toEqual({
			version: 1,
			reason: "mismatch",
			label: "personal",
			expectedUuid: "uuid-personal",
			observedEmailRedacted: "d***@example.com",
		});

		// untracked → skip capture-back, expectedUuid is explicitly null
		writeFileSync(join(pool, ".active"), "personal");
		writeFileSync(stateFile, SECRET_A);
		rmSync(join(pool, "personal", "identity-anchor.json"));
		switched = runBoth(["use", "school"]);
		markers = switched.stderr
			.split("\n")
			.filter((line) => line.startsWith("FLYWHEEL_ACTIVE_IDENTITY_DRIFT "));
		expect(markers).toHaveLength(1);
		expect(JSON.parse(markers[0].split(" ", 2)[1])).toMatchObject({
			version: 1,
			reason: "untracked",
			label: "personal",
			expectedUuid: null,
		});
		expect(
			readFileSync(join(pool, "personal", ".credentials.json"), "utf-8"),
		).toBe(SECRET_A);

		// unavailable → C succeeds first, B probe fails second; switch still repairs
		seedAnchor("personal", "uuid-personal", EMAILS.personal);
		writeFileSync(join(pool, ".active"), "personal");
		writeFileSync(stateFile, SECRET_A);
		const callCount = join(tmp, "identity-curl-call-count");
		const secondCallFails = join(tmp, "identity-curl-second-call-fails");
		writeFileSync(
			secondCallFails,
			`#!/usr/bin/env bash
set -euo pipefail
n=0; [[ -f "${callCount}" ]] && n=$(cat "${callCount}")
n=$((n + 1)); printf '%s' "$n" > "${callCount}"
cat >/dev/null
if [[ "$n" -eq 1 ]]; then printf '%s' '${JSON.stringify({ account: IDENTITY_PROFILES["sk-ant-oat01-BBB"] })}'; else exit 22; fi
`,
			{ mode: 0o755 },
		);
		switched = runBoth(["use", "school"], {
			FLYWHEEL_PROFILE_CURL_BIN: secondCallFails,
		});
		markers = switched.stderr
			.split("\n")
			.filter((line) => line.startsWith("FLYWHEEL_ACTIVE_IDENTITY_DRIFT "));
		expect(markers).toHaveLength(1);
		expect(JSON.parse(markers[0].split(" ", 2)[1])).toEqual({
			version: 1,
			reason: "unavailable",
			label: "personal",
			expectedUuid: "uuid-personal",
			observedEmailRedacted: null,
		});
		expect(readFileSync(stateFile, "utf-8")).toBe(SECRET_B);
	});

	it("capture bootstraps only a truly empty mapped slot and refuses legacy credentials without an anchor", () => {
		seedIdentityMap();
		writeFileSync(stateFile, SECRET_BIZ);
		writeFileSync(claudeJson, claudeJsonWith(IDENTITY_BIZ));

		run(["capture", "business"]);
		expect(
			JSON.parse(
				readFileSync(join(pool, "business", "identity-anchor.json"), "utf-8"),
			),
		).toMatchObject({
			accountUuid: "uuid-biz",
			email: EMAILS.business,
			confirmedBy: "identity-map-test-v1",
		});
		expect(
			readFileSync(join(pool, "business", ".credentials.json"), "utf-8"),
		).toBe(SECRET_BIZ);
		expect(
			JSON.parse(
				readFileSync(join(pool, "business", "oauthAccount.json"), "utf-8"),
			).accountUuid,
		).toBe("uuid-biz");

		// Existing credential + display metadata but missing anchor is a legacy
		// migration state, never a bootstrap state.
		writeFileSync(join(pool, "personal", "oauthAccount.json"), "{}", {
			mode: 0o600,
		});
		rmSync(join(pool, "personal", "identity-anchor.json"));
		const beforeCredential = readFileSync(
			join(pool, "personal", ".credentials.json"),
			"utf-8",
		);
		const result = runExpectFail(["capture", "personal"]);
		expect(result.status).toBe(87);
		expect(
			readFileSync(join(pool, "personal", ".credentials.json"), "utf-8"),
		).toBe(beforeCredential);
		expect(existsSync(join(pool, "personal", "identity-anchor.json"))).toBe(
			false,
		);

		// Both bootstrap proofs are mandatory. A display/token mismatch fails
		// before even creating the new slot.
		const shoppingDir = join(pool, "shopping");
		writeFileSync(claudeJson, claudeJsonWith(IDENTITY_BIZ));
		const displayMismatch = runExpectFail(["capture", "shopping"]);
		expect(displayMismatch.status).toBe(86);
		expect(existsSync(shoppingDir)).toBe(false);

		// Even when display and token agree, the canonical label mapping must too.
		seedIdentityMap({ shopping: "not-current@example.com" });
		writeFileSync(
			claudeJson,
			claudeJsonWith({
				accountUuid: "uuid-current",
				emailAddress: "current@example.com",
				organizationUuid: "org-current",
				organizationName: "Current Org",
			}),
		);
		const mappingMismatch = runExpectFail(["capture", "shopping"]);
		expect(mappingMismatch.status).toBe(87);
		expect(existsSync(shoppingDir)).toBe(false);
	});

	it("anchor migration and replacement require live proof, canonical evidence, and explicit replacement confirmation", () => {
		seedIdentityMap();
		writeFileSync(stateFile, SECRET_A);
		writeFileSync(
			claudeJson,
			claudeJsonWith({
				accountUuid: "uuid-personal",
				emailAddress: EMAILS.personal,
				organizationUuid: "org-personal",
				organizationName: "Personal Org",
			}),
		);
		writeFileSync(
			join(pool, "personal", "oauthAccount.json"),
			JSON.stringify({
				accountUuid: "legacy",
				emailAddress: "legacy@example.com",
				organizationUuid: "legacy-org",
				organizationName: "Legacy Org",
			}),
			{ mode: 0o600 },
		);
		rmSync(join(pool, "personal", "identity-anchor.json"));

		run(["anchor", "personal", "--migrate"]);
		let anchor = JSON.parse(
			readFileSync(join(pool, "personal", "identity-anchor.json"), "utf-8"),
		);
		expect(anchor).toMatchObject({
			accountUuid: "uuid-personal",
			email: EMAILS.personal,
			confirmedBy: "identity-map-test-v1",
		});
		const migratedAnchor = anchor;

		// Existing anchors cannot be silently re-anchored.
		let result = runExpectFail(["anchor", "personal", "--replace"]);
		expect(result.status).not.toBe(0);
		expect(
			JSON.parse(
				readFileSync(join(pool, "personal", "identity-anchor.json"), "utf-8"),
			),
		).toEqual(anchor);

		run(["anchor", "personal", "--replace"], {
			FLYWHEEL_PROFILE_REANCHOR_CONFIRM: "personal",
		});
		anchor = JSON.parse(
			readFileSync(join(pool, "personal", "identity-anchor.json"), "utf-8"),
		);
		expect(anchor.accountUuid).toBe("uuid-personal");
		expect(anchor.email).toBe(EMAILS.personal);
		const replacementAudit = readFileSync(auditLog, "utf-8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
			.at(-1);
		expect(replacementAudit).toMatchObject({
			probeSummary: "match",
			details: {
				oldAnchor: migratedAnchor,
				newAnchor: anchor,
				artifactId: "identity-map-test-v1",
				confirmationReference: "env:FLYWHEEL_PROFILE_REANCHOR_CONFIRM=personal",
			},
		});
		expect(replacementAudit.details.identityMapSha256).toMatch(
			/^[a-f0-9]{64}$/,
		);

		result = runExpectFail(
			["anchor", "personal", "--replace", "--evidence", "relative-map.json"],
			{
				FLYWHEEL_PROFILE_REANCHOR_CONFIRM: "personal",
			},
		);
		expect(result.status).not.toBe(0);
	});

	it("canonical identity maps and anchors reject schema drift, wide modes, and symlinks", () => {
		seedIdentityMap();
		writeFileSync(stateFile, SECRET_A);
		writeFileSync(
			claudeJson,
			claudeJsonWith({
				accountUuid: "uuid-personal",
				emailAddress: EMAILS.personal,
				organizationUuid: "org-personal",
				organizationName: "Personal Org",
			}),
		);
		writeFileSync(join(pool, "personal", "oauthAccount.json"), "{}", {
			mode: 0o600,
		});
		rmSync(join(pool, "personal", "identity-anchor.json"));
		const mapPath = join(pool, "identity-map.json");

		const mapWithExtra = JSON.parse(readFileSync(mapPath, "utf-8"));
		mapWithExtra.labels.unknown = "unknown@example.com";
		writeFileSync(mapPath, JSON.stringify(mapWithExtra), { mode: 0o600 });
		expect(runExpectFail(["anchor", "personal", "--migrate"]).status).toBe(87);

		seedIdentityMap();
		chmodSync(mapPath, 0o644);
		expect(runExpectFail(["anchor", "personal", "--migrate"]).status).toBe(87);

		const realMap = join(tmp, "real-identity-map.json");
		seedIdentityMap();
		writeFileSync(realMap, readFileSync(mapPath), { mode: 0o600 });
		rmSync(mapPath);
		symlinkSync(realMap, mapPath);
		expect(runExpectFail(["anchor", "personal", "--migrate"]).status).toBe(87);

		// An anchor with any extra key is untracked, never partially accepted.
		rmSync(mapPath);
		seedAnchor("personal", "uuid-personal", EMAILS.personal);
		const anchorPath = join(pool, "personal", "identity-anchor.json");
		const anchorWithExtra = JSON.parse(readFileSync(anchorPath, "utf-8"));
		anchorWithExtra.note = "unexpected";
		writeFileSync(anchorPath, JSON.stringify(anchorWithExtra), { mode: 0o600 });
		expect(
			runExpectFail(["verify", "personal", "--source", "pool"]).status,
		).toBe(87);
		chmodSync(anchorPath, 0o644);
		expect(
			runExpectFail(["verify", "personal", "--source", "pool"]).status,
		).toBe(87);
	});

	it("mutating commands append safe entry+exit audit records and refuse an unsafe audit target before mutation", () => {
		run(["use", "personal"], {
			FLYWHEEL_AUDIT_ACTOR: "operator\ncontrolled-line",
		});
		const raw = readFileSync(auditLog, "utf-8");
		const lines = raw.trim().split("\n");
		expect(lines).toHaveLength(2);
		const records = lines.map((line) => JSON.parse(line));
		expect(records.map((record) => record.phase)).toEqual(["entry", "exit"]);
		expect(records[0]).toMatchObject({
			cmd: "use",
			profile: "personal",
			actor: "operator\ncontrolled-line",
		});
		expect(records[1]).toMatchObject({
			cmd: "use",
			profile: "personal",
			exitCode: 0,
		});
		expect(statSync(auditLog).mode & 0o777).toBe(0o600);
		expect(raw).not.toContain("sk-ant-oat01");
		expect(raw).not.toContain("accessToken");
		writeFileSync(auditLog, "", { mode: 0o600 });
		run(["next"]);
		const nextRecords = readFileSync(auditLog, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(nextRecords).toHaveLength(2);
		// Candidate loops do not know which profile will pass live quota until
		// after the entry audit. The exit record carries the actual committed one.
		expect(nextRecords[0]).toMatchObject({ cmd: "next", profile: null });
		expect(nextRecords[1]).toMatchObject({
			cmd: "next",
			profile: "school",
			exitCode: 0,
		});

		// Existing wide-mode files are not grandfathered by umask: entry audit
		// must fail before a mutating command can touch the Keychain.
		writeFileSync(stateFile, SECRET_CUR);
		rmSync(join(pool, ".active"), { force: true });
		chmodSync(auditLog, 0o644);
		const result = runExpectFail(["use", "personal"]);
		expect(result.status).not.toBe(0);
		expect(readFileSync(stateFile, "utf-8")).toBe(SECRET_CUR);
		expect(existsSync(join(pool, ".active"))).toBe(false);

		// A symlink target is equally unsafe and its referent remains untouched.
		const referent = join(tmp, "audit-referent");
		writeFileSync(referent, "sentinel", { mode: 0o600 });
		rmSync(auditLog);
		symlinkSync(referent, auditLog);
		const symlinked = runExpectFail(["use", "personal"]);
		expect(symlinked.status).not.toBe(0);
		expect(readFileSync(referent, "utf-8")).toBe("sentinel");
		expect(readFileSync(stateFile, "utf-8")).toBe(SECRET_CUR);
	});

	it("EXIT audit failure preserves the original failure code and still releases the lock", () => {
		seedAnchor("personal", "wrong-uuid", EMAILS.personal);
		const binDir = join(tmp, "audit-exit-stubbin");
		mkdirSync(binDir);
		writeFileSync(
			join(binDir, "node"),
			`#!/bin/sh
case "$*" in
  *"$FLYWHEEL_PROFILE_AUDIT_LOG exit "*) exit 70 ;;
esac
exec "$FLYWHEEL_REAL_NODE" "$@"
`,
			{ mode: 0o755 },
		);
		const result = runExpectFail(["use", "personal"], {
			FLYWHEEL_REAL_NODE: process.execPath,
			PATH: `${binDir}:${process.env.PATH ?? ""}`,
		});
		expect(result.status).toBe(86);
		expect(existsSync(lockDir)).toBe(false);
		const records = readFileSync(auditLog, "utf-8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(records).toHaveLength(1);
		expect(records[0].phase).toBe("entry");
	});

	it("identity bypass is a loud manual-only escape hatch and is denied on delegated automatic switches", () => {
		// Human/manual path: old behavior is available explicitly even when the
		// target cannot be anchored/probed.
		rmSync(join(pool, "personal", "identity-anchor.json"));
		const unavailableCurl = join(tmp, "identity-bypass-unavailable-curl");
		writeFileSync(unavailableCurl, "#!/bin/sh\ncat >/dev/null\nexit 22\n", {
			mode: 0o755,
		});
		const manual = runBoth(["use", "personal"], {
			FLYWHEEL_PROFILE_IDENTITY_BYPASS: "1",
			FLYWHEEL_PROFILE_CURL_BIN: unavailableCurl,
		});
		expect(manual.stderr).toMatch(/IDENTITY_BYPASS|identity.*bypass/i);
		expect(readFileSync(stateFile, "utf-8")).toBe(SECRET_A);
		const manualAudit = readFileSync(auditLog, "utf-8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(manualAudit.at(-1).probeSummary).toBe("bypass_requested");

		// Automatic/delegated path: even inherited bypass=1 is rejected before
		// Keychain mutation and leaves an auditable denied result.
		writeFileSync(stateFile, SECRET_CUR);
		rmSync(join(pool, ".active"), { force: true });
		writeFileSync(auditLog, "", { mode: 0o600 });
		mkdirSync(lockDir, { recursive: true });
		writeFileSync(
			join(lockDir, "holder"),
			JSON.stringify({ pid: process.pid, at: Date.now() }),
		);
		const denied = runExpectFail(["use", "personal"], {
			FLYWHEEL_PROFILE_IDENTITY_BYPASS: "1",
			FLYWHEEL_CLAUDE_LOCK_DELEGATED: String(process.pid),
		});
		expect(denied.status).toBe(88);
		expect(readFileSync(stateFile, "utf-8")).toBe(SECRET_CUR);
		expect(existsSync(join(pool, ".active"))).toBe(false);
		const deniedAudit = readFileSync(auditLog, "utf-8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(deniedAudit.at(-1)).toMatchObject({
			probeSummary: "bypass_denied",
			exitCode: 88,
		});
		rmSync(lockDir, { recursive: true, force: true });
	});
});

/**
 * FLY-865 — the switch must ALSO swap the display identity: `use` writes the
 * captured `oauthAccount` back into ~/.claude.json (the source /status reads),
 * and `capture` snapshots that identity beside the pooled token. All identity
 * IO is best-effort (token switch is authoritative) and never touches the real
 * ~/.claude.json — env() always points FLYWHEEL_CLAUDE_JSON at a scratch file.
 */
describe("flywheel-claude-profile — display identity sync (FLY-865)", () => {
	const identityFile = (name: string) => join(pool, name, "oauthAccount.json");
	function seedIdentity(name: string, identity: unknown): void {
		mkdirSync(join(pool, name), { recursive: true });
		writeFileSync(identityFile(name), JSON.stringify(identity), {
			mode: 0o600,
		});
	}
	const readOauth = () =>
		JSON.parse(readFileSync(claudeJson, "utf-8")).oauthAccount;

	it("`capture` snapshots the current ~/.claude.json oauthAccount beside the token (0600) + echoes email", () => {
		// scratch ~/.claude.json currently holds the BIZ identity.
		seedIdentityMap();
		writeFileSync(stateFile, SECRET_BIZ);
		writeFileSync(claudeJson, claudeJsonWith(IDENTITY_BIZ));
		const { stdout, stderr } = runBoth(["capture", "business"]);
		// token still captured (existing behavior):
		expect(
			readFileSync(join(pool, "business", ".credentials.json"), "utf-8"),
		).toBe(SECRET_BIZ);
		// identity captured beside it, 0600:
		expect(JSON.parse(readFileSync(identityFile("business"), "utf-8"))).toEqual(
			IDENTITY_BIZ,
		);
		expect(statSync(identityFile("business")).mode & 0o777).toBe(0o600);
		// the email is echoed for operator eyeballing (stdout or stderr):
		expect(stdout + stderr).toContain(EMAILS.business);
	});

	it("`capture` with no/invalid target oauthAccount DELETES any stale identity file (no stale pairing) + still captures token + exit 0", () => {
		// business already has a (stale) identity from a prior capture…
		seedAnchor("business", "uuid-current", "current@example.com");
		seedIdentity("business", IDENTITY_BIZ);
		// …but the current ~/.claude.json has NO oauthAccount now.
		writeFileSync(claudeJson, JSON.stringify({ numStartups: 1 }));
		const { stderr } = runBoth(["capture", "business"]);
		// token captured…
		expect(
			readFileSync(join(pool, "business", ".credentials.json"), "utf-8"),
		).toBe(SECRET_CUR);
		// …but the stale identity file is REMOVED (never pair a new token with old identity).
		expect(existsSync(identityFile("business"))).toBe(false);
		expect(stderr).toMatch(/no display identity|capture/i);
	});

	it("`use` with a captured identity swaps ~/.claude.json oauthAccount, preserves every other key, keeps mode, stdout unchanged", () => {
		seedIdentity("personal", IDENTITY_BIZ);
		chmodSync(claudeJson, 0o600);
		const before = JSON.parse(readFileSync(claudeJson, "utf-8"));
		const out = run(["use", "personal"]);
		// stdout contract unchanged (single Switched line):
		expect(out).toContain(
			"Switched machine Claude account to profile 'personal'",
		);
		// oauthAccount became BIZ:
		expect(readOauth()).toEqual(IDENTITY_BIZ);
		// every OTHER top-level key semantically preserved:
		const after = JSON.parse(readFileSync(claudeJson, "utf-8"));
		expect(after.numStartups).toBe(before.numStartups);
		expect(after.mcpServers).toEqual(before.mcpServers);
		expect(after.projects).toEqual(before.projects);
		expect(after.tail).toBe(before.tail);
		// mode preserved:
		expect(statSync(claudeJson).mode & 0o777).toBe(0o600);
		// token switched too:
		expect(readFileSync(stateFile, "utf-8")).toBe(SECRET_A);
	});

	it("`use` with NO captured identity: loud warn, ~/.claude.json untouched, token switched, exit 0 (RED LINE: no regression)", () => {
		const before = readFileSync(claudeJson, "utf-8");
		const { stdout, stderr } = runBoth(["use", "personal"]);
		expect(stdout).toContain(
			"Switched machine Claude account to profile 'personal'",
		);
		expect(stderr).toMatch(/capture/i); // tells operator how to fix
		expect(readFileSync(claudeJson, "utf-8")).toBe(before); // untouched
		expect(readFileSync(stateFile, "utf-8")).toBe(SECRET_A); // token switched
	});

	it("`use` refuses a source identity that is not a valid object (null/string/missing email) — target untouched, exit 0", () => {
		const before = readFileSync(claudeJson, "utf-8");
		for (const bad of ["null", '"a-string"', '{"emailAddress":"x"}']) {
			mkdirSync(join(pool, "personal"), { recursive: true });
			writeFileSync(identityFile("personal"), bad, { mode: 0o600 });
			const { stderr } = runBoth(["use", "personal"]);
			expect(readFileSync(claudeJson, "utf-8"), `bad src ${bad}`).toBe(before);
			expect(stderr, `bad src ${bad}`).toMatch(/identit|invalid|display/i);
			rmSync(identityFile("personal"), { force: true });
		}
	});

	it("`use` refuses to overwrite a ~/.claude.json that is not valid JSON — bytes unchanged, exit 0", () => {
		seedIdentity("personal", IDENTITY_BIZ);
		writeFileSync(claudeJson, "not-json-at-all{{{");
		const { stderr } = runBoth(["use", "personal"]);
		expect(readFileSync(claudeJson, "utf-8")).toBe("not-json-at-all{{{");
		expect(stderr).toMatch(/identit|display|json/i);
		expect(readFileSync(stateFile, "utf-8")).toBe(SECRET_A); // token still switched
	});

	it("`use` refuses a symlinked oauthAccount.json / symlinked ~/.claude.json — not written, exit 0", () => {
		// symlinked identity file:
		seedIdentity("real", IDENTITY_BIZ);
		mkdirSync(join(pool, "personal"), { recursive: true });
		symlinkSync(identityFile("real"), identityFile("personal"));
		const before = readFileSync(claudeJson, "utf-8");
		const r1 = runBoth(["use", "personal"]);
		expect(readFileSync(claudeJson, "utf-8")).toBe(before);
		expect(r1.stderr).toMatch(/symlink|identit|display/i);
		rmSync(identityFile("personal"), { force: true });

		// symlinked ~/.claude.json:
		seedIdentity("school", IDENTITY_BIZ);
		const realJson = join(tmp, "real-claude.json");
		writeFileSync(realJson, claudeJsonWith(IDENTITY_SHOP));
		rmSync(claudeJson, { force: true });
		symlinkSync(realJson, claudeJson);
		const r2 = runBoth(["use", "school"]);
		// target (through the symlink) unchanged — the real file still SHOP:
		expect(readOauth()).toEqual(IDENTITY_SHOP);
		expect(r2.stderr).toMatch(/symlink|identit|display/i);
	});

	it("`use` refuses a group/world-readable oauthAccount.json (must be 0600/0400) — not written, exit 0", () => {
		seedIdentity("personal", IDENTITY_BIZ);
		chmodSync(identityFile("personal"), 0o644);
		const before = readFileSync(claudeJson, "utf-8");
		const { stderr } = runBoth(["use", "personal"]);
		expect(readFileSync(claudeJson, "utf-8")).toBe(before);
		expect(stderr).toMatch(/600|400|identit|display/i);
	});

	it("atomic + cleanup: a successful identity write leaves NO temp files behind", () => {
		seedIdentity("personal", IDENTITY_BIZ);
		run(["use", "personal"]);
		expect(readOauth()).toEqual(IDENTITY_BIZ);
		const leftovers = readdirSync(dirname(claudeJson)).filter(
			(f) =>
				f.startsWith("claude.json") &&
				f !== "claude.json" &&
				f !== "claude.json.lock",
		);
		expect(leftovers).toEqual([]);
	});

	it("claude-json lock held by a live holder: identity step times out → warn, ~/.claude.json untouched, but token/.active STILL switched, exit 0", () => {
		seedIdentity("personal", IDENTITY_BIZ);
		// Pre-hold the claude-json lock with a fresh live holder (this process).
		mkdirSync(claudeJsonLock, { recursive: true });
		writeFileSync(
			join(claudeJsonLock, "holder"),
			JSON.stringify({ pid: process.pid, at: Date.now() }),
		);
		const before = readFileSync(claudeJson, "utf-8");
		const { stdout, stderr } = runBoth(["use", "personal"], {
			CLAUDE_LOCK_WAIT_S: "1", // fail fast in the identity step
		});
		expect(stdout).toContain(
			"Switched machine Claude account to profile 'personal'",
		);
		expect(readFileSync(claudeJson, "utf-8")).toBe(before); // identity not written
		expect(readFileSync(stateFile, "utf-8")).toBe(SECRET_A); // token switched
		expect(readFileSync(join(pool, ".active"), "utf-8")).toBe("personal");
		expect(stderr).toMatch(/lock|identit|display/i);
		rmSync(claudeJsonLock, { recursive: true, force: true });
	});

	it("runs the identity path under macOS system /bin/bash (3.2) too (FLY-865 #6)", () => {
		if (!existsSync("/bin/bash")) return; // non-macOS CI: skip
		seedIdentity("personal", IDENTITY_BIZ);
		const out = run(["use", "personal"], {}, "/bin/bash");
		expect(out).toContain(
			"Switched machine Claude account to profile 'personal'",
		);
		expect(readOauth()).toEqual(IDENTITY_BIZ);
	});

	// Codex code R1#1: prove the GLOBAL EXIT trap releases the claude-json lock on
	// an abnormal exit even in FLY-852 delegated mode (acquire_lock returns early
	// without arming a per-acquire trap). We hold the lock at kill time by making
	// the identity `node` patch BLOCK: a `node` stub that just sleeps is put first
	// on PATH, so sync_identity acquires the claude-json lock and then stalls in
	// the patch. SIGTERM the shell → the global EXIT trap must free the lock.
	// (A FIFO can't be used as $CLAUDE_JSON — it fails the `-f` regular-file gate.)
	it("delegated mode: SIGTERM while holding the claude-json lock still releases it (global EXIT trap)", async () => {
		seedIdentity("personal", IDENTITY_BIZ);
		const lock = claudeJsonLock; // scratch claude.json is a regular file → passes `-f`
		// A `node` that ignores its args and blocks — makes the patch step stall
		// AFTER the lock is acquired. It records its own pid (which `exec sleep`
		// inherits) so cleanup can reap the orphaned sleep deterministically.
		const binDir = join(tmp, "stubbin");
		mkdirSync(binDir, { recursive: true });
		const stubPidFile = join(tmp, "stub.pid");
		writeFileSync(
			join(binDir, "node"),
			`#!/bin/sh
	last=""
	for arg in "$@"; do last="$arg"; done
	if test "$last" = "$FLYWHEEL_CLAUDE_JSON"; then
	  echo $$ > "$FLY865_STUB_PID"
	  exec sleep 20
	fi
	exec "$FLY865_REAL_NODE" "$@"
	`,
			{ mode: 0o755 },
		);
		// Delegated: pre-hold the ACCOUNTS lock as THIS process so the child's
		// acquire_lock returns early WITHOUT arming a per-acquire trap.
		mkdirSync(lockDir, { recursive: true });
		writeFileSync(
			join(lockDir, "holder"),
			JSON.stringify({ pid: process.pid, at: Date.now() }),
		);
		let childStderr = "";
		const child = spawn("bash", [PROFILE_BIN, "use", "personal"], {
			env: env({
				FLYWHEEL_CLAUDE_LOCK_DELEGATED: String(process.pid),
				FLY865_STUB_PID: stubPidFile,
				FLY865_REAL_NODE: process.execPath,
				PATH: `${binDir}:${process.env.PATH ?? ""}`,
			}),
			stdio: ["ignore", "ignore", "pipe"],
		});
		child.stderr?.on("data", (chunk) => {
			childStderr += String(chunk);
		});
		const waitFor = async (cond: () => boolean): Promise<boolean> => {
			for (let i = 0; i < 250; i++) {
				if (cond()) return true;
				await new Promise((r) => setTimeout(r, 20));
			}
			return cond();
		};
		// Wait for the sleeping patch child, not merely the mkdir. The lock becomes
		// visible a few instructions before the script records it as owned; using
		// directory existence alone made this test race the acquisition boundary.
		const reachedPatch = await waitFor(
			() => existsSync(lock) && existsSync(stubPidFile),
		);
		expect(reachedPatch, childStderr).toBe(true);
		child.kill("SIGTERM"); // just the shell
		// The global EXIT trap must have released the lock despite delegated mode.
		expect(await waitFor(() => !existsSync(lock))).toBe(true);
		// Cleanup: reap the orphaned sleep + kill the shell if still alive.
		try {
			const sleepPid = Number(readFileSync(stubPidFile, "utf-8").trim());
			if (sleepPid > 0) process.kill(sleepPid, "SIGKILL");
		} catch {
			/* stub already gone */
		}
		try {
			child.kill("SIGKILL");
		} catch {
			/* already dead */
		}
		rmSync(lockDir, { recursive: true, force: true });
	}, 15000);
});

/**
 * FLY-871 R1 — token freshness guard + capture-back. Before writing a NON-ACTIVE
 * target to the Keychain, `use` probe-refreshes its pooled token via a small Node
 * helper (faked here, exit-code contract) and captures the OLD active account's
 * live Keychain value back into its pool slot. A stale target / missing helper
 * fails CLOSED with the Keychain untouched — the 2026-07-04 logout root-cure.
 */
describe("flywheel-claude-profile — freshness guard + capture-back (FLY-871)", () => {
	/** A freshness stub with a fixed exit code (30 stale / 31 error / …). */
	function staleStub(code: number): string {
		const p = join(tmp, `fake-freshness-${code}`);
		writeFileSync(
			p,
			`#!/usr/bin/env bash\nset -u\nprintf '%s\\n' "$*" >> "$FRESH_ARGV_LOG"\nexit ${code}\n`,
			{ mode: 0o755 },
		);
		return p;
	}

	it("`use` invokes the freshness helper for a NON-ACTIVE target (verify --name --active --pool)", () => {
		run(["use", "personal"]); // active was empty → still verifies the target
		const log = readFileSync(freshLog, "utf-8");
		expect(log).toContain("verify");
		expect(log).toContain("--name personal");
		expect(log).toContain(`--pool ${pool}`);
		expect(readFileSync(stateFile, "utf-8")).toBe(SECRET_A); // switch happened
	});

	it("a STALE target (helper exit 30) → `use` exits 30, Keychain + .active UNTOUCHED", () => {
		const { status, stderr } = runExpectFail(["use", "personal"], {
			FLYWHEEL_CLAUDE_FRESHNESS_BIN: staleStub(30),
		});
		expect(status).toBe(30);
		expect(stderr).toContain("FLYWHEEL_TARGET_STALE personal");
		expect(readFileSync(stateFile, "utf-8")).toBe(SECRET_CUR); // never written
		expect(existsSync(join(pool, ".active"))).toBe(false);
	});

	it("a MISSING helper → `use` exits 31 fail-closed, Keychain + .active UNTOUCHED", () => {
		const { status, stderr } = runExpectFail(["use", "personal"], {
			FLYWHEEL_CLAUDE_FRESHNESS_BIN: join(tmp, "does-not-exist"),
		});
		expect(status).toBe(31);
		expect(stderr).toContain("FLYWHEEL_FRESHNESS_UNAVAILABLE personal");
		expect(readFileSync(stateFile, "utf-8")).toBe(SECRET_CUR);
		expect(existsSync(join(pool, ".active"))).toBe(false);
	});

	it("a helper exit code OTHER than 30 → treated as unavailable (31), fail-closed", () => {
		const { status, stderr } = runExpectFail(["use", "personal"], {
			FLYWHEEL_CLAUDE_FRESHNESS_BIN: staleStub(7),
		});
		expect(status).toBe(31);
		expect(stderr).toContain("FLYWHEEL_FRESHNESS_UNAVAILABLE personal");
		expect(readFileSync(stateFile, "utf-8")).toBe(SECRET_CUR);
	});

	it("EMERGENCY bypass (non-delegated): missing helper + BYPASS=1 → switch proceeds with a loud warning", () => {
		const { stdout, stderr } = runBoth(["use", "personal"], {
			FLYWHEEL_CLAUDE_FRESHNESS_BIN: join(tmp, "does-not-exist"),
			FLYWHEEL_CLAUDE_FRESHNESS_BYPASS: "1",
		});
		expect(stdout).toContain(
			"Switched machine Claude account to profile 'personal'",
		);
		expect(stderr).toMatch(/BYPASS|SKIPPING token freshness/i);
		expect(readFileSync(stateFile, "utf-8")).toBe(SECRET_A);
	});

	it("bypass is NOT honored in delegated-lock mode (Codex R2#1 layer 2) → still fails closed 31", () => {
		// Simulate the Bridge auto-switch path: it holds the lock and delegates.
		mkdirSync(lockDir, { recursive: true });
		writeFileSync(
			join(lockDir, "holder"),
			JSON.stringify({ pid: process.pid, at: Date.now() }),
		);
		const { status } = runExpectFail(["use", "personal"], {
			FLYWHEEL_CLAUDE_FRESHNESS_BIN: join(tmp, "does-not-exist"),
			FLYWHEEL_CLAUDE_FRESHNESS_BYPASS: "1", // leaked into the auto path…
			FLYWHEEL_CLAUDE_LOCK_DELEGATED: String(process.pid), // …but delegated refuses it
		});
		expect(status).toBe(31); // bypass ignored → fail-closed
		expect(readFileSync(stateFile, "utf-8")).toBe(SECRET_CUR);
		rmSync(lockDir, { recursive: true, force: true });
	});

	it("freshness WRITE-BACK: a helper that rotates the pool credential → `use` writes the ROTATED token", () => {
		// A refreshing helper writes a new compact credential to pool/<name>.
		const refreshBin = join(tmp, "fake-freshness-refresh");
		writeFileSync(
			refreshBin,
			`#!/usr/bin/env bash
set -u
name=""; pool=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) name="$2"; shift 2;;
    --pool) pool="$2"; shift 2;;
    --active) shift 2;;
    *) shift;;
  esac
done
printf '%s' '${SECRET_ROTATED}' > "$pool/$name/.credentials.json"
exit 0
`,
			{ mode: 0o755 },
		);
		run(["use", "school"], { FLYWHEEL_CLAUDE_FRESHNESS_BIN: refreshBin });
		// the Keychain got the ROTATED credential the helper wrote back, not SECRET_B
		expect(readFileSync(stateFile, "utf-8")).toBe(SECRET_ROTATED);
		expect(
			readFileSync(join(pool, "school", ".credentials.json"), "utf-8"),
		).toBe(SECRET_ROTATED);
	});

	it("CAPTURE-BACK: identity drift is not copied into the active slot", () => {
		run(["use", "personal"]); // active=personal, kc=SECRET_A
		// claude auto-refreshed the live token → the Keychain drifted:
		writeFileSync(stateFile, SECRET_DRIFT);
		const { stderr } = runBoth(["use", "school"]);
		expect(
			readFileSync(join(pool, "personal", ".credentials.json"), "utf-8"),
		).toBe(SECRET_A);
		expect(stderr).toContain("FLYWHEEL_ACTIVE_IDENTITY_DRIFT");
		// the new target still switched normally
		expect(readFileSync(stateFile, "utf-8")).toBe(SECRET_B);
		expect(readFileSync(join(pool, ".active"), "utf-8")).toBe("school");
	});

	it("CAPTURE-BACK is skipped on the FIRST switch (no prior active) and never poisons the pool", () => {
		run(["use", "personal"]); // active empty → capture-back skipped
		// personal's pool credential is unchanged (still SECRET_A)
		expect(
			readFileSync(join(pool, "personal", ".credentials.json"), "utf-8"),
		).toBe(SECRET_A);
	});

	it("capture-back ignores a predictable legacy temp symlink", () => {
		writeFileSync(join(pool, ".active"), "personal");
		writeFileSync(stateFile, SECRET_PERSONAL_REFRESHED);
		const credential = join(pool, "personal", ".credentials.json");
		const referent = join(tmp, "legacy-temp-referent");
		writeFileSync(referent, "sentinel", { mode: 0o600 });
		symlinkSync(referent, `${credential}.tmp`);
		run(["use", "school"]);
		expect(readFileSync(referent, "utf8")).toBe("sentinel");
		expect(readFileSync(credential, "utf8")).toBe(SECRET_PERSONAL_REFRESHED);
	});

	it("re-selecting the CURRENT active (name == active) does NOT probe-refresh it (never refresh the active family)", () => {
		run(["use", "personal"]); // active=personal
		writeFileSync(freshLog, ""); // reset the helper argv log
		run(["use", "personal"]); // name == active → no freshness probe
		expect(readFileSync(freshLog, "utf-8").trim()).toBe(""); // helper NOT invoked
	});

	it("capture-back refuses a symlinked active pool credential file (never follow a symlink)", () => {
		run(["use", "personal"]); // active=personal
		// Replace personal's credential file with a symlink to an outside target.
		const outside = join(tmp, "outside-cred");
		writeFileSync(outside, SECRET_CUR);
		rmSync(join(pool, "personal", ".credentials.json"), { force: true });
		symlinkSync(outside, join(pool, "personal", ".credentials.json"));
		writeFileSync(stateFile, SECRET_PERSONAL_REFRESHED);
		const { stderr } = runBoth(["use", "school"]);
		// the symlink target OUTSIDE the pool was NOT written through
		expect(readFileSync(outside, "utf-8")).toBe(SECRET_CUR);
		expect(stderr).toMatch(/symlink/i);
		// the switch itself still succeeded
		expect(readFileSync(stateFile, "utf-8")).toBe(SECRET_B);
	});
});

/**
 * FLY-1252 — a target must pass a live 5h + 7d quota check before any
 * Keychain mutation. `next` evaluates candidates under one owned lock and
 * skips only definitely-exhausted (32) candidates; unavailable evidence (33)
 * remains fail-closed for manual commands. The Node-delegated path may skip
 * the duplicate probe only after the lock delegation itself is authenticated.
 */
describe("flywheel-claude-profile — live quota guard (FLY-1252)", () => {
	it("never snapshots the exported environment to disk for bypass auditing", () => {
		const source = readFileSync(PROFILE_BIN, "utf-8");
		expect(source).not.toContain("flywheel-quota-bypass-env");
		expect(source).not.toContain("export -p >");
	});

	function quotaStub(code: number, body = ""): string {
		const p = join(tmp, `fake-quota-${code}-${Math.random()}`);
		writeFileSync(
			p,
			`#!/usr/bin/env bash\nset -u\nprintf '%s\\n' "$*" >> "$QUOTA_ARGV_LOG"\n${body}\nexit ${code}\n`,
			{ mode: 0o755 },
		);
		return p;
	}

	function seedBusinessActive(): void {
		seedProfile("business", SECRET_CUR);
		writeFileSync(join(pool, ".active"), "business", { mode: 0o600 });
	}

	it("`use` invokes freshness/check exactly once and active-sync after committing", () => {
		run(["use", "personal"]);
		const freshnessCalls = readFileSync(freshLog, "utf-8").trim().split("\n");
		const quotaCalls = readFileSync(quotaLog, "utf-8").trim().split("\n");
		expect(freshnessCalls).toHaveLength(1);
		expect(quotaCalls).toHaveLength(2);
		expect(quotaCalls[0]).toContain("check --name personal");
		expect(quotaCalls[0]).toContain(`--pool ${pool}`);
		expect(quotaCalls[0]).toContain(`--store ${accountsStore}`);
		expect(quotaCalls[1]).toBe(
			`active-sync --name personal --store ${accountsStore}`,
		);
		expect(readFileSync(stateFile, "utf-8")).toBe(SECRET_A);
	});

	it("quota exhausted (32) preserves a freshness write-back but never mutates Keychain/.active", () => {
		const refreshBin = join(tmp, "freshness-rotates-before-quota");
		writeFileSync(
			refreshBin,
			`#!/usr/bin/env bash\nset -u\nname=""; pool=""\nwhile [[ $# -gt 0 ]]; do\n  case "$1" in\n    --name) name="$2"; shift 2;;\n    --pool) pool="$2"; shift 2;;\n    *) shift;;\n  esac\ndone\nprintf '%s' '${SECRET_ROTATED}' > "$pool/$name/.credentials.json"\nexit 0\n`,
			{ mode: 0o755 },
		);
		const { status, stderr } = runExpectFail(["use", "personal"], {
			FLYWHEEL_CLAUDE_FRESHNESS_BIN: refreshBin,
			FLYWHEEL_CLAUDE_QUOTA_GUARD_BIN: quotaStub(32),
		});
		expect(status).toBe(32);
		expect(stderr).toContain("FLYWHEEL_TARGET_QUOTA_EXHAUSTED personal");
		expect(readFileSync(stateFile, "utf-8")).toBe(SECRET_CUR);
		expect(existsSync(join(pool, ".active"))).toBe(false);
		expect(
			readFileSync(join(pool, "personal", ".credentials.json"), "utf-8"),
		).toBe(SECRET_ROTATED);
	});

	it("quota evidence unavailable (33) is fail-closed for manual `use`", () => {
		const { status, stderr } = runExpectFail(["use", "personal"], {
			FLYWHEEL_CLAUDE_QUOTA_GUARD_BIN: quotaStub(33),
		});
		expect(status).toBe(33);
		expect(stderr).toContain("FLYWHEEL_QUOTA_UNAVAILABLE personal");
		expect(readFileSync(stateFile, "utf-8")).toBe(SECRET_CUR);
	});

	it("a missing quota helper is unavailable (33), never fail-open manually", () => {
		const { status, stderr } = runExpectFail(["use", "personal"], {
			FLYWHEEL_CLAUDE_QUOTA_GUARD_BIN: join(tmp, "missing-quota-helper"),
		});
		expect(status).toBe(33);
		expect(stderr).toContain("FLYWHEEL_QUOTA_UNAVAILABLE personal");
		expect(readFileSync(stateFile, "utf-8")).toBe(SECRET_CUR);
	});

	it("manual quota bypass is loud, alerts once, and proceeds without probing", () => {
		const { stdout, stderr } = runBoth(["use", "personal"], {
			FLYWHEEL_CLAUDE_QUOTA_GUARD_BIN: quotaBin,
			FLYWHEEL_CLAUDE_QUOTA_BYPASS: "1",
		});
		expect(stdout).toContain("Switched machine Claude account");
		expect(stderr).toMatch(/BYPASS|quota guard/i);
		expect(readFileSync(quotaLog, "utf-8")).toContain(
			"active-sync --name personal",
		);
		expect(readFileSync(quotaLog, "utf-8")).not.toContain("check --name");
		const alert = readFileSync(alertLog, "utf-8");
		expect(alert).toContain("--kind quota_guard_bypassed");
		expect(alert).toContain("--severity warning");
		expect(alert).toContain("target=personal");
		expect(alert.trim().split("\n")).toHaveLength(1);
	});

	it("forged delegation cannot unlock PREVERIFIED quota trust", () => {
		const { status } = runExpectFail(["use", "personal"], {
			FLYWHEEL_CLAUDE_LOCK_DELEGATED: String(process.pid),
			FLYWHEEL_CLAUDE_QUOTA_PREVERIFIED: "1",
			FLYWHEEL_CLAUDE_QUOTA_GUARD_BIN: quotaStub(32),
		});
		expect(status).toBe(32);
		expect(readFileSync(stateFile, "utf-8")).toBe(SECRET_CUR);
	});

	it("authenticated delegated + PREVERIFIED skips the duplicate quota probe", () => {
		mkdirSync(lockDir, { recursive: true });
		writeFileSync(
			join(lockDir, "holder"),
			JSON.stringify({ pid: process.pid, at: Date.now() }),
		);
		run(["use", "personal"], {
			FLYWHEEL_CLAUDE_LOCK_DELEGATED: String(process.pid),
			FLYWHEEL_CLAUDE_QUOTA_PREVERIFIED: "1",
			FLYWHEEL_CLAUDE_QUOTA_GUARD_BIN: quotaStub(32),
		});
		expect(readFileSync(quotaLog, "utf-8")).toBe("");
		expect(readFileSync(stateFile, "utf-8")).toBe(SECRET_A);
		expect(existsSync(lockDir)).toBe(true);
		rmSync(lockDir, { recursive: true, force: true });
	});

	it("authenticated legacy delegation warns and fails open only for unavailable evidence (33)", () => {
		mkdirSync(lockDir, { recursive: true });
		writeFileSync(
			join(lockDir, "holder"),
			JSON.stringify({ pid: process.pid, at: Date.now() }),
		);
		const { stderr } = runBoth(["use", "personal"], {
			FLYWHEEL_CLAUDE_LOCK_DELEGATED: String(process.pid),
			FLYWHEEL_CLAUDE_QUOTA_GUARD_BIN: quotaStub(33),
		});
		expect(stderr).toMatch(/unavailable|legacy delegated/i);
		expect(readFileSync(stateFile, "utf-8")).toBe(SECRET_A);
		rmSync(lockDir, { recursive: true, force: true });
	});

	it("delegated mode ignores quota BYPASS and still refuses exhausted evidence (32)", () => {
		mkdirSync(lockDir, { recursive: true });
		writeFileSync(
			join(lockDir, "holder"),
			JSON.stringify({ pid: process.pid, at: Date.now() }),
		);
		const { status } = runExpectFail(["use", "personal"], {
			FLYWHEEL_CLAUDE_LOCK_DELEGATED: String(process.pid),
			FLYWHEEL_CLAUDE_QUOTA_BYPASS: "1",
			FLYWHEEL_CLAUDE_QUOTA_GUARD_BIN: quotaStub(32),
		});
		expect(status).toBe(32);
		expect(readFileSync(stateFile, "utf-8")).toBe(SECRET_CUR);
		rmSync(lockDir, { recursive: true, force: true });
	});

	it("`next` skips exhausted candidates under one lock and checks each candidate once", () => {
		seedBusinessActive();
		const selective = join(tmp, "quota-personal-exhausted");
		writeFileSync(
			selective,
			`#!/usr/bin/env bash\nset -u\nprintf '%s\\n' "$*" >> "$QUOTA_ARGV_LOG"\nname=""\nwhile [[ $# -gt 0 ]]; do\n  if [[ "$1" == "--name" ]]; then name="$2"; break; fi\n  shift\ndone\n[[ "$name" == "personal" ]] && exit 32\nexit 0\n`,
			{ mode: 0o755 },
		);
		run(["next"], { FLYWHEEL_CLAUDE_QUOTA_GUARD_BIN: selective });
		expect(readFileSync(join(pool, ".active"), "utf-8")).toBe("school");
		expect(readFileSync(stateFile, "utf-8")).toBe(SECRET_B);
		const quotaCalls = readFileSync(quotaLog, "utf-8").trim().split("\n");
		const freshnessCalls = readFileSync(freshLog, "utf-8").trim().split("\n");
		expect(quotaCalls).toHaveLength(3);
		expect(quotaCalls[0]).toContain("--name personal");
		expect(quotaCalls[1]).toContain("--name school");
		expect(quotaCalls[2]).toBe(
			`active-sync --name school --store ${accountsStore}`,
		);
		expect(freshnessCalls).toHaveLength(2);
		expect(existsSync(lockDir)).toBe(false);
	});

	it("warns but keeps a committed manual switch when active-sync fails", () => {
		const helper = join(tmp, "quota-active-sync-fails");
		writeFileSync(
			helper,
			`#!/usr/bin/env bash
set -u
printf '%s\\n' "$*" >> "$QUOTA_ARGV_LOG"
[[ "\${1:-}" == "active-sync" ]] && exit 41
exit 0
`,
			{ mode: 0o755 },
		);

		const { stdout, stderr } = runBoth(["use", "personal"], {
			FLYWHEEL_CLAUDE_QUOTA_GUARD_BIN: helper,
		});

		expect(stdout).toContain("Switched machine Claude account");
		expect(stderr).toContain("Warning: active account store sync failed");
		expect(readFileSync(stateFile, "utf-8")).toBe(SECRET_A);
		expect(readFileSync(join(pool, ".active"), "utf-8")).toBe("personal");
	});

	it("`next` hard-stops after every candidate is exhausted (32)", () => {
		seedBusinessActive();
		const { status, stderr } = runExpectFail(["next"], {
			FLYWHEEL_CLAUDE_QUOTA_GUARD_BIN: quotaStub(32),
		});
		expect(status).toBe(32);
		expect(stderr).toContain("FLYWHEEL_TARGET_QUOTA_EXHAUSTED");
		expect(readFileSync(stateFile, "utf-8")).toBe(SECRET_CUR);
		expect(readFileSync(join(pool, ".active"), "utf-8")).toBe("business");
	});

	it("`next` does not skip freshness failures or unavailable quota evidence", () => {
		seedBusinessActive();
		const staleBin = join(tmp, "freshness-stale-for-next");
		writeFileSync(
			staleBin,
			'#!/usr/bin/env bash\nset -u\nprintf \'%s\\n\' "$*" >> "$FRESH_ARGV_LOG"\nexit 30\n',
			{ mode: 0o755 },
		);
		const stale = runExpectFail(["next"], {
			FLYWHEEL_CLAUDE_FRESHNESS_BIN: staleBin,
		});
		expect(stale.status).toBe(30);
		expect(readFileSync(quotaLog, "utf-8")).toBe("");

		writeFileSync(freshLog, "");
		const unavailable = runExpectFail(["next"], {
			FLYWHEEL_CLAUDE_QUOTA_GUARD_BIN: quotaStub(33),
		});
		expect(unavailable.status).toBe(33);
		expect(readFileSync(stateFile, "utf-8")).toBe(SECRET_CUR);
	});

	it("losing lock ownership after verification aborts before Keychain and preserves the replacement holder", () => {
		const steal = quotaStub(
			0,
			'rm -rf "$FLYWHEEL_CLAUDE_ACCOUNTS_LOCK"; mkdir "$FLYWHEEL_CLAUDE_ACCOUNTS_LOCK"; printf \'{"pid":1,"at":1,"token":"replacement"}\\n\' > "$FLYWHEEL_CLAUDE_ACCOUNTS_LOCK/holder.replacement"',
		);
		const { status, stderr } = runExpectFail(["use", "personal"], {
			FLYWHEEL_CLAUDE_QUOTA_GUARD_BIN: steal,
		});
		expect(status).not.toBe(0);
		expect(stderr).toMatch(/lease|ownership|lock/i);
		expect(readFileSync(stateFile, "utf-8")).toBe(SECRET_CUR);
		expect(existsSync(lockDir)).toBe(true);
		expect(
			readFileSync(join(lockDir, "holder.replacement"), "utf-8"),
		).toContain('"pid":1');
		rmSync(lockDir, { recursive: true, force: true });
	});
});

describe("flywheel-claude-profile — account identity policy (FLY-1252 P7)", () => {
	const EXPECTED = "b".repeat(64);
	const ACTUAL = "a".repeat(64);

	function identityGuard(body: string): string {
		const p = join(tmp, `fake-identity-${Math.random()}`);
		writeFileSync(
			p,
			`#!/usr/bin/env bash
set -u
printf '%s\n' "$*" >> "$QUOTA_ARGV_LOG"
case "\${1:-}" in
  check|active-sync) exit 0 ;;
  identity-alert-flush) cat >/dev/null; exit 0 ;;
  identity-verify)
    token=$(cat)
    name=""
    while [[ $# -gt 0 ]]; do
      if [[ "$1" == "--name" ]]; then name="$2"; break; fi
      shift
    done
    ${body}
    ;;
  *) exit 33 ;;
esac
`,
			{ mode: 0o755 },
		);
		return p;
	}

	it("pre-write mismatch exits 34 before Keychain mutation and reports only digests", () => {
		const report = join(tmp, "apply-report-mismatch.json");
		const guard = identityGuard(
			`echo "identity verify: mismatch for '$name' expectedKey=${EXPECTED} actualDigest=${ACTUAL}" >&2
exit 34`,
		);
		const { status, stderr } = runExpectFail(["use", "personal"], {
			FLYWHEEL_ACCOUNT_IDENTITY_CHECK: "1",
			FLYWHEEL_CLAUDE_QUOTA_GUARD_BIN: guard,
			FLYWHEEL_APPLY_REPORT_FILE: report,
		});

		expect(status).toBe(34);
		expect(stderr).toContain("FLYWHEEL_TARGET_IDENTITY_MISMATCH personal");
		expect(readFileSync(stateFile, "utf8")).toBe(SECRET_CUR);
		expect(existsSync(join(pool, ".active"))).toBe(false);
		const calls = readFileSync(quotaLog, "utf8");
		expect(calls).toContain("identity-verify --name personal");
		expect(calls).not.toContain("sk-ant-oat01");
		expect(JSON.parse(readFileSync(report, "utf8"))).toEqual({
			identityChecks: [
				{
					label: "personal",
					checkpoint: "pre_write",
					verdict: "mismatch",
					expectedKey: EXPECTED,
					actualDigest: ACTUAL,
				},
			],
		});
	});

	it("manual mismatch flushes its report only after releasing the account lock", () => {
		const guard = join(tmp, "manual-identity-flush");
		const flushed = join(tmp, "manual-identity-flushed.json");
		writeFileSync(
			guard,
			`#!/usr/bin/env bash
set -u
case "\${1:-}" in
  check|active-sync) exit 0 ;;
  identity-verify)
    cat >/dev/null
    echo "identity verify: mismatch expectedKey=${EXPECTED} actualDigest=${ACTUAL}" >&2
    exit 34
    ;;
  identity-alert-flush)
    [[ ! -d "$FLYWHEEL_CLAUDE_ACCOUNTS_LOCK" ]] || exit 90
    cat > "$MANUAL_IDENTITY_FLUSHED"
    exit 0
    ;;
  *) exit 33 ;;
esac
`,
			{ mode: 0o755 },
		);

		const { status } = runExpectFail(["use", "personal"], {
			FLYWHEEL_ACCOUNT_IDENTITY_CHECK: "1",
			FLYWHEEL_CLAUDE_QUOTA_GUARD_BIN: guard,
			MANUAL_IDENTITY_FLUSHED: flushed,
		});

		expect(status).toBe(34);
		expect(existsSync(lockDir)).toBe(false);
		expect(JSON.parse(readFileSync(flushed, "utf8"))).toEqual({
			identityChecks: [
				{
					label: "personal",
					checkpoint: "pre_write",
					verdict: "mismatch",
					expectedKey: EXPECTED,
					actualDigest: ACTUAL,
				},
			],
		});
	});

	it("network-unknown pre-write identity warns and allows the switch", () => {
		const report = join(tmp, "apply-report-unknown.json");
		const guard = identityGuard(
			'echo "identity verify: profile_network" >&2\nexit 35',
		);
		const { stdout, stderr } = runBoth(["use", "personal"], {
			FLYWHEEL_ACCOUNT_IDENTITY_CHECK: "1",
			FLYWHEEL_CLAUDE_QUOTA_GUARD_BIN: guard,
			FLYWHEEL_APPLY_REPORT_FILE: report,
		});

		expect(stdout).toContain("Switched machine Claude account");
		expect(stderr).toMatch(/identity.*unknown|profile_network/i);
		expect(readFileSync(stateFile, "utf8")).toBe(SECRET_A);
		expect(JSON.parse(readFileSync(report, "utf8"))).toMatchObject({
			identityChecks: [
				{
					label: "personal",
					checkpoint: "pre_write",
					verdict: "profile_network",
				},
			],
		});
	});

	it("profile unauthorized exits 38 before Keychain mutation without a sticky write", () => {
		const guard = identityGuard(
			'echo "identity verify: profile_unauthorized" >&2\nexit 38',
		);
		const { status, stderr } = runExpectFail(["use", "personal"], {
			FLYWHEEL_ACCOUNT_IDENTITY_CHECK: "1",
			FLYWHEEL_CLAUDE_QUOTA_GUARD_BIN: guard,
			FLYWHEEL_APPLY_REPORT_FILE: join(tmp, "unauthorized-report.json"),
		});
		expect(status).toBe(38);
		expect(stderr).toContain("FLYWHEEL_TARGET_IDENTITY_UNVERIFIABLE personal");
		expect(readFileSync(stateFile, "utf8")).toBe(SECRET_CUR);
		expect(existsSync(join(pool, ".active"))).toBe(false);
	});

	it("capture_back mismatch skips the pool write but still switches to the verified target (anti-contamination)", () => {
		// FLY-1182 assertion B (deployed anchor behavior, per Lead ruling: capture
		// uses the always-on anchor model, and capture_back keeps its shipped
		// anti-contamination semantics). The outgoing account's live Keychain token
		// drifted from its anchor, so it is NEVER copied back into its pool slot —
		// but the switch to the already-verified target still completes (a drifted
		// outgoing account must not strand the user on a bad account). The drift is
		// surfaced as a single stable marker, not silently swallowed.
		writeFileSync(join(pool, ".active"), "personal", { mode: 0o600 });
		writeFileSync(join(pool, "personal", ".credentials.json"), SECRET_A);
		writeFileSync(stateFile, SECRET_DRIFT);

		const switched = runBoth(["use", "school"]);

		// the switch to the verified target completed
		expect(readFileSync(stateFile, "utf8")).toBe(SECRET_B);
		expect(readFileSync(join(pool, ".active"), "utf8")).toBe("school");
		// the drifted outgoing token was NOT written back into its pool slot
		expect(
			readFileSync(join(pool, "personal", ".credentials.json"), "utf8"),
		).toBe(SECRET_A);
		// exactly one stable drift marker surfaced the capture-back mismatch
		const markers = switched.stderr
			.split("\n")
			.filter((line) => line.startsWith("FLYWHEEL_ACTIVE_IDENTITY_DRIFT "));
		expect(markers).toHaveLength(1);
		expect(JSON.parse(markers[0].split(" ", 2)[1])).toMatchObject({
			reason: "mismatch",
			label: "personal",
			expectedUuid: "uuid-personal",
		});
	});

	it("manual capture without an identity anchor fails closed (anchor 87), creating no labeled pool slot", () => {
		// FLY-1182 migration (Lead ruling: capture uses the always-on anchor
		// model, not the env-gated probe). A fresh label with neither an identity
		// anchor nor a canonical identity map cannot bootstrap, so the pool write
		// is refused before any slot is created — the anti-contamination guarantee
		// this issue was filed for. Exit 87 = untracked/unbootstrappable.
		const { status } = runExpectFail(["capture", "current"]);
		expect(status).toBe(87);
		expect(existsSync(join(pool, "current", ".credentials.json"))).toBe(false);
	});

	it("next skips identity mismatch and unauthorized candidates exactly once", () => {
		seedProfile("business", SECRET_CUR);
		writeFileSync(join(pool, ".active"), "business", { mode: 0o600 });
		const guard = identityGuard(
			`case "$name" in
  personal) echo "identity verify: mismatch expectedKey=${EXPECTED} actualDigest=${ACTUAL}" >&2; exit 34 ;;
  school) echo "identity verify: match expectedKey=${EXPECTED}" >&2; exit 0 ;;
esac
exit 38`,
		);

		run(["next"], {
			FLYWHEEL_ACCOUNT_IDENTITY_CHECK: "1",
			FLYWHEEL_CLAUDE_QUOTA_GUARD_BIN: guard,
			FLYWHEEL_APPLY_REPORT_FILE: join(tmp, "next-report.json"),
		});

		expect(readFileSync(join(pool, ".active"), "utf8")).toBe("school");
		const preWrites = JSON.parse(
			readFileSync(join(tmp, "next-report.json"), "utf8"),
		).identityChecks.filter(
			(check: { checkpoint: string }) => check.checkpoint === "pre_write",
		);
		expect(preWrites.map((check: { label: string }) => check.label)).toEqual([
			"personal",
			"school",
		]);
	}, 15_000);

	it("legacy identity policy env off does NOT exempt capture — the anchor gate stays enforced", () => {
		// FLY-1182 migration + ruling 3 (Lead): the anchor layer is the single
		// identity truth and has NO env door. Even with the contamination-era
		// policy-off passthrough (FLYWHEEL_ACCOUNT_IDENTITY_CHECK unset — model B's
		// exemption), a capture into an unanchored label without a canonical
		// identity map is still refused closed (87) and creates no pool slot. That
		// passthrough is exactly the zero-verification pool-write behavior this
		// issue kills. (The env-gated probe layer still governs switch pre-write;
		// its policy-off passthrough is covered by the dedicated FLY-1252 switch
		// tests, which this migration deliberately leaves untouched.)
		const { status } = runExpectFail(["capture", "off-capture"]);
		expect(status).toBe(87);
		expect(existsSync(join(pool, "off-capture", ".credentials.json"))).toBe(
			false,
		);
	}, 15_000);
});
