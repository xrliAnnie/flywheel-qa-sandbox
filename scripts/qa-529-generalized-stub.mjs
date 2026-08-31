#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	buildDesignFixtureHtml,
	generalizedFixtureBranch,
	nextStubAction,
	reconcileGeneralizedFixturePrBody,
	validateQaRelease,
} from "./lib/qa-generalized-e2e-lib.mjs";

if (process.argv.includes("--version") || process.argv.includes("-v")) {
	process.stdout.write("Flywheel 529 generalized persistent stub 1.1.0\n");
	process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const requireFromTeamlead = createRequire(
	resolve(root, "packages/teamlead/package.json"),
);
const Database = requireFromTeamlead("better-sqlite3");

const executionId = requiredEnv("FLYWHEEL_EXEC_ID");
const stateDbPath = requiredEnv("FLYWHEEL_STATE_DB_PATH");
const commCli = requiredEnv("FLYWHEEL_COMM_CLI");
const slotDir = dirname(stateDbPath);
const stateDir = join(slotDir, "stub-state");
const controlDir = join(slotDir, "stub-control");
const statePath = join(stateDir, `${executionId}.json`);
const exitPath = join(controlDir, `${executionId}.exit.json`);
const failReleasePath = join(controlDir, `${executionId}.fail-release.json`);
const releasePath = join(controlDir, `${executionId}.release.json`);
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
mkdirSync(controlDir, { recursive: true, mode: 0o700 });

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
	process.on(signal, () => {
		stopping = true;
	});
}

function requiredEnv(name) {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required for the generalized stub`);
	return value;
}

function readJson(path) {
	if (!existsSync(path)) return null;
	return JSON.parse(readFileSync(path, "utf8"));
}

function writeJsonAtomic(path, value) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.tmp.${process.pid}`;
	writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	chmodSync(temp, 0o600);
	renameSync(temp, path);
}

function initialState() {
	const existing = readJson(statePath);
	if (existing?.schemaVersion === 1 && existing.executionId === executionId) {
		return {
			...existing,
			completedAttempts: Array.isArray(existing.completedAttempts)
				? existing.completedAttempts
				: [],
		};
	}
	return {
		schemaVersion: 1,
		executionId,
		pid: process.pid,
		startedAt: new Date().toISOString(),
		completedAttempts: [],
	};
}

const state = initialState();
state.pid = process.pid;
state.lastHeartbeatAt = new Date().toISOString();
writeJsonAtomic(statePath, state);

function validateControlRelease(path, release, expected, kind) {
	try {
		validateQaRelease(release, expected);
		return true;
	} catch (error) {
		state.rejectedControls = [
			...(Array.isArray(state.rejectedControls) ? state.rejectedControls : []),
			{
				kind,
				reason: error instanceof Error ? error.message : String(error),
				rejectedAt: new Date().toISOString(),
			},
		].slice(-10);
		renameSync(path, `${path}.rejected-${Date.now()}`);
		return false;
	}
}

function exitRequested(context) {
	const command = readJson(exitPath);
	if (!command) return false;
	if (
		command.schemaVersion !== 1 ||
		command.executionId !== executionId ||
		command.requested !== true
	) {
		throw new Error(`invalid exit control for ${executionId}`);
	}
	if (context && command.runId !== context.runId) {
		throw new Error(`exit control run tuple mismatch for ${executionId}`);
	}
	return true;
}

// Entry fence: a late physical launch for an already-terminated execution must
// die before DB-role lookup, git, gh, or flywheel-comm side effects.
if (exitRequested(null)) {
	state.exitObservedAt = new Date().toISOString();
	writeJsonAtomic(statePath, state);
	process.exit(0);
}

function openDb() {
	const db = new Database(stateDbPath, {
		readonly: true,
		fileMustExist: true,
		timeout: 5_000,
	});
	db.pragma("busy_timeout = 5000");
	return db;
}

function loadContext() {
	const db = openDb();
	try {
		return db
			.prepare(
				`SELECT b.run_id AS runId, b.node_id AS nodeId, b.attempt,
				        a.role, s.issue_identifier AS issueIdentifier,
				        s.issue_id AS issueId, s.status AS sessionStatus
				   FROM workflow_execution_binding b
				   JOIN workflow_actor a ON a.execution_id = b.execution_id
				   LEFT JOIN sessions s ON s.execution_id = b.execution_id
				  WHERE b.execution_id = ?
				  ORDER BY b.attempt DESC, b.bound_at DESC LIMIT 1`,
			)
			.get(executionId);
	} finally {
		db.close();
	}
}

function latestImplementExecution(runId) {
	const db = openDb();
	try {
		return db
			.prepare(
				`SELECT execution_id FROM workflow_run_node
				  WHERE run_id = ? AND node_id = 'implement'
				    AND execution_id IS NOT NULL
				  ORDER BY attempt DESC LIMIT 1`,
			)
			.get(runId)?.execution_id;
	} finally {
		db.close();
	}
}

function sleep(ms) {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function run(file, args, options = {}) {
	return execFileSync(file, args, {
		cwd: process.cwd(),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		...options,
	}).trim();
}

function runComm(args) {
	const result = spawnSync(process.execPath, [commCli, ...args], {
		cwd: process.cwd(),
		env: process.env,
		encoding: "utf8",
	});
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
	return { ok: result.status === 0, status: result.status, output };
}

function configureGit() {
	run("git", ["config", "user.name", "Flywheel QA 529 Stub"]);
	run("git", ["config", "user.email", "flywheel-qa-529@invalid.local"]);
}

function commitFile(path, content, message) {
	const absolute = resolve(process.cwd(), path);
	mkdirSync(dirname(absolute), { recursive: true });
	if (!existsSync(absolute) || readFileSync(absolute, "utf8") !== content) {
		writeFileSync(absolute, content, "utf8");
	}
	run("git", ["add", "--", path]);
	const staged = run("git", ["diff", "--cached", "--name-only"]);
	if (staged) run("git", ["commit", "-m", message]);
	run("git", ["push", "origin", "HEAD"]);
	return run("git", ["rev-parse", "HEAD"]);
}

function issueIdentifier(context) {
	if (/^[A-Z]+-\d+$/.test(context.issueIdentifier ?? "")) {
		return context.issueIdentifier;
	}
	const branch = run("git", ["branch", "--show-current"]);
	const match = branch.match(/[A-Z]+-\d+/);
	if (!match) throw new Error("stub cannot derive canonical issue identifier");
	return match[0];
}

function selectFixtureBranch(context, issue) {
	const branch = generalizedFixtureBranch(issue, context.runId);
	run("git", ["fetch", "origin", "main"]);
	let startPoint = "origin/main";
	try {
		run("git", [
			"fetch",
			"origin",
			`+refs/heads/${branch}:refs/remotes/origin/${branch}`,
		]);
		startPoint = `origin/${branch}`;
	} catch {
		// A fresh workflow run owns a fresh branch. Absence is the normal path.
	}
	run("git", ["switch", "-C", branch, startPoint]);
	return branch;
}

function completeDesign(context) {
	configureGit();
	const issue = issueIdentifier(context);
	selectFixtureBranch(context, issue);
	const path = `doc/${issue}-generalized-e2e/design.html`;
	const content = buildDesignFixtureHtml(issue, context.runId, executionId);
	const head = commitFile(
		path,
		content,
		`docs(${issue}): add generalized e2e design fixture`,
	);
	state.pending = { action: "complete-design", attempt: context.attempt, head };
	writeJsonAtomic(statePath, state);
	const result = runComm([
		"complete",
		"--route",
		"phase_design_complete",
		"--session-role",
		"design",
		"--summary",
		"529 generalized stub design complete",
	]);
	if (!result.ok) throw new Error(`design complete failed: ${result.output}`);
	state.completedAttempts = [
		...new Set([...state.completedAttempts, context.attempt]),
	];
	state.lastCompletion = {
		action: "design",
		attempt: context.attempt,
		head,
		at: new Date().toISOString(),
	};
	delete state.pending;
	writeJsonAtomic(statePath, state);
}

function repoIdentity() {
	return run("gh", [
		"repo",
		"view",
		"--json",
		"nameWithOwner",
		"--jq",
		".nameWithOwner",
	]);
}

function ensurePullRequest(context, head) {
	const repo = repoIdentity();
	const branch = run("git", ["branch", "--show-current"]);
	const issue = issueIdentifier(context);
	const title = `test(${issue}): generalized 529 e2e fixture`;
	const body = (
		priorBody = "Deterministic generalized-DAG room drill; do not merge.",
	) => reconcileGeneralizedFixturePrBody(priorBody, context.runId, executionId);
	let rows = [];
	const raw = run("gh", [
		"pr",
		"list",
		"--repo",
		repo,
		"--head",
		branch,
		"--state",
		"open",
		"--json",
		"number,url,isDraft,headRefOid,title,body",
	]);
	if (raw) rows = JSON.parse(raw);
	if (rows.length === 0) {
		run("gh", [
			"pr",
			"create",
			"--repo",
			repo,
			"--base",
			"main",
			"--head",
			branch,
			"--title",
			title,
			"--body",
			body(),
		]);
		rows = JSON.parse(
			run("gh", [
				"pr",
				"list",
				"--repo",
				repo,
				"--head",
				branch,
				"--state",
				"open",
				"--json",
				"number,url,isDraft,headRefOid,title,body",
			]),
		);
	}
	if (
		rows.length !== 1 ||
		rows[0].isDraft ||
		rows[0].headRefOid !== head ||
		rows[0].title !== title
	) {
		throw new Error(`sandbox PR authority mismatch: ${JSON.stringify(rows)}`);
	}
	const reconciledBody = body(rows[0].body);
	if (rows[0].body.trim() !== reconciledBody) {
		run("gh", [
			"pr",
			"edit",
			String(rows[0].number),
			"--repo",
			repo,
			"--body",
			reconciledBody,
		]);
		rows[0].body = reconciledBody;
	}
	return { ...rows[0], repo, branch };
}

function completeImplement(context) {
	configureGit();
	const issue = issueIdentifier(context);
	selectFixtureBranch(context, issue);
	const path = `doc/qa/fixtures/${issue}-generalized-e2e.md`;
	const prior = existsSync(path)
		? readFileSync(path, "utf8")
		: `# ${issue} generalized e2e fixture\n`;
	const marker = `\n- attempt ${context.attempt}: run=${context.runId} execution=${executionId}\n`;
	const content = prior.includes(marker.trim())
		? prior
		: `${prior.trimEnd()}${marker}`;
	const head = commitFile(
		path,
		content,
		`test(${issue}): generalized e2e implement attempt ${context.attempt}`,
	);
	const pr = ensurePullRequest(context, head);
	state.pending = {
		action: "complete-implement",
		attempt: context.attempt,
		head,
		prNumber: pr.number,
		prUrl: pr.url,
		repo: pr.repo,
		branch: pr.branch,
	};
	writeJsonAtomic(statePath, state);
	const result = runComm([
		"complete",
		"--route",
		"needs_review",
		"--pr",
		String(pr.number),
		"--session-role",
		"implement",
		"--summary",
		`529 generalized stub implement attempt ${context.attempt}`,
	]);
	if (!result.ok)
		throw new Error(`implement complete failed: ${result.output}`);
	state.completedAttempts = [
		...new Set([...state.completedAttempts, context.attempt]),
	];
	state.lastCompletion = {
		action: "implement",
		attempt: context.attempt,
		head,
		prNumber: pr.number,
		prUrl: pr.url,
		repo: pr.repo,
		branch: pr.branch,
		at: new Date().toISOString(),
	};
	state.completionHistory = [
		...(Array.isArray(state.completionHistory) ? state.completionHistory : []),
		state.lastCompletion,
	];
	delete state.pending;
	writeJsonAtomic(statePath, state);
}

function submitQaFail(context) {
	const target = latestImplementExecution(context.runId);
	if (!target)
		throw new Error(`implement execution missing for ${context.runId}`);
	state.pending = { action: "qa-fail", attempt: context.attempt, target };
	writeJsonAtomic(statePath, state);
	const result = runComm([
		"qa-result",
		"--status",
		"fail",
		"--target-exec",
		target,
		"--summary",
		"FLY-1775 deterministic drill: require implement attempt-2 marker",
	]);
	if (!result.ok) throw new Error(`qa fail verdict failed: ${result.output}`);
	state.completedAttempts = [
		...new Set([...state.completedAttempts, context.attempt]),
	];
	state.lastCompletion = {
		action: "qa-fail",
		attempt: context.attempt,
		target,
		at: new Date().toISOString(),
	};
	delete state.pending;
	writeJsonAtomic(statePath, state);
}

function publishQaFailReady(context) {
	state.qaFailReady = {
		runId: context.runId,
		executionId,
		attempt: context.attempt,
		readyAt: new Date().toISOString(),
	};
	writeJsonAtomic(statePath, state);
}

function publishQaReady(context) {
	const expectedHead = run("git", ["rev-parse", "HEAD"]);
	state.qaReady = {
		runId: context.runId,
		executionId,
		attempt: context.attempt,
		expectedHead,
		targetExecutionId: latestImplementExecution(context.runId),
		readyAt: new Date().toISOString(),
	};
	writeJsonAtomic(statePath, state);
}

function submitQaPass(context) {
	const tuple = validateQaRelease(readJson(releasePath), state.qaReady);
	const target = state.qaReady.targetExecutionId;
	if (!target)
		throw new Error(`implement execution missing for ${context.runId}`);
	state.pending = {
		action: "qa-pass",
		attempt: context.attempt,
		tuple,
		target,
	};
	writeJsonAtomic(statePath, state);
	const result = runComm([
		"qa-result",
		"--status",
		"pass",
		"--target-exec",
		target,
		"--pr-head",
		tuple.expectedHead,
		"--summary",
		"FLY-1775 deterministic generalized 529 drill passed",
	]);
	state.qaPassResult = {
		ok: result.ok,
		status: result.status,
		output: result.output.slice(-8_000),
		tuple,
		at: new Date().toISOString(),
	};
	if (result.ok) {
		state.completedAttempts = [
			...new Set([...state.completedAttempts, context.attempt]),
		];
	}
	delete state.pending;
	writeJsonAtomic(statePath, state);
}

async function main() {
	let context;
	for (let attempt = 0; attempt < 120 && !context; attempt += 1) {
		context = loadContext();
		if (!context) await sleep(250);
	}
	if (!context)
		throw new Error(`workflow execution binding not found for ${executionId}`);
	state.runId = context.runId;
	state.nodeId = context.nodeId;
	state.role = context.role;
	writeJsonAtomic(statePath, state);

	while (!stopping) {
		context = loadContext() ?? context;
		if (exitRequested(context)) break;
		state.runId = context.runId;
		state.nodeId = context.nodeId;
		state.role = context.role;
		state.attempt = context.attempt;
		state.lastHeartbeatAt = new Date().toISOString();
		const release = readJson(releasePath);
		const failRelease = readJson(failReleasePath);
		let qaFailReleased = false;
		if (failRelease && state.qaFailReady) {
			qaFailReleased = validateControlRelease(
				failReleasePath,
				{
					...failRelease,
					expectedHead: failRelease.expectedHead ?? "0".repeat(40),
				},
				{ ...state.qaFailReady, expectedHead: "0".repeat(40) },
				"qa-fail",
			);
		}
		let releaseValid = false;
		if (release && state.qaReady) {
			releaseValid = validateControlRelease(
				releasePath,
				release,
				state.qaReady,
				"qa-pass",
			);
		}
		const action = nextStubAction({
			role: context.role,
			attempt: context.attempt,
			completedAttempts: state.completedAttempts,
			qaFailReady: Boolean(state.qaFailReady),
			qaFailReleased,
			qaReady: Boolean(state.qaReady),
			releaseValid,
			qaPassAttempted: Boolean(state.qaPassResult),
			exitRequested: false,
		});
		state.lastAction = action;
		writeJsonAtomic(statePath, state);
		switch (action) {
			case "complete-design":
				completeDesign(context);
				break;
			case "complete-implement":
				completeImplement(context);
				break;
			case "qa-fail":
				submitQaFail(context);
				break;
			case "qa-fail-ready":
				publishQaFailReady(context);
				break;
			case "qa-ready":
				publishQaReady(context);
				break;
			case "qa-pass":
				submitQaPass(context);
				break;
			case "park":
				await sleep(1_000);
				break;
			default:
				throw new Error(`unexpected action: ${action}`);
		}
	}
	state.exitObservedAt = new Date().toISOString();
	state.lastAction = "exit";
	writeJsonAtomic(statePath, state);
}

main().catch((error) => {
	state.fatal = {
		message: error instanceof Error ? error.message : String(error),
		at: new Date().toISOString(),
	};
	writeJsonAtomic(statePath, state);
	process.stderr.write(`[qa-529-stub] ${state.fatal.message}\n`);
	process.exitCode = 1;
});
