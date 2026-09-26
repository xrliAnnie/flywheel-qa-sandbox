/**
 * FLY-493 (Codex R2 #1 defense-in-depth): sendRunnerWake must SKIP a
 * no-transport (antigravity) session — it has no mailbox, so routing a wake to
 * the env-default claude mailbox would report a misleading success. The guard
 * short-circuits BEFORE touching the CommDB and records honest telemetry.
 */
import type { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../../StateStore.js";
import { sendRunnerWake } from "../runner-wake.js";

// A CommDB stub that THROWS if any method is called — proves the guard returns
// before any mailbox interaction for a no-transport session.
const throwingDb = new Proxy(
	{},
	{
		get() {
			throw new Error("CommDB must NOT be touched for a no-transport wake");
		},
	},
) as unknown as CommDB;

describe("sendRunnerWake — FLY-493 no-transport guard", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});
	afterEach(() => {
		store.close();
	});

	it("antigravity-tmux session → SKIP wake, record runner_wake_no_transport, never touch CommDB", async () => {
		store.upsertSession({
			execution_id: "exec-agy",
			issue_id: "issue-agy",
			project_name: "flywheel",
			status: "approved_to_ship",
			adapter_type: "antigravity-tmux",
		});

		await expect(
			sendRunnerWake(
				store,
				throwingDb,
				"exec-agy",
				{ issue_id: "issue-agy", project_name: "flywheel" },
				"approval_wake",
			),
		).resolves.toBeUndefined();

		const events = store.getEventsByExecution("exec-agy");
		expect(
			events.some((e) => e.event_type === "runner_wake_no_transport"),
		).toBe(true);
		// No misleading wake-failure either:
		expect(events.some((e) => e.event_type === "runner_wake_failed")).toBe(
			false,
		);
	});

	it("kimi-tmux session → SKIP wake, record runner_wake_no_transport, never touch CommDB (FLY-494)", async () => {
		store.upsertSession({
			execution_id: "exec-kimi",
			issue_id: "issue-kimi",
			project_name: "flywheel",
			status: "approved_to_ship",
			adapter_type: "kimi-tmux",
		});

		await expect(
			sendRunnerWake(
				store,
				throwingDb,
				"exec-kimi",
				{ issue_id: "issue-kimi", project_name: "flywheel" },
				"approval_wake",
			),
		).resolves.toBeUndefined();

		const events = store.getEventsByExecution("exec-kimi");
		expect(
			events.some((e) => e.event_type === "runner_wake_no_transport"),
		).toBe(true);
		expect(events.some((e) => e.event_type === "runner_wake_failed")).toBe(
			false,
		);
	});

	it("claude-tmux session is NOT skipped by the no-transport guard (proceeds to wake path)", async () => {
		store.upsertSession({
			execution_id: "exec-claude",
			issue_id: "issue-claude",
			project_name: "flywheel",
			status: "approved_to_ship",
			adapter_type: "claude-tmux",
		});

		// A claude session passes the guard and reaches the real wake path; with
		// the throwing stub that surfaces as a recorded wake failure (NOT the
		// no-transport skip). Either way it must NOT record no_transport.
		await sendRunnerWake(
			store,
			throwingDb,
			"exec-claude",
			{ issue_id: "issue-claude", project_name: "flywheel" },
			"approval_wake",
		).catch(() => {});

		const events = store.getEventsByExecution("exec-claude");
		expect(
			events.some((e) => e.event_type === "runner_wake_no_transport"),
		).toBe(false);
	});
});
