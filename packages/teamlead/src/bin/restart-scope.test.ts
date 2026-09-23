import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
	collectRestartScopeRuntime,
	loadCurrentRestartScope,
	materializeRestartScopeSnapshot,
	type RestartContextIo,
	type RestartScopeSnapshotV1,
} from "./restart-request.js";

const executionId = "21111111-2222-4333-8444-555555555555";
const activationId = "activation-1";
const reviewId = "review-1";
const digest = (value: string) =>
	createHash("sha256").update(value).digest("hex");

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
	}).trim();
}

describe("restart closeout scope materialization", () => {
	let root = "";
	let previousPath = "";
	afterEach(() => {
		if (previousPath) process.env.PATH = previousPath;
		if (root) rmSync(root, { recursive: true, force: true });
	});

	it("re-enumerates StateStore, CommDB, wakes, processes, and pushed git state", () => {
		root = mkdtempSync(join(tmpdir(), "fly2654-restart-scope-"));
		const home = join(root, "home");
		const flywheelHome = join(home, ".flywheel");
		const commDir = join(flywheelHome, "comm", "flywheel");
		const worktree = join(root, "worktree");
		const remote = join(root, "remote.git");
		const recoveryPath = join(root, "recovery.json");
		const scopeRoot = join(root, "scope");
		const bin = join(root, "bin");
		mkdirSync(commDir, { recursive: true });
		mkdirSync(bin, { recursive: true });
		writeFileSync(
			join(bin, "tmux"),
			'#!/usr/bin/env bash\n[ "$1" = has-session ] && [ "$2" = -t ]\n',
		);
		chmodSync(join(bin, "tmux"), 0o755);
		previousPath = process.env.PATH ?? "";
		process.env.PATH = `${bin}:${previousPath}`;

		execFileSync("git", ["init", "--bare", remote]);
		execFileSync("git", ["init", "-b", "main", worktree]);
		git(worktree, "config", "user.name", "Scope Test");
		git(worktree, "config", "user.email", "scope@example.test");
		writeFileSync(join(worktree, "README.md"), "scope\n");
		git(worktree, "add", "README.md");
		git(worktree, "commit", "-m", "scope fixture");
		git(worktree, "remote", "add", "origin", remote);
		git(worktree, "push", "-u", "origin", "main");
		git(
			worktree,
			"remote",
			"set-url",
			"origin",
			"git@github.com:xrliAnnie/flywheel.git",
		);
		const headSha = git(worktree, "rev-parse", "HEAD");
		const recovery = '{"cursor":"parked"}\n';
		writeFileSync(recoveryPath, recovery, { mode: 0o600 });

		const state = new Database(join(flywheelHome, "teamlead.db"));
		state.exec(`
			CREATE TABLE sessions (
				execution_id TEXT PRIMARY KEY, project_name TEXT, worktree_path TEXT,
				status TEXT, terminal_at TEXT, session_role TEXT, workflow_node_id TEXT,
				pr_head_sha TEXT
			);
			CREATE TABLE workflow_execution_binding (
				activation_id TEXT PRIMARY KEY, execution_id TEXT, run_id TEXT, node_id TEXT,
				attempt INTEGER, mode TEXT, bound_at TEXT
			);
			CREATE TABLE codex_review_record (
				execution_id TEXT, target_repo_identity TEXT, target_pr_head_sha TEXT,
				request_id TEXT, verdict_event_id TEXT, status TEXT, approved_at TEXT,
				author_family TEXT, reviewer_family TEXT
			);
		`);
		state
			.prepare("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?)")
			.run(
				executionId,
				"flywheel",
				worktree,
				"running",
				null,
				"implement",
				"implement",
				headSha,
			);
		state
			.prepare("INSERT INTO workflow_execution_binding VALUES (?,?,?,?,?,?,?)")
			.run(
				activationId,
				executionId,
				"run-1",
				"implement",
				1,
				"spawn",
				"2026-09-20T20:00:00.000Z",
			);
		state
			.prepare("INSERT INTO workflow_execution_binding VALUES (?,?,?,?,?,?,?)")
			.run(
				"activation-old",
				executionId,
				"run-1",
				"design",
				1,
				"spawn",
				"2026-09-20T19:00:00.000Z",
			);
		state
			.prepare("INSERT INTO codex_review_record VALUES (?,?,?,?,?,?,?,?,?)")
			.run(
				executionId,
				"__main__",
				headSha,
				reviewId,
				"verdict-1",
				"approved",
				"2026-09-20T20:01:00.000Z",
				"codex",
				"claude",
			);
		state.close();

		const commPath = join(commDir, "comm.db");
		const comm = new Database(commPath);
		comm.exec(`
			CREATE TABLE sessions (
				execution_id TEXT PRIMARY KEY, tmux_window TEXT, project_name TEXT,
				issue_id TEXT, lead_id TEXT, status TEXT, phase_keep_alive INTEGER
			);
			CREATE TABLE runner_declared_states (
				execution_id TEXT, kind TEXT, reason TEXT, created_at INTEGER,
				expires_at INTEGER, updated_at INTEGER
			);
			CREATE TABLE workflow_engine_park (
				execution_id TEXT, run_id TEXT, node_id TEXT, attempt INTEGER,
				activation_id TEXT, generation INTEGER, state TEXT, reason TEXT,
				source_row_id INTEGER, updated_at TEXT
			);
			CREATE TABLE three_stage_turn (
				issue_id TEXT, holder_exec_id TEXT, phase TEXT, epoch INTEGER,
				activation_id TEXT, active_turn_id TEXT, turn_generation INTEGER
			);
			CREATE TABLE runner_phase_wakes (
				execution_id TEXT, message_id TEXT, state TEXT, queued_at INTEGER
			);
			CREATE TABLE turn_wake_outbox (
				execution_id TEXT, wake_id TEXT, state TEXT, created_at INTEGER
			);
		`);
		comm
			.prepare("INSERT INTO sessions VALUES (?,?,?,?,?,?,?)")
			.run(
				executionId,
				"flywheel-FLY-2654",
				"flywheel",
				"FLY-2654",
				"flywheel-eng-lead",
				"running",
				1,
			);
		comm
			.prepare("INSERT INTO runner_declared_states VALUES (?,?,?,?,?,?)")
			.run(executionId, "parked", "scope-test", Date.now(), null, Date.now());
		comm.close();

		const draft: RestartScopeSnapshotV1 = {
			version: "restart-scope-snapshot/v1",
			capturedAt: "2026-09-20T20:02:00.000Z",
			sources: [],
			entries: [
				{
					executionId,
					activationId,
					project: "flywheel",
					phase: "implement",
					repo: "xrliAnnie/flywheel",
					worktree,
					headSha,
					pushedHeadSha: headSha,
					clean: true,
					parked: true,
					activeWrite: false,
					pendingWakeIds: [],
					verdict: {
						kind: "code-review",
						receiptId: reviewId,
						status: "approved",
						headSha,
					},
					recovery: { path: recoveryPath, digest: digest(recovery) },
				},
			],
			snapshotDigest: "",
		};
		const now = Date.parse("2026-09-20T20:03:00.000Z");
		const io: RestartContextIo = {
			fetch,
			readFile: (path) => readFileSync(path, "utf8"),
			lstat: lstatSync,
			processAlive: () => true,
			now: () => now,
		};
		const unsafeDraft = structuredClone(draft);
		unsafeDraft.entries[0]!.project = "../outside";
		expect(() => collectRestartScopeRuntime(unsafeDraft, home, io)).toThrow(
			"restart-request-scope-entry-invalid",
		);

		const materialized = materializeRestartScopeSnapshot({
			home,
			draft,
			receiptId: "decision-1-r1",
			scopeRoot,
			io,
		});
		expect(materialized.sources.map((source) => source.kind)).toEqual([
			"state-store",
			"comm-db",
			"turn-wake",
			"process-service",
		]);
		expect(loadCurrentRestartScope(home, io, scopeRoot)).toEqual(materialized);

		const activeTurn = new Database(commPath);
		activeTurn
			.prepare("INSERT INTO three_stage_turn VALUES (?,?,?,?,?,?,?)")
			.run(
				"FLY-2654",
				executionId,
				"implement",
				16,
				activationId,
				"turn-live",
				1,
			);
		activeTurn.close();
		expect(
			collectRestartScopeRuntime(draft, home, io).entries[0]?.activeWrite,
		).toBe(true);
		expect(() => loadCurrentRestartScope(home, io, scopeRoot)).toThrow(
			"restart-request-scope-drift",
		);
		const clearTurn = new Database(commPath);
		clearTurn.prepare("DELETE FROM three_stage_turn").run();
		clearTurn.close();

		const orphanCommDir = join(flywheelHome, "comm", "other-project");
		mkdirSync(orphanCommDir, { recursive: true });
		const orphanComm = new Database(join(orphanCommDir, "comm.db"));
		orphanComm.exec(`
			CREATE TABLE sessions (
				execution_id TEXT PRIMARY KEY, tmux_window TEXT, project_name TEXT,
				issue_id TEXT, lead_id TEXT, status TEXT, phase_keep_alive INTEGER
			);
			INSERT INTO sessions VALUES (
				'orphan-execution','orphan-window','other-project','FLY-9999',
				'other-lead','running',0
			);
		`);
		orphanComm.close();
		expect(() => loadCurrentRestartScope(home, io, scopeRoot)).toThrow(
			"restart-request-scope-inventory-drift",
		);
		rmSync(orphanCommDir, { recursive: true, force: true });

		const wakeDb = new Database(commPath);
		wakeDb
			.prepare("INSERT INTO turn_wake_outbox VALUES (?,?,?,?)")
			.run(executionId, "wake-1", "pending", now);
		wakeDb.close();
		expect(() => loadCurrentRestartScope(home, io, scopeRoot)).toThrow(
			"restart-request-scope-drift",
		);

		const inventory = new Database(join(flywheelHome, "teamlead.db"));
		inventory
			.prepare("UPDATE sessions SET terminal_at = ? WHERE execution_id = ?")
			.run("2026-09-20T20:04:00.000Z", executionId);
		inventory.close();
		expect(() => collectRestartScopeRuntime(draft, home, io)).toThrow(
			"restart-request-scope-inventory-drift",
		);

		const restore = new Database(join(flywheelHome, "teamlead.db"));
		restore
			.prepare("UPDATE sessions SET terminal_at = NULL WHERE execution_id = ?")
			.run(executionId);
		restore.close();
		writeFileSync(join(worktree, "README.md"), "scope\nlocal head\n");
		git(worktree, "add", "README.md");
		git(worktree, "commit", "-m", "unpushed");
		expect(() => collectRestartScopeRuntime(draft, home, io)).toThrow(
			"restart-request-scope-worktree-unpushed",
		);
	});
});
