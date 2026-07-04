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
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

const SECRET_A =
	'{"claudeAiOauth":{"accessToken":"sk-ant-oat01-INT-A","refreshToken":"rA"}}';
const SECRET_B =
	'{"claudeAiOauth":{"accessToken":"sk-ant-oat01-INT-B","refreshToken":"rB"}}';

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
	"FLYWHEEL_CLAUDE_SECURITY_BIN",
	"FLYWHEEL_CLAUDE_KEYCHAIN_SERVICE",
	"FLYWHEEL_CLAUDE_KEYCHAIN_ACCOUNT",
	"FLYWHEEL_CLAUDE_LOCK_TIMEOUT_MS",
	"FAKE_SEC_STATE",
	"FAKE_SEC_ARGV_LOG",
] as const;

let tmp: string;
let lockPath: string;
let storePath: string;
let saved: Record<string, string | undefined>;

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
	writeFileSync(stubBin, STUB, { mode: 0o755 });
	writeFileSync(stateFile, SECRET_A); // current machine credential
	writeFileSync(argvLog, "");
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
	process.env.FLYWHEEL_CLAUDE_SECURITY_BIN = stubBin;
	process.env.FLYWHEEL_CLAUDE_KEYCHAIN_SERVICE = "Claude Seam-credentials";
	process.env.FLYWHEEL_CLAUDE_KEYCHAIN_ACCOUNT = "seamacct";
	// Regression speed: an un-delegated child would time out in 2s, not 30s.
	process.env.FLYWHEEL_CLAUDE_LOCK_TIMEOUT_MS = "2000";
	process.env.FAKE_SEC_STATE = stateFile;
	process.env.FAKE_SEC_ARGV_LOG = argvLog;
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
	it("switches while Node holds the shared lock — the delegated child neither deadlocks nor releases it", async () => {
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
	});
});
