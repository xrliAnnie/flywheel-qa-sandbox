#!/usr/bin/env node
/**
 * QA · FLY-1236 — real-machine E2E for the /goal objective 4000-char fix.
 *
 * The unit tests intercept `runGoalFn` (mocked seam). This harness drives the REAL
 * production runtime (packages/claude-runner/dist) against a REAL `codex app-server`
 * daemon, with a REAL tmux TUI window and a REAL-SCALE task whose SOURCE text is
 * > 4000 chars — the exact regime that used to blow up thread/goal/set with
 * `-32600 goal objective must be at most 4000 characters` (the FLY-1225 incident).
 *
 * Proves the three things the Lead's pre-ship rule requires:
 *   A1 goal-set succeeds   — a > 4000-char SOURCE task no longer -32600s; the run
 *                            reaches a terminal status (no setup_failed throw).
 *   A2 kick body arrives   — the operative instruction + a unique token live ONLY in
 *                            the > 4000-char KICK (the objective is a short pointer);
 *                            the agent commits that token → the full kick reached it.
 *   A3 founder TUI alive    — the cmux/tmux pane renders + stays alive (the same-cause
 *                            "TUI dies" symptom is gone because goal-set succeeded).
 * Plus a negative control:
 *   B  fail-closed guard   — passing the > 4000 body AS the objective (the old
 *                            fold-everything form) throws `setup_failed` LOCALLY in
 *                            setGoal, so no oversized frame ever reaches the daemon.
 *
 * Requires: real `codex` auth (~/.codex), tmux, network. Spends codex tokens.
 * Run with a SHORT TMPDIR (e.g. TMPDIR=/tmp) so the fixture path is short.
 *
 * Usage:  TMPDIR=/tmp node scripts/qa-fly-1236-e2e.mjs
 * Exit 0 = PASS. Evidence -> engineering/doc/FLY-1236-codex-goal-objective-limit/qa/
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const RUNNER = join(REPO, "packages/claude-runner/dist/index.js");
const EVID = join(
	REPO,
	"engineering/doc/FLY-1236-codex-goal-objective-limit/qa",
);

const {
	CodexDaemonGoalRuntime,
	GoalRunError,
	GOAL_OBJECTIVE_MAX_CHARS,
	buildGoalObjective,
	buildGoalKickText,
	provisionCodexHome,
	resolveDaemonSocketPath,
	buildDaemonSandboxWritableRoots,
	ensureRunnerTuiWindow,
	killRunnerTuiWindow,
	isRunnerTuiWindowAlive,
	flywheelCodexBin,
	rawCodexBin,
} = await import(RUNNER);

const TMUX_SESSION = "qa-fly1236";
const WINDOW = "FLY-1236";
const EXEC_ID = `qa1236-${Date.now().toString(36)}`;

const log = (m) => console.log(`[qa] ${m}`);
const sh = (c, a, cwd) => execFileSync(c, a, { cwd, encoding: "utf8" }).trim();
const tmux = (...a) => spawnSync("tmux", a, { encoding: "utf8" });
const results = [];
const record = (id, pass, detail) => {
	results.push({ id, pass, detail });
	log(`${pass ? "PASS" : "FAIL"} ${id} — ${detail}`);
};

// ── fixture: main repo + a SIBLING LINKED worktree (production shape) ──
const ROOT = mkdtempSync(join(tmpdir(), "qa-fly1236-"));
mkdirSync(EVID, { recursive: true });
const mainRepo = join(ROOT, "repo");
const worktree = join(ROOT, "repo-qa-wt");
mkdirSync(mainRepo, { recursive: true });
sh("git", ["init", "-q", "-b", "main"], mainRepo);
sh("git", ["config", "user.email", "qa@flywheel.local"], mainRepo);
sh("git", ["config", "user.name", "QA FLY-1236"], mainRepo);
writeFileSync(join(mainRepo, "README.md"), "# qa fixture\n");
sh("git", ["add", "-A"], mainRepo);
sh("git", ["commit", "-qm", "init"], mainRepo);
sh("git", ["worktree", "add", "-q", "-b", "qa-wt", worktree], mainRepo);
const sandboxCwd = realpathSync(worktree);
const gitDir = sh(
	"git",
	["-C", sandboxCwd, "rev-parse", "--path-format=absolute", "--git-dir"],
	sandboxCwd,
);
const gitCommonDir = sh(
	"git",
	["-C", sandboxCwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
	sandboxCwd,
);

// ── build a REAL-SCALE task: SOURCE text > 4000 chars, token near the END ──
const TOKEN = `KICK-${Date.now().toString(36).toUpperCase()}-OK`;
// A realistic system layer (ponytail-ish + append) — this used to be folded into
// the objective too.
const systemLayer = [
	"# Runner system layer (FLY-1236 QA)",
	"Prefer the boring, obvious solution. Surface assumptions. Handle failure paths.",
	"You are unattended — never ask questions; use real shell commands.",
].join("\n");
// A prompt padded to look like an issue body + design handoff, so the SOURCE is
// genuinely real-scale (> 4000). The operative instruction + token sit AFTER the
// filler, so a truncated/partial kick would miss them.
const filler = Array.from(
	{ length: 60 },
	(_, i) =>
		`Design note ${i + 1}: this line stands in for real issue-description and design-handoff prose that a genuine DAG workflow implement objective carries, which is exactly what pushed the folded objective past the 4000-char thread/goal/set ceiling in the FLY-1225 incident.`,
).join("\n");
const prompt = `You are working inside the git worktree at ${sandboxCwd}.

## Task background (real-scale filler)
${filler}

## The actual work (perform this)
CRITICAL TURN DISCIPLINE: do EXACTLY ONE step per turn, then END YOUR TURN.

Step 1: create a file named kick-marker.txt whose ONLY content is this exact token:
        ${TOKEN}
        Then run: git add kick-marker.txt && git commit -m "qa kick marker"
        Then END YOUR TURN.

Step 2: run git log --oneline, then create done.txt whose content is the number of commits.
        Then run: git add done.txt && git commit -m "qa done"
        The objective is COMPLETE once done.txt is committed.`;

// The FLY-1236 split: short pointer objective + full body via the kick turn.
const objective = buildGoalObjective({
	issueId: "FLY-1225",
	label: "FLY-1225-codex-implement-real-scale",
});
const kickText = buildGoalKickText({ systemLayer, prompt });
const foldedLen = `${systemLayer}\n\n---\n\n${prompt}`.length; // the OLD objective size

record(
	"A0-split-shape",
	objective.length <= GOAL_OBJECTIVE_MAX_CHARS &&
		foldedLen > GOAL_OBJECTIVE_MAX_CHARS &&
		kickText.length > GOAL_OBJECTIVE_MAX_CHARS,
	`objective=${objective.length}<=${GOAL_OBJECTIVE_MAX_CHARS}; old-folded=${foldedLen} (would -32600); kick=${kickText.length} carries the full body`,
);

const flywheelRoot = join(ROOT, "state");
const gateMarkerDir = join(flywheelRoot, "gates");
mkdirSync(gateMarkerDir, { recursive: true });
const writableRoots = buildDaemonSandboxWritableRoots({
	flywheelRoot,
	gateMarkerDir,
	sandboxCwd,
	gitWritableDirs: [realpathSync(gitDir), realpathSync(gitCommonDir)],
});

tmux("kill-session", "-t", TMUX_SESSION);
tmux("new-session", "-d", "-s", TMUX_SESSION, "-n", "shell");

const socketPath = resolveDaemonSocketPath(EXEC_ID);
const codexBin = flywheelCodexBin();
const tuiBin = rawCodexBin();
const codexHome = provisionCodexHome({ executionId: EXEC_ID });

const runtime = new CodexDaemonGoalRuntime({
	executionId: EXEC_ID,
	codexBin,
	codexHomes: [codexHome],
	cwd: sandboxCwd,
	socketPath,
	sandbox: "workspace-write",
	approvalPolicy: "never",
	sandboxWritableRoots: writableRoots,
	networkAccess: true,
	logger: (m) => log(`  runtime: ${m}`),
});

let tuiOpened = false;
let tuiPane = "";
let tuiAliveSamples = 0;
let paneSampler = null;
let threadId = null;
let outcome = null;
let caught = null;

const t0 = Date.now();
try {
	// ── Run A (positive): real-scale SOURCE via the objective/kick split ──
	outcome = await runtime.runGoal(
		{
			objective, // short pointer
			kickText, // the > 4000-char full body
			overallTimeoutMs: 8 * 60_000,
			onThreadReady: (tid) => {
				threadId = tid;
				if (tuiOpened) return;
				tuiOpened = ensureRunnerTuiWindow(
					{
						tmuxSession: TMUX_SESSION,
						windowName: WINDOW,
						codexHome,
						socketPath,
						cwd: sandboxCwd,
						threadId: tid,
						executionId: EXEC_ID,
						codexBin: tuiBin,
					},
					{ log: (m) => log(`  tui: ${m}`) },
				);
				log(`ensureRunnerTuiWindow -> ${tuiOpened}`);
				paneSampler = setInterval(() => {
					const out =
						tmux("capture-pane", "-p", "-t", `=${TMUX_SESSION}:=${WINDOW}`)
							.stdout ?? "";
					if (out.trim().length > tuiPane.trim().length) tuiPane = out;
					if (
						isRunnerTuiWindowAlive(
							{ tmuxSession: TMUX_SESSION, windowName: WINDOW },
							{},
						)
					)
						tuiAliveSamples++;
				}, 2500);
			},
		},
		{ onNotification: () => {} },
	);
} catch (e) {
	caught = e;
	log(`runGoal THREW: ${e?.kind ?? ""} ${e?.message ?? e}`);
}
if (paneSampler) clearInterval(paneSampler);
const elapsed = Math.round((Date.now() - t0) / 1000);

if (!tuiPane)
	tuiPane =
		tmux("capture-pane", "-p", "-t", `=${TMUX_SESSION}:=${WINDOW}`).stdout ??
		"";
writeFileSync(join(EVID, "tui-pane-capture.txt"), tuiPane);

// A1 — goal set succeeded (no -32600 / no setup_failed) and the run terminated.
const setupFailed =
	caught instanceof GoalRunError && caught.kind === "setup_failed";
record(
	"A1-goalset-succeeds",
	!setupFailed &&
		outcome?.result?.status === "complete" &&
		outcome?.result?.succeeded === true,
	setupFailed
		? `goal set FAILED (setup_failed): ${caught.message}`
		: `goal set OK, terminal=${outcome?.result?.status ?? "(threw)"} succeeded=${outcome?.result?.succeeded} in ${elapsed}s`,
);

// A2 — the token that lived ONLY in the > 4000-char kick was acted on + committed.
let gitLog = "";
try {
	gitLog = sh("git", ["-C", sandboxCwd, "log", "--oneline"], sandboxCwd);
} catch (e) {
	gitLog = `(git log failed: ${e.message})`;
}
let markerContent = "";
try {
	markerContent = sh(
		"git",
		["-C", sandboxCwd, "show", "HEAD:kick-marker.txt"],
		sandboxCwd,
	);
} catch {
	// fall back to worktree copy
	try {
		markerContent = execFileSync("cat", [join(sandboxCwd, "kick-marker.txt")], {
			encoding: "utf8",
		}).trim();
	} catch {}
}
record(
	"A2-kick-body-arrived",
	markerContent.includes(TOKEN),
	markerContent.includes(TOKEN)
		? `agent committed the kick-only token ${TOKEN} → the full > 4000-char kick reached it`
		: `token ${TOKEN} NOT found (kick-marker="${markerContent.slice(0, 60)}") — kick body did not fully arrive`,
);

// A3 — founder TUI alive + rendering real work.
const tuiWorkMarkers = [/•|└|─{5,}/, /Ran |Added |git |kick|Explored|goal/i];
const tuiLooksLive =
	tuiOpened &&
	tuiAliveSamples > 0 &&
	tuiPane.trim().length > 200 &&
	tuiWorkMarkers.every((re) => re.test(tuiPane));
record(
	"A3-founder-tui-alive",
	tuiLooksLive,
	tuiLooksLive
		? `real codex TUI rendering + alive in tmux ${TMUX_SESSION}:${WINDOW} (${tuiPane.trim().split("\n").length} lines, ${tuiAliveSamples} live samples)`
		: `pane did NOT render a live codex TUI (opened=${tuiOpened}, samples=${tuiAliveSamples}, ${tuiPane.trim().length} bytes)`,
);

// teardown Run A
killRunnerTuiWindow({ tmuxSession: TMUX_SESSION, windowName: WINDOW }, {});
runtime.stop();
await runtime.drained();

// ── Run B (negative control): the OLD fold-everything form must fail CLOSED ──
// Pass the > 4000 body AS the objective; the client's setGoal guard must throw
// setup_failed LOCALLY so no -32600 frame ever reaches the daemon.
let bThrew = null;
const EXEC_ID_B = `qa1236b-${Date.now().toString(36)}`;
const runtimeB = new CodexDaemonGoalRuntime({
	executionId: EXEC_ID_B,
	codexBin,
	codexHomes: [provisionCodexHome({ executionId: EXEC_ID_B })],
	cwd: sandboxCwd,
	socketPath: resolveDaemonSocketPath(EXEC_ID_B),
	sandbox: "workspace-write",
	approvalPolicy: "never",
	sandboxWritableRoots: writableRoots,
	networkAccess: true,
	logger: () => {},
});
try {
	await runtimeB.runGoal({
		objective: `${systemLayer}\n\n---\n\n${prompt}`, // > 4000 — the old fold form
		overallTimeoutMs: 60_000,
	});
} catch (e) {
	bThrew = e;
}
runtimeB.stop();
await runtimeB.drained();
record(
	"B-failclosed-guard",
	bThrew instanceof GoalRunError && bThrew.kind === "setup_failed",
	bThrew
		? `oversized objective rejected LOCALLY as ${bThrew.kind} before the RPC (no -32600 to daemon): ${String(bThrew.message).slice(0, 90)}`
		: "oversized objective did NOT fail closed (guard missing)",
);

// ── teardown + orphan probe (by SOCKET, mirrors the 1188 harness) ──
tmux("kill-session", "-t", TMUX_SESSION);
await new Promise((r) => setTimeout(r, 2000));
const classifyHolders = (sock) => {
	const pids = (
		spawnSync("pgrep", ["-f", sock], { encoding: "utf8" }).stdout ?? ""
	)
		.trim()
		.split("\n")
		.filter(Boolean);
	return pids;
};
let holdersA = classifyHolders(socketPath);
let holdersB = classifyHolders(resolveDaemonSocketPath(EXEC_ID_B));
for (let i = 0; i < 12 && (holdersA.length || holdersB.length); i++) {
	await new Promise((r) => setTimeout(r, 1000));
	holdersA = classifyHolders(socketPath);
	holdersB = classifyHolders(resolveDaemonSocketPath(EXEC_ID_B));
}
for (const p of [...holdersA, ...holdersB]) {
	try {
		process.kill(Number(p), "SIGKILL");
	} catch {}
}
record(
	"T-clean-teardown",
	holdersA.length === 0 && holdersB.length === 0,
	`orphan socket holders after teardown: A=${JSON.stringify(holdersA)} B=${JSON.stringify(holdersB)}`,
);

const summary = {
	issue: "FLY-1236",
	execId: EXEC_ID,
	head: sh("git", ["rev-parse", "HEAD"], REPO),
	codexVersion: spawnSync("codex", ["--version"], {
		encoding: "utf8",
	}).stdout?.trim(),
	objectiveLen: objective.length,
	objective,
	oldFoldedObjectiveLen: foldedLen,
	kickLen: kickText.length,
	token: TOKEN,
	kickMarkerContent: markerContent,
	threadId,
	elapsedSec: elapsed,
	goalStatus: outcome?.result?.status ?? null,
	goalSucceeded: outcome?.result?.succeeded ?? null,
	threw: caught ? `${caught.kind ?? ""}: ${caught.message ?? caught}` : null,
	negControlThrew: bThrew
		? `${bThrew.kind ?? ""}: ${bThrew.message ?? bThrew}`
		: null,
	gitLog,
	results,
	verdict: results.every((r) => r.pass) ? "PASS" : "FAIL",
};
// Tab-indent so the committed evidence stays Biome-clean (a re-run must not
// re-introduce a lint error — the repo formats JSON with tabs).
writeFileSync(
	join(EVID, "e2e-result.json"),
	`${JSON.stringify(summary, null, "\t")}\n`,
);

console.log("\n════════ QA · FLY-1236 real-machine E2E ════════");
for (const r of results)
	console.log(`${r.pass ? "✅" : "❌"} ${r.id} — ${r.detail}`);
console.log(`\nVERDICT: ${summary.verdict}`);
process.exit(summary.verdict === "PASS" ? 0 : 1);
