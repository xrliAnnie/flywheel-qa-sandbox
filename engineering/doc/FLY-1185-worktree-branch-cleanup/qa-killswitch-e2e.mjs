#!/usr/bin/env node
/**
 * FLY-1185 INDEPENDENT QA (three-stage QA phase) — kill-switch real-object proof.
 *
 * The rollout contract is "merge = enable, no new feature flag" (Annie 直令), so
 * the ONLY emergency stop for the whole no-flag surface is the existing
 * FLYWHEEL_WORKTREE_AUTOCLEAN=0 master switch. The implement-phase E2E
 * (qa-lifecycle-e2e.mjs) exercises the ON path (real deletion). This companion
 * proves the OFF path against REAL objects: with the switch OFF a closeout /
 * sweep must physically touch NOTHING — a live tmux window survives, the FSM
 * stays `running`, and a real leftover worktree is left on disk. Runs the SAME
 * #564 built dist entrypoints, no assertions hidden behind mocks.
 *
 * Test hygiene (Codex code review): every real object this driver creates uses a
 * per-process-unique name and is torn down in a `finally`. It NEVER pre-kills an
 * unowned fixed-name tmux session — that is exactly the FLY-1185 anti-pattern
 * this suite guards against.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const D = "/Users/xiaorongli/Dev/flywheel-FLY-1185/packages";
const { StateStore } = await import(`${D}/teamlead/dist/StateStore.js`);
const { closeoutIssue, createIssueMutex } = await import(
	`${D}/teamlead/dist/bridge/lifecycle-closeout.js`
);
const { sweepProjectLifecycle, STABILITY_WINDOW_MS } = await import(
	`${D}/teamlead/dist/bridge/lifecycle-sweep.js`
);
const { createRepoMutationLock } = await import(
	`${D}/teamlead/dist/bridge/repo-mutation-lock.js`
);
const { WorktreeManager } = await import(`${D}/edge-worker/dist/index.js`);
const core = await import(`${D}/core/dist/index.js`);
const { WorkflowFSM, WORKFLOW_TRANSITIONS } = core;

const git = (cwd, ...a) =>
	execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
const tmux = (...a) => execFileSync("tmux", a, { encoding: "utf8" }).trim();
const tmuxTry = (...a) => {
	try {
		return { ok: true, out: tmux(...a) };
	} catch (e) {
		return { ok: false, out: String(e.stderr || e.message) };
	}
};
const line = (s) => console.log(s);
const UUID = "22222222-2222-2222-2222-222222221185";

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
	if (cond) {
		pass++;
		line(`  ✅ ${name}${detail ? ` — ${detail}` : ""}`);
	} else {
		fail++;
		line(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
	}
};

// The whole point: OFF for the entire run.
process.env.FLYWHEEL_WORKTREE_AUTOCLEAN = "0";

line("═══════════════════════════════════════════════════════════════");
line("FLY-1185 KILL-SWITCH REAL-OBJECT QA — FLYWHEEL_WORKTREE_AUTOCLEAN=0");
line("  (independent QA phase; #564 built dist vs real objects)");
line("═══════════════════════════════════════════════════════════════\n");

// ─────────────────────────────────────────────────────────────────────
// SCENARIO K1 — closeoutIssue with the switch OFF leaves a live runner alone
// ─────────────────────────────────────────────────────────────────────
line(
	"SCENARIO K1 — closeout with switch OFF: real tmux window + FSM untouched\n",
);

const store = await StateStore.create(":memory:");
store.upsertSession({
	execution_id: "k1",
	issue_id: UUID,
	project_name: "proj",
	status: "running",
	issue_identifier: "FLY-1185KS",
});

// Collision-proof unique session name (random UUID, not a reusable PID); we
// create it, so we own it. Never `kill-session` a fixed/unowned name up front,
// and only tear it down once creation actually SUCCEEDED (sessCreated) — so a
// failed `new-session` (e.g. a pre-existing collision) never makes us kill an
// object we did not create.
const SESS = `fly1185ks-${randomUUID()}`;
let sessCreated = false;
try {
	tmux("new-session", "-d", "-s", SESS, "-n", "keeper");
	sessCreated = true;
	tmux("new-window", "-t", SESS, "-n", "runner");
	const WIN = `${SESS}:runner`;

	const winsBefore = tmux("list-windows", "-t", SESS, "-F", "#{window_name}");
	line(`  BEFORE: tmux windows = [${winsBefore.split("\n").join(", ")}]`);
	line(`  BEFORE: session k1 status = ${store.getSession("k1")?.status}`);

	let teardownCalls = 0;
	const report = await closeoutIssue(
		{
			store,
			transitionOpts: { store, fsm: new WorkflowFSM(WORKFLOW_TRANSITIONS) },
			withIssueMutex: createIssueMutex(),
			// If the switch failed to gate, this would physically kill the window.
			closeRunnerFn: async () => {
				teardownCalls++;
				tmuxTry("kill-window", "-t", WIN);
				return { closed: true };
			},
			lookupTarget: () => ({ kind: "found", target: { tmuxWindow: WIN } }),
			probeLiveness: async () => "alive",
			archiveThreads: async () => {
				teardownCalls++;
			},
			linearConsistency: async () => {
				teardownCalls++;
				return undefined;
			},
			log: () => {},
		},
		{
			issueKey: UUID,
			projectName: "proj",
			disposition: "canceled",
			authority: "linear_reconcile",
		},
	);

	const winsAfter = tmuxTry("list-windows", "-t", SESS, "-F", "#{window_name}");
	const runnerAlive =
		winsAfter.ok && winsAfter.out.split("\n").includes("runner");
	line(
		`  AFTER : tmux windows = [${winsAfter.ok ? winsAfter.out.split("\n").join(", ") : "session gone"}]`,
	);
	line(`  AFTER : session k1 status = ${store.getSession("k1")?.status}`);
	line(
		`  closeout outcome = ${report.outcome}; operatorItems = ${JSON.stringify(report.operatorItems)}; nodes = ${report.nodes.length}; teardownCalls = ${teardownCalls}\n`,
	);

	line("  OBSERVED RESULTS:");
	check(
		"live runner window PHYSICALLY SURVIVES (kill-switch真的挡住了)",
		runnerAlive,
		"runner window still in tmux list-windows",
	);
	check(
		"FSM status UNCHANGED (still running — no transition)",
		store.getSession("k1")?.status === "running",
	);
	check("ZERO teardown/archive/linear calls executed", teardownCalls === 0);
	check(
		"closeout reported blocked(autoclean_disabled), zero nodes",
		report.outcome === "blocked" &&
			report.operatorItems.includes("autoclean_disabled") &&
			report.nodes.length === 0,
	);
} finally {
	// Only kill the session if THIS process actually created it.
	if (sessCreated) tmuxTry("kill-session", "-t", SESS);
}

// ─────────────────────────────────────────────────────────────────────
// SCENARIO K2 — sweep with the switch OFF leaves a real deletable worktree
// ─────────────────────────────────────────────────────────────────────
line(
	"\nSCENARIO K2 — sweep with switch OFF: a REAL deletable owned worktree survives\n",
);

const root = fs.mkdtempSync(
	path.join(fs.realpathSync(os.tmpdir()), "fly1185-ks-"),
);
try {
	const repo = path.join(root, "repo");
	fs.mkdirSync(repo);
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.email", "t@t");
	git(repo, "config", "user.name", "t");
	fs.writeFileSync(path.join(repo, "f.txt"), "1\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-q", "-m", "base");

	const store2 = await StateStore.create(":memory:");
	const lock = createRepoMutationLock();
	const wm = new WorktreeManager({ withRepoLock: lock.withRepoLock });
	const wt = await wm.create({
		mainRepoPath: repo,
		projectName: "proj",
		issueId: "FLY-20",
		startPoint: "main",
	});
	store2.upsertSession({
		execution_id: "k20",
		issue_id: "FLY-20",
		project_name: "proj",
		status: "completed",
	});
	store2.bindWorktreeOnce("k20", {
		path: wt.worktreePath,
		branch: wt.branch,
		generation: wt.generation,
	});

	const wtBefore = fs.existsSync(wt.worktreePath);
	line(`  BEFORE: worktree dir exists = ${wtBefore}`);

	const res = await sweepProjectLifecycle({
		store: store2,
		worktreeManager: wm,
		project: { projectName: "proj", projectRoot: repo },
		withRepoLock: lock.withRepoLock,
		quarantineRoot: path.join(root, "quarantine"),
		bundleDir: path.join(root, "bundles"),
		// autoclean intentionally omitted → reads FLYWHEEL_WORKTREE_AUTOCLEAN=0
		nowMs: () => Date.now() + STABILITY_WINDOW_MS + 60_000,
		ghPrSetsFn: async () => ({
			merged: new Map(),
			open: new Set(),
			openTruncated: false,
		}),
	});

	const wtAfter = fs.existsSync(wt.worktreePath);
	line(`  AFTER : worktree dir exists = ${wtAfter}`);
	line(`  sweep dryRun=${res.dryRun}; entries=${res.entries.length}\n`);

	line("  OBSERVED RESULTS:");
	check(
		"REAL owned worktree PHYSICALLY SURVIVES under switch OFF",
		wtBefore && wtAfter,
		wt.worktreePath,
	);
	check(
		"sweep took the disabled path (no deleter mutations)",
		!res.entries.some((e) => e.action === "deleted"),
	);
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}

line("\n═══════════════════════════════════════════════════════════════");
line(`RESULT: ${pass} PASS / ${fail} FAIL (kill-switch real-object evidence)`);
line("═══════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
