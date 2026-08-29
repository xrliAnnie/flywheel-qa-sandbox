#!/usr/bin/env node
/**
 * FLY-1185 real-machine lifecycle QA — drives #564's BUILT dist production code
 * against REAL objects and OBSERVES the 6-item closeout (no assertions, real
 * before/after). Tadashi-authorized fallback: closeout/sweep entrypoints run
 * directly against real leftover worktree/runner objects.
 */
import { execFileSync } from "node:child_process";
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
const UUID = "11111111-1111-1111-1111-111111111185";

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

line("═══════════════════════════════════════════════════════════════");
line("FLY-1185 REAL-MACHINE LIFECYCLE QA — #564 built dist vs real objects");
line("═══════════════════════════════════════════════════════════════\n");

// ─────────────────────────────────────────────────────────────────────
// SCENARIO A — closeoutIssue against a REAL tmux window + REAL StateStore
//   items ③ runner session FSM close, ④ cmux/tmux window recycle,
//   ⑤ Discord thread archive (order), ⑥ Linear consistency (order/LAST)
// ─────────────────────────────────────────────────────────────────────
line("SCENARIO A — issue-terminal closeout (disposition=canceled)");
line(
	"  real tmux window + real StateStore FSM, from dist lifecycle-closeout.js\n",
);

const store = await StateStore.create(":memory:");
store.upsertSession({
	execution_id: "e1",
	issue_id: UUID,
	project_name: "proj",
	status: "running",
	issue_identifier: "FLY-1185QA",
});

const SESS = "fly1185qa";
tmuxTry("kill-session", "-t", SESS);
tmux("new-session", "-d", "-s", SESS, "-n", "keeper");
tmux("new-window", "-t", SESS, "-n", "runner");
const WIN = `${SESS}:runner`;

const winsBefore = tmux("list-windows", "-t", SESS, "-F", "#{window_name}");
line(
	`  BEFORE: tmux windows in ${SESS} = [${winsBefore.split("\n").join(", ")}]`,
);
line(`  BEFORE: session e1 status = ${store.getSession("e1")?.status}`);

const calls = [];
const probe = async () => {
	const r = tmuxTry("list-windows", "-t", SESS, "-F", "#{window_name}");
	if (!r.ok) return "absent"; // session gone entirely
	return r.out.split("\n").includes("runner") ? "alive" : "absent";
};
const report = await closeoutIssue(
	{
		store,
		transitionOpts: { store, fsm: new WorkflowFSM(WORKFLOW_TRANSITIONS) },
		withIssueMutex: createIssueMutex(),
		// real teardown: physically kill the real tmux window (mirrors production
		// closeRunner's window kill; the DAG orchestration under test is prod code)
		closeRunnerFn: async () => {
			calls.push("teardown:kill-window");
			tmuxTry("kill-window", "-t", WIN);
			return { closed: true };
		},
		lookupTarget: () => ({ kind: "found", target: { tmuxWindow: WIN } }),
		probeLiveness: probe,
		archiveThreads: async () => {
			calls.push("archiveThreads");
		},
		linearConsistency: async () => {
			calls.push("linearConsistency");
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
const runnerGone =
	!winsAfter.ok || !winsAfter.out.split("\n").includes("runner");
line(
	`  AFTER : tmux windows in ${SESS} = [${winsAfter.ok ? winsAfter.out.split("\n").join(", ") : "session gone"}]`,
);
line(`  AFTER : session e1 status = ${store.getSession("e1")?.status}`);
line(
	`  closeout outcome = ${report.outcome}; call order = [${calls.join(" → ")}]`,
);
const nodeE1 = report.nodes.find((n) => n.node.executionId === "e1");
line(
	`  node e1: transition=${JSON.stringify(nodeE1?.transition)}, confirmedGone=${nodeE1?.confirmedGone}\n`,
);

line("  OBSERVED RESULTS:");
check(
	"③ runner session FSM → terminated (not completed)",
	store.getSession("e1")?.status === "terminated",
	`status=${store.getSession("e1")?.status}`,
);
check(
	"③ FSM transition legal (canceled→terminated, no forceStatus)",
	nodeE1?.transition?.state === "done",
);
check(
	"④ real tmux window physically recycled",
	runnerGone,
	"runner window gone from tmux list-windows",
);
check(
	"④ closeout confirmed-gone via FRESH liveness probe",
	nodeE1?.confirmedGone === true,
);
check(
	"⑤+⑥ thread archive + Linear ran AFTER node confirmed gone",
	calls[0] === "teardown:kill-window" &&
		calls.indexOf("archiveThreads") > calls.indexOf("teardown:kill-window"),
);
check(
	"⑥ Linear consistency ran LAST (DAG edge #4)",
	calls[calls.length - 1] === "linearConsistency",
);
check("closeout outcome = complete", report.outcome === "complete");
tmuxTry("kill-session", "-t", SESS);

// ─────────────────────────────────────────────────────────────────────
// SCENARIO B — sweepProjectLifecycle against a REAL owned worktree
//   items ① branch (local + remote), ② worktree remove
// ─────────────────────────────────────────────────────────────────────
line(
	"\nSCENARIO B — periodic sweep (兜底) removes a real leftover owned worktree",
);
line(
	"  real git repo + bare origin + real worktree, from dist lifecycle-sweep.js\n",
);

const root = fs.mkdtempSync(
	path.join(fs.realpathSync(os.tmpdir()), "fly1185-qa-"),
);
const bare = path.join(root, "origin.git");
fs.mkdirSync(bare);
git(bare, "init", "-q", "--bare", "-b", "main");
const repo = path.join(root, "repo");
fs.mkdirSync(repo);
git(repo, "init", "-q", "-b", "main");
git(repo, "config", "user.email", "t@t");
git(repo, "config", "user.name", "t");
fs.writeFileSync(path.join(repo, "f.txt"), "1\n");
git(repo, "add", "-A");
git(repo, "commit", "-q", "-m", "base");
git(repo, "remote", "add", "origin", bare);
git(repo, "push", "-q", "origin", "main");

const store2 = await StateStore.create(":memory:");
const lock = createRepoMutationLock();
const wm = new WorktreeManager({ withRepoLock: lock.withRepoLock });
const wt = await wm.create({
	mainRepoPath: repo,
	projectName: "proj",
	issueId: "FLY-10",
	startPoint: "main",
});
// push the worktree branch to origin → a REAL remote branch to delete
git(repo, "push", "-q", "origin", wt.branch);
store2.upsertSession({
	execution_id: "e10",
	issue_id: "FLY-10",
	project_name: "proj",
	status: "completed",
});
store2.bindWorktreeOnce("e10", {
	path: wt.worktreePath,
	branch: wt.branch,
	generation: wt.generation,
});

const wtExistsBefore = fs.existsSync(wt.worktreePath);
const localBefore = git(repo, "branch", "--list", wt.branch);
const remoteBefore = git(repo, "ls-remote", "--heads", "origin", wt.branch);
line(`  BEFORE: worktree dir exists = ${wtExistsBefore} (${wt.worktreePath})`);
line(`  BEFORE: local branch present = ${!!localBefore} (${wt.branch})`);
line(`  BEFORE: remote branch present = ${!!remoteBefore}`);

const res = await sweepProjectLifecycle({
	store: store2,
	worktreeManager: wm,
	project: { projectName: "proj", projectRoot: repo },
	withRepoLock: lock.withRepoLock,
	quarantineRoot: path.join(root, "quarantine"),
	bundleDir: path.join(root, "bundles"),
	autoclean: true,
	nowMs: () => Date.now() + STABILITY_WINDOW_MS + 60_000, // elapse 3d stability gate
	ghPrSetsFn: async () => ({
		merged: new Map(),
		open: new Set(),
		openTruncated: false,
	}),
});

const wtExistsAfter = fs.existsSync(wt.worktreePath);
let localAfter = "";
try {
	localAfter = git(repo, "branch", "--list", wt.branch);
} catch {}
const remoteAfter = git(repo, "ls-remote", "--heads", "origin", wt.branch);
const entry = res.entries.find((e) => e.ref === wt.worktreePath);
line(`  AFTER : worktree dir exists = ${wtExistsAfter}`);
line(`  AFTER : local branch present = ${!!localAfter}`);
line(`  AFTER : remote branch present = ${!!remoteAfter}`);
line(`  sweep entry: action=${entry?.action}, family=${entry?.family}`);
const _remoteEntry = res.entries.find(
	(e) => e.kind === "branch" && String(e.ref).includes(wt.branch),
);
line(
	`  sweep remote-branch entries: ${JSON.stringify(res.entries.filter((e) => e.kind === "branch").map((e) => ({ ref: e.ref, action: e.action })))}\n`,
);

line("  OBSERVED RESULTS:");
check(
	"② worktree directory physically removed",
	wtExistsBefore && !wtExistsAfter,
	`${wt.worktreePath} gone`,
);
check(
	"① local branch deleted (git branch --list empty)",
	!!localBefore && !localAfter,
	wt.branch,
);
check("sweep classified it deleted/clean_merged", entry?.action === "deleted");
// remote deletion is a separate pass; observe (informational — periodic remote
// merged branch handling)
line(
	`  ℹ️  ① remote branch after sweep present=${!!remoteAfter} (periodic remote pass observation — see report)`,
);

// ─────────────────────────────────────────────────────────────────────
// SCENARIO C — real REMOTE branch deletion primitive (item ① remote half;
//   the "304 远端分支" symptom). Ship-time Layer A path uses this lease-CAS.
// ─────────────────────────────────────────────────────────────────────
line(
	"\nSCENARIO C — real remote-branch lease-CAS delete (item ① remote / 304 远端分支)",
);
line("  real bare origin + real branch, from dist branch-cleanup.js\n");
const { casDeleteRemoteBranch } = await import(
	`${D}/teamlead/dist/bridge/branch-cleanup.js`
);
git(repo, "branch", "repo-FLY-99", "main");
git(repo, "push", "-q", "origin", "repo-FLY-99");
const remShaBefore = git(repo, "ls-remote", "--heads", "origin", "repo-FLY-99");
line(`  BEFORE: remote branch repo-FLY-99 present = ${!!remShaBefore}`);
const expectedSha = git(repo, "rev-parse", "refs/heads/repo-FLY-99");
const delRes = await casDeleteRemoteBranch({
	mainRepoPath: repo,
	branch: "repo-FLY-99",
	expectedSha,
});
const remAfter = git(repo, "ls-remote", "--heads", "origin", "repo-FLY-99");
line(`  AFTER : remote branch repo-FLY-99 present = ${!!remAfter}`);
line(`  delete outcome = ${JSON.stringify(delRes)}\n`);
line("  OBSERVED RESULTS:");
check(
	"① remote branch physically deleted (lease-CAS)",
	!!remShaBefore && !remAfter,
	"git ls-remote empty after",
);
check("① delete primitive reported deleted:true", delRes.deleted === true);
// stale-lease refusal: advance remote out-of-band, then a stale expected sha refuses
git(repo, "branch", "repo-FLY-98", "main");
git(repo, "push", "-q", "origin", "repo-FLY-98");
const staleSha = git(repo, "rev-parse", "refs/heads/repo-FLY-98");
fs.writeFileSync(path.join(repo, "adv.txt"), "x\n");
git(repo, "add", "-A");
git(repo, "commit", "-q", "-m", "advance");
git(repo, "push", "-q", "origin", "HEAD:refs/heads/repo-FLY-98");
const refuse = await casDeleteRemoteBranch({
	mainRepoPath: repo,
	branch: "repo-FLY-98",
	expectedSha: staleSha,
});
const stillThere = git(repo, "ls-remote", "--heads", "origin", "repo-FLY-98");
check(
	"① stale-lease REFUSES delete (remote moved → not deleted)",
	refuse.deleted === false && !!stillThere,
	`reason=${refuse.reason}`,
);

// cleanup throwaway repo
fs.rmSync(root, { recursive: true, force: true });

line("\n═══════════════════════════════════════════════════════════════");
line(`RESULT: ${pass} PASS / ${fail} FAIL (real observed evidence, #564 dist)`);
line("═══════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
