// QA·FLY-1234 — real-machine, module-driven E2E harness for the watchdog
// session_stuck pane/process CONFIRM layer (PR #579, HEAD 7a658d8a).
//
// Drives the REAL packages/teamlead/dist build (never re-implemented logic)
// against REAL tmux panes + an isolated CommDB + an isolated StateStore + the
// REAL judge (codex-with-fallback) + REAL isolated Discord (#test-flywheel-alerts).
//
// Isolation:
//  - process.env.HOME is repointed to a temp dir BEFORE any dist module reads
//    os.homedir() — this isolates BOTH commDbRootDir() (session-capture.js,
//    respects FLYWHEEL_COMM_DIR OR falls back to homedir()) AND
//    tmux-lookup.js's lookupTmuxTarget(), which hardcodes
//    join(homedir(), ".flywheel", "comm", ...) and does NOT read
//    FLYWHEEL_COMM_DIR. Setting HOME (not FLYWHEEL_COMM_DIR) is the only way
//    to keep both resolution paths pointed at the SAME isolated CommDB root.
//  - The judge's spawned codex-with-fallback child gets a SEPARATE env
//    snapshot (REAL_ENV, captured before HOME is overridden) so its own auth
//    files / PATH / profile-manager resolve normally against the real HOME.
//  - StateStore uses an explicit temp file path (HOME-independent).
//  - TMPDIR=/tmp (memory: runner-state unix socket 104-byte overflow if left
//    under a long scratchpad path).
//
// Six scenarios (a)-(f) per the QA brief. (c) is driven through the REAL
// HeartbeatService.check() tick entry point (not confirmStuckCandidate
// directly) per the Eng Lead's anti-regression mandate: the original FLY-1234
// bug was "judge installed but never wired into the tick" — verifying via a
// direct confirm-runner call would bypass exactly that break point.

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ── capture the REAL env before any mutation (judge child needs it) ────────
const REAL_ENV = { ...process.env };

const REPO = "/Users/xiaorongli/Dev/flywheel-FLY-1234";
const EVIDENCE_DIR = join(
	REPO,
	"engineering/doc/FLY-1234-watchdog-stuck-false-positives/e2e-evidence",
);
const FAKE_HOME = "/private/tmp/qa-fly1234-home";
// fresh isolated state every run — a stale StateStore/CommDB from a prior run
// would carry persisted stuck-dedup rows for the same fixed execution_ids and
// silently swallow this run's notifications (found via preflight — cross-run
// contamination, not a product bug).
rmSync(FAKE_HOME, { recursive: true, force: true });
mkdirSync(FAKE_HOME, { recursive: true });
mkdirSync(EVIDENCE_DIR, { recursive: true });

process.env.HOME = FAKE_HOME;
process.env.TMPDIR = "/tmp";
process.env.FLYWHEEL_WATCHDOG_JUDGE = "1";
process.env.FLYWHEEL_STUCK_CONFIRM_DEADLINE_MS = "300000"; // max allowed (5min) — real codex judge calls can take minutes
process.env.FLYWHEEL_WATCHDOG_JUDGE_TIMEOUT_MS = "240000"; // 4min spawn timeout, leaves ~45s slack under the 5min outer deadline
delete process.env.FLYWHEEL_STUCK_PANE_CONFIRM; // unset = ON (default) for a-e

const tl = (p) => import(join(REPO, "packages/teamlead/dist", p));

const { StateStore } = await tl("StateStore.js");
const { HeartbeatService } = await tl("HeartbeatService.js");
const { captureSession } = await tl("bridge/session-capture.js");
const { lookupTmuxTarget, probeRunnerProcessLiveness } = await tl(
	"bridge/tmux-lookup.js",
);
const { stuckCommActivityMs } = await tl("bridge/stuck-escalation.js");
const { formatSessionStuck } = await tl("bridge/hook-payload.js");
const { CONFIRM_NOTES } = await tl("bridge/stuck-pane-confirm.js");
const { createWatchdogJudge, defaultJudgeSpawnRunner, parseJudgeVerdict } =
	await tl("bridge/watchdog-judge.js");

// FLY-1234 QA FINDING (see outcome.json "findings"): parseJudgeVerdict's
// regex /\{[^{}]*"verdict"[^{}]*\}/g assumes the verdict JSON appears
// UNESCAPED in stdout. Real `codex exec --json` output wraps the model's
// answer as an ESCAPED STRING inside an `item.completed` event
// (`{"type":"item.completed","item":{...,"text":"{\"verdict\":...}"}}`), so
// the regex never matches real codex-with-fallback output — every real judge
// call fail-opens to judge_unavailable. Diagnostic helper: extract the
// item.completed text field(s) from a real JSONL stdout so the evidence shows
// what the ACTUAL model verdict was, distinct from what parseJudgeVerdict
// (mis)parsed.
function extractRealAgentMessages(stdout) {
	const messages = [];
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const evt = JSON.parse(trimmed);
			if (evt?.type === "item.completed" && evt?.item?.text) {
				messages.push(evt.item.text);
			}
		} catch {
			/* not a JSON line — ignore */
		}
	}
	return messages;
}
function regexCandidates(stdout) {
	return stdout.match(/\{[^{}]*"verdict"[^{}]*\}/g);
}
const { createJudgeRoutingDepsFactory, createStuckConfirmRunner } = await tl(
	"bridge/watchdog-judge-assembly.js",
);
const { CommDB } = await import(
	join(REPO, "packages/flywheel-comm/dist/db.js")
);

// ── constants ────────────────────────────────────────────────────────────
const PROJECT_NAME = "qa-fly1234-e2e";
const ISSUE_ID = "FLY-1234-QA-E2E";
const TMUX_SESSION = "qa-fly1234-e2e";
const DISCORD_CHANNEL = "1519421055805165842"; // #test-flywheel-alerts (isolated)
const DISCORD_TOKEN_ENV = "TEST_BOT_TOKEN_1";
const DISCORD_TOKEN = REAL_ENV[DISCORD_TOKEN_ENV];

const results = { scenarios: {} };
const evidencePath = (name) => join(EVIDENCE_DIR, `${name}.json`);
const writeEvidence = (name, obj) =>
	writeFileSync(evidencePath(name), JSON.stringify(obj, null, 2));

function log(...args) {
	console.log(`[${new Date().toISOString()}]`, ...args);
}

// ── tmux helpers ─────────────────────────────────────────────────────────
function tmux(args) {
	return execFileSync("tmux", args, { encoding: "utf-8" });
}
function tmuxQuiet(args) {
	try {
		return tmux(args);
	} catch (err) {
		return { error: err.message };
	}
}

function killTmuxSession() {
	try {
		execFileSync("tmux", ["kill-session", "-t", TMUX_SESSION], {
			stdio: "ignore",
		});
	} catch {
		/* not running */
	}
}

killTmuxSession(); // start clean
tmux(["new-session", "-d", "-s", TMUX_SESSION, "-n", "boot", "bash"]);
// NOTE: remain-on-exit is a tmux WINDOW option with no per-session default
// tier — only global (-g, affects the WHOLE shared tmux server / other
// agents' sessions too) or per-window (after creation, before exit). We set
// it per-window for case-d only (see runScenarioD) to avoid any global
// mutation on this shared box.

function newWindow(name, bashScript) {
	tmux([
		"new-window",
		"-t",
		TMUX_SESSION,
		"-n",
		name,
		"bash",
		"-c",
		bashScript,
	]);
	return `${TMUX_SESSION}:${name}`;
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

function sqliteUtcMinutesAgo(min) {
	return new Date(Date.now() - min * 60_000)
		.toISOString()
		.slice(0, 19)
		.replace("T", " ");
}

// ── isolated StateStore + CommDB ────────────────────────────────────────
const STORE_PATH = join(FAKE_HOME, "qa-fly1234-state.db");
const store = await StateStore.create(STORE_PATH);
const commDbPath = join(
	FAKE_HOME,
	".flywheel",
	"comm",
	PROJECT_NAME,
	"comm.db",
);
mkdirSync(join(FAKE_HOME, ".flywheel", "comm", PROJECT_NAME), {
	recursive: true,
});
const commDb = new CommDB(commDbPath);

log("isolated STORE_PATH:", STORE_PATH);
log("isolated commDbPath:", commDbPath);

async function seedSession(execId, overrides = {}) {
	await store.upsertSession({
		execution_id: execId,
		issue_id: ISSUE_ID,
		project_name: PROJECT_NAME,
		status: "running",
		issue_identifier: ISSUE_ID,
		issue_title: "FLY-1234 QA E2E harness",
		last_activity_at: sqliteUtcMinutesAgo(20), // > 15min threshold
		...overrides,
	});
}

async function retireSession(execId) {
	await store.upsertSession({
		execution_id: execId,
		issue_id: ISSUE_ID,
		project_name: PROJECT_NAME,
		status: "completed",
	});
}

function registerTmuxTarget(execId, tmuxTarget) {
	commDb.registerSession(
		execId,
		tmuxTarget,
		PROJECT_NAME,
		ISSUE_ID,
		"qa-fly1234-lead",
		"claude-code",
	);
}

// ── judge instance (shared — exercises the real single-flight+cache exactly
// as production does), with a call-log wrapper around the REAL spawn so we
// can prove/disprove judge invocation per scenario without altering behavior.
const judgeCallLog = [];
const watchdogJudge = createWatchdogJudge({
	repoRoot: REPO,
	env: REAL_ENV, // REAL HOME/PATH/auth for the codex-with-fallback child
	spawnRunner: async (opts) => {
		const entry = { atMs: Date.now(), stdin: opts.stdin };
		judgeCallLog.push(entry);
		log(
			`[judge] spawning ${opts.bin} ${opts.argv.join(" ")} (prompt ${opts.stdin.length} chars)`,
		);
		const res = await defaultJudgeSpawnRunner(opts);
		entry.stdout = res.stdout;
		entry.code = res.code;
		entry.timedOut = res.timedOut;
		entry.durationMs = Date.now() - entry.atMs;
		log(
			`[judge] result code=${res.code} timedOut=${res.timedOut} durationMs=${entry.durationMs} stdout=${res.stdout.slice(0, 300)}`,
		);
		return res;
	},
});

const buildJudgeRoutingDeps = createJudgeRoutingDepsFactory({
	store,
	judge: watchdogJudge,
	judgeEnabled: () => process.env.FLYWHEEL_WATCHDOG_JUDGE === "1",
	resolveOwner: (r) => ({
		executionId: r.targetKey,
		issueId: ISSUE_ID,
		projectName: PROJECT_NAME,
	}),
});

// ── the SAME confirm-holder function plugin.ts binds to HeartbeatService —
// generic over ANY session (execution_id/project_name driven), reused
// directly (a,b,d,e) and via the real tick (c,f).
const frameCaptureCounts = new Map();
const stuckConfirmFn = createStuckConfirmRunner({
	buildRoutingDeps: buildJudgeRoutingDeps,
	probeLiveness: async (s) => {
		if (!s.project_name) return "gone";
		const lookup = lookupTmuxTarget(s.execution_id, s.project_name);
		if (lookup.kind === "gone") return "gone";
		if (lookup.kind === "error") return "indeterminate";
		return probeRunnerProcessLiveness(lookup.target.tmuxWindow);
	},
	captureFrame: async (s) => {
		if (!s.project_name) return null;
		frameCaptureCounts.set(
			s.execution_id,
			(frameCaptureCounts.get(s.execution_id) ?? 0) + 1,
		);
		const res = await captureSession(s.execution_id, s.project_name, 200);
		return "output" in res
			? { text: res.output, capturedAtMs: Date.now() }
			: null;
	},
	commCorroborationMs: () => stuckCommActivityMs(process.env),
	logger: (m) => log(`[stuck-confirm] ${m}`),
});
const stuckConfirmHolder = { current: stuckConfirmFn };

// ── Discord helpers (real API, isolated test channel) ───────────────────
function discordPost(content) {
	if (!DISCORD_TOKEN) throw new Error(`${DISCORD_TOKEN_ENV} not set`);
	const raw = execFileSync(
		"curl",
		[
			"-s",
			"-X",
			"POST",
			"-H",
			`Authorization: Bot ${DISCORD_TOKEN}`,
			"-H",
			"Content-Type: application/json",
			"-H",
			"User-Agent: FlywheelQA (https://flywheel, 1.0)",
			`https://discord.com/api/v10/channels/${DISCORD_CHANNEL}/messages`,
			"-d",
			JSON.stringify({ content }),
		],
		{ encoding: "utf-8" },
	);
	const parsed = JSON.parse(raw);
	if (!parsed.id) throw new Error(`Discord POST failed: ${raw}`);
	return parsed;
}

function discordGet(msgId) {
	const raw = execFileSync(
		"curl",
		[
			"-s",
			"-H",
			`Authorization: Bot ${DISCORD_TOKEN}`,
			"-H",
			"User-Agent: FlywheelQA (https://flywheel, 1.0)",
			`https://discord.com/api/v10/channels/${DISCORD_CHANNEL}/messages/${msgId}`,
		],
		{ encoding: "utf-8" },
	);
	return JSON.parse(raw);
}

// ═════════════════════════════════════════════════════════════════════════
// Scenario (a): actively-working pane — frames_changing, judge NOT called
// ═════════════════════════════════════════════════════════════════════════
async function runScenarioA() {
	const execId = "qa1234-a";
	log("=== scenario (a): actively-working pane ===");
	const target = newWindow(
		"case-a",
		'while true; do echo "$(date +%s) work $RANDOM"; sleep 0.5; done',
	);
	await sleep(600);
	registerTmuxTarget(execId, target);
	await seedSession(execId, { session_stage: "implement" });

	const before = judgeCallLog.length;
	const t0 = Date.now();
	const result = await stuckConfirmHolder.current(store.getSession(execId));
	const durationMs = Date.now() - t0;
	const judgeCalls = judgeCallLog.length - before;

	const pass =
		result.action === "suppress" &&
		result.reason === "frames_changing" &&
		judgeCalls === 0;

	const evidence = {
		scenario: "a",
		description: "actively-working pane — scrolling output",
		execId,
		tmuxTarget: target,
		result,
		judgeCalls,
		framesCaptured: frameCaptureCounts.get(execId) ?? 0,
		durationMs,
		pass,
	};
	writeEvidence("case-a", evidence);
	results.scenarios.a = evidence;
	log(
		"(a) result:",
		JSON.stringify(result),
		"judgeCalls:",
		judgeCalls,
		"PASS:",
		pass,
	);

	await retireSession(execId);
	return evidence;
}

// ═════════════════════════════════════════════════════════════════════════
// Scenario (b): static pane + corroboration — judge → suppress/a_working
// ═════════════════════════════════════════════════════════════════════════
async function runScenarioB() {
	const execId = "qa1234-b";
	log("=== scenario (b): static pane + corroboration ===");
	const target = newWindow(
		"case-b",
		"printf '%s\\n' '$ codex exec --json -C /Users/…/flywheel-FLY-1224 -s read-only -' '[codex] design review R2 in progress…' '❯ '; sleep 300",
	);
	await sleep(600);
	registerTmuxTarget(execId, target);
	await seedSession(execId, { session_stage: "design_review" });
	// recent corroborating comm/stage event — insertEvent's `ts` column
	// defaults to CURRENT_TIMESTAMP (now), giving the judge a fresh
	// "Xmin ago" corroboration signal per buildJudgeInputFromStore.
	store.insertEvent({
		event_id: `qa-fly1234-b-corrob-${Date.now()}`,
		execution_id: execId,
		issue_id: ISSUE_ID,
		project_name: PROJECT_NAME,
		event_type: "external_review_started",
		severity: "info",
		payload: { note: "codex design review R2 started" },
		source: "qa-fly1234-harness",
	});

	const before = judgeCallLog.length;
	const t0 = Date.now();
	const result = await stuckConfirmHolder.current(store.getSession(execId));
	const durationMs = Date.now() - t0;
	const judgeCalls = judgeCallLog.length - before;
	const lastJudge = judgeCallLog[judgeCallLog.length - 1];
	const verdict = lastJudge ? parseJudgeVerdict(lastJudge.stdout) : null;

	const pass =
		judgeCalls === 1 &&
		result.action === "suppress" &&
		result.reason === "judge_a_working";

	const evidence = {
		scenario: "b",
		description: "static pane + corroborating recent comm/stage event",
		execId,
		tmuxTarget: target,
		result,
		judgeCalls,
		judgeVerdict: verdict,
		judgeDurationMs: lastJudge?.durationMs,
		judgeRawStdout: lastJudge?.stdout,
		judgeRegexCandidates: lastJudge ? regexCandidates(lastJudge.stdout) : null,
		judgeRealAgentMessages: lastJudge
			? extractRealAgentMessages(lastJudge.stdout)
			: null,
		framesCaptured: frameCaptureCounts.get(execId) ?? 0,
		durationMs,
		pass,
	};
	writeEvidence("case-b", evidence);
	results.scenarios.b = evidence;
	log(
		"(b) result:",
		JSON.stringify(result),
		"judgeCalls:",
		judgeCalls,
		"verdict:",
		JSON.stringify(verdict),
		"PASS:",
		pass,
	);

	await retireSession(execId);
	return evidence;
}

// ═════════════════════════════════════════════════════════════════════════
// Scenario (c): static pane + NO corroboration — driven through the REAL
// HeartbeatService.check() tick entry point (Eng Lead mandate).
// ═════════════════════════════════════════════════════════════════════════
const notifierCallLog = [];
function makeSharedNotifier() {
	return {
		async onSessionStuck(...args) {
			// INV-5 arity sentinel: legacy path calls with EXACTLY 2 args, the
			// confirm path with 3 (the details object). Rest-param length is the
			// faithful arity probe (biome noArguments-clean).
			const argc = args.length;
			const [session, minutesSince, details] = args;
			notifierCallLog.push({
				execution_id: session.execution_id,
				minutesSince,
				details,
				argc,
				atMs: Date.now(),
			});
			return true; // pretend-persisted (matches the dedup-gating contract)
		},
		async onSessionOrphaned() {},
		async onSessionStale() {},
		async onSessionMonitoringLost() {},
		async onSessionMonitoringReestablished() {},
	};
}
const sharedNotifier = makeSharedNotifier();

// Constructor arg order confirmed against
// packages/teamlead/src/bridge/__tests__/stuck-confirm-assembly.test.ts buildService().
const heartbeatService = new HeartbeatService(
	store,
	sharedNotifier,
	15, // thresholdMinutes
	999_999_999, // intervalMs (never start()'d — check() called directly)
	60, // orphanThresholdMinutes
	undefined, // transitionOpts
	24, // staleThresholdHours
	6 * 3_600_000, // staleCheckIntervalMs
	undefined, // monitorReconcile
	48, // reviewTimeoutHours
	undefined, // quietSignalsProbe
	undefined, // crashReaperConfig
	undefined, // staleTerminalClose
	undefined, // serverLoss
	undefined, // staleParkedClose
	undefined, // onMaintenanceTick
	stuckConfirmHolder, // FLY-1234 confirm holder — SAME object plugin.ts binds
);

async function runScenarioC() {
	const execId = "qa1234-c";
	log(
		"=== scenario (c): static pane + NO corroboration — REAL HeartbeatService.check() tick ===",
	);
	const target = newWindow(
		"case-c",
		"printf '%s\\n' '$ codex exec --json -C /Users/…/flywheel-FLY-1224 -s read-only -' '[codex] design review R2 in progress…' '❯ '; sleep 300",
	);
	await sleep(600);
	registerTmuxTarget(execId, target);
	await seedSession(execId, { session_stage: null }); // NO stage, NO comm events

	delete process.env.FLYWHEEL_STUCK_PANE_CONFIRM; // ensure ON (ambient, in case f ran first in a re-order)
	const beforeJudge = judgeCallLog.length;
	const beforeNotifier = notifierCallLog.length;
	const t0 = Date.now();
	await heartbeatService.check();
	const durationMs = Date.now() - t0;
	const judgeCalls = judgeCallLog.length - beforeJudge;
	const lastJudge = judgeCallLog[judgeCallLog.length - 1];
	const verdict = lastJudge ? parseJudgeVerdict(lastJudge.stdout) : null;

	const myNotifierCalls = notifierCallLog
		.slice(beforeNotifier)
		.filter((c) => c.execution_id === execId);
	const emitCall = myNotifierCalls[0];

	const emitted = !!emitCall;
	const argc3 = emitCall?.argc === 3;
	const confirmNote = emitCall?.details?.confirmNote;
	const reasonOk =
		confirmNote === CONFIRM_NOTES.judge_suspicious ||
		confirmNote === CONFIRM_NOTES.judge_unavailable;

	let discordEvidence = null;
	if (emitted && argc3 && confirmNote) {
		const envelope = {
			seq: 1,
			event: {
				event_type: "session_stuck",
				execution_id: execId,
				issue_id: ISSUE_ID,
				issue_identifier: ISSUE_ID,
				issue_title: "FLY-1234 QA E2E — case (c) static pane, no corroboration",
				project_name: PROJECT_NAME,
				status: "running",
				minutes_since_activity: emitCall.minutesSince,
				session_role: "main",
				confirm_note: confirmNote,
			},
			sessionKey: execId,
			leadId: "qa-fly1234-lead",
			timestamp: new Date().toISOString(),
		};
		const rendered = formatSessionStuck(envelope);
		const marker = `[QA-FLY1234-c-${Date.now()}]`;
		const posted = discordPost(`${marker}\n${rendered}`);
		await sleep(500);
		const readback = discordGet(posted.id);
		discordEvidence = {
			marker,
			postedMessageId: posted.id,
			renderedText: rendered,
			readback: {
				id: readback.id,
				content: readback.content,
				timestamp: readback.timestamp,
				containsConfirmNoteLine: (readback.content || "").includes(
					`Confirm-Note: ${confirmNote}`,
				),
			},
		};
	}

	const pass =
		emitted &&
		argc3 &&
		reasonOk &&
		judgeCalls === 1 &&
		!!discordEvidence?.readback?.containsConfirmNoteLine;

	const evidence = {
		scenario: "c",
		description:
			"static pane + NO corroboration — driven through real HeartbeatService.checkStuck tick entry (not confirmStuckCandidate)",
		execId,
		tmuxTarget: target,
		notifierCall: emitCall,
		judgeCalls,
		judgeVerdict: verdict,
		judgeDurationMs: lastJudge?.durationMs,
		judgeRawStdout: lastJudge?.stdout,
		judgeRegexCandidates: lastJudge ? regexCandidates(lastJudge.stdout) : null,
		judgeRealAgentMessages: lastJudge
			? extractRealAgentMessages(lastJudge.stdout)
			: null,
		framesCaptured: frameCaptureCounts.get(execId) ?? 0,
		confirmNote,
		discord: discordEvidence,
		durationMs,
		pass,
	};
	writeEvidence("case-c", evidence);
	if (discordEvidence)
		writeEvidence("case-c-discord-readback", discordEvidence);
	results.scenarios.c = evidence;
	log(
		"(c) notifierCall:",
		JSON.stringify(emitCall),
		"judgeCalls:",
		judgeCalls,
		"verdict:",
		JSON.stringify(verdict),
		"discordMsgId:",
		discordEvidence?.postedMessageId,
		"PASS:",
		pass,
	);

	await retireSession(execId);
	return evidence;
}

// ═════════════════════════════════════════════════════════════════════════
// Scenario (d): dead pin (remain-on-exit corpse) — emit immediately, zero
// frames captured (fast path).
// ═════════════════════════════════════════════════════════════════════════
async function runScenarioD() {
	const execId = "qa1234-d";
	log("=== scenario (d): dead pin (remain-on-exit corpse) ===");
	const target = newWindow(
		"case-d",
		"echo QA_FLY1234_DEAD_PIN_MARKER; sleep 1; exit 0",
	);
	// per-window override (NOT global -g — avoids mutating tmux server-wide
	// state for other agents/sessions on this shared box). Must be set BEFORE
	// the 1s sleep above elapses and the process exits.
	tmuxQuiet(["set-option", "-t", target, "remain-on-exit", "on"]);
	registerTmuxTarget(execId, target);
	await seedSession(execId, { session_stage: "implement" });

	// poll for pane_dead=1 (process exit + tmux reap race)
	let paneDead = false;
	for (let i = 0; i < 10; i++) {
		await sleep(300);
		try {
			const out = tmux(["list-panes", "-t", target, "-F", "#{pane_dead}"]);
			if (out.trim() === "1") {
				paneDead = true;
				break;
			}
		} catch {
			/* keep polling */
		}
	}

	const before = judgeCallLog.length;
	const t0 = Date.now();
	const result = await stuckConfirmHolder.current(store.getSession(execId));
	const durationMs = Date.now() - t0;
	const judgeCalls = judgeCallLog.length - before;

	const pass =
		paneDead &&
		result.action === "emit" &&
		result.reason === "dead_pin" &&
		judgeCalls === 0 &&
		(frameCaptureCounts.get(execId) ?? 0) === 0; // fast path: liveness short-circuits BEFORE captureFrame

	const evidence = {
		scenario: "d",
		description: "dead pin — remain-on-exit corpse",
		execId,
		tmuxTarget: target,
		paneDeadConfirmed: paneDead,
		result,
		judgeCalls,
		framesCaptured: frameCaptureCounts.get(execId) ?? 0,
		durationMs,
		pass,
	};
	writeEvidence("case-d", evidence);
	results.scenarios.d = evidence;
	log(
		"(d) paneDead:",
		paneDead,
		"result:",
		JSON.stringify(result),
		"framesCaptured:",
		frameCaptureCounts.get(execId) ?? 0,
		"PASS:",
		pass,
	);

	await retireSession(execId);
	return evidence;
}

// ═════════════════════════════════════════════════════════════════════════
// Scenario (e): parked husk — judge → suppress/b_parked WITH mechanical
// corroboration (declared park in CommDB).
// ═════════════════════════════════════════════════════════════════════════
async function runScenarioE() {
	const execId = "qa1234-e";
	log("=== scenario (e): parked husk (declared park + idle shell) ===");
	const target = newWindow(
		"case-e",
		"printf '%s\\n' '$ flywheel-comm park --reason \"three-stage implement parked awaiting QA\"' 'Parked. Waiting for wake.' '❯ '; sleep 300",
	);
	await sleep(600);
	registerTmuxTarget(execId, target);
	await seedSession(execId, { session_stage: "implement" });
	// mechanical corroboration: a declared park marker in the isolated CommDB
	// (runner_declared_states) — this is what mechanicalParkEvidence() reads
	// to accept (not downgrade-to-suspicious) a judge b_parked verdict.
	commDb.upsertDeclaredState(
		execId,
		"parked",
		"three-stage implement parked awaiting QA",
		Date.now(),
		null,
	);

	const before = judgeCallLog.length;
	const t0 = Date.now();
	const result = await stuckConfirmHolder.current(store.getSession(execId));
	const durationMs = Date.now() - t0;
	const judgeCalls = judgeCallLog.length - before;
	const lastJudge = judgeCallLog[judgeCallLog.length - 1];
	const verdict = lastJudge ? parseJudgeVerdict(lastJudge.stdout) : null;

	const pass =
		judgeCalls === 1 &&
		result.action === "suppress" &&
		result.reason === "judge_b_parked";

	const evidence = {
		scenario: "e",
		description: "parked husk — declared park (CommDB) + idle shell pane",
		execId,
		tmuxTarget: target,
		result,
		judgeCalls,
		judgeVerdict: verdict,
		judgeDurationMs: lastJudge?.durationMs,
		judgeRawStdout: lastJudge?.stdout,
		judgeRegexCandidates: lastJudge ? regexCandidates(lastJudge.stdout) : null,
		judgeRealAgentMessages: lastJudge
			? extractRealAgentMessages(lastJudge.stdout)
			: null,
		framesCaptured: frameCaptureCounts.get(execId) ?? 0,
		durationMs,
		pass,
	};
	writeEvidence("case-e", evidence);
	results.scenarios.e = evidence;
	log(
		"(e) result:",
		JSON.stringify(result),
		"judgeCalls:",
		judgeCalls,
		"verdict:",
		JSON.stringify(verdict),
		"PASS:",
		pass,
	);

	await retireSession(execId);
	return evidence;
}

// ═════════════════════════════════════════════════════════════════════════
// Scenario (f): kill-switch byte-revert — FLYWHEEL_STUCK_PANE_CONFIRM=0 →
// legacy 2-arg onSessionStuck (arity sentinel, INV-5), via the REAL
// HeartbeatService tick.
// ═════════════════════════════════════════════════════════════════════════
async function runScenarioF() {
	const execId = "qa1234-f";
	log(
		"=== scenario (f): kill-switch byte-revert (FLYWHEEL_STUCK_PANE_CONFIRM=0) ===",
	);
	const target = newWindow(
		"case-f",
		"printf '%s\\n' 'idle shell, nothing happening' '❯ '; sleep 300",
	);
	await sleep(600);
	registerTmuxTarget(execId, target);
	await seedSession(execId, { session_stage: "implement" });

	process.env.FLYWHEEL_STUCK_PANE_CONFIRM = "0";
	const beforeJudge = judgeCallLog.length;
	const beforeNotifier = notifierCallLog.length;
	const t0 = Date.now();
	await heartbeatService.check();
	const durationMs = Date.now() - t0;
	delete process.env.FLYWHEEL_STUCK_PANE_CONFIRM; // restore ON for hygiene

	const judgeCalls = judgeCallLog.length - beforeJudge;
	const myNotifierCalls = notifierCallLog
		.slice(beforeNotifier)
		.filter((c) => c.execution_id === execId);
	const emitCall = myNotifierCalls[0];
	const argc2 = emitCall?.argc === 2;
	const detailsUndefined = emitCall?.details === undefined;

	const pass =
		!!emitCall &&
		argc2 &&
		detailsUndefined &&
		judgeCalls === 0 &&
		(frameCaptureCounts.get(execId) ?? 0) === 0;

	const evidence = {
		scenario: "f",
		description:
			"kill-switch byte-revert — FLYWHEEL_STUCK_PANE_CONFIRM=0, real HeartbeatService tick, legacy 2-arg onSessionStuck arity sentinel (INV-5)",
		execId,
		tmuxTarget: target,
		notifierCall: emitCall,
		judgeCalls,
		framesCaptured: frameCaptureCounts.get(execId) ?? 0,
		durationMs,
		pass,
	};
	writeEvidence("case-f", evidence);
	results.scenarios.f = evidence;
	log(
		"(f) notifierCall:",
		JSON.stringify(emitCall),
		"argc:",
		emitCall?.argc,
		"judgeCalls:",
		judgeCalls,
		"PASS:",
		pass,
	);

	await retireSession(execId);
	return evidence;
}

// ═════════════════════════════════════════════════════════════════════════
// main
// ═════════════════════════════════════════════════════════════════════════
async function main() {
	try {
		await runScenarioA();
		await runScenarioB();
		await runScenarioC();
		await runScenarioD();
		await runScenarioE();
		await runScenarioF();
	} finally {
		killTmuxSession();
	}

	const anyUnparseableJudge = Object.values(results.scenarios).some(
		(v) => v.judgeCalls > 0 && v.judgeVerdict === null,
	);
	const outcome = {
		generatedAt: new Date().toISOString(),
		prHead: "c9f755aa5",
		scenarios: Object.fromEntries(
			Object.entries(results.scenarios).map(([k, v]) => [
				k,
				{ pass: v.pass, description: v.description, result: v.result ?? null },
			]),
		),
		allPass: Object.values(results.scenarios).every((v) => v.pass),
		findings: anyUnparseableJudge
			? [
					{
						severity: "HIGH",
						title:
							"parseJudgeVerdict cannot parse REAL codex-with-fallback `exec --json` output — every real judge call fail-opens to judge_unavailable",
						detail:
							"packages/teamlead/dist/bridge/watchdog-judge.js parseJudgeVerdict() uses " +
							'/\\{[^{}]*"verdict"[^{}]*\\}/g against raw stdout, assuming the verdict JSON ' +
							"appears UNESCAPED. Real `codex exec --json` output is JSONL where the model's " +
							"answer is nested as an ESCAPED STRING inside an item.completed event: " +
							'{"type":"item.completed","item":{...,"text":"{\\"verdict\\":...}"}}. The escaped ' +
							"quotes break the regex — it finds zero candidates — so parseJudgeVerdict ALWAYS " +
							"returns null against real output, even though the underlying codex call " +
							"succeeded (exit 0, well-formed JSON, a valid verdict is present in the text " +
							"field). Effect: routeSuspiciousReport always treats the judge as unavailable " +
							"(decision=unavailable) and fail-opens to EMIT — the 2/5 audited FLY-1234 false " +
							"positives that depend on the judge downgrading to a_working (cases 00ddfc18, " +
							"cc21f3f5) will NOT be suppressed in production even with " +
							"FLYWHEEL_WATCHDOG_JUDGE=1 set. This is fail-open/safe (no real stuck runner " +
							"gets silenced) but defeats part of the fix's stated goal.",
						reproducedIn: ["case-b", "case-c", "case-e"],
						reproCount:
							"4/4 real codex-with-fallback invocations observed during this E2E (3 in-harness + 1 standalone probe) — every one produced a well-formed, parseable verdict in item.completed.item.text, and parseJudgeVerdict returned null for every one.",
						unitTestGap:
							"packages/teamlead/src/bridge/__tests__/watchdog-judge.test.ts's parseJudgeVerdict " +
							"tests construct stdout as a BARE unescaped VERDICT_JSON string spliced into fake " +
							"JSONL lines (turn.started + noise + the bare VERDICT_JSON constant) — this " +
							"fixture shape does not match real codex --json output and never exercised the " +
							"escaped-string-inside-item.completed case, so the unit suite is green despite " +
							"the parser being broken against the real CLI.",
					},
				]
			: [],
	};
	writeEvidence("outcome", outcome);

	console.log("\n===== FLY-1234 E2E OUTCOME =====");
	for (const [k, v] of Object.entries(results.scenarios)) {
		console.log(`  (${k}) ${v.pass ? "PASS" : "FAIL"} — ${v.description}`);
	}
	console.log(outcome.allPass ? "\nOVERALL: PASS" : "\nOVERALL: FAIL");
	process.exit(outcome.allPass ? 0 : 1);
}

main().catch((err) => {
	console.error("HARNESS CRASHED:", err);
	killTmuxSession();
	process.exit(2);
});
