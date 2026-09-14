import { expect, it, vi } from "vitest";
import { ShipJudgmentScanner } from "../scanner.js";
import { bindingFixture, HEAD, NOW } from "./binding-fixture.js";

it("persists a fair fifty-card cursor and skips disabled modes, including after restart", async () => {
	const { store, db } = await bindingFixture();
	try {
		for (let i = 0; i < 55; i++) {
			const run = `scan-run-${i}`,
				question = `scan-q-${String(i).padStart(2, "0")}`;
			store.createWorkflowRun({
				runId: run,
				issueId: `FLY-${3000 + i}`,
				projectName: i === 54 ? "other" : "flywheel",
				claimsReadEnrolled: true,
			});
			db.prepare(
				`INSERT INTO workflow_gate_holder(run_id,gate_node_id,attempt,head_sha,source_execution_id,question_id,authority_mode,subject_kind,carrier_binding_state,card_message_id,state,materialization_stage,created_at,updated_at) VALUES (?,'founder_gate',1,?,'execution',?,'land','git_head','bound','123456789012345678','awaiting_review','completed',?,?)`,
			).run(run, HEAD, question, NOW, NOW);
		}
		let mode = "dry_run";
		const visited: string[] = [];
		const deps = {
			store,
			mode: () => mode,
			process: async (question: string) => {
				visited.push(question);
				if (question === "scan-q-01") throw new Error("one card failed");
			},
			onError: vi.fn(),
		};
		const scanner = new ShipJudgmentScanner(deps);
		await scanner.tick();
		expect(visited).toHaveLength(50);
		expect(deps.onError).toHaveBeenCalledWith("judgment_card_scan_failed");
		const cursor = db
			.prepare(
				"SELECT scan_cursor FROM ship_judgment_project_state WHERE project_name='flywheel'",
			)
			.get() as { scan_cursor: string };
		expect(cursor.scan_cursor).toBe(visited.at(-1));
		await scanner.stop();
		const resumed = new ShipJudgmentScanner(deps);
		await resumed.tick();
		expect(new Set(visited).size).toBe(55);
		expect(visited).not.toContain("scan-q-54");
		for (const value of ["off", "auto"]) {
			mode = value;
			visited.length = 0;
			await resumed.tick();
			expect(visited).toEqual([]);
		}
		await resumed.stop();
	} finally {
		store.close();
	}
});

it("joins ongoing work on stop and does not overlap ticks", async () => {
	const { store } = await bindingFixture();
	try {
		let finish: (() => void) | undefined;
		const process = vi.fn(
			async (_question: string, signal: AbortSignal) =>
				new Promise<void>((resolve) => {
					finish = resolve;
					signal.addEventListener("abort", resolve.bind(null, undefined), {
						once: true,
					});
				}),
		);
		const scanner = new ShipJudgmentScanner({
			store,
			mode: () => "dry_run",
			process,
		});
		const first = scanner.tick();
		const second = scanner.tick();
		expect(first).toBe(second);
		await vi.waitFor(() => expect(finish).toBeDefined());
		await scanner.stop();
		await first;
		await scanner.tick();
		expect(process).toHaveBeenCalledTimes(1);
	} finally {
		store.close();
	}
});

it("enqueues a materialized card without collecting on the caller stack and coalesces repeats", async () => {
	const { store } = await bindingFixture();
	try {
		const process = vi.fn(async () => {});
		const scanner = new ShipJudgmentScanner({
			store,
			mode: () => "dry_run",
			process,
		});
		scanner.enqueue("q");
		scanner.enqueue("q");
		expect(process).not.toHaveBeenCalled();
		await scanner.tick();
		expect(process).toHaveBeenCalledTimes(1);
		await scanner.stop();
		scanner.enqueue("q");
		await scanner.tick();
		expect(process).toHaveBeenCalledTimes(1);
	} finally {
		store.close();
	}
});
