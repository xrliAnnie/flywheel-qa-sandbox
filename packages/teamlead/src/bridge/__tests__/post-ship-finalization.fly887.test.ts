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
 * is removed and drops the TURN row.
 *
 * FLY-1204: the finalizer ALSO reclaims the QA phase-session (role `qa`, incl. the
 * `completed` terminal state a shipped QA lands in). The old design relied on
 * `postMergeTmuxCleanup(opts.executionId)` to tear down the QA, but that trigger
 * chain is fragile (ship via external-merge, QA advanced off `needs_review` by
 * another path, registration already reaped) — so a `completed` QA process leaked
 * alive and accumulated toward OOM. The finalize is idempotent (already-gone → a
 * no-op close), so it can always attempt the QA regardless of the trigger.
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
	it("closes parked design + implement + qa (→ completed), deletes TURN", async () => {
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
		// FLY-1204: a QA phase parked at awaiting_review (ship arrived via a path
		// that didn't tear it down) must now be reclaimed by finalize, not left
		// leaked alive.
		seed(store, {
			execution_id: "q",
			status: "awaiting_review",
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
		// FLY-1204: qa is now reclaimed too (awaiting_review → completed).
		expect(store.getSession("q")?.status).toBe("completed");

		const db2 = new CommDB(commDbPathForProject("flywheel"));
		expect(db2.getTurn("FLY-1")).toBeNull();
		db2.close();
	});

	// FLY-1204: the primary leak — a shipped QA phase-session parked at the
	// `completed` terminal state whose tmux was never torn down. finalize must
	// attempt to close it (idempotent when tmux is already gone).
	it("reclaims a leaked completed qa (idempotent close on already-gone tmux)", async () => {
		const { store, transitionOpts } = await makeStore();
		seed(store, {
			execution_id: "q",
			status: "completed",
			chat_thread_role: "qa",
			session_role: "qa",
		});
		const finalize = makeFinalizeThreeStagePhases(store, transitionOpts);
		await finalize("FLY-1", "flywheel");

		// completed is terminal (no FSM transition) — the observable proof that
		// finalize reclaimed it is the close-runner audit event.
		expect(store.getSession("q")?.status).toBe("completed");
		const closeEvent = store
			.getEventsByExecution("q")
			.find((e) => e.event_type === "lead_close_runner");
		expect(closeEvent).toBeDefined();
		expect(
			(closeEvent?.payload as { alreadyGone?: boolean })?.alreadyGone,
		).toBe(true);
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

describe("runPostShipFinalization thread teardown via shared sink (FLY-1165)", () => {
	const PROJECT = {
		projectName: "flywheel",
		projectRoot: "/tmp/fw",
		leads: [
			{
				agentId: "tadashi",
				chatChannel: "ch-eng",
				match: { labels: ["Flywheel"] },
				botToken: "tok-tadashi",
			},
		],
	} as unknown as import("../../ProjectConfig.js").ProjectEntry;

	function seedShipped(store: StateStore, execId: string, issueId: string) {
		store.upsertSession({
			execution_id: execId,
			issue_id: issueId,
			project_name: "flywheel",
			status: "completed",
			chat_thread_role: "main",
			issue_labels: JSON.stringify(["Flywheel"]),
		});
	}

	const okFetch = () =>
		vi
			.fn()
			.mockResolvedValue(
				new Response(JSON.stringify({ id: "m-1" }), { status: 200 }),
			) as unknown as typeof fetch;

	it("archives a fresh thread through the sink — one PATCH, archived_at set, post-ship audit source", async () => {
		const { store } = await makeStore();
		seedShipped(store, "exec-s1", "FLY-10");
		store.upsertChatThread("t-s1", "ch-eng", "FLY-10", "tadashi");
		const archiveFn = vi.fn().mockResolvedValue({
			archived: true,
			attempts: 1,
			status: 200,
			reason: "ok",
		});
		const removeUserFn = vi.fn().mockResolvedValue(undefined);

		await runPostShipFinalization(
			{
				executionId: "exec-s1",
				issueId: "FLY-10",
				projectName: "flywheel",
				sessionStatus: "completed",
				discordOwnerUserId: "owner-1",
			},
			{
				store,
				projects: [PROJECT],
				archiveFn,
				removeUserFn,
				fetchImpl: okFetch(),
			},
		);

		expect(archiveFn).toHaveBeenCalledTimes(1);
		expect(removeUserFn).toHaveBeenCalledWith(
			"t-s1",
			"owner-1",
			"tok-tadashi",
			expect.any(Object),
		);
		expect(store.isChatThreadArchived("t-s1")).toBe(true);
		const events = store.getEventsByExecution("exec-s1");
		const archivedEvent = events.find(
			(e) => e.event_type === "chat_thread_archived",
		);
		expect(archivedEvent?.source).toBe("bridge.post-ship-finalization");
	});

	it("already-archived thread: ZERO Discord PATCH + non-failure audit (idempotent no-op success)", async () => {
		const { store } = await makeStore();
		seedShipped(store, "exec-s2", "FLY-11");
		store.upsertChatThread("t-s2", "ch-eng", "FLY-11", "tadashi");
		// Archived earlier (e.g. by the close cascade); Annie may have re-opened it.
		store.markChatThreadArchived("t-s2");
		const archiveFn = vi.fn();
		const removeUserFn = vi.fn();

		await runPostShipFinalization(
			{
				executionId: "exec-s2",
				issueId: "FLY-11",
				projectName: "flywheel",
				sessionStatus: "completed",
				discordOwnerUserId: "owner-1",
			},
			{
				store,
				projects: [PROJECT],
				archiveFn,
				removeUserFn,
				fetchImpl: okFetch(),
			},
		);

		// Zero Discord PATCH / removal side effects on the re-openable thread.
		expect(archiveFn).not.toHaveBeenCalled();
		expect(removeUserFn).not.toHaveBeenCalled();
		// Non-failure audit: never a chat_thread_archive_failed for this case.
		const events = store.getEventsByExecution("exec-s2");
		expect(
			events.some((e) => e.event_type === "chat_thread_archive_failed"),
		).toBe(false);
		const noop = events.find((e) => e.event_type === "chat_thread_archived");
		expect(noop?.source).toBe("bridge.post-ship-finalization");
		expect((noop?.payload as { reason?: string })?.reason).toBe(
			"already_archived",
		);
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
