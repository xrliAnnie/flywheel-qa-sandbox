import { WORKFLOW_TRANSITIONS, WorkflowFSM } from "flywheel-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplyTransitionOpts } from "../../applyTransition.js";
import { StateStore } from "../../StateStore.js";
import {
	evaluatePaneLossEvidence,
	type PaneLossReconcileDeps,
	persistPaneLossGenerationCredential,
	reconcilePaneLoss,
} from "../pane-loss-reconcile.js";

const NOW_MS = Date.parse("2026-08-04T12:00:00Z");
const GENERATION = {
	socket_path: "/tmp/tmux-501/default",
	server_start_time: "1722700000",
};

describe("pane-loss reconciler (FLY-1628)", () => {
	let store: StateStore;
	let transitionOpts: ApplyTransitionOpts;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		transitionOpts = {
			store,
			fsm: new WorkflowFSM(WORKFLOW_TRANSITIONS),
		};
	});
	afterEach(() => store.close());

	function seed(
		executionId: string,
		opts: {
			status?: string;
			adapterType?: string | null;
			generation?: boolean;
		} = {},
	): void {
		store.upsertSession({
			execution_id: executionId,
			issue_id: `issue-${executionId}`,
			project_name: "flywheel",
			status: opts.status ?? "running",
			started_at: "2026-08-04 11:00:00",
			...(opts.adapterType !== null && {
				adapter_type: opts.adapterType ?? "claude-tmux",
			}),
		});
		if (opts.generation !== false) {
			store.setSessionParams(executionId, {
				pane_loss_generation: GENERATION,
			});
		}
	}

	function deps(
		overrides: Partial<PaneLossReconcileDeps> = {},
	): PaneLossReconcileDeps {
		return {
			store,
			transitionOpts,
			mutate: true,
			nowMs: () => NOW_MS,
			preflight: vi.fn(async () => "ran"),
			fence: vi.fn(() => "ran"),
			lookupTarget: vi.fn(() => ({
				kind: "found",
				target: {
					tmuxWindow: "runner-flywheel:@42",
					sessionName: "runner-flywheel",
				},
			})),
			probeRunner: vi.fn(async () => "absent"),
			discoverTarget: vi.fn(async () => ({ kind: "missing" })),
			probeServerGeneration: vi.fn(async () => ({
				kind: "found",
				startTime: "1722700001",
			})),
			isCompleteMarkerPending: vi.fn(() => false),
			notify: vi.fn(async () => true),
			...overrides,
		};
	}

	it("pure evidence only authorizes running legacy/claude rows with proven superseded generation", () => {
		expect(
			evaluatePaneLossEvidence({
				status: "running",
				adapterType: undefined,
				body: "absent",
				generation: "superseded",
			}),
		).toEqual({ action: "fail", notificationClass: "settlement" });
		expect(
			evaluatePaneLossEvidence({
				status: "running",
				adapterType: "codex-tmux",
				body: "absent",
				generation: "superseded",
			}),
		).toEqual({ action: "advisory", notificationClass: "advisory_codex" });
		expect(
			evaluatePaneLossEvidence({
				status: "running",
				adapterType: "antigravity-tmux",
				body: "absent",
				generation: "superseded",
			}),
		).toEqual({ action: "keep" });
		expect(
			evaluatePaneLossEvidence({
				status: "running",
				adapterType: "claude-tmux",
				body: "alive",
				generation: "superseded",
			}),
		).toEqual({ action: "keep" });
	});

	it("launch credential writer merges existing params and refuses missing/terminal rows", () => {
		seed("launching", { generation: false });
		store.setSessionParams("launching", { preserved: "yes" });
		persistPaneLossGenerationCredential(store, "launching", {
			windowId: "@42",
			socketPath: GENERATION.socket_path,
			serverStartTime: GENERATION.server_start_time,
			executionId: "launching",
		});
		expect(store.getSessionParams("launching")).toEqual({
			preserved: "yes",
			pane_loss_generation: {
				...GENERATION,
				window_id: "@42",
				execution_id: "launching",
			},
		});
		expect(() =>
			persistPaneLossGenerationCredential(store, "missing", {
				windowId: "@43",
				socketPath: GENERATION.socket_path,
				serverStartTime: GENERATION.server_start_time,
				executionId: "missing",
			}),
		).toThrow(/not registered/);
		store.upsertSession({
			execution_id: "terminal",
			issue_id: "issue-terminal",
			project_name: "flywheel",
			status: "failed",
		});
		expect(() =>
			persistPaneLossGenerationCredential(store, "terminal", {
				windowId: "@44",
				socketPath: GENERATION.socket_path,
				serverStartTime: GENERATION.server_start_time,
				executionId: "terminal",
			}),
		).toThrow(/terminal/);
	});

	it("moves a proven superseded running Claude body to failed and emits a settlement proposal", async () => {
		seed("lost-running");
		const d = deps();

		const result = await reconcilePaneLoss("flywheel", d);

		expect(result).toMatchObject({ face: "ran", failed: 1 });
		expect(store.getSession("lost-running")?.status).toBe("failed");
		expect(store.getSession("lost-running")?.last_error).toMatch(/^pane_loss:/);
		expect(d.notify).toHaveBeenCalledWith(
			expect.objectContaining({ execution_id: "lost-running" }),
			"settlement",
			expect.any(String),
		);
		expect(
			store
				.getEventsByExecution("lost-running")
				.some((event) => event.event_id === "pane-loss-lost-running"),
		).toBe(true);
	});

	it("keeps parked and same-generation rows active, with class-specific truthful advisory debt", async () => {
		seed("parked-lost", { status: "ship_parked" });
		seed("same-generation");
		store.setSessionParams("same-generation", {
			pane_loss_generation: {
				...GENERATION,
				socket_path: "/tmp/tmux-501/same",
			},
		});
		const d = deps({
			probeServerGeneration: vi.fn(async (socketPath: string) => ({
				kind: "found" as const,
				startTime:
					socketPath === "/tmp/tmux-501/same" ? "1722700000" : "1722700001",
			})),
		});

		await reconcilePaneLoss("flywheel", d);

		expect(store.getSession("parked-lost")?.status).toBe("ship_parked");
		expect(store.getSession("same-generation")?.status).toBe("running");
		expect(d.notify).toHaveBeenCalledWith(
			expect.objectContaining({ execution_id: "parked-lost" }),
			"advisory_generation_superseded",
			undefined,
		);
		expect(d.notify).toHaveBeenCalledWith(
			expect.objectContaining({ execution_id: "same-generation" }),
			"advisory_absence_unproven",
			undefined,
		);
	});

	it.each(["alive", "dead_pin", "indeterminate"] as const)(
		"keeps a target whose runner probe is %s",
		async (body) => {
			seed(`body-${body}`);
			const d = deps({ probeRunner: vi.fn(async () => body) });

			const result = await reconcilePaneLoss("flywheel", d);

			expect(result.kept).toBe(1);
			expect(store.getSession(`body-${body}`)?.status).toBe("running");
			expect(d.discoverTarget).not.toHaveBeenCalled();
			expect(d.notify).not.toHaveBeenCalled();
		},
	);

	it("re-probes a rediscovered target and preserves the live runner", async () => {
		seed("rediscovered");
		const probeRunner = vi
			.fn()
			.mockResolvedValueOnce("absent")
			.mockResolvedValueOnce("alive");
		const d = deps({
			probeRunner,
			discoverTarget: vi.fn(async () => ({
				kind: "found" as const,
				tmuxWindow: "runner-flywheel:@99",
			})),
		});

		await reconcilePaneLoss("flywheel", d);

		expect(probeRunner).toHaveBeenNthCalledWith(2, "runner-flywheel:@99");
		expect(store.getSession("rediscovered")?.status).toBe("running");
		expect(d.notify).not.toHaveBeenCalled();
	});

	it("fails closed when the credential socket generation cannot be read", async () => {
		seed("generation-indeterminate");
		const d = deps({
			probeServerGeneration: vi.fn(async () => ({
				kind: "indeterminate" as const,
			})),
		});

		await reconcilePaneLoss("flywheel", d);

		expect(store.getSession("generation-indeterminate")?.status).toBe(
			"running",
		);
		expect(store.getEventsByExecution("generation-indeterminate")).toEqual([]);
		expect(d.notify).not.toHaveBeenCalled();
	});

	it("keeps a missing-credential advisory quiet during launch grace", async () => {
		seed("new-unstamped", { generation: false });
		store.upsertSession({
			execution_id: "new-unstamped",
			issue_id: "issue-new-unstamped",
			project_name: "flywheel",
			status: "running",
			started_at: "2026-08-04 11:55:00",
			adapter_type: "claude-tmux",
		});
		const d = deps();

		await reconcilePaneLoss("flywheel", d);

		expect(store.getEventsByExecution("new-unstamped")).toEqual([]);
		expect(d.notify).not.toHaveBeenCalled();
	});

	it("keeps a Codex advisory quiet during launch grace", async () => {
		seed("new-codex", { generation: false });
		store.upsertSession({
			execution_id: "new-codex",
			issue_id: "issue-new-codex",
			project_name: "flywheel",
			status: "running",
			started_at: "2026-08-04 11:55:00",
			adapter_type: "codex-tmux",
		});
		const d = deps();

		await reconcilePaneLoss("flywheel", d);

		expect(store.getEventsByExecution("new-codex")).toEqual([]);
		expect(d.notify).not.toHaveBeenCalled();
	});

	it("skips a candidate owned by a pending complete marker", async () => {
		seed("marker-owned");
		const d = deps({ isCompleteMarkerPending: vi.fn(() => true) });

		await reconcilePaneLoss("flywheel", d);

		expect(d.lookupTarget).not.toHaveBeenCalled();
		expect(store.getSession("marker-owned")?.status).toBe("running");
	});

	it("skips the entire face when the server-loss owner has not yielded", async () => {
		seed("owner-held");
		const d = deps({ preflight: vi.fn(async () => "skipped_episode") });

		const result = await reconcilePaneLoss("flywheel", d);

		expect(result).toMatchObject({ face: "skipped_episode", scanned: 0 });
		expect(d.lookupTarget).not.toHaveBeenCalled();
	});

	it("refuses mutation when the exact CommDB target changes before the fence", async () => {
		seed("retargeted");
		const lookupTarget = vi.fn(() => ({
			kind: "found" as const,
			target: {
				tmuxWindow: "runner-flywheel:@42",
				sessionName: "runner-flywheel",
			},
		}));
		const d = deps({
			lookupTarget,
			probeServerGeneration: vi.fn(async () => {
				lookupTarget.mockReturnValue({ kind: "gone" });
				return { kind: "found", startTime: "1722700001" } as const;
			}),
		});

		await reconcilePaneLoss("flywheel", d);

		expect(store.getSession("retargeted")?.status).toBe("running");
		expect(d.notify).not.toHaveBeenCalled();
	});

	it("retries settlement notification debt after transition delivery fails", async () => {
		seed("notify-debt");
		const notify = vi
			.fn()
			.mockResolvedValueOnce(false)
			.mockResolvedValueOnce(true);
		const d = deps({ notify });

		await reconcilePaneLoss("flywheel", d);
		await reconcilePaneLoss("flywheel", d);

		expect(store.getSession("notify-debt")?.status).toBe("failed");
		expect(notify).toHaveBeenCalledTimes(2);
		expect(
			store
				.getEventsByExecution("notify-debt")
				.filter((event) => event.event_type === "runner_pane_loss_notified"),
		).toHaveLength(1);
	});

	it("the zero-await fence refuses a credential race after the final generation probe", async () => {
		seed("raced");
		const d = deps({
			probeServerGeneration: vi.fn(async () => {
				store.setSessionParams("raced", {
					pane_loss_generation: {
						...GENERATION,
						server_start_time: "changed-before-fence",
					},
				});
				return { kind: "found", startTime: "1722700001" } as const;
			}),
		});

		await reconcilePaneLoss("flywheel", d);

		expect(store.getSession("raced")?.status).toBe("running");
		expect(d.notify).not.toHaveBeenCalled();
	});

	it("mutate=false performs evidence reads but no transitions, events, or notifications", async () => {
		seed("dry-run");
		const d = deps({ mutate: false });

		const result = await reconcilePaneLoss("flywheel", d);

		expect(result).toMatchObject({ scanned: 1, failed: 1, advisories: 0 });
		expect(store.getSession("dry-run")?.status).toBe("running");
		expect(store.getEventsByExecution("dry-run")).toEqual([]);
		expect(d.notify).not.toHaveBeenCalled();
	});
});
