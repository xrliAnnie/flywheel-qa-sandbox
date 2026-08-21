import {
	type PatrolTurnJudgmentSnapshot,
	patrolJudgmentFingerprint,
} from "flywheel-comm/db";
import { describe, expect, it } from "vitest";
import {
	collectPatrolLoopEntries,
	judgeLoopLight,
	PATROL_RED_MIN_WAIT_MS,
	type PatrolLoopFacts,
	type PatrolLoopStore,
	toPatrolLoopEntry,
} from "../bridge/patrol-loop-ledger.js";

const NOW_MS = Date.parse("2026-08-20T12:00:00.000Z");

function facts(overrides: Partial<PatrolLoopFacts> = {}): PatrolLoopFacts {
	return {
		issueId: "issue-1855",
		identifier: "FLY-1855",
		nowMs: NOW_MS,
		roster: [
			{ executionId: "exec-waiter", status: "running" },
			{ executionId: "exec-holder", status: "running" },
		],
		turn: {
			issueId: "issue-1855",
			holderExecId: "exec-holder",
			phase: "qa",
			epoch: 3,
			targetRunId: "run-1",
			targetNodeId: "qa",
			targetAttempt: 1,
			activationId: "activation-holder",
		},
		waits: [
			{
				executionId: "exec-waiter",
				holderExecId: "exec-holder",
				epoch: 3,
				firstSeenAt: NOW_MS - PATROL_RED_MIN_WAIT_MS - 1,
			},
		],
		runs: [
			{
				runId: "run-1",
				status: "active",
				currentNodeId: "implement",
			},
		],
		attempts: [],
		reworkDeliveries: [],
		landOperations: [],
		wakes: [],
		gateAuthorities: [],
		sessionStatuses: [],
		parkedExecutionIds: [],
		displayWarnings: [],
		unreadableSources: [],
		fingerprintStable: true,
		...overrides,
	};
}

function factsWithProcessLiveness(
	overrides: Partial<PatrolLoopFacts>,
	processLiveness: Array<{
		executionId: string;
		state: "alive" | "dead" | "unknown";
	}>,
): PatrolLoopFacts {
	return {
		...facts(overrides),
		processLiveness,
	};
}

describe("FLY-1925 patrol loop red-light predicate", () => {
	it("marks the 1855 shape red when an aged exact TURN wait has no loop source", () => {
		expect(judgeLoopLight(facts())).toEqual({ light: "red" });
	});

	describe("QA round 3 inactive-holder loop-existence gate", () => {
		describe("must be red when no S1-S5 loop exists", () => {
			it("marks shape ④ red when the holder session is completed", () => {
				expect(
					judgeLoopLight(
						facts({
							waits: [],
							runs: [
								{
									runId: "run-1",
									status: "active",
									currentNodeId: "founder_gate",
								},
							],
							sessionStatuses: [
								{ executionId: "exec-holder", status: "completed" },
							],
						}),
					),
				).toEqual({
					light: "red",
					redCause: {
						kind: "holder_terminal_session",
						status: "completed",
					},
				});
			});

			it("marks shape E red when the holder session failed", () => {
				expect(
					judgeLoopLight(
						facts({
							waits: [],
							sessionStatuses: [
								{ executionId: "exec-holder", status: "failed" },
							],
						}),
					),
				).toEqual({
					light: "red",
					redCause: {
						kind: "holder_terminal_session",
						status: "failed",
					},
				});
			});

			it("marks shape F red without a waiter when the holder owns the terminal current attempt", () => {
				expect(
					judgeLoopLight(
						facts({
							waits: [],
							runs: [{ runId: "run-1", status: "active", currentNodeId: "qa" }],
							attempts: [
								{
									runId: "run-1",
									nodeId: "qa",
									attempt: 2,
									state: "done",
									executionId: "exec-holder",
								},
							],
						}),
					),
				).toEqual({
					light: "red",
					redCause: {
						kind: "holder_terminal_attempt",
						nodeId: "qa",
						attempt: 2,
						state: "done",
					},
				});
			});
		});

		describe("must not be red while an S1-S5 loop exists", () => {
			it("keeps shape ① green while the founder gate awaits review", () => {
				expect(
					judgeLoopLight(
						facts({
							waits: [],
							runs: [
								{
									runId: "run-1",
									status: "active",
									currentNodeId: "founder_gate",
								},
							],
							sessionStatuses: [
								{ executionId: "exec-holder", status: "completed" },
							],
							gateAuthorities: [
								{
									runId: "run-1",
									kind: "gate",
									state: "awaiting_review",
								},
							],
						}),
					),
				).toEqual({ light: "not_triggered" });
			});

			it("keeps shape ② green while a rework delivery is pending", () => {
				expect(
					judgeLoopLight(
						facts({
							waits: [],
							sessionStatuses: [
								{ executionId: "exec-holder", status: "completed" },
							],
							reworkDeliveries: [{ runId: "run-1", state: "pending" }],
						}),
					),
				).toEqual({ light: "not_triggered" });
			});

			it("keeps shape ③ green while land is running", () => {
				expect(
					judgeLoopLight(
						facts({
							waits: [],
							sessionStatuses: [
								{ executionId: "exec-holder", status: "completed" },
							],
							landOperations: [{ state: "running", supersededAt: null }],
						}),
					),
				).toEqual({ light: "not_triggered" });
			});

			it.each(["FLY-1867", "FLY-1887"])(
				"keeps the %s founder-review snapshot green",
				(identifier) => {
					expect(
						judgeLoopLight(
							facts({
								identifier,
								waits: [],
								turn: {
									...facts().turn!,
									targetNodeId: "qa",
									targetAttempt: 2,
								},
								runs: [
									{
										runId: "run-1",
										status: "active",
										currentNodeId: "founder_gate",
									},
								],
								attempts: [
									{
										runId: "run-1",
										nodeId: "qa",
										attempt: 2,
										state: "done",
										executionId: "exec-holder",
									},
								],
								sessionStatuses: [
									{ executionId: "exec-holder", status: "running" },
								],
								gateAuthorities: [
									{
										runId: "run-1",
										kind: "gate",
										state: "awaiting_review",
									},
								],
							}),
						),
					).toEqual({ light: "not_triggered" });
				},
			);
		});
	});

	it("keeps the real FLY-1925 control green when the TURN holder owns a running current attempt", () => {
		expect(
			judgeLoopLight(
				facts({
					identifier: "FLY-1925",
					roster: [
						{ executionId: "exec-waiter", status: "ship_parked" },
						{ executionId: "exec-holder", status: "running" },
					],
					turn: {
						...facts().turn!,
						targetNodeId: "qa",
						targetAttempt: 1,
					},
					runs: [{ runId: "run-1", status: "active", currentNodeId: "qa" }],
					attempts: [
						{
							runId: "run-1",
							nodeId: "qa",
							attempt: 1,
							state: "running",
							executionId: "exec-holder",
						},
					],
					parkedExecutionIds: ["exec-waiter"],
				}),
			),
		).toEqual({ light: "not_triggered" });
	});

	it.each(["failed", "blocked", "terminated", "completed", "ship_parked"])(
		"marks an active run red without a waiter when the TURN holder session is %s",
		(status) => {
			expect(
				judgeLoopLight(
					facts({
						waits: [],
						sessionStatuses: [{ executionId: "exec-holder", status }],
					}),
				),
			).toEqual({
				light: "red",
				redCause: { kind: "holder_terminal_session", status },
			});
		},
	);

	it("marks an active run red without a waiter when its TURN holder is in-roster and effectively parked", () => {
		expect(
			judgeLoopLight(facts({ waits: [], parkedExecutionIds: ["exec-holder"] })),
		).toEqual({
			light: "red",
			redCause: { kind: "holder_parked" },
		});
	});

	it("does not trust an unscoped parked declaration for an off-roster TURN holder", () => {
		expect(
			judgeLoopLight(
				facts({
					waits: [],
					roster: [{ executionId: "exec-waiter", status: "running" }],
					parkedExecutionIds: ["exec-holder"],
				}),
			),
		).toEqual({ light: "not_triggered" });
	});

	it("marks a held run red when its live TURN holder owns the terminal current attempt", () => {
		expect(
			judgeLoopLight(
				factsWithProcessLiveness(
					{
						waits: [],
						runs: [{ runId: "run-1", status: "held", currentNodeId: "qa" }],
						attempts: [
							{
								runId: "run-1",
								nodeId: "qa",
								attempt: 2,
								state: "done",
								executionId: "exec-holder",
							},
						],
					},
					[{ executionId: "exec-holder", state: "alive" }],
				),
			),
		).toEqual({
			light: "red",
			redCause: {
				kind: "holder_terminal_attempt",
				nodeId: "qa",
				attempt: 2,
				state: "done",
			},
		});
	});

	it("marks a dead TURN holder red even when its attempt ledger still says running", () => {
		expect(
			judgeLoopLight(
				factsWithProcessLiveness(
					{
						waits: [],
						runs: [{ runId: "run-1", status: "active", currentNodeId: "qa" }],
						attempts: [
							{
								runId: "run-1",
								nodeId: "qa",
								attempt: 2,
								state: "running",
								executionId: "exec-holder",
							},
						],
					},
					[{ executionId: "exec-holder", state: "dead" }],
				),
			),
		).toEqual({
			light: "red",
			redCause: { kind: "holder_process_dead" },
		});
	});

	it("fails honestly when the TURN holder process probe is indeterminate", () => {
		expect(
			judgeLoopLight(
				factsWithProcessLiveness(
					{
						waits: [],
						runs: [{ runId: "run-1", status: "active", currentNodeId: "qa" }],
						attempts: [
							{
								runId: "run-1",
								nodeId: "qa",
								attempt: 2,
								state: "running",
								executionId: "exec-holder",
							},
						],
					},
					[{ executionId: "exec-holder", state: "unknown" }],
				),
			),
		).toEqual({
			light: "unknown",
			reason: "process_liveness_unknown:exec-hol",
		});
	});

	it("marks the FLY-1934 dead wake-delivered holder shape red", () => {
		expect(
			judgeLoopLight(
				factsWithProcessLiveness(
					{
						identifier: "FLY-1934",
						waits: [],
						runs: [
							{
								runId: "ba972fa3-run",
								status: "active",
								currentNodeId: "implement",
							},
						],
						turn: {
							...facts().turn!,
							holderExecId: "e8180aee-dead-holder",
							targetRunId: "ba972fa3-run",
							targetNodeId: "implement",
							targetAttempt: 3,
						},
						attempts: [
							{
								runId: "ba972fa3-run",
								nodeId: "implement",
								attempt: 3,
								state: "running",
								executionId: "e8180aee-dead-holder",
							},
						],
						reworkDeliveries: [
							{
								runId: "ba972fa3-run",
								state: "wake_delivered",
								preferredActorExecutionId: "e8180aee-dead-holder",
							},
						],
						sessionStatuses: [
							{
								executionId: "e8180aee-dead-holder",
								status: "terminated",
							},
						],
					},
					[
						{
							executionId: "e8180aee-dead-holder",
							state: "dead",
						},
					],
				),
			),
		).toEqual({
			light: "red",
			redCause: { kind: "holder_process_dead" },
		});
	});

	it("marks the FLY-1925 held needs-lead live-idle shape red", () => {
		expect(
			judgeLoopLight(
				factsWithProcessLiveness(
					{
						identifier: "FLY-1925",
						roster: [
							{ executionId: "443d5131-qa-holder", status: "running" },
							{ executionId: "e244d9c6-implement", status: "ship_parked" },
						],
						turn: {
							...facts().turn!,
							holderExecId: "443d5131-qa-holder",
							targetRunId: "c198029f-run",
							targetNodeId: "qa",
						},
						waits: [
							{
								executionId: "e244d9c6-implement",
								holderExecId: "443d5131-qa-holder",
								epoch: 3,
								firstSeenAt: NOW_MS - PATROL_RED_MIN_WAIT_MS - 1,
							},
						],
						runs: [
							{
								runId: "c198029f-run",
								status: "held",
								currentNodeId: "qa",
							},
						],
						attempts: [
							{
								runId: "c198029f-run",
								nodeId: "qa",
								attempt: 1,
								state: "done",
								executionId: "443d5131-qa-holder",
							},
						],
						reworkDeliveries: [
							{
								runId: "c198029f-run",
								state: "needs_lead",
								preferredActorExecutionId: "e244d9c6-implement",
							},
						],
						parkedExecutionIds: ["443d5131-qa-holder", "e244d9c6-implement"],
					},
					[
						{ executionId: "443d5131-qa-holder", state: "alive" },
						{ executionId: "e244d9c6-implement", state: "alive" },
					],
				),
			),
		).toEqual({
			light: "red",
			redCause: {
				kind: "holder_terminal_attempt",
				nodeId: "qa",
				attempt: 1,
				state: "done",
			},
		});
	});

	it("does not trigger when another actor owns the terminal current attempt", () => {
		expect(
			judgeLoopLight(
				facts({
					waits: [],
					runs: [{ runId: "run-1", status: "active", currentNodeId: "qa" }],
					attempts: [
						{
							runId: "run-1",
							nodeId: "qa",
							attempt: 2,
							state: "done",
							executionId: "exec-other",
						},
					],
				}),
			),
		).toEqual({ light: "not_triggered" });
	});

	it("uses the latest current-node attempt instead of an older terminal attempt", () => {
		expect(
			judgeLoopLight(
				facts({
					waits: [],
					runs: [{ runId: "run-1", status: "active", currentNodeId: "qa" }],
					attempts: [
						{
							runId: "run-1",
							nodeId: "qa",
							attempt: 1,
							state: "done",
							executionId: "exec-holder",
						},
						{
							runId: "run-1",
							nodeId: "qa",
							attempt: 2,
							state: "running",
							executionId: "exec-holder",
						},
					],
				}),
			),
		).toEqual({ light: "not_triggered" });
	});

	it.each(["running", "rejected", "deferred", "shelved"])(
		"does not broaden holder session terminality to %s",
		(status) => {
			expect(
				judgeLoopLight(
					facts({
						waits: [],
						sessionStatuses: [{ executionId: "exec-holder", status }],
					}),
				),
			).toEqual({ light: "not_triggered" });
		},
	);

	it("does not trigger when a different actor has an active attempt", () => {
		expect(
			judgeLoopLight(
				facts({
					attempts: [
						{
							runId: "run-1",
							nodeId: "qa",
							attempt: 1,
							state: "running",
							executionId: "exec-actor",
						},
					],
				}),
			),
		).toEqual({ light: "not_triggered" });
	});

	it("does not let the blocked waiter's own active attempt suppress red", () => {
		expect(
			judgeLoopLight(
				facts({
					attempts: [
						{
							runId: "run-1",
							nodeId: "implement",
							attempt: 2,
							state: "running",
							executionId: "exec-waiter",
						},
					],
				}),
			),
		).toEqual({ light: "red" });
	});

	it("does not trigger for a fresh exact wait", () => {
		expect(
			judgeLoopLight(
				facts({
					waits: [
						{
							executionId: "exec-waiter",
							holderExecId: "exec-holder",
							epoch: 3,
							firstSeenAt: NOW_MS - PATROL_RED_MIN_WAIT_MS + 1,
						},
					],
				}),
			),
		).toEqual({ light: "not_triggered" });
	});

	it("does not trigger for a wait row whose TURN tuple is stale", () => {
		expect(
			judgeLoopLight(
				facts({
					waits: [
						{
							executionId: "exec-waiter",
							holderExecId: "old-holder",
							epoch: 2,
							firstSeenAt: NOW_MS - PATROL_RED_MIN_WAIT_MS - 1,
						},
					],
				}),
			),
		).toEqual({ light: "not_triggered" });
	});

	it("excludes an off-roster holder's self-wait attempt from S1", () => {
		expect(
			judgeLoopLight(
				facts({
					roster: [{ executionId: "exec-waiter", status: "running" }],
					waits: [
						...facts().waits,
						{
							executionId: "exec-holder",
							holderExecId: "exec-holder",
							epoch: 3,
							firstSeenAt: NOW_MS - PATROL_RED_MIN_WAIT_MS - 1,
						},
					],
					attempts: [
						{
							runId: "run-1",
							nodeId: "qa",
							attempt: 1,
							state: "running",
							executionId: "exec-holder",
						},
					],
				}),
			),
		).toEqual({ light: "red" });
	});

	it("treats an exact current-target retryable wake as a loop source", () => {
		expect(
			judgeLoopLight(
				facts({
					waits: [
						...facts().waits,
						{
							executionId: "exec-holder",
							holderExecId: "exec-holder",
							epoch: 3,
							firstSeenAt: NOW_MS - 1,
						},
					],
					attempts: [
						{
							runId: "run-1",
							nodeId: "qa",
							attempt: 1,
							state: "running",
							executionId: "exec-holder",
						},
					],
					wakes: [
						{
							issueId: "issue-1855",
							state: "sent",
							pushCount: 1,
							executionId: "exec-holder",
							epoch: 3,
							activationId: "activation-holder",
						},
					],
				}),
			),
		).toEqual({ light: "not_triggered" });
	});

	it.each([
		{
			name: "an unbound pending reservation",
			overrides: {
				attempts: [
					{
						runId: "run-1",
						nodeId: "qa",
						attempt: 1,
						state: "pending",
						executionId: null,
					},
				],
			},
		},
		{
			name: "a pending rework delivery",
			overrides: {
				reworkDeliveries: [{ runId: "run-1", state: "pending" }],
			},
		},
		{
			name: "a non-superseded land operation",
			overrides: {
				landOperations: [{ state: "held", supersededAt: null }],
			},
		},
		{
			name: "an awaiting-review gate holder",
			overrides: {
				gateAuthorities: [
					{ runId: "run-1", kind: "gate" as const, state: "awaiting_review" },
				],
			},
		},
		{
			name: "an open carrier delivery",
			overrides: {
				gateAuthorities: [
					{ runId: "run-1", kind: "carrier" as const, state: "held" },
				],
			},
		},
	])("does not trigger when the ledger has $name", ({ overrides }) => {
		expect(judgeLoopLight(facts(overrides))).toEqual({
			light: "not_triggered",
		});
	});

	it("does not count exhausted or stale-target wakes as loop sources", () => {
		const selfWait = {
			executionId: "exec-holder",
			holderExecId: "exec-holder",
			epoch: 3,
			firstSeenAt: NOW_MS - 1,
		};
		const targetAttempt = {
			runId: "run-1",
			nodeId: "qa",
			attempt: 1,
			state: "done",
			executionId: "exec-holder",
		};
		expect(
			judgeLoopLight(
				facts({
					waits: [...facts().waits, selfWait],
					attempts: [targetAttempt],
					wakes: [
						{
							issueId: "issue-1855",
							state: "sent",
							pushCount: 2,
							executionId: "exec-holder",
							epoch: 3,
							activationId: "activation-holder",
						},
					],
				}),
			),
		).toEqual({ light: "red" });
		expect(
			judgeLoopLight(
				facts({
					waits: [...facts().waits, selfWait],
					attempts: [targetAttempt],
					wakes: [
						{
							issueId: "issue-1855",
							state: "pending",
							pushCount: 0,
							executionId: "exec-holder",
							epoch: 2,
							activationId: "old-activation",
						},
					],
				}),
			),
		).toEqual({ light: "red" });
	});

	it("mirrors the legacy activation-less wake terminal-session guard", () => {
		const legacyTurn = {
			...facts().turn!,
			targetRunId: null,
			targetNodeId: null,
			targetAttempt: null,
			activationId: null,
		};
		const legacyWake = {
			issueId: "issue-1855",
			state: "pending",
			pushCount: 0,
			executionId: "exec-holder",
			epoch: 3,
			activationId: null,
		};
		expect(
			judgeLoopLight(
				facts({ turn: legacyTurn, wakes: [legacyWake], sessionStatuses: [] }),
			),
		).toEqual({ light: "not_triggered" });
		expect(
			judgeLoopLight(
				facts({
					turn: legacyTurn,
					wakes: [legacyWake],
					sessionStatuses: [
						{ executionId: "exec-holder", status: "terminated" },
					],
				}),
			),
		).toEqual({
			light: "red",
			redCause: {
				kind: "holder_terminal_session",
				status: "terminated",
			},
		});
	});

	it("fails honestly on unreadable ledgers, fingerprint drift, or ambiguous runs", () => {
		expect(judgeLoopLight(facts({ unreadableSources: ["comm_db"] }))).toEqual({
			light: "unknown",
			reason: "ledger_unreadable:comm_db",
		});
		expect(judgeLoopLight(facts({ fingerprintStable: false }))).toEqual({
			light: "unknown",
			reason: "turn_tuple_moved",
		});
		expect(
			judgeLoopLight(
				facts({
					runs: [
						...facts().runs,
						{
							runId: "run-2",
							status: "active",
							currentNodeId: "qa",
						},
					],
				}),
			),
		).toEqual({ light: "unknown", reason: "ambiguous_runs" });
	});

	it("uses only the selected active run as a loop source", () => {
		expect(
			judgeLoopLight(
				facts({
					runs: [
						...facts().runs,
						{
							runId: "run-held",
							status: "held",
							currentNodeId: "qa",
						},
					],
					attempts: [
						{
							runId: "run-held",
							nodeId: "qa",
							attempt: 1,
							state: "running",
							executionId: "exec-actor",
						},
					],
				}),
			),
		).toEqual({ light: "red" });
	});

	it("keeps display-only parked availability out of the red-light verdict", () => {
		expect(
			judgeLoopLight(facts({ displayWarnings: ["parked_unavailable"] })),
		).toEqual({ light: "red" });
		expect(
			judgeLoopLight(
				facts({
					waits: [],
					parkedExecutionIds: ["exec-waiter"],
				}),
			),
		).toEqual({ light: "not_triggered" });
	});

	it("probes an off-roster TURN holder and projects physical liveness", async () => {
		const turn = facts().turn!;
		const snapshot: PatrolTurnJudgmentSnapshot = {
			available: true,
			turns: new Map([["issue-1855", turn]]),
			waits: new Map(),
			wakes: new Map(),
		};
		const currentAttempt = {
			runId: "run-1",
			nodeId: "qa",
			attempt: 2,
			state: "running",
			executionId: "exec-holder",
		};
		const store: PatrolLoopStore = {
			getPatrolWorkflowRuns: () => [
				{ runId: "run-1", status: "active", currentNodeId: "qa" },
			],
			listActiveNodeAttempts: () => [],
			getLatestNodeAttempt: () => currentAttempt,
			listOpenReworkDeliveries: () => [],
			listOpenLandOperations: () => [],
			listOpenGateAuthorities: () => [],
			getSession: (executionId) =>
				executionId === "exec-holder" ? { status: "completed" } : undefined,
		};
		const expectedFingerprint = patrolJudgmentFingerprint(
			snapshot,
			"issue-1855",
			["exec-waiter"],
		);

		await expect(
			collectPatrolLoopEntries({
				projectName: "flywheel",
				roster: [
					{
						issueId: "issue-1855",
						identifier: "FLY-1855",
						executionId: "exec-waiter",
						status: "running",
					},
				],
				nowMs: NOW_MS,
				store,
				reader: {
					readPatrolTurnSnapshot: () => ({
						judgment: snapshot,
						display: { available: true, declared: new Map() },
					}),
					rereadJudgmentFingerprint: () => ({
						available: true,
						fingerprint: expectedFingerprint,
					}),
					close: () => {},
				},
				probeProcessLiveness: async (executionId) =>
					executionId === "exec-holder" ? "dead" : "alive",
			}),
		).resolves.toMatchObject([
			{
				light: "red",
				redCause: { kind: "holder_process_dead" },
				processes: [
					{ executionId8: "exec-wai", state: "alive" },
					{ executionId8: "exec-hol", state: "dead" },
				],
			},
		]);
	});

	it("projects the selected run, TURN, and ledger-row ages into one issue entry", () => {
		const input = facts({
			attempts: [
				{
					runId: "run-1",
					nodeId: "implement",
					attempt: 2,
					state: "done",
					executionId: "exec-waiter",
				},
			],
			waits: [
				...facts().waits,
				{
					executionId: "exec-stale",
					holderExecId: "old-holder",
					epoch: 2,
					firstSeenAt: NOW_MS - 5 * 60_000,
				},
				{
					executionId: "exec-stale",
					holderExecId: "older-holder",
					epoch: 1,
					firstSeenAt: NOW_MS - 10 * 60_000,
				},
			],
			roster: [
				...facts().roster,
				{ executionId: "exec-stale", status: "running" },
			],
			parkedExecutionIds: ["exec-holder"],
			displayWarnings: ["parked_unavailable"],
		});

		expect(toPatrolLoopEntry(input, { light: "red" })).toEqual({
			issueId: "issue-1855",
			identifier: "FLY-1855",
			runId8: "run-1",
			runStatus: "active",
			currentNode: "implement",
			currentAttempt: 2,
			currentAttemptState: "done",
			turnHolderExecId8: "exec-hol",
			turnPhase: "qa",
			turnEpoch: 3,
			openLoops: [],
			waiters: [
				{
					executionId8: "exec-wai",
					kind: "turn-poll",
					waitedMinutes: 30,
					redQualified: true,
				},
				{
					executionId8: "exec-sta",
					kind: "turn-poll-stale",
				},
				{ executionId8: "exec-hol", kind: "parked" },
			],
			displayWarnings: ["parked_unavailable"],
			light: "red",
		});
	});

	it("projects every open-loop authority and classifies stale or exhausted wakes", () => {
		const entry = toPatrolLoopEntry(
			facts({
				reworkDeliveries: [
					{
						runId: "run-1",
						state: "replacement_pending",
						targetNodeId: "implement",
						targetAttempt: 3,
					},
				],
				landOperations: [{ state: "partial", currentStep: "merge" }],
				wakes: [
					{
						issueId: "issue-1855",
						state: "sent",
						pushCount: 2,
						executionId: "exec-holder",
						epoch: 3,
						activationId: "activation-holder",
					},
					{
						issueId: "issue-1855",
						state: "pending",
						pushCount: 0,
						executionId: "old-execution",
						epoch: 2,
						activationId: "old-activation",
					},
				],
				gateAuthorities: [
					{ runId: "run-1", kind: "gate", state: "approved" },
					{ runId: "run-1", kind: "carrier", state: "held" },
				],
			}),
			{ light: "not_triggered" },
		);

		expect(entry.openLoops).toEqual([
			{
				kind: "rework",
				state: "replacement_pending",
				target: "implement@3",
			},
			{ kind: "land", state: "partial", step: "merge" },
			{ kind: "wake", state: "exhausted", target: "exec-hol" },
			{ kind: "wake", state: "stale", target: "old-exec" },
			{ kind: "gate", state: "approved" },
			{ kind: "carrier", state: "held" },
		]);
	});
});
