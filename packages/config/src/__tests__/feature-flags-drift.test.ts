import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FEATURE_FLAGS } from "../feature-flags/registry.js";

// FLY-709 F5: two-way drift guard. Keep the registry and the code in sync so a
// NEW `FLYWHEEL_*` boolean gate added to production code but not registered fails
// CI, and every registered env flag really is read where the registry claims.
//
// First version (Codex-endorsed): a SCOPED scan of production runtime `src`
// dirs (excludes tests/dist/node_modules). The forward direction (no silent new
// gate) uses a `process.env.FLYWHEEL_*` regex; plumbing / value / context vars
// are excluded via an allowlist WITH A REASON. The reverse direction (registered
// → read) checks the flag's declared readSite FILE actually contains the env var
// (robust to read form: process.env.X, injected `env.X`, destructured). A full
// AST scanner is a follow-up.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");

const SCAN_DIRS = [
	"packages/teamlead/src",
	"packages/config/src",
	"packages/flywheel-comm/src",
	"packages/edge-worker/src",
];

/**
 * `FLYWHEEL_*` env vars that are NOT on/off feature gates — runtime context,
 * plumbing, ids, paths, tuning knobs, secrets, value config. Each MUST carry a
 * reason. If you add a real feature gate, register it instead of allowlisting.
 */
const NON_FLAG_ALLOWLIST: Record<string, string> = {
	// context / ids
	FLYWHEEL_EXEC_ID: "context: runner execution id",
	FLYWHEEL_ISSUE_ID: "context: linear issue id",
	FLYWHEEL_PROJECT_NAME: "context: project name",
	FLYWHEEL_PROJECT_DIR: "context: project dir",
	FLYWHEEL_TMUX_SESSION: "context: tmux session name",
	FLYWHEEL_RUNNER_BACKEND_ID: "context: runner backend id",
	FLYWHEEL_RUNNER_VENDOR_ID: "context: runner vendor id",
	FLYWHEEL_AGENT_BACKEND: "context: agent backend",
	FLYWHEEL_RUNNER_START_POINT: "context: runner start point",
	FLYWHEEL_FOUNDER_USER_ID: "context: founder discord id",
	FLYWHEEL_FOUNDER_DISCORD_USER_ID: "context: founder discord id (alt)",
	// plumbing / paths
	FLYWHEEL_BRIDGE_URL: "plumbing: bridge base URL",
	FLYWHEEL_COMM_DB: "plumbing: comm db path",
	FLYWHEEL_COMM_DIR: "plumbing: comm dir path",
	FLYWHEEL_COMM_ROOT: "plumbing: comm root path",
	FLYWHEEL_CLAIMS_DB: "plumbing: claims db path",
	FLYWHEEL_GATE_MARKER_DIR: "plumbing: gate marker dir",
	FLYWHEEL_CMUX_CLOSE_REQUEST_FILE:
		"plumbing: cmux close-request marker file path (FLY-685)",
	FLYWHEEL_REPO_ROOT: "plumbing: repo root path",
	FLYWHEEL_DIR: "plumbing: state dir root",
	FLYWHEEL_STATE_DIR: "plumbing: state dir",
	FLYWHEEL_REPORTS_DIR: "plumbing: reports dir",
	FLYWHEEL_BLOCKED_DIR: "plumbing: blocked-sessions dir",
	FLYWHEEL_HOOK_SOURCE_DIR: "plumbing: hook source dir",
	FLYWHEEL_HOOKS_DIR: "plumbing: hooks dir",
	FLYWHEEL_BIN_DIR: "plumbing: bin dir",
	FLYWHEEL_LAND_STATUS_PATH: "plumbing: land-status path",
	FLYWHEEL_MISROUTE_ARCHIVE_DIR: "plumbing: misroute archive dir",
	FLYWHEEL_ALERT_QUEUE_DIR: "plumbing: alert queue dir",
	FLYWHEEL_ALERT_DEADLETTER_DIR: "plumbing: alert deadletter dir",
	FLYWHEEL_PUBLISH_BROKER_SOCKET:
		"plumbing: publish-broker unix socket path (FLY-1062)",
	FLYWHEEL_PUBLISH_AUDIT_PATH: "plumbing: publish audit JSONL path (FLY-1062)",
	FLYWHEEL_PUBLISH_APPROVAL_CHANNEL:
		"config value: publish-approval Discord channel id (FLY-1062)",
	FLYWHEEL_FLEET_SANITIZE:
		"plumbing: fleet-sanitize.sh scanner path override (FLY-1062 broker gate; tests point it at stubs)",
	FLYWHEEL_CLAUDE_ACCOUNTS_PATH:
		"plumbing: claude account-state json path (FLY-696)",
	FLYWHEEL_ACCOUNT_PENDING_PATH:
		"plumbing: account_switch_pending store path (FLY-696)",
	FLYWHEEL_CLAUDE_PROFILE_BIN:
		"plumbing: flywheel-claude-profile script path (FLY-696)",
	FLYWHEEL_CLAUDE_LOCK_DELEGATED:
		"internal contract: parent lock-holder pid passed to the profile script (FLY-852 anti-deadlock; validated against the live holder marker)",
	FLYWHEEL_CLAUDE_OAUTH_ENDPOINT:
		"config value: OAuth token-refresh endpoint override for the freshness helper (FLY-871; enable-gate spike pins the exact contract without a code change)",
	FLYWHEEL_CLAUDE_OAUTH_CLIENT_ID:
		"config value: OAuth public client id override for the freshness helper (FLY-871)",
	FLYWHEEL_ACCOUNT_LEDGER_PATH:
		"plumbing: account-ledger json path override (FLY-871)",
	FLYWHEEL_INFRA_BOT_USER_ID:
		"context: Codex Infra Bot discord user id, for @-mention on account-switch assignment posts (FLY-871)",
	FLYWHEEL_DETECTION_AI_CLASSIFY:
		"internal ops lever: kill-switch for the Layer-2 AI-assisted pane classify step, default-on (FLY-871)",
	FLYWHEEL_BRIDGE_WATCHDOG_LOG: "plumbing: watchdog log path",
	// secrets / token env names
	FLYWHEEL_INGEST_TOKEN: "secret: ingest token",
	FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL:
		"secret: short-lived per-execution workflow submission credential",
	FLYWHEEL_ALERT_REPAIR_BOT_TOKEN_ENV:
		"config value: repair-bot token env NAME",
	// value config (non-boolean)
	FLYWHEEL_PROJECTS: "config value: inline projects json (env-pin)",
	FLYWHEEL_COMM_BACKEND: "config value: comm backend",
	FLYWHEEL_MEMORY_MODEL: "config value: memory model",
	FLYWHEEL_LEAD_MODEL: "config value: per-lead model (fleet)",
	FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID: "config value: alert channel id",
	FLYWHEEL_FLY324_SWEEP_EXCLUDE: "config value: sweep exclude list",
	FLYWHEEL_FOUNDER_AUTO_APPROVE_DENYLIST:
		"config value: comma-separated projects excluded from founder auto-approve (FLY-799)",
	FLYWHEEL_DIGEST_CHANNEL: "config value: daily digest channel id (FLY-727)",
	FLYWHEEL_DIGEST_TZ: "config value: daily digest timezone (FLY-727)",
	FLYWHEEL_FOUNDER_CONSENT_ENABLED:
		"legacy alias of DECISION_MODE (the enum gate is registered)",
	FLYWHEEL_ROUNDTABLE_THREAD_AUTOCONTINUE_EFFECTIVE:
		"internal derived var (SET by mcp-config to propagate, not a founder gate)",
	// FLY-766 chrome-reaper: the enable gate itself is a registered kill_switch
	// flag (chrome_session_reaper); these are its two numeric tuning knobs plus
	// one internal ops safety lever (deliberately NOT a founder dashboard flag —
	// it opts into reaping unattributed Chrome, which could touch a human's own
	// browser, so it stays an internal env lever, not a founder-toggle).
	FLYWHEEL_CHROME_REAPER_ORPHAN_GRACE_MIN:
		"tuning knob: chrome-reaper orphan idle grace minutes (FLY-766)",
	FLYWHEEL_CHROME_REAPER_INTERVAL_MS:
		"tuning knob: chrome-reaper sweep interval ms (FLY-766)",
	FLYWHEEL_CHROME_REAPER_MIGRATE_UNATTRIBUTED:
		"internal ops lever: opt-in reap of unattributed Chrome, default off (FLY-766)",
	// tuning knobs (numeric)
	FLYWHEEL_WATCHDOG_JUDGE_BIN:
		"config value: watchdog-judge binary override (FLY-1048 PR-B)",
	FLYWHEEL_WATCHDOG_JUDGE_MODEL:
		"config value: watchdog-judge codex model override (FLY-1048 PR-B)",
	FLYWHEEL_WATCHDOG_JUDGE_TIMEOUT_MS:
		"tuning knob: watchdog-judge child timeout ms (FLY-1048 PR-B)",
	FLYWHEEL_JUDGE_COOLDOWN_MS:
		"tuning knob: per-target judge verdict-cache cooldown ms (FLY-1048 PR-B)",
	FLYWHEEL_JUDGE_SUPPRESS_TTL_MS:
		"tuning knob: judge a/b suppression TTL ms before re-evaluation (FLY-1048 PR-B)",
	FLYWHEEL_STUCK_FRAME_GAP_MS:
		"tuning knob: stuck-confirm two-frame gap ms, bounded ≤60s, default 15s (FLY-1234)",
	FLYWHEEL_STUCK_CONFIRM_PER_TICK:
		"tuning knob: stuck-confirm per-tick candidate budget, bounded ≤20, default 3 — beyond-budget candidates take the legacy emit (FLY-1234)",
	FLYWHEEL_STUCK_CONFIRM_DEADLINE_MS:
		"tuning knob: stuck-confirm end-to-end deadline ms, bounded ≤300s, default 90s — expiry fail-opens to emit (FLY-1234)",
	FLYWHEEL_GAP_SCAN_EVERY_N_TICKS:
		"tuning knob: gap-scan cadence in GatePoller ticks (FLY-1048 A6)",
	FLYWHEEL_DETECTION_LEAD_GRACE_MS:
		"tuning knob: detection-escalation Lead grace ms before the founder page (FLY-1048 PR-C; per-project override via detection.lead_grace_ms)",
	FLYWHEEL_DETECTION_FLEET_THRESHOLD:
		"tuning knob: same-kind overdue episode count that becomes ONE fleet aggregate instead of founder pages (FLY-1048 PR-C)",
	FLYWHEEL_DETECTION_RECONCILE_EVERY_N_TICKS:
		"tuning knob: detection-escalation reconcile cadence in GatePoller ticks (FLY-1048 PR-C)",
	FLYWHEEL_CLEARING_TTL_MS:
		"tuning knob: CLEARING mute TTL ms before an unfinished cleanup re-arms its episodes, default 2h (FLY-1048 PR-C C5)",
	FLYWHEEL_FRAME_INTERVAL_MS:
		"tuning knob: focused-frame capture interval ms (FLY-1048 A7)",
	FLYWHEEL_FRAME_CAPTURES_PER_TICK:
		"tuning knob: focused-frame capture budget per tick (FLY-1048 A7)",
	FLYWHEEL_REPORT_SHOT_WIDTH: "tuning knob: screenshot width",
	FLYWHEEL_ALERT_DRAIN_STUCK_CYCLES: "tuning knob: alert drain cycles",
	FLYWHEEL_ALERT_QUEUE_MAX: "tuning knob: alert queue max",
	FLYWHEEL_MAILBOX_WRITE_TIMEOUT_MS: "tuning knob: mailbox write timeout",
	FLYWHEEL_CLAUDE_REVIEW_TIMEOUT_MS:
		"tuning knob: active Claude review subprocess timeout (FLY-1254)",
	FLYWHEEL_AUTOCONTINUE_ARM_WINDOW_MS:
		"tuning knob: FLY-818 autocontinue arm-observe window (ms), lifecycle-bound",
	FLYWHEEL_CRASH_REAP_GRACE_MIN: "tuning knob: crash reap grace minutes",
	FLYWHEEL_PARKED_PHASE_STALE_HOURS:
		"tuning knob: parked three-stage phase reclaim time backstop hours (FLY-1204)",
	FLYWHEEL_BRIDGE_SHUTDOWN_TIMEOUT_MS: "tuning knob: bridge shutdown timeout",
	FLYWHEEL_FOUNDER_MILESTONE_PATROL_TICKS:
		"tuning knob: milestone patrol cadence (FLY-725)",
	FLYWHEEL_FOUNDER_MILESTONE_LOOKBACK_HOURS:
		"tuning knob: milestone patrol lookback (FLY-725)",
	FLYWHEEL_FOUNDER_MILESTONE_GRACE_MS:
		"tuning knob: milestone notify grace window (FLY-725)",
	FLYWHEEL_CRON_STALE_TTL_MIN:
		"tuning knob: cron stale-blocker TTL minutes (FLY-742)",
	FLYWHEEL_THREE_STAGE_MAX_FIX_ROUNDS:
		"tuning knob: three-stage QA fix-loop round cap, default 3 (FLY-859)",
	// FLY-927 infra-alert ticket-queue rollout levers (all default-off = current
	// behavior; ops-flipped in ~/.flywheel/.env + Bridge restart, NOT founder
	// dashboard toggles yet — same class as the internal ops levers above). When
	// FLY-928 deploys them, consider promoting the three boolean gates to
	// registered founder flags like FLY-368's alert_threads / auto_repair.
	FLYWHEEL_ALERT_ROUTING:
		"internal ops lever: D1 responder-based alert routing + /send gating, default-off (FLY-927)",
	FLYWHEEL_ALERT_TICKETS:
		"internal ops lever: 🎫 ticket schema header + owner @-target + lifecycle/T2, default-off (FLY-927)",
	FLYWHEEL_CHECKPOINT_WATCHDOG:
		"internal ops lever: Watchdog v2 checkpoint-park patrol, default-off (FLY-927)",
	FLYWHEEL_ALERT_SENDER_TOKEN_ENV:
		"config value: single alert-sender token env NAME (D2), default-unset = own-bot chain (FLY-927)",
	FLYWHEEL_CHECKPOINT_STUCK_MS:
		"tuning knob: Watchdog v2 checkpoint-park stuck threshold ms, default 3600000 (FLY-927)",
};

function walk(dir: string, out: string[]): void {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const e of entries) {
		const p = join(dir, e);
		if (statSync(p).isDirectory()) {
			if (e === "__tests__" || e === "node_modules" || e === "dist") continue;
			walk(p, out);
		} else if (
			e.endsWith(".ts") &&
			!e.endsWith(".test.ts") &&
			!e.endsWith(".d.ts")
		) {
			out.push(p);
		}
	}
}

// Direct `process.env.X` reads (broad — plumbing/value vars are allowlisted).
// PLUS injected `env.X` reads (function-parameter reads like
// `env.FLYWHEEL_STUCK_DETECT !== "0"`, which the process.env scan missed — Codex
// R1 HIGH), but ONLY anchored to a BOOLEAN-GATE comparison (=== / !== "0"|"1"|
// "true"|"false"). Matching every `env.X` catches dozens of injected config
// VALUES (channel ids, thresholds, paths) that are not gates — the boolean
// anchor isolates real on/off gates and keeps the guard low-noise.
const BOOL_CMP = String.raw`\s*(?:===|!==)\s*["'](?:0|1|true|false)["']`;
const ENV_PATTERNS = [
	/process\.env\.(FLYWHEEL_[A-Z0-9_]+)/g,
	/process\.env\[\s*["'](FLYWHEEL_[A-Z0-9_]+)["']\s*\]/g,
	new RegExp(String.raw`\benv\.(FLYWHEEL_[A-Z0-9_]+)` + BOOL_CMP, "g"),
	new RegExp(
		String.raw`\benv\[\s*["'](FLYWHEEL_[A-Z0-9_]+)["']\s*\]` + BOOL_CMP,
		"g",
	),
];

function scanFlywheelEnvNames(): Set<string> {
	const files: string[] = [];
	for (const d of SCAN_DIRS) walk(join(REPO_ROOT, d), files);
	const names = new Set<string>();
	for (const f of files) {
		const src = readFileSync(f, "utf-8");
		for (const re of ENV_PATTERNS) {
			re.lastIndex = 0;
			let m: RegExpExecArray | null = re.exec(src);
			while (m !== null) {
				names.add(m[1] as string);
				m = re.exec(src);
			}
		}
	}
	return names;
}

describe("feature-flag drift guard", () => {
	const registeredEnvVars = new Set(
		FEATURE_FLAGS.filter((f) => f.envVar).map((f) => f.envVar as string),
	);

	it("scanner finds FLYWHEEL_* env reads in production src", () => {
		const found = scanFlywheelEnvNames();
		expect(found.size).toBeGreaterThan(5);
		// a known gate read via direct process.env access
		expect(found.has("FLYWHEEL_FLEET_CONSOLE")).toBe(true);
	});

	it("every registered env flag is read where its readSite file claims", () => {
		const missing: string[] = [];
		for (const flag of FEATURE_FLAGS) {
			if (!flag.envVar) continue;
			const found = flag.readSites.some((s) => {
				try {
					return readFileSync(join(REPO_ROOT, s.file), "utf-8").includes(
						flag.envVar as string,
					);
				} catch {
					return false;
				}
			});
			if (!found) missing.push(`${flag.name} (${flag.envVar})`);
		}
		expect(
			missing,
			`registered but not found in readSite file: ${missing.join(", ")}`,
		).toEqual([]);
	});

	it("no silent new gate: every scanned FLYWHEEL_* is registered or allowlisted", () => {
		const found = scanFlywheelEnvNames();
		const unregistered = [...found].filter(
			(v) => !registeredEnvVars.has(v) && !(v in NON_FLAG_ALLOWLIST),
		);
		expect(
			unregistered,
			`new FLYWHEEL_* env not registered or allowlisted (register it, or add to NON_FLAG_ALLOWLIST with a reason): ${unregistered.join(", ")}`,
		).toEqual([]);
	});
});
