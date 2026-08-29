import { describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

/**
 * FLY-939 (G-A2): getStrandedImplementPhaseSessions — implement rows stranded at
 * awaiting_review with the three-stage chat_thread_role='implement' marker. The
 * startup reconcile re-drives their lost implement→QA handoff.
 */
async function freshStore(): Promise<StateStore> {
	return StateStore.create(":memory:");
}
function seed(
	store: StateStore,
	o: {
		execution_id: string;
		issue_id?: string;
		status?: string;
		session_role?: string;
		chat_thread_role?: string;
	},
): void {
	store.upsertSession({
		execution_id: o.execution_id,
		issue_id: o.issue_id ?? "FLY-939",
		project_name: "flywheel",
		status: o.status ?? "running",
		session_role: o.session_role,
		chat_thread_role: o.chat_thread_role,
	});
}

describe("getStrandedImplementPhaseSessions (FLY-939 G-A2)", () => {
	it("matches implement + awaiting_review + chat_thread_role='implement'", async () => {
		const store = await freshStore();
		seed(store, {
			execution_id: "hit",
			session_role: "implement",
			chat_thread_role: "implement",
			status: "awaiting_review",
		});
		const rows = store.getStrandedImplementPhaseSessions();
		expect(rows.map((r) => r.execution_id)).toEqual(["hit"]);
	});

	it("excludes single-session ('main') awaiting_review implement rows", async () => {
		const store = await freshStore();
		seed(store, {
			execution_id: "main-impl",
			session_role: "implement",
			chat_thread_role: "main",
			status: "awaiting_review",
		});
		expect(store.getStrandedImplementPhaseSessions()).toHaveLength(0);
	});

	it("excludes other statuses (running / completed) and other roles (design/qa)", async () => {
		const store = await freshStore();
		seed(store, {
			execution_id: "running",
			session_role: "implement",
			chat_thread_role: "implement",
			status: "running",
		});
		seed(store, {
			execution_id: "done",
			session_role: "implement",
			chat_thread_role: "implement",
			status: "completed",
		});
		seed(store, {
			execution_id: "design",
			session_role: "design",
			chat_thread_role: "design",
			status: "awaiting_review",
		});
		seed(store, {
			execution_id: "qa",
			session_role: "qa",
			chat_thread_role: "qa",
			status: "awaiting_review",
		});
		expect(store.getStrandedImplementPhaseSessions()).toHaveLength(0);
	});
});
