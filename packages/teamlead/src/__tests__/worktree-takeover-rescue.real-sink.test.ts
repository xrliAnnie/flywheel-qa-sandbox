/**
 * FLY-2901 §10: crash-restart re-entry of the shared worktree takeover rescue
 * against the REAL Bridge-local authority — a real StateStore file, a real
 * DirectEventSink, the production repo-mutation lock and a real WorktreeManager
 * over real git repositories. Each "restart" closes the store, reopens the same
 * file, and rebuilds the sink + manager (no in-memory recorder anywhere).
 */

import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	type EventEnvelope,
	TAKEOVER_CLEANED_EVENT_KIND,
	TAKEOVER_RESCUED_EVENT_KIND,
	type TakeoverRescueRecorder,
	WorktreeManager,
} from "flywheel-edge-worker";
import { afterEach, describe, expect, it } from "vitest";
import { resolveWorkflowHeadAuthority } from "../bridge/head-authority.js";
import { createRepoMutationLock } from "../bridge/repo-mutation-lock.js";
import type { BridgeConfig } from "../bridge/types.js";
import { DirectEventSink } from "../DirectEventSink.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";
import { buildWorkflowRunSnapshotV2 } from "../workflow-run-snapshot.js";

const EXEC = "exec-2901-successor";
const RUN_ID = `run-${EXEC}`;
const env: EventEnvelope = {
	executionId: EXEC,
	issueId: "FLY-2901",
	projectName: "flywheel",
};
const testProjects = [
	{ projectName: "flywheel", projectRoot: "/tmp/unused", leads: [] },
] as unknown as ProjectEntry[];
const testConfig = {
	host: "127.0.0.1",
	port: 0,
	dbPath: ":memory:",
	ingestToken: "ingest-secret",
	notificationChannel: "test-channel",
	defaultLeadAgentId: "lead",
	stuckThresholdMinutes: 15,
	stuckCheckIntervalMs: 300000,
	orphanThresholdMinutes: 60,
	discordBotToken: "bot-token",
} as unknown as BridgeConfig;
const WORKFLOW_ON = {
	FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
};
const PERMIT = {
	allowed: true,
	reason: "no_live_writer" as const,
	predecessors: [
		{
			executionId: "exec-2901-predecessor",
			sessionStatus: "failed",
			liveness: "dead" as const,
			pathSource: "both" as const,
		},
	],
};

const roots: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
	for (const close of closers.splice(0)) close();
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function tempDir(prefix: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	roots.push(dir);
	return dir;
}

function bindExecution(store: StateStore): void {
	const agents = mkdtempSync(join(tmpdir(), "fly2901-real-sink-agents-"));
	mkdirSync(join(agents, "agents"));
	writeFileSync(join(agents, "agents", "generic.md"), "Execute.\n");
	const snapshot = buildWorkflowRunSnapshotV2({
		template: { id: "test", revision: 1 },
		canonicalRoot: agents,
		manifest: {
			schema_version: 2,
			nodes: [
				{
					id: "implement",
					type: "generic",
					vendor: "codex",
					model: "gpt-5.6-sol",
					effort: "low",
					agent_file: "agents/generic.md",
				},
				{ id: "founder_gate", type: "gate" },
			],
			edges: [
				{
					id: "done",
					from: "implement",
					to: "founder_gate",
					condition: "node_done",
				},
			],
			loops: [],
			terminal_gate: { node: "founder_gate", predicate: "founder_approved" },
			ship_claims: ["founder_approved"],
		},
	});
	rmSync(agents, { recursive: true, force: true });
	store.createWorkflowRun({
		runId: RUN_ID,
		issueId: "FLY-2901",
		projectName: "flywheel",
		snapshotJson: JSON.stringify(snapshot),
		claimsReadEnrolled: false,
	});
	expect(
		store.admitGeneralizedWorkflowExecution({
			runId: RUN_ID,
			nodeId: "implement",
			executionId: EXEC,
			attempt: 1,
			now: "2026-09-25T00:00:00.000Z",
			expiresAt: "2026-09-25T00:05:00.000Z",
			absoluteDeadlineAt: "2026-09-25T01:00:00.000Z",
			env: WORKFLOW_ON,
		}),
	).toMatchObject({ ok: true });
	store.upsertSession({
		execution_id: EXEC,
		issue_id: "FLY-2901",
		project_name: "flywheel",
		status: "running",
		issue_identifier: "FLY-2901",
	});
}

async function world() {
	const origin = tempDir("fly2901-real-origin-");
	const root = join(tempDir("fly2901-real-main-"), "flywheel");
	mkdirSync(root);
	const baseDir = tempDir("fly2901-real-worktrees-");
	const state = tempDir("fly2901-real-state-");
	git(origin, "init", "--quiet", "--bare", "--initial-branch=main");
	git(root, "init", "--quiet", "--initial-branch=main");
	git(root, "config", "user.name", "Flywheel Test");
	git(root, "config", "user.email", "test@flywheel.local");
	writeFileSync(join(root, "tracked.txt"), "base\n");
	git(root, "add", ".");
	git(root, "commit", "--quiet", "-m", "base");
	git(root, "remote", "add", "origin", origin);
	git(root, "push", "--quiet", "-u", "origin", "main");
	const dbPath = join(state, "teamlead.db");
	const initial = await StateStore.create(dbPath);
	bindExecution(initial);
	initial.close();

	/** One Bridge process lifetime: store + sink + lock + manager. */
	const boot = async () => {
		const store = await StateStore.create(dbPath);
		let open = true;
		const close = () => {
			if (open) store.close();
			open = false;
		};
		closers.push(close);
		const sink = new DirectEventSink(store, testConfig, testProjects);
		const manager = new WorktreeManager({
			baseDir,
			pushGuardStateDir: join(state, "push-guard"),
			pushGuardSourcePath: resolve(
				process.cwd(),
				"..",
				"edge-worker",
				"assets",
				"push-guard",
				"pre-push",
			),
			takeoverRescueStateDir: join(state, "takeover-rescue"),
			withRepoLock: createRepoMutationLock().withRepoLock,
		});
		const recorder: TakeoverRescueRecorder = {
			loadPendingTakeoverRescue: (input) =>
				sink.loadPendingTakeoverRescue(env, input),
			recordRescue: (input) => sink.recordTakeoverRescue(env, input),
			recordCleaned: (input) => sink.recordTakeoverCleaned(env, input),
		};
		return { store, sink, manager, recorder, close };
	};
	const input = (
		recorder: TakeoverRescueRecorder,
		extra: Record<string, unknown> = {},
	) => ({
		mainRepoPath: root,
		projectName: "flywheel",
		issueId: "FLY-2901",
		issueKey: "FLY-2901",
		runId: RUN_ID,
		successorExec: EXEC,
		startPoint: git(root, "rev-parse", "HEAD"),
		permit: PERMIT,
		rescueDisabled: false,
		recorder,
		stabilityWaitMs: 0,
		...extra,
	});
	return { root, origin, boot, input };
}

function eventKinds(store: StateStore): string[] {
	return store
		.listWorkflowRunEvents(RUN_ID)
		.map((event) => event.kind)
		.filter(
			(kind) =>
				kind === TAKEOVER_RESCUED_EVENT_KIND ||
				kind === TAKEOVER_CLEANED_EVENT_KIND,
		);
}

describe("FLY-2901 takeover rescue — real StateStore + DirectEventSink restarts", () => {
	it(
		"a crash right after the rescue event converges on the next Bridge life",
		{ timeout: 180_000 },
		async () => {
			const w = await world();
			const first = await w.boot();
			const shared = await first.manager.create({
				mainRepoPath: w.root,
				projectName: "flywheel",
				issueId: "FLY-2901",
			});
			writeFileSync(join(shared.worktreePath, "tracked.txt"), "dirty\n");
			writeFileSync(join(shared.worktreePath, "new.txt"), "new\n");
			await expect(
				first.manager.runTakeoverTransaction(
					w.input(first.recorder, {
						onStep: (step: string) => {
							if (step === "event_recorded") throw new Error("crash");
						},
					}),
				),
			).rejects.toThrow("crash");
			first.close();

			const second = await w.boot();
			const pending = await second.sink.loadPendingTakeoverRescue(env, {
				runId: RUN_ID,
				canonicalPath: realpathSync(shared.worktreePath),
			});
			expect(pending).toHaveLength(1);
			const result = await second.manager.runTakeoverTransaction(
				w.input(second.recorder),
			);
			expect(result.kind).toBe("rescued");
			if (result.kind !== "rescued") return;
			expect(result.evidence.resumed).toBe(true);
			expect(result.worktree.generation).toBe(shared.generation);
			expect(git(shared.worktreePath, "status", "--porcelain")).toBe("");
			expect(eventKinds(second.store)).toEqual([
				TAKEOVER_RESCUED_EVENT_KIND,
				TAKEOVER_CLEANED_EVENT_KIND,
			]);
			// "No head mismatch": the successor's persisted worktree resolves to the
			// cleaned target through the workflow head authority.
			await second.sink.emitWorktreeReady(env, shared.worktreePath, {
				branch: shared.branch,
				generation: result.worktree.generation,
			});
			const authority = await resolveWorkflowHeadAuthority(second.store, EXEC);
			expect(authority.prHeadSha).toBe(result.evidence.manifest.target);
		},
	);

	it(
		"worktree_missing: a crash after prune re-creates with the carried generation, never a fresh one",
		{ timeout: 180_000 },
		async () => {
			const w = await world();
			const first = await w.boot();
			const shared = await first.manager.create({
				mainRepoPath: w.root,
				projectName: "flywheel",
				issueId: "FLY-2901",
			});
			git(shared.worktreePath, "config", "user.name", "Pred");
			git(shared.worktreePath, "config", "user.email", "pred@flywheel.local");
			writeFileSync(join(shared.worktreePath, "unpushed.txt"), "u\n");
			git(shared.worktreePath, "add", "unpushed.txt");
			git(shared.worktreePath, "commit", "--quiet", "--no-verify", "-m", "u");
			const L = git(shared.worktreePath, "rev-parse", "HEAD");
			rmSync(shared.worktreePath, { recursive: true, force: true });
			await expect(
				first.manager.runTakeoverTransaction(
					w.input(first.recorder, {
						onStep: (step: string) => {
							if (step === "pruned") throw new Error("crash");
						},
					}),
				),
			).rejects.toThrow("crash");
			first.close();

			const second = await w.boot();
			const result = await second.manager.runTakeoverTransaction(
				w.input(second.recorder),
			);
			expect(result.kind).toBe("rescued");
			if (result.kind !== "rescued") return;
			expect(result.evidence.resumed).toBe(true);
			expect(result.worktree.generation).toBe(shared.generation);
			expect(git(shared.worktreePath, "rev-parse", "HEAD")).toBe(L);
			expect(eventKinds(second.store)).toEqual([
				TAKEOVER_RESCUED_EVENT_KIND,
				TAKEOVER_CLEANED_EVENT_KIND,
			]);
		},
	);

	it(
		"a failed cleaned receipt is completed by the next Bridge life without redoing the rescue",
		{ timeout: 180_000 },
		async () => {
			const w = await world();
			const first = await w.boot();
			const shared = await first.manager.create({
				mainRepoPath: w.root,
				projectName: "flywheel",
				issueId: "FLY-2901",
			});
			writeFileSync(join(shared.worktreePath, "new.txt"), "new\n");
			const refused = await first.manager.runTakeoverTransaction(
				w.input({
					...first.recorder,
					recordCleaned: async () => {
						throw new Error("statestore write failed");
					},
				}),
			);
			expect(refused).toMatchObject({
				kind: "refused",
				reason: "rescue_event_unrecorded",
			});
			expect(git(shared.worktreePath, "status", "--porcelain")).toBe("");
			first.close();

			const second = await w.boot();
			const result = await second.manager.runTakeoverTransaction(
				w.input(second.recorder),
			);
			expect(result.kind).toBe("rescued");
			if (result.kind !== "rescued") return;
			expect(result.evidence.resumed).toBe(true);
			expect(eventKinds(second.store)).toEqual([
				TAKEOVER_RESCUED_EVENT_KIND,
				TAKEOVER_CLEANED_EVENT_KIND,
			]);
		},
	);
});
