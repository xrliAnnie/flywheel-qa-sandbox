import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commDbPathForProject } from "../commdb-path.js";
import {
	type ProjectRuntime,
	RetryDispatcher,
	RunDispatcher,
} from "../run-dispatcher.js";
import { RunnerAdmissionController } from "../runner-admission.js";

describe("FLY-1066 A3 pre-registration cleanup audit", () => {
	let commDir: string;

	beforeEach(() => {
		commDir = mkdtempSync(join(tmpdir(), "fly1066-pre-registration-"));
		process.env.FLYWHEEL_COMM_DIR = commDir;
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		delete process.env.FLYWHEEL_COMM_DIR;
		rmSync(commDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	function runtimeWith(
		result: { success: false; error: string; sessionId?: string } | Error,
	): ProjectRuntime {
		return {
			blueprint: {
				run: vi.fn(async () => {
					if (result instanceof Error) throw result;
					return result;
				}),
			} as unknown as ProjectRuntime["blueprint"],
			projectRoot: "/tmp/fly1066",
			tmuxSessionName: "runner-fly1066",
		};
	}

	it.each([
		["resolved without sessionId", { success: false, error: "spawn failed" }],
		["rejected promise", new Error("spawn rejected")],
	] as const)(
		"fresh start %s removes its pending CommDB row",
		async (_name, result) => {
			const dispatcher = new RunDispatcher(
				new Map([["proj", runtimeWith(result)]]),
				[],
				RunnerAdmissionController.alwaysAdmit(),
			);
			const { executionId } = await dispatcher.start({
				issueId: "FLY-1066",
				projectName: "proj",
			});
			await dispatcher.drain();

			const db = new CommDB(commDbPathForProject("proj"));
			expect(db.getSession(executionId)).toBeUndefined();
			db.close();
		},
	);

	it.each([
		["resolved without sessionId", { success: false, error: "spawn failed" }],
		["rejected promise", new Error("spawn rejected")],
	] as const)(
		"retry %s removes its pending CommDB row",
		async (_name, result) => {
			const dispatcher = new RetryDispatcher(
				new Map([["proj", runtimeWith(result)]]),
				[],
			);
			const { newExecutionId } = await dispatcher.dispatch({
				oldExecutionId: "old-exec",
				issueId: "FLY-1066",
				projectName: "proj",
				runAttempt: 2,
			});
			await dispatcher.drain();

			const db = new CommDB(commDbPathForProject("proj"));
			expect(db.getSession(newExecutionId)).toBeUndefined();
			db.close();
		},
	);

	it("preserves a registration when the failed result proves self-registration", async () => {
		const dispatcher = new RunDispatcher(
			new Map([
				[
					"proj",
					runtimeWith({
						success: false,
						error: "runner reported failure",
						sessionId: "runner-session",
					}),
				],
			]),
			[],
			RunnerAdmissionController.alwaysAdmit(),
		);
		const { executionId } = await dispatcher.start({
			issueId: "FLY-1066",
			projectName: "proj",
		});
		await dispatcher.drain();

		const db = new CommDB(commDbPathForProject("proj"));
		expect(db.getSession(executionId)).toBeDefined();
		db.close();
	});
});
