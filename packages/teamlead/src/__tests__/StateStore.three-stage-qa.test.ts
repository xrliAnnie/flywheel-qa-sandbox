import { describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

/**
 * FLY-859: StateStore queries backing the three-stage QA verdict coordinator —
 * fix-loop round counting, reconcile sweep candidates, and latest stored
 * verdict event lookup. `chat_thread_role` is the durable three-stage marker
 * (Blueprint writes the phase role ONLY for shareParentBranch phase sessions).
 */
async function freshStore(): Promise<StateStore> {
	return StateStore.create(":memory:");
}

function seedSession(
	store: StateStore,
	over: {
		execution_id: string;
		issue_id: string;
		status?: string;
		session_role?: string;
		chat_thread_role?: string;
		session_params?: string;
	},
): void {
	store.upsertSession({
		execution_id: over.execution_id,
		issue_id: over.issue_id,
		project_name: "flywheel",
		status: over.status ?? "running",
		session_role: over.session_role,
		chat_thread_role: over.chat_thread_role,
		session_params: over.session_params,
	});
}

describe("countSessionsByIssueAndChatThreadRole (FLY-859 fix-round cap)", () => {
	it("counts only the requested chat_thread_role for the issue", async () => {
		const store = await freshStore();
		seedSession(store, {
			execution_id: "impl-1",
			issue_id: "FLY-1",
			session_role: "implement",
			chat_thread_role: "implement",
			status: "completed",
		});
		seedSession(store, {
			execution_id: "impl-2",
			issue_id: "FLY-1",
			session_role: "implement",
			chat_thread_role: "implement",
			status: "running",
		});
		seedSession(store, {
			execution_id: "qa-1",
			issue_id: "FLY-1",
			session_role: "qa",
			chat_thread_role: "qa",
			status: "running",
		});
		// auto-QA style session: role qa but chat_thread_role main → not counted
		seedSession(store, {
			execution_id: "autoqa-1",
			issue_id: "FLY-1",
			session_role: "qa",
			chat_thread_role: "main",
		});
		expect(
			store.countSessionsByIssueAndChatThreadRole("FLY-1", "implement"),
		).toBe(2);
		expect(store.countSessionsByIssueAndChatThreadRole("FLY-1", "qa")).toBe(1);
	});

	it("does not leak counts across issues", async () => {
		const store = await freshStore();
		seedSession(store, {
			execution_id: "impl-a",
			issue_id: "FLY-1",
			chat_thread_role: "implement",
		});
		seedSession(store, {
			execution_id: "impl-b",
			issue_id: "FLY-2",
			chat_thread_role: "implement",
		});
		expect(
			store.countSessionsByIssueAndChatThreadRole("FLY-2", "implement"),
		).toBe(1);
	});

	it("returns 0 when nothing matches", async () => {
		const store = await freshStore();
		expect(
			store.countSessionsByIssueAndChatThreadRole("FLY-9", "implement"),
		).toBe(0);
	});
});

describe("getThreeStageQaSessionsWithVerdictEvents (FLY-859 sweep a)", () => {
	it("returns only chat_thread_role=qa sessions that have a stored qa_result event", async () => {
		const store = await freshStore();
		seedSession(store, {
			execution_id: "qa-with-event",
			issue_id: "FLY-1",
			session_role: "qa",
			chat_thread_role: "qa",
		});
		seedSession(store, {
			execution_id: "qa-no-event",
			issue_id: "FLY-2",
			session_role: "qa",
			chat_thread_role: "qa",
		});
		// auto-QA session with a qa_result event → chat_thread_role main → excluded
		seedSession(store, {
			execution_id: "autoqa-with-event",
			issue_id: "FLY-3",
			session_role: "qa",
			chat_thread_role: "main",
		});
		store.insertEvent({
			event_id: "ev-1",
			execution_id: "qa-with-event",
			issue_id: "FLY-1",
			project_name: "flywheel",
			event_type: "qa_result",
			payload: { status: "fail" },
			source: "test",
		});
		store.insertEvent({
			event_id: "ev-2",
			execution_id: "autoqa-with-event",
			issue_id: "FLY-3",
			project_name: "flywheel",
			event_type: "qa_result",
			payload: { status: "pass" },
			source: "test",
		});
		const rows = store.getThreeStageQaSessionsWithVerdictEvents();
		expect(rows.map((r) => r.execution_id)).toEqual(["qa-with-event"]);
	});
});

describe("getStrandedThreeStageQaPassSessions (FLY-859 sweep c)", () => {
	it("returns terminal qa-phase sessions carrying a verdict intent; skips others", async () => {
		const store = await freshStore();
		seedSession(store, {
			execution_id: "stranded",
			issue_id: "FLY-1",
			session_role: "qa",
			chat_thread_role: "qa",
			status: "completed",
			session_params: JSON.stringify({
				three_stage_verdict: { status: "pass", event_id: "e1" },
			}),
		});
		seedSession(store, {
			execution_id: "failed-with-intent",
			issue_id: "FLY-2",
			session_role: "qa",
			chat_thread_role: "qa",
			status: "failed",
			session_params: JSON.stringify({
				three_stage_verdict: { status: "pass", event_id: "e2" },
			}),
		});
		// still running → not a candidate
		seedSession(store, {
			execution_id: "running-qa",
			issue_id: "FLY-3",
			session_role: "qa",
			chat_thread_role: "qa",
			status: "running",
			session_params: JSON.stringify({
				three_stage_verdict: { status: "pass", event_id: "e3" },
			}),
		});
		// completed but no intent → not a candidate
		seedSession(store, {
			execution_id: "no-intent",
			issue_id: "FLY-4",
			session_role: "qa",
			chat_thread_role: "qa",
			status: "completed",
		});
		// auto-QA completed → excluded by chat_thread_role
		seedSession(store, {
			execution_id: "autoqa-done",
			issue_id: "FLY-5",
			session_role: "qa",
			chat_thread_role: "main",
			status: "completed",
			session_params: JSON.stringify({
				three_stage_verdict: { status: "pass", event_id: "e5" },
			}),
		});
		// FLY-1050: a TERMINATED qa with an intent (the FLY-967 shape) is a
		// candidate too — it was silently invisible to the boot sweep pre-fix.
		seedSession(store, {
			execution_id: "terminated-with-intent",
			issue_id: "FLY-6",
			session_role: "qa",
			chat_thread_role: "qa",
			status: "terminated",
			session_params: JSON.stringify({
				three_stage_verdict: { status: "pass", event_id: "e6" },
			}),
		});
		const rows = store.getStrandedThreeStageQaPassSessions();
		expect(rows.map((r) => r.execution_id).sort()).toEqual([
			"failed-with-intent",
			"stranded",
			"terminated-with-intent",
		]);
	});
});

describe("getLatestQaResultEventForExecution (FLY-859 sweep a)", () => {
	it("returns the latest stored qa_result event with parsed payload", async () => {
		const store = await freshStore();
		seedSession(store, {
			execution_id: "qa-1",
			issue_id: "FLY-1",
			chat_thread_role: "qa",
		});
		store.insertEvent({
			event_id: "ev-old",
			execution_id: "qa-1",
			issue_id: "FLY-1",
			project_name: "flywheel",
			event_type: "qa_result",
			payload: { status: "fail", summary: "first" },
			source: "test",
		});
		store.insertEvent({
			event_id: "ev-new",
			execution_id: "qa-1",
			issue_id: "FLY-1",
			project_name: "flywheel",
			event_type: "qa_result",
			payload: { status: "pass", summary: "second" },
			source: "test",
		});
		// unrelated event type is ignored
		store.insertEvent({
			event_id: "ev-other",
			execution_id: "qa-1",
			issue_id: "FLY-1",
			project_name: "flywheel",
			event_type: "session_completed",
			payload: {},
			source: "test",
		});
		const latest = store.getLatestQaResultEventForExecution("qa-1");
		expect(latest?.eventId).toBe("ev-new");
		expect(latest?.payload).toMatchObject({ status: "pass" });
	});

	it("returns undefined when no qa_result event exists", async () => {
		const store = await freshStore();
		expect(store.getLatestQaResultEventForExecution("nope")).toBeUndefined();
	});
});
