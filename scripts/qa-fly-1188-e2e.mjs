#!/usr/bin/env node
/**
 * QA · FLY-1188 — real-machine E2E for the resident /goal codex runner.
 *
 * Drives the REAL production runtime (packages/claude-runner/dist) against a REAL
 * `codex app-server` daemon, in a REAL linked git worktree, with a REAL tmux TUI
 * window. This is the gate for the four founder-facing hard problems the issue names
 * — none of them can be proven by the mocked unit tests (they mock the exec seam,
 * which is exactly where all the real failures live).
 *
 *   H1 AGENTS.md — the codex contract is materialized into $CODEX_HOME
 *   H2 loop      — the resident /goal drives >=2 turns AUTONOMOUSLY (no external kick)
 *   H3 TUI       — the founder can WATCH it run in a cmux/tmux pane
 *   H4 sandbox   — the daemon thread can `git commit` in a LINKED worktree, whose
 *                  .git metadata lives in the main repo, OUTSIDE the thread's cwd
 *   T  teardown  — no orphan daemon / socket survives the run
 *
 * Requires: a real `codex` auth (~/.codex), tmux, and network. Spends codex tokens.
 * Everything else is a throwaway tmp fixture; the only host state touched is a
 * dedicated tmux session, killed at the end.
 *
 * Usage:  node scripts/qa-fly-1188-e2e.mjs
 * Exit 0 = PASS. Evidence -> engineering/doc/FLY-1188-codex-runner-first-class/qa/
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const RUNNER = join(REPO, "packages/claude-runner/dist/index.js");
const EVID = join(REPO, "engineering/doc/FLY-1188-codex-runner-first-class/qa");

const {
	CodexDaemonGoalRuntime,
	provisionCodexHome,
	resolveDaemonSocketPath,
	buildDaemonSandboxWritableRoots,
	ensureRunnerTuiWindow,
	killRunnerTuiWindow,
	isRunnerTuiWindowAlive,
	flywheelCodexBin,
	rawCodexBin,
} = await import(RUNNER);

const TMUX_SESSION = "qa-fly1188";
const WINDOW = "FLY-1188";
const EXEC_ID = `qa1188-${Date.now().toString(36)}`;

const log = (m) => console.log(`[qa] ${m}`);
const sh = (c, a, cwd) => execFileSync(c, a, { cwd, encoding: "utf8" }).trim();
const tmux = (...a) => spawnSync("tmux", a, { encoding: "utf8" });

const results = [];
const record = (id, pass, detail) => {
	results.push({ id, pass, detail });
	log(`${pass ? "PASS" : "FAIL"} ${id} — ${detail}`);
};

// ── fixture: a MAIN repo + a SIBLING LINKED worktree (the production shape) ──
const ROOT = mkdtempSync(join(tmpdir(), "qa-fly1188-"));
mkdirSync(EVID, { recursive: true });
const mainRepo = join(ROOT, "repo");
const worktree = join(ROOT, "repo-qa-wt"); // SIBLING (like flywheel-FLY-XXXX-qa)
mkdirSync(mainRepo, { recursive: true });
sh("git", ["init", "-q", "-b", "main"], mainRepo);
sh("git", ["config", "user.email", "qa@flywheel.local"], mainRepo);
sh("git", ["config", "user.name", "QA FLY-1188"], mainRepo);
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
if (gitDir.startsWith(sandboxCwd)) {
	throw new Error(
		"fixture invalid: git metadata is INSIDE cwd — not a linked worktree",
	);
}
log(`worktree=${sandboxCwd}`);
log(`git metadata (OUTSIDE cwd)=${gitDir}`);

// ── H1: the isolated CODEX_HOME carries the codex behaviour contract ──
const codexHome = provisionCodexHome({ executionId: EXEC_ID });
const agentsMd = join(codexHome, "AGENTS.md");
const body = existsSync(agentsMd) ? readFileSync(agentsMd, "utf8") : "";
record(
	"H1-agents-md",
	body.length > 500,
	existsSync(agentsMd)
		? `$CODEX_HOME/AGENTS.md materialized (${body.length} bytes)`
		: `MISSING ${agentsMd}`,
);
const anchors = ["flywheel-comm", "gate", "complete"].filter(
	(a) => !body.includes(a),
);
record(
	"H1-contract-anchors",
	anchors.length === 0,
	anchors.length === 0
		? "contract carries the comm-protocol anchors"
		: `contract MISSING anchors: ${anchors.join(", ")}`,
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
const codexBin = flywheelCodexBin(); // daemon: shim (429 rotation; app-server needs no TTY)
const tuiBin = rawCodexBin(); // founder TUI: RAW codex — MUST be TTY-capable
let paneSampler = null;
let tuiAliveSamples = 0;

// ── H2: three steps, one per turn — the ONLY way all three land is the resident
//        /goal autonomously starting new turns after each one ends.
const objective = `You are working inside the git worktree at ${sandboxCwd}. Complete this objective.

CRITICAL TURN DISCIPLINE: perform EXACTLY ONE step per turn, then END YOUR TURN. Never do two steps in the same turn.

Step 1: create step1.txt whose only content is the word: alpha
        Then run: git add step1.txt && git commit -m "qa step1"
        Then END YOUR TURN.

Step 2: read step1.txt, create step2.txt whose only content is that word reversed (ahpla).
        Then run: git add step2.txt && git commit -m "qa step2"
        Then END YOUR TURN.

Step 3: run git log --oneline, then create done.txt whose content is the number of commits.
        Then run: git add done.txt && git commit -m "qa done"
        The objective is COMPLETE once done.txt is committed.

Use real shell commands. Do not ask questions — you are unattended.`;

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

let turnsStarted = 0;
let turnsCompleted = 0;
let tuiOpened = false;
let tuiPane = "";
let threadId = null;
let outcome = null;
let caught = null;

const t0 = Date.now();
try {
	outcome = await runtime.runGoal(
		{
			objective,
			overallTimeoutMs: 8 * 60_000,
			onThreadReady: (tid) => {
				threadId = tid;
				if (tuiOpened) return;
				// FLY-1239: ensureRunnerTuiWindow now returns { created, reason }.
				tuiOpened = ensureRunnerTuiWindow(
					{
						tmuxSession: TMUX_SESSION,
						windowName: WINDOW,
						codexHome,
						socketPath,
						cwd: sandboxCwd,
						threadId: tid,
						// MIRROR PRODUCTION (CodexTmuxAdapter): TUI = raw codex, daemon = shim.
						// An earlier cut of this harness passed the SHIM here and produced a
						// FAIL that was the harness's fault, not the product's. A QA rig must
						// reproduce the production wiring, never invent its own.
						codexBin: tuiBin,
					},
					{ log: (m) => log(`  tui: ${m}`) },
				).created;
				log(`ensureRunnerTuiWindow -> ${tuiOpened}`);
				// Sample over time. A single snapshot is NOT evidence: the TUI needs a
				// moment to paint, and it exits when the daemon goes away at run end.
				// Keep the richest frame we ever saw + count live samples.
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
		{
			onNotification: (method) => {
				if (method === "turn/started") turnsStarted++;
				if (method === "turn/completed") turnsCompleted++;
			},
		},
	);
} catch (e) {
	caught = e;
	log(`runGoal THREW: ${e?.kind ?? ""} ${e?.message ?? e}`);
}
if (paneSampler) clearInterval(paneSampler);
const elapsed = Math.round((Date.now() - t0) / 1000);

const tuiAlive = isRunnerTuiWindowAlive(
	{ tmuxSession: TMUX_SESSION, windowName: WINDOW },
	{},
);
if (!tuiPane)
	tuiPane =
		tmux("capture-pane", "-p", "-t", `=${TMUX_SESSION}:=${WINDOW}`).stdout ??
		"";
writeFileSync(join(EVID, "tui-pane-capture.txt"), tuiPane);

record(
	"H2-resident-multi-turn",
	turnsCompleted >= 2,
	`resident /goal drove ${turnsStarted} turn/started + ${turnsCompleted} turn/completed autonomously (need >=2)`,
);
record(
	"H2-goal-terminal",
	outcome?.result?.status === "complete" && outcome?.result?.succeeded === true,
	`goal terminal status=${outcome?.result?.status ?? "(threw)"} succeeded=${outcome?.result?.succeeded}`,
);

// H3: a real `codex resume --remote` TUI renders its chrome. An empty/dead pane is
// the ORIGINAL BUG (Annie opened the cmux tab and saw nothing).
// What "the founder can watch it run" actually means: the pane is ALIVE, and it
// is rendering the agent's real work. (Round 2 lesson: an earlier marker here
// required the literal string "Codex", which the TUI never prints — the check
// failed while the TUI was rendering perfectly. Assert on observed reality.)
const tuiWorkMarkers = [/•|└|─{5,}/, /Ran |Added |git |step1|Explored|goal/i];
const tuiLooksLive =
	tuiOpened &&
	tuiAliveSamples > 0 &&
	tuiPane.trim().length > 200 &&
	tuiWorkMarkers.every((re) => re.test(tuiPane));
record(
	"H3-founder-tui-visible",
	tuiLooksLive,
	tuiLooksLive
		? `real codex TUI rendering in tmux ${TMUX_SESSION}:${WINDOW} (${tuiPane.trim().split("\n").length} lines)`
		: `pane did NOT render a live codex TUI (opened=${tuiOpened}, alive=${tuiAlive}, ${tuiPane.trim().length} bytes) — see qa/tui-failure-diagnosis.txt`,
);

// H4: did the daemon's sandboxed thread really COMMIT in the linked worktree?
let gitLog = "";
try {
	gitLog = sh("git", ["-C", sandboxCwd, "log", "--oneline"], sandboxCwd);
} catch (e) {
	gitLog = `(git log failed: ${e.message})`;
}
const qaCommits = gitLog
	.split("\n")
	.map((l) => l.replace(/^\S+\s/, ""))
	.filter((s) => s.startsWith("qa "));
record(
	"H4-sandbox-linked-worktree-commit",
	qaCommits.length >= 2,
	`daemon thread landed ${qaCommits.length} commit(s) in the LINKED worktree: ${JSON.stringify(qaCommits)}`,
);

// ── teardown ──
killRunnerTuiWindow({ tmuxSession: TMUX_SESSION, windowName: WINDOW }, {});
runtime.stop();
await runtime.drained();
tmux("kill-session", "-t", TMUX_SESSION);
await new Promise((r) => setTimeout(r, 2000));

// NOTE: probe by SOCKET, not by the tracked pid. The runtime tracks the pid of the
// `flywheel-codex-with-fallback` shim, but the real `codex app-server` is its CHILD
// (the shim tees stdout to sniff 429s, so it cannot exec). Killing the shim leaves
// the daemon alive, reparented to PID 1, still holding the socket + ~178MB.
/** Every process whose argv names our socket, split into daemon vs founder TUI. */
const classifyHolders = () => {
	const pids = (
		spawnSync("pgrep", ["-f", socketPath], { encoding: "utf8" }).stdout ?? ""
	)
		.trim()
		.split("\n")
		.filter(Boolean);
	const daemons = [];
	const tuis = [];
	for (const pid of pids) {
		const cmd =
			spawnSync("ps", ["-o", "command=", "-p", pid], { encoding: "utf8" })
				.stdout ?? "";
		if (/app-server/.test(cmd)) daemons.push(pid);
		else if (/resume/.test(cmd)) tuis.push(pid);
		else daemons.push(pid); // unknown holder — count it against us (fail closed)
	}
	return { daemons, tuis };
};
// the TUI dies with its window; give it a bounded moment rather than racing it
let holders = classifyHolders();
for (
	let i = 0;
	i < 12 && (holders.daemons.length || holders.tuis.length);
	i++
) {
	await new Promise((r) => setTimeout(r, 1000));
	holders = classifyHolders();
}
const socketGone = !existsSync(socketPath);
record(
	"T-clean-teardown",
	socketGone && holders.daemons.length === 0 && holders.tuis.length === 0,
	`socket removed=${socketGone}; orphan daemons=${JSON.stringify(holders.daemons)} (the HIGH-2 defect); lingering founder TUIs=${JSON.stringify(holders.tuis)}`,
);

// never leave the machine dirty, even on FAIL (this box has an OOM history)
for (const p of [...holders.daemons, ...holders.tuis]) {
	try {
		process.kill(Number(p), "SIGKILL");
	} catch {}
}

const summary = {
	issue: "FLY-1188",
	execId: EXEC_ID,
	head: sh("git", ["rev-parse", "HEAD"], REPO),
	codexVersion: spawnSync("codex", ["--version"], {
		encoding: "utf8",
	}).stdout?.trim(),
	codexBin,
	worktree: sandboxCwd,
	gitDir,
	writableRoots,
	threadId,
	elapsedSec: elapsed,
	turnsStarted,
	turnsCompleted,
	goalStatus: outcome?.result?.status ?? null,
	goalSucceeded: outcome?.result?.succeeded ?? null,
	threw: caught ? `${caught.kind ?? ""}: ${caught.message ?? caught}` : null,
	gitLog,
	orphanSocketHolders: holders,
	baselineNote:
		"holders classified: app-server = the HIGH-2 orphan defect; resume = founder TUI",
	results,
	verdict: results.every((r) => r.pass) ? "PASS" : "FAIL",
};
writeFileSync(join(EVID, "e2e-result.json"), JSON.stringify(summary, null, 2));

console.log("\n════════ QA · FLY-1188 real-machine E2E ════════");
for (const r of results)
	console.log(`${r.pass ? "✅" : "❌"} ${r.id} — ${r.detail}`);
console.log(`\nVERDICT: ${summary.verdict}`);
process.exit(summary.verdict === "PASS" ? 0 : 1);
