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
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
	emailAddress: "shop@example.com",
	organizationUuid: "org-shop",
	organizationName: "Shop Org",
	displayName: "Shopper",
	organizationRole: "admin",
};
const IDENTITY_BIZ = {
	accountUuid: "uuid-biz",
	emailAddress: "biz@example.com",
	organizationUuid: "org-biz",
	organizationName: "Biz Org",
	displayName: "Biz",
	organizationRole: "admin",
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
		expect(status).not.toBe(0);
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
		expect(status).not.toBe(0);
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
		const out = run(["capture", "current"]);
		expect(out).toContain("Captured");
		const file = join(pool, "current", ".credentials.json");
		expect(readFileSync(file, "utf-8")).toBe(SECRET_CUR);
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(statSync(join(pool, "current")).mode & 0o777).toBe(0o700);
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
		writeFileSync(claudeJson, claudeJsonWith(IDENTITY_BIZ));
		const { stdout, stderr } = runBoth(["capture", "business"]);
		// token still captured (existing behavior):
		expect(
			readFileSync(join(pool, "business", ".credentials.json"), "utf-8"),
		).toBe(SECRET_CUR);
		// identity captured beside it, 0600:
		expect(JSON.parse(readFileSync(identityFile("business"), "utf-8"))).toEqual(
			IDENTITY_BIZ,
		);
		expect(statSync(identityFile("business")).mode & 0o777).toBe(0o600);
		// the email is echoed for operator eyeballing (stdout or stderr):
		expect(stdout + stderr).toContain("biz@example.com");
	});

	it("`capture` with no/invalid target oauthAccount DELETES any stale identity file (no stale pairing) + still captures token + exit 0", () => {
		// business already has a (stale) identity from a prior capture…
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
			'#!/bin/sh\necho $$ > "$FLY865_STUB_PID"\nexec sleep 20\n',
			{ mode: 0o755 },
		);
		// Delegated: pre-hold the ACCOUNTS lock as THIS process so the child's
		// acquire_lock returns early WITHOUT arming a per-acquire trap.
		mkdirSync(lockDir, { recursive: true });
		writeFileSync(
			join(lockDir, "holder"),
			JSON.stringify({ pid: process.pid, at: Date.now() }),
		);
		const child = spawn("bash", [PROFILE_BIN, "use", "personal"], {
			env: env({
				FLYWHEEL_CLAUDE_LOCK_DELEGATED: String(process.pid),
				FLY865_STUB_PID: stubPidFile,
				PATH: `${binDir}:${process.env.PATH ?? ""}`,
			}),
			stdio: "ignore",
		});
		const waitFor = async (cond: () => boolean): Promise<boolean> => {
			for (let i = 0; i < 250; i++) {
				if (cond()) return true;
				await new Promise((r) => setTimeout(r, 20));
			}
			return cond();
		};
		// Script acquired `lock`, then stalled in the sleeping node patch.
		expect(await waitFor(() => existsSync(lock))).toBe(true);
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

	it("CAPTURE-BACK: the OLD active account's DRIFTED Keychain value is snapshotted into its pool slot", () => {
		run(["use", "personal"]); // active=personal, kc=SECRET_A
		// claude auto-refreshed the live token → the Keychain drifted:
		writeFileSync(stateFile, SECRET_DRIFT);
		run(["use", "school"]); // switching away captures personal's drifted value back
		expect(
			readFileSync(join(pool, "personal", ".credentials.json"), "utf-8"),
		).toBe(SECRET_DRIFT);
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
		writeFileSync(stateFile, SECRET_DRIFT);
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
