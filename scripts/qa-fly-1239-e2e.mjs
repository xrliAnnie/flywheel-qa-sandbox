#!/usr/bin/env node
/**
 * QA · FLY-1239 — real-machine E2E for the founder-TUI rollout-race fix.
 *
 * The bug (FLY-1236 A3, real-machine capture): the founder cmux/tmux window opens
 * on `onThreadReady` — right after `thread/start`, BEFORE the first turn — so the
 * thread's rollout is not persisted yet and `codex resume --remote` dies during
 * bootstrap with `thread/resume failed: no rollout found for thread id ... (-32600)`.
 * The pane is dead within a second; the founder opens the cmux tab and sees nothing.
 *
 * The fix (this PR): CodexTmuxAdapter retries the founder window on a `died`
 * outcome, NON-BLOCKING (scheduled off the goal loop so setGoal lands the rollout
 * between attempts) and BOUNDED (TUI_OPEN_MAX_ATTEMPTS, fail-loud after), and each
 * attempt provably purges its own stale same-named window first (≤1 window).
 *
 * This harness drives the PRODUCTION `CodexTmuxAdapter.execute()` against a REAL
 * `codex app-server` daemon in a REAL git worktree with a REAL tmux window — so the
 * REAL retry loop (default unref'd setTimeout scheduler) runs. While the run is in
 * flight it samples the founder pane and proves:
 *   A3  founder TUI alive + rendering thread content   (the rollout race recovered)
 *   NP  no pile-up — at most ONE FLY-1239 window in the session at any sample
 *   G   the goal reaches a terminal status (the run is unaffected)
 *   T   clean teardown (the window is killed; no orphan daemon/socket)
 *
 * Requires: real `codex` auth (~/.codex), tmux, network. Spends codex tokens.
 * Run with a SHORT TMPDIR (e.g. TMPDIR=/tmp) so the socket path fits SUN_LEN.
 *
 * Usage:  TMPDIR=/tmp node scripts/qa-fly-1239-e2e.mjs
 * Exit 0 = PASS. Evidence -> engineering/doc/FLY-1239-tui-rollout-race/qa/
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const RUNNER = join(REPO, "packages/claude-runner/dist/index.js");
const EVID = process.env.FLYWHEEL_QA_EVID_DIR
	? resolve(process.env.FLYWHEEL_QA_EVID_DIR)
	: join(REPO, "engineering/doc/FLY-1239-tui-rollout-race/qa");

const {
	CodexTmuxAdapter,
	isRunnerTuiWindowAlive,
	killRunnerTuiWindow,
	resolveDaemonSocketPath,
	TUI_OPEN_MAX_ATTEMPTS,
} = await import(RUNNER);

const QA_ISSUE = process.env.FLYWHEEL_QA_ISSUE ?? "FLY-1239";
const QA_SLUG = QA_ISSUE.toLowerCase().replace(/[^a-z0-9]+/g, "");
const TMUX_SESSION = `qa-${QA_SLUG}`;
const WINDOW = QA_ISSUE; // = sanitizeTmuxName(ctx.label)
const EXEC_ID = `qa-${QA_SLUG}-${process.pid}`;

const log = (m) => console.log(`[qa-1239] ${m}`);
const sh = (c, a, cwd) => execFileSync(c, a, { cwd, encoding: "utf8" }).trim();
const tmux = (...a) => spawnSync("tmux", a, { encoding: "utf8" });

const results = [];
const record = (id, pass, detail) => {
	results.push({ id, pass, detail });
	log(`${pass ? "PASS" : "FAIL"} ${id} — ${detail}`);
};

// ── fixture: a MAIN repo + a SIBLING LINKED worktree (the production shape) ──
const ROOT = mkdtempSync(join(tmpdir(), "qa-fly1239-"));
mkdirSync(EVID, { recursive: true });
const mainRepo = join(ROOT, "repo");
const worktree = join(ROOT, "repo-qa-wt");
mkdirSync(mainRepo, { recursive: true });
sh("git", ["init", "-q", "-b", "main"], mainRepo);
sh("git", ["config", "user.email", "qa@flywheel.local"], mainRepo);
sh("git", ["config", "user.name", "QA FLY-1239"], mainRepo);
writeFileSync(join(mainRepo, "README.md"), "# qa fixture\n");
sh("git", ["add", "-A"], mainRepo);
sh("git", ["commit", "-qm", "init"], mainRepo);
sh("git", ["worktree", "add", "-q", "-b", "qa-wt", worktree], mainRepo);
const sandboxCwd = realpathSync(worktree);
log(`worktree=${sandboxCwd}`);

// clean tmux session so the sampler + no-pile-up count start from a known state.
tmux("kill-session", "-t", TMUX_SESSION);
tmux("new-session", "-d", "-s", TMUX_SESSION, "-n", "shell");

const socketPath = resolveDaemonSocketPath(EXEC_ID);

// ── the production adapter, targeting OUR tmux session so we can watch the pane ──
// Default execFile / ensureWindow / killWindow / scheduleReopen (REAL retry timing).
const adapter = new CodexTmuxAdapter(TMUX_SESSION);

// A trivial single-step task: the rollout race is at thread/start, INDEPENDENT of
// task size — a cheap task still exercises the exact open-window timing.
const prompt = `You are in the git worktree at ${sandboxCwd}. Do EXACTLY this, unattended:
create ok.txt whose only content is the word: ready
then run: git add ok.txt && git commit -m "qa ${QA_ISSUE}"
The objective is COMPLETE once ok.txt is committed. Use real shell commands; do not ask questions.`;

const ctx = {
	executionId: EXEC_ID,
	issueId: QA_ISSUE,
	prompt,
	cwd: sandboxCwd,
	leadId: "flywheel-eng-lead",
	projectName: "flywheel",
	label: WINDOW,
	pretrustWorkspace: true,
	timeoutMs: 8 * 60_000,
};

// ── sample the founder pane WHILE the run is in flight ──
let richestPane = "";
let aliveSamples = 0;
let maxSameNameWindows = 0;
let sawNoRollout = false;
let richestPaneCommand = "";
const countWindows = () => {
	const out =
		tmux("list-windows", "-t", `=${TMUX_SESSION}`, "-F", "#{window_name}")
			.stdout ?? "";
	return out
		.split("\n")
		.map((s) => s.trim())
		.filter((n) => n === WINDOW).length;
};
const sampler = setInterval(() => {
	const n = countWindows();
	if (n > maxSameNameWindows) maxSameNameWindows = n;
	if (isRunnerTuiWindowAlive({ tmuxSession: TMUX_SESSION, windowName: WINDOW }))
		aliveSamples++;
	const pane =
		tmux("capture-pane", "-p", "-t", `=${TMUX_SESSION}:=${WINDOW}`).stdout ??
		"";
	const panePid = (
		tmux(
			"display-message",
			"-p",
			"-t",
			`=${TMUX_SESSION}:=${WINDOW}`,
			"#{pane_pid}",
		).stdout ?? ""
	).trim();
	if (panePid) {
		const paneCommand = (
			spawnSync("ps", ["-o", "command=", "-p", panePid], {
				encoding: "utf8",
			}).stdout ?? ""
		).trim();
		if (paneCommand.length > richestPaneCommand.length)
			richestPaneCommand = paneCommand;
	}
	if (/no rollout found/i.test(pane)) sawNoRollout = true;
	if (pane.trim().length > richestPane.trim().length) richestPane = pane;
}, 2000);

let result;
let caught;
const t0 = Date.now();
try {
	result = await adapter.execute(ctx);
} catch (e) {
	caught = e;
	log(`execute THREW: ${e?.message ?? e}`);
}
clearInterval(sampler);
const elapsed = Math.round((Date.now() - t0) / 1000);
writeFileSync(join(EVID, "tui-pane-capture.txt"), richestPane);
writeFileSync(join(EVID, "tui-pane-command.txt"), `${richestPaneCommand}\n`);

// ── A3: the founder TUI ended up ALIVE and rendering the thread (race recovered) ──
// The bug's terminal state is a dead pane / a `no rollout found` corpse. The fix's
// success state is a live pane rendering the codex TUI chrome + the agent's work.
const workMarkers = [
	/•|└|─{5,}|▌/,
	/Ran |Added |git |ok\.txt|Explored|codex|ready/i,
];
const tuiRecovered =
	aliveSamples > 0 &&
	richestPane.trim().length > 200 &&
	workMarkers.every((re) => re.test(richestPane));
record(
	"A3-founder-tui-recovered",
	tuiRecovered,
	tuiRecovered
		? `founder TUI reached a LIVE, rendering state after the rollout race (${aliveSamples} live samples, ${richestPane.trim().split("\n").length} lines)`
		: `founder TUI never rendered a live pane (aliveSamples=${aliveSamples}, ${richestPane.trim().length} bytes) — see qa/tui-pane-capture.txt`,
);
record(
	"A3-native-tui-command",
	/codex(?:\s|$).*resume.*--remote/.test(richestPaneCommand) &&
		!/tail\s+-F/.test(richestPaneCommand),
	`pane command=${JSON.stringify(richestPaneCommand)}`,
);

// ── NP: no pile-up — SAMPLED evidence, never more than ONE FLY-1239 window ──
// Codex code R1 LOW-4: the 2s sampler only observes the window count at sample
// instants — a retry could create+remove a pane between samples — so this is
// supporting evidence, NOT the deterministic proof. The proof of the ≤1-same-name
// invariant is the unit multiset-by-window-id test in codex-runner-tui-window.test.ts
// (purge-before-create by immutable id + verify). A sample >1 here is still a real
// failure worth flagging.
record(
	"NP-no-pile-up-sampled",
	maxSameNameWindows <= 1,
	`max simultaneous '${WINDOW}' windows observed across ${Math.round(elapsed / 2)} samples = ${maxSameNameWindows} (<= 1 expected; deterministic proof is the unit multiset-by-id test, this is sampled corroboration)`,
);

// Diagnostic (not gating): the transient `no rollout found` may or may not be caught
// mid-race by the 2s sampler; either way the fix is proven by A3 (final live pane).
record(
	"NP-race-diag",
	true,
	`transient 'no rollout found' captured mid-race by the sampler: ${sawNoRollout} (informational — retries recovered), TUI_OPEN_MAX_ATTEMPTS=${TUI_OPEN_MAX_ATTEMPTS}`,
);

// ── G: the run itself is unaffected (window failure never breaks the machine run) ──
record(
	"G-goal-terminal",
	result?.success === true,
	`adapter run success=${result?.success} timedOut=${result?.timedOut} in ${elapsed}s (threw=${caught ? caught.message : "no"})`,
);

// ── H4: the daemon's sandboxed thread really committed in the linked worktree ──
let gitLog = "";
try {
	gitLog = sh("git", ["-C", sandboxCwd, "log", "--oneline"], sandboxCwd);
} catch (e) {
	gitLog = `(git log failed: ${e.message})`;
}
record(
	"H4-worktree-commit",
	gitLog.includes(`qa ${QA_ISSUE}`),
	`worktree commits: ${JSON.stringify(gitLog.split("\n"))}`,
);

const runnerHome = join(
	process.env.FLYWHEEL_CODEX_HOMES_ROOT ??
		join(homedir(), ".flywheel", "codex-homes"),
	EXEC_ID,
);
const generatedConfig = existsSync(join(runnerHome, "config.toml"))
	? readFileSync(join(runnerHome, "config.toml"), "utf8")
	: "";
record(
	"P-managed-runner-policy",
	/sandbox_mode\s*=\s*"workspace-write"/.test(generatedConfig) &&
		/approval_policy\s*=\s*"never"/.test(generatedConfig),
	`generated config has workspace-write=${/sandbox_mode\s*=\s*"workspace-write"/.test(generatedConfig)} never=${/approval_policy\s*=\s*"never"/.test(generatedConfig)}`,
);

const findRollouts = (directory) => {
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		return entry.isDirectory()
			? findRollouts(path)
			: entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")
				? [path]
				: [];
	});
};
const readRolloutMeta = (path) => {
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.includes('"type":"session_meta"')) continue;
		const parsed = JSON.parse(line);
		return parsed.payload;
	}
	return undefined;
};
const classifyRollouts = (metadata, rootId) => {
	const parentId = (meta) =>
		meta.parent_thread_id ??
		meta.forked_from_id ??
		meta.source?.subagent?.thread_spawn?.parent_thread_id;
	const isSubagent = (meta) =>
		meta.thread_source === "subagent" || Boolean(meta.source?.subagent);
	return {
		roots: metadata.filter(
			(meta) => (meta.id ?? meta.session_id) === rootId && !isSubagent(meta),
		),
		allowedSubagents: metadata.filter(
			(meta) => isSubagent(meta) && parentId(meta) === rootId,
		),
		unexpected: metadata.filter(
			(meta) =>
				!((meta.id ?? meta.session_id) === rootId && !isSubagent(meta)) &&
				!(isSubagent(meta) && parentId(meta) === rootId),
		),
	};
};
const classifierFixture = classifyRollouts(
	[
		{ id: "root" },
		{ id: "sub", thread_source: "subagent", parent_thread_id: "root" },
		{ id: "fork", forked_from_id: "root" },
	],
	"root",
);
record(
	"NF-classifier-self-check",
	classifierFixture.roots.length === 1 &&
		classifierFixture.allowedSubagents.length === 1 &&
		classifierFixture.unexpected.map((meta) => meta.id).join(",") === "fork",
	"classifier accepts the intended root + native subagent and rejects a synthetic non-subagent fork",
);
const rolloutMetadata = findRollouts(join(runnerHome, "sessions"))
	.map(readRolloutMeta)
	.filter(Boolean);
const rolloutClassification = classifyRollouts(
	rolloutMetadata,
	result?.sessionId,
);
writeFileSync(
	join(EVID, "rollout-classification.json"),
	JSON.stringify(rolloutClassification, null, 2),
);
record(
	"NF-no-unexpected-root-or-fork",
	rolloutClassification.roots.length === 1 &&
		rolloutClassification.unexpected.length === 0,
	`root=${result?.sessionId}; roots=${rolloutClassification.roots.length}; allowed native subagents=${rolloutClassification.allowedSubagents.length}; unexpected=${rolloutClassification.unexpected.map((meta) => meta.id ?? meta.session_id).join(",") || "none"}`,
);

// ── teardown proof BEFORE fallback cleanup ──

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
		else daemons.push(pid);
	}
	return { daemons, tuis };
};
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
const terminalWindowCount = countWindows();
record(
	"T-clean-teardown",
	socketGone &&
		terminalWindowCount === 0 &&
		holders.daemons.length === 0 &&
		holders.tuis.length === 0,
	`before fallback cleanup: window count=${terminalWindowCount}; socket removed=${socketGone}; orphan daemons=${JSON.stringify(holders.daemons)}; lingering TUIs=${JSON.stringify(holders.tuis)}`,
);

// Fallback cleanup only after the teardown assertion above has sampled reality.
killRunnerTuiWindow({ tmuxSession: TMUX_SESSION, windowName: WINDOW }, {});
tmux("kill-session", "-t", TMUX_SESSION);
for (const p of [...holders.daemons, ...holders.tuis]) {
	try {
		process.kill(Number(p), "SIGKILL");
	} catch {}
}

const summary = {
	issue: QA_ISSUE,
	when: new Date().toISOString(),
	elapsedSeconds: elapsed,
	maxSameNameWindows,
	aliveSamples,
	results,
};
writeFileSync(join(EVID, "e2e-result.json"), JSON.stringify(summary, null, 2));

const failed = results.filter((r) => !r.pass);
log("");
log(`RESULT: ${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
	log(`FAILED: ${failed.map((r) => r.id).join(", ")}`);
	process.exit(1);
}
log("ALL PASS");
process.exit(0);
