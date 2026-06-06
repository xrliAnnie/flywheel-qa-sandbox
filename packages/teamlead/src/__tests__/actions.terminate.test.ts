/**
 * FLY-228: handleTerminate — reason audit, transition-first ordering, observable
 * partial-failure on tmux-kill error, and ownership-validated best-effort gate
 * resolution. tmux-lookup is mocked so we can deterministically force a kill
 * failure / control whether a tmux target exists.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { WORKFLOW_TRANSITIONS, WorkflowFSM } from "flywheel-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock tmux-lookup: control target presence + kill outcome per test.
vi.mock("../bridge/tmux-lookup.js", () => ({
	getTmuxTargetFromCommDb: vi.fn(),
	killTmuxWindow: vi.fn(),
}));
// Avoid real macOS Terminal automation in the kill-success path.
vi.mock("flywheel-core", async (importOriginal) => ({
	...(await importOriginal<typeof import("flywheel-core")>()),
	closeRunnerTerminalView: vi.fn(async () => {}),
}));

import type { ApplyTransitionOpts } from "../applyTransition.js";
import { handleTerminate } from "../bridge/actions.js";
import {
	getTmuxTargetFromCommDb,
	killTmuxWindow,
} from "../bridge/tmux-lookup.js";
import { StateStore } from "../StateStore.js";

const getTarget = vi.mocked(getTmuxTargetFromCommDb);
const kill = vi.mocked(killTmuxWindow);

describe("handleTerminate (FLY-228)", () => {
	let store: StateStore;
	let opts: ApplyTransitionOpts;
	let commRoot: string;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		opts = { store, fsm: new WorkflowFSM(WORKFLOW_TRANSITIONS) };
		commRoot = mkdtempSync(join(tmpdir(), "fly228-terminate-comm-"));
		process.env.FLYWHEEL_COMM_ROOT = commRoot;
		getTarget.mockReset();
		kill.mockReset();
		getTarget.mockReturnValue(undefined); // no tmux target by default
		kill.mockResolvedValue({ killed: true });
	});

	afterEach(() => {
		store.close();
		rmSync(commRoot, { recursive: true, force: true });
		delete process.env.FLYWHEEL_COMM_ROOT;
	});

	const seedAwaitingReview = (execId = "e1") =>
		store.upsertSession({
			execution_id: execId,
			issue_id: "i1",
			project_name: "geoforge3d",
			status: "awaiting_review",
			issue_identifier: "GEO-1",
		});

	it("transitions to terminated and records the provided reason in the audit", async () => {
		seedAwaitingReview();
		const res = await handleTerminate(
			store,
			"e1",
			opts,
			undefined,
			[],
			undefined,
			undefined,
			"Annie canceled GEO-411 — CJK relief unwanted",
		);
		expect(res.success).toBe(true);
		const s = store.getSession("e1")!;
		expect(s.status).toBe("terminated");
		expect(s.last_error).toBe("Annie canceled GEO-411 — CJK relief unwanted");
	});

	it("falls back to 'Terminated by CEO' when no reason given", async () => {
		seedAwaitingReview();
		await handleTerminate(store, "e1", opts);
		expect(store.getSession("e1")!.last_error).toBe("Terminated by CEO");
	});

	it("blank/whitespace reason → fallback", async () => {
		seedAwaitingReview();
		await handleTerminate(
			store,
			"e1",
			opts,
			undefined,
			[],
			undefined,
			undefined,
			"   ",
		);
		expect(store.getSession("e1")!.last_error).toBe("Terminated by CEO");
	});

	it("rejects a non-terminable status WITHOUT touching tmux (transition-first guard)", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "geoforge3d",
			status: "completed", // not in terminate fromStates
		});
		const res = await handleTerminate(store, "e1", opts);
		expect(res.success).toBe(false);
		expect(res.message).toContain("Cannot terminate");
		expect(getTarget).not.toHaveBeenCalled();
		expect(kill).not.toHaveBeenCalled();
		expect(store.getSession("e1")!.status).toBe("completed");
	});

	it("tmux-kill failure → success:false + cleanupPending, FSM still terminated + audit event", async () => {
		seedAwaitingReview();
		getTarget.mockReturnValue({
			tmuxWindow: "sess:@9",
			projectName: "geoforge3d",
		} as ReturnType<typeof getTmuxTargetFromCommDb>);
		kill.mockResolvedValue({ killed: false, error: "permission denied" });

		const res = await handleTerminate(store, "e1", opts);

		expect(res.success).toBe(false);
		expect(res.cleanupPending).toBe(true);
		expect(res.message).toContain("transitioned to terminated");
		// FSM is terminal regardless (zombie awaiting_review is gone).
		expect(store.getSession("e1")!.status).toBe("terminated");
		const events = store.getEventsByExecution("e1");
		expect(
			events.some((e) => e.event_type === "lead_terminate_cleanup_failed"),
		).toBe(true);
	});

	it("tmux-kill success with a target → success:true", async () => {
		seedAwaitingReview();
		getTarget.mockReturnValue({
			tmuxWindow: "sess:@9",
			projectName: "geoforge3d",
		} as ReturnType<typeof getTmuxTargetFromCommDb>);
		kill.mockResolvedValue({ killed: true });
		const res = await handleTerminate(store, "e1", opts);
		expect(res.success).toBe(true);
		expect(res.cleanupPending).toBeUndefined();
		expect(store.getSession("e1")!.status).toBe("terminated");
	});

	it("resolves a bound approve_to_ship gate so it no longer shows pending", async () => {
		// seed a real CommDB gate for the runner
		mkdirSync(join(commRoot, "geoforge3d"), { recursive: true });
		const db = new CommDB(join(commRoot, "geoforge3d", "comm.db"), true);
		let qid: string;
		try {
			db.registerSession(
				"e1",
				"sess:@9",
				"geoforge3d",
				undefined,
				"product-lead",
			);
			qid = db.insertQuestion("e1", "product-lead", "PR ready", {
				checkpoint: "approve_to_ship",
			});
		} finally {
			db.close();
		}
		seedAwaitingReview();
		store.setReviewBinding("e1", { questionId: qid, prHeadSha: null });

		await handleTerminate(store, "e1", opts);

		const check = new CommDB(join(commRoot, "geoforge3d", "comm.db"), false);
		try {
			// resolveGate(qid, 0) expires it → no longer a pending gate
			expect(
				check.getPendingGateByRunner("e1", "approve_to_ship"),
			).toBeUndefined();
		} finally {
			check.close();
		}
	});

	it("does NOT touch a gate whose binding doesn't belong to this runner", async () => {
		mkdirSync(join(commRoot, "geoforge3d"), { recursive: true });
		const db = new CommDB(join(commRoot, "geoforge3d", "comm.db"), true);
		let qid: string;
		try {
			// question authored by a DIFFERENT runner
			db.registerSession(
				"other",
				"sess:@8",
				"geoforge3d",
				undefined,
				"product-lead",
			);
			qid = db.insertQuestion("other", "product-lead", "PR ready", {
				checkpoint: "approve_to_ship",
			});
		} finally {
			db.close();
		}
		seedAwaitingReview();
		store.setReviewBinding("e1", { questionId: qid, prHeadSha: null }); // mismatched owner

		await handleTerminate(store, "e1", opts);

		const check = new CommDB(join(commRoot, "geoforge3d", "comm.db"), false);
		try {
			// ownership check failed → gate left pending (still owned by "other")
			expect(
				check.getPendingGateByRunner("other", "approve_to_ship"),
			).toBeDefined();
		} finally {
			check.close();
		}
	});

	it("running terminate with no tmux target → no CommDB gate open attempt (best-effort skip)", async () => {
		// priorStatus=running and no review_question_id → resolveTerminatedGate is a no-op
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "geoforge3d",
			status: "running",
		});
		const res = await handleTerminate(store, "e1", opts);
		expect(res.success).toBe(true);
		expect(store.getSession("e1")!.status).toBe("terminated");
	});
});
