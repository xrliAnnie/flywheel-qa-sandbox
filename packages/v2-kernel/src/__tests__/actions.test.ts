import { afterEach, describe, expect, it } from "vitest";
import {
	listActions,
	readAction,
	recordActionIntent,
	recordActionOutcome,
} from "../actions.js";
import { ActionSerializationError, CasViolation } from "../errors.js";
import { Kernel } from "../kernel.js";
import { migrateDatabase } from "../migrator.js";
import {
	boundAgentParams,
	INSERT_BOUND_AGENT_SQL,
	makeTempDatabase,
	type TempDatabase,
} from "./helpers.js";

describe("action black box", () => {
	let temp: TempDatabase | undefined;
	let kernel: Kernel | undefined;

	class SdkResult {
		constructor(readonly externalId: string) {}
	}

	afterEach(() => {
		kernel?.close();
		kernel = undefined;
		temp?.cleanup();
		temp = undefined;
	});

	it("records and reads an arbitrary action intent for the current agent", () => {
		temp = makeTempDatabase();
		migrateDatabase({ path: temp.path });
		kernel = Kernel.open({ path: temp.path });
		kernel.write("seed current lead", (tx) => {
			tx.run(
				INSERT_BOUND_AGENT_SQL,
				boundAgentParams({ agentId: "lead-a", kind: "lead" }),
			);
		});

		const recorded = kernel.write("record action intent", (tx) =>
			recordActionIntent(tx, {
				id: "action-1",
				actor: {
					kind: "lead",
					agentId: "lead-a",
					instanceId: "session-a",
					generation: 1,
				},
				kind: "custom_tool_call",
				payload: { body: "hello", target: "founder" },
				authorization: { gate_id: "gate-1", target_head: "abc123" },
				logicalEffectId: "daily-report",
				invocationUid: "transcript:tool-call-1",
				cutoverEpoch: 7,
				createdAt: "2026-07-28T08:00:00.000Z",
			}),
		);

		expect(recorded).toMatchObject({
			outcome: "inserted",
			action: {
				id: "action-1",
				actor: {
					kind: "lead",
					agentId: "lead-a",
					instanceId: "session-a",
					generation: 1,
				},
				kind: "custom_tool_call",
				payload: { body: "hello", target: "founder" },
				authorization: { gate_id: "gate-1", target_head: "abc123" },
				cutoverEpoch: 7,
				state: "intended",
				createdAt: "2026-07-28T08:00:00.000Z",
			},
		});
		expect(kernel.read((tx) => readAction(tx, "action-1"))).toEqual(
			recorded.action,
		);
	});

	it.each([
		["Date", new Date("2026-07-28T08:00:00.000Z")],
		["Map", new Map([["externalId", "map-result"]])],
		["Set", new Set(["set-result"])],
		["class instance", new SdkResult("class-result")],
		["boxed number", new Number(7)],
	])(
		"rejects a non-JSON %s payload instead of recording an empty object",
		(_, payload) => {
			temp = makeTempDatabase();
			migrateDatabase({ path: temp.path });
			kernel = Kernel.open({ path: temp.path });
			kernel.write("seed current lead", (tx) => {
				tx.run(
					INSERT_BOUND_AGENT_SQL,
					boundAgentParams({ agentId: "lead-a", kind: "lead" }),
				);
			});

			expect(() =>
				kernel?.write("reject non-JSON payload", (tx) =>
					recordActionIntent(tx, {
						id: "action-non-json",
						actor: {
							kind: "lead",
							agentId: "lead-a",
							instanceId: "session-a",
							generation: 1,
						},
						kind: "custom_tool_call",
						payload: payload as never,
						logicalEffectId: "non-json-payload",
						invocationUid: "transcript:non-json-payload",
						cutoverEpoch: 7,
					}),
				),
			).toThrow(/JSON/i);
			expect(kernel.read((tx) => readAction(tx, "action-non-json"))).toBeNull();
		},
	);

	it("treats toJSON as ordinary data and never invokes callable serializers", () => {
		temp = makeTempDatabase();
		migrateDatabase({ path: temp.path });
		kernel = Kernel.open({ path: temp.path });
		kernel.write("seed current lead", (tx) => {
			tx.run(
				INSERT_BOUND_AGENT_SQL,
				boundAgentParams({ agentId: "lead-a", kind: "lead" }),
			);
		});
		const base = {
			actor: {
				kind: "lead" as const,
				agentId: "lead-a",
				instanceId: "session-a",
				generation: 1,
			},
			kind: "custom_tool_call",
			logicalEffectId: "to-json-boundary",
			cutoverEpoch: 7,
		};
		const callable = () => ({ forged: true });

		expect(() =>
			kernel?.write("reject callable toJSON", (tx) =>
				recordActionIntent(tx, {
					id: "action-callable-to-json",
					...base,
					payload: { body: "hello", toJSON: callable } as never,
					invocationUid: "transcript:callable-to-json",
				}),
			),
		).toThrow(/unsupported function value/i);
		const data = kernel.write("record JSON-valued toJSON field", (tx) =>
			recordActionIntent(tx, {
				id: "action-data-to-json",
				...base,
				payload: { body: "hello", toJSON: { mode: "data" } },
				invocationUid: "transcript:data-to-json",
			}),
		);

		expect(data.action.payload).toEqual({
			body: "hello",
			toJSON: { mode: "data" },
		});
		expect(
			kernel.read((tx) => readAction(tx, "action-callable-to-json")),
		).toBeNull();
	});

	it("returns the original action when the same invocation is replayed", () => {
		temp = makeTempDatabase();
		migrateDatabase({ path: temp.path });
		kernel = Kernel.open({ path: temp.path });
		kernel.write("seed current lead", (tx) => {
			tx.run(
				INSERT_BOUND_AGENT_SQL,
				boundAgentParams({ agentId: "lead-a", kind: "lead" }),
			);
		});
		const spec = {
			actor: {
				kind: "lead" as const,
				agentId: "lead-a",
				instanceId: "session-a",
				generation: 1,
			},
			kind: "custom_tool_call",
			payload: { body: "hello", target: "founder" },
			logicalEffectId: "daily-report",
			invocationUid: "transcript:tool-call-1",
			cutoverEpoch: 7,
			createdAt: "2026-07-28T08:00:00.000Z",
		};
		kernel.write("record first intent", (tx) =>
			recordActionIntent(tx, { id: "action-1", ...spec }),
		);

		const replayed = kernel.write("replay intent", (tx) =>
			recordActionIntent(tx, { id: "action-2", ...spec }),
		);

		expect(replayed).toMatchObject({
			outcome: "replayed",
			action: { id: "action-1", state: "intended" },
		});
		expect(kernel.read((tx) => readAction(tx, "action-2"))).toBeNull();
	});

	it("keeps the original authorization snapshot when an invocation replays", () => {
		temp = makeTempDatabase();
		migrateDatabase({ path: temp.path });
		kernel = Kernel.open({ path: temp.path });
		kernel.write("seed current lead", (tx) => {
			tx.run(
				INSERT_BOUND_AGENT_SQL,
				boundAgentParams({ agentId: "lead-a", kind: "lead" }),
			);
		});
		const base = {
			actor: {
				kind: "lead" as const,
				agentId: "lead-a",
				instanceId: "session-a",
				generation: 1,
			},
			kind: "github_merge",
			payload: { pr: 720 },
			logicalEffectId: "merge-pr-720",
			invocationUid: "transcript:merge-pr-720",
			cutoverEpoch: 7,
		};
		const original = kernel.write("record authorized intent", (tx) =>
			recordActionIntent(tx, {
				id: "action-authorized",
				...base,
				authorization: { gate_id: "gate-1", target_head: "abc123" },
			}),
		);

		const replayed = kernel.write("replay under changed authorization", (tx) =>
			recordActionIntent(tx, {
				id: "action-authorized-replay",
				...base,
				authorization: { gate_id: "gate-2", target_head: "def456" },
			}),
		);

		expect(replayed).toEqual({
			outcome: "replayed",
			action: original.action,
		});
		expect(replayed.action.authorization).toEqual({
			gate_id: "gate-1",
			target_head: "abc123",
		});
		expect(
			kernel.read((tx) => readAction(tx, "action-authorized-replay")),
		).toBeNull();
	});

	it("rejects non-canonical explicit action timestamps", () => {
		temp = makeTempDatabase();
		migrateDatabase({ path: temp.path });
		kernel = Kernel.open({ path: temp.path });
		const actor = {
			kind: "lead" as const,
			agentId: "lead-a",
			instanceId: "session-a",
			generation: 1,
		};
		kernel.write("seed current lead", (tx) => {
			tx.run(
				INSERT_BOUND_AGENT_SQL,
				boundAgentParams({ agentId: "lead-a", kind: "lead" }),
			);
		});

		expect(() =>
			kernel?.write("reject non-canonical createdAt", (tx) =>
				recordActionIntent(tx, {
					id: "action-invalid-created-at",
					actor,
					kind: "custom_tool_call",
					payload: { body: "hello" },
					logicalEffectId: "invalid-created-at",
					invocationUid: "transcript:invalid-created-at",
					cutoverEpoch: 7,
					createdAt: "2026-07-28T08:00:00Z",
				}),
			),
		).toThrow(/createdAt.*canonical ISO/i);
		kernel.write("record action for completedAt validation", (tx) =>
			recordActionIntent(tx, {
				id: "action-invalid-completed-at",
				actor,
				kind: "custom_tool_call",
				payload: { body: "hello" },
				logicalEffectId: "invalid-completed-at",
				invocationUid: "transcript:invalid-completed-at",
				cutoverEpoch: 7,
			}),
		);
		expect(() =>
			kernel?.write("reject non-canonical completedAt", (tx) =>
				recordActionOutcome(tx, {
					id: "action-invalid-completed-at",
					actor,
					state: "succeeded",
					result: { ok: true },
					completedAt: "2026-07-28T08:00:01Z",
				}),
			),
		).toThrow(/completedAt.*canonical ISO/i);
		expect(
			kernel.read((tx) => readAction(tx, "action-invalid-completed-at")),
		).toMatchObject({
			state: "intended",
			result: undefined,
			completedAt: undefined,
		});
	});

	it("records one successful outcome with the original actor token", () => {
		temp = makeTempDatabase();
		migrateDatabase({ path: temp.path });
		kernel = Kernel.open({ path: temp.path });
		kernel.write("seed current lead", (tx) => {
			tx.run(
				INSERT_BOUND_AGENT_SQL,
				boundAgentParams({ agentId: "lead-a", kind: "lead" }),
			);
		});
		const actor = {
			kind: "lead" as const,
			agentId: "lead-a",
			instanceId: "session-a",
			generation: 1,
		};
		kernel.write("record action intent", (tx) =>
			recordActionIntent(tx, {
				id: "action-1",
				actor,
				kind: "custom_tool_call",
				payload: { body: "hello" },
				logicalEffectId: "daily-report",
				invocationUid: "transcript:tool-call-1",
				cutoverEpoch: 7,
				createdAt: "2026-07-28T08:00:00.000Z",
			}),
		);

		const completed = kernel.write("record action outcome", (tx) =>
			recordActionOutcome(tx, {
				id: "action-1",
				actor,
				state: "succeeded",
				result: { externalId: "result-1", ok: true },
				completedAt: "2026-07-28T08:00:01.000Z",
			}),
		);

		expect(completed).toMatchObject({
			id: "action-1",
			state: "succeeded",
			result: { externalId: "result-1", ok: true },
			completedAt: "2026-07-28T08:00:01.000Z",
		});
		expect(kernel.read((tx) => readAction(tx, "action-1"))).toEqual(completed);
	});

	it("types action result serialization failures without mutating the intent", () => {
		temp = makeTempDatabase();
		migrateDatabase({ path: temp.path });
		kernel = Kernel.open({ path: temp.path });
		const actor = {
			kind: "lead" as const,
			agentId: "lead-a",
			instanceId: "session-a",
			generation: 1,
		};
		kernel.write("seed current lead and intent", (tx) => {
			tx.run(
				INSERT_BOUND_AGENT_SQL,
				boundAgentParams({ agentId: "lead-a", kind: "lead" }),
			);
			recordActionIntent(tx, {
				id: "action-sdk-result",
				actor,
				kind: "custom_tool_call",
				payload: { body: "hello" },
				logicalEffectId: "sdk-result",
				invocationUid: "transcript:sdk-result",
				cutoverEpoch: 7,
			});
		});

		expect(() =>
			kernel?.write("record non-JSON outcome", (tx) =>
				recordActionOutcome(tx, {
					id: "action-sdk-result",
					actor,
					state: "succeeded",
					result: new Date("2026-07-28T08:00:00.000Z") as never,
				}),
			),
		).toThrow(ActionSerializationError);
		expect(
			kernel.read((tx) => readAction(tx, "action-sdk-result")),
		).toMatchObject({
			state: "intended",
			result: undefined,
			completedAt: undefined,
		});
	});

	it("records an explicit evidenced successor for a failed action", () => {
		temp = makeTempDatabase();
		migrateDatabase({ path: temp.path });
		kernel = Kernel.open({ path: temp.path });
		kernel.write("seed current lead", (tx) => {
			tx.run(
				INSERT_BOUND_AGENT_SQL,
				boundAgentParams({ agentId: "lead-a", kind: "lead" }),
			);
		});
		const actor = {
			kind: "lead" as const,
			agentId: "lead-a",
			instanceId: "session-a",
			generation: 1,
		};
		const base = {
			actor,
			kind: "custom_tool_call",
			payload: { body: "hello" },
			logicalEffectId: "daily-report",
			cutoverEpoch: 7,
		};
		kernel.write("record failed root", (tx) => {
			recordActionIntent(tx, {
				id: "action-1",
				...base,
				invocationUid: "transcript:tool-call-1",
			});
			recordActionOutcome(tx, {
				id: "action-1",
				actor,
				state: "failed",
				result: { error: "connection reset" },
			});
		});

		const successor = kernel.write("record explicit successor", (tx) =>
			recordActionIntent(tx, {
				id: "action-2",
				...base,
				invocationUid: "transcript:tool-call-2",
				supersedesActionId: "action-1",
				retryBasis: {
					evidenceRef: "gh://runs/123",
					reason: "provider confirmed no request was accepted",
				},
			}),
		);

		expect(successor).toMatchObject({
			outcome: "inserted",
			action: {
				id: "action-2",
				state: "intended",
				supersedesActionId: "action-1",
				retryBasis: {
					evidenceRef: "gh://runs/123",
					reason: "provider confirmed no request was accepted",
				},
			},
		});
	});

	it("lists intended actions newest first with a caller-required limit", () => {
		temp = makeTempDatabase();
		migrateDatabase({ path: temp.path });
		kernel = Kernel.open({ path: temp.path });
		kernel.write("seed current lead and intents", (tx) => {
			tx.run(
				INSERT_BOUND_AGENT_SQL,
				boundAgentParams({ agentId: "lead-a", kind: "lead" }),
			);
			for (const [id, logicalEffectId, createdAt] of [
				["action-1", "daily-report", "2026-07-28T08:00:00.000Z"],
				["action-2", "weekly-report", "2026-07-28T08:00:01.000Z"],
			] as const) {
				recordActionIntent(tx, {
					id,
					actor: {
						kind: "lead",
						agentId: "lead-a",
						instanceId: "session-a",
						generation: 1,
					},
					kind: "custom_tool_call",
					payload: { logicalEffectId },
					logicalEffectId,
					invocationUid: `transcript:${id}`,
					cutoverEpoch: 7,
					createdAt,
				});
			}
		});

		expect(
			kernel.read((tx) => listActions(tx, { state: "intended", limit: 1 })),
		).toMatchObject([{ id: "action-2", state: "intended" }]);
	});

	it("rejects terminal rewrites and stale-generation writes", () => {
		temp = makeTempDatabase();
		migrateDatabase({ path: temp.path });
		kernel = Kernel.open({ path: temp.path });
		const actor = {
			kind: "lead" as const,
			agentId: "lead-a",
			instanceId: "session-a",
			generation: 1,
		};
		kernel.write("seed current lead and intent", (tx) => {
			tx.run(
				INSERT_BOUND_AGENT_SQL,
				boundAgentParams({ agentId: "lead-a", kind: "lead" }),
			);
			recordActionIntent(tx, {
				id: "action-1",
				actor,
				kind: "custom_tool_call",
				payload: { body: "hello" },
				logicalEffectId: "daily-report",
				invocationUid: "transcript:tool-call-1",
				cutoverEpoch: 7,
			});
			recordActionOutcome(tx, {
				id: "action-1",
				actor,
				state: "succeeded",
				result: { externalId: "external-1" },
			});
		});
		expect(() =>
			kernel?.write("rewrite terminal action", (tx) =>
				recordActionOutcome(tx, {
					id: "action-1",
					actor,
					state: "failed",
					result: { error: "late" },
				}),
			),
		).toThrow(CasViolation);
		kernel.write("advance generation", (tx) => {
			const successor = boundAgentParams({
				agentId: "lead-a",
				kind: "lead",
				generation: 2,
				instanceId: "session-b",
				pid: 4343,
			});
			tx.run(
				`UPDATE agents
				 SET generation=@generation,instance_id=@instanceId,
				     session_binding=@sessionBinding
				 WHERE agent_id=@agentId`,
				successor,
			);
		});
		expect(() =>
			kernel?.write("late old-generation outcome", (tx) =>
				recordActionOutcome(tx, {
					id: "action-1",
					actor,
					state: "succeeded",
					result: { externalId: "late" },
				}),
			),
		).toThrow(CasViolation);
		expect(() =>
			kernel?.write("old-generation new intent", (tx) =>
				recordActionIntent(tx, {
					id: "action-stale",
					actor,
					kind: "custom_tool_call",
					payload: { body: "stale" },
					logicalEffectId: "stale-report",
					invocationUid: "transcript:tool-call-stale",
					cutoverEpoch: 7,
				}),
			),
		).toThrow();
		expect(kernel.read((tx) => readAction(tx, "action-1"))).toMatchObject({
			state: "succeeded",
			result: { externalId: "external-1" },
		});
	});

	it("fails loudly on effect-envelope collisions and unchained second roots", () => {
		temp = makeTempDatabase();
		migrateDatabase({ path: temp.path });
		kernel = Kernel.open({ path: temp.path });
		const actor = {
			kind: "lead" as const,
			agentId: "lead-a",
			instanceId: "session-a",
			generation: 1,
		};
		kernel.write("seed current lead and root", (tx) => {
			tx.run(
				INSERT_BOUND_AGENT_SQL,
				boundAgentParams({ agentId: "lead-a", kind: "lead" }),
			);
			recordActionIntent(tx, {
				id: "action-1",
				actor,
				kind: "custom_tool_call",
				payload: { body: "original" },
				logicalEffectId: "daily-report",
				invocationUid: "transcript:tool-call-1",
				cutoverEpoch: 7,
			});
		});
		expect(() =>
			kernel?.write("colliding replay", (tx) =>
				recordActionIntent(tx, {
					id: "action-collision",
					actor,
					kind: "custom_tool_call",
					payload: { body: "changed" },
					logicalEffectId: "daily-report",
					invocationUid: "transcript:tool-call-1",
					cutoverEpoch: 7,
				}),
			),
		).toThrow(/effect key collision/i);
		expect(() =>
			kernel?.write("unchained root", (tx) =>
				recordActionIntent(tx, {
					id: "action-root-2",
					actor,
					kind: "custom_tool_call",
					payload: { body: "original" },
					logicalEffectId: "daily-report",
					invocationUid: "transcript:tool-call-2",
					cutoverEpoch: 7,
				}),
			),
		).toThrow();
	});

	it("requires an evidenced linear retry chain with an unchanged envelope", () => {
		temp = makeTempDatabase();
		migrateDatabase({ path: temp.path });
		kernel = Kernel.open({ path: temp.path });
		const actor = {
			kind: "lead" as const,
			agentId: "lead-a",
			instanceId: "session-a",
			generation: 1,
		};
		kernel.write("seed current lead and roots", (tx) => {
			tx.run(
				INSERT_BOUND_AGENT_SQL,
				boundAgentParams({ agentId: "lead-a", kind: "lead" }),
			);
			recordActionIntent(tx, {
				id: "action-unknown",
				actor,
				kind: "custom_tool_call",
				payload: { body: "unknown" },
				logicalEffectId: "unknown-report",
				invocationUid: "transcript:unknown-1",
				cutoverEpoch: 7,
			});
			recordActionIntent(tx, {
				id: "action-succeeded",
				actor,
				kind: "custom_tool_call",
				payload: { body: "succeeded" },
				logicalEffectId: "succeeded-report",
				invocationUid: "transcript:succeeded-1",
				cutoverEpoch: 7,
			});
			recordActionOutcome(tx, {
				id: "action-succeeded",
				actor,
				state: "succeeded",
				result: { externalId: "external-1" },
			});
		});
		const retryBasis = {
			evidenceRef: "gh://runs/123",
			reason: "provider confirmed no request was accepted",
		};
		const retryUnknown = {
			actor,
			kind: "custom_tool_call",
			payload: { body: "unknown" },
			logicalEffectId: "unknown-report",
			cutoverEpoch: 7,
			supersedesActionId: "action-unknown",
			retryBasis,
		};

		expect(() =>
			kernel?.write("reject split retry metadata", (tx) =>
				recordActionIntent(tx, {
					id: "action-split",
					actor,
					kind: "custom_tool_call",
					payload: { body: "unknown" },
					logicalEffectId: "unknown-report",
					invocationUid: "transcript:unknown-split",
					supersedesActionId: "action-unknown",
					cutoverEpoch: 7,
				}),
			),
		).toThrow(/provided together/i);
		expect(() =>
			kernel?.write("reject changed retry envelope", (tx) =>
				recordActionIntent(tx, {
					id: "action-changed",
					...retryUnknown,
					payload: { body: "changed" },
					invocationUid: "transcript:unknown-changed",
				}),
			),
		).toThrow(/matching/i);
		expect(() =>
			kernel?.write("reject successor after success", (tx) =>
				recordActionIntent(tx, {
					id: "action-after-success",
					actor,
					kind: "custom_tool_call",
					payload: { body: "succeeded" },
					logicalEffectId: "succeeded-report",
					invocationUid: "transcript:succeeded-2",
					supersedesActionId: "action-succeeded",
					retryBasis,
					cutoverEpoch: 7,
				}),
			),
		).toThrow(/matching/i);

		const successor = kernel.write("record successor", (tx) =>
			recordActionIntent(tx, {
				id: "action-successor",
				...retryUnknown,
				invocationUid: "transcript:unknown-2",
			}),
		);
		expect(successor.action.supersedesActionId).toBe("action-unknown");
		expect(() =>
			kernel?.write("reject forked successor", (tx) =>
				recordActionIntent(tx, {
					id: "action-fork",
					...retryUnknown,
					invocationUid: "transcript:unknown-3",
				}),
			),
		).toThrow();

		const changedRoot = kernel.write(
			"record changed effect as new root",
			(tx) =>
				recordActionIntent(tx, {
					id: "action-new-root",
					actor,
					kind: "custom_tool_call",
					payload: { body: "changed" },
					logicalEffectId: "changed-report",
					invocationUid: "transcript:changed-1",
					cutoverEpoch: 7,
				}),
		);
		expect(changedRoot).toMatchObject({
			outcome: "inserted",
			action: { id: "action-new-root", supersedesActionId: undefined },
		});
	});

	it("rejects duplicate retry-basis keys at the database boundary", () => {
		temp = makeTempDatabase();
		migrateDatabase({ path: temp.path });
		kernel = Kernel.open({ path: temp.path });
		const actor = {
			kind: "lead" as const,
			agentId: "lead-a",
			instanceId: "session-a",
			generation: 1,
		};
		kernel.write("seed current lead and retry root", (tx) => {
			tx.run(
				INSERT_BOUND_AGENT_SQL,
				boundAgentParams({ agentId: "lead-a", kind: "lead" }),
			);
			recordActionIntent(tx, {
				id: "action-retry-root",
				actor,
				kind: "custom_tool_call",
				payload: { body: "hello" },
				logicalEffectId: "retry-report",
				invocationUid: "transcript:retry-root",
				cutoverEpoch: 7,
			});
		});

		expect(() =>
			kernel?.write("reject duplicate retry basis keys", (tx) => {
				tx.run(
					`INSERT INTO actions (
					   id, task_id, attempt_id, attempt_generation, activation_id,
					   actor_kind, actor_agent_id, actor_instance_id, actor_generation,
					   kind, payload, payload_digest, authorization, authorization_digest,
					   logical_key, effect_key, supersedes_action_id, retry_basis,
					   cutover_epoch, created_at
					 )
					 SELECT
					   'action-duplicate-basis', task_id, attempt_id, attempt_generation,
					   activation_id, actor_kind, actor_agent_id, actor_instance_id,
					   actor_generation, kind, payload, payload_digest, authorization,
					   authorization_digest, logical_key, 'effect:duplicate-basis', id,
					   '{"evidence_ref":"gh://runs/123","reason":"provider confirmed no request was accepted","reason":"retry"}',
					   cutover_epoch, '2026-07-28T08:00:01.000Z'
					 FROM actions WHERE id='action-retry-root'`,
				);
			}),
		).toThrow();
		expect(
			kernel.read((tx) => readAction(tx, "action-duplicate-basis")),
		).toBeNull();
	});

	it("replays only the identical explicit supersede request", () => {
		temp = makeTempDatabase();
		migrateDatabase({ path: temp.path });
		kernel = Kernel.open({ path: temp.path });
		const actor = {
			kind: "lead" as const,
			agentId: "lead-a",
			instanceId: "session-a",
			generation: 1,
		};
		const base = {
			actor,
			kind: "custom_tool_call",
			payload: { body: "hello" },
			logicalEffectId: "retry-replay-report",
			cutoverEpoch: 7,
		};
		kernel.write("seed current lead and failed root", (tx) => {
			tx.run(
				INSERT_BOUND_AGENT_SQL,
				boundAgentParams({ agentId: "lead-a", kind: "lead" }),
			);
			recordActionIntent(tx, {
				id: "action-replay-root",
				...base,
				invocationUid: "transcript:retry-replay-root",
			});
			recordActionOutcome(tx, {
				id: "action-replay-root",
				actor,
				state: "failed",
				result: { error: "connection reset" },
			});
		});
		const original = kernel.write("record retry intent", (tx) =>
			recordActionIntent(tx, {
				id: "action-retry-original",
				...base,
				invocationUid: "transcript:retry-replay",
				supersedesActionId: "action-replay-root",
				retryBasis: {
					evidenceRef: "gh://runs/123",
					reason: "provider confirmed no request was accepted at 08:00",
				},
			}),
		);

		const replayed = kernel.write("replay identical supersede intent", (tx) =>
			recordActionIntent(tx, {
				id: "action-retry-replayed",
				...base,
				invocationUid: "transcript:retry-replay",
				supersedesActionId: "action-replay-root",
				retryBasis: {
					evidenceRef: "gh://runs/123",
					reason: "provider confirmed no request was accepted at 08:00",
				},
			}),
		);
		expect(replayed).toEqual({
			outcome: "replayed",
			action: original.action,
		});

		expect(() =>
			kernel?.write("reject changed supersede audit envelope", (tx) =>
				recordActionIntent(tx, {
					id: "action-retry-changed",
					...base,
					invocationUid: "transcript:retry-replay",
					supersedesActionId: "action-replay-root",
					retryBasis: {
						evidenceRef: "gh://runs/456",
						reason: "provider confirmed no request was accepted at 08:05",
					},
				}),
			),
		).toThrow(/effect key collision/i);
		expect(() =>
			kernel?.write("reject dropped supersede audit envelope", (tx) =>
				recordActionIntent(tx, {
					id: "action-retry-without-metadata",
					...base,
					invocationUid: "transcript:retry-replay",
					retryBasis: undefined,
					supersedesActionId: undefined,
				}),
			),
		).toThrow(/effect key collision/i);
		expect(original.action).toMatchObject({
			id: "action-retry-original",
			supersedesActionId: "action-replay-root",
			retryBasis: {
				evidenceRef: "gh://runs/123",
				reason: "provider confirmed no request was accepted at 08:00",
			},
		});
	});

	it("namespaces taskless logical effects by stable agent id", () => {
		temp = makeTempDatabase();
		migrateDatabase({ path: temp.path });
		kernel = Kernel.open({ path: temp.path });
		kernel.write("seed two leads", (tx) => {
			tx.run(
				INSERT_BOUND_AGENT_SQL,
				boundAgentParams({
					agentId: "lead-a",
					kind: "lead",
					instanceId: "session-lead-a",
				}),
			);
			tx.run(
				INSERT_BOUND_AGENT_SQL,
				boundAgentParams({
					agentId: "lead-b",
					kind: "lead",
					instanceId: "session-lead-b",
					pid: 4243,
				}),
			);
		});
		const recordFor = (agentId: string, id: string) =>
			kernel?.write(`record ${agentId}`, (tx) =>
				recordActionIntent(tx, {
					id,
					actor: {
						kind: "lead",
						agentId,
						instanceId: `session-${agentId}`,
						generation: 1,
					},
					kind: "custom_tool_call",
					payload: { body: agentId },
					logicalEffectId: "standup",
					invocationUid: "transcript:tool-call-1",
					cutoverEpoch: 7,
				}),
			);

		const first = recordFor("lead-a", "action-a");
		const second = recordFor("lead-b", "action-b");
		const nullTaskReplay = kernel.write(
			"replay explicit null task binding",
			(tx) =>
				recordActionIntent(tx, {
					id: "action-a-replayed",
					taskId: null as never,
					actor: {
						kind: "lead",
						agentId: "lead-a",
						instanceId: "session-lead-a",
						generation: 1,
					},
					kind: "custom_tool_call",
					payload: { body: "lead-a" },
					logicalEffectId: "standup",
					invocationUid: "transcript:tool-call-1",
					cutoverEpoch: 7,
				}),
		);

		expect(first?.action.logicalKey).not.toBe(second?.action.logicalKey);
		expect([first?.action.id, second?.action.id]).toEqual([
			"action-a",
			"action-b",
		]);
		expect(nullTaskReplay).toMatchObject({
			outcome: "replayed",
			action: { id: "action-a" },
		});
	});

	it("binds runner actions to matching task, attempt generation, and activation", () => {
		temp = makeTempDatabase();
		migrateDatabase({ path: temp.path });
		kernel = Kernel.open({ path: temp.path });
		kernel.write("seed runner lineage", (tx) => {
			tx.run(
				INSERT_BOUND_AGENT_SQL,
				boundAgentParams({
					agentId: "runner-a",
					kind: "runner",
					generation: 3,
					instanceId: "runner-instance",
				}),
			);
			tx.run(
				`INSERT INTO tasks
				 (id, project_id, kind, state, lineage_root_id, created_at)
				 VALUES ('task-1', 'flywheel', 'build', 'running', 'task-1', 'now')`,
			);
			tx.run(
				`INSERT INTO attempts(id, task_id, generation, desired_state)
				 VALUES ('attempt-1', 'task-1', 2, 'started')`,
			);
			tx.run(
				`INSERT INTO activations
				 (id, attempt_id, session_ref, generation, state)
				 VALUES ('activation-1', 'attempt-1', 'session-runner', 2, 'active')`,
			);
		});
		const actor = {
			kind: "runner" as const,
			agentId: "runner-a",
			instanceId: "runner-instance",
			generation: 3,
			activationId: "activation-1",
		};
		const valid = kernel.write("record bound runner action", (tx) =>
			recordActionIntent(tx, {
				id: "runner-action",
				taskId: "task-1",
				attemptId: "attempt-1",
				attemptGeneration: 2,
				actor,
				kind: "custom_tool_call",
				payload: { body: "bound" },
				logicalEffectId: "task-effect",
				invocationUid: "proposal-1:0",
				cutoverEpoch: 7,
			}),
		);
		expect(valid.action.actor).toEqual(actor);
		expect(() =>
			kernel?.write("reject mismatched attempt generation", (tx) =>
				recordActionIntent(tx, {
					id: "runner-action-bad",
					taskId: "task-1",
					attemptId: "attempt-1",
					attemptGeneration: 1,
					actor,
					kind: "custom_tool_call",
					payload: { body: "bad" },
					logicalEffectId: "task-effect-bad",
					invocationUid: "proposal-2:0",
					cutoverEpoch: 7,
				}),
			),
		).toThrow(/lineage/i);
	});

	// QA (FLY-1500) — mapping §7.2 要求「旧世代回写抛 CasViolation，原行不变」。既有用例只覆盖
	// 「同一 actor token 但 agents 世代已推进」这一形态。生产里更常见的是**接班的新世代**
	// （新 session、新 instance、generation+1）回来结算前代留下的 intended 行：那条路径必须同样
	// 被挡住，否则 FINAL §8 的「库内 generation 是最后保险丝」在真实接班场景下失效。
	it("refuses a successor generation settling the predecessor's intent", () => {
		temp = makeTempDatabase();
		migrateDatabase({ path: temp.path });
		kernel = Kernel.open({ path: temp.path });
		const predecessor = {
			kind: "lead" as const,
			agentId: "lead-a",
			instanceId: "session-a",
			generation: 1,
		};
		kernel.write("seed current lead and intent", (tx) => {
			tx.run(
				INSERT_BOUND_AGENT_SQL,
				boundAgentParams({ agentId: "lead-a", kind: "lead" }),
			);
			recordActionIntent(tx, {
				id: "action-handover",
				actor: predecessor,
				kind: "custom_tool_call",
				payload: { body: "hello" },
				logicalEffectId: "handover-report",
				invocationUid: "transcript:tool-call-handover",
				cutoverEpoch: 7,
			});
		});
		kernel.write("cutover to the next generation", (tx) => {
			const successor = boundAgentParams({
				agentId: "lead-a",
				kind: "lead",
				generation: 2,
				instanceId: "session-b",
				pid: 4343,
			});
			tx.run(
				`UPDATE agents
				 SET generation=@generation,instance_id=@instanceId,
				     session_binding=@sessionBinding
				 WHERE agent_id=@agentId`,
				successor,
			);
		});

		expect(() =>
			kernel?.write("successor settles predecessor intent", (tx) =>
				recordActionOutcome(tx, {
					id: "action-handover",
					actor: {
						...predecessor,
						instanceId: "session-b",
						generation: 2,
					},
					state: "succeeded",
					result: { externalId: "guessed" },
				}),
			),
		).toThrow(CasViolation);
		expect(
			kernel.read((tx) => readAction(tx, "action-handover")),
		).toMatchObject({
			state: "intended",
			result: undefined,
			completedAt: undefined,
			actor: predecessor,
		});
	});

	// QA (FLY-1500) — 记录 `createdBefore` 的**真实边界**，不是给缺陷背书。
	//
	// mapping §5 冻结的公开 options 只有 `createdBefore`，而排序是 (created_at DESC, id DESC)。
	// 因此当多行共享同一 `created_at`（同一毫秒内写入完全可能：一次 tick 内多个工具调用、
	// intent 与后续 intent 相邻）时，用「上一页最后一行的 createdAt」当游标翻页会**静默丢掉**
	// 同秒的其余行 —— 它是时间戳过滤器，不是完整 keyset 游标。
	//
	// 本用例把这个边界钉死：一旦未来有人给 listActions 加上 (createdAt,id) 复合游标，这里会变红，
	// 提醒同步更新事故现场读取合同。已作为 MEDIUM 发现报给 Lead（见 qa-report.md）。
	it("treats createdBefore as a timestamp filter, not a complete keyset cursor", () => {
		temp = makeTempDatabase();
		migrateDatabase({ path: temp.path });
		kernel = Kernel.open({ path: temp.path });
		const createdAt = "2026-07-28T08:00:00.000Z";
		kernel.write("seed three same-timestamp intents", (tx) => {
			tx.run(
				INSERT_BOUND_AGENT_SQL,
				boundAgentParams({ agentId: "lead-a", kind: "lead" }),
			);
			for (const suffix of ["1", "2", "3"]) {
				recordActionIntent(tx, {
					id: `action-tie-${suffix}`,
					actor: {
						kind: "lead",
						agentId: "lead-a",
						instanceId: "session-a",
						generation: 1,
					},
					kind: "custom_tool_call",
					payload: { suffix },
					logicalEffectId: `tie-report-${suffix}`,
					invocationUid: `transcript:tie-${suffix}`,
					cutoverEpoch: 7,
					createdAt,
				});
			}
		});

		const firstPage = kernel.read((tx) => listActions(tx, { limit: 2 }));
		const nextPage = kernel.read((tx) =>
			listActions(tx, {
				limit: 2,
				createdBefore: firstPage[firstPage.length - 1]?.createdAt ?? createdAt,
			}),
		);

		expect(firstPage.map((action) => action.id)).toEqual([
			"action-tie-3",
			"action-tie-2",
		]);
		// 同秒的 action-tie-1 落在 createdBefore 的严格小于之外 —— 这是当前合同下的已知丢行。
		expect(nextPage).toEqual([]);
		// 不带游标的完整读取仍然能看见三行：数据没丢，丢的只是这种翻页用法。
		expect(
			kernel
				.read((tx) => listActions(tx, { limit: 10 }))
				.map((action) => action.id),
		).toEqual(["action-tie-3", "action-tie-2", "action-tie-1"]);
	});
});
