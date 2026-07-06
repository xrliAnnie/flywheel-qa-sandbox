import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { WORKFLOW_TRANSITIONS, WorkflowFSM } from "flywheel-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplyTransitionOpts } from "../../applyTransition.js";
import { DirectiveExecutor } from "../../DirectiveExecutor.js";
import { StateStore } from "../../StateStore.js";
import { commDbPathForProject } from "../commdb-path.js";
import {
	makeFinalizeThreeStagePhases,
	runPostShipFinalization,
} from "../post-ship-finalization.js";

/**
 * FLY-887 Step 8: ship-time finalization of the parked design + implement phases.
 * The finalizer closes them (finalizeDone → completed) BEFORE the shared worktree
 * is removed, leaves the QA (shipped) session alone, and drops the TURN row.
 */

let commDir: string;
beforeEach(() => {
	commDir = mkdtempSync(join(tmpdir(), "fly887-postship-"));
	process.env.FLYWHEEL_COMM_DIR = commDir;
});
afterEach(() => {
	process.env.FLYWHEEL_COMM_DIR = undefined;
	rmSync(commDir, { recursive: true, force: true });
});

async function makeStore() {
	const store = await StateStore.create(":memory:");
	const fsm = new WorkflowFSM(WORKFLOW_TRANSITIONS);
	const executor = new DirectiveExecutor(store);
	const transitionOpts: ApplyTransitionOpts = { store, fsm, executor };
	return { store, transitionOpts };
}

function seed(
	store: StateStore,
	o: {
		execution_id: string;
		status: string;
		chat_thread_role: string;
		session_role: string;
	},
) {
	store.upsertSession({
		execution_id: o.execution_id,
		issue_id: "FLY-1",
		project_name: "flywheel",
		status: o.status,
		session_role: o.session_role,
		chat_thread_role: o.chat_thread_role,
	});
}

describe("makeFinalizeThreeStagePhases (FLY-887)", () => {
	it("closes parked design + implement (→ completed), leaves qa, deletes TURN", async () => {
		const { store, transitionOpts } = await makeStore();
		seed(store, {
			execution_id: "d",
			status: "design_done",
			chat_thread_role: "design",
			session_role: "design",
		});
		seed(store, {
			execution_id: "i",
			status: "awaiting_review",
			chat_thread_role: "implement",
			session_role: "implement",
		});
		seed(store, {
			execution_id: "q",
			status: "running",
			chat_thread_role: "qa",
			session_role: "qa",
		});
		// A live TURN row that finalization must drop.
		const db = new CommDB(commDbPathForProject("flywheel"));
		db.grantTurn("FLY-1", "q", "qa", 1_700_000_000_000);
		db.close();

		const finalize = makeFinalizeThreeStagePhases(store, transitionOpts);
		await finalize("FLY-1", "flywheel");

		expect(store.getSession("d")?.status).toBe("completed");
		expect(store.getSession("i")?.status).toBe("completed");
		// QA is the shipped session — finalized by the normal path, not here.
		expect(store.getSession("q")?.status).toBe("running");

		const db2 = new CommDB(commDbPathForProject("flywheel"));
		expect(db2.getTurn("FLY-1")).toBeNull();
		db2.close();
	});

	it("no-op for a single-session issue (no phase sessions)", async () => {
		const { store, transitionOpts } = await makeStore();
		store.upsertSession({
			execution_id: "main-1",
			issue_id: "FLY-2",
			project_name: "flywheel",
			status: "awaiting_review",
			chat_thread_role: "main",
		});
		const finalize = makeFinalizeThreeStagePhases(store, transitionOpts);
		await expect(finalize("FLY-2", "flywheel")).resolves.toBeUndefined();
		// the main session is untouched
		expect(store.getSession("main-1")?.status).toBe("awaiting_review");
	});

	// FLY-887 founder-visibility real-machine QA (Finding B): the status line
	// otherwise goes stale at whatever it last showed pre-merge — the final
	// refresh must fire AFTER design/implement are closed to completed (so it
	// can render the documented done/done/done state), and must never throw
	// even if the refresh itself fails (best-effort, byte-compat when absent).
	it("calls refreshPhaseStatusLine AFTER closing design+implement to completed", async () => {
		const { store, transitionOpts } = await makeStore();
		seed(store, {
			execution_id: "d",
			status: "design_done",
			chat_thread_role: "design",
			session_role: "design",
		});
		seed(store, {
			execution_id: "i",
			status: "awaiting_review",
			chat_thread_role: "implement",
			session_role: "implement",
		});
		const statusesAtRefreshTime: (string | undefined)[] = [];
		const refreshPhaseStatusLine = vi.fn(async (issueId: string) => {
			statusesAtRefreshTime.push(store.getSession("d")?.status);
			statusesAtRefreshTime.push(store.getSession("i")?.status);
			expect(issueId).toBe("FLY-1");
		});
		const finalize = makeFinalizeThreeStagePhases(
			store,
			transitionOpts,
			refreshPhaseStatusLine,
		);
		await finalize("FLY-1", "flywheel");

		expect(refreshPhaseStatusLine).toHaveBeenCalledOnce();
		expect(statusesAtRefreshTime).toEqual(["completed", "completed"]);
	});

	it("a throwing refreshPhaseStatusLine is swallowed — finalization still completes", async () => {
		const { store, transitionOpts } = await makeStore();
		seed(store, {
			execution_id: "d",
			status: "design_done",
			chat_thread_role: "design",
			session_role: "design",
		});
		const refreshPhaseStatusLine = vi.fn(async () => {
			throw new Error("discord boom");
		});
		const finalize = makeFinalizeThreeStagePhases(
			store,
			transitionOpts,
			refreshPhaseStatusLine,
		);
		await expect(finalize("FLY-1", "flywheel")).resolves.toBeUndefined();
		expect(store.getSession("d")?.status).toBe("completed");
	});

	it("absent refreshPhaseStatusLine (byte-compat) — no refresh attempted, no error", async () => {
		const { store, transitionOpts } = await makeStore();
		seed(store, {
			execution_id: "d",
			status: "design_done",
			chat_thread_role: "design",
			session_role: "design",
		});
		const finalize = makeFinalizeThreeStagePhases(store, transitionOpts);
		await expect(finalize("FLY-1", "flywheel")).resolves.toBeUndefined();
		expect(store.getSession("d")?.status).toBe("completed");
	});
});

describe("runPostShipFinalization ordering (FLY-887, Codex R1 #8)", () => {
	it("calls finalizeThreeStagePhases BEFORE removeCleanWorktree", async () => {
		const { store } = await makeStore();
		// A shipped QA session so the atomic claim + resolveLead path have a row.
		seed(store, {
			execution_id: "q",
			status: "completed",
			chat_thread_role: "qa",
			session_role: "qa",
		});
		const order: string[] = [];
		const finalizeThreeStagePhases = vi.fn(async () => {
			order.push("finalizePhases");
		});
		const removeCleanWorktree = vi.fn(async () => {
			order.push("removeWorktree");
		});
		await runPostShipFinalization(
			{
				executionId: "q",
				issueId: "FLY-1",
				projectName: "flywheel",
				sessionStatus: "completed",
			},
			{
				store,
				projects: [],
				finalizeThreeStagePhases,
				removeCleanWorktree,
			},
		);
		expect(finalizeThreeStagePhases).toHaveBeenCalledWith("FLY-1", "flywheel");
		expect(order).toEqual(["finalizePhases", "removeWorktree"]);
	});
});
