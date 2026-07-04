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
import { execFileSync, type SpawnSyncReturns } from "node:child_process";
import {
	accessSync,
	constants,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

let tmp: string;
let pool: string;
let lockDir: string;
let stateFile: string;
let argvLog: string;
let stubBin: string;

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
		...extra,
	};
}

function run(args: string[], extra: Record<string, string> = {}): string {
	return execFileSync("bash", [PROFILE_BIN, ...args], {
		env: env(extra),
		encoding: "utf-8",
	});
}

function runExpectFail(
	args: string[],
	extra: Record<string, string> = {},
): { status: number; stderr: string } {
	try {
		execFileSync("bash", [PROFILE_BIN, ...args], {
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

function seedProfile(name: string, secret: string): void {
	mkdirSync(join(pool, name), { recursive: true });
	writeFileSync(join(pool, name, ".credentials.json"), secret, { mode: 0o600 });
}

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "fly696-profile-"));
	pool = join(tmp, "pool");
	lockDir = join(tmp, "accounts.lock");
	stateFile = join(tmp, "keychain-state");
	argvLog = join(tmp, "argv.log");
	stubBin = join(tmp, "fake-security");
	writeFileSync(stubBin, STUB, { mode: 0o755 });
	writeFileSync(argvLog, "");
	mkdirSync(pool, { recursive: true });
	seedProfile("personal", SECRET_A);
	seedProfile("school", SECRET_B);
	// current machine credential (what a rollback must restore)
	writeFileSync(stateFile, SECRET_CUR);
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

	it("lock: held by a LIVE holder → times out fail-closed", () => {
		mkdirSync(lockDir, { recursive: true });
		writeFileSync(
			join(lockDir, "holder"),
			JSON.stringify({ pid: process.pid, at: Date.now() }), // live pid, fresh
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

	it("lock is RELEASED after a successful command (next run acquires instantly)", () => {
		run(["use", "personal"]);
		expect(existsSync(lockDir)).toBe(false);
		run(["use", "school"], { FLYWHEEL_CLAUDE_LOCK_TIMEOUT_MS: "300" });
		expect(readFileSync(stateFile, "utf-8")).toBe(SECRET_B);
	});
});
