/**
 * FLY-137 Phase 5: event-route Codex auto-trigger tests.
 *
 * On `stage_changed` to `design_review` or `pr_created`, Bridge:
 *   - reads `session.codex_skip` and writes skip.json if set
 *   - persists `payload.plan_path` to session.plan_path
 *   - writes a Runner-targeted instruction to CommDB pointing at
 *     `/codex-design-review <plan>` (or `/codex-code-review`)
 *   - on missing plan_path for design_review, writes a fail-closed
 *     "re-trigger with --plan" instruction instead
 *
 * Skip.json is the ONLY file Bridge writes inside the codex dir —
 * Runner/Codex writes the review JSON itself. This keeps the gate
 * non-self-authorizing.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import type http from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commDbPathForProject } from "../bridge/commdb-path.js";
import { createBridgeApp } from "../bridge/plugin.js";
import type { BridgeConfig } from "../bridge/types.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

const testProjects: ProjectEntry[] = [
	{
		projectName: "geoforge3d-codex-test",
		projectRoot: "/tmp/geoforge3d-codex-test",
		projectRepo: "xrliAnnie/GeoForge3D",
		leads: [
			{
				agentId: "product-lead",
				forumChannel: "test-channel",
				chatChannel: "test-chat",
				match: { labels: ["Product"] },
			},
		],
	},
];

function makeConfig(): BridgeConfig {
	return {
		host: "127.0.0.1",
		port: 0,
		dbPath: ":memory:",
		ingestToken: "ingest-secret",
		notificationChannel: "test-channel",
		defaultLeadAgentId: "product-lead",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300000,
		orphanThresholdMinutes: 60,
	};
}

describe("event-route Codex auto-trigger (FLY-137 Phase 5)", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;
	let tmpWorktree: string;
	let commDbDir: string;
	let originalHome: string | undefined;

	const execId = "exec-codex-trigger-1";
	const issueId = "issue-fly-137";

	beforeEach(async () => {
		// Redirect HOME so commDbPathForProject() resolves to a temp dir.
		tmpWorktree = join(
			tmpdir(),
			`codex-trigger-${Date.now()}-${Math.random()}`,
		);
		commDbDir = join(tmpWorktree, "home");
		mkdirSync(tmpWorktree, { recursive: true });
		mkdirSync(commDbDir, { recursive: true });
		originalHome = process.env.HOME;
		process.env.HOME = commDbDir;

		store = await StateStore.create(":memory:");
		const config = makeConfig();
		const app = createBridgeApp(store, testProjects, config);
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		baseUrl = `http://127.0.0.1:${port}`;

		// Seed a running session row with a known worktree path so the
		// codex trigger has a target dir for skip.json.
		store.upsertSession({
			execution_id: execId,
			issue_id: issueId,
			project_name: "geoforge3d-codex-test",
			status: "running",
			started_at: new Date().toISOString(),
			worktree_path: tmpWorktree,
		});
	});

	afterEach(async () => {
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
		store.close();
		if (originalHome !== undefined) {
			process.env.HOME = originalHome;
		} else {
			delete process.env.HOME;
		}
		rmSync(tmpWorktree, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	async function postEvent(event: Record<string, unknown>): Promise<Response> {
		return fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(event),
		});
	}

	function readCommDbInstructions(): {
		from_agent: string;
		to_agent: string;
		content: string;
	}[] {
		// FLY-493: resolve via the shared helper so it honors FLYWHEEL_COMM_DIR
		// (the test-isolation override) — matches the path the Bridge writes.
		const dbPath = commDbPathForProject("geoforge3d-codex-test");
		if (!existsSync(dbPath)) return [];
		const db = new CommDB(dbPath);
		try {
			return db.getUnreadInstructions(execId).map((row) => ({
				from_agent: row.from_agent,
				to_agent: row.to_agent,
				content: row.content,
			}));
		} finally {
			db.close();
		}
	}

	it("design_review stage with plan_path queues a Runner instruction in CommDB", async () => {
		const res = await postEvent({
			event_id: "evt-design-1",
			execution_id: execId,
			issue_id: issueId,
			project_name: "geoforge3d-codex-test",
			event_type: "stage_changed",
			payload: {
				stage: "design_review",
				plan_path: "doc/engineer/plan/draft/v1.27.0-FLY-137-foo.md",
			},
		});
		expect(res.status).toBe(200);

		// Session row has plan_path persisted
		const updated = store.getSession(execId);
		expect(updated?.plan_path).toBe(
			"doc/engineer/plan/draft/v1.27.0-FLY-137-foo.md",
		);

		// Runner inbox has the instruction
		const instructions = readCommDbInstructions();
		expect(instructions).toHaveLength(1);
		expect(instructions[0]!.from_agent).toBe("bridge");
		expect(instructions[0]!.to_agent).toBe(execId);
		expect(instructions[0]!.content).toContain("/codex-design-review");
		expect(instructions[0]!.content).toContain(
			"doc/engineer/plan/draft/v1.27.0-FLY-137-foo.md",
		);
		expect(instructions[0]!.content).toContain("await-codex-gate design");

		// Bridge does NOT pre-write the result file (gate must come from Runner/Codex).
		const resultPath = join(
			tmpWorktree,
			".flywheel",
			"runs",
			execId,
			"codex",
			"design-review.json",
		);
		expect(existsSync(resultPath)).toBe(false);
	});

	it("FLY-1188 §7.1: codex-tmux AUTHOR skips the legacy trigger — no instruction, no skip.json (request-driven lane)", async () => {
		store.patchSessionMetadata(execId, { adapter_type: "codex-tmux" });
		store.patchSessionMetadata(execId, { codex_skip: 1 }); // even with skip set

		const res = await postEvent({
			event_id: "evt-design-codex-author",
			execution_id: execId,
			issue_id: issueId,
			project_name: "geoforge3d-codex-test",
			event_type: "stage_changed",
			payload: {
				stage: "design_review",
				plan_path: "doc/engineer/plan/draft/v1.27.0-FLY-137-foo.md",
			},
		});
		expect(res.status).toBe(200);

		// plan_path is still persisted (audit metadata both lanes want)
		expect(store.getSession(execId)?.plan_path).toBe(
			"doc/engineer/plan/draft/v1.27.0-FLY-137-foo.md",
		);
		// but NO legacy reviewer machinery fires: no instruction, no skip.json
		expect(readCommDbInstructions()).toHaveLength(0);
		const skipPath = join(
			tmpWorktree,
			".flywheel",
			"runs",
			execId,
			"codex",
			"skip.json",
		);
		expect(existsSync(skipPath)).toBe(false);
	});

	it("codex_skip=true on session → writes skip.json and does NOT queue a CommDB instruction", async () => {
		store.patchSessionMetadata(execId, { codex_skip: 1 });

		const res = await postEvent({
			event_id: "evt-design-skip",
			execution_id: execId,
			issue_id: issueId,
			project_name: "geoforge3d-codex-test",
			event_type: "stage_changed",
			payload: {
				stage: "design_review",
				plan_path: "doc/engineer/plan/draft/foo.md",
			},
		});
		expect(res.status).toBe(200);

		const skipPath = join(
			tmpWorktree,
			".flywheel",
			"runs",
			execId,
			"codex",
			"skip.json",
		);
		expect(existsSync(skipPath)).toBe(true);

		const skip = JSON.parse(readFileSync(skipPath, "utf-8"));
		expect(skip.executionId).toBe(execId);
		expect(skip.reviewType).toBe("design");
		expect(skip.reason).toBe("codex-skip-label");

		// No CommDB instruction
		const instructions = readCommDbInstructions();
		expect(instructions).toHaveLength(0);
	});

	it("design_review with missing plan_path writes a fail-closed re-trigger instruction (no skip)", async () => {
		const res = await postEvent({
			event_id: "evt-design-missing-plan",
			execution_id: execId,
			issue_id: issueId,
			project_name: "geoforge3d-codex-test",
			event_type: "stage_changed",
			payload: { stage: "design_review" },
		});
		expect(res.status).toBe(200);

		// No skip.json (this is a Runner protocol violation, not a sanctioned skip)
		const skipPath = join(
			tmpWorktree,
			".flywheel",
			"runs",
			execId,
			"codex",
			"skip.json",
		);
		expect(existsSync(skipPath)).toBe(false);

		// Runner inbox has a re-trigger instruction
		const instructions = readCommDbInstructions();
		expect(instructions).toHaveLength(1);
		expect(instructions[0]!.content).toContain("requires --plan");
		expect(instructions[0]!.content).toContain(
			"stage set design_review --plan",
		);
	});

	it("pr_created stage queues a code-review instruction", async () => {
		const res = await postEvent({
			event_id: "evt-pr-1",
			execution_id: execId,
			issue_id: issueId,
			project_name: "geoforge3d-codex-test",
			event_type: "stage_changed",
			payload: { stage: "pr_created" },
		});
		expect(res.status).toBe(200);

		const instructions = readCommDbInstructions();
		expect(instructions).toHaveLength(1);
		expect(instructions[0]!.content).toContain("/codex-code-review");
		expect(instructions[0]!.content).toContain("await-codex-gate code");
	});

	it("pr_created with codex_skip=true writes code skip.json", async () => {
		store.patchSessionMetadata(execId, { codex_skip: 1 });

		const res = await postEvent({
			event_id: "evt-pr-skip",
			execution_id: execId,
			issue_id: issueId,
			project_name: "geoforge3d-codex-test",
			event_type: "stage_changed",
			payload: { stage: "pr_created" },
		});
		expect(res.status).toBe(200);

		const skipPath = join(
			tmpWorktree,
			".flywheel",
			"runs",
			execId,
			"codex",
			"skip.json",
		);
		expect(existsSync(skipPath)).toBe(true);
		const skip = JSON.parse(readFileSync(skipPath, "utf-8"));
		expect(skip.reviewType).toBe("code");
	});

	it("rejects unsafe plan_path (absolute) silently — does not persist", async () => {
		const res = await postEvent({
			event_id: "evt-design-unsafe-abs",
			execution_id: execId,
			issue_id: issueId,
			project_name: "geoforge3d-codex-test",
			event_type: "stage_changed",
			payload: { stage: "design_review", plan_path: "/etc/passwd" },
		});
		expect(res.status).toBe(200);

		const updated = store.getSession(execId);
		expect(updated?.plan_path).toBeUndefined();
	});

	it("rejects unsafe plan_path (.. traversal) silently — does not persist", async () => {
		const res = await postEvent({
			event_id: "evt-design-unsafe-trav",
			execution_id: execId,
			issue_id: issueId,
			project_name: "geoforge3d-codex-test",
			event_type: "stage_changed",
			payload: {
				stage: "design_review",
				plan_path: "../escape/foo.md",
			},
		});
		expect(res.status).toBe(200);

		const updated = store.getSession(execId);
		expect(updated?.plan_path).toBeUndefined();
	});

	it("worktree_ready event patches session.worktree_path on the running session", async () => {
		// The session was seeded with tmpWorktree; verify the event
		// overwrites it with the real Runner-reported path.
		const newWorktree = join(tmpWorktree, "real-runner-worktree");
		const res = await postEvent({
			event_id: "evt-wt-1",
			execution_id: execId,
			issue_id: issueId,
			project_name: "geoforge3d-codex-test",
			event_type: "worktree_ready",
			payload: { worktreePath: newWorktree },
		});
		expect(res.status).toBe(200);

		const after = store.getSession(execId);
		expect(after?.worktree_path).toBe(newWorktree);
	});

	it("worktree_ready event upserts a pending session when row does not exist (Codex R2/R3 race fix)", async () => {
		// Simulate the race: worktree_ready POST lands BEFORE
		// session_started's fire-and-forget POST. Use a fresh exec id so
		// no row exists yet.
		const lateExecId = "exec-wt-before-started";
		const lateIssueId = "issue-late";
		const newWorktree = join(tmpWorktree, "late-runner");

		expect(store.getSession(lateExecId)).toBeUndefined();

		const res = await postEvent({
			event_id: "evt-wt-late",
			execution_id: lateExecId,
			issue_id: lateIssueId,
			project_name: "geoforge3d-codex-test",
			event_type: "worktree_ready",
			payload: { worktreePath: newWorktree },
		});
		expect(res.status).toBe(200);

		const upserted = store.getSession(lateExecId);
		expect(upserted).toBeDefined();
		expect(upserted?.worktree_path).toBe(newWorktree);
		// Codex R3: row must stay `pending` so the later session_started
		// can apply the FSM-legal `pending → running` transition.
		expect(upserted?.status).toBe("pending");
	});

	it("worktree_ready event with missing worktreePath payload preserves existing value", async () => {
		const before = store.getSession(execId);
		const beforePath = before?.worktree_path;
		expect(beforePath).toBeTruthy();
		const res = await postEvent({
			event_id: "evt-wt-empty",
			execution_id: execId,
			issue_id: issueId,
			project_name: "geoforge3d-codex-test",
			event_type: "worktree_ready",
			payload: {},
		});
		expect(res.status).toBe(200);
		// Existing value preserved (handler logs warning + skips patch).
		const after = store.getSession(execId);
		expect(after?.worktree_path).toBe(beforePath);
	});

	it("non-trigger stages (implement / brainstorm) do NOT queue a Codex instruction", async () => {
		const res = await postEvent({
			event_id: "evt-impl",
			execution_id: execId,
			issue_id: issueId,
			project_name: "geoforge3d-codex-test",
			event_type: "stage_changed",
			payload: { stage: "implement" },
		});
		expect(res.status).toBe(200);

		const instructions = readCommDbInstructions();
		expect(instructions).toHaveLength(0);
	});
});

// Tell vitest this file uses a real network port, so it doesn't race
// with other event-route tests sharing the same suite namespace.
//
// (No vitest-specific markup needed — each `describe` creates its own
//  server instance per `beforeEach`.)
void homedir;
