import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { WORKFLOW_TRANSITIONS, WorkflowFSM } from "flywheel-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { activateHolderForWake } from "../holder-wake-activation.js";

describe("FLY-1374 holder wake activation", () => {
	let dir: string;
	let store: StateStore;
	let commDbPath: string;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "fly1374-activation-"));
		store = await StateStore.create(":memory:");
		commDbPath = join(dir, "comm.db");
	});

	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	function seed(status: string) {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "FLY-1374",
			project_name: "flywheel",
			status,
			adapter_type: "codex-tmux",
			session_role: "implement",
			chat_thread_role: "implement",
		});
		return store.getSession("exec-1")!;
	}

	function deps() {
		const transitions: string[] = [];
		return {
			transitions,
			input: {
				transitionOpts: {
					store,
					fsm: new WorkflowFSM(WORKFLOW_TRANSITIONS),
					onTransition: (_executionId: string, targetStatus: string) =>
						transitions.push(targetStatus),
				},
				openCommDb: () => new CommDB(commDbPath),
				resolveLeadId: () => "flywheel-eng-lead",
				resolveVendor: () => "codex",
				discoverTmuxTarget: vi.fn(async () => ({
					kind: "found" as const,
					tmuxWindow: "flywheel:@42",
				})),
				probeDiscoveredTarget: vi.fn(async () => "alive" as const),
			},
		};
	}

	it("revives awaiting_review through legal edges and emits display hooks at each write", async () => {
		const session = seed("awaiting_review");
		const comm = new CommDB(commDbPath);
		comm.registerSession(
			"exec-1",
			"flywheel:@42",
			"flywheel",
			"FLY-1374",
			"flywheel-eng-lead",
			"codex",
		);
		comm.updateSessionStatus("exec-1", "completed");
		comm.close();
		const h = deps();

		await expect(
			activateHolderForWake(h.input, {
				session,
				cause: "qa_fail",
			}),
		).resolves.toEqual({ ok: true });

		expect(store.getSession("exec-1")?.status).toBe("running");
		expect(h.transitions).toEqual(["ship_parked", "running"]);
		const read = new CommDB(commDbPath);
		expect(read.getSession("exec-1")?.status).toBe("running");
		read.close();
		expect(h.input.discoverTmuxTarget).not.toHaveBeenCalled();
		expect(h.input.probeDiscoveredTarget).toHaveBeenCalledWith("flywheel:@42");
	});

	it("repairs a missing CommDB row only from one discovered live window and revives design", async () => {
		const session = seed("design_done");
		const h = deps();

		await expect(
			activateHolderForWake(h.input, {
				session,
				cause: "workflow_rework",
			}),
		).resolves.toEqual({ ok: true });

		expect(h.input.discoverTmuxTarget).toHaveBeenCalledWith("exec-1");
		expect(h.input.probeDiscoveredTarget).toHaveBeenCalledWith("flywheel:@42");
		expect(store.getSession("exec-1")?.status).toBe("running");
		expect(h.transitions).toEqual(["running"]);
		const read = new CommDB(commDbPath);
		expect(read.getSession("exec-1")).toMatchObject({
			status: "running",
			tmux_window: "flywheel:@42",
		});
		read.close();
	});

	it("repairs a :pending CommDB row from discovered immutable identity before wake", async () => {
		const session = seed("design_done");
		const comm = new CommDB(commDbPath);
		comm.registerSession(
			"exec-1",
			"flywheel:pending",
			"flywheel",
			"FLY-1374",
			"flywheel-eng-lead",
			"codex",
			true,
		);
		comm.updateSessionStatus("exec-1", "completed");
		comm.close();
		const h = deps();

		await expect(
			activateHolderForWake(h.input, { session, cause: "workflow_rework" }),
		).resolves.toEqual({ ok: true });
		expect(h.input.discoverTmuxTarget).toHaveBeenCalledWith("exec-1");
		expect(h.input.probeDiscoveredTarget).toHaveBeenCalledWith("flywheel:@42");
		const read = new CommDB(commDbPath);
		expect(read.getSession("exec-1")?.tmux_window).toBe("flywheel:@42");
		read.close();
	});

	it.each(["missing", "ambiguous", "indeterminate"] as const)(
		"holds a %s discovered target without status writes",
		async (kind) => {
			const session = seed("design_done");
			const h = deps();
			h.input.discoverTmuxTarget.mockResolvedValue({ kind });

			await expect(
				activateHolderForWake(h.input, {
					session,
					cause: "workflow_rework",
				}),
			).resolves.toEqual({
				ok: false,
				error: `commdb_session_target_${kind}`,
			});
			expect(store.getSession("exec-1")?.status).toBe("design_done");
			expect(h.transitions).toEqual([]);
			expect(h.input.probeDiscoveredTarget).not.toHaveBeenCalled();
		},
	);

	it("holds a discovered dead target without status writes", async () => {
		const session = seed("design_done");
		const first = deps();
		first.input.probeDiscoveredTarget.mockResolvedValue("dead_pin");
		await expect(
			activateHolderForWake(first.input, {
				session,
				cause: "workflow_rework",
			}),
		).resolves.toEqual({
			ok: false,
			error: "persisted_target_not_alive:dead_pin",
		});
		expect(store.getSession("exec-1")?.status).toBe("design_done");
		expect(first.transitions).toEqual([]);
	});

	it("never revives an authority-bearing target", async () => {
		seed("design_done");
		store.forceStatus("exec-1", "approved_to_ship", new Date().toISOString());
		const approved = deps();
		await expect(
			activateHolderForWake(approved.input, {
				session: store.getSession("exec-1")!,
				cause: "phase_retest",
			}),
		).resolves.toEqual({
			ok: false,
			error: "state_not_revivable:approved_to_ship",
		});
		expect(approved.transitions).toEqual([]);
	});
});
