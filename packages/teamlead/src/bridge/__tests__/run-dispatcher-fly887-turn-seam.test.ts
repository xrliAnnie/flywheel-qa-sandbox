/**
 * FLY-887 Step 4b: the RunDispatcher pre-launch TURN grant seam. A three-stage
 * phase SPAWN must have its shared-worktree TURN recorded in CommDB BEFORE the
 * runner launches (its first `turn` self-check must see `yours`, not `no-turn`).
 * The seam records it between preRegisterCommDb and blueprint.run; a
 * non-shareParentBranch dispatch or keep-alive OFF grants nothing (byte-compat).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import type { BlueprintContext } from "flywheel-edge-worker/dist/Blueprint.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commDbPathForProject } from "../commdb-path.js";
import { type ProjectRuntime, RunDispatcher } from "../run-dispatcher.js";
import { RunnerAdmissionController } from "../runner-admission.js";

describe("RunDispatcher pre-launch TURN grant seam (FLY-887)", () => {
	let tmpDir: string;
	let commDir: string;
	/** The TURN holder observed INSIDE blueprint.run (proves happens-before). */
	let turnAtLaunch: { holder: string; phase: string } | null;

	function makeRuntime(): ProjectRuntime {
		return {
			blueprint: {
				run: vi.fn(async (_n: unknown, _r: string, ctx: BlueprintContext) => {
					// Read the TURN the moment the runner would launch.
					const db = new CommDB(commDbPathForProject("proj"));
					const t = db.getTurn("issue-1");
					db.close();
					turnAtLaunch = t
						? { holder: t.holder_exec_id, phase: t.phase }
						: null;
					// Confirm the ctx phase role matches (the seam keys on it).
					void ctx.sessionRole;
					return { success: true, sessionId: "s" };
				}),
			} as unknown as ProjectRuntime["blueprint"],
			projectRoot: tmpDir,
			tmuxSessionName: "runner-test",
			agentDispatcher: {
				dispatchByName: vi.fn(),
			} as unknown as ProjectRuntime["agentDispatcher"],
		};
	}

	function makeDispatcher(): RunDispatcher {
		return new RunDispatcher(
			new Map([["proj", makeRuntime()]]),
			[],
			RunnerAdmissionController.alwaysAdmit(),
		);
	}

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "fly887-seam-"));
		commDir = mkdtempSync(join(tmpdir(), "fly887-seam-comm-"));
		process.env.FLYWHEEL_COMM_DIR = commDir;
		process.env.FLYWHEEL_THREE_STAGE_KEEPALIVE = undefined;
		turnAtLaunch = null;
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
		rmSync(commDir, { recursive: true, force: true });
		process.env.FLYWHEEL_COMM_DIR = undefined;
		process.env.FLYWHEEL_THREE_STAGE_KEEPALIVE = undefined;
		vi.restoreAllMocks();
	});

	it("grants the phase TURN BEFORE launch (fresh Design spawn)", async () => {
		const dispatcher = makeDispatcher();
		const res = await dispatcher.start({
			issueId: "issue-1",
			projectName: "proj",
			sessionRole: "design",
			shareParentBranch: true,
		});
		await dispatcher.drain();
		// The runner observed the TURN already granted to itself at launch time.
		expect(turnAtLaunch).toEqual({ holder: res.executionId, phase: "design" });
		// And it persists.
		const db = new CommDB(commDbPathForProject("proj"));
		const t = db.getTurn("issue-1");
		const source = db.listWorkflowSourceEvents();
		const history = db.listTurnSourceHistory("issue-1");
		db.close();
		expect(t?.holder_exec_id).toBe(res.executionId);
		expect(source).toHaveLength(1);
		expect(source[0]).toMatchObject({
			project: "proj",
			source_event_id: `turn:spawn:${res.executionId}`,
			kind: "turn_grant",
		});
		expect(history).toHaveLength(1);
		expect(history[0]?.target_run_id).toBeNull();
	});

	it("byte-compat: a non-phase (no shareParentBranch) dispatch grants NO turn", async () => {
		const dispatcher = makeDispatcher();
		await dispatcher.start({
			issueId: "issue-1",
			projectName: "proj",
			sessionRole: "main",
		});
		await dispatcher.drain();
		expect(turnAtLaunch).toBeNull();
	});

	it("byte-compat: keep-alive OFF grants NO turn even for a phase dispatch", async () => {
		process.env.FLYWHEEL_THREE_STAGE_KEEPALIVE = "0";
		const dispatcher = makeDispatcher();
		await dispatcher.start({
			issueId: "issue-1",
			projectName: "proj",
			sessionRole: "implement",
			shareParentBranch: true,
		});
		await dispatcher.drain();
		expect(turnAtLaunch).toBeNull();
	});
});
