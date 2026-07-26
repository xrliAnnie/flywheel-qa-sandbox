import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../../StateStore.js";
import { projectWorkflowEngineParkOutbox } from "../workflow-engine-park-projector.js";

const EVENT = {
	projectName: "flywheel",
	executionId: "exec-1448",
	runId: "run-1448",
	nodeId: "implement",
	attempt: 1,
	activationId: "activation-1",
	reason: "test",
} as const;

describe("workflow engine park projector", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("projects open then clear events and survives projector restart", async () => {
		const dir = mkdtempSync(join(tmpdir(), "engine-park-"));
		dirs.push(dir);
		const dbPath = join(dir, "comm.db");
		new CommDB(dbPath).close();
		const store = await StateStore.create(":memory:");
		store.appendWorkflowEngineParkEvent({
			...EVENT,
			eventId: "open-1",
			event: "park_opened",
		});

		const deps = {
			store,
			projectNames: ["flywheel"],
			commDbPathForProject: () => dbPath,
		};
		expect(await projectWorkflowEngineParkOutbox(deps)).toBe(1);
		let db = new CommDB(dbPath);
		expect(db.getWorkflowEnginePark("exec-1448")).toMatchObject({
			state: "open",
			generation: 1,
		});
		db.close();

		store.appendWorkflowEngineParkEvent({
			...EVENT,
			eventId: "clear-1",
			event: "park_cleared",
		});
		expect(await projectWorkflowEngineParkOutbox(deps)).toBe(1);
		expect(await projectWorkflowEngineParkOutbox(deps)).toBe(0);
		db = new CommDB(dbPath);
		expect(db.getWorkflowEnginePark("exec-1448")).toMatchObject({
			state: "cleared",
			generation: 2,
		});
		db.close();
	});

	it("does not let a delayed older open resurrect a newer clear", () => {
		const db = new CommDB(":memory:");
		db.applyWorkflowEngineParkEvents("flywheel", [
			{
				row_id: 1,
				event_id: "clear",
				execution_id: "exec-1448",
				run_id: "run-1448",
				node_id: "implement",
				attempt: 2,
				activation_id: "activation-2",
				generation: 2,
				event: "park_cleared",
				reason: "resume",
				created_at: "2026-07-24T00:00:00.000Z",
			},
			{
				row_id: 2,
				event_id: "late-open",
				execution_id: "exec-1448",
				run_id: "run-1448",
				node_id: "implement",
				attempt: 1,
				activation_id: "activation-1",
				generation: 1,
				event: "park_opened",
				reason: "late",
				created_at: "2026-07-24T00:00:01.000Z",
			},
		]);

		expect(db.getWorkflowEnginePark("exec-1448")).toMatchObject({
			state: "cleared",
			generation: 2,
			activation_id: "activation-2",
		});
		db.close();
	});
});
