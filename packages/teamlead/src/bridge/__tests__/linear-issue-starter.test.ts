import { afterEach, describe, expect, it, vi } from "vitest";
import {
	makeLinearIssueStarter,
	markLinearIssueStarted,
} from "../linear-issue-starter.js";

describe("markLinearIssueStarted", () => {
	it.each(["backlog", "unstarted"])(
		"moves a %s issue with no startedAt to the lowest-position started state",
		async (initialType) => {
			const states = [
				{ id: initialType, name: initialType, type: initialType, position: 0 },
				{ id: "review", name: "In Review", type: "started", position: 3 },
				{ id: "progress", name: "In Progress", type: "started", position: 2 },
			];
			let current = states[0]!;
			const client = {
				issue: vi.fn(async () => ({
					startedAt:
						current.type === "started"
							? new Date("2026-09-04T19:00:00.000Z")
							: null,
					state: Promise.resolve(current),
					team: Promise.resolve({
						states: vi.fn(async () => ({ nodes: states })),
					}),
				})),
				updateIssue: vi.fn(
					async (_issueId: string, input: { stateId: string }) => {
						current = states.find((state) => state.id === input.stateId)!;
						return { success: true };
					},
				),
			};

			const result = await markLinearIssueStarted(client, "issue-1");

			expect(result).toMatchObject({ started: true, outcome: "started" });
			expect(client.updateIssue).toHaveBeenCalledWith("issue-1", {
				stateId: "progress",
			});
		},
	);

	it("reads each SDK state getter exactly once", async () => {
		const states = [
			{ id: "backlog", name: "Backlog", type: "backlog", position: 0 },
			{ id: "progress", name: "In Progress", type: "started", position: 1 },
		];
		let current = states[0]!;
		let stateReads = 0;
		const client = {
			issue: vi.fn(async () => ({
				startedAt:
					current.type === "started"
						? new Date("2026-09-04T19:00:00.000Z")
						: null,
				get state() {
					stateReads += 1;
					return Promise.resolve(current);
				},
				team: Promise.resolve({
					states: vi.fn(async () => ({ nodes: states })),
				}),
			})),
			updateIssue: vi.fn(
				async (_issueId: string, input: { stateId: string }) => {
					current = states.find((state) => state.id === input.stateId)!;
					return { success: true };
				},
			),
		};

		await expect(
			markLinearIssueStarted(client, "issue-1"),
		).resolves.toMatchObject({
			started: true,
			outcome: "started",
		});
		expect(stateReads).toBe(3);
	});

	it.each([
		["started", "2026-09-04T19:00:00.000Z", true, "started"],
		["started", null, false, "failed"],
		["triage", null, false, "skipped_triage"],
		["canceled", null, false, "skipped_terminal"],
		["completed", null, false, "skipped_terminal"],
	] as const)(
		"zero-writes an issue whose current state is %s",
		async (type, startedAt, started, outcome) => {
			const client = {
				issue: vi.fn(async () => ({
					startedAt,
					state: Promise.resolve({ id: type, name: type, type }),
					team: Promise.resolve({
						states: vi.fn(async () => ({ nodes: [] })),
					}),
				})),
				updateIssue: vi.fn(),
			};

			await expect(
				markLinearIssueStarted(client, "issue-1"),
			).resolves.toMatchObject({ started, outcome });
			expect(client.updateIssue).not.toHaveBeenCalled();
		},
	);

	it("does not overwrite a terminal state that appears before the mutation", async () => {
		const backlog = { id: "backlog", name: "Backlog", type: "backlog" };
		const canceled = { id: "canceled", name: "Canceled", type: "canceled" };
		const issue = vi
			.fn()
			.mockResolvedValueOnce({
				startedAt: null,
				state: Promise.resolve(backlog),
				team: Promise.resolve({
					states: vi.fn(async () => ({
						nodes: [
							{
								id: "progress",
								name: "In Progress",
								type: "started",
								position: 1,
							},
						],
					})),
				}),
			})
			.mockResolvedValue({
				startedAt: null,
				state: Promise.resolve(canceled),
				team: Promise.resolve(undefined),
			});
		const client = { issue, updateIssue: vi.fn() };

		await expect(
			markLinearIssueStarted(client, "issue-1"),
		).resolves.toMatchObject({ started: false, outcome: "skipped_terminal" });
		expect(client.updateIssue).not.toHaveBeenCalled();
	});

	it("fails closed when the fresh pre-mutation state is unreadable", async () => {
		const backlog = { id: "backlog", name: "Backlog", type: "backlog" };
		const issue = vi
			.fn()
			.mockResolvedValueOnce({
				startedAt: null,
				state: Promise.resolve(backlog),
				team: Promise.resolve({
					states: vi.fn(async () => ({
						nodes: [{ id: "progress", name: "In Progress", type: "started" }],
					})),
				}),
			})
			.mockResolvedValue({
				startedAt: null,
				state: undefined,
				team: Promise.resolve(undefined),
			});
		const client = { issue, updateIssue: vi.fn() };

		await expect(
			markLinearIssueStarted(client, "issue-1"),
		).resolves.toMatchObject({
			started: false,
			outcome: "failed",
			errorClass: "state_unreadable",
		});
		expect(client.updateIssue).not.toHaveBeenCalled();
	});

	it.each([
		["state", "state_unreadable"],
		["team", "no_team"],
		["started workflow state", "no_started_state"],
	] as const)(
		"fails closed when the issue has no readable %s",
		async (missing, errorClass) => {
			const backlog = { id: "backlog", name: "Backlog", type: "backlog" };
			const client = {
				issue: vi.fn(async () => ({
					startedAt: null,
					state: missing === "state" ? undefined : Promise.resolve(backlog),
					team:
						missing === "team"
							? Promise.resolve(undefined)
							: Promise.resolve({
									states: vi.fn(async () => ({
										nodes:
											missing === "started workflow state"
												? [backlog]
												: [
														{
															id: "progress",
															name: "In Progress",
															type: "started",
															position: 1,
														},
													],
									})),
								}),
				})),
				updateIssue: vi.fn(),
			};

			await expect(
				markLinearIssueStarted(client, "issue-1"),
			).resolves.toMatchObject({
				started: false,
				outcome: "failed",
				errorClass,
			});
			expect(client.updateIssue).not.toHaveBeenCalled();
		},
	);

	it("converts an SDK exception into a stable error class without throwing", async () => {
		const client = {
			issue: vi.fn().mockRejectedValue(new TypeError("sensitive request body")),
			updateIssue: vi.fn(),
		};

		await expect(
			markLinearIssueStarted(client, "issue-1"),
		).resolves.toMatchObject({
			started: false,
			outcome: "failed",
			errorClass: "TypeError",
		});
		expect(client.updateIssue).not.toHaveBeenCalled();
	});

	it("does not report success when the write leaves the issue in backlog", async () => {
		const backlog = { id: "backlog", name: "Backlog", type: "backlog" };
		const client = {
			issue: vi.fn(async () => ({
				startedAt: null,
				state: Promise.resolve(backlog),
				team: Promise.resolve({
					states: vi.fn(async () => ({
						nodes: [
							{
								id: "progress",
								name: "In Progress",
								type: "started",
								position: 1,
							},
						],
					})),
				}),
			})),
			updateIssue: vi.fn(async () => ({ success: true })),
		};

		await expect(
			markLinearIssueStarted(client, "issue-1"),
		).resolves.toMatchObject({
			started: false,
			outcome: "failed",
			errorClass: "update_not_effective",
		});
	});

	it("honors an already-aborted signal before the first SDK call", async () => {
		const controller = new AbortController();
		controller.abort();
		const client = { issue: vi.fn(), updateIssue: vi.fn() };

		await expect(
			markLinearIssueStarted(client, "issue-1", controller.signal),
		).resolves.toMatchObject({
			started: false,
			outcome: "failed",
			errorClass: "linear_start_aborted",
		});
		expect(client.issue).not.toHaveBeenCalled();
		expect(client.updateIssue).not.toHaveBeenCalled();
	});

	it("does not mutate after a delayed SDK read resolves following abort", async () => {
		const controller = new AbortController();
		let resolveIssue:
			| ((value: {
					startedAt: null;
					state: Promise<{ id: string; name: string; type: string }>;
					team: Promise<undefined>;
			  }) => void)
			| undefined;
		const delayedIssue = new Promise<{
			startedAt: null;
			state: Promise<{ id: string; name: string; type: string }>;
			team: Promise<undefined>;
		}>((resolve) => {
			resolveIssue = resolve;
		});
		const client = {
			issue: vi.fn().mockReturnValue(delayedIssue),
			updateIssue: vi.fn(),
		};
		const result = markLinearIssueStarted(client, "issue-1", controller.signal);

		controller.abort();
		resolveIssue?.({
			startedAt: null,
			state: Promise.resolve({
				id: "backlog",
				name: "Backlog",
				type: "backlog",
			}),
			team: Promise.resolve(undefined),
		});

		await expect(result).resolves.toMatchObject({
			started: false,
			outcome: "failed",
			errorClass: "linear_start_aborted",
		});
		expect(client.updateIssue).not.toHaveBeenCalled();
	});
});

describe("makeLinearIssueStarter", () => {
	afterEach(() => {
		delete process.env.FLYWHEEL_LINEAR_STARTED_SYNC;
	});

	it("is enabled by default when a Linear API key exists", () => {
		expect(makeLinearIssueStarter({ linearApiKey: "k" })).toBeInstanceOf(
			Function,
		);
	});

	it("stays enabled for kill-switch values other than the exact string 0", () => {
		process.env.FLYWHEEL_LINEAR_STARTED_SYNC = "false";
		expect(makeLinearIssueStarter({ linearApiKey: "k" })).toBeInstanceOf(
			Function,
		);
	});

	it("is disabled without an API key or when the kill switch is 0", () => {
		expect(makeLinearIssueStarter({})).toBeUndefined();
		process.env.FLYWHEEL_LINEAR_STARTED_SYNC = "0";
		expect(makeLinearIssueStarter({ linearApiKey: "k" })).toBeUndefined();
	});
});
